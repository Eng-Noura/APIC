import { describe, expect, it } from "vitest";
import { calcEstimate, calcMaterials, type EstimateInputs, type ScrapSettings } from "./calc";
import {
  DEFAULT_PRICE_SOURCE, SHEET_STATUSES, allocateKg, allocateMaterialRow, buildPriceOptions, buildSnapshot, choosePriceSource, compareSnapshots,
  diffFields, initialPrice, optionFor, partMatchesRow, priceAfterSync, resolveSavedLine, sameJson, splitRequiredAmongRows, transition, verifySnapshot, type SheetAction, type SheetStatus,
} from "./workflow";

const scrap: ScrapSettings = { usedLaterPct: 0, usedLaterPricePerKg: 0, scrapSellPricePerKg: 15, creditRecoveredScrap: false };

const inputs = (over: Partial<EstimateInputs> = {}): EstimateInputs => ({
  materials: [{ id: "m1", source: "NESTING", name: "S235 10mm", itemId: "i1", requiredKg: 800, purchasedKg: 1000, unitPrice: 60, priceSource: "PROCUREMENT" }],
  scrap,
  items: [{ id: "i1", weightKg: 800, pieces: 8, operations: [{ id: "o1", selected: true, costType: "PER_KG", rate: 10, quantity: null, percentBase: null }] }],
  subcontracts: [], projectCosts: [],
  commercial: { profitMode: "MARKUP_ON_COST", profitValue: 10, insuranceMode: "FIXED", insuranceValue: 0, taxPct: 14 },
  ...over,
});

describe("status workflow — allowed transitions", () => {
  it("editing a draft or calculated sheet returns it to DRAFT without a version bump", () => {
    expect(transition("DRAFT", "EDIT")).toEqual({ ok: true, next: "DRAFT", versionIncrement: 0 });
    expect(transition("CALCULATED", "EDIT")).toEqual({ ok: true, next: "DRAFT", versionIncrement: 0 });
  });
  it("calculates from DRAFT and re-calculates from CALCULATED", () => {
    expect(transition("DRAFT", "CALCULATE")).toMatchObject({ ok: true, next: "CALCULATED" });
    expect(transition("CALCULATED", "CALCULATE")).toMatchObject({ ok: true, next: "CALCULATED" });
  });
  it("approves a CALCULATED, unchanged, error-free sheet when the user may approve", () => {
    expect(transition("CALCULATED", "APPROVE", { canApprove: true, calculatedInputsCurrent: true })).toEqual({ ok: true, next: "APPROVED", versionIncrement: 0 });
  });
  it("reopening an APPROVED sheet gives a DRAFT and bumps the version", () => {
    expect(transition("APPROVED", "REOPEN", { canApprove: true })).toEqual({ ok: true, next: "DRAFT", versionIncrement: 1 });
  });
});

describe("status workflow — forbidden transitions", () => {
  it("an approved sheet cannot be edited or recalculated", () => {
    expect(transition("APPROVED", "EDIT")).toMatchObject({ ok: false, status: 409 });
    expect(transition("APPROVED", "CALCULATE")).toMatchObject({ ok: false, status: 409 });
  });
  it("cannot approve a DRAFT, an already approved sheet, or a sheet changed since it was calculated", () => {
    expect(transition("DRAFT", "APPROVE", { canApprove: true, calculatedInputsCurrent: true })).toMatchObject({ ok: false, status: 409 });
    expect(transition("APPROVED", "APPROVE", { canApprove: true, calculatedInputsCurrent: true })).toMatchObject({ ok: false, status: 409 });
    expect(transition("CALCULATED", "APPROVE", { canApprove: true, calculatedInputsCurrent: false })).toMatchObject({ ok: false, status: 409 });
  });
  it("approving and reopening need the permission", () => {
    expect(transition("CALCULATED", "APPROVE", { canApprove: false, calculatedInputsCurrent: true })).toMatchObject({ ok: false, status: 403 });
    expect(transition("APPROVED", "REOPEN", { canApprove: false })).toMatchObject({ ok: false, status: 403 });
  });
  it("error-level issues block calculating and approving", () => {
    expect(transition("DRAFT", "CALCULATE", { hasErrors: true })).toMatchObject({ ok: false, status: 422 });
    expect(transition("CALCULATED", "APPROVE", { canApprove: true, calculatedInputsCurrent: true, hasErrors: true })).toMatchObject({ ok: false, status: 422 });
  });
  it("only an APPROVED sheet can be reopened", () => {
    expect(transition("DRAFT", "REOPEN", { canApprove: true })).toMatchObject({ ok: false, status: 409 });
    expect(transition("CALCULATED", "REOPEN", { canApprove: true })).toMatchObject({ ok: false, status: 409 });
  });
  it("covers every status × action combination without throwing", () => {
    for (const s of SHEET_STATUSES) for (const a of ["EDIT", "CALCULATE", "APPROVE", "REOPEN"] as SheetAction[]) {
      expect(() => transition(s as SheetStatus, a, { canApprove: true, calculatedInputsCurrent: true })).not.toThrow();
    }
  });
});

describe("allocateKg", () => {
  it("splits pro rata and adds up to exactly the total", () => {
    const { shares, unallocatedKg } = allocateKg(1000, [1, 1, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1000, 9);
    expect(unallocatedKg).toBe(0);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(0.001 + 1e-9);
  });
  it("follows the weights", () => {
    const { shares } = allocateKg(1000, [3, 1]);
    expect(shares).toEqual([750, 250]);
  });
  it("never invents an allocation when weights carry no information", () => {
    expect(allocateKg(500, [0, 0])).toEqual({ shares: [0, 0], unallocatedKg: 500 });
    expect(allocateKg(0, [1, 2]).shares).toEqual([0, 0]);
    expect(allocateKg(-5, [1]).shares).toEqual([0]);
  });
  it("ignores zero, negative and non-finite weights", () => {
    const { shares } = allocateKg(100, [1, 0, -4, NaN]);
    expect(shares).toEqual([100, 0, 0, 0]);
  });
});

describe("allocateMaterialRow", () => {
  it("allocates purchased AND required kg by the net weight of each item's parts, summing to the row totals", () => {
    const out = allocateMaterialRow({ purchasedKg: 1000, requiredKg: 800 }, [
      { scopeId: "A", netKg: 300 }, { scopeId: "A", netKg: 100 }, { scopeId: "B", netKg: 400 },
    ]);
    expect(out.map((o) => o.scopeId)).toEqual(["A", "B"]);
    expect(out[0]).toMatchObject({ netKg: 400, purchasedKg: 500, requiredKg: 400 });
    expect(out[1]).toMatchObject({ netKg: 400, purchasedKg: 500, requiredKg: 400 });
    expect(out.reduce((a, o) => a + o.purchasedKg, 0)).toBeCloseTo(1000, 9);
  });
  it("gives parts without a scope item their own shared slice (last)", () => {
    const out = allocateMaterialRow({ purchasedKg: 90, requiredKg: 90 }, [{ scopeId: null, netKg: 30 }, { scopeId: "A", netKg: 60 }]);
    expect(out.map((o) => o.scopeId)).toEqual(["A", null]);
    expect(out[0].purchasedKg).toBe(60);
    expect(out[1].purchasedKg).toBe(30);
  });
  it("with no matching parts the whole row stays one shared slice", () => {
    expect(allocateMaterialRow({ purchasedKg: 77, requiredKg: 70 }, [])).toEqual([{ scopeId: null, netKg: 0, purchasedKg: 77, requiredKg: 70 }]);
  });
  it("does not lose kg to rounding with awkward numbers", () => {
    const out = allocateMaterialRow({ purchasedKg: 1234.567, requiredKg: 1000.001 }, [{ scopeId: "A", netKg: 1 }, { scopeId: "B", netKg: 1 }, { scopeId: "C", netKg: 1 }]);
    expect(out.reduce((a, o) => a + o.purchasedKg, 0)).toBeCloseTo(1234.567, 9);
    expect(out.reduce((a, o) => a + o.requiredKg, 0)).toBeCloseTo(1000.001, 9);
  });
});

describe("price options and source choice", () => {
  const opts = buildPriceOptions({ procurementPrice: 60, requiredKg: 800, purchasedKg: 1000, scrap });
  it("offers the procurement price as is", () => expect(opts.procurement).toBe(60));
  it("offers NO stock price (StockItem has no valuation) unless real data is passed", () => {
    expect(opts.stock).toBeNull();
    expect(buildPriceOptions({ procurementPrice: 60, stockPrice: 55, requiredKg: 800, purchasedKg: 1000, scrap }).stock).toBe(55);
  });
  it("derives the effective scrap cost per kg: (purchased × price − recovered scrap) ÷ kg the parts use", () => {
    // gross 1000 × 60 = 60000; scrap 200 kg × 15 = 3000 recovered → 57000 / 800 = 71.25
    expect(opts.scrap).toBeCloseTo(71.25, 4);
  });
  it("scrap option is withheld without a base price, without required kg, or when purchased < required", () => {
    expect(buildPriceOptions({ procurementPrice: null, requiredKg: 800, purchasedKg: 1000, scrap }).scrap).toBeNull();
    expect(buildPriceOptions({ procurementPrice: 60, requiredKg: null, purchasedKg: 1000, scrap }).scrap).toBeNull();
    expect(buildPriceOptions({ procurementPrice: 60, requiredKg: 1200, purchasedKg: 1000, scrap }).scrap).toBeNull();
  });
  it("treats zero / negative prices as missing, never as a price", () => {
    expect(buildPriceOptions({ procurementPrice: 0, requiredKg: 800, purchasedKg: 1000, scrap })).toEqual({ procurement: null, stock: null, scrap: null });
  });
  it("SCRAP-priced line costs the same as procurement-priced purchased kg minus recovered scrap — scrap is not counted twice", () => {
    const asProc = calcMaterials([{ id: "a", source: "NESTING", name: "x", requiredKg: 800, purchasedKg: 1000, unitPrice: 60, priceSource: "PROCUREMENT" }], { ...scrap, creditRecoveredScrap: true });
    const asScrap = calcMaterials([{ id: "a", source: "NESTING", name: "x", requiredKg: 800, purchasedKg: 1000, unitPrice: opts.scrap!, priceSource: "SCRAP" }], { ...scrap, creditRecoveredScrap: true });
    expect(asScrap.materialCostCents).toBe(asProc.materialCostCents);
    // and with credit OFF, the SCRAP line must still not be credited again
    const off = calcMaterials([{ id: "a", source: "NESTING", name: "x", requiredKg: 800, purchasedKg: 1000, unitPrice: opts.scrap!, priceSource: "SCRAP" }], scrap);
    expect(off.materialCostCents).toBe(asProc.materialCostCents);
  });
  it("choosing a source with a price switches source and price; the other options stay untouched", () => {
    const r = choosePriceSource({ priceSource: "MANUAL", unitPrice: 50 }, opts, "SCRAP");
    expect(r).toEqual({ ok: true, line: { priceSource: "SCRAP", unitPrice: opts.scrap } });
    expect(optionFor(opts, "PROCUREMENT")).toBe(60);
  });
  it("refuses a source with no price and leaves the line as it was", () => {
    const r = choosePriceSource({ priceSource: "MANUAL", unitPrice: 50 }, opts, "STOCK");
    expect(r.ok).toBe(false);
  });
  it("MANUAL keeps the typed value; a negative manual price is refused", () => {
    expect(choosePriceSource({ priceSource: "PROCUREMENT", unitPrice: 60 }, opts, "MANUAL", 63)).toEqual({ ok: true, line: { priceSource: "MANUAL", unitPrice: 63 } });
    expect(choosePriceSource({ priceSource: "PROCUREMENT", unitPrice: 60 }, opts, "MANUAL", -1).ok).toBe(false);
  });
  it("re-sync: a MANUAL line keeps the user's price; a sourced line follows its source", () => {
    const moved = { ...opts, procurement: 65 };
    expect(priceAfterSync({ priceSource: "MANUAL", unitPrice: 50 }, moved)).toEqual({ line: { priceSource: "MANUAL", unitPrice: 50 }, sourceLost: false });
    expect(priceAfterSync({ priceSource: "PROCUREMENT", unitPrice: 60 }, moved)).toEqual({ line: { priceSource: "PROCUREMENT", unitPrice: 65 }, sourceLost: false });
  });
  it("re-sync: when the chosen source stops offering a price, the price is kept and flagged", () => {
    const r = priceAfterSync({ priceSource: "PROCUREMENT", unitPrice: 60 }, { procurement: null, stock: null, scrap: null });
    expect(r).toEqual({ line: { priceSource: "PROCUREMENT", unitPrice: 60 }, sourceLost: true });
  });
  it("new line starts from the default source when it has a price, otherwise MANUAL 0 (calc will warn, nothing invented)", () => {
    expect(DEFAULT_PRICE_SOURCE).toBe("PROCUREMENT");
    expect(initialPrice(opts)).toEqual({ priceSource: "PROCUREMENT", unitPrice: 60 });
    expect(initialPrice({ procurement: null, stock: null, scrap: null })).toEqual({ priceSource: "MANUAL", unitPrice: 0 });
  });
});

describe("snapshots", () => {
  it("records inputs and result and verifies by recomputation", () => {
    const s = buildSnapshot(inputs());
    expect(s.costTotalCents).toBe(s.result.totals.estimatedCostCents);
    expect(s.finalPriceCents).toBe(s.result.commercial.finalCents);
    expect(s.finalPriceCents).toBeGreaterThan(0);
    expect(verifySnapshot({ inputs: s.inputs, result: s.result })).toBe(true);
  });
  it("still verifies after a JSON round-trip, as a JSONB column would return it", () => {
    const s = buildSnapshot(inputs());
    expect(verifySnapshot(JSON.parse(JSON.stringify({ inputs: s.inputs, result: s.result })))).toBe(true);
  });
  it("detects a tampered result and tampered inputs", () => {
    const s = buildSnapshot(inputs());
    const badResult = JSON.parse(JSON.stringify(s.result)); badResult.commercial.finalCents += 1;
    expect(verifySnapshot({ inputs: s.inputs, result: badResult })).toBe(false);
    const badInputs = JSON.parse(JSON.stringify(s.inputs)); badInputs.materials[0].unitPrice = 61;
    expect(verifySnapshot({ inputs: badInputs, result: s.result })).toBe(false);
  });
  it("is not affected by later changes to the object it was built from", () => {
    const i = inputs();
    const s = buildSnapshot(i);
    const before = JSON.stringify(s);
    i.materials[0].unitPrice = 999;
    expect(JSON.stringify(s)).toBe(before);
  });
  it("garbage input verifies as false instead of throwing", () => {
    expect(verifySnapshot({ inputs: null, result: {} })).toBe(false);
  });
  it("sameJson ignores key order and undefined, and detects real differences", () => {
    expect(sameJson({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1, c: undefined })).toBe(true);
    expect(sameJson({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
});

describe("compareSnapshots", () => {
  it("reports the change per category, and a v2 snapshot stays unchanged when a v3 is built", () => {
    const v2 = buildSnapshot(inputs());
    const frozen = JSON.stringify(v2);
    const v3 = buildSnapshot(inputs({ materials: [{ id: "m1", source: "NESTING", name: "S235 10mm", itemId: "i1", requiredKg: 800, purchasedKg: 1000, unitPrice: 70, priceSource: "MANUAL" }] }));
    const d = compareSnapshots(v2, v3);
    const mat = d.find((x) => x.key === "material")!;
    expect(mat.deltaCents).toBe(1000 * 10 * 100);
    expect(d.find((x) => x.key === "manufacturing")!.deltaCents).toBe(0);
    expect(d.find((x) => x.key === "final")!.deltaCents).toBeGreaterThan(0);
    expect(JSON.stringify(v2)).toBe(frozen);
    expect(calcEstimate(v3.inputs).commercial.finalCents).toBe(v3.finalPriceCents);
  });
});

describe("diffFields (field-level audit)", () => {
  it("lists only changed fields, with from / to", () => {
    const d = diffFields("material", "S235 10mm", { purchasedKg: 1000, unitPrice: 60, notes: "" }, { purchasedKg: 1000, unitPrice: 65, notes: "x" }, ["purchasedKg", "unitPrice", "notes"]);
    expect(d).toEqual([
      { entity: "material", label: "S235 10mm", field: "unitPrice", from: 60, to: 65 },
      { entity: "material", label: "S235 10mm", field: "notes", from: null, to: "x" },
    ]);
  });
  it("treats null, undefined and empty string as the same empty value", () => {
    expect(diffFields("e", "l", { a: null, b: "" }, { a: undefined, b: null }, ["a", "b"])).toEqual([]);
  });
  it("ignores float noise but catches a real change", () => {
    expect(diffFields("e", "l", { a: 0.1 + 0.2 }, { a: 0.3 }, ["a"])).toEqual([]);
    expect(diffFields("e", "l", { a: 1 }, { a: 1.01 }, ["a"])).toHaveLength(1);
  });
});

describe("partMatchesRow", () => {
  const plate = { type: "Plate", grade: "S235", thicknessMm: 10, spec: "PL 10 × 2000 × 6000 mm" };
  const part = (o: Partial<{ partType: string; material: string | null; thicknessMm: number | null; description: string }> = {}) => ({ partType: "PLATE", material: null, thicknessMm: 10, description: "PL 10 mm", ...o });
  it("plates: same thickness; blank grade on either side matches; different grade does not", () => {
    expect(partMatchesRow(plate, part())).toBe(true);
    expect(partMatchesRow(plate, part({ material: "S235" }))).toBe(true);
    expect(partMatchesRow(plate, part({ material: "S355" }))).toBe(false);
    expect(partMatchesRow({ ...plate, grade: "—" }, part({ material: "S355" }))).toBe(true);
  });
  it("plates: different thickness or missing thickness does not match; cones count as plate", () => {
    expect(partMatchesRow(plate, part({ thicknessMm: 12 }))).toBe(false);
    expect(partMatchesRow(plate, part({ thicknessMm: null }))).toBe(false);
    expect(partMatchesRow(plate, part({ partType: "CONE" }))).toBe(true);
    expect(partMatchesRow(plate, part({ partType: "PIPE" }))).toBe(false);
  });
  it("profiles and pipes match on the description prefix of the row spec", () => {
    expect(partMatchesRow({ type: "Profile", grade: "S275", thicknessMm: null, spec: "IPE 300" }, { partType: "HOT_ROLLED", material: null, thicknessMm: null, description: "IPE 300" })).toBe(true);
    expect(partMatchesRow({ type: "Profile", grade: "S275", thicknessMm: null, spec: "IPE 300" }, { partType: "HOT_ROLLED", material: null, thicknessMm: null, description: "IPE 200" })).toBe(false);
    expect(partMatchesRow({ type: "Pipe", grade: "—", thicknessMm: 5, spec: "Ø 88.9 · 5 mm wall" }, { partType: "PIPE", material: null, thicknessMm: 5, description: "Ø 88.9" })).toBe(true);
  });
  it("accessories and blank descriptions never match", () => {
    expect(partMatchesRow(plate, part({ partType: "ACCESSORY" }))).toBe(false);
    expect(partMatchesRow({ type: "Profile", grade: "", thicknessMm: null, spec: "IPE 300" }, { partType: "HOT_ROLLED", material: null, thicknessMm: null, description: " " })).toBe(false);
  });
});

describe("splitRequiredAmongRows", () => {
  it("shares one thickness/grade total between sheet-size rows instead of repeating it", () => {
    const r = splitRequiredAmongRows(900, [{ key: "a", purchasedKg: 600 }, { key: "b", purchasedKg: 300 }]);
    expect(r).toEqual({ a: 600, b: 300 });
    expect(r.a + r.b).toBe(900);
  });
  it("a single row keeps the whole total", () => expect(splitRequiredAmongRows(412.5, [{ key: "a", purchasedKg: 500 }])).toEqual({ a: 412.5 }));
});

describe("resolveSavedLine (price after the page saves)", () => {
  const auto = { source: "NESTING", priceSource: "PROCUREMENT" as const, unitPrice: 60, requiredKg: 800, procurementPrice: 60 };
  it("a hand-typed line keeps what was sent, as MANUAL", () => {
    expect(resolveSavedLine({ ...auto, source: "MANUAL", priceSource: "MANUAL" }, { purchasedKg: 10, unitPrice: 77 }, scrap)).toMatchObject({ ok: true, unitPrice: 77, priceSource: "MANUAL", purchasedKg: 10 });
  });
  it("older page, price unchanged → keeps following Procurement", () => {
    expect(resolveSavedLine(auto, { purchasedKg: 1000, unitPrice: 60 }, scrap)).toMatchObject({ ok: true, unitPrice: 60, priceSource: "PROCUREMENT" });
  });
  it("older page, price typed over → MANUAL with the typed price", () => {
    expect(resolveSavedLine(auto, { purchasedKg: 1000, unitPrice: 63 }, scrap)).toMatchObject({ ok: true, unitPrice: 63, priceSource: "MANUAL" });
  });
  it("names a source → that source's price wins over the browser's number", () => {
    const r = resolveSavedLine(auto, { purchasedKg: 1000, unitPrice: 1, priceSource: "SCRAP" }, scrap);
    expect(r).toMatchObject({ ok: true, priceSource: "SCRAP" });
    if (r.ok) expect(r.unitPrice).toBeCloseTo(71.25, 4);
  });
  it("names a source that offers nothing → refused (Stock has no valuation data)", () => {
    const r = resolveSavedLine(auto, { purchasedKg: 1000, unitPrice: 60, priceSource: "STOCK" }, scrap);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toMatch(/Stock has no valuation/);
  });
  it("a SCRAP-priced line with an unchanged price moves when purchased kg changes (never stale)", () => {
    const scrapLine = { ...auto, priceSource: "SCRAP" as const, unitPrice: 71.25 };
    const r = resolveSavedLine(scrapLine, { purchasedKg: 1100, unitPrice: 71.25 }, scrap);
    // gross 1100 × 60 = 66000; scrap 300 kg × 15 = 4500 → 61500 / 800 = 76.875
    expect(r).toMatchObject({ ok: true, priceSource: "SCRAP" });
    if (r.ok) expect(r.unitPrice).toBeCloseTo(76.875, 4);
  });
  it("a MANUAL automatic line is never pulled back to a source by saving", () => {
    expect(resolveSavedLine({ ...auto, priceSource: "MANUAL", unitPrice: 50 }, { purchasedKg: 1000, unitPrice: 50 }, scrap)).toMatchObject({ ok: true, unitPrice: 50, priceSource: "MANUAL" });
  });
  it("explicit MANUAL with the same number stays MANUAL", () => {
    expect(resolveSavedLine(auto, { purchasedKg: 1000, unitPrice: 60, priceSource: "MANUAL" }, scrap)).toMatchObject({ ok: true, priceSource: "MANUAL", unitPrice: 60 });
  });
});
