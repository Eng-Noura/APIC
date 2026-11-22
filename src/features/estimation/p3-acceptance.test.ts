// P3 acceptance scenarios, the parts that can be checked with pure TypeScript (calculation, snapshots, offer lines). Scenarios that
// need a database (materials read from Part List, persistence after reload, other modules unaffected) are NOT covered here:
// see the README. Nothing in this file touches a database.

import { describe, expect, it } from "vitest";
import { calcEstimate, type EstimateInputs } from "./calc";
import { buildSnapshot, verifySnapshot } from "./workflow";
import { buildOfferLines, pickApprovedSnapshot } from "./offer";
import { editMaterialPrice, materialEditState, scrapOf } from "./sheet-view";
import type { EstMaterial, EstSettings } from "./types";

const base = (): EstimateInputs => ({
  materials: [
    { id: "m1", source: "PART_LIST", name: "Plate", itemId: "i1", requiredKg: 100, purchasedKg: 110, unitPrice: 20, priceSource: "PROCUREMENT" },
    { id: "m2", source: "PART_LIST", name: "Pipe", itemId: "i2", requiredKg: 200, purchasedKg: 200, unitPrice: 30, priceSource: "PROCUREMENT" },
  ],
  scrap: { usedLaterPct: 0, usedLaterPricePerKg: 0, scrapSellPricePerKg: 0, creditRecoveredScrap: false },
  items: [
    { id: "i1", weightKg: 100, pieces: 4, operations: [{ id: "o1", selected: true, costType: "PER_KG", rate: 2, quantity: null, percentBase: null }, { id: "o2", selected: false, costType: "FIXED", rate: 999, quantity: null, percentBase: null }] },
    { id: "i2", weightKg: 200, pieces: 2, operations: [{ id: "o3", selected: true, costType: "PER_PIECE", rate: 50, quantity: null, percentBase: null }, { id: "o4", selected: true, costType: "FIXED", rate: 1000, quantity: null, percentBase: null }] },
  ],
  subcontracts: [], projectCosts: [],
  commercial: { profitMode: "MARKUP_ON_COST", profitValue: 10, insuranceMode: "FIXED", insuranceValue: 0, taxPct: 14 },
});
const items = (r: ReturnType<typeof calcEstimate>) => Object.fromEntries(r.manufacturing.items.map((i) => [i.id, i.totalCents]));

describe("3 · different operations for each item", () => {
  it("each item is priced from its own selected operations; an unselected operation costs nothing", () => {
    const m = items(calcEstimate(base()));
    expect(m.i1).toBe(100 * 2 * 100);             // 100 kg × 2, the FIXED 999 is not selected
    expect(m.i2).toBe(2 * 50 * 100 + 1000 * 100); // 2 pieces × 50 + fixed 1000
  });
});

describe("4 · custom operation", () => {
  it("a CUSTOM operation is rate × quantity and joins the item's manufacturing cost", () => {
    const i = base(); i.items[0].operations.push({ id: "oc", selected: true, costType: "CUSTOM", rate: 100, quantity: 3, percentBase: null });
    expect(items(calcEstimate(i)).i1).toBe(100 * 2 * 100 + 3 * 100 * 100);
  });
});

describe("5 · subcontractor", () => {
  it("is kept apart from internal manufacturing and lands on its item", () => {
    const i = base(); i.subcontracts.push({ id: "s1", quantity: 2, unitPrice: 400, itemId: "i1", selected: true, costType: "PER_UNIT", percentBase: null });
    const r = calcEstimate(i); const r0 = calcEstimate(base());
    expect(r.subcontract.totalCents).toBe(80000);
    expect(r.manufacturing.totalCents).toBe(r0.manufacturing.totalCents);
    expect(r.items.find((x) => x.id === "i1")!.subcontractCents).toBe(80000);
    expect(r.totals.estimatedCostCents).toBe(r0.totals.estimatedCostCents + 80000);
  });
  it("a project-wide service (no item) is shared, and the item shares still add up", () => {
    const i = base(); i.subcontracts.push({ id: "s2", quantity: 1, unitPrice: 900, itemId: null, selected: true, costType: "PER_UNIT", percentBase: null });
    const r = calcEstimate(i);
    expect(r.items.reduce((a, x) => a + x.finalCents, 0) + r.shared.finalCents).toBe(r.commercial.finalCents);
  });
});

describe("6 · project costs", () => {
  it("fixed and percentage costs are added; the shared part is spread over the items without losing a cent", () => {
    const i = base();
    i.projectCosts.push({ id: "c1", enabled: true, method: "FIXED", rate: 1001, quantity: null, percentBase: null, itemId: null }, { id: "c2", enabled: true, method: "PERCENTAGE", rate: 5, quantity: null, percentBase: "DIRECT_COST", itemId: null }, { id: "c3", enabled: false, method: "FIXED", rate: 5000, quantity: null, percentBase: null, itemId: null });
    const r = calcEstimate(i);
    expect(r.project.totalCents).toBeGreaterThan(100100);
    expect(r.items.reduce((a, x) => a + x.projectCents, 0) + r.shared.projectCents).toBe(r.totals.projectCents);
    expect(r.project.totalCents).toBe(calcEstimate({ ...i, projectCosts: i.projectCosts.slice(0, 2) }).project.totalCents); // the disabled one is ignored
  });
});

describe("7 · final commercial price", () => {
  it("cost + profit + insurance + other charges + tax − discount, in cents, and the item shares add up to it", () => {
    const i = base();
    i.commercial = { ...i.commercial, insuranceValue: 250, discountMode: "PERCENT", discountValue: 2, discountTiming: "BEFORE_TAX", otherChargesValue: 120, otherChargesTaxable: false };
    const c = calcEstimate(i).commercial;
    expect(c.finalCents).toBe(c.costCents + c.profitCents + c.insuranceCents + c.otherChargesCents + c.taxCents - c.discountCents);
    const r = calcEstimate(i);
    expect(r.items.reduce((a, x) => a + x.finalCents, 0) + r.shared.finalCents).toBe(c.finalCents);
  });
});

describe("2 · editable prices (the logic side)", () => {
  const settings = { scrapUsedLaterPct: 0, scrapUsedLaterPrice: 0, scrapSellPrice: 0, creditRecoveredScrap: false } as EstSettings;
  const line: EstMaterial = { id: "m1", source: "PART_LIST", name: "Plate", grade: null, thicknessMm: null, requiredKg: 100, purchasedKg: 110, unitPrice: 20, sourceRequiredKg: 100, sourcePurchasedKg: 110, suggestedUnitPrice: 20, sourceMissing: false, itemId: "i1", priceSource: "PROCUREMENT", priceOptions: { procurement: 20, stock: null, scrap: null } };
  it("a typed price is kept as Manual and the imported values stay known, so it can be restored", () => {
    const edited = editMaterialPrice(line, 35);
    const st = materialEditState(edited, scrapOf(settings));
    expect(edited).toMatchObject({ unitPrice: 35, priceSource: "MANUAL", sourcePurchasedKg: 110 });
    expect(st).toMatchObject({ priceEdited: true, canRestore: true });
    expect(st.original).toMatchObject({ unitPrice: 20, priceSource: "PROCUREMENT", purchasedKg: 110 });
  });
});

describe("9 · versioning: an approved snapshot never changes", () => {
  it("a later calculation with different inputs leaves the approved snapshot exactly as it was, and an offer still prices from it", () => {
    const v1 = buildSnapshot(base());
    const approvedRow = { id: "a1", kind: "APPROVED", version: 1, createdAt: "2026-11-01T10:00:00Z", inputs: v1.inputs, result: v1.result };
    const frozen = JSON.stringify(approvedRow);
    const changed = base(); changed.materials[0].unitPrice = 99; changed.commercial.profitValue = 25;
    const v2 = buildSnapshot(changed);
    const calcRow = { id: "c2", kind: "CALCULATED", version: 2, createdAt: "2026-11-05T10:00:00Z", inputs: v2.inputs, result: v2.result };
    expect(JSON.stringify(approvedRow)).toBe(frozen);
    expect(v2.finalPriceCents).not.toBe(v1.finalPriceCents);
    expect(verifySnapshot(approvedRow)).toBe(true);
    const picked = pickApprovedSnapshot([calcRow, approvedRow])!;
    expect(picked.id).toBe("a1");
    const o = buildOfferLines("LUMP_SUM", picked.result, { projectName: "P", itemName: () => null });
    expect(o.ok && o.lines[0].unitRateCents).toBe(v1.finalPriceCents);
  });
});
