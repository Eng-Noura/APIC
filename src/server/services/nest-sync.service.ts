// BOQ <-> nest sync (2D and 1D). Reads the project's saved nest, compares it with the takeoff parts linked to it
// (nestKind/nestPartId) using the pure rules in src/server/calc/nest-sync.ts, and — when asked to apply — moves
// every nest-side quantity change into the BOQ, and every BOQ-side change into the nest (a version-checked write,
// so an open tab's autosave can never overwrite it; the tab notices the new version and reloads). Conflicts are
// only reported.

import { prisma } from "@/server/db/client";
import { effectiveQtyMap } from "@/server/calc/boq-groups";
import { reconcileNestParts, summarizePlan, type LinkedPartLite, type NestKind, type NestPartLite, type SyncItem, type SyncPlan } from "@/server/calc/nest-sync";
import { nestPartDescription, nestPartFileName, nestPartToDxf, parseNestParts } from "@/features/takeoff/nest-parts";
import { isFromPartList, labelSet, parseNestPieces, partListLabel } from "@/features/takeoff/nest-1d-parts";
import { getWorkspace, pushQuantitiesToNest } from "./nesting-workspace.service";
import { recomputeFor } from "./part-group.service";
import { pushSpecsToNestSafe } from "./nest-link.service";
import { logActivity, logPartEvents } from "./activity-log.service";

export interface NestSyncReport {
  hasNest: boolean;
  summary: ReturnType<typeof summarizePlan>;
  items: (SyncItem & { label: string })[];
  /** BOQ quantities changed by this call (taken from the nest) */
  applied: number;
  /** nest quantities changed by this call (taken from the BOQ) */
  pushed: number;
}

/** The 1D pieces that could still become Part List parts: not plates, and not pieces that came FROM the Part List. */
async function importable1DIds(projectId: string, pieces: ReturnType<typeof parseNestPieces>): Promise<Set<number>> {
  const drawings = await prisma.takeoffDrawing.findMany({
    where: { projectId },
    select: { drawingNumber: true, parts: { select: { itemNo: true, description: true } } },
  });
  const labels = labelSet(drawings.flatMap((d) => d.parts.map((p) => partListLabel(d.drawingNumber, p.itemNo, p.description))));
  return new Set(pieces.filter((p) => p.partType !== "PLATE" && !isFromPartList(p, labels)).map((p) => p.id));
}

async function buildPlan(projectId: string, kind: NestKind) {
  const ws = await getWorkspace(projectId, kind);
  let nestParts: NestPartLite[];
  let candidates: Set<number> | null = null;
  if (kind === "2D") {
    nestParts = ws ? parseNestParts(ws.dataJson) : [];
  } else {
    const pieces = ws ? parseNestPieces(ws.dataJson) : [];
    nestParts = pieces.map((p) => ({ id: p.id, qty: p.qty, th: 0, material: p.material }));
    candidates = pieces.length ? await importable1DIds(projectId, pieces) : new Set();
  }
  const [parts, groups] = await Promise.all([
    prisma.takeoffPart.findMany({
      where: { drawing: { projectId }, nestKind: kind, nestPartId: { not: null } },
      select: {
        id: true, nestPartId: true, qty: true, thicknessMm: true, material: true, nestSyncedQty: true, groupId: true, description: true,
        partType: true, geometry: true, paintSides: true, areaFormula: true, buyWeightKg: true, qtyPerAssembly: true,
      },
    }),
    prisma.partGroup.findMany({ where: { projectId }, select: { id: true, parentId: true, qty: true } }),
  ]);
  const eff = effectiveQtyMap(groups);
  const linked: LinkedPartLite[] = parts.map((p) => ({
    id: p.id, nestPartId: p.nestPartId as number, qty: p.qty, thicknessMm: p.thicknessMm, material: p.material, syncedQty: p.nestSyncedQty,
    groupId: p.groupId, groupQty: p.groupId ? eff.get(p.groupId) ?? null : null,
  }));
  const plan: SyncPlan = reconcileNestParts(nestParts, linked);
  // 1D: plates and pieces that came from the Part List are not "missing from the BOQ" — only real candidates are reported
  if (candidates) plan.unlinkedNestIds = plan.unlinkedNestIds.filter((id) => candidates!.has(id));
  return { hasNest: !!ws, plan, parts };
}

const KINDS: NestKind[] = ["2D", "1D"];

/** Both nests in one report: counts are added up, the items of the 2D nest come first. */
function mergeReports(reports: NestSyncReport[]): NestSyncReport {
  const summary = { linked: 0, nest_changed: 0, boq_changed: 0, conflict: 0, orphan: 0, unlinked: 0 };
  for (const r of reports) for (const k of Object.keys(summary) as (keyof typeof summary)[]) summary[k] += r.summary[k];
  return {
    hasNest: reports.some((r) => r.hasNest),
    summary,
    items: reports.flatMap((r) => r.items),
    applied: reports.reduce((t, r) => t + r.applied, 0),
    pushed: reports.reduce((t, r) => t + r.pushed, 0),
  };
}

async function nestSyncStatusFor(projectId: string, kind: NestKind): Promise<NestSyncReport> {
  const { hasNest, plan, parts } = await buildPlan(projectId, kind);
  const label = new Map(parts.map((p) => [p.id, p.description]));
  return { hasNest, summary: summarizePlan(plan), items: plan.items.map((i) => ({ ...i, label: label.get(i.partId) ?? i.partId })), applied: 0, pushed: 0 };
}

/** What would change, for the 2D and the 1D nest together (nothing is written). */
export async function getNestSyncStatus(projectId: string): Promise<NestSyncReport> {
  return mergeReports(await Promise.all(KINDS.map((k) => nestSyncStatusFor(projectId, k))));
}

async function applyNestSyncFor(projectId: string, userId: string, kind: NestKind): Promise<NestSyncReport> {
  const { hasNest, plan, parts } = await buildPlan(projectId, kind);
  const byId = new Map(parts.map((p) => [p.id, p]));
  const now = new Date();
  const writes = [];

  for (const i of plan.items) {
    const p = byId.get(i.partId)!;
    if (i.status === "nest_changed" && i.newQty !== undefined) {
      writes.push(prisma.takeoffPart.update({
        where: { id: p.id },
        data: {
          qty: i.newQty,
          ...(i.newQtyPerAssembly !== undefined ? { qtyPerAssembly: i.newQtyPerAssembly } : {}),
          ...recomputeFor(p, i.newQty),
          nestSyncedQty: i.newQty, nestSyncedAt: now,
        },
      }));
    } else if (i.status === "linked" && p.nestSyncedQty !== i.boqQty) {
      // both sides agree: just remember it, so a later change can be attributed to the right side
      writes.push(prisma.takeoffPart.update({ where: { id: p.id }, data: { nestSyncedQty: i.boqQty, nestSyncedAt: now } }));
    }
  }
  if (writes.length) await prisma.$transaction(writes);

  // BOQ -> nest: only quantities the BOQ changed since the last sync; anything else stays untouched.
  const toPush = plan.items.filter((i) => i.status === "boq_changed");
  let pushedIds: number[] = [];
  if (toPush.length) {
    pushedIds = await pushQuantitiesToNest(projectId, toPush.map((i) => ({ nestPartId: i.nestPartId, qty: i.boqQty })), userId, kind);
    const done = new Set(pushedIds);
    const marks = toPush.filter((i) => done.has(i.nestPartId)).map((i) =>
      prisma.takeoffPart.update({ where: { id: i.partId }, data: { nestSyncedQty: i.boqQty, nestSyncedAt: now } }));
    if (marks.length) await prisma.$transaction(marks);
    await logActivity({
      userId, action: "UPDATE", entity: "NESTING_RUN", entityId: projectId, projectId,
      detail: `Nest sync: ${pushedIds.length} quantities written into the ${kind} nest from the BOQ (${toPush.filter((i) => done.has(i.nestPartId)).map((i) => `${byId.get(i.partId)!.description} ${i.nestQty}→${i.boqQty}`).slice(0, 5).join(", ")})`,
    });
  }

  const changed = plan.items.filter((i) => i.status === "nest_changed");
  if (changed.length) {
    await logPartEvents(userId, projectId, changed.map((i) => ({
      partId: i.partId, action: "UPDATE" as const, detail: `"${byId.get(i.partId)!.description}": qty ${i.boqQty} → ${i.newQty} (changed in the ${kind} nest)`,
    })));
  }
  // what is left after applying: nest_changed items are now linked
  const pushed = new Set(pushedIds);
  const after: SyncPlan = {
    ...plan,
    items: plan.items.map((i) =>
      i.status === "nest_changed" ? { ...i, status: "linked" as const, boqQty: i.newQty ?? i.boqQty }
      : i.status === "boq_changed" && pushed.has(i.nestPartId) ? { ...i, status: "linked" as const, nestQty: i.boqQty }
      : i),
  };
  return {
    hasNest, summary: summarizePlan(after), applied: changed.length, pushed: pushedIds.length,
    items: after.items.map((i) => ({ ...i, label: byId.get(i.partId)?.description ?? i.partId })),
  };
}

/** Carries quantity changes both ways between the BOQ and the 2D nest, and between the BOQ and the 1D nest. */
export async function applyNestSync(projectId: string, userId: string): Promise<NestSyncReport> {
  const reports: NestSyncReport[] = [];
  for (const k of KINDS) reports.push(await applyNestSyncFor(projectId, userId, k)); // one after the other: each may write its own nest
  return mergeReports(reports);
}

/**
 * Automatic sync after a BOQ edit (a part's quantity, an assembly's quantity). Best effort: a failure here must never
 * fail the edit that triggered it — the manual "Sync with nest" button shows whatever is still out of step.
 */
export async function autoSyncAfterBoqChange(projectId: string, userId: string): Promise<void> {
  try {
    const linked = await prisma.takeoffPart.count({ where: { drawing: { projectId }, nestPartId: { not: null } } });
    if (linked > 0) await applyNestSync(projectId, userId);
  } catch (e) {
    console.error("[nest-sync] automatic sync failed", e);
  }
}

const NESTING_DRAWING = "NESTING";

/**
 * Takes every part of the project's saved 2D nest that is not in the Part List yet (same rules as the screen's
 * automatic import: linked by nest part id, plus name+thickness inside the NESTING drawing). Returns how many were added.
 */
export async function importMissingNestParts(projectId: string, userId: string): Promise<number> {
  const ws = await getWorkspace(projectId, "2D");
  const nestParts = ws ? parseNestParts(ws.dataJson) : [];
  if (!nestParts.length) return 0;

  const drawings = await prisma.takeoffDrawing.findMany({
    where: { projectId },
    select: { id: true, drawingNumber: true, parts: { select: { description: true, thicknessMm: true, nestKind: true, nestPartId: true } } },
  });
  const linked = new Set(drawings.flatMap((d) => d.parts).filter((p) => p.nestKind === "2D" && p.nestPartId !== null).map((p) => p.nestPartId));
  const target = drawings.find((d) => d.drawingNumber === NESTING_DRAWING);
  const taken = new Set((target?.parts ?? []).map((p) => `${p.description.trim().toLowerCase()}|${p.thicknessMm ?? 0}`));
  const missing = nestParts.filter((r) => !linked.has(r.id) && !taken.has(`${nestPartDescription(r).toLowerCase()}|${r.th || 0}`));
  if (!missing.length) return 0;

  // lazy: these import this file back (cycle)
  const { createDrawing } = await import("./takeoff.service");
  const { importDxfParts } = await import("./dxf-import.service");
  const drawingId = target?.id ?? (await createDrawing({ projectId, drawingNumber: NESTING_DRAWING, title: "Parts from 2D Nesting", weightFromDwg: null }, userId)).id;

  let added = 0;
  for (const r of missing) {
    const file = new File([nestPartToDxf(r)], nestPartFileName(r), { type: "application/dxf" });
    const res = await importDxfParts(drawingId, file, [{
      partIndex: 0, description: nestPartDescription(r), side: "EXTERNAL", qty: r.qty, thicknessMm: r.th > 0 ? r.th : null,
      paintSides: 2, material: r.material || "Steel", partType: "PLATE", nestPartId: r.id,
    }], userId).catch(() => null);
    if (res?.[0]?.ok && !res[0].skipped) added++;
  }
  if (added) {
    await logActivity({ userId, action: "CREATE", entity: "NESTING_RUN", entityId: projectId, detail: `${added} parts taken from the 2D nest into the Part List` });
    await pushSpecsToNestSafe(projectId, userId); // the nest rows take the Part List's name straight away
  }
  return added;
}

/** Everything that must happen before the Part List is READ by something else (materials, production, nesting jobs). */
export async function syncBeforeUse(projectId: string, userId: string): Promise<void> {
  const added2D = await importMissingNestParts(projectId, userId);
  // lazy: that file imports takeoff.service, which imports this file back (cycle)
  const { importMissingNestPieces } = await import("./nest-1d-import.service");
  const added1D = (await importMissingNestPieces(projectId, userId)).imported;
  const linked = await prisma.takeoffPart.count({ where: { drawing: { projectId }, nestPartId: { not: null } } });
  if (linked > 0 || added2D > 0 || added1D > 0) await applyNestSync(projectId, userId);
}
