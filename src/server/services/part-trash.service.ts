// Trash of the Part List.
//
// A deleted part is really deleted — so no cost, weight, production or nesting query anywhere has to know about a
// "deleted" flag — but a full copy of it (every column + its DXF record) is kept here for TRASH_DAYS, so a wrong delete
// can be undone. The DXF file itself is never removed from storage by a delete, so a restored part gets it back.
//
//   trashPart(id)        before a part is deleted   -> returns the trash id (the "Undo" of the toast)
//   dropTrash(trashId)   the delete failed          -> forget the copy
//   listTrash(projectId) the Trash dialog            (copies older than TRASH_DAYS are purged first)
//   restoreFromTrash(id) "Undo" / "Restore"          -> the part is back, with its DXF, assembly / scope / work order
//
// A restored part is a normal Part List part again. Its link to a nest row is NOT restored: that row was removed from
// the nest together with the part, so the part can be sent to the nest again (2D / 1D "Send to Nesting").

import { prisma } from "@/server/db/client";
import { logActivity } from "./activity-log.service";

export const TRASH_DAYS = 30;

type Rec = Record<string, unknown>;

/**
 * A saved part row, ready to be written back: the assembly / scope / work order it was in are kept unless they were
 * deleted in the meantime, and (for a part that is created again) the link to a nest row is dropped — that row left
 * the nest together with the part. Shared by the Trash and by Ctrl+Z.
 */
export async function reviveRow(saved: Rec, opts: { dropNestLink: boolean }): Promise<Rec> {
  const s = { ...saved };
  if (opts.dropNestLink) { s.nestKind = null; s.nestPartId = null; s.nestSyncedQty = null; s.nestSyncedAt = null; }
  const [group, scope, wo] = await Promise.all([
    typeof s.groupId === "string" ? prisma.partGroup.findUnique({ where: { id: s.groupId }, select: { id: true } }) : null,
    typeof s.scopeId === "string" ? prisma.scopeItem.findUnique({ where: { id: s.scopeId }, select: { id: true } }) : null,
    typeof s.workOrderGroupId === "string" ? prisma.workOrderGroup.findUnique({ where: { id: s.workOrderGroupId }, select: { id: true } }) : null,
  ]);
  if (!group) s.groupId = null;
  if (!scope) s.scopeId = null;
  if (!wo) s.workOrderGroupId = null;
  return s;
}

/** The saved DXF record as data for `partDxf.create`. */
export function dxfData(saved: Rec, partId: string): Rec {
  const d: Rec = { ...saved, takeoffPartId: partId };
  delete d.id;
  if (d.geometryJson === null) delete d.geometryJson; // a nullable JSON column does not take a plain null: leaving it out stores null
  return d;
}

export class TrashError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

/** Copy of the part (and its DXF record) into the trash. Call it right before the delete. */
export async function trashPart(partId: string, userId: string): Promise<string | null> {
  const row = await prisma.takeoffPart.findUnique({ where: { id: partId }, include: { dxf: true, drawing: { select: { projectId: true, drawingNumber: true } } } });
  if (!row) return null;
  const { dxf, drawing, ...part } = row;
  const copy = await prisma.takeoffPartTrash.create({
    data: {
      projectId: drawing.projectId,
      drawingId: part.drawingId,
      drawingNumber: drawing.drawingNumber,
      partId: part.id,
      description: part.description,
      snapshot: JSON.parse(JSON.stringify(part)),
      dxf: dxf ? JSON.parse(JSON.stringify(dxf)) : undefined,
      deletedById: userId,
    },
    select: { id: true },
  });
  return copy.id;
}

/** The delete did not happen (e.g. the part is used in a nesting job): the copy is not needed. */
export async function dropTrash(trashId: string | null): Promise<void> {
  if (trashId) await prisma.takeoffPartTrash.delete({ where: { id: trashId } }).catch(() => undefined);
}

export async function listTrash(projectId: string) {
  const cutoff = new Date(Date.now() - TRASH_DAYS * 24 * 3600 * 1000);
  await prisma.takeoffPartTrash.deleteMany({ where: { projectId, deletedAt: { lt: cutoff } } });
  const rows = await prisma.takeoffPartTrash.findMany({
    where: { projectId },
    orderBy: { deletedAt: "desc" },
    select: { id: true, description: true, drawingNumber: true, deletedAt: true, deletedById: true, snapshot: true },
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => (r.deletedById ? [r.deletedById] : [])))] } }, select: { id: true, name: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return rows.map((r) => {
    const s = (r.snapshot ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      description: r.description,
      drawingNumber: r.drawingNumber,
      deletedAt: r.deletedAt,
      deletedBy: r.deletedById ? nameOf.get(r.deletedById) ?? null : null,
      partType: typeof s.partType === "string" ? s.partType : null,
      qty: typeof s.qty === "number" ? s.qty : null,
      expiresAt: new Date(r.deletedAt.getTime() + TRASH_DAYS * 24 * 3600 * 1000),
    };
  });
}

/** Puts the part back. Throws TrashError with a message the person can act on. */
export async function restoreFromTrash(trashId: string, userId: string) {
  const t = await prisma.takeoffPartTrash.findUnique({ where: { id: trashId } });
  if (!t) throw new TrashError("This item is no longer in the trash (it was already restored, or it is older than 30 days).", 404);

  const drawing = await prisma.takeoffDrawing.findUnique({ where: { id: t.drawingId }, select: { id: true, projectId: true } });
  if (!drawing) throw new TrashError(`Its drawing (${t.drawingNumber}) was deleted — create the drawing again, or add the part by hand.`);

  // the part was deleted from the nest too, so there is nothing to point at any more
  const s = await reviveRow(t.snapshot as Rec, { dropNestLink: true });

  // keep the original id unless something took it (it never should)
  const taken = await prisma.takeoffPart.findUnique({ where: { id: t.partId }, select: { id: true } });
  if (taken) delete s.id;

  const restored = await prisma.$transaction(async (tx) => {
    const part = await tx.takeoffPart.create({ data: s as never });
    if (t.dxf) await tx.partDxf.create({ data: dxfData(t.dxf as Rec, part.id) as never });
    await tx.takeoffPartTrash.delete({ where: { id: trashId } });
    return part;
  });
  await logActivity({ userId, action: "CREATE", entity: "TAKEOFF_PART", entityId: restored.id, projectId: drawing.projectId, detail: `Restored "${restored.description}" from the Trash` });
  return restored;
}
