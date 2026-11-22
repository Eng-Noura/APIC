import { describe, expect, it } from "vitest";
import { calcEstimate, type CalcIssue, type EstimateInputs } from "./calc";
import { buildSnapshot, transition } from "./workflow";
import {
  applyTarget, approvedSnapshotFor, buildItemRows, chooseMaterialSource, countIssues, defaultComparePair, draftToInputs, editMaterialPrice, followSources, formatValue,
  indexIssues, issuesFor, liveEstimate, liveIssues, materialEditState, normalizeChanges, quotationPreview, scrapOf, sheetActions, snapshotOverview, sourceOptions, stageTracker, type Draft,
} from "./sheet-view";
import type { EstMaterial, EstSettings, EstVersionRow } from "./types";

const settings: EstSettings = {
  scrapUsedLaterPct: 0, scrapUsedLaterPrice: 0, scrapSellPrice: 0, creditRecoveredScrap: false,
  profitMode: "MARKUP_ON_COST", profitValue: 10, insuranceMode: "FIXED", insuranceValue: 0, taxPct: 14,
  paymentTerms: null, offerValidityDays: 30, deliveryDays: null, exclusions: null, commercialNotes: null,
};
const mat = (over: Partial<EstMaterial> = {}): EstMaterial => ({
  id: "m1", source: "PART_LIST", name: "Plate 10mm", grade: "S355", thicknessMm: 10, requiredKg: 80, purchasedKg: 100, unitPrice: 20,
  sourceRequiredKg: 80, sourcePurchasedKg: 100, suggestedUnitPrice: 20, sourceMissing: false,
  itemId: "i1", priceSource: "PROCUREMENT", priceOptions: { procurement: 20, stock: null, scrap: 25 }, ...over,
});
const draft = (over: Partial<Draft> = {}): Draft => ({
  settings, materials: [mat()],
  items: [{ id: "i1", name: "Riser", linked: false, weightKg: 0, pieces: 0, manualWeightKg: 100, manualPieces: 2, operations: [{ id: "o1", name: "Welding", costType: "FIXED", unit: "", rate: 500, quantity: null, percentBase: null, selected: true, source: "MANUAL" }] }],
  subcontracts: [], projectCosts: [], ...over,
});

describe("draftToInputs / liveEstimate", () => {
  it("passes the v2 commercial inputs the server uses (discount, other charges, target) and the allocation basis", () => {
    const i = draftToInputs(draft({ settings: { ...settings, discountMode: "PERCENT", discountValue: 5, discountTiming: "BEFORE_TAX", otherChargesValue: 100, otherChargesTaxable: true, targetSalePrice: 5000, allocationBasis: "DIRECT_COST" } }));
    expect(i.commercial).toMatchObject({ discountMode: "PERCENT", discountValue: 5, discountTiming: "BEFORE_TAX", otherChargesValue: 100, otherChargesTaxable: true, targetSaleCents: 500000 });
    expect(i.allocationBasis).toBe("DIRECT_COST");
  });

  it("a discount in the settings changes the live final price (the old page ignored it, so its preview disagreed with the server)", () => {
    const base = liveEstimate(draft()).commercial.finalCents;
    const disc = liveEstimate(draft({ settings: { ...settings, discountMode: "PERCENT", discountValue: 10, discountTiming: "BEFORE_TAX" } })).commercial;
    expect(disc.discountCents).toBeGreaterThan(0);
    expect(disc.finalCents).toBeLessThan(base);
  });

  it("a manual item uses its manual weight, a linked item the weight the server sent", () => {
    const d = draft();
    d.items.push({ ...d.items[0], id: "i2", linked: true, weightKg: 300, pieces: 5, manualWeightKg: 1, manualPieces: 1, operations: [] });
    const i = draftToInputs(d);
    expect(i.items.find((x) => x.id === "i1")).toMatchObject({ weightKg: 100, pieces: 2 });
    expect(i.items.find((x) => x.id === "i2")).toMatchObject({ weightKg: 300, pieces: 5 });
  });
});

describe("price source of a material line", () => {
  it("typing a price on an automatic line makes it Manual (otherwise the server snaps it back to the source price)", () => {
    const m = editMaterialPrice(mat(), 33);
    expect(m).toMatchObject({ unitPrice: 33, priceSource: "MANUAL" });
  });
  it("typing a price on a hand-typed line keeps it Manual and changes only the price", () => {
    expect(editMaterialPrice(mat({ source: "MANUAL", priceSource: "MANUAL", priceOptions: null }), 7)).toMatchObject({ unitPrice: 7, priceSource: "MANUAL" });
  });
  it("choosing Scrap takes the scrap price from the line's options", () => {
    const r = chooseMaterialSource(mat(), "SCRAP");
    expect(r.ok && r.material).toMatchObject({ priceSource: "SCRAP", unitPrice: 25 });
  });
  it("a source without a price is refused and the line is not changed", () => {
    const m = mat({ priceOptions: { procurement: 20, stock: null, scrap: null } });
    const r = chooseMaterialSource(m, "SCRAP");
    expect(r.ok).toBe(false);
    const s = chooseMaterialSource(m, "STOCK");
    expect(s.ok).toBe(false);
  });
  it("a hand-typed line has no source choices", () => {
    expect(chooseMaterialSource(mat({ source: "MANUAL" }), "PROCUREMENT").ok).toBe(false);
    expect(sourceOptions(mat({ source: "MANUAL" }))).toEqual([]);
  });
  it("Stock is listed but always disabled; Scrap is disabled when it offers no price", () => {
    const o = sourceOptions(mat({ priceOptions: { procurement: 20, stock: null, scrap: null } }));
    expect(o.find((x) => x.value === "STOCK")?.disabled).toBe(true);
    expect(o.find((x) => x.value === "SCRAP")?.disabled).toBe(true);
    expect(o.find((x) => x.value === "PROCUREMENT")?.disabled).toBe(false);
    expect(o.find((x) => x.value === "MANUAL")?.disabled).toBe(false);
  });
  it("a line on Scrap follows the scrap cost when purchased kg changes; a Manual line keeps the typed number", () => {
    const scrap = scrapOf(settings);
    const scrapLine = mat({ priceSource: "SCRAP", unitPrice: 25, purchasedKg: 160 });
    const [a] = followSources([scrapLine], scrap);
    expect(a.unitPrice).not.toBe(25); // 160 kg bought for 80 kg used: the effective cost per kg moved
    const manual = mat({ priceSource: "MANUAL", unitPrice: 33, purchasedKg: 160 });
    expect(followSources([manual], scrap)[0].unitPrice).toBe(33);
  });
});

describe("edited-vs-original and restore", () => {
  const scrap = scrapOf(settings);
  it("an untouched automatic line is not edited and cannot be restored", () => {
    expect(materialEditState(mat(), scrap)).toMatchObject({ auto: true, qtyEdited: false, priceEdited: false, canRestore: false });
  });
  it("a changed purchased quantity is flagged and the original kg is the imported one", () => {
    const s = materialEditState(mat({ purchasedKg: 120 }), scrap);
    expect(s.qtyEdited).toBe(true); expect(s.canRestore).toBe(true);
    expect(s.original?.purchasedKg).toBe(100);
  });
  it("a typed price (Manual) is flagged and the original is the default source's price", () => {
    const s = materialEditState(mat({ priceSource: "MANUAL", unitPrice: 33 }), scrap);
    expect(s.priceEdited).toBe(true); expect(s.canRestore).toBe(true);
    expect(s.original).toMatchObject({ priceSource: "PROCUREMENT", unitPrice: 20 });
  });
  it("choosing another source counts as edited even when the number happens to be equal", () => {
    expect(materialEditState(mat({ priceSource: "SCRAP", unitPrice: 20 }), scrap).priceEdited).toBe(true);
  });
  it("a hand-typed line has nothing to restore", () => {
    expect(materialEditState(mat({ source: "MANUAL", sourcePurchasedKg: null }), scrap)).toMatchObject({ auto: false, canRestore: false, original: null });
  });
  it("with no procurement price the original is Manual 0 (what the server restores)", () => {
    const s = materialEditState(mat({ priceOptions: { procurement: null, stock: null, scrap: null }, priceSource: "MANUAL", unitPrice: 5 }), scrap);
    expect(s.original).toMatchObject({ priceSource: "MANUAL", unitPrice: 0 });
    expect(s.priceEdited).toBe(true);
  });
});

describe("issues next to fields", () => {
  const issues: CalcIssue[] = [
    { level: "warning", scope: "material", id: "m1", message: "w" }, { level: "error", scope: "material", id: "m1", message: "e" },
    { level: "error", scope: "operation", id: "o1", message: "op" }, { level: "warning", scope: "commercial", message: "c" },
  ];
  it("finds the messages of one line, errors first, and nothing for a line without issues", () => {
    const ix = indexIssues(issues);
    expect(issuesFor(ix, "material", "m1").map((i) => i.message)).toEqual(["e", "w"]);
    expect(issuesFor(ix, "material", "m2")).toEqual([]);
    expect(issuesFor(ix, "commercial")).toHaveLength(1);
    expect(issuesFor(ix, "operation", "m1")).toEqual([]); // same id, other scope
  });
  it("an unsaved draft gets the calculation's issues plus a warning for a line whose source row disappeared", () => {
    const d = draft({ materials: [mat({ sourceMissing: true })] });
    const li = liveIssues(liveEstimate(d), d.materials);
    expect(li.find((i) => i.scope === "material" && i.id === "m1" && /disappeared/.test(i.message))?.level).toBe("warning");
    expect(liveIssues(liveEstimate(draft()), draft().materials).some((i) => /disappeared/.test(i.message))).toBe(false);
  });
  it("counts errors and warnings", () => expect(countIssues(issues)).toEqual({ errors: 2, warnings: 2 }));
});

describe("sheetActions: what the page shows and enables", () => {
  const base = { dirty: false, errors: 0, canEdit: true, canApprove: true };
  it("an approved sheet is locked: fields read-only, save/calculate/templates disabled, reopen enabled for the approver", () => {
    const a = sheetActions({ ...base, status: "APPROVED" });
    expect(a.locked).toBe(true); expect(a.fieldsEditable).toBe(false);
    expect(a.calculate.enabled).toBe(false); expect(a.calculate.reason).toMatch(/locked/);
    expect(a.templates.enabled).toBe(false); expect(a.save.enabled).toBe(false);
    expect(a.approve.enabled).toBe(false);
    expect(a.reopen).toMatchObject({ visible: true, enabled: true });
  });
  it("DRAFT: calculate is enabled, approve is disabled with 'Calculate first', reopen is disabled", () => {
    const a = sheetActions({ ...base, status: "DRAFT" });
    expect(a.calculate.enabled).toBe(true);
    expect(a.approve.enabled).toBe(false); expect(a.approve.reason).toMatch(/Calculate/);
    expect(a.reopen.enabled).toBe(false);
    expect(a.fieldsEditable).toBe(true);
  });
  it("CALCULATED and saved: approve is enabled", () => {
    expect(sheetActions({ ...base, status: "CALCULATED" }).approve.enabled).toBe(true);
  });
  it("CALCULATED but with unsaved edits: approve is disabled (the sheet changed after it was calculated)", () => {
    const a = sheetActions({ ...base, status: "CALCULATED", dirty: true });
    expect(a.approve.enabled).toBe(false); expect(a.approve.reason).toMatch(/changed/);
    expect(a.save.enabled).toBe(true);
  });
  it("errors block calculate and approve, warnings do not", () => {
    const a = sheetActions({ ...base, status: "CALCULATED", errors: 2 });
    expect(a.calculate.enabled).toBe(false); expect(a.approve.enabled).toBe(false);
    expect(a.calculate.reason).toMatch(/errors/);
  });
  it("an editor without pricing.approve does not see Approve or Reopen", () => {
    const a = sheetActions({ ...base, status: "APPROVED", canApprove: false });
    expect(a.approve.visible).toBe(false); expect(a.reopen.visible).toBe(false);
    expect(a.reopen.enabled).toBe(false);
  });
  it("a viewer sees no edit buttons and cannot edit fields", () => {
    const a = sheetActions({ ...base, status: "DRAFT", canEdit: false, canApprove: false });
    expect(a.fieldsEditable).toBe(false);
    for (const k of ["save", "calculate", "approve", "reopen", "templates", "manageTemplates"] as const) expect(a[k].visible).toBe(false);
  });
  it("agrees with transition() for every status × action (the page cannot enable what the server refuses)", () => {
    for (const status of ["DRAFT", "CALCULATED", "APPROVED"] as const) {
      for (const dirty of [false, true]) for (const errors of [0, 1]) {
        const a = sheetActions({ status, dirty, errors, canEdit: true, canApprove: true });
        expect(a.calculate.enabled).toBe(transition(status, "CALCULATE", { hasErrors: errors > 0 }).ok);
        expect(a.approve.enabled).toBe(transition(status, "APPROVE", { canApprove: true, calculatedInputsCurrent: !dirty, hasErrors: errors > 0 }).ok);
        expect(a.reopen.enabled).toBe(transition(status, "REOPEN", { canApprove: true }).ok);
      }
    }
  });
});

describe("stageTracker", () => {
  it("first not-done stage is current, the rest are todo", () => {
    expect(stageTracker("DRAFT", { material: true, manufacturing: false, project: false }).map((s) => s.state)).toEqual(["done", "current", "todo", "todo"]);
    expect(stageTracker("DRAFT", { material: false, manufacturing: false, project: false }).map((s) => s.state)).toEqual(["current", "todo", "todo", "todo"]);
  });
  it("Commercial is current once the other three are done, and done only when approved", () => {
    expect(stageTracker("CALCULATED", { material: true, manufacturing: true, project: true }).map((s) => s.state)).toEqual(["done", "done", "done", "current"]);
    expect(stageTracker("APPROVED", { material: false, manufacturing: false, project: false }).every((s) => s.state === "done")).toBe(true);
  });
  it("has the four named stages in order", () => {
    expect(stageTracker("DRAFT", { material: false, manufacturing: false, project: false }).map((s) => s.label)).toEqual(["Material", "Manufacturing", "Project Costs", "Commercial"]);
  });
});

describe("buildItemRows", () => {
  const inputs: EstimateInputs = draftToInputs(draft({ projectCosts: [{ id: "c1", name: "Eng", method: "FIXED", unit: "", quantity: null, rate: 1000, percentBase: null, enabled: true, source: "MANUAL" }], materials: [mat(), mat({ id: "m2", itemId: null, name: "Shared plate" })] }));
  const r = calcEstimate(inputs);
  const d = draft({ projectCosts: [{ id: "c1", name: "Eng", method: "FIXED", unit: "", quantity: null, rate: 1000, percentBase: null, enabled: true, source: "MANUAL" }], materials: [mat(), mat({ id: "m2", itemId: null, name: "Shared plate" })] });
  const doc = { ...d, itemTotals: r.items, totals: { ...r.totals, ...r.commercial }, };
  it("one row per item with the server's figures, plus a shared row that holds the rest, so the rows add up to the sheet totals", () => {
    const rows = buildItemRows(doc);
    expect(rows.map((x) => x.name)).toEqual(["Riser", "Shared / project level"]);
    const sum = (f: (x: (typeof rows)[number]) => number) => rows.reduce((a, x) => a + f(x), 0);
    expect(sum((x) => x.materialCents)).toBe(doc.totals.materialCents);
    expect(sum((x) => x.manufacturingCents)).toBe(doc.totals.manufacturingCents);
    expect(sum((x) => x.projectCents)).toBe(doc.totals.projectCents);
    expect(sum((x) => x.finalCents)).toBe(doc.totals.finalCents);
  });
  it("each line goes to its item or to the shared row; a line pointing at a deleted item is shared, never dropped", () => {
    const rows = buildItemRows({ ...doc, materials: [mat(), mat({ id: "m3", itemId: "gone" })] });
    expect(rows[0].materials.map((m) => m.id)).toEqual(["m1"]);
    expect(rows[1].materials.map((m) => m.id)).toEqual(["m3"]);
  });
  it("a shared subcontractor service lands in the shared row with its cost, and the rows still add up to the totals", () => {
    const sub = { id: "s1", name: "Blasting", company: null, unit: "lot", quantity: 1, unitPrice: 700, notes: null, itemId: null, selected: true, costType: "PER_UNIT", percentBase: null } as never;
    const d3 = draft({ subcontracts: [sub] }); const r3 = calcEstimate(draftToInputs(d3));
    const rows = buildItemRows({ ...d3, itemTotals: r3.items, totals: { ...r3.totals, ...r3.commercial } });
    const shared = rows.find((x) => x.shared)!;
    expect(shared.subcontracts.map((x) => x.id)).toEqual(["s1"]);
    expect(shared.subcontractCents).toBe(70000);
    expect(rows.reduce((a2, x) => a2 + x.subcontractCents, 0)).toBe(r3.totals.subcontractorCents);
  });
  it("no shared row when nothing is shared", () => {
    const d2 = draft(); const r2 = calcEstimate(draftToInputs(d2));
    expect(buildItemRows({ ...d2, itemTotals: r2.items, totals: { ...r2.totals, ...r2.commercial } }).map((x) => x.shared)).toEqual([false]);
  });
});

describe("versions", () => {
  const v = (id: string, version: number, kind: "CALCULATED" | "APPROVED", createdAt: string): EstVersionRow => ({ id, version, kind, costTotal: 1, finalPrice: 1, note: null, createdAt, createdById: "u", verified: true });
  const rows = [v("a", 1, "CALCULATED", "2026-11-01T10:00:00Z"), v("b", 1, "APPROVED", "2026-11-02T10:00:00Z"), v("c", 2, "CALCULATED", "2026-11-03T10:00:00Z"), v("d", 1, "APPROVED", "2026-11-04T10:00:00Z")];
  it("finds the approved snapshot of THIS version only (newest if several); a calculated one never counts", () => {
    expect(approvedSnapshotFor(rows, 1)?.id).toBe("d");
    expect(approvedSnapshotFor(rows, 2)).toBeNull();
  });
  it("default compare = the two newest", () => {
    expect(defaultComparePair(rows)).toEqual({ from: "c", to: "d" });
    expect(defaultComparePair(rows.slice(0, 1))).toBeNull();
  });
});

describe("snapshotOverview", () => {
  const inputs = draftToInputs(draft());
  const snap = buildSnapshot(inputs);
  it("counts the selected operations and names the items it still knows", () => {
    const o = snapshotOverview({ version: 1, kind: "APPROVED", verified: true, inputs: snap.inputs, result: snap.result }, (id) => (id === "i1" ? "Riser" : null));
    expect(o.counts).toMatchObject({ materials: 1, items: 1, operations: 1, subcontracts: 0, projectCosts: 0 });
    expect(o.items[0].name).toBe("Riser");
    expect(o.materials[0]).toMatchObject({ name: "Plate 10mm", priceSource: "PROCUREMENT" });
    expect(o.totals.estimatedCostCents).toBe(snap.result.totals.estimatedCostCents);
  });
  it("an item that is no longer on the sheet is labelled, not hidden", () => {
    const o = snapshotOverview({ version: 1, kind: "APPROVED", verified: false, inputs: snap.inputs, result: snap.result }, () => null);
    expect(o.items[0].name).toMatch(/no longer on the sheet/);
    expect(o.verified).toBe(false);
  });
});

describe("audit values", () => {
  it("keeps only well-formed change entries", () => {
    expect(normalizeChanges([{ entity: "material", label: "Plate", field: "unitPrice", from: 1, to: 2 }, { bad: true }, null, "x"])).toHaveLength(1);
    expect(normalizeChanges(null)).toEqual([]);
    expect(normalizeChanges({})).toEqual([]);
  });
  it("formats values for reading", () => {
    expect(formatValue(null)).toBe("—"); expect(formatValue("")).toBe("—"); expect(formatValue(true)).toBe("Yes"); expect(formatValue(1234.5)).toBe("1,234.5"); expect(formatValue("PROCUREMENT")).toBe("PROCUREMENT");
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("quotationPreview", () => {
  it("the amount lines add up to the final price (discount before or after tax, other charges taxable or not)", () => {
    for (const timing of ["BEFORE_TAX", "AFTER_TAX"] as const) for (const taxable of [true, false]) {
      const s: EstSettings = { ...settings, insuranceMode: "FIXED", insuranceValue: 300, discountMode: "PERCENT", discountValue: 5, discountTiming: timing, otherChargesValue: 150, otherChargesTaxable: taxable, otherChargesLabel: "Freight" };
      const c = liveEstimate(draft({ settings: s })).commercial;
      const p = quotationPreview(c, s);
      const total = p.lines.filter((l) => l.kind === "amount").reduce((a, l) => a + l.amountCents, 0);
      expect(total).toBe(c.finalCents);
      expect(p.lines.at(-1)).toMatchObject({ kind: "total", amountCents: c.finalCents });
    }
  });
  it("a line appears only when the sheet has it; the discount is shown negative; no term is invented", () => {
    const c = liveEstimate(draft({ settings: { ...settings, taxPct: 0 } })).commercial;
    const p = quotationPreview(c, { ...settings, taxPct: 0 });
    expect(p.lines.map((l) => l.label)).toEqual(["Supply & fabrication", "Total price"]);
    expect(p.terms.map((t) => t.label)).toEqual(["Offer validity"]);
    const s2 = { ...settings, discountMode: "FIXED" as const, discountValue: 100, advancePct: 20, warrantyMonths: 12, milestones: "30/40/30" };
    const p2 = quotationPreview(liveEstimate(draft({ settings: s2 })).commercial, s2);
    expect(p2.lines.find((l) => l.label === "Discount")!.amountCents).toBe(-10000);
    expect(p2.terms.map((t) => t.label)).toEqual(expect.arrayContaining(["Advance payment", "Milestones", "Warranty"]));
  });
});

describe("applyTarget", () => {
  it("an operation needs an item; a project cost or a subcontract can go to the whole project", () => {
    expect(applyTarget("OPERATION", null).ok).toBe(false);
    expect(applyTarget("OPERATION", "i1")).toEqual({ ok: true, itemId: "i1" });
    expect(applyTarget("PROJECT_COST", null)).toEqual({ ok: true, itemId: null });
    expect(applyTarget("SUBCONTRACT", null)).toEqual({ ok: true, itemId: null });
    expect(applyTarget("SUBCONTRACT", "i1")).toEqual({ ok: true, itemId: "i1" });
  });
});
