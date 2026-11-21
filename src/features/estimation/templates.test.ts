import { describe, expect, it } from "vitest";
import { nameKey, operationSeed, planApply, projectCostSeed, subcontractSeed } from "./templates";

describe("template seeds", () => {
  it("operation: selected, keeps the template's rate, drops percentBase unless PERCENTAGE", () => {
    const s = operationSeed("Welding", { costType: "PER_METER", unit: "M", rate: 12.5, percentBase: "ITEM_OPERATIONS" });
    expect(s).toMatchObject({ name: "Welding", costType: "PER_METER", rate: 12.5, selected: true, percentBase: null, quantity: null });
    const p = operationSeed("Assembly", { costType: "PERCENTAGE", unit: "%", rate: 8, percentBase: "ITEM_OPERATIONS" });
    expect(p.percentBase).toBe("ITEM_OPERATIONS");
  });

  it("operation: a PERCENTAGE template without a base keeps null (the validator rejects it earlier)", () => {
    expect(operationSeed("X", { costType: "PERCENTAGE", unit: "%", rate: 5 }).percentBase).toBeNull();
  });

  it("project cost: enabled, category defaults to empty, percentBase only for PERCENTAGE", () => {
    expect(projectCostSeed("NDT", { method: "PER_TEST", unit: "test", rate: 40, percentBase: "DIRECT_COST" })).toMatchObject({ enabled: true, category: "", percentBase: null, rate: 40 });
    expect(projectCostSeed("QA/QC", { method: "PERCENTAGE", unit: "%", rate: 2, percentBase: "DIRECT_COST", category: "Quality" })).toMatchObject({ percentBase: "DIRECT_COST", category: "Quality" });
  });

  it("subcontract: PER_UNIT by default, selected, blank strings become null", () => {
    const s = subcontractSeed("Blasting", { unit: "m²", quantity: 100, unitPrice: 3, company: "", notes: "" });
    expect(s).toMatchObject({ costType: "PER_UNIT", selected: true, company: null, notes: null, percentBase: null, quantity: 100, unitPrice: 3 });
    expect(subcontractSeed("Galvanizing", { unit: "%", quantity: 1, unitPrice: 6, costType: "PERCENTAGE", percentBase: "MATERIAL_COST" }).percentBase).toBe("MATERIAL_COST");
  });
});

describe("planApply", () => {
  it("adds when nothing with that name exists", () => {
    expect(planApply("OPERATION", "Welding", undefined)).toEqual({ action: "ADD" });
    expect(planApply("PROJECT_COST", "Crane", undefined)).toEqual({ action: "ADD" });
  });

  it("fills an untouched default operation (DEFAULT source, unselected, rate 0)", () => {
    expect(planApply("OPERATION", "Welding", { id: "o1", source: "DEFAULT", rate: 0, selected: false })).toEqual({ action: "FILL", id: "o1" });
  });

  it("refuses to overwrite an operation that is selected, priced or typed in by hand", () => {
    for (const ex of [
      { id: "o1", source: "DEFAULT", rate: 0, selected: true },
      { id: "o1", source: "DEFAULT", rate: 3, selected: false },
      { id: "o1", source: "MANUAL", rate: 0, selected: false },
    ]) expect(planApply("OPERATION", "Welding", ex).action).toBe("CONFLICT");
  });

  it("a default project cost with rate 0 is filled; a priced or manual one is a conflict", () => {
    expect(planApply("PROJECT_COST", "Engineering", { id: "c1", source: "DEFAULT", rate: 0 })).toEqual({ action: "FILL", id: "c1" });
    expect(planApply("PROJECT_COST", "Engineering", { id: "c1", source: "DEFAULT", rate: 500 }).action).toBe("CONFLICT");
    expect(planApply("PROJECT_COST", "Engineering", { id: "c1", source: "MANUAL", rate: 0 }).action).toBe("CONFLICT");
  });

  it("project cost 'selected' is irrelevant: only operations look at it", () => {
    expect(planApply("PROJECT_COST", "Engineering", { id: "c1", source: "DEFAULT", rate: 0, selected: true }).action).toBe("FILL");
  });

  it("subcontract services are always added, even when the same name exists", () => {
    expect(planApply("SUBCONTRACT", "Blasting", { id: "s1", source: "MANUAL", rate: 9, selected: true })).toEqual({ action: "ADD" });
  });

  it("the conflict message names the line and says what to do", () => {
    const r = planApply("OPERATION", "Welding", { id: "o1", source: "MANUAL", rate: 1 });
    expect(r.action === "CONFLICT" && r.reason).toContain("Welding");
  });
});

describe("nameKey", () => {
  it("ignores case, outer and repeated whitespace", () => {
    expect(nameKey("  Final   Painting ")).toBe(nameKey("final painting"));
    expect(nameKey("A")).not.toBe(nameKey("B"));
  });
});
