import { describe, it, expect } from "vitest";
import { addFileParts, addManualPart, addNestParts, mergeDuplicateGroups, type Group, type Pt } from "./engine";

const rect = (w: number, h: number): Pt[] => [[0, 0], [w, 0], [w, h], [0, h]];
const counters = () => ({ id: 1, sn: 0 });
const shape = { kind: "rect", w: 200, h: 100 } as const;
const base = { th: 8, material: "S235", qty: 2 };

describe("addFileParts — parts with different names are never merged", () => {
  it("same name + same shape/thickness/material -> one row, quantity added (case / spacing ignored)", () => {
    const c = counters();
    let gs = addFileParts([], [rect(100, 50)], "Plate A.dxf", 1, c, { th: 8, material: "S235", qty: 2 }).groups;
    gs = addFileParts(gs, [rect(100, 50)], "plate  a.DXF", 1, c, { th: 8, material: "S235", qty: 3 }).groups;
    expect(gs).toHaveLength(1);
    expect(gs[0].qty).toBe(5);
  });

  it("different name, everything else identical -> a row of its own", () => {
    const c = counters();
    let gs = addFileParts([], [rect(100, 50)], "Plate A.dxf", 1, c, { th: 8, material: "S235", qty: 2 }).groups;
    gs = addFileParts(gs, [rect(100, 50)], "Plate B.dxf", 1, c, { th: 8, material: "S235", qty: 2 }).groups;
    expect(gs).toHaveLength(2);
    expect(gs.map((g) => g.qty)).toEqual([2, 2]);
  });

  it("a part with no name still merges into a matching one", () => {
    const c = counters();
    let gs = addFileParts([], [rect(100, 50)], "Plate A.dxf", 1, c, { th: 8, qty: 2 }).groups;
    gs = addFileParts(gs, [rect(100, 50)], "", 1, c, { th: 8, qty: 4 }).groups;
    expect(gs).toHaveLength(1);
    expect(gs[0].qty).toBe(6);
  });
});

describe("addManualPart — name decides the merge", () => {
  it("same name merges, different name stays a row of its own, empty name merges", () => {
    const c = counters();
    const r1 = addManualPart([], shape, { name: "Base plate", ...base }, c);
    if ("error" in r1) throw new Error(r1.error);
    const r2 = addManualPart(r1.groups, shape, { name: "base  PLATE", ...base, qty: 3 }, c);
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.merged).toBe(true);
    expect(r2.groups).toHaveLength(1);
    expect(r2.groups[0].qty).toBe(5);

    const r3 = addManualPart(r2.groups, shape, { name: "Cover plate", ...base }, c);
    if ("error" in r3) throw new Error(r3.error);
    expect(r3.merged).toBe(false);
    expect(r3.groups).toHaveLength(2);

    const r4 = addManualPart(r3.groups, shape, { name: "", ...base, qty: 1 }, c);
    if ("error" in r4) throw new Error(r4.error);
    expect(r4.merged).toBe(true);
    expect(r4.groups).toHaveLength(2);
  });
});

describe("mergeDuplicateGroups — only rows with the same name fold together", () => {
  it("folds same-name rows, keeps differently named rows apart", () => {
    const c = counters();
    let gs = addFileParts([], [rect(100, 50)], "A.dxf", 1, c, { th: 8, material: "S235", qty: 2 }).groups;
    gs = addFileParts(gs, [rect(100, 50)], "A.dxf", 1, c, { th: 10, material: "S235", qty: 3 }).groups;
    gs = addFileParts(gs, [rect(100, 50)], "B.dxf", 1, c, { th: 10, material: "S235", qty: 4 }).groups;
    expect(gs).toHaveLength(3);
    const edited: Group[] = gs.map((g) => (g.th === 10 ? { ...g, th: 8 } : g));
    const m = mergeDuplicateGroups(edited, new Set(edited.map((g) => g.id)));
    expect(m.groups).toHaveLength(2);
    expect(m.groups.find((g) => g.name === "A.dxf")!.qty).toBe(5);
    expect(m.groups.find((g) => g.name === "B.dxf")!.qty).toBe(4);
  });
});

describe("addNestParts — nest import follows the same rule", () => {
  const nest = (n: number) => [{ W: 2000, H: 1000, parts: Array.from({ length: n }, () => ({ outer: rect(100, 50), holes: [] as Pt[][], w: 100, h: 50, area: 5000, per: 300, box: [0, 0, 100, 50] as [number, number, number, number] })) }];
  it("same name folds into the existing row, a different name gets its own row", () => {
    const c = counters();
    const a = addNestParts([], nest(2) as never, "Nest A.dxf", c, { th: 8, material: "S235" });
    expect(a.groups).toHaveLength(1);
    expect(a.groups[0].qty).toBe(2);
    const same = addNestParts(a.groups, nest(1) as never, "nest a.dxf", c, { th: 8, material: "S235" });
    expect(same.groups).toHaveLength(1);
    expect(same.groups[0].qty).toBe(3);
    const other = addNestParts(same.groups, nest(1) as never, "Nest B.dxf", c, { th: 8, material: "S235" });
    expect(other.groups).toHaveLength(2);
  });
});
