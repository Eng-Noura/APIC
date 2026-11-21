import { describe, expect, it } from "vitest";
import { calcItem, dedupeImported, lineComponent, profileLines, sheetTotals, type ItemRow, type RateProfileRow } from "./sheet-calc";

const rates = (m: Record<string, number>): RateProfileRow => ({ id: "g", scope: "GLOBAL", components: Object.entries(m).map(([key, rate]) => ({ key, rate, enabled: true })) });
const GLOBAL = rates({
  "fabrication.indirectPct": 0.05, "installation.indirectPct": 0.04, "installation.heightFactorPct": 0.05,
  "markup.material": 1.2, "markup.fabrication": 1.255, "markup.installation": 1.255, "markup.addOn": 1.2, "markup.subcontractor": 1.2,
  "subcontractor.indirectPct": 0.05, "sale.thirdPartyPct": 0.01, "sale.commissioningLump": 0, "sale.mobDemobPct": 0.1, "sale.insuranceDivisor": 0.9505, "sale.taxPct": 0.038,
});
const inst = (id: string, name: string, rate: number) => ({ id, category: "INSTALLATION", name, method: "PER_TON", rate, unit: "TON", enabled: true });
const item = (over: Partial<ItemRow> = {}): ItemRow => ({
  id: "i1", itemNo: "1", description: "Erection", unit: "TON", qty: 250, materials: [], overrides: [],
  components: [inst("a", "Handling", 800), inst("b", "Crane", 5200), inst("c", "Scaffolding", 5200), inst("d", "Man-hour", 7500), inst("e", "Tools", 800), inst("f", "PPE", 350), inst("g", "Paint", 300), inst("h", "Welding", 300)],
  ...over,
});

describe("sheet-calc", () => {
  it("reproduces the acceptance item from stored rows (unit rate 34,003.14)", () => {
    const c = calcItem(item(), "STANDARD", [GLOBAL]);
    expect(c.result.ok).toBe(true);
    expect(c.result.summary!.unitRate).toBeCloseTo(34003.1356, 2);
    expect(c.result.summary!.salePrice).toBeCloseTo(8500783.908, 2);
    expect(c.totalWeightKg).toBe(250000);
  });
  it("cost + profit = sale price", () => {
    const s = calcItem(item(), "STANDARD", [GLOBAL]).result.summary!;
    expect(s.totalCost + s.profit).toBeCloseTo(s.salePrice, 6);
  });
  it("item override beats every other layer", () => {
    const c = calcItem(item({ overrides: [{ rateKey: "markup.installation", value: 1.35 }] }), "STANDARD", [GLOBAL]);
    expect(c.result.trace["INSTALL_SALE"].rate).toMatchObject({ value: 1.35, layer: "OVERRIDE" });
  });
  it("a missing required rate is an error, never 0", () => {
    const c = calcItem(item(), "STANDARD", []);
    expect(c.result.ok).toBe(false);
    expect(c.result.summary).toBeNull();
    expect(c.issues.some((i) => i.code === "MISSING_RATE")).toBe(true);
  });
  it("material lines are quantity × unit cost, with the arithmetic in the trace", () => {
    const c = calcItem(item({ unit: "TON", qty: 10, components: [], materials: [{ id: "m1", source: "MANUAL", name: "Plate", qty: 12000, unit: "KG", unitCost: 40 }] }), "STANDARD", [GLOBAL]);
    expect(c.result.values["MATERIAL_COST"]).toBe(480000);
    expect(c.result.trace["mat:m1"].source).toContain("12000 KG × 40");
    expect(c.result.values["MATERIAL_SALE"]).toBeCloseTo(576000, 6);
  });
  it("rejects invalid units and negative quantities", () => {
    expect(calcItem(item({ unit: "FURLONG" }), "STANDARD", [GLOBAL]).result.ok).toBe(false);
    expect(calcItem(item({ qty: -1 }), "STANDARD", [GLOBAL]).result.ok).toBe(false);
    const bad = calcItem(item({ components: [], materials: [{ id: "m", source: "MANUAL", name: "X", qty: 1, unit: "BOX", unitCost: 1 }] }), "STANDARD", [GLOBAL]);
    expect(bad.issues.some((i) => i.code === "INVALID_UNIT")).toBe(true);
  });
  it("zero quantity does not crash and reports a warning", () => {
    const c = calcItem(item({ qty: 0 }), "STANDARD", [GLOBAL]);
    expect(c.result.ok).toBe(true);
    expect(c.result.summary!.unitRate).toBe(0);
    expect(c.issues.some((i) => i.code === "ZERO_QUANTITY")).toBe(true);
  });
  it("a percentage line cannot reference its own category (no cycle)", () => {
    const r = lineComponent({ id: "x", category: "FABRICATION", name: "Self", method: "PERCENT_OF_BASE", rate: 0.1, base: "FAB_DIRECT", enabled: true });
    expect(r.component).toBeUndefined();
    expect(r.issue?.severity).toBe("error");
    expect(lineComponent({ id: "y", category: "ADD_ON", name: "Transport", method: "PERCENT_OF_BASE", rate: 0.02, base: "MATERIAL_COST", enabled: true }).component).toBeDefined();
  });
  it("add-ons support fixed, percentage, per ton and per unit", () => {
    const base = { category: "ADD_ON", enabled: true } as const;
    const c = calcItem(item({ components: [
      { id: "t1", ...base, name: "Fixed", method: "FIXED_LUMP_SUM", rate: 1000 },
      { id: "t2", ...base, name: "Per ton", method: "PER_TON", rate: 10, unit: "TON" },
      { id: "t3", ...base, name: "Per trip", method: "PER_UNIT", rate: 50, unit: "EA" },
    ] }), "STANDARD", [GLOBAL]);
    expect(c.result.ok).toBe(false); // PER_UNIT on a TON item has no unit basis → explicit error, not 0
    expect(c.issues.some((i) => i.code === "MISSING_BASIS")).toBe(true);
  });
  it("sheet totals sum unrounded items and count failures", () => {
    const ok = calcItem(item(), "STANDARD", [GLOBAL]);
    const bad = calcItem(item({ id: "i2" }), "STANDARD", []);
    const t = sheetTotals([ok, ok, bad]);
    expect(t.priced).toBe(2);
    expect(t.failed).toBe(1);
    expect(t.salePrice).toBeCloseTo(2 * ok.result.summary!.salePrice, 6);
    expect(t.profitPct).toBeCloseTo(ok.result.summary!.profitPct, 8);
  });
  it("is deterministic and monotonic in the rates", () => {
    const a = calcItem(item(), "STANDARD", [GLOBAL]).result.summary!;
    const a2 = calcItem(item(), "STANDARD", [GLOBAL]).result.summary!;
    expect(a2).toEqual(a);
    const hi = calcItem(item({ components: item().components.map((c) => (c.id === "b" ? { ...c, rate: 6000 } : c)) }), "STANDARD", [GLOBAL]).result.summary!;
    expect(hi.salePrice).toBeGreaterThan(a.salePrice);
  });
  it("never counts an imported material twice", () => {
    const incoming = [{ importedRef: "nest:1:S355", name: "A" }, { importedRef: "nest:1:S355", name: "A dup" }, { importedRef: "nest:1:S275", name: "B" }];
    expect(dedupeImported(["nest:1:S355"], incoming).map((l) => l.importedRef)).toEqual(["nest:1:S275"]);
    expect(dedupeImported([], incoming)).toHaveLength(2);
    expect(dedupeImported([null, undefined], incoming)).toHaveLength(2);
  });
  it("line templates of a selected profile become item lines; unselected profiles add nothing", () => {
    const prof: RateProfileRow = { id: "p1", name: "Heavy Steel", scope: "GLOBAL", components: [{ key: "line.crane", name: "Crane", category: "INSTALLATION", method: "PER_TON", rate: 5200, unit: "TON", enabled: true }] };
    const none = item({ components: [] });
    expect(profileLines(none, [prof])).toHaveLength(0);
    const sel = item({ components: [], profileRefs: { INSTALLATION: "p1" } });
    expect(profileLines(sel, [prof])).toHaveLength(1);
    const c = calcItem(sel, "STANDARD", [GLOBAL, prof]);
    expect(c.result.values["INSTALL_LINES_SUM"]).toBe(5200 * 250);
    expect(c.result.trace["line:p1:line.crane"].source).toBe("line");
  });
  it("line templates never leak into the chain rate map", () => {
    const prof: RateProfileRow = { id: "p2", scope: "GLOBAL", components: [{ key: "line.x", category: "INSTALLATION", method: "PER_TON", rate: 1, enabled: true }] };
    const c = calcItem(item(), "STANDARD", [GLOBAL, prof]);
    expect(c.result.ok).toBe(true);
  });
});
