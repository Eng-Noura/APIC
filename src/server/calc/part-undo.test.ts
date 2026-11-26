import { describe, expect, it } from "vitest";
import { diffSnapshots, planApply, sameState, undoLabel, type Snap } from "./part-undo";

const snap = (over: Record<string, unknown> = {}, dxf: Record<string, unknown> | null = null): Snap => ({
  row: { id: "p1", description: "Plate A", qty: 2, thicknessMm: 12, updatedAt: "2026-01-01T00:00:00Z", ...over }, dxf,
});
const map = (...s: Snap[]) => new Map(s.map((x) => [x.row.id as string, x]));

describe("sameState", () => {
  it("ignores the columns that change on their own", () => {
    expect(sameState(snap(), snap({ updatedAt: "2027-01-01", nestSyncedAt: "x", nestSyncedQty: 9 }))).toBe(true);
  });
  it("sees a real difference, in the row or in the DXF", () => {
    expect(sameState(snap(), snap({ qty: 3 }))).toBe(false);
    expect(sameState(snap({}, { fileName: "a.dxf" }), snap({}, { fileName: "b.dxf" }))).toBe(false);
    expect(sameState(snap(), null)).toBe(false);
    expect(sameState(null, null)).toBe(true);
  });
});

describe("diffSnapshots", () => {
  it("keeps only the parts that changed, including created and deleted ones", () => {
    const before = map(snap({ id: "a" }), snap({ id: "b" }));
    const after = map(snap({ id: "a", qty: 5 }), snap({ id: "c" }));
    const d = diffSnapshots(["a", "b", "c"], before, after);
    expect(d.map((c) => [c.id, c.before !== null, c.after !== null])).toEqual([["a", true, true], ["b", true, false], ["c", false, true]]);
  });
  it("nothing changed = nothing to record", () => {
    expect(diffSnapshots(["a"], map(snap({ id: "a" })), map(snap({ id: "a" })))).toEqual([]);
  });
});

describe("planApply", () => {
  const edit = diffSnapshots(["p1"], map(snap()), map(snap({ qty: 4 })));
  const del = diffSnapshots(["p1"], map(snap()), new Map());
  const add = diffSnapshots(["p1"], new Map(), map(snap()));

  it("undo of an edit writes the old values back; redo writes the new ones", () => {
    const u = planApply(edit, "undo", map(snap({ qty: 4 })));
    expect(u.ops).toEqual([{ kind: "update", id: "p1", snap: edit[0].before }]);
    const r = planApply(edit, "redo", map(snap()));
    expect(r.ops).toEqual([{ kind: "update", id: "p1", snap: edit[0].after }]);
  });
  it("undo of a delete re-creates the part, undo of an add deletes it", () => {
    expect(planApply(del, "undo", new Map()).ops).toEqual([{ kind: "create", id: "p1", snap: del[0].before }]);
    expect(planApply(add, "undo", map(snap())).ops).toEqual([{ kind: "delete", id: "p1" }]);
    expect(planApply(del, "redo", map(snap())).ops).toEqual([{ kind: "delete", id: "p1" }]);
  });
  it("refuses a step when somebody changed the part since", () => {
    const r = planApply(edit, "undo", map(snap({ qty: 99 })));
    expect(r.ops).toEqual([]);
    expect(r.conflicts).toEqual(["p1"]);
  });
  it("refuses to undo an add when the part was edited, and to undo a delete when the id is taken", () => {
    expect(planApply(add, "undo", map(snap({ qty: 7 }))).conflicts).toEqual(["p1"]);
    expect(planApply(del, "undo", map(snap({ description: "other" }))).conflicts).toEqual(["p1"]);
  });
  it("a part that is already in the wanted state is skipped, not a conflict", () => {
    expect(planApply(edit, "undo", map(snap()))).toEqual({ ops: [], conflicts: [] });
  });
});

describe("undoLabel", () => {
  it("names one part, counts several", () => {
    expect(undoLabel("Edit", ["Plate A"])).toBe('Edit "Plate A"');
    expect(undoLabel("Delete", ["a", "b", "c"])).toBe("Delete 3 parts");
  });
});
