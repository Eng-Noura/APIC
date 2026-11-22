import { describe, it, expect } from "vitest";
import { UNASSIGNED, assemblyScope, assemblyWithDescendants, dropStaleFilters, emptyFilters, filtersActive, matchesFilters } from "./part-filters";
import type { TakeoffPartRow } from "./types";

const part = (o: Partial<TakeoffPartRow>): TakeoffPartRow => ({
  id: "p", itemNo: 1, description: "Plate", material: "S235", partType: "PLATE", side: "BOTH", groupId: null, posNo: null,
  qtyPerAssembly: 1, remark: null, scopeId: null, workOrderGroupId: null, nestKind: null, nestPartId: null, qty: 1,
  thicknessMm: 8, geometry: {}, areaFormula: null, paintSides: 0, totalArea: 1, volume: 0, weightKg: 10, paintAreaSqm: 0,
  buyWeightKg: null, scrapKg: null, scrapPct: null, dxf: null, ...o,
});

const asms = [
  { id: "A", parentId: null },
  { id: "A1", parentId: "A" },
  { id: "A11", parentId: "A1" },
  { id: "B", parentId: null },
];
const run = (parts: TakeoffPartRow[], f: Partial<typeof emptyFilters>) => {
  const filters = { ...emptyFilters, ...f };
  const ids = assemblyScope(filters, asms);
  return parts.filter((p) => matchesFilters(p, filters, ids));
};

describe("part list filters", () => {
  const parts = [
    part({ id: "1", groupId: "A", scopeId: "S1", workOrderGroupId: "W1", weightKg: 10 }),
    part({ id: "2", groupId: "A11", scopeId: "S2", workOrderGroupId: "W1", weightKg: 20 }),
    part({ id: "3", groupId: "B", scopeId: "S1", workOrderGroupId: null, weightKg: 30 }),
    part({ id: "4", groupId: null, scopeId: null, workOrderGroupId: null, weightKg: 40 }),
  ];

  it("no filter active -> every part", () => {
    expect(filtersActive(emptyFilters)).toBe(false);
    expect(run(parts, {}).map((p) => p.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("assembly filter includes the sub-assemblies", () => {
    expect(run(parts, { assembly: "A" }).map((p) => p.id)).toEqual(["1", "2"]);
    expect(run(parts, { assembly: "A11" }).map((p) => p.id)).toEqual(["2"]);
    expect(run(parts, { assembly: "B" }).map((p) => p.id)).toEqual(["3"]);
    expect(assemblyWithDescendants(asms, "A")).toEqual(new Set(["A", "A1", "A11"]));
  });

  it("scope and work-order filters", () => {
    expect(run(parts, { scope: "S1" }).map((p) => p.id)).toEqual(["1", "3"]);
    expect(run(parts, { workOrder: "W1" }).map((p) => p.id)).toEqual(["1", "2"]);
  });

  it("filters combine (all of them must match)", () => {
    expect(run(parts, { scope: "S1", workOrder: "W1" }).map((p) => p.id)).toEqual(["1"]);
    expect(run(parts, { assembly: "A", scope: "S2", workOrder: "W1" }).map((p) => p.id)).toEqual(["2"]);
    expect(run(parts, { assembly: "B", workOrder: "W1" })).toEqual([]);
  });

  it("'no assembly / scope / work order' picks the unassigned parts", () => {
    expect(run(parts, { assembly: UNASSIGNED }).map((p) => p.id)).toEqual(["4"]);
    expect(run(parts, { scope: UNASSIGNED }).map((p) => p.id)).toEqual(["4"]);
    expect(run(parts, { workOrder: UNASSIGNED }).map((p) => p.id)).toEqual(["3", "4"]);
  });

  it("the total weight is that of the filtered parts only", () => {
    const sum = (ps: TakeoffPartRow[]) => ps.reduce((s, p) => s + p.weightKg, 0);
    expect(sum(run(parts, {}))).toBe(100);
    expect(sum(run(parts, { scope: "S1" }))).toBe(40);
    expect(sum(run(parts, { assembly: "A", workOrder: "W1" }))).toBe(30);
  });

  it("still combines with the older filters (type / thickness / description / side)", () => {
    const more = [...parts, part({ id: "5", groupId: "A", scopeId: "S1", thicknessMm: 12, description: "Rib" })];
    expect(run(more, { scope: "S1", thickness: "12" }).map((p) => p.id)).toEqual(["5"]);
    expect(run(more, { assembly: "A", description: "rib" }).map((p) => p.id)).toEqual(["5"]);
  });

  it("a filter on a deleted assembly / scope / work order falls back to All", () => {
    const lists = { assemblies: [{ id: "A" }], scopes: [{ id: "S1" }], workOrders: [{ id: "W1" }] };
    const f = dropStaleFilters({ ...emptyFilters, assembly: "gone", scope: "S1", workOrder: "gone2" }, lists);
    expect([f.assembly, f.scope, f.workOrder]).toEqual(["ALL", "S1", "ALL"]);
    // lists not loaded yet: left untouched
    expect(dropStaleFilters({ ...emptyFilters, scope: "x" }, null).scope).toBe("x");
  });
});
