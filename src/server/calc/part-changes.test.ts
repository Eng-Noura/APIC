import { describe, expect, it } from "vitest";
import { describeChanges } from "./part-changes";

const base = { description: "Plate A", partType: "PLATE", side: "EXTERNAL", qty: 2, thicknessMm: 12, material: "S235", paintSides: 2, itemNo: 1, geometry: { width: 0.4, length: 5.8 } };

describe("describeChanges", () => {
  it("nothing typed = nothing to record", () => {
    expect(describeChanges(base, { ...base })).toEqual([]);
  });
  it("says what changed, with the old and the new value", () => {
    const out = describeChanges(base, { ...base, qty: 4, thicknessMm: 15, description: "Plate B", material: null });
    expect(out).toEqual(['name "Plate A" → "Plate B"', "qty 2 → 4", 'material "S235" → —', "thickness 12 → 15 mm"]);
  });
  it("reads the size from the geometry", () => {
    expect(describeChanges(base, { ...base, geometry: { width: 0.5, length: 5.8 } })).toEqual(["width 0.4 → 0.5"]);
  });
  it("a field left out of the update is not a change", () => {
    expect(describeChanges(base, { description: "Plate A" })).toEqual([]);
  });
  it("null and empty text are the same 'nothing'", () => {
    expect(describeChanges({ ...base, remark: null }, { ...base, remark: "" })).toEqual([]);
  });
});
