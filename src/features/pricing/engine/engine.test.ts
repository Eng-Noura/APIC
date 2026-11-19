import { describe, expect, it } from "vitest";
import {
  CALC_PROFILES, N, RATE_KEYS, ROUNDING, buildPricingGraph, convert, deriveQuantities, evaluateGraph, parseUnit,
  priceItem, resolveRate, roundFactor, roundHalfAway, roundMoney, roundRate, topoSort,
  type CalcProfileId, type Category, type Component, type Method, type NodeSpec, type RateLayers,
} from "./index";

// ---------------------------------------------------------------- helpers
const comp = (id: string, method: Method, o: Partial<Component> = {}): Component => ({
  id, name: id, category: "INSTALLATION", ledger: "COST", method, enabled: true, ...o,
});
const spec = (c: Component): NodeSpec => ({ kind: "component", component: c });
const run = (c: Component, q = {}, layers: RateLayers = {}, extra: NodeSpec[] = []) =>
  evaluateGraph([...extra, spec(c)], { quantities: q, layers });
const derivedNode = (id: string, value: number, ledger: "COST" | "SALE" = "COST"): NodeSpec =>
  ({ kind: "derived", id, label: id, ledger, deps: [], formula: "const", fn: () => value });

// ---------------------------------------------------------------- methods
describe("calculation methods", () => {
  it("PER_TON / PER_KG / PER_SQM / PER_METER / PER_UNIT multiply the matching basis", () => {
    const q = { weightTon: 2, weightKg: 2000, areaSqm: 10, lengthM: 7, units: 3 };
    expect(run(comp("a", "PER_TON", { rate: 100 }), q).values.a).toBe(200);
    expect(run(comp("a", "PER_KG", { rate: 0.5 }), q).values.a).toBe(1000);
    expect(run(comp("a", "PER_SQM", { rate: 12 }), q).values.a).toBe(120);
    expect(run(comp("a", "PER_METER", { rate: 4 }), q).values.a).toBe(28);
    expect(run(comp("a", "PER_UNIT", { rate: 50 }), q).values.a).toBe(150);
  });
  it("PERCENT_OF_BASE uses the named base node", () => {
    const r = run(comp("p", "PERCENT_OF_BASE", { rate: 0.05, base: "b" }), {}, {}, [derivedNode("b", 1000)]);
    expect(r.values.p).toBeCloseTo(50, 10);
    expect(r.trace.p.inputs).toEqual([{ id: "b", value: 1000 }]);
  });
  it("FIXED_LUMP_SUM returns the amount regardless of quantity", () => {
    expect(run(comp("l", "FIXED_LUMP_SUM", { rate: 1234 }), { weightTon: 99 }).values.l).toBe(1234);
  });
  it("FIXED_PLUS_VARIABLE = fixed + rate × basis (unit required)", () => {
    const c = comp("f", "FIXED_PLUS_VARIABLE", { fixed: 500, rate: 10, unit: "TON" });
    expect(run(c, { weightTon: 4 }).values.f).toBe(540);
    expect(run({ ...c, unit: undefined }, { weightTon: 4 }).issues[0].code).toBe("UNIT_MISMATCH");
    expect(run({ ...c, fixed: undefined }, { weightTon: 4 }).issues[0].code).toBe("MISSING_RATE");
  });
  it("DIVISOR yields the INCREASE (base ÷ d − base); MARKUP yields base × m", () => {
    const d = run(comp("d", "DIVISOR", { rate: 0.9505, base: "b", ledger: "SALE" }), {}, {}, [derivedNode("b", 1000, "SALE")]);
    expect(d.values.d).toBeCloseTo(1000 / 0.9505 - 1000, 10);
    const m = run(comp("m", "MARKUP", { rate: 1.255, base: "b", ledger: "SALE" }), {}, {}, [derivedNode("b", 1000)]);
    expect(m.values.m).toBeCloseTo(1255, 10);
  });
  it("rejects divisor ≤ 0 and markup ≤ 0; warns on markup < 1", () => {
    const b = [derivedNode("b", 100)];
    expect(run(comp("d", "DIVISOR", { rate: 0, base: "b", ledger: "SALE" }), {}, {}, b).ok).toBe(false);
    expect(run(comp("m", "MARKUP", { rate: 0, base: "b", ledger: "SALE" }), {}, {}, b).ok).toBe(false);
    const low = run(comp("m", "MARKUP", { rate: 0.9, base: "b", ledger: "SALE" }), {}, {}, b);
    expect(low.ok).toBe(true);
    expect(low.issues.map((i) => i.code)).toContain("LOW_MARKUP");
  });
  it("a disabled component is 0 and says so in the trace", () => {
    const r = run(comp("x", "PER_TON", { rate: 100, enabled: false }), { weightTon: 5 });
    expect(r.values.x).toBe(0);
    expect(r.trace.x.status).toBe("DISABLED");
  });
  it("per-method unit must match when given; missing basis is an error, zero basis a warning", () => {
    expect(run(comp("a", "PER_TON", { rate: 1, unit: "KG" }), { weightTon: 1 }).issues[0].code).toBe("UNIT_MISMATCH");
    expect(run(comp("a", "PER_SQM", { rate: 1 }), { weightTon: 1 }).issues[0].code).toBe("MISSING_BASIS");
    const z = run(comp("a", "PER_TON", { rate: 1 }), { weightTon: 0 });
    expect(z.ok).toBe(true);
    expect(z.issues[0].code).toBe("ZERO_BASIS");
  });
});

// ---------------------------------------------------------------- rates
describe("rate inheritance", () => {
  const layers: RateLayers = { global: { k: 1, g: 10 }, project: { k: 2 }, profile: { k: 3 }, override: { k: 4 } };
  it("Override > Profile > Project > Global > component fallback", () => {
    expect(resolveRate("k", layers)).toEqual({ value: 4, layer: "OVERRIDE" });
    expect(resolveRate("k", { ...layers, override: {} })).toEqual({ value: 3, layer: "PROFILE" });
    expect(resolveRate("k", { global: layers.global, project: layers.project })).toEqual({ value: 2, layer: "PROJECT" });
    expect(resolveRate("g", layers)).toEqual({ value: 10, layer: "GLOBAL" });
    expect(resolveRate("zzz", layers, 7)).toEqual({ value: 7, layer: "COMPONENT" });
  });
  it("an override of 0 still wins (0 is a value, not 'missing')", () => {
    expect(resolveRate("k", { global: { k: 5 }, override: { k: 0 } })).toEqual({ value: 0, layer: "OVERRIDE" });
  });
  it("trace records which layer supplied the rate", () => {
    const r = run(comp("a", "PER_TON", { rateKey: "k" }), { weightTon: 2 }, layers);
    expect(r.values.a).toBe(8);
    expect(r.trace.a.rate).toEqual({ key: "k", value: 4, layer: "OVERRIDE" });
  });
  it("missing rate is an explicit error, never 0", () => {
    const r = run(comp("a", "PER_TON", { rateKey: "nope" }), { weightTon: 2 }, layers);
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe("MISSING_RATE");
    expect(r.values.a).toBeUndefined();
    expect(r.trace.a.status).toBe("ERROR");
  });
  it("negative or non-finite rates are rejected", () => {
    expect(run(comp("a", "PER_TON", { rate: -1 }), { weightTon: 1 }).issues[0].code).toBe("INVALID_RATE");
    expect(run(comp("a", "PER_TON", { rate: NaN }), { weightTon: 1 }).issues[0].code).toBe("INVALID_RATE");
  });
  it("dependents of a failed node are SKIPPED with a warning, not computed from garbage", () => {
    const r = evaluateGraph(
      [spec(comp("a", "PER_TON", { rateKey: "nope" })), spec(comp("p", "PERCENT_OF_BASE", { rate: 0.1, base: "a" }))],
      { quantities: { weightTon: 1 }, layers: {} },
    );
    expect(r.trace.p.status).toBe("SKIPPED");
    expect(r.values.p).toBeUndefined();
  });
});

// ---------------------------------------------------------------- units
describe("units and quantities", () => {
  it("parses known units case-insensitively and rejects unknown ones", () => {
    expect(parseUnit("ton")).toBe("TON");
    expect(parseUnit("kg")).toBe("KG");
    expect(parseUnit("M2")).toBe("SQM");
    expect(parseUnit("furlong")).toBeNull();
    expect(parseUnit("")).toBeNull();
    expect(parseUnit(null)).toBeNull();
  });
  it("converts only KG <-> TON", () => {
    expect(convert(2500, "KG", "TON")).toBe(2.5);
    expect(convert(2.5, "TON", "KG")).toBe(2500);
    expect(convert(3, "M", "M")).toBe(3);
    expect(() => convert(1, "M", "SQM")).toThrow(/UNIT_CONVERSION/);
    expect(() => convert(1, "EA", "TON")).toThrow();
  });
  it("derives bases per unit", () => {
    expect(deriveQuantities({ qty: 250, unit: "Ton" }).quantities).toMatchObject({ weightTon: 250, weightKg: 250_000 });
    expect(deriveQuantities({ qty: 340, unit: "SQM", unitWeightKg: 30 }).quantities).toMatchObject({ areaSqm: 340, weightKg: 10_200, weightTon: 10.2 });
    expect(deriveQuantities({ qty: 4, unit: "EA", unitWeightKg: 50 }).quantities).toMatchObject({ units: 4, weightKg: 200 });
  });
  it("invalid unit and negative / non-finite quantity are errors", () => {
    expect(deriveQuantities({ qty: 1, unit: "box" }).issues[0].code).toBe("INVALID_UNIT");
    expect(deriveQuantities({ qty: -1, unit: "ton" }).issues[0].code).toBe("INVALID_QUANTITY");
    expect(deriveQuantities({ qty: NaN, unit: "ton" }).quantities).toBeNull();
    expect(deriveQuantities({ qty: 1, unit: "EA", unitWeightKg: -5 }).issues[0].code).toBe("INVALID_QUANTITY");
  });
  it("zero quantity is allowed but flagged; EA with no unit weight has no weight basis", () => {
    const z = deriveQuantities({ qty: 0, unit: "ton" });
    expect(z.quantities).toMatchObject({ weightTon: 0 });
    expect(z.issues.map((i) => i.code)).toContain("ZERO_QUANTITY");
    const e = deriveQuantities({ qty: 3, unit: "EA" });
    expect(e.quantities?.weightTon).toBeUndefined();
    expect(e.issues.map((i) => i.code)).toContain("ZERO_WEIGHT");
  });
});

// ---------------------------------------------------------------- graph
describe("dependency graph", () => {
  it("orders by dependency regardless of input order", () => {
    const a = derivedNode("a", 1);
    const b: NodeSpec = { kind: "derived", id: "b", label: "b", ledger: "COST", deps: ["a"], formula: "a+1", fn: (v) => v.a + 1 };
    const r = evaluateGraph([b, a], { quantities: {}, layers: {} });
    expect(r.order).toEqual(["a", "b"]);
    expect(r.values.b).toBe(2);
  });
  it("detects cycles and reports the path", () => {
    const mk = (id: string, dep: string): NodeSpec => ({ kind: "derived", id, label: id, ledger: "COST", deps: [dep], formula: "", fn: () => 0 });
    const r = evaluateGraph([mk("a", "c"), mk("b", "a"), mk("c", "b")], { quantities: {}, layers: {} });
    expect(r.ok).toBe(false);
    const issue = r.issues.find((i) => i.code === "CYCLE")!;
    expect(issue.message).toMatch(/a → c → b → a|b → a → c → b|c → b → a → c/);
    expect(topoSort([mk("x", "x")]).cycle).toEqual(["x", "x"]);
  });
  it("flags unknown dependencies and duplicate ids", () => {
    const bad: NodeSpec = { kind: "derived", id: "b", label: "b", ledger: "COST", deps: ["ghost"], formula: "", fn: () => 0 };
    expect(evaluateGraph([bad], { quantities: {}, layers: {} }).issues[0].code).toBe("UNKNOWN_DEPENDENCY");
    expect(evaluateGraph([derivedNode("a", 1), derivedNode("a", 2)], { quantities: {}, layers: {} }).issues[0].code).toBe("DUPLICATE_NODE");
  });
  it("keeps cost and price separate: a COST node cannot read a SALE node", () => {
    const bad: NodeSpec = { kind: "derived", id: "c", label: "c", ledger: "COST", deps: ["s"], formula: "", fn: (v) => v.s };
    const r = evaluateGraph([derivedNode("s", 5, "SALE"), bad], { quantities: {}, layers: {} });
    expect(r.issues.map((i) => i.code)).toContain("LEDGER_MIX");
  });
  it("every value carries a trace with inputs and a numeric expression", () => {
    const r = priceItem(item1());
    const t = r.trace[N.MOB_DEMOB];
    expect(t.status).toBe("OK");
    expect(t.rate).toMatchObject({ key: RATE_KEYS.mobDemobPct, value: 0.1, layer: "GLOBAL" });
    expect(t.inputs).toEqual([{ id: N.SUBTOTAL, value: r.values[N.SUBTOTAL] }]);
    expect(t.expression).toContain("0.1");
    expect(r.trace[N.INSTALL_DIRECT].formula).toBe("lines + height factor");
    // every node in the order has a trace entry
    for (const id of r.order) expect(r.trace[id]).toBeDefined();
  });
});

// ---------------------------------------------------------------- acceptance: erection item 1
const W = 250;
const lineRates: Record<string, number> = { transportation: 0, handling: 800, packing: 0, crane: 5200, scaffolding: 5200, manHour: 7500, tools: 800, ppe: 350, touchUp: 300, weldSurveyor: 300 };
const installLines = (rates: Record<string, number>, keyPrefix = "install."): Component[] =>
  Object.keys(rates).map((k) => comp(`line.${k}`, "PER_TON", { name: k, rateKey: keyPrefix + k, category: "INSTALLATION" }));
const prefixed = (rates: Record<string, number>, p = "install.") => Object.fromEntries(Object.entries(rates).map(([k, v]) => [p + k, v]));

function item1(profile: CalcProfileId = "STANDARD", extraGlobal: Record<string, number> = {}) {
  return {
    quantities: { weightTon: W, weightKg: W * 1000 },
    divisorQty: W,
    profile,
    components: installLines(lineRates),
    layers: {
      global: {
        ...prefixed(lineRates),
        [RATE_KEYS.installHeightFactorPct]: 0.05, [RATE_KEYS.installIndirectPct]: 0.04, [RATE_KEYS.markupInstallation]: 1.255,
        [RATE_KEYS.thirdPartyPct]: 0.01, [RATE_KEYS.mobDemobPct]: 0.1, [RATE_KEYS.insuranceDivisor]: 0.9505, [RATE_KEYS.taxPct]: 0.038,
        ...extraGlobal,
      },
    } as RateLayers,
  };
}

describe("acceptance numbers — erection item (250 t)", () => {
  const r = priceItem(item1());
  const v = r.values;
  it("computes without errors; engineering / commissioning are visibly 'not applied' warnings, not silent zeros", () => {
    expect(r.ok).toBe(true);
    const warned = r.issues.filter((i) => i.code === "OPTIONAL_RATE_MISSING").map((i) => i.nodeId).sort();
    expect(warned).toEqual([N.COMMISSIONING, N.ENGINEERING].sort());
    expect(r.trace[N.ENGINEERING].status).toBe("DISABLED");
  });
  it("matches every verified figure within 0.01", () => {
    expect(v[N.INSTALL_LINES_SUM]).toBeCloseTo(5_112_500, 2);
    expect(v[N.HEIGHT_FACTOR]).toBeCloseTo(255_625, 2);
    expect(v[N.INSTALL_DIRECT]).toBeCloseTo(5_368_125, 2);
    expect(v[N.INSTALL_INDIRECT]).toBeCloseTo(214_725, 2);
    expect(v[N.INSTALL_SALE]).toBeCloseTo(7_006_476.75, 2);
    expect(v[N.THIRD_PARTY]).toBeCloseTo(70_064.7675, 2);
    expect(v[N.MOB_DEMOB]).toBeCloseTo(707_654.15175, 2);
    expect(v[N.TOTAL_BEFORE_INSURANCE]).toBeCloseTo(7_784_195.66925, 2);
    expect(v[N.INSURANCE_TOTAL]).toBeCloseTo(405_384.2, 1);
    expect(v[N.TAX]).toBeCloseTo(311_204.035, 2);
    expect(v[N.SALE_PRICE]).toBeCloseTo(8_500_783.908, 2);
    expect(v[N.UNIT_RATE]).toBeCloseTo(34_003.1356, 2);
    expect(roundMoney(v[N.UNIT_RATE])).toBe(34_003.14);
    expect(v[N.TOTAL_COST]).toBeCloseTo(7_077_157.158, 2);
    expect(v[N.PROFIT]).toBeCloseTo(1_423_626.75, 2);
    expect(v[N.PROFIT_PCT]).toBeCloseTo(0.201158, 5);
    expect(v[N.RATE_PER_TON]).toBeCloseTo(34_003.1356, 2);
  });
  it("keeps direct, indirect and sale separate and consistent", () => {
    expect(v[N.DIRECT_COST]).toBeCloseTo(5_368_125, 2);
    expect(v[N.INDIRECT_COST]).toBeCloseTo(214_725, 2);
    expect(v[N.SALE_PRICE]).toBeGreaterThan(v[N.TOTAL_COST]);
    expect(v[N.TOTAL_COST] + v[N.PROFIT]).toBeCloseTo(v[N.SALE_PRICE], 6);
    expect(r.summary!.totalCost).toBe(v[N.TOTAL_COST]);
  });
});

// ---------------------------------------------------------------- legacy profiles vs workbook (literal)
describe("legacy profiles reproduce the workbook literally (named, opt-in)", () => {
  it("LEGACY_MOB_DOUBLE_COUNT — steel grating item (340 m², 10.2 t)", () => {
    const tonRates = { handling: 800, packing: 0, crane: 5200, scaffolding: 5200, manHour: 7500, tools: 300, ppe: 350, touchUp: 300 };
    const r = priceItem({
      quantities: { areaSqm: 340, weightKg: 10_200, weightTon: 10.2 }, divisorQty: 340, profile: "LEGACY_MOB_DOUBLE_COUNT",
      components: installLines(tonRates),
      layers: { global: { ...prefixed(tonRates), [RATE_KEYS.installHeightFactorPct]: 0.05, [RATE_KEYS.installIndirectPct]: 0.04, [RATE_KEYS.markupInstallation]: 1.2,
        [RATE_KEYS.engineeringPct]: 0, [RATE_KEYS.thirdPartyPct]: 0.01, [RATE_KEYS.mobDemobPct]: 0.1, [RATE_KEYS.commissioningPct]: 0.01,
        [RATE_KEYS.insuranceDivisor]: 0.9505, [RATE_KEYS.taxPct]: 0.038 } },
    });
    expect(r.ok).toBe(true);
    const v = r.values;
    expect(v[N.HEIGHT_FACTOR]).toBeCloseTo(10_021.5, 2); // computed but NOT in Direct, as in the workbook
    expect(v[N.INSTALL_DIRECT]).toBeCloseTo(200_430, 2);
    expect(v[N.MOB_DEMOB]).toBeCloseTo(25_013.664, 2);
    expect(v[N.SUBTOTAL]).toBeCloseTo(277_651.6704, 2);
    expect(v[N.COMMISSIONING]).toBeCloseTo(2_776.516704, 2);
    expect(v[N.TOTAL_BEFORE_INSURANCE]).toBeCloseTo(302_665.3344, 2); // Mob/Demob counted twice
    expect(v[N.SALE_PRICE]).toBeCloseTo(330_527.74025, 2);
    expect(v[N.UNIT_RATE]).toBeCloseTo(972.1404, 3); // per m²
    expect(v[N.RATE_PER_TON]).toBeCloseTo(32_404.6804, 3);
    expect(v[N.TOTAL_COST]).toBeCloseTo(266_601.15295, 2);
    expect(v[N.PROFIT]).toBeCloseTo(63_926.5873, 2);
    expect(v[N.PROFIT_PCT]).toBeCloseTo(0.239784, 5);
  });
  it("LEGACY_EQUIPMENT — moving floor (14 t): two divisors, no tax, commissioning in price not in cost", () => {
    const tonRates = { handling: 800, packing: 150, crane: 5200, scaffolding: 5200, manHour: 12500, tools: 300, ppe: 350, touchUp: 300 };
    const r = priceItem({
      quantities: { weightTon: 14, weightKg: 14_000 }, divisorQty: 14, profile: "LEGACY_EQUIPMENT",
      components: installLines(tonRates),
      layers: { global: { ...prefixed(tonRates), [RATE_KEYS.installIndirectPct]: 0.04, [RATE_KEYS.markupInstallation]: 1.2,
        [RATE_KEYS.engineeringPct]: 0, [RATE_KEYS.thirdPartyPct]: 0.01, [RATE_KEYS.mobDemobPct]: 0.1, [RATE_KEYS.commissioningPct]: 0.01,
        [RATE_KEYS.extraDivisor]: 0.97, [RATE_KEYS.insuranceDivisor]: 0.9505 } },
    });
    expect(r.ok).toBe(true);
    const v = r.values;
    expect(v[N.INSTALL_DIRECT]).toBeCloseTo(347_200, 2);
    expect(v[N.INSURANCE_BASE]).toBeCloseTo(500_802.99810, 2);
    expect(v[N.TAX]).toBe(0);
    expect(r.trace[N.TAX].status).toBe("DISABLED");
    expect(v[N.SALE_PRICE]).toBeCloseTo(526_883.7434, 2);
    expect(v[N.UNIT_RATE]).toBeCloseTo(37_634.5531, 3);
    expect(v[N.TOTAL_COST]).toBeCloseTo(449_856.45124, 2);
    expect(v[N.PROFIT_PCT]).toBeCloseTo(0.171226, 5);
  });
  it("the three profiles give different, documented results on the same item (no silent default)", () => {
    const base = item1("STANDARD", { [RATE_KEYS.commissioningPct]: 0.01, [RATE_KEYS.extraDivisor]: 0.97 });
    const prices = (["STANDARD", "LEGACY_MOB_DOUBLE_COUNT", "LEGACY_EQUIPMENT"] as const).map((p) => priceItem({ ...base, profile: p }).values[N.SALE_PRICE]);
    expect(new Set(prices.map((x) => Math.round(x))).size).toBe(3);
    for (const p of Object.values(CALC_PROFILES)) expect(p.description.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------- full item: supply + fabrication + subcontractor + add-ons
function fullItem(profile: CalcProfileId = "STANDARD", order: "asc" | "desc" = "asc") {
  const c = (id: string, category: Category, method: Method, o: Partial<Component> = {}) => comp(id, method, { category, ...o });
  const components = [
    c("mat.plate", "MATERIAL", "PER_KG", { rateKey: "mat.plate" }),
    c("fab.cutting", "FABRICATION", "PER_TON", { rateKey: "fab.cutting" }),
    c("fab.welding", "FABRICATION", "PER_TON", { rateKey: "fab.welding" }),
    c("sub.insulation", "SUBCONTRACTOR", "FIXED_LUMP_SUM", { rateKey: "sub.insulation" }),
    c("add.transport", "ADD_ON", "FIXED_PLUS_VARIABLE", { rateKey: "add.transport", fixed: 25_000, unit: "TON" }),
    ...installLines({ crane: 5200, manHour: 7500 }),
  ];
  if (order === "desc") components.reverse();
  return {
    quantities: { weightTon: 100, weightKg: 100_000 }, divisorQty: 100, profile, components,
    layers: { global: {
      "mat.plate": 46, "fab.cutting": 6000, "fab.welding": 16000, "sub.insulation": 300_000, "add.transport": 400,
      "install.crane": 5200, "install.manHour": 7500,
      [RATE_KEYS.fabricationIndirectPct]: 0.0025, [RATE_KEYS.subcontractorIndirectPct]: 0.01,
      [RATE_KEYS.installHeightFactorPct]: 0.05, [RATE_KEYS.installIndirectPct]: 0.04,
      [RATE_KEYS.markupMaterial]: 1.1, [RATE_KEYS.markupFabrication]: 1.29, [RATE_KEYS.markupSubcontractor]: 1.2, [RATE_KEYS.markupInstallation]: 1.255, [RATE_KEYS.markupAddOn]: 1.1,
      [RATE_KEYS.engineeringPct]: 0.02, [RATE_KEYS.thirdPartyPct]: 0.01, [RATE_KEYS.commissioningLump]: 10_000, [RATE_KEYS.commissioningPct]: 0.01,
      [RATE_KEYS.mobDemobPct]: 0.1, [RATE_KEYS.extraDivisor]: 0.97, [RATE_KEYS.insuranceDivisor]: 0.9505, [RATE_KEYS.taxPct]: 0.038,
    } } as RateLayers,
  };
}

describe("supply, fabrication, subcontractor and add-ons", () => {
  it("applies each category's own indirect and markup (hand-calculated)", () => {
    const r = priceItem(fullItem());
    expect(r.ok).toBe(true);
    const v = r.values;
    expect(v[N.MATERIAL_COST]).toBe(4_600_000);
    expect(v[N.FAB_DIRECT]).toBe(2_200_000);
    expect(v[N.FAB_INDIRECT]).toBeCloseTo(5_500, 6);
    expect(v[N.SUB_INDIRECT]).toBeCloseTo(3_000, 6);
    expect(v[N.ADDON_DIRECT]).toBe(25_000 + 400 * 100); // fixed + variable
    expect(v[N.MATERIAL_SALE]).toBeCloseTo(4_600_000 * 1.1, 4);
    expect(v[N.FAB_SALE]).toBeCloseTo(2_205_500 * 1.29, 4);
    expect(v[N.SUB_SALE]).toBeCloseTo(303_000 * 1.2, 4);
    expect(v[N.ADDON_SALE]).toBeCloseTo(65_000 * 1.1, 4);
    expect(v[N.SUPPLY_AND_INSTALL]).toBeCloseTo(v[N.SUPPLY_SALE] + v[N.INSTALL_SALE], 6);
    expect(v[N.DIRECT_COST] + v[N.INDIRECT_COST]).toBeLessThan(v[N.TOTAL_COST]); // statutory + sale-side costs on top
    expect(r.summary!.profit).toBeGreaterThan(0);
  });
  it("a category with lines but no markup is an error (never a silent 1.0)", () => {
    const f = fullItem();
    delete (f.layers.global as Record<string, number>)[RATE_KEYS.markupFabrication];
    const r = priceItem(f);
    expect(r.ok).toBe(false);
    expect(r.issues.find((i) => i.code === "MISSING_RATE")!.nodeId).toBe(N.FAB_SALE);
    expect(r.summary).toBeNull();
  });
  it("a category with no lines needs none of its rates", () => {
    const r = priceItem(item1()); // no material / fabrication / subcontractor
    expect(r.ok).toBe(true);
    expect(r.values[N.MATERIAL_SALE]).toBe(0);
  });
  it("external supply cost/sale is added as-is", () => {
    const r = priceItem({ ...item1(), externalSupply: { cost: 1_000_000, sale: 1_300_000 } });
    expect(r.values[N.SUPPLY_AND_INSTALL]).toBeCloseTo(7_006_476.75 + 1_300_000, 2);
    expect(r.values[N.DIRECT_COST]).toBeCloseTo(5_368_125 + 1_000_000, 2);
  });
  it("override beats profile, project and global for one item", () => {
    const f = fullItem();
    const base = priceItem(f).values[N.SALE_PRICE];
    const o = priceItem({ ...f, layers: { ...f.layers, override: { [RATE_KEYS.markupFabrication]: 1.5 } } });
    expect(o.values[N.SALE_PRICE]).toBeGreaterThan(base);
    expect(o.trace[N.FAB_SALE].rate?.layer).toBe("OVERRIDE");
  });
});

// ---------------------------------------------------------------- invariants
describe("invariants", () => {
  const profiles: CalcProfileId[] = ["STANDARD", "LEGACY_MOB_DOUBLE_COUNT", "LEGACY_EQUIPMENT"];
  it("profit = sale − cost, cost + profit = sale, Profit % is derived (profit ÷ cost)", () => {
    for (const p of profiles) {
      const r = priceItem(fullItem(p));
      expect(r.ok).toBe(true);
      const s = r.summary!;
      expect(s.totalCost + s.profit).toBeCloseTo(s.salePrice, 6);
      expect(s.profitPct).toBeCloseTo(s.profit / s.totalCost, 12);
    }
  });
  it("raising any rate raises the price (divisors: lowering them does)", () => {
    for (const p of profiles) {
      const f = fullItem(p);
      const base = priceItem(f).values[N.SALE_PRICE];
      for (const [key, value] of Object.entries(f.layers.global!)) {
        const isDivisor = key === RATE_KEYS.insuranceDivisor || key === RATE_KEYS.extraDivisor;
        const moved = priceItem({ ...f, layers: { global: { ...f.layers.global, [key]: isDivisor ? value * 0.99 : value * 1.1 } } });
        expect(moved.ok).toBe(true);
        const after = moved.values[N.SALE_PRICE];
        // some keys are inert for a given profile (e.g. tax in the equipment profile, the lump when commissioning is a %)
        expect(after, `${p}:${key}`).toBeGreaterThanOrEqual(base - 1e-9);
      }
    }
    // and for the standard profile specifically, every key that is used strictly raises the price
    const f = fullItem("STANDARD");
    const base = priceItem(f).values[N.SALE_PRICE];
    const inert = new Set([RATE_KEYS.commissioningPct, RATE_KEYS.extraDivisor]);
    for (const [key, value] of Object.entries(f.layers.global!)) {
      if (inert.has(key as never)) continue;
      const isDivisor = key === RATE_KEYS.insuranceDivisor;
      const after = priceItem({ ...f, layers: { global: { ...f.layers.global, [key]: isDivisor ? value * 0.99 : value * 1.1 } } }).values[N.SALE_PRICE];
      expect(after, key).toBeGreaterThan(base);
    }
  });
  it("is deterministic and independent of component order", () => {
    const a = priceItem(fullItem());
    const b = priceItem(fullItem());
    expect(b.values).toEqual(a.values);
    const rev = priceItem(fullItem("STANDARD", "desc"));
    for (const k of [N.TOTAL_COST, N.SALE_PRICE, N.PROFIT]) expect(rev.values[k]).toBeCloseTo(a.values[k], 6);
  });
  it("zero weight: per-ton amounts are 0, warnings raised, no NaN/Infinity, unit rate 0", () => {
    const r = priceItem({ ...item1(), quantities: { weightTon: 0, weightKg: 0 }, divisorQty: 0 });
    expect(r.ok).toBe(true);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["ZERO_BASIS", "ZERO_QUANTITY", "ZERO_WEIGHT", "ZERO_COST"]));
    for (const x of Object.values(r.values)) expect(Number.isFinite(x)).toBe(true);
    expect(r.values[N.UNIT_RATE]).toBe(0);
    expect(r.values[N.RATE_PER_TON]).toBe(0);
  });
  it("an item with no weight basis cannot use per-ton lines (error, not 0)", () => {
    const r = priceItem({ ...item1(), quantities: { units: 3 } });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === "MISSING_BASIS")).toBe(true);
  });
  it("buildPricingGraph produces an acyclic, ledger-clean graph for every profile", () => {
    for (const p of profiles) {
      const { specs } = buildPricingGraph(fullItem(p));
      expect(topoSort(specs).cycle).toBeNull();
      expect(evaluateGraph(specs, { quantities: fullItem(p).quantities, layers: fullItem(p).layers }).issues.filter((i) => i.severity === "error")).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- rounding
describe("rounding policy (presentation / persistence only)", () => {
  it("documents 2 / 4 / 4 decimals", () => expect(ROUNDING).toEqual({ money: 2, rate: 4, factor: 4 }));
  it("rounds half away from zero", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(34_003.1356)).toBe(34_003.14);
    expect(roundRate(0.123456)).toBe(0.1235);
    expect(roundFactor(1.25549)).toBe(1.2555);
    expect(roundHalfAway(2.5, 0)).toBe(3);
  });
  it("the engine itself never rounds", () => {
    const r = priceItem(item1());
    expect(r.values[N.UNIT_RATE]).not.toBe(roundMoney(r.values[N.UNIT_RATE]));
  });
});
