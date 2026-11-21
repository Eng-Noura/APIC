import { describe, expect, it } from "vitest";
import { calculateScrapRow, calculateScrapScenarios, calculateScrapTotals, type ScrapRowInput } from "./scrap-management";

// Fixtures from the reference workbook ("pricing" sheet): cost 46 LE/kg, scrap sold at 15 LE/kg.
function input(o: Partial<ScrapRowInput>): ScrapRowInput {
  return {
    key: "k", label: "PL 20 mm", material: "Steel", thicknessMm: 20, widthMm: 1500, lengthMm: 6000,
    usedAreaSqm: 18.91, usedWeightKg: 2968.34, buyQty: 4, buyAreaSqm: 36, buyWeightKg: 5652,
    costPerKg: 46, usedLaterPct: 0, usedLaterPriceLEPerKg: 46, scrapSellPriceLEPerKg: 15,
    ...o,
  };
}

describe("calculateScrapRow", () => {
  it("0% used later matches the workbook (PL 20 mm: 47% primary, 32% actual scrap)", () => {
    const r = calculateScrapRow(input({}));
    expect(r.primaryScrapPct).toBeCloseTo(0.4748, 3);
    expect(r.soldScrapKg).toBeCloseTo(2683.66, 2);
    expect(r.usedCostLE).toBeCloseTo(136543.64, 1);
    expect(r.netScrapLossLE).toBeCloseTo(83193.37, 0);
    expect(r.financialScrapPct).toBeCloseTo(0.32, 2);
  });

  it("keeping 50% of the scrap at cost price roughly halves the financial scrap %", () => {
    const r = calculateScrapRow(input({ usedLaterPct: 0.5 }));
    expect(r.usedLaterKg).toBeCloseTo(1341.83, 2);
    expect(r.usedLaterValueLE).toBeCloseTo(r.usedLaterCostLE, 6); // price = cost → no loss on kept part
    expect(r.financialScrapPct).toBeCloseTo(0.16, 2);
  });

  it("effective cost/kg = (used cost + net loss) / used kg", () => {
    const r = calculateScrapRow(input({}));
    expect(r.effectiveCostPerKg).toBeCloseTo((r.usedCostLE + r.netScrapLossLE) / r.usedWeightKg, 8);
    expect(r.effectiveCostPerKg).toBeGreaterThan(46);
  });

  it("flags a shortage instead of producing negative scrap (FB 90 x 20 in the workbook)", () => {
    const r = calculateScrapRow(input({ usedWeightKg: 1185.73, buyWeightKg: 763.02 }));
    expect(r.shortage).toBe(true);
    expect(r.shortageKg).toBeCloseTo(422.71, 2);
    expect(r.primaryScrapKg).toBe(0);
    expect(r.netScrapLossLE).toBe(0);
    expect(r.financialScrapPct).toBe(0);
  });

  it("clamps % used later to 0..1 and survives zero weights", () => {
    expect(calculateScrapRow(input({ usedLaterPct: 3 })).soldScrapKg).toBe(0);
    const empty = calculateScrapRow(input({ usedWeightKg: 0, buyWeightKg: 0, buyQty: 0 }));
    expect(empty.financialScrapPct).toBe(0);
    expect(empty.effectiveCostPerKg).toBe(46);
  });
});

describe("totals & scenarios", () => {
  const rows = [input({ key: "a" }), input({ key: "b", thicknessMm: 8, usedWeightKg: 1966.9, buyWeightKg: 2826 })];

  it("totals are ratios of sums, not averages of row %", () => {
    const t = calculateScrapTotals(rows.map(calculateScrapRow));
    const loss = rows.map(calculateScrapRow).reduce((s, r) => s + r.netScrapLossLE, 0);
    expect(t.financialScrapPct).toBeCloseTo(loss / ((5652 + 2826) * 46), 8);
  });

  it("scenario table: more reuse → lower scrap %, lower effective cost", () => {
    const s = calculateScrapScenarios(rows, [0, 0.5, 1]);
    expect(s[0].totals.financialScrapPct).toBeGreaterThan(s[1].totals.financialScrapPct);
    expect(s[1].totals.financialScrapPct).toBeGreaterThan(s[2].totals.financialScrapPct);
    expect(s[2].totals.financialScrapPct).toBeCloseTo(0, 8); // all kept at cost → no loss
    expect(s[0].totals.effectiveCostPerKg).toBeGreaterThan(s[2].totals.effectiveCostPerKg);
  });
});
