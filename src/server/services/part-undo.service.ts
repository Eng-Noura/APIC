// Ctrl+Z / Ctrl+Y for the Part List (rules: src/server/calc/part-undo.ts).
//
//   trackPartChange(...)  wraps a service call that changes parts: copies of the rows before and after are stored
//   peekUndo(...)         what Undo / Redo would do now (the toolbar shows it)
//   applyUndoRedo(...)    one step back / forward, refused when somebody changed those parts since
//
// Each person has their own stack per project, so Ctrl+Z never undoes a colleague's work. A new change clears that
// person's redo steps. Covered: every change to parts (add, edit, delete, assembly / scope / work-order assignment).
// Not covered: the assemblies, scopes and drawings themselves, and the nest tools (the 2D tool has its own Ctrl+Z).

import { prisma } from "@/server/db/client";
import { diffSnapshots, planApply, undoLabel, type Change, type Rec, type Snap } from "@/server/calc/part-undo";
import { dxfData, reviveRow } from "./part-trash.service";
import { logPartEvents } from "./activity-log.service";

export { undoLabel };

const KEEP_STEPS = 50;
const KEEP_DAYS = 7;

export class UndoError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}

const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** The parts (with their DXF records) as plain JSON; ids that do not exist are simply absent. */
export async function snapshotParts(ids: string[]): Promise<Map<string, Snap>> {
  const out = new Map<string, Snap>();
  if (!ids.length) return out;
  const rows = await prisma.takeoffPart.findMany({ where: { id: { in: ids } }, include: { dxf: true } });
  for (const r of rows) {
    const { dxf, ...row } = r;
    out.set(r.id, json({ row: row as Rec, dxf: (dxf as Rec | null) ?? null }));
  }
  return out;
}

async function pruneStack(projectId: string, userId: string) {
  const done = await prisma.takeoffUndo.findMany({ where: { projectId, userId, state: "done" }, orderBy: { createdAt: "desc" }, skip: KEEP_STEPS, select: { id: true } });
  const old = new Date(Date.now() - KEEP_DAYS * 24 * 3600 * 1000);
  await prisma.takeoffUndo.deleteMany({ where: { OR: [{ id: { in: done.map((d) => d.id) } }, { projectId, userId, createdAt: { lt: old } }] } });
}

/** Stores a step. Never throws: a failure to record must not fail the change itself. */
async function record(args: { userId: string; projectId: string; label: string; before: Map<string, Snap>; ids: string[] }): Promise<string | null> {
  try {
    const after = await snapshotParts(args.ids);
    const changes = diffSnapshots(args.ids, args.before, after);
    if (!changes.length) return null;
    await prisma.takeoffUndo.deleteMany({ where: { projectId: args.projectId, userId: args.userId, state: "undone" } }); // a new change ends the redo line
    const entry = await prisma.takeoffUndo.create({
      data: { projectId: args.projectId, userId: args.userId, label: args.label, changes: json(changes) as never },
      select: { id: true },
    });
    await pruneStack(args.projectId, args.userId);
    return entry.id;
  } catch (e) {
    console.error("[undo] could not record the step", e);
    return null;
  }
}

/**
 * Runs `fn` (a change to parts) and records it so it can be undone. `beforeIds` are the parts that exist before;
 * `afterIds` are the ones to look at afterwards (new parts show up there).
 */
export async function trackPartChange<T>(
  opts: { userId: string; projectId: string; label: string | ((r: T) => string); beforeIds: string[]; afterIds?: (r: T) => string[] },
  fn: () => Promise<T>,
): Promise<{ result: T; undoId: string | null }> {
  let before = new Map<string, Snap>();
  try { before = await snapshotParts(opts.beforeIds); } catch (e) { console.error("[undo] could not read the parts before the change", e); }
  const result = await fn();
  const ids = [...new Set([...opts.beforeIds, ...(opts.afterIds ? opts.afterIds(result) : [])])];
  const label = typeof opts.label === "function" ? opts.label(result) : opts.label;
  const undoId = await record({ userId: opts.userId, projectId: opts.projectId, label, before, ids });
  return { result, undoId };
}

/** What Ctrl+Z and Ctrl+Y would do for this person in this project right now. */
export async function peekUndo(userId: string, projectId: string) {
  const [undo, redo] = await Promise.all([
    prisma.takeoffUndo.findFirst({ where: { projectId, userId, state: "done" }, orderBy: { createdAt: "desc" }, select: { id: true, label: true, createdAt: true } }),
    prisma.takeoffUndo.findFirst({ where: { projectId, userId, state: "undone" }, orderBy: { createdAt: "asc" }, select: { id: true, label: true, createdAt: true } }),
  ]);
  return { undo, redo };
}

const nameOf = (c: Change, snaps: Map<string, Snap>) => String((snaps.get(c.id)?.row ?? c.after?.row ?? c.before?.row)?.description ?? c.id);

/** One step back (`undo`) or forward (`redo`). `entryId` = a specific step (the toast's "Undo"); otherwise the next one. */
export async function applyUndoRedo(userId: string, projectId: string, direction: "undo" | "redo", entryId?: string) {
  const entry = entryId
    ? await prisma.takeoffUndo.findFirst({ where: { id: entryId, projectId, userId } })
    : await prisma.takeoffUndo.findFirst({
        where: { projectId, userId, state: direction === "undo" ? "done" : "undone" },
        orderBy: { createdAt: direction === "undo" ? "desc" : "asc" },
      });
  if (!entry) throw new UndoError(direction === "undo" ? "Nothing to undo." : "Nothing to redo.", 404);
  if (entry.state !== (direction === "undo" ? "done" : "undone")) throw new UndoError(direction === "undo" ? "This step was already undone." : "This step was not undone.", 409);

  const changes = entry.changes as unknown as Change[];
  const current = await snapshotParts(changes.map((c) => c.id));
  const { ops, conflicts } = planApply(changes, direction, current);
  if (conflicts.length) {
    const names = conflicts.slice(0, 3).map((id) => `"${nameOf(changes.find((c) => c.id === id)!, current)}"`).join(", ");
    throw new UndoError(`Cannot ${direction}: ${names}${conflicts.length > 3 ? ` and ${conflicts.length - 3} more` : ""} changed since (by you or someone else). Nothing was changed.`);
  }

  // everything that is written needs its drawing; a deleted drawing cannot get its parts back
  const need = [...new Set(ops.flatMap((o) => (o.kind === "delete" ? [] : [String(o.snap.row.drawingId)])))];
  if (need.length) {
    const have = new Set((await prisma.takeoffDrawing.findMany({ where: { id: { in: need }, projectId }, select: { id: true } })).map((d) => d.id));
    if (need.some((d) => !have.has(d))) throw new UndoError("The drawing of this part was deleted, so the step cannot be applied.");
  }
  const prepared = await Promise.all(ops.map(async (o) => (o.kind === "delete" ? o : { ...o, row: await reviveRow(o.snap.row, { dropNestLink: o.kind === "create" }) })));

  const removedFromNest: { id: string; nestKind: string | null; nestPartId: number | null }[] = [];
  try {
  await prisma.$transaction(async (tx) => {
    for (const o of prepared) {
      if (o.kind === "delete") {
        const p = await tx.takeoffPart.findUnique({ where: { id: o.id }, select: { id: true, nestKind: true, nestPartId: true } });
        if (p) { removedFromNest.push(p); await tx.takeoffPart.delete({ where: { id: o.id } }); }
        continue;
      }
      const { id: _id, createdAt: _c, updatedAt: _u, ...scalars } = o.row;
      if (o.kind === "create") {
        await tx.takeoffPart.create({ data: { ...o.row, id: o.id } as never });
        await tx.takeoffPartTrash.deleteMany({ where: { projectId, partId: o.id } }); // it is back: no copy needed in the Trash
      } else {
        await tx.takeoffPart.update({ where: { id: o.id }, data: scalars as never });
      }
      await tx.partDxf.deleteMany({ where: { takeoffPartId: o.id } });
      if (o.snap.dxf) await tx.partDxf.create({ data: dxfData(o.snap.dxf, o.id) as never });
    }
    await tx.takeoffUndo.update({ where: { id: entry.id }, data: { state: direction === "undo" ? "undone" : "done" } });
  });
  } catch (e) {
    // e.g. the part is already used in a nesting job (the database refuses to delete it)
    if ((e as { code?: string })?.code === "P2003") throw new UndoError("A part of this step is used in a nesting job, so it cannot be removed. Nothing was changed.");
    throw e;
  }

  // the nests follow the Part List: a deleted part leaves them, a changed name / spec is written into them
  const nest = await import("./nest-link.service");
  if (removedFromNest.length) await nest.removePartsFromNests(projectId, userId, removedFromNest);
  if (ops.some((o) => o.kind === "update")) await nest.pushSpecsToNestSafe(projectId, userId);

  const verb = direction === "undo" ? "Undid" : "Redid";
  await logPartEvents(userId, projectId, ops.map((o) => ({
    partId: o.id,
    action: o.kind === "delete" ? ("DELETE" as const) : o.kind === "create" ? ("CREATE" as const) : ("UPDATE" as const),
    detail: `${verb}: ${entry.label}`,
  })));
  return { label: entry.label, count: ops.length };
}
