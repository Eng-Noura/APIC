import { describe, expect, it } from "vitest";
import { calcEstimate, type EstimateInputs } from "./calc";
import { buildOfferLines, offerProfitPct, offerTerms, pickApprovedSnapshot } from "./offer";

const inputs = (over: Partial<EstimateInputs> = {}): EstimateInputs => ({
  materials: [
    { id: "m1", source: "PART_LIST", name: "A", itemId: "i1", requiredKg: 100, purchasedKg: 100, unitPrice: 20, priceSource: "PROCUREMENT" },
    { id: "m2", source: "PART_LIST", name: "B", itemId: "i2", requiredKg: 50, purchasedKg: 60, unitPrice: 25, priceSource: "PROCUREMENT" },
    { id: "m3", source: "MANUAL", name: "Shared", itemId: null, requiredKg: null, purchasedKg: 10, unitPrice: 7, priceSource: "MANUAL" },
  ],
  scrap: { usedLaterPct: 0, usedLaterPricePerKg: 0, scrapSellPricePerKg: 0, creditRecoveredScrap: false },
  items: [{ id: "i1", weightKg: 100, pieces: 1, operations: [{ id: "o1", selected: true, costType: "FIXED", rate: 333.33, quantity: null, percentBase: null }] }, { id: "i2", weightKg: 50, pieces: 1, operations: [] }],
  subcontracts: [], projectCosts: [{ id: "c1", enabled: true, method: "FIXED", rate: 1000.01, quantity: null, percentBase: null, itemId: null }],
  commercial: { profitMode: "MARKUP_ON_COST", profitValue: 12.5, insuranceMode: "FIXED", insuranceValue: 100, taxPct: 14, discountMode: "PERCENT", discountValue: 3, discountTiming: "BEFORE_TAX" },
  ...over,
});
const names = (id: string) => ({ i1: "Riser", i2: "Skid" } as Record<string, string>)[id] ?? null;
const ctx = { projectName: "Plant A", itemName: names };

describe("buildOfferLines", () => {
  const r = calcEstimate(inputs());
  it("lump sum: one line with the snapshot's final price", () => {
    const o = buildOfferLines("LUMP_SUM", r, ctx);
    expect(o).toEqual({ ok: true, lines: [{ description: "Plant A — supply & fabrication (all inclusive)", qty: 1, unit: "lot", unitRateCents: r.commercial.finalCents }] });
  });
  it("per item: one line per item with the sheet's names, and the lines add up to the final price to the cent", () => {
    const o = buildOfferLines("PER_ITEM", r, ctx);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(o.lines.map((l) => l.description)).toContain("Riser");
    expect(o.lines.map((l) => l.description)).toContain("Skid");
    expect(o.lines.reduce((a, l) => a + l.unitRateCents, 0)).toBe(r.commercial.finalCents);
  });
  it("per item adds a shared line only when something is not tied to an item, and still adds up (odd cents, discount, tax)", () => {
    for (const taxPct of [0, 14, 5.5]) for (const insuranceValue of [0, 100.55]) {
      const res = calcEstimate(inputs({ commercial: { ...inputs().commercial, taxPct, insuranceValue } }));
      const o = buildOfferLines("PER_ITEM", res, ctx);
      expect(o.ok && o.lines.reduce((a, l) => a + l.unitRateCents, 0)).toBe(res.commercial.finalCents);
    }
  });
  it("per item refuses when an item's name is unknown: no invented label", () => {
    const o = buildOfferLines("PER_ITEM", r, { projectName: "P", itemName: (id) => (id === "i1" ? "Riser" : null) });
    expect(o).toMatchObject({ ok: false, status: 422 });
    expect(o.ok === false && o.reason).toMatch(/lump sum/i);
  });
  it("per item refuses when the lines would not add up to the final price (never fudged)", () => {
    const broken = { ...r, items: r.items.map((i, n) => (n === 0 ? { ...i, finalCents: i.finalCents + 1 } : i)) };
    expect(buildOfferLines("PER_ITEM", broken, ctx)).toMatchObject({ ok: false, status: 422 });
    expect(buildOfferLines("LUMP_SUM", broken, ctx).ok).toBe(true);
  });
  it("refuses a snapshot with an error-level issue, or with no price", () => {
    expect(buildOfferLines("LUMP_SUM", { ...r, issues: [{ level: "error", scope: "commercial", message: "bad" }] }, ctx)).toMatchObject({ ok: false, status: 422 });
    expect(buildOfferLines("LUMP_SUM", { ...r, issues: [{ level: "warning", scope: "commercial", message: "meh" }] }, ctx).ok).toBe(true);
    const empty = calcEstimate(inputs({ materials: [], items: [], projectCosts: [] }));
    expect(buildOfferLines("LUMP_SUM", empty, ctx)).toMatchObject({ ok: false });
  });
  it("per item with no items is refused", () => {
    const noItems = calcEstimate(inputs({ items: [], materials: [{ id: "m", source: "MANUAL", name: "X", itemId: null, requiredKg: null, purchasedKg: 10, unitPrice: 5, priceSource: "MANUAL" }], projectCosts: [] }));
    expect(buildOfferLines("PER_ITEM", noItems, ctx)).toMatchObject({ ok: false });
  });
});

describe("pickApprovedSnapshot", () => {
  const row = (id: string, kind: string, createdAt: string) => ({ id, kind, createdAt });
  it("takes the newest APPROVED one, never a CALCULATED one, even when it is newer", () => {
    const rows = [row("a", "APPROVED", "2026-11-01T10:00:00Z"), row("b", "CALCULATED", "2026-11-05T10:00:00Z"), row("c", "APPROVED", "2026-11-03T10:00:00Z")];
    expect(pickApprovedSnapshot(rows)?.id).toBe("c");
    expect(pickApprovedSnapshot([row("b", "CALCULATED", "2026-11-05T10:00:00Z")])).toBeNull();
    expect(pickApprovedSnapshot([])).toBeNull();
  });
});

describe("terms and profit", () => {
  it("keeps the wording the offer always had and omits what the sheet does not have", () => {
    expect(offerTerms({ paymentTerms: "30% advance", deliveryDays: 45, exclusions: "Erection" })).toBe("Payment terms: 30% advance\nDelivery period: 45 days\nExclusions: Erection");
    expect(offerTerms({ paymentTerms: null, deliveryDays: null, exclusions: null })).toBeNull();
    expect(offerTerms({ deliveryDays: 0 })).toBe("Delivery period: 0 days");
  });
  it("profit percentage of cost from the snapshot figures", () => {
    expect(offerProfitPct({ costCents: 20000, profitCents: 2500 })).toBe(12.5);
    expect(offerProfitPct({ costCents: 0, profitCents: 0 })).toBeNull();
  });
});
