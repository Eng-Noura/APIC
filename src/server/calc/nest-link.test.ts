import { describe, expect, it } from "vitest";
import { extractEdits, overlayRows, partIdsOfRows, removeRows, takeRemovedIds, type LinkedSpec } from "./nest-link";

const plate = (over: Partial<LinkedSpec> = {}): LinkedSpec => ({
  id: "p1", description: "Drawing55 5802×400", material: "S235JR", thicknessMm: 15, partType: "PLATE", geometry: { width: 0.4, length: 5.802 },
  qty: 2, groupId: null, drawingNumber: "NESTING", itemNo: 32, nestKind: "2D", nestPartId: 7, ...over,
});
const bar = (over: Partial<LinkedSpec> = {}): LinkedSpec => ({
  id: "b1", description: "EJ5-part 7", material: "P265 GH", thicknessMm: null, partType: "HOT_ROLLED",
  geometry: { profile: "L75x50x6", length: 14.752, weightPerMeter: 5.65 }, qty: 6, groupId: null, drawingNumber: "EJ5", itemNo: 3,
  nestKind: null, nestPartId: null, ...over,
});

const data2D = (g: Record<string, unknown>[] = []) => ({ v: 1, groups: [{ id: 7, name: "8.dxf", th: 12, material: "", qty: 2, outer: [], holes: [] }, ...g], result: { sheets: [] } });

describe("overlayRows 2D", () => {
  it("shows the Part List name, thickness and material", () => {
    const r = overlayRows(data2D(), "2D", [plate()]);
    expect(r.changed).toBe(true);
    const g = (r.data as { groups: Record<string, unknown>[] }).groups[0];
    expect(g).toMatchObject({ name: "Drawing55 5802×400", th: 15, material: "S235JR" });
  });
  it("leaves the placements alone (only 1D drops its result)", () => {
    const r = overlayRows(data2D(), "2D", [plate()]);
    expect((r.data as { result: unknown }).result).not.toBeNull();
  });
  it("is a no-op when everything already matches", () => {
    const once = overlayRows(data2D(), "2D", [plate()]).data;
    const twice = overlayRows(once, "2D", [plate()]);
    expect(twice.changed).toBe(false);
    expect(twice.data).toBe(once);
  });
  it("treats the importer's 'Steel' as an empty nest material", () => {
    const r = overlayRows({ groups: [{ id: 7, name: "Drawing55 5802×400", th: 15, material: "", qty: 2 }] }, "2D", [plate({ material: "Steel" })]);
    expect(r.changed).toBe(false);
  });
  it("never touches rows with no part, paired copies or segmented pieces", () => {
    const d = data2D([{ id: 9, name: "free", th: 5, material: "" }, { id: 10, cid: 7, name: "copy" }, { id: 11, name: "7-1", seg: { role: "child", parentId: 7 } }]);
    const rows = (overlayRows(d, "2D", [plate()]).data as { groups: Record<string, unknown>[] }).groups;
    expect(rows.slice(1).map((g) => g.name)).toEqual(["free", "copy", "7-1"]);
  });
});

describe("extractEdits", () => {
  it("2D: a rename / thickness / material typed in the nest goes to the part", () => {
    const d = { groups: [{ id: 7, name: "Cover plate", th: 20, material: "S355", qty: 2 }] };
    expect(extractEdits(d, "2D", [plate()])).toEqual([{ partId: "p1", patch: { description: "Cover plate", thicknessMm: 20, material: "S355" } }]);
  });
  it("2D: nothing typed = no edit", () => {
    const d = overlayRows(data2D(), "2D", [plate()]).data;
    expect(extractEdits(d, "2D", [plate()])).toEqual([]);
  });
  it("2D: clearing the material falls back to the placeholder", () => {
    const d = { groups: [{ id: 7, name: "Drawing55 5802×400", th: 15, material: "", qty: 2 }] };
    expect(extractEdits(d, "2D", [plate()])[0].patch).toEqual({ material: "Steel" });
  });
  it("1D: a piece sent from the Part List is matched by partId and its label prefix is stripped", () => {
    const d = { pieces: [{ id: 1, partId: "b1", name: "EJ5 #3 Beam A", profile: "L75x50x6", material: "P265 GH", length: 14752, qty: 6 }] };
    expect(extractEdits(d, "1D", [bar()])).toEqual([{ partId: "b1", patch: { description: "Beam A" } }]);
  });
  it("1D: length, quantity and a known profile go through; an unknown profile does not", () => {
    const d = { pieces: [{ id: 1, partId: "b1", name: "EJ5 #3 EJ5-part 7", profile: "IPE200", material: "P265 GH", length: 12000, qty: 8 }] };
    const known = extractEdits(d, "1D", [bar()], (p) => (p === "IPE200" ? 22.4 : null));
    expect(known[0].patch).toEqual({ profile: "IPE200", lengthMm: 12000, qty: 8 });
    const unknown = extractEdits(d, "1D", [bar()], () => null);
    expect(unknown[0].patch).toEqual({ lengthMm: 12000, qty: 8 });
  });
  it("1D: an assembly part's quantity is not taken from the nest", () => {
    const d = { pieces: [{ id: 1, partId: "b1", name: "EJ5 #3 EJ5-part 7", profile: "L75x50x6", material: "P265 GH", length: 14752, qty: 9 }] };
    expect(extractEdits(d, "1D", [bar({ groupId: "g1" })])).toEqual([]);
  });
});

describe("overlayRows 1D", () => {
  it("restores the Part List specs and drops the stale cutting result", () => {
    const d = { pieces: [{ id: 1, partId: "b1", name: "x", profile: "IPE100", material: "", length: 100, qty: 1 }], result: { bars: [] }, resS: {} };
    const r = overlayRows(d, "1D", [bar()]);
    expect((r.data as { pieces: Record<string, unknown>[]; result: unknown }).pieces[0]).toMatchObject({ name: "EJ5 #3 EJ5-part 7", profile: "L75x50x6", material: "P265 GH", length: 14752, qty: 6 });
    expect((r.data as { result: unknown }).result).toBeNull();
  });
  it("a rename alone keeps the cutting result", () => {
    const d = { pieces: [{ id: 1, partId: "b1", name: "old", profile: "L75x50x6", material: "P265 GH", length: 14752, qty: 6 }], result: { bars: [] } };
    expect((overlayRows(d, "1D", [bar()]).data as { result: unknown }).result).not.toBeNull();
  });
});

describe("round trip", () => {
  it("what the nest loads (overlay) never looks like an edit when it comes back", () => {
    const d2 = overlayRows(data2D(), "2D", [plate()]).data;
    expect(extractEdits(d2, "2D", [plate()])).toEqual([]);
    const d1 = overlayRows({ pieces: [{ id: 1, partId: "b1", name: "x", profile: "IPE100", material: "", length: 100, qty: 1 }] }, "1D", [bar()]).data;
    expect(extractEdits(d1, "1D", [bar()], () => 5)).toEqual([]);
  });
  it("a Part List rename wins over the stale name in an old snapshot, and the next save does not undo it", () => {
    const renamed = plate({ description: "Base plate 5802×400" });
    const loaded = overlayRows(data2D(), "2D", [renamed]).data;
    expect((loaded as { groups: { name: string }[] }).groups[0].name).toBe("Base plate 5802×400");
    expect(extractEdits(loaded, "2D", [renamed])).toEqual([]);
  });
});

describe("removeRows / takeRemovedIds", () => {
  it("removes the row, its paired copies and its segmented pieces, and clears the result", () => {
    const d = data2D([{ id: 10, cid: 7, name: "copy" }, { id: 11, name: "7-1", seg: { role: "child", parentId: 7 } }, { id: 12, name: "other" }]);
    const r = removeRows(d, "2D", [7]);
    expect((r.data as { groups: { id: number }[] }).groups.map((g) => g.id)).toEqual([12]);
    expect(r.removed).toEqual([7]); // the requested rows that were found
    expect((r.data as { result: unknown }).result).toBeNull();
  });
  it("1D: removes the piece and its segments", () => {
    const d = { pieces: [{ id: 1, name: "a" }, { id: 2, name: "a-1", segment: { index: 1, total: 2, parentId: 1, parentLength: 5 } }, { id: 3, name: "b" }], result: {} };
    expect((removeRows(d, "1D", [1]).data as { pieces: { id: number }[] }).pieces.map((p) => p.id)).toEqual([3]);
  });
  it("1D: a piece sent from the Part List is removed by the part's id, and partIdsOfRows reads it from the old snapshot", () => {
    const d = { pieces: [{ id: 1, partId: "b1", name: "a" }, { id: 2, name: "b" }], result: {} };
    expect(partIdsOfRows(d, "1D", [1, 2])).toEqual(["b1"]);
    expect(partIdsOfRows(d, "2D", [1])).toEqual([]);
    expect((removeRows(d, "1D", [], ["b1"]).data as { pieces: { id: number }[] }).pieces.map((p) => p.id)).toEqual([2]);
  });
  it("nothing to remove returns the same object", () => {
    const d = data2D();
    expect(removeRows(d, "2D", [99]).data).toBe(d);
  });
  it("takeRemovedIds strips the tombstones and de-duplicates", () => {
    const r = takeRemovedIds({ v: 1, removedIds: [3, 3, "x", 4] });
    expect(r.ids).toEqual([3, 4]);
    expect(r.data).toEqual({ v: 1 });
    expect(takeRemovedIds({ v: 1 }).ids).toEqual([]);
  });
});
