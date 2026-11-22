// 1D nest -> Part List. Every piece of the project's saved 1D nest that is not in the Part List yet becomes a
// Profile / Pipe part, linked to the piece (nestKind "1D" + nestPartId = piece id) so that
//   - it is never added twice (the link, not the name, decides),
//   - its quantity is kept in step with the nest and the BOQ (see nest-sync.service.ts).
// Pieces that came FROM the Part List are never taken back, plates stay with the 2D tool, and a piece whose weight
// per metre or pipe size is not known is reported with the reason — nothing is guessed.

import { prisma } from "@/server/db/client";
import { takeoffPartSchema } from "@/server/validators/takeoff";
import {
  buildPartFromPiece, isFromPartList, labelSet, parseNestPieces, partListLabel, pieceDescription,
  type NestPiece, type PartDraft, type PieceOverrides,
} from "@/features/takeoff/nest-1d-parts";
import { createDrawing, createPart } from "./takeoff.service";
import { getWorkspace } from "./nesting-workspace.service";
import { logActivity } from "./activity-log.service";

export const NESTING_1D_DRAWING = "NESTING-1D";

export interface Nest1DImportResult {
  /** parts created now */
  imported: number;
  /** pieces that were buildable but could not be saved */
  failed: number;
  /** pieces that were left out, each with the reason (one line each) */
  warnings: string[];
}

/** One part as the manual dialog sends it: what the piece says, plus anything the person typed in. */
export interface Nest1DImportItem extends PieceOverrides {
  nestPartId?: number;
  name: string;
  profile: string;
  material: string;
  lengthMm: number;
  qty: number;
  partType: "HOT_ROLLED" | "PIPE";
}
export interface Nest1DItemResult { index: number; ok: boolean; skipped?: boolean; error?: string }

/** Creates one part from a draft and links it to the nest piece. Idempotent on the link. */
async function createLinkedPart(drawingId: string, projectId: string, draft: PartDraft, nestPartId: number | undefined, userId: string): Promise<{ ok: true; skipped?: boolean } | { ok: false; error: string }> {
  if (nestPartId !== undefined) {
    const dup = await prisma.takeoffPart.findFirst({ where: { drawing: { projectId }, nestKind: "1D", nestPartId }, select: { id: true } });
    if (dup) return { ok: true, skipped: true };
  }
  const last = await prisma.takeoffPart.aggregate({ where: { drawingId }, _max: { itemNo: true } });
  const validated = takeoffPartSchema.safeParse({
    ...draft, drawingId, itemNo: (last._max.itemNo ?? 0) + 1, side: "EXTERNAL", paintSides: 2,
  });
  if (!validated.success) return { ok: false, error: validated.error.issues[0]?.message ?? "Invalid part data" };
  const created = await createPart(validated.data, userId);
  if (nestPartId !== undefined) {
    try {
      await prisma.takeoffPart.update({ where: { id: created.id }, data: { nestKind: "1D", nestPartId, nestSyncedQty: created.qty, nestSyncedAt: new Date() } });
    } catch (err) {
      // an unlinked copy would be added again next time: do not leave one behind
      await prisma.takeoffPart.delete({ where: { id: created.id } }).catch(() => undefined);
      return { ok: false, error: err instanceof Error ? err.message : "Could not link the part to the nest" };
    }
  }
  return { ok: true };
}

const pieceLabel = (p: NestPiece) => pieceDescription(p);

/**
 * Takes every piece of the project's saved 1D nest that is not in the Part List yet into the drawing NESTING-1D.
 * Safe to call again and again: only pieces without a linked part are touched.
 */
export async function importMissingNestPieces(projectId: string, userId: string): Promise<Nest1DImportResult> {
  const none: Nest1DImportResult = { imported: 0, failed: 0, warnings: [] };
  const ws = await getWorkspace(projectId, "1D");
  const pieces = ws ? parseNestPieces(ws.dataJson) : [];
  if (!pieces.length) return none;

  const drawings = await prisma.takeoffDrawing.findMany({
    where: { projectId },
    select: { id: true, drawingNumber: true, parts: { select: { itemNo: true, description: true, nestKind: true, nestPartId: true } } },
  });
  const linked = new Set(drawings.flatMap((d) => d.parts).filter((p) => p.nestKind === "1D" && p.nestPartId !== null).map((p) => p.nestPartId));
  const labels = labelSet(drawings.flatMap((d) => d.parts.map((p) => partListLabel(d.drawingNumber, p.itemNo, p.description))));

  const warnings: string[] = [];
  const todo: { piece: NestPiece; draft: PartDraft }[] = [];
  let plates = 0;
  for (const piece of pieces) {
    if (linked.has(piece.id) || isFromPartList(piece, labels)) continue;
    if (piece.partType === "PLATE") { plates++; continue; }
    const built = buildPartFromPiece(piece);
    if (built.ok) todo.push({ piece, draft: built.draft });
    else warnings.push(`${pieceLabel(piece)}: ${built.reason}`);
  }
  if (plates) warnings.push(`${plates} plate piece(s) in the 1D nest were left out — plates are taken from the 2D nest`);
  if (!todo.length) return { ...none, warnings };

  const target = drawings.find((d) => d.drawingNumber === NESTING_1D_DRAWING);
  const drawingId = target?.id ?? (await createDrawing(
    { projectId, drawingNumber: NESTING_1D_DRAWING, title: "Parts from 1D Nesting", weightFromDwg: null }, userId,
  )).id;

  let imported = 0;
  let failed = 0;
  for (const { piece, draft } of todo) {
    const r = await createLinkedPart(drawingId, projectId, draft, piece.id, userId).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "Import failed" }));
    if (!r.ok) { failed++; warnings.push(`${pieceLabel(piece)}: ${r.error}`); } else if (!r.skipped) imported++;
  }
  if (imported) await logActivity({ userId, action: "CREATE", entity: "NESTING_RUN", entityId: projectId, detail: `${imported} parts taken from the 1D nest into the Part List` });
  return { imported, failed, warnings };
}

/** The manual "Take parts from 1D Nesting" dialog: the chosen pieces (with any weight / size the person typed) into one drawing. */
export async function importNestPieces(drawingId: string, items: Nest1DImportItem[], userId: string): Promise<Nest1DItemResult[]> {
  const drawing = await prisma.takeoffDrawing.findUnique({ where: { id: drawingId }, select: { projectId: true } });
  if (!drawing) throw new Error("Drawing not found");
  const results: Nest1DItemResult[] = [];
  for (const [index, item] of items.entries()) {
    const piece: NestPiece = {
      id: item.nestPartId ?? -1, name: item.name, profile: item.profile, material: item.material,
      lengthMm: item.lengthMm, qty: item.qty, partType: item.partType, partId: null,
    };
    const built = buildPartFromPiece(piece, { weightPerMeter: item.weightPerMeter, odMm: item.odMm, thicknessMm: item.thicknessMm });
    if (!built.ok) { results.push({ index, ok: false, error: built.reason }); continue; }
    const r = await createLinkedPart(drawingId, drawing.projectId, built.draft, item.nestPartId, userId)
      .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "Import failed" }));
    results.push(r.ok ? { index, ok: true, skipped: r.skipped } : { index, ok: false, error: r.error });
  }
  const added = results.filter((r) => r.ok && !r.skipped).length;
  if (added) await logActivity({ userId, action: "CREATE", entity: "NESTING_RUN", entityId: drawing.projectId, detail: `${added} parts taken from the 1D nest into the Part List` });
  return results;
}
