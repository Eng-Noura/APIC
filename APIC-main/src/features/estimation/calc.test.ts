import { describe, expect, it } from "vitest";
import { calcCommercial, calcEstimate, calcManufacturing, calcMaterials, calcProjectCosts, calcSubcontract, type ItemInput, type OperationInput, type ScrapSettings } from "./calc";

const scrap: ScrapSettings = { usedLaterPct: 0, usedLaterPricePerKg: 0, scrapSellPricePerKg: 15, creditRecoveredScrap: false };
const op = (o: Partial<OperationInput> & { id: string }): OperationInput => ({ selected: true, costType: "FIXED", rate: 0, quantity: null, percentBase: null, ...o });

describe("materials", () => {
  const lines = [
    { id: "a", source: "NESTING" as const, name: "S235 10mm", requiredKg: 4200, purchasedKg: 5000, unitPrice: 58 },
    { id: "b", source: "PART_LIST" as const, name: "S355 12mm", requiredKg: 1500, purchasedKg: 1500, unitPrice: 62 },
    { id: "m", source: "MANUAL" as const, name: "IPE 200", requiredKg: null, purchasedKg: 1000, unitPrice: 64 },
  ];
  it("costs the PURCHASED weight, so scrap is not added again", () => {
    const r = calcMaterials(lines, scrap);
    expect(r.grossCents).toBe((5000 * 58 + 1500 * 62 + 1000 * 64) * 100);
    expect(r.materialCostCents).toBe(r.grossCents);
    expect(r.scrap.scrapKg).toBe(800);
    expect(r.scrap.scrapPct).toBeCloseTo(800 / 7500, 6);
  });
  it("credits recovered scrap only when asked", () => {
    const r = calcMaterials(lines, { ...scrap, creditRecoveredScrap: true });
    expect(r.scrap.recoveredCents).toBe(800 * 15 * 100);
    expect(r.materialCostCents).toBe(r.grossCents - 800 * 15 * 100);
  });
  it("flags a purchase shortage and never gives negative scrap", () => {
    const r = calcMaterials([{ ...lines[0], requiredKg: 6000 }], scrap);
    expect(r.scrap.shortageKg).toBe(1000);
    expect(r.scrap.scrapKg).toBe(0);
  });
});

describe("manufacturing", () => {
  const item: ItemInput = {
    id: "riser", weightKg: 1000, pieces: 10,
    operations: [
      op({ id: "cut", costType: "PER_KG", rate: 45 }),
      op({ id: "weld", costType: "PER_METER", rate: 90, quantity: 400 }),
      op({ id: "roll", costType: "FIXED", rate: 5000, selected: false }),
      op({ id: "hole", costType: "PER_HOLE", rate: 15, quantity: 500 }),
      op({ id: "asm", costType: "PERCENTAGE", rate: 8, percentBase: "ITEM_OPERATIONS" }),
    ],
  };
  it("counts only selected operations and uses item data for per-kg", () => {
    const r = calcManufacturing([item], 0).items[0];
    const by = Object.fromEntries(r.operations.map((o) => [o.id, o]));
    expect(by.cut.amountCents).toBe(4_500_000);
    expect(by.weld.amountCents).toBe(3_600_000);
    expect(by.roll.contributes).toBe(false);
    expect(r.totalCents).toBe(4_500_000 + 3_600_000 + 750_000 + Math.round((4_500_000 + 3_600_000 + 750_000) * 0.08));
  });
  it("percentage base excludes unselected operations", () => {
    const r = calcManufacturing([{ ...item, operations: item.operations.map((o) => (o.id === "weld" ? { ...o, selected: false } : o)) }], 0).items[0];
    expect(r.operations.find((o) => o.id === "asm")!.amountCents).toBe(Math.round((4_500_000 + 750_000) * 0.08));
  });
  it("material-share base splits material cost by weight", () => {
    const items: ItemInput[] = [
      { id: "a", weightKg: 1000, pieces: 1, operations: [op({ id: "p", costType: "PERCENTAGE", rate: 10, percentBase: "ITEM_MATERIAL_SHARE" })] },
      { id: "b", weightKg: 500, pieces: 1, operations: [op({ id: "p", costType: "PERCENTAGE", rate: 10, percentBase: "ITEM_MATERIAL_SHARE" })] },
    ];
    const r = calcManufacturing(items, 150_000_00);
    expect(r.items[0].totalCents).toBe(100_000_00 * 0.1);
    expect(r.items[1].totalCents).toBe(50_000_00 * 0.1);
    expect(r.totalCents).toBe(r.items[0].totalCents + r.items[1].totalCents);
  });
  it("manual-quantity types without a quantity are flagged and cost nothing", () => {
    const r = calcManufacturing([{ ...item, operations: [op({ id: "x", costType: "PER_METER", rate: 20 })] }], 0).items[0];
    expect(r.operations[0].issue).toBeTruthy();
    expect(r.totalCents).toBe(0);
  });
  it("a percentage with no base is flagged", () => {
    const r = calcManufacturing([{ ...item, operations: [op({ id: "x", costType: "PERCENTAGE", rate: 5 })] }], 0).items[0];
    expect(r.operations[0].issue).toBeTruthy();
  });
});

describe("subcontractor", () => {
  it("totals separately", () => {
    const r = calcSubcontract([{ id: "1", quantity: 3, unitPrice: 25_000 }, { id: "2", quantity: 1.5, unitPrice: 0.1 }]);
    expect(r.totalCents).toBe(7_500_000 + 15);
  });
});

describe("project costs", () => {
  const ctx = { materialCents: 100_000_00, manufacturingCents: 50_000_00, subcontractorCents: 10_000_00, totalWeightKg: 2000 };
  it("handles each method, disabled rows and explicit percentage bases", () => {
    const r = calcProjectCosts([
      { id: "fix", enabled: true, method: "FIXED", rate: 25_000, quantity: null, percentBase: null },
      { id: "pct", enabled: true, method: "PERCENTAGE", rate: 5, quantity: null, percentBase: "DIRECT_COST" },
      { id: "ton", enabled: true, method: "PER_TON", rate: 800, quantity: null, percentBase: null },
      { id: "trip", enabled: true, method: "PER_TRIP", rate: 3000, quantity: 4, percentBase: null },
      { id: "off", enabled: false, method: "FIXED", rate: 99_999, quantity: null, percentBase: null },
    ], ctx);
    const by = Object.fromEntries(r.lines.map((l) => [l.id, l.amountCents]));
    expect(by.pct).toBe(160_000_00 * 0.05);
    expect(by.ton).toBe(2 * 800 * 100);
    expect(by.trip).toBe(12_000_00);
    expect(r.totalCents).toBe(25_000_00 + 8_000_00 + 1_600_00 + 12_000_00);
  });
});

describe("commercial price", () => {
  const base = { insuranceMode: "FIXED" as const, insuranceValue: 0, taxPct: 0 };
  it("markup on cost, then insurance, then tax on the whole price", () => {
    const r = calcCommercial(1_000_000_00, { ...base, profitMode: "MARKUP_ON_COST", profitValue: 20, insuranceValue: 1000, taxPct: 14 });
    expect(r.profitCents).toBe(200_000_00);
    expect(r.insuranceCents).toBe(1000_00);
    expect(r.taxableCents).toBe(1_201_000_00);
    expect(r.taxCents).toBe(168_140_00);
    expect(r.finalCents).toBe(1_369_140_00);
  });
  it("margin on price makes profit exactly p% of the pre-tax price", () => {
    const r = calcCommercial(800_000_00, { ...base, profitMode: "MARGIN_ON_PRICE", profitValue: 20 });
    expect(r.profitCents).toBe(200_000_00);
    expect(r.finalCents).toBe(1_000_000_00);
  });
  it("rejects a 100% margin and supports fixed profit and percent insurance", () => {
    expect(calcCommercial(100, { ...base, profitMode: "MARGIN_ON_PRICE", profitValue: 100 }).issue).toBeTruthy();
    const r = calcCommercial(100_00, { profitMode: "FIXED", profitValue: 10, insuranceMode: "PERCENT", insuranceValue: 5, taxPct: 0 });
    expect(r.profitCents).toBe(10_00);
    expect(r.insuranceCents).toBe(5_50);
  });
  it("has no floating-point drift on awkward numbers", () => {
    const r = calcCommercial(toC(0.1 + 0.2), { ...base, profitMode: "MARKUP_ON_COST", profitValue: 10, taxPct: 14 });
    expect(Number.isInteger(r.finalCents)).toBe(true);
  });
});
const toC = (x: number) => Math.round(x * 100);

describe("whole estimate", () => {
  it("aggregates the four stages", () => {
    const r = calcEstimate({
      materials: [{ id: "m", source: "MANUAL", name: "Plate", requiredKg: null, purchasedKg: 1000, unitPrice: 50 }], scrap,
      items: [{ id: "i", weightKg: 1000, pieces: 1, operations: [op({ id: "o", costType: "PER_KG", rate: 10 })] }],
      subcontracts: [{ id: "s", quantity: 1, unitPrice: 2000 }],
      projectCosts: [{ id: "p", enabled: true, method: "FIXED", rate: 3000, quantity: null, percentBase: null }],
      commercial: { profitMode: "MARKUP_ON_COST", profitValue: 10, insuranceMode: "FIXED", insuranceValue: 0, taxPct: 0 },
    });
    expect(r.totals).toEqual({ materialCents: 5_000_000, manufacturingCents: 1_000_000, subcontractorCents: 200_000, projectCents: 300_000, estimatedCostCents: 6_500_000 });
    expect(r.commercial.finalCents).toBe(7_150_000);
  });
});

// ------------------------------------------------------------------ v2: item-based estimate
import { allocateCents, calcEstimate, type EstimateInputs } from "./calc";

const base = (): EstimateInputs => ({
  scrap, allocationBasis: "WEIGHT",
  materials: [
    { id: "m1", itemId: "A", source: "NESTING", name: "S235 10mm", requiredKg: 800, purchasedKg: 1000, unitPrice: 50 },
    { id: "m2", itemId: "B", source: "PART_LIST", name: "S355 12mm", requiredKg: 500, purchasedKg: 500, unitPrice: 60 },
    { id: "m3", itemId: null, source: "MANUAL", name: "Consumables", requiredKg: null, purchasedKg: 100, unitPrice: 10 },
  ],
  items: [
    { id: "A", weightKg: 800, pieces: 4, operations: [op({ id: "a1", costType: "PER_KG", rate: 10 }), op({ id: "a2", costType: "FIXED", rate: 5000 })] },
    { id: "B", weightKg: 200, pieces: 2, operations: [op({ id: "b1", costType: "FIXED", rate: 1000 }), op({ id: "b2", costType: "FIXED", rate: 999, selected: false })] },
  ],
  subcontracts: [
    { id: "s1", itemId: "A", quantity: 800, unitPrice: 6, costType: "PER_UNIT" },
    { id: "s2", itemId: null, quantity: 1, unitPrice: 2000, costType: "FIXED" },
    { id: "s3", itemId: "B", quantity: 1, unitPrice: 5, costType: "PERCENTAGE", percentBase: "MATERIAL_COST" },
    { id: "s4", itemId: "B", quantity: 1, unitPrice: 777, costType: "FIXED", selected: false },
  ],
  projectCosts: [
    { id: "p1", enabled: true, method: "FIXED", rate: 1000, quantity: null, percentBase: null },
    { id: "p2", enabled: true, method: "FIXED", rate: 500, quantity: null, percentBase: null, itemId: "B" },
    { id: "p3", enabled: true, method: "PERCENTAGE", rate: 10, quantity: null, percentBase: "MATERIAL_COST", itemId: "A" },
  ],
  commercial: { profitMode: "MARKUP_ON_COST", profitValue: 20, insuranceMode: "FIXED", insuranceValue: 1000, taxPct: 14 },
});

describe("item-based estimate", () => {
  const r = calcEstimate(base());
  it("keeps each item's materials, operations and services independent", () => {
    const [a, b] = r.items;
    expect(a.materialCents).toBe(50_000_00);
    expect(b.materialCents).toBe(30_000_00);
    expect(a.manufacturingCents).toBe(8_000_00 + 5_000_00);
    expect(b.manufacturingCents).toBe(1_000_00); // unselected 999 ignored
    expect(a.subcontractCents).toBe(4_800_00);
    expect(b.subcontractCents).toBe(1_500_00); // 5% of its own material (30,000)
  });
  it("counts unselected subcontract lines in no total", () => {
    expect(r.totals.subcontractorCents).toBe(4_800_00 + 2_000_00 + 1_500_00);
  });
  it("shared material and project-level services stay out of the items but inside the totals", () => {
    expect(r.shared.materialCents).toBe(1_000_00);
    expect(r.shared.subcontractCents).toBe(2_000_00);
    expect(r.totals.materialCents).toBe(50_000_00 + 30_000_00 + 1_000_00);
  });
  it("assigns item costs to their item and spreads shared ones by weight, once", () => {
    const [a, b] = r.items;
    expect(a.projectCents).toBe(5_000_00 /*10% of A material*/ + 800_00); // + 80% of 1000
    expect(b.projectCents).toBe(500_00 + 200_00);
    expect(r.totals.projectCents).toBe(1_000_00 + 500_00 + 5_000_00);
  });
  it("item costs + shared pool = total estimated cost; item finals add up to the final price", () => {
    const sum = r.items.reduce((x, i) => x + i.costCents, 0) + r.shared.costCents;
    expect(sum).toBe(r.totals.estimatedCostCents);
    expect(r.items.reduce((x, i) => x + i.finalCents, 0) + r.shared.finalCents).toBe(r.commercial.finalCents);
  });
  it("gives final rates per kg and per ton", () => {
    expect(r.rates.totalWeightKg).toBe(1000);
    expect(r.rates.finalPerTon).toBeCloseTo(r.commercial.finalCents / 100, 2);
  });
  it("is deterministic: recalculating the same inputs (a stored snapshot) gives the identical result", () => {
    const snap = JSON.parse(JSON.stringify(base()));
    expect(calcEstimate(snap)).toEqual(r);
  });
  it("a line pointing at a deleted item becomes shared instead of vanishing", () => {
    const i = base(); i.materials[0].itemId = "gone";
    const x = calcEstimate(i);
    expect(x.totals.materialCents).toBe(r.totals.materialCents);
    expect(x.shared.materialCents).toBe(1_000_00 + 50_000_00);
  });
});

describe("allocateCents", () => {
  it("always sums to the total", () => { expect(allocateCents(100, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100); });
  it("falls back to an equal split when all weights are 0", () => { expect(allocateCents(10, [0, 0])).toEqual([5, 5]); });
  it("handles no items", () => { expect(allocateCents(10, [])).toEqual([]); });
});

describe("scrap price source", () => {
  it("SCRAP-priced lines use the kg the parts use and are never credited for recovered scrap again", () => {
    const lines = [{ id: "x", source: "NESTING" as const, name: "P", requiredKg: 800, purchasedKg: 1000, unitPrice: 60, priceSource: "SCRAP" as const }];
    const r = calcMaterials(lines, { ...scrap, creditRecoveredScrap: true });
    expect(r.materialCostCents).toBe(800 * 60 * 100);
    expect(r.scrap.recoveredCents).toBe(0);
  });
  it("warns instead of inventing a price", () => {
    const r = calcMaterials([{ id: "x", source: "MANUAL", name: "?", requiredKg: null, purchasedKg: 10, unitPrice: 0 }], scrap);
    expect(r.lines[0].issue).toBeTruthy();
  });
});

describe("commercial — margin vs markup, discount, other charges, tax", () => {
  const c = { insuranceMode: "FIXED" as const, insuranceValue: 0, taxPct: 0 };
  it("20% markup and 20% margin are different prices", () => {
    expect(calcCommercial(100_000_00, { ...c, profitMode: "MARKUP_ON_COST", profitValue: 20 }).profitCents).toBe(20_000_00);
    expect(calcCommercial(100_000_00, { ...c, profitMode: "MARGIN_ON_PRICE", profitValue: 20 }).profitCents).toBe(25_000_00);
  });
  it("reports markup and margin separately", () => {
    const r = calcCommercial(100_000_00, { ...c, profitMode: "MARKUP_ON_COST", profitValue: 25 });
    expect(r.markupPct).toBe(25); expect(r.marginPct).toBe(20);
  });
  it("applies insurance % to cost+profit and tax to the whole taxable amount", () => {
    const r = calcCommercial(100_000_00, { profitMode: "MARKUP_ON_COST", profitValue: 20, insuranceMode: "PERCENT", insuranceValue: 1, taxPct: 14 });
    expect(r.insuranceCents).toBe(1_200_00);
    expect(r.taxCents).toBe(Math.round(121_200_00 * 0.14));
    expect(r.finalCents).toBe(121_200_00 + r.taxCents);
  });
  it("discount before tax lowers the tax; after tax does not", () => {
    const i = { ...c, taxPct: 10, profitMode: "FIXED" as const, profitValue: 0, discountMode: "FIXED" as const, discountValue: 10_000 };
    const before = calcCommercial(100_000_00, { ...i, discountTiming: "BEFORE_TAX" });
    const after = calcCommercial(100_000_00, { ...i, discountTiming: "AFTER_TAX" });
    expect(before.finalCents).toBe(90_000_00 + 9_000_00);
    expect(after.finalCents).toBe(100_000_00 + 10_000_00 - 10_000_00);
  });
  it("non-taxable other charges are added after tax", () => {
    const r = calcCommercial(100_000_00, { ...c, taxPct: 10, profitMode: "FIXED", profitValue: 0, otherChargesValue: 2_000, otherChargesTaxable: false });
    expect(r.taxCents).toBe(10_000_00);
    expect(r.finalCents).toBe(100_000_00 + 2_000_00 + 10_000_00);
  });
  it("rejects impossible values with a message, never NaN", () => {
    expect(calcCommercial(1000, { ...c, profitMode: "MARGIN_ON_PRICE", profitValue: 100 }).issue).toBeTruthy();
    expect(calcCommercial(1000_00, { ...c, profitMode: "FIXED", profitValue: 0, discountMode: "PERCENT", discountValue: 150 }).issue).toBeTruthy();
  });
  it("reports the gap to a target price without changing the price", () => {
    const r = calcCommercial(100_000_00, { ...c, profitMode: "FIXED", profitValue: 0, targetSaleCents: 95_000_00 });
    expect(r.targetGapCents).toBe(5_000_00); expect(r.finalCents).toBe(100_000_00);
  });
});
