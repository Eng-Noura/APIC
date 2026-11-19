import { describe, expect, it } from "vitest";
import { ENGINE_VERSION, N, RATE_KEYS, buildSnapshot, buildSnapshotItem, priceItem, type Component, type PricingItemInput } from "./index";

const lines: Record<string, number> = { handling: 800, crane: 5200, scaffolding: 5200, manHour: 7500, tools: 800, ppe: 350, touchUp: 300, weldSurveyor: 300 };
const item = (tons: number, markup = 1.255): PricingItemInput => ({
  quantities: { weightTon: tons, weightKg: tons * 1000 }, divisorQty: tons, profile: "STANDARD",
  components: Object.keys(lines).map((k): Component => ({ id: `l.${k}`, name: k, category: "INSTALLATION", ledger: "COST", method: "PER_TON", rateKey: `install.${k}`, enabled: true })),
  layers: { global: {
    ...Object.fromEntries(Object.entries(lines).map(([k, v]) => [`install.${k}`, v])),
    [RATE_KEYS.installHeightFactorPct]: 0.05, [RATE_KEYS.installIndirectPct]: 0.04, [RATE_KEYS.markupInstallation]: markup,
    [RATE_KEYS.thirdPartyPct]: 0.01, [RATE_KEYS.mobDemobPct]: 0.1, [RATE_KEYS.insuranceDivisor]: 0.9505, [RATE_KEYS.taxPct]: 0.038 } },
});
const meta = { pricingItemId: "pi1", scopeItemId: "s1", itemNo: "1", description: "Erection", unit: "TON", qty: 250 };

describe("snapshot builder (rounding happens only here)", () => {
  const r = priceItem(item(250));
  it("rounds money to 2 dp, unit rate to 4 dp, profit % to 4 dp", () => {
    const s = buildSnapshotItem(meta, r);
    expect(s.unitRate).toBe(34_003.1356);
    expect(s.salePrice).toBe(8_500_783.91);
    expect(s.totalCost).toBe(7_077_157.16);
    expect(s.profit).toBe(1_423_626.75);
    expect(s.profitPct).toBe(0.2012);
    expect(s.data.values[N.UNIT_RATE]).toBe(34_003.1356);
  });
  it("records the rate and layer used for every priced node", () => {
    const s = buildSnapshotItem(meta, r);
    expect(s.data.rates[N.MOB_DEMOB]).toEqual({ value: 0.1, layer: "GLOBAL", key: RATE_KEYS.mobDemobPct });
  });
  it("is JSON-safe and independent of the live result (immutable copy)", () => {
    const p = buildSnapshot([{ meta, result: r }], { kind: "APPROVED", sheetVersion: 2, inputs: { a: 1 } });
    const json = JSON.stringify(p);
    expect(JSON.parse(json)).toEqual(p);
    r.values[N.SALE_PRICE] = 1; // mutate the live result afterwards
    expect(p.items[0].salePrice).toBe(8_500_783.91);
    r.values[N.SALE_PRICE] = priceItem(item(250)).values[N.SALE_PRICE];
    expect(p.engineVersion).toBe(ENGINE_VERSION);
    expect(p.roundingPolicy).toEqual({ money: 2, rate: 4, factor: 4 });
  });
  it("sums totals from unrounded values, then rounds once; cost + profit = sale", () => {
    const a = priceItem(item(250)), b = priceItem(item(13.37, 1.2));
    const p = buildSnapshot([{ meta, result: a }, { meta: { ...meta, pricingItemId: "pi2", itemNo: "2" }, result: b }], { kind: "CALCULATED", sheetVersion: 1, inputs: {} });
    expect(p.totals.salePrice).toBeCloseTo(a.values[N.SALE_PRICE] + b.values[N.SALE_PRICE], 2);
    expect(p.totals.totalCost + p.totals.profit).toBeCloseTo(p.totals.salePrice, 1);
    expect(Object.keys(p.ratesUsed)).toEqual(["pi1", "pi2"]);
  });
  it("refuses to snapshot a calculation with errors", () => {
    const bad = priceItem({ ...item(250), layers: { global: {} } });
    expect(bad.ok).toBe(false);
    expect(() => buildSnapshotItem(meta, bad)).toThrow(/calculation has errors/);
  });
  it("a later rate change does not alter an existing snapshot (re-pricing makes a new one)", () => {
    const before = buildSnapshot([{ meta, result: priceItem(item(250)) }], { kind: "APPROVED", sheetVersion: 1, inputs: {} });
    const after = buildSnapshot([{ meta, result: priceItem(item(250, 1.4)) }], { kind: "APPROVED", sheetVersion: 2, inputs: {} });
    expect(before.items[0].unitRate).toBe(34_003.1356);
    expect(after.items[0].unitRate).toBeGreaterThan(before.items[0].unitRate);
  });
});
