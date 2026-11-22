import { describe, it, expect } from "vitest";
import { reconcileNestParts, summarizePlan, type LinkedPartLite, type NestPartLite } from "./nest-sync";

const nest = (id: number, qty: number, over: Partial<NestPartLite> = {}): NestPartLite => ({ id, qty, th: 10, material: "S235JR", ...over });
const lp = (id: string, nestPartId: number, qty: number, synced: number | null, over: Partial<LinkedPartLite> = {}): LinkedPartLite => ({
  id, nestPartId, qty, thicknessMm: 10, material: "S235JR", syncedQty: synced, groupId: null, groupQty: null, ...over,
});
const one = (n: NestPartLite[], l: LinkedPartLite[]) => reconcileNestParts(n, l).items[0];

describe("reconcileNestParts", () => {
  it("equal quantities are linked", () => { expect(one([nest(1, 4)], [lp("a", 1, 4, 4)]).status).toBe("linked"); });

  it("only the nest changed -> applied to the BOQ", () => {
    const i = one([nest(1, 6)], [lp("a", 1, 4, 4)]);
    expect(i.status).toBe("nest_changed");
    expect(i.newQty).toBe(6);
  });

  it("only the BOQ changed -> has to be pushed to the nest", () => {
    expect(one([nest(1, 4)], [lp("a", 1, 6, 4)]).status).toBe("boq_changed");
  });

  it("both changed to different values -> conflict, nothing applied", () => {
    const i = one([nest(1, 5)], [lp("a", 1, 6, 4)]);
    expect(i.status).toBe("conflict");
    expect(i.newQty).toBeUndefined();
  });

  it("both changed to the SAME value -> simply linked", () => {
    expect(one([nest(1, 6)], [lp("a", 1, 6, 4)]).status).toBe("linked");
  });

  it("no earlier sync and different quantities -> conflict", () => {
    expect(one([nest(1, 5)], [lp("a", 1, 4, null)]).status).toBe("conflict");
  });

  it("a part missing from the nest is an orphan, never removed", () => {
    const i = one([], [lp("a", 9, 4, 4)]);
    expect(i.status).toBe("orphan");
    expect(i.nestQty).toBeNull();
  });

  it("reports nest parts that are not linked yet", () => {
    expect(reconcileNestParts([nest(1, 1), nest(2, 1)], [lp("a", 1, 1, 1)]).unlinkedNestIds).toEqual([2]);
  });

  describe("parts inside an assembly", () => {
    const grouped = (qty: number, synced: number) => lp("a", 1, qty, synced, { groupId: "g", groupQty: 4 });
    it("nest quantity becomes a new qty-per-assembly when it divides evenly", () => {
      const i = one([nest(1, 12)], [grouped(8, 8)]);
      expect(i.status).toBe("nest_changed");
      expect(i.newQtyPerAssembly).toBe(3);
      expect(i.newQty).toBe(12);
    });
    it("a quantity that does not divide evenly is a conflict, not a rounded guess", () => {
      expect(one([nest(1, 10)], [grouped(8, 8)]).status).toBe("conflict");
    });
    it("an assembly quantity change (BOQ side) is boq_changed", () => {
      // assembly went 4 -> 6, so the part went 8 -> 12 in the BOQ; the nest still has 8
      expect(one([nest(1, 8)], [lp("a", 1, 12, 8, { groupId: "g", groupQty: 6 })]).status).toBe("boq_changed");
    });
  });

  it("reports thickness and material differences without touching them", () => {
    const i = one([nest(1, 4, { th: 12, material: "S355" })], [lp("a", 1, 4, 4)]);
    expect(i.status).toBe("linked");
    expect(i.differences).toHaveLength(2);
  });

  it("summarises", () => {
    const plan = reconcileNestParts([nest(1, 6), nest(2, 1), nest(3, 1)], [lp("a", 1, 4, 4), lp("b", 2, 1, 1), lp("c", 9, 1, 1)]);
    expect(summarizePlan(plan)).toEqual({ linked: 1, nest_changed: 1, boq_changed: 0, conflict: 0, orphan: 1, unlinked: 1 });
  });
});

import { applyQuantityChanges } from "./nest-sync";

describe("applyQuantityChanges", () => {
  const snap = { v: 1, result: { sheets: [] }, groups: [
    { id: 1, qty: 4, name: "a" }, { id: 2, qty: 2, name: "b" },
    { id: 3, qty: 2, cid: 2 }, { id: 4, qty: 1, seg: { role: "child" } },
  ] };
  it("changes only the quantity of the named parts and keeps everything else", () => {
    const r = applyQuantityChanges(snap, [{ nestPartId: 1, qty: 6 }]);
    const g = (r.data as typeof snap).groups;
    expect(r.applied).toEqual([1]);
    expect(g[0]).toEqual({ id: 1, qty: 6, name: "a" });
    expect(g[1]).toBe(snap.groups[1]);
    expect((r.data as typeof snap).result).toBe(snap.result);
    expect(snap.groups[0].qty).toBe(4); // the input is not mutated
  });
  it("never touches paired-triangle copies or segment pieces", () => {
    const r = applyQuantityChanges(snap, [{ nestPartId: 3, qty: 9 }, { nestPartId: 4, qty: 9 }]);
    expect(r.applied).toEqual([]);
  });
  it("ignores unknown ids and a missing snapshot", () => {
    expect(applyQuantityChanges(snap, [{ nestPartId: 99, qty: 1 }]).applied).toEqual([]);
    expect(applyQuantityChanges(null, [{ nestPartId: 1, qty: 1 }]).applied).toEqual([]);
  });
});

describe("applyQuantityChanges — 1D nest", () => {
  const snap1d = {
    v: 1,
    pieces: [
      { id: 1, sn: 1, name: "A", profile: "IPE200", material: "S235", length: 3000, qty: 4 },
      { id: 2, sn: 2, name: "B", profile: "IPE200", material: "S235", length: 1000, qty: 2 },
      // a segment of a part that is longer than every bar: never a part of its own
      { id: 1, sn: 3, name: "A", profile: "IPE200", material: "S235", length: 6000, qty: 1, segment: { index: 1, total: 2, parentId: 1, parentLength: 12000 } },
    ],
    sources: [{ id: 100001, qty: 5 }],
    result: { bars: [1, 2, 3] },
    resS: { kerf: 3 },
  };

  it("writes the quantity into pieces[] and leaves everything else as it is", () => {
    const r = applyQuantityChanges(snap1d, [{ nestPartId: 1, qty: 6 }], "1D");
    const d = r.data as typeof snap1d;
    expect(r.applied).toEqual([1]);
    expect(d.pieces[0].qty).toBe(6);
    expect(d.pieces[1].qty).toBe(2);
    expect(d.sources).toEqual(snap1d.sources);
    expect(snap1d.pieces[0].qty).toBe(4); // input not mutated
  });

  it("never touches a segment, even when its id matches", () => {
    const r = applyQuantityChanges(snap1d, [{ nestPartId: 1, qty: 6 }], "1D");
    expect((r.data as typeof snap1d).pieces[2].qty).toBe(1);
  });

  it("drops the saved cutting result (it no longer matches the quantities)", () => {
    const d = applyQuantityChanges(snap1d, [{ nestPartId: 2, qty: 9 }], "1D").data as { result: unknown; resS: unknown };
    expect(d.result).toBeNull();
    expect(d.resS).toBeNull();
  });

  it("keeps the result when nothing was written", () => {
    const r = applyQuantityChanges(snap1d, [{ nestPartId: 99, qty: 1 }], "1D");
    expect(r.applied).toEqual([]);
    expect(r.data).toBe(snap1d);
  });

  it("a 1D change does not look at groups[] and a 2D change does not look at pieces[]", () => {
    expect(applyQuantityChanges(snap1d, [{ nestPartId: 1, qty: 6 }]).applied).toEqual([]);
    expect(applyQuantityChanges({ groups: [{ id: 1, qty: 1 }] }, [{ nestPartId: 1, qty: 6 }], "1D").applied).toEqual([]);
  });
});
