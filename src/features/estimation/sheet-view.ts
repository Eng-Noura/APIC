/**
 * Pricing sheet — what the page shows and what it lets the user do. Pure TypeScript (no React, no fetch), same style as
 * calc.ts / workflow.ts, so every rule here is unit-tested.
 *
 * Nothing here is a company rule: the status transitions come from `transition()` in workflow.ts (the same function the
 * server uses), and permissions only decide what the PAGE shows. The server enforces them again on every route.
 */
import { calcEstimate, toCents, type CalcIssue, type EstimateInputs, type EstimateResult, type PriceSource, type ScrapSettings } from "./calc";
import { buildPriceOptions, choosePriceSource, initialPrice, priceAfterSync, transition, type FieldChange, type PriceOptions, type SheetStatus } from "./workflow";
import type { EstimateDoc, EstItem, EstMaterial, EstSettings, EstSnapshotFull, EstVersionRow } from "./types";
import type { TemplateKind } from "./templates";

export type Draft = Pick<EstimateDoc, "materials" | "items" | "subcontracts" | "projectCosts" | "settings">;

// --------------------------------------------------------------------------- 1 · Draft → calculation inputs

export const scrapOf = (s: EstSettings): ScrapSettings => ({
  usedLaterPct: s.scrapUsedLaterPct, usedLaterPricePerKg: s.scrapUsedLaterPrice, scrapSellPricePerKg: s.scrapSellPrice, creditRecoveredScrap: s.creditRecoveredScrap,
});

/**
 * A line that follows its price source (Procurement / Scrap) gets that source's price again when its purchased kg or the
 * scrap settings change — the same rule the server applies on save (priceAfterSync). Typed (MANUAL) lines keep their number.
 */
export function followSources(materials: EstMaterial[], scrap: ScrapSettings): EstMaterial[] {
  return materials.map((m) => {
    if (m.source === "MANUAL" || !m.priceSource || m.priceSource === "MANUAL" || !m.priceOptions) return m;
    const options = buildPriceOptions({ procurementPrice: m.priceOptions.procurement, stockPrice: null, requiredKg: m.requiredKg, purchasedKg: m.purchasedKg, scrap });
    const { line } = priceAfterSync({ priceSource: m.priceSource, unitPrice: m.unitPrice }, options);
    return { ...m, unitPrice: line.unitPrice, priceOptions: options };
  });
}

/** Every input the server's recalculation uses (v2 included: discount, other charges, target, allocation basis). */
export function draftToInputs(d: Draft): EstimateInputs {
  const s = d.settings;
  return {
    materials: followSources(d.materials, scrapOf(s)).map((m) => ({ id: m.id, source: m.source, name: m.name, itemId: m.itemId ?? null, requiredKg: m.requiredKg, purchasedKg: m.purchasedKg, unitPrice: m.unitPrice, priceSource: m.priceSource ?? "MANUAL" })),
    scrap: scrapOf(s),
    items: d.items.map((i) => {
      const w = i.linked ? { weightKg: i.weightKg, pieces: i.pieces } : { weightKg: i.manualWeightKg ?? 0, pieces: i.manualPieces ?? 0 };
      return { id: i.id, ...w, operations: i.operations.map((o) => ({ id: o.id, selected: o.selected, costType: o.costType, rate: o.rate, quantity: o.quantity, percentBase: o.percentBase })) };
    }),
    subcontracts: d.subcontracts.map((x) => ({ id: x.id, quantity: x.quantity, unitPrice: x.unitPrice, itemId: x.itemId ?? null, selected: x.selected, costType: x.costType, percentBase: x.percentBase ?? null })),
    projectCosts: d.projectCosts.map((c) => ({ id: c.id, enabled: c.enabled, method: c.method, rate: c.rate, quantity: c.quantity, percentBase: c.percentBase, itemId: c.itemId ?? null })),
    commercial: {
      profitMode: s.profitMode, profitValue: s.profitValue, insuranceMode: s.insuranceMode, insuranceValue: s.insuranceValue, taxPct: s.taxPct,
      discountMode: s.discountMode, discountValue: s.discountValue, discountTiming: s.discountTiming,
      otherChargesValue: s.otherChargesValue, otherChargesTaxable: s.otherChargesTaxable,
      targetSaleCents: s.targetSalePrice != null ? toCents(s.targetSalePrice) : null,
    },
    allocationBasis: s.allocationBasis,
  };
}

/** Live figures for the page while the user edits (never sent to the server: it recalculates from the inputs). */
export const liveEstimate = (d: Draft): EstimateResult => calcEstimate(draftToInputs(d));

// --------------------------------------------------------------------------- 2 · Material lines: source, edited-vs-original, restore

/** The user types a price. On an automatic line that means "Manual" (the server ignores a typed number on a Procurement/Scrap line). */
export const editMaterialPrice = (m: EstMaterial, price: number): EstMaterial =>
  m.source === "MANUAL" ? { ...m, unitPrice: price } : { ...m, unitPrice: price, priceSource: "MANUAL" };

export type SourceChoice = { ok: true; material: EstMaterial } | { ok: false; reason: string };

/** The user picks a price source for an automatic line. A source without a price is refused; the current price is never replaced silently. */
export function chooseMaterialSource(m: EstMaterial, wanted: PriceSource): SourceChoice {
  if (m.source === "MANUAL") return { ok: false, reason: "A line typed in by hand has no other price source." };
  const options: PriceOptions = m.priceOptions ?? { procurement: null, stock: null, scrap: null };
  const c = choosePriceSource({ priceSource: m.priceSource ?? "MANUAL", unitPrice: m.unitPrice }, options, wanted);
  if (!c.ok) return { ok: false, reason: c.reason };
  return { ok: true, material: { ...m, priceSource: c.line.priceSource, unitPrice: c.line.unitPrice } };
}

export interface MaterialEditState {
  auto: boolean;
  qtyEdited: boolean; priceEdited: boolean;
  /** what "Restore" puts back (the same values the server's restore uses) */
  original: { purchasedKg: number; unitPrice: number; priceSource: PriceSource } | null;
  canRestore: boolean;
}

export function materialEditState(m: EstMaterial, scrap: ScrapSettings): MaterialEditState {
  const auto = m.source !== "MANUAL";
  if (!auto || m.sourcePurchasedKg == null) return { auto, qtyEdited: false, priceEdited: false, original: null, canRestore: false };
  const options = buildPriceOptions({ procurementPrice: m.priceOptions?.procurement ?? null, stockPrice: null, requiredKg: m.requiredKg, purchasedKg: m.sourcePurchasedKg, scrap });
  const price = initialPrice(options);
  const original = { purchasedKg: m.sourcePurchasedKg, unitPrice: price.unitPrice, priceSource: price.priceSource };
  const qtyEdited = Math.abs(m.purchasedKg - original.purchasedKg) > 1e-6;
  const priceEdited = (m.priceSource ?? "MANUAL") !== original.priceSource || Math.abs(m.unitPrice - original.unitPrice) > 1e-9;
  return { auto, qtyEdited, priceEdited, original, canRestore: qtyEdited || priceEdited };
}

export const PRICE_SOURCE_LABEL: Record<PriceSource, string> = { PROCUREMENT: "Procurement", SCRAP: "Scrap", MANUAL: "Manual", STOCK: "Stock" };

export interface SourceOption { value: PriceSource; label: string; price: number | null; disabled: boolean; why?: string }
/** The choices of one line's price-source selector. Stock is listed but disabled (the stock module holds no unit cost). */
export function sourceOptions(m: EstMaterial): SourceOption[] {
  if (m.source === "MANUAL") return [];
  const o = m.priceOptions ?? { procurement: null, stock: null, scrap: null };
  return [
    { value: "PROCUREMENT", label: PRICE_SOURCE_LABEL.PROCUREMENT, price: o.procurement, disabled: o.procurement == null, why: o.procurement == null ? "No procurement price for this line" : undefined },
    { value: "SCRAP", label: PRICE_SOURCE_LABEL.SCRAP, price: o.scrap, disabled: o.scrap == null, why: o.scrap == null ? "No scrap cost available (needs a procurement price and purchased ≥ required kg)" : undefined },
    { value: "STOCK", label: PRICE_SOURCE_LABEL.STOCK, price: o.stock, disabled: true, why: "Stock has no unit cost yet" },
    { value: "MANUAL", label: PRICE_SOURCE_LABEL.MANUAL, price: null, disabled: false },
  ];
}

// --------------------------------------------------------------------------- 3 · Issues next to the fields

export type IssueScope = CalcIssue["scope"];
export type IssueIndex = Map<string, CalcIssue[]>;
const key = (scope: IssueScope, id?: string | null) => `${scope}:${id ?? ""}`;

export function indexIssues(issues: CalcIssue[]): IssueIndex {
  const ix: IssueIndex = new Map();
  for (const i of issues) { const k = key(i.scope, i.id); ix.set(k, [...(ix.get(k) ?? []), i]); }
  return ix;
}
/** Messages of one line, errors first. */
export const issuesFor = (ix: IssueIndex, scope: IssueScope, id?: string | null): CalcIssue[] =>
  [...(ix.get(key(scope, id)) ?? [])].sort((a, b) => Number(b.level === "error") - Number(a.level === "error"));

/** The issues of an unsaved draft: the calculation's own, plus the warning the server adds for a line whose source row disappeared. */
export function liveIssues(r: EstimateResult, materials: EstMaterial[]): CalcIssue[] {
  return [...r.issues, ...materials.filter((m) => m.sourceMissing).map((m): CalcIssue => ({ level: "warning", scope: "material", id: m.id, message: "The source row of this line disappeared. It is still counted in the cost: check it or remove it." }))];
}

export function countIssues(issues: CalcIssue[]) {
  const errors = issues.filter((i) => i.level === "error").length;
  return { errors, warnings: issues.length - errors };
}

export type StageKey = "material" | "manufacturing" | "project" | "commercial";
export const ISSUE_TAB: Record<IssueScope, "materials" | "manufacturing" | "project" | "commercial"> = {
  material: "materials", operation: "manufacturing", subcontract: "manufacturing", projectCost: "project", commercial: "commercial",
};

// --------------------------------------------------------------------------- 4 · Buttons: shown / enabled / why not

export interface ActionState { visible: boolean; enabled: boolean; reason?: string }
export interface SheetActions { locked: boolean; fieldsEditable: boolean; save: ActionState; calculate: ActionState; approve: ActionState; reopen: ActionState; templates: ActionState; manageTemplates: ActionState }

export interface ActionInput {
  status: SheetStatus; dirty: boolean; errors: number;
  canEdit: boolean;      // pricing.edit
  canApprove: boolean;   // pricing.approve
}

/**
 * Which buttons the page shows and enables. Statuses are judged by transition() — the function the server runs — so the page
 * and the server cannot disagree about the workflow. Permissions only hide or disable here; the routes check them again.
 */
export function sheetActions(a: ActionInput): SheetActions {
  const locked = a.status === "APPROVED";
  const fieldsEditable = a.canEdit && !locked;
  const calc = transition(a.status, "CALCULATE", { hasErrors: a.errors > 0 });
  // A sheet with unsaved edits is not "calculated": the page saves first, so the server will see the edits.
  const approve = transition(a.status, "APPROVE", { canApprove: a.canApprove, calculatedInputsCurrent: !a.dirty, hasErrors: a.errors > 0 });
  const reopen = transition(a.status, "REOPEN", { canApprove: a.canApprove });
  const edit = transition(a.status, "EDIT");
  return {
    locked, fieldsEditable,
    save: { visible: a.canEdit, enabled: fieldsEditable && a.dirty, reason: !a.canEdit ? undefined : locked ? (edit.ok ? undefined : edit.reason) : a.dirty ? undefined : "Nothing to save" },
    calculate: { visible: a.canEdit, enabled: a.canEdit && calc.ok, reason: calc.ok ? undefined : calc.reason },
    approve: { visible: a.canApprove, enabled: approve.ok, reason: approve.ok ? undefined : approve.reason },
    reopen: { visible: a.canApprove, enabled: reopen.ok, reason: reopen.ok ? undefined : reopen.reason },
    templates: { visible: a.canEdit, enabled: fieldsEditable, reason: locked ? "This sheet is approved and locked. Reopen it to apply a template." : undefined },
    manageTemplates: { visible: a.canEdit, enabled: true },
  };
}

// --------------------------------------------------------------------------- 5 · Four-stage tracker

export interface TrackerStage { key: StageKey; label: string; state: "done" | "current" | "todo" }
const STAGE_LABEL: Record<StageKey, string> = { material: "Material", manufacturing: "Manufacturing", project: "Project Costs", commercial: "Commercial" };

/**
 * Material / Manufacturing / Project Costs come from the stage flags the user sets with "Mark complete"; Commercial is done
 * only when the sheet is APPROVED. An approved sheet shows all four done. The first stage not done is "current".
 */
export function stageTracker(status: SheetStatus, done: { material: boolean; manufacturing: boolean; project: boolean }): TrackerStage[] {
  const approved = status === "APPROVED";
  const flags: Record<StageKey, boolean> = { material: approved || done.material, manufacturing: approved || done.manufacturing, project: approved || done.project, commercial: approved };
  let currentSet = false;
  return (["material", "manufacturing", "project", "commercial"] as StageKey[]).map((k) => {
    if (flags[k]) return { key: k, label: STAGE_LABEL[k], state: "done" as const };
    if (!currentSet) { currentSet = true; return { key: k, label: STAGE_LABEL[k], state: "current" as const }; }
    return { key: k, label: STAGE_LABEL[k], state: "todo" as const };
  });
}

// --------------------------------------------------------------------------- 6 · Items table

export interface ItemRow {
  id: string | null; name: string; linked: boolean; shared: boolean;
  weightKg: number; pieces: number;
  materialCents: number; manufacturingCents: number; subcontractCents: number; projectCents: number; costCents: number; finalCents: number; finalPerKg: number | null;
  materials: EstMaterial[]; operations: EstItem["operations"]; subcontracts: EstimateDoc["subcontracts"]; projectCosts: EstimateDoc["projectCosts"];
}

/**
 * One row per item (figures from the server's `itemTotals`), plus a "Shared / project level" row for what belongs to no item.
 * The shared figures are what is left of the sheet totals after the items — nothing is recalculated here.
 */
export function buildItemRows(doc: Pick<EstimateDoc, "items" | "materials" | "subcontracts" | "projectCosts" | "itemTotals" | "totals">): ItemRow[] {
  const ids = new Set(doc.items.map((i) => i.id));
  const own = (itemId: string | null | undefined) => (itemId && ids.has(itemId) ? itemId : null);
  const rows: ItemRow[] = doc.items.map((i) => {
    const t = doc.itemTotals.find((x) => x.id === i.id);
    return {
      id: i.id, name: i.name, linked: i.linked, shared: false,
      weightKg: t?.weightKg ?? (i.linked ? i.weightKg : i.manualWeightKg ?? 0), pieces: i.linked ? i.pieces : i.manualPieces ?? 0,
      materialCents: t?.materialCents ?? 0, manufacturingCents: t?.manufacturingCents ?? 0, subcontractCents: t?.subcontractCents ?? 0, projectCents: t?.projectCents ?? 0,
      costCents: t?.costCents ?? 0, finalCents: t?.finalCents ?? 0, finalPerKg: t?.finalPerKg ?? null,
      materials: doc.materials.filter((m) => own(m.itemId) === i.id), operations: i.operations,
      subcontracts: doc.subcontracts.filter((s) => own(s.itemId) === i.id), projectCosts: doc.projectCosts.filter((c) => own(c.itemId) === i.id),
    };
  });
  const sum = (f: (r: ItemRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const sharedMaterials = doc.materials.filter((m) => own(m.itemId) === null);
  const sharedSubs = doc.subcontracts.filter((s) => own(s.itemId) === null);
  const sharedCosts = doc.projectCosts.filter((c) => own(c.itemId) === null);
  const shared = {
    materialCents: doc.totals.materialCents - sum((r) => r.materialCents),
    manufacturingCents: doc.totals.manufacturingCents - sum((r) => r.manufacturingCents),
    subcontractCents: doc.totals.subcontractorCents - sum((r) => r.subcontractCents),
    projectCents: doc.totals.projectCents - sum((r) => r.projectCents),
  };
  const sharedCost = shared.materialCents + shared.manufacturingCents + shared.subcontractCents + shared.projectCents;
  if (sharedMaterials.length || sharedSubs.length || sharedCosts.length || sharedCost !== 0) {
    rows.push({
      id: null, name: "Shared / project level", linked: false, shared: true, weightKg: 0, pieces: 0, ...shared,
      costCents: sharedCost, finalCents: doc.totals.finalCents - sum((r) => r.finalCents), finalPerKg: null,
      materials: sharedMaterials, operations: [], subcontracts: sharedSubs, projectCosts: sharedCosts,
    });
  }
  return rows;
}

// --------------------------------------------------------------------------- 7 · Versions, approved snapshot, compare

/** The snapshot that was approved for this version of the sheet (newest if several). */
export function approvedSnapshotFor(versions: EstVersionRow[], version: number): EstVersionRow | null {
  return versions.filter((v) => v.kind === "APPROVED" && v.version === version).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

/** Newest version as "to", the one before it as "from". */
export function defaultComparePair(versions: EstVersionRow[]): { from: string; to: string } | null {
  const s = [...versions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return s.length >= 2 ? { from: s[1].id, to: s[0].id } : null;
}

export interface SnapshotOverview {
  version: number; kind: EstVersionRow["kind"]; verified: boolean;
  counts: { materials: number; items: number; operations: number; subcontracts: number; projectCosts: number };
  totals: EstimateResult["totals"]; commercial: EstimateResult["commercial"];
  items: { id: string; name: string; weightKg: number; materialCents: number; manufacturingCents: number; subcontractCents: number; projectCents: number; costCents: number; finalCents: number }[];
  materials: { id: string; name: string; purchasedKg: number; unitPrice: number; priceSource: PriceSource; totalCents: number }[];
}

/** "What exactly was calculated / approved": counts, totals, items and material lines of one stored snapshot. Item names come from the live sheet when it still has them. */
export function snapshotOverview(s: Pick<EstSnapshotFull, "version" | "kind" | "verified" | "inputs" | "result">, nameOf: (itemId: string) => string | null): SnapshotOverview {
  const { inputs, result } = s;
  const lineTotal = new Map(result.materials.lines.map((l) => [l.id, l.totalCents]));
  return {
    version: s.version, kind: s.kind, verified: s.verified,
    counts: {
      materials: inputs.materials.length, items: inputs.items.length,
      operations: inputs.items.reduce((a, i) => a + i.operations.filter((o) => o.selected).length, 0),
      subcontracts: inputs.subcontracts.filter((x) => x.selected !== false).length, projectCosts: inputs.projectCosts.filter((c) => c.enabled).length,
    },
    totals: result.totals, commercial: result.commercial,
    items: result.items.map((i) => ({ id: i.id, name: nameOf(i.id) ?? `Item ${i.id.slice(0, 6)} (no longer on the sheet)`, weightKg: i.weightKg, materialCents: i.materialCents, manufacturingCents: i.manufacturingCents, subcontractCents: i.subcontractCents, projectCents: i.projectCents, costCents: i.costCents, finalCents: i.finalCents })),
    materials: inputs.materials.map((m) => ({ id: m.id, name: m.name, purchasedKg: m.purchasedKg, unitPrice: m.unitPrice, priceSource: m.priceSource ?? "MANUAL", totalCents: lineTotal.get(m.id) ?? 0 })),
  };
}

// --------------------------------------------------------------------------- 8 · Audit

/** The `changes` column is JSON from the database: keep only well-formed { entity, label, field, from, to } entries. */
export function normalizeChanges(raw: unknown): FieldChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is FieldChange => !!c && typeof c === "object" && typeof (c as FieldChange).entity === "string" && typeof (c as FieldChange).label === "string" && typeof (c as FieldChange).field === "string");
}

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// --------------------------------------------------------------------------- 9 · Quotation preview

export interface PreviewLine { label: string; amountCents: number; kind: "amount" | "info" | "total" }
export interface QuotationPreview { lines: PreviewLine[]; terms: { label: string; value: string }[] }

/**
 * Customer-facing build-up from a result — the approved snapshot's when the sheet is approved. The "amount" lines add up to
 * the final price (cost + profit + insurance + other charges + tax − discount); the taxable base is shown as information only.
 * Nothing is invented: a line or a term appears only when the sheet has it.
 */
export function quotationPreview(c: EstimateResult["commercial"], s: EstSettings): QuotationPreview {
  const lines: PreviewLine[] = [{ label: "Supply & fabrication", amountCents: c.costCents + c.profitCents, kind: "amount" }];
  if (c.insuranceCents > 0) lines.push({ label: "Insurance", amountCents: c.insuranceCents, kind: "amount" });
  if (c.otherChargesCents > 0) lines.push({ label: s.otherChargesLabel?.trim() || "Other charges", amountCents: c.otherChargesCents, kind: "amount" });
  if (c.taxCents > 0 || s.taxPct > 0) {
    lines.push({ label: "Taxable amount", amountCents: c.taxableCents, kind: "info" });
    lines.push({ label: `Tax (${s.taxPct}%)`, amountCents: c.taxCents, kind: "amount" });
  }
  if (c.discountCents > 0) lines.push({ label: "Discount", amountCents: -c.discountCents, kind: "amount" });
  lines.push({ label: "Total price", amountCents: c.finalCents, kind: "total" });
  const terms: { label: string; value: string }[] = [];
  if (s.paymentTerms) terms.push({ label: "Payment terms", value: s.paymentTerms });
  if (s.advancePct != null) terms.push({ label: "Advance payment", value: `${s.advancePct}%` });
  if (s.milestones) terms.push({ label: "Milestones", value: s.milestones });
  if (s.warrantyMonths != null) terms.push({ label: "Warranty", value: `${s.warrantyMonths} months` });
  terms.push({ label: "Offer validity", value: `${s.offerValidityDays} days` });
  if (s.deliveryDays != null) terms.push({ label: "Delivery period", value: `${s.deliveryDays} days` });
  if (s.exclusions) terms.push({ label: "Exclusions", value: s.exclusions });
  if (s.commercialNotes) terms.push({ label: "Notes", value: s.commercialNotes });
  return { lines, terms };
}

// --------------------------------------------------------------------------- 10 · Templates

/** Where a template may be applied: an operation needs an item; a project cost or a subcontract can go to one item or the whole project. */
export function applyTarget(kind: TemplateKind, itemId: string | null): { ok: true; itemId: string | null } | { ok: false; reason: string } {
  if (kind === "OPERATION" && !itemId) return { ok: false, reason: "Choose the item this operation belongs to." };
  return { ok: true, itemId };
}
