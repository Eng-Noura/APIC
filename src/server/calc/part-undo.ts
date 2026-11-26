// Ctrl+Z / Ctrl+Y for the Part List — the rules, with no database.
//
// A change is recorded as a before / after copy of every part row it touched (and the row's DXF record). Undo puts the
// "before" back, redo the "after". Before anything is applied, the rows as they are NOW are compared with what the
// change left behind: if someone (or something) changed a part since, the step is refused instead of overwriting it.

export type Rec = Record<string, unknown>;

/** A part row with its DXF record, as plain JSON. */
export interface Snap { row: Rec; dxf: Rec | null }

export interface Change { id: string; before: Snap | null; after: Snap | null }

export type Op =
  | { kind: "delete"; id: string }
  | { kind: "create"; id: string; snap: Snap }
  | { kind: "update"; id: string; snap: Snap };

// Columns that change on their own (timestamps, the bookkeeping of the nest sync) are not "a change by someone".
const IGNORED_ROW = new Set(["createdAt", "updatedAt", "nestSyncedQty", "nestSyncedAt"]);
const IGNORED_DXF = new Set(["uploadedAt", "updatedAt", "createdAt"]);

const strip = (r: Rec, ignored: Set<string>): Rec => Object.fromEntries(Object.entries(r).filter(([k]) => !ignored.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)));

/** Same part, same values (the columns that change by themselves are left out). */
export function sameState(a: Snap | null, b: Snap | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(strip(a.row, IGNORED_ROW)) === JSON.stringify(strip(b.row, IGNORED_ROW))
    && JSON.stringify(a.dxf ? strip(a.dxf, IGNORED_DXF) : null) === JSON.stringify(b.dxf ? strip(b.dxf, IGNORED_DXF) : null);
}

/** The parts whose state differs between the two snapshots (a part missing from a map did not exist). */
export function diffSnapshots(ids: string[], before: Map<string, Snap>, after: Map<string, Snap>): Change[] {
  const out: Change[] = [];
  for (const id of new Set(ids)) {
    const b = before.get(id) ?? null;
    const a = after.get(id) ?? null;
    if (!sameState(b, a)) out.push({ id, before: b, after: a });
  }
  return out;
}

/**
 * What has to be written to go one step back (`undo`) or forward (`redo`), or the parts that changed since and so
 * block the step. A part that is already in the wanted state is skipped.
 */
export function planApply(changes: Change[], direction: "undo" | "redo", current: Map<string, Snap>): { ops: Op[]; conflicts: string[] } {
  const ops: Op[] = [];
  const conflicts: string[] = [];
  for (const c of changes) {
    const target = direction === "undo" ? c.before : c.after;
    const expected = direction === "undo" ? c.after : c.before;
    const cur = current.get(c.id) ?? null;
    if (sameState(cur, target)) continue; // already there
    if (!sameState(cur, expected)) { conflicts.push(c.id); continue; }
    if (target === null) ops.push({ kind: "delete", id: c.id });
    else if (cur === null) ops.push({ kind: "create", id: c.id, snap: target });
    else ops.push({ kind: "update", id: c.id, snap: target });
  }
  return { ops, conflicts };
}

/** "Edit "Plate A"" / "Delete 3 parts": what the toolbar shows next to Undo / Redo. */
export function undoLabel(verb: string, names: string[]): string {
  if (names.length === 1) return `${verb} "${names[0]}"`;
  return `${verb} ${names.length} parts`;
}
