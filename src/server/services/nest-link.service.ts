// One part = one thing: the Part List (TakeoffPart) owns a part's name and specs, the nests only point at it.
// The rules are in src/server/calc/nest-link.ts; this file moves them to and from the database:
//
//   nest opened            -> overlayForRead      (the nest shows the Part List's name / specs)
//   nest saved             -> applyNestSideEffects (typed edits go to the part; removed parts are deleted from the Part List)
//   Part List part edited  -> pushSpecsToNest      (version-checked write into the open nests)
//   Part List part deleted -> removePartsFromNests (the part disappears from the nests too)
//
// Every write into a nest is version-checked (mutateWorkspace), so an open tab can never overwrite it: the tab notices
// the new version, reloads, and shows the same name / specs / parts as the Part List.

import { prisma } from "@/server/db/client";
import { extractEdits, overlayRows, partIdsOfRows, removeRows, takeRemovedIds, type LinkedSpec, type SpecEdit } from "@/server/calc/nest-link";
import type { NestKind } from "@/server/calc/nest-sync";
import { profileWeightPerMeter } from "@/features/nesting/report/profile-weight";
import { mutateWorkspace } from "./nesting-workspace.service";
import { recomputeFor } from "./part-group.service";
import { logActivity } from "./activity-log.service";
import { describeChanges } from "@/server/calc/part-changes";

const KINDS: NestKind[] = ["2D", "1D"];

const SELECT = {
  id: true, drawingId: true, description: true, material: true, thicknessMm: true, partType: true, geometry: true, qty: true, groupId: true, itemNo: true,
  side: true, posNo: true, remark: true, qtyPerAssembly: true,
  nestKind: true, nestPartId: true, paintSides: true, areaFormula: true, buyWeightKg: true,
  drawing: { select: { drawingNumber: true } },
} as const;

type Row = Awaited<ReturnType<typeof loadRows>>[number];

function loadRows(projectId: string, kind: NestKind) {
  return prisma.takeoffPart.findMany({
    where: {
      drawing: { projectId },
      // 2D: plates that came from the nest. 1D: pieces that came from the nest, and every profile / pipe that may have been sent to it
      OR: kind === "2D" ? [{ nestKind: "2D", nestPartId: { not: null } }] : [{ nestKind: "1D", nestPartId: { not: null } }, { partType: { in: ["HOT_ROLLED", "PIPE"] } }],
    },
    select: SELECT,
  });
}

const toSpec = (p: Row): LinkedSpec => ({
  id: p.id, description: p.description, material: p.material, thicknessMm: p.thicknessMm, partType: p.partType, geometry: p.geometry, qty: p.qty,
  groupId: p.groupId, drawingNumber: p.drawing.drawingNumber, itemNo: p.itemNo, nestKind: p.nestKind, nestPartId: p.nestPartId,
});

async function loadSpecs(projectId: string, kind: NestKind): Promise<LinkedSpec[]> {
  return (await loadRows(projectId, kind)).map(toSpec);
}

/** Read side: what /api/nesting/workspace returns for a project nest — the stored snapshot with the Part List's name and specs. */
export async function overlayForRead(projectId: string, kind: NestKind, data: unknown): Promise<unknown> {
  try {
    return overlayRows(data, kind, await loadSpecs(projectId, kind)).data;
  } catch (e) {
    console.error("[nest-link] overlay failed — returning the stored nest", e);
    return data;
  }
}

/** Part List -> nests: write the current name / specs of the Part List into the saved 2D and 1D nests (only where something differs). */
export async function pushSpecsToNest(projectId: string, userId: string): Promise<void> {
  for (const kind of KINDS) {
    const specs = await loadSpecs(projectId, kind);
    if (!specs.length) continue;
    await mutateWorkspace(projectId, kind, userId, (d) => {
      const r = overlayRows(d, kind, specs);
      return r.changed ? r.data : null;
    });
  }
}

/** Best effort wrapper: a failure here must never fail the edit that triggered it (the next read of the nest still shows the Part List's values). */
export async function pushSpecsToNestSafe(projectId: string, userId: string): Promise<void> {
  try { await pushSpecsToNest(projectId, userId); } catch (e) { console.error("[nest-link] push to nest failed", e); }
}

/** Part List -> nests: the parts are gone from the Part List, so their rows go from the nests (and the stale results with them). */
export async function removePartsFromNests(projectId: string, userId: string, parts: { id: string; nestKind: string | null; nestPartId: number | null }[]): Promise<void> {
  if (!parts.length) return;
  try {
    for (const kind of KINDS) {
      const ids = parts.filter((p) => p.nestKind === kind && p.nestPartId !== null).map((p) => p.nestPartId as number);
      const partIds = kind === "1D" ? parts.map((p) => p.id) : [];
      if (!ids.length && !partIds.length) continue;
      await mutateWorkspace(projectId, kind, userId, (d) => {
        const r = removeRows(d, kind, ids, partIds);
        return r.removed.length ? r.data : null;
      });
    }
  } catch (e) {
    console.error("[nest-link] removing parts from the nests failed", e);
  }
}

/** The part with the nest's typed values applied; weight / area are recomputed so the Part List stays correct. */
async function applyEdit(edit: SpecEdit, userId: string): Promise<boolean> {
  const p = await prisma.takeoffPart.findUnique({ where: { id: edit.partId }, select: SELECT });
  if (!p) return false;
  const { patch } = edit;
  const geometry = { ...((p.geometry && typeof p.geometry === "object" ? p.geometry : {}) as Record<string, unknown>) };
  if (patch.profile && p.partType === "HOT_ROLLED") {
    const w = profileWeightPerMeter(patch.profile);
    if (w) { geometry.profile = patch.profile; geometry.weightPerMeter = Math.round(w * 1e4) / 1e4; }
  }
  if (patch.lengthMm && (p.partType === "HOT_ROLLED" || p.partType === "PIPE")) geometry.length = Math.round(patch.lengthMm * 1e3) / 1e6;
  const thicknessMm = patch.thicknessMm ?? p.thicknessMm;
  const qty = patch.qty ?? p.qty;
  const next = { partType: p.partType, geometry, thicknessMm, paintSides: p.paintSides, areaFormula: p.areaFormula, buyWeightKg: p.buyWeightKg };
  const updated = await prisma.takeoffPart.update({
    where: { id: p.id },
    data: {
      description: patch.description ?? p.description,
      material: patch.material ?? p.material,
      thicknessMm,
      geometry: geometry as object,
      qty,
      ...recomputeFor(next, qty),
    },
  });
  const changes = describeChanges(p, updated);
  if (changes.length) {
    const drawing = await prisma.takeoffDrawing.findUnique({ where: { id: p.drawingId }, select: { projectId: true } });
    await logActivity({
      userId, action: "UPDATE", entity: "TAKEOFF_PART", entityId: p.id, ...(drawing ? { projectId: drawing.projectId } : {}),
      detail: `"${updated.description}": ${changes.join(", ")} (changed in the nest)`,
    });
  }
  return true;
}

export interface NestSideEffects {
  /** parts removed from the Part List because the person removed them in the nest */
  deleted: number;
  /** parts that could not be removed (e.g. already used in a nesting job) — they stay and show up as "no longer in the nest" */
  blocked: number;
  /** parts whose name / specs were taken over from the nest row the person edited */
  updated: number;
}

/**
 * Nest -> Part List, after a project nest was saved. `removedIds` are the rows the person removed (the nest tool lists
 * them explicitly, so a part that merely is missing from a snapshot is never deleted by guesswork); `previousData` is
 * the snapshot as it was before this save, used to find the Part List part behind a removed 1D piece.
 */
export async function applyNestSideEffects(args: { projectId: string; kind: NestKind; userId: string; data: unknown; removedIds: number[]; previousData: unknown }): Promise<NestSideEffects> {
  const { projectId, kind, userId, data, removedIds, previousData } = args;
  const out: NestSideEffects = { deleted: 0, blocked: 0, updated: 0 };

  if (removedIds.length) {
    const viaPartId = partIdsOfRows(previousData, kind, removedIds);
    const doomed = await prisma.takeoffPart.findMany({
      where: { drawing: { projectId }, OR: [{ nestKind: kind, nestPartId: { in: removedIds } }, ...(viaPartId.length ? [{ id: { in: viaPartId } }] : [])] },
      select: { id: true },
    });
    const { deletePart } = await import("./takeoff.service"); // lazy: it imports this file back
    for (const { id } of doomed) {
      try { await deletePart(id, userId); out.deleted++; } catch (e) { out.blocked++; console.error("[nest-link] could not delete the part removed in the nest", id, e); }
    }
  }

  // Typed edits. After the write the Part List and the saved snapshot agree again, so nothing has to be written back.
  const specs = await loadSpecs(projectId, kind);
  for (const edit of extractEdits(data, kind, specs, profileWeightPerMeter)) {
    try { if (await applyEdit(edit, userId)) out.updated++; } catch (e) { console.error("[nest-link] could not apply the nest edit", edit.partId, e); }
  }
  return out;
}

/** Splits the explicit removals off a nest snapshot that is about to be saved. */
export const splitRemovals = takeRemovedIds;
