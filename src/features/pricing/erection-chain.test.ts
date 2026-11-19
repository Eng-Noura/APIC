import { describe, expect, it } from "vitest";
import { calcErectionChain, type ChainInput } from "./erection-chain";

// Item 1 of Cost_Estimation-1.xlsx: Erection – Steel Structure, 250 t. Expected values are the
// workbook's cached results (row 17), not recomputed here.
const W = 250;
const item1: ChainInput = {
  weight: W,
  lines: [
    { key: "handling", basis: W, rate: 800 },
    { key: "crane", basis: W, rate: 5200 },
    { key: "scaffolding", basis: W, rate: 5200 },
    { key: "manHour", basis: W, rate: 7500 },
    { key: "tools", basis: W, rate: 800 },
    { key: "ppe", basis: W, rate: 350 },
    { key: "touchUp", basis: W, rate: 300 },
    { key: "weldSurveyor", basis: W, rate: 300 },
  ],
  heightFactor: 0.05,
  installIndirect: 0.04,
  installMarkup: 1.255,
  thirdParty: 0.01,
  mobDemob: 0.1,
  insuranceDivisor: 0.9505,
  tax: 0.038,
};

describe("erection chain vs workbook row 17", () => {
  const r = calcErectionChain(item1);
  it("installation", () => {
    expect(r.linesTotal).toBeCloseTo(5_112_500, 2);
    expect(r.heightFactorAmount).toBeCloseTo(255_625, 2); // AM17
    expect(r.installDirect).toBeCloseTo(5_368_125, 2); // AN17
    expect(r.installIndirect).toBeCloseTo(214_725, 2); // AO17
    expect(r.installSale).toBeCloseTo(7_006_476.75, 2); // AP17
  });
  it("additions and totals", () => {
    expect(r.thirdParty).toBeCloseTo(70_064.7675, 4); // AS17
    expect(r.mobDemob).toBeCloseTo(707_654.15175, 4); // AV17
    expect(r.totalBeforeInsurance).toBeCloseTo(7_784_195.669249999, 4); // AW17
  });
  it("insurance, tax, sale price, unit rate", () => {
    expect(r.insurance).toBeCloseTo(405_384.2037, 3); // AX17 − AW17
    expect(r.tax).toBeCloseTo(311_204.03517254, 4); // AY17
    expect(r.salePrice).toBeCloseTo(8_500_783.90813414, 4); // AZ17
    expect(r.unitRate).toBeCloseTo(34_003.13563253656, 6); // BA17
    expect(r.unitRate.toFixed(2)).toBe("34003.14");
  });
  it("cost and profit", () => {
    expect(r.totalCost).toBeCloseTo(7_077_157.15813414, 4); // BB17
    expect(r.profit).toBeCloseTo(1_423_626.75, 4); // BC17
    expect(r.profitPct).toBeCloseTo(0.2011579958152763, 10); // BD17
    expect(r.totalCost + r.profit).toBeCloseTo(r.salePrice, 6);
  });
  it("zero weight does not divide by zero", () => {
    expect(calcErectionChain({ ...item1, weight: 0 }).unitRate).toBe(0);
  });
  it("lowering a rate lowers the price", () => {
    const lower = calcErectionChain({ ...item1, lines: item1.lines.map((l) => (l.key === "crane" ? { ...l, rate: 4000 } : l)) });
    expect(lower.salePrice).toBeLessThan(r.salePrice);
  });
});
