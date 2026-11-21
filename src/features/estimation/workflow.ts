/**
 * Pricing sheet — workflow, allocation, price-source and snapshot logic. Pure TypeScript (no DB, no React), same style as calc.ts.
 *
 * Nothing here decides company policy: who may approve is a permission (pricing.approve), the default price source is a
 * constant marked "needs approval", and no rate or threshold is hard-coded.
 */
import { calcEstimate, calcMaterials, type EstimateInputs, type EstimateResult, type PriceSource, type ScrapSettings } from "./calc";

// --------------------------------------------------------------------------- 1 · Status workflow

export const SHEET_STATUSES = ["DRAFT", "CALCULATED", "APPROVED"] as const;
export type SheetStatus = (typeof SHEET_STATUSES)[number];
export type SheetAction = "EDIT" | "CALCULATE" | "APPROVE" | "REOPEN";

/** Needs approval: which price source a NEW automatic line starts with when Procurement has a price. */
export const DEFAULT_PRICE_SOURCE: PriceSource = "PROCUREMENT";

export interface TransitionContext {
  /** the inputs now stored equal the inputs of the latest CALCULATED snapshot of this version */
  calculatedInputsCurrent?: boolean;
  /** calcEstimate().issues contains at least one error-level issue */
  hasErrors?: boolean;
  /** the caller holds pricing.approve */
  canApprove?: boolean;
}
export type TransitionResult = { ok: true; next: SheetStatus; versionIncrement: 0 | 1 } | { ok: false; reason: string; status: number };

/**
 * The only place that decides whether a status change is allowed.
 *   EDIT      DRAFT | CALCULATED → DRAFT   (an edit invalidates the calculation); APPROVED → forbidden (reopen first)
 *   CALCULATE DRAFT | CALCULATED → CALCULATED; blocked while there are error-level issues; APPROVED → forbidden
 *   APPROVE   CALCULATED → APPROVED, only if nothing changed since the calculation, no errors, and the caller may approve
 *   REOPEN    APPROVED → DRAFT with version + 1 (the approved snapshot is never touched)
 */
export function transition(status: SheetStatus, action: SheetAction, ctx: TransitionContext = {}): TransitionResult {
  switch (action) {
    case "EDIT":
      if (status === "APPROVED") return { ok: false, reason: "This sheet is approved and locked. Reopen it to create a new version.", status: 409 };
      return { ok: true, next: "DRAFT", versionIncrement: 0 };
    case "CALCULATE":
      if (status === "APPROVED") return { ok: false, reason: "This sheet is approved and locked. Reopen it to recalculate.", status: 409 };
      if (ctx.hasErrors) return { ok: false, reason: "Fix the errors in the issues panel before calculating.", status: 422 };
      return { ok: true, next: "CALCULATED", versionIncrement: 0 };
    case "APPROVE":
      if (!ctx.canApprove) return { ok: false, reason: "You do not have permission to approve pricing sheets.", status: 403 };
      if (status === "APPROVED") return { ok: false, reason: "This sheet is already approved.", status: 409 };
      if (status !== "CALCULATED") return { ok: false, reason: "Calculate the sheet before approving it.", status: 409 };
      if (!ctx.calculatedInputsCurrent) return { ok: false, reason: "The sheet changed after it was calculated. Recalculate before approving.", status: 409 };
      if (ctx.hasErrors) return { ok: false, reason: "Fix the errors in the issues panel before approving.", status: 422 };
      return { ok: true, next: "APPROVED", versionIncrement: 0 };
    case "REOPEN":
      if (!ctx.canApprove) return { ok: false, reason: "You do not have permission to reopen an approved sheet.", status: 403 };
      if (status !== "APPROVED") return { ok: false, reason: "Only an approved sheet can be reopened.", status: 409 };
      return { ok: true, next: "DRAFT", versionIncrement: 1 };
  }
}

// --------------------------------------------------------------------------- 2 · Allocating purchased kg to BOQ items

const GRAM = 1000;

/**
 * Splits `totalKg` over `weights` pro rata, in whole grams with largest-remainder rounding, so the shares add up to exactly
 * the total (to the gram). When the weights carry no information (all 0) nothing is invented: `unallocatedKg` is the whole total.
 */
export function allocateKg(totalKg: number, weights: number[]): { shares: number[]; unallocatedKg: number } {
  const total = Number.isFinite(totalKg) && totalKg > 0 ? Math.round(totalKg * GRAM) : 0;
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const sum = w.reduce((a, b) => a + b, 0);
  if (total === 0 || sum <= 0) return { shares: w.map(() => 0), unallocatedKg: total / GRAM };
  const raw = w.map((x) => (x / sum) * total);
  const floors = raw.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - floors[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) { if (left <= 0) break; if (w[o.i] > 0) { floors[o.i]++; left--; } }
  return { shares: floors.map((g) => g / GRAM), unallocatedKg: 0 };
}

export interface PartNet { scopeId: string | null; netKg: number }
export interface MaterialAllocation { scopeId: string | null; netKg: number; purchasedKg: number; requiredKg: number }

/**
 * One requirement row (what nesting / the Part List says must be bought) → one slice per BOQ item, pro rata by the NET weight
 * of the parts of that item that use this material. Parts without a scope item form the shared slice (scopeId null).
 * With no matching parts the whole row is one shared slice (nothing is guessed).
 */
export function allocateMaterialRow(row: { purchasedKg: number; requiredKg: number }, parts: PartNet[]): MaterialAllocation[] {
  const net = new Map<string | null, number>();
  for (const p of parts) if (Number.isFinite(p.netKg) && p.netKg > 0) net.set(p.scopeId, (net.get(p.scopeId) ?? 0) + p.netKg);
  const keys = [...net.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)));
  if (!keys.length) return [{ scopeId: null, netKg: 0, purchasedKg: row.purchasedKg, requiredKg: row.requiredKg }];
  const weights = keys.map((k) => net.get(k)!);
  const buy = allocateKg(row.purchasedKg, weights).shares;
  const need = allocateKg(row.requiredKg, weights).shares;
  return keys.map((k, i) => ({ scopeId: k, netKg: Math.round(weights[i] * GRAM) / GRAM, purchasedKg: buy[i], requiredKg: need[i] }));
}

// --------------------------------------------------------------------------- 3 · Price sources

export interface PriceOptions { procurement: number | null; stock: number | null; scrap: number | null }

/**
 * What each source offers, EGP/kg, for one material line.
 *  - procurement: weighted purchase price from Procurement (passed in).
 *  - stock: StockItem has no unit cost / valuation today, so this is null unless the caller has real data. Never invented.
 *  - scrap: Scrap Management's EFFECTIVE cost per kg = (purchased × base price − recoverable scrap value) ÷ kg the parts use,
 *    derived from the procurement price and this sheet's scrap settings. It is only offered when a base price exists and the
 *    parts need weight. Selecting it makes calcMaterials apply it to the kg the parts USE, so scrap is never counted twice.
 */
export function buildPriceOptions(i: { procurementPrice: number | null; stockPrice?: number | null; requiredKg: number | null; purchasedKg: number; scrap: ScrapSettings }): PriceOptions {
  const proc = i.procurementPrice != null && i.procurementPrice > 0 ? i.procurementPrice : null;
  const stock = i.stockPrice != null && i.stockPrice > 0 ? i.stockPrice : null;
  let scrap: number | null = null;
  const used = i.requiredKg ?? 0;
  if (proc != null && used > 0 && i.purchasedKg >= used) {
    const r = calcMaterials([{ id: "x", source: "PART_LIST", name: "x", requiredKg: used, purchasedKg: i.purchasedKg, unitPrice: proc, priceSource: "PROCUREMENT" }], { ...i.scrap, creditRecoveredScrap: false });
    const eff = r.effectiveCostPerKg;
    scrap = Number.isFinite(eff) && eff > 0 ? Math.round(eff * 10000) / 10000 : null;
  }
  return { procurement: proc, stock, scrap };
}

export const optionFor = (o: PriceOptions, s: PriceSource): number | null => (s === "MANUAL" ? null : s === "PROCUREMENT" ? o.procurement : s === "STOCK" ? o.stock : o.scrap);

export interface PriceLineState { priceSource: PriceSource; unitPrice: number }
export type PriceChoice = { ok: true; line: PriceLineState } | { ok: false; reason: string };

/** The user picks a source. A source that offers no price is refused — the current price is never replaced silently. */
export function choosePriceSource(cur: PriceLineState, options: PriceOptions, wanted: PriceSource, manualPrice?: number): PriceChoice {
  if (wanted === "MANUAL") {
    const p = manualPrice ?? cur.unitPrice;
    if (!Number.isFinite(p) || p < 0) return { ok: false, reason: "Enter a price of 0 or more" };
    return { ok: true, line: { priceSource: "MANUAL", unitPrice: p } };
  }
  const v = optionFor(options, wanted);
  if (v == null) return { ok: false, reason: `${wanted === "STOCK" ? "Stock has no valuation data" : `No ${wanted.toLowerCase()} price is available`} for this line` };
  return { ok: true, line: { priceSource: wanted, unitPrice: v } };
}

/**
 * Re-sync rule for a line the user has not typed over: it follows its source when that source's price changes. A MANUAL line
 * keeps the user's number. If the chosen source stops offering a price the current price is kept (and the caller shows a warning).
 */
export function priceAfterSync(cur: PriceLineState, options: PriceOptions): { line: PriceLineState; sourceLost: boolean } {
  if (cur.priceSource === "MANUAL") return { line: cur, sourceLost: false };
  const v = optionFor(options, cur.priceSource);
  return v == null ? { line: cur, sourceLost: true } : { line: { priceSource: cur.priceSource, unitPrice: v }, sourceLost: false };
}

/** Initial price of a brand-new automatic line: the default source when it offers a price, otherwise MANUAL at 0 (calc warns). */
export function initialPrice(options: PriceOptions): PriceLineState {
  const v = optionFor(options, DEFAULT_PRICE_SOURCE);
  return v != null ? { priceSource: DEFAULT_PRICE_SOURCE, unitPrice: v } : { priceSource: "MANUAL", unitPrice: 0 };
}

// --------------------------------------------------------------------------- 4 · Snapshots

/** JSON round-trip: what a JSONB column hands back (undefined dropped, NaN → null), so comparisons are like for like. */
export const normalize = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function stable(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stable).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
}
export const sameJson = (a: unknown, b: unknown) => stable(normalize(a)) === stable(normalize(b));

export interface SnapshotPayload { inputs: EstimateInputs; result: EstimateResult; costTotalCents: number; finalPriceCents: number }

export function buildSnapshot(inputs: EstimateInputs): SnapshotPayload {
  const frozen = normalize(inputs);
  const result = normalize(calcEstimate(frozen));
  return { inputs: frozen, result, costTotalCents: result.totals.estimatedCostCents, finalPriceCents: result.commercial.finalCents };
}

/** A stored snapshot is genuine when recomputing its inputs gives exactly its stored result. */
export function verifySnapshot(s: { inputs: unknown; result: unknown }): boolean {
  try { return sameJson(calcEstimate(normalize(s.inputs) as EstimateInputs), s.result); } catch { return false; }
}

// --------------------------------------------------------------------------- 5 · Comparing versions

export interface SnapshotDelta { key: string; label: string; fromCents: number; toCents: number; deltaCents: number }
export function compareSnapshots(a: { result: EstimateResult }, b: { result: EstimateResult }): SnapshotDelta[] {
  const rows: [string, string, (r: EstimateResult) => number][] = [
    ["material", "Materials", (r) => r.totals.materialCents],
    ["manufacturing", "Manufacturing", (r) => r.totals.manufacturingCents],
    ["subcontractor", "Subcontractors", (r) => r.totals.subcontractorCents],
    ["project", "Project costs", (r) => r.totals.projectCents],
    ["cost", "Estimated cost", (r) => r.totals.estimatedCostCents],
    ["profit", "Profit", (r) => r.commercial.profitCents],
    ["final", "Final price", (r) => r.commercial.finalCents],
  ];
  return rows.map(([key, label, f]) => ({ key, label, fromCents: f(a.result), toCents: f(b.result), deltaCents: f(b.result) - f(a.result) }));
}

// --------------------------------------------------------------------------- 6 · Field-level audit

export interface FieldChange { entity: string; label: string; field: string; from: unknown; to: unknown }

/** Lists the fields of `fields` whose value differs. Numbers compare with a tiny tolerance; null / undefined / "" are the same "empty". */
export function diffFields(entity: string, label: string, before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]): FieldChange[] {
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  const out: FieldChange[] = [];
  for (const f of fields) {
    const a = before[f], b = after[f];
    if (empty(a) && empty(b)) continue;
    if (typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-9 : a === b) continue;
    out.push({ entity, label, field: f, from: empty(a) ? null : a, to: empty(b) ? null : b });
  }
  return out;
}

// --------------------------------------------------------------------------- 7 · Matching Part List parts to a requirement row

export interface ReqRowKey { type: string; grade: string; thicknessMm: number | null; spec: string }
export interface PartKey { partType: string; material: string | null; thicknessMm: number | null; description: string }
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Does this part consume this requirement row? Same rule the old estimate used for plates (thickness + grade, a blank grade on
 * either side matches). Profiles / pipes / flats match when the row's spec starts with the part's description. Bought-out
 * accessories never match. A part that matches nothing is simply not attributed (the row then stays one shared slice).
 */
export function partMatchesRow(row: ReqRowKey, p: PartKey): boolean {
  if (p.partType === "ACCESSORY") return false;
  if (row.type === "Plate") {
    if (p.partType !== "PLATE" && p.partType !== "CONE") return false;
    if (row.thicknessMm == null || p.thicknessMm == null || Math.abs(row.thicknessMm - p.thicknessMm) >= 0.01) return false;
    const g = norm(row.grade);
    return !g || g === "—" || !norm(p.material) || norm(p.material) === g;
  }
  const d = norm(p.description);
  if (!d) return false;
  if (row.type === "Pipe") return p.partType === "PIPE" && norm(row.spec).startsWith(d);
  if (row.type === "Profile" || row.type === "Flat") return p.partType === "HOT_ROLLED" && norm(row.spec).startsWith(d);
  return false;
}

/**
 * Nest rows of the same thickness + grade (different sheet sizes) all see the same parts. Their part weight must be shared out
 * between them, not repeated on each, or "required kg" is counted once per sheet size. Shared pro rata by purchased kg.
 */
export function splitRequiredAmongRows(groupUsedKg: number, rows: { key: string; purchasedKg: number }[]): Record<string, number> {
  const { shares } = allocateKg(groupUsedKg, rows.map((r) => r.purchasedKg));
  const out: Record<string, number> = {};
  rows.forEach((r, i) => { out[r.key] = shares[i]; });
  return out;
}

// --------------------------------------------------------------------------- 8 · Price of a material line when the page saves

export interface SavedLineBefore { source: string; priceSource: PriceSource; unitPrice: number; requiredKg: number | null; procurementPrice: number | null }
export interface SavedLineInput { purchasedKg: number; unitPrice: number; priceSource?: PriceSource }
export type SavedLineResult = { ok: true; purchasedKg: number; unitPrice: number; priceSource: PriceSource; options: PriceOptions | null } | { ok: false; reason: string };

/**
 * Server-authoritative price of a material line after a save.
 *  - a hand-typed (MANUAL source) line keeps exactly what was sent;
 *  - an automatic line whose page names a source gets THAT source's price (the browser's number is ignored), or is refused;
 *  - an older page that names no source: a changed price means "I typed this" → MANUAL; an unchanged price keeps following
 *    its source (so e.g. the scrap cost per kg moves when purchased kg or the scrap settings change).
 */
export function resolveSavedLine(before: SavedLineBefore, sent: SavedLineInput, scrap: ScrapSettings): SavedLineResult {
  if (before.source === "MANUAL") return { ok: true, purchasedKg: sent.purchasedKg, unitPrice: sent.unitPrice, priceSource: "MANUAL", options: null };
  const options = buildPriceOptions({ procurementPrice: before.procurementPrice, stockPrice: null, requiredKg: before.requiredKg, purchasedKg: sent.purchasedKg, scrap });
  const cur: PriceLineState = { priceSource: before.priceSource, unitPrice: before.unitPrice };
  let line: PriceLineState;
  if (sent.priceSource) {
    const c = choosePriceSource(cur, options, sent.priceSource, sent.unitPrice);
    if (!c.ok) return { ok: false, reason: c.reason };
    line = c.line;
  } else if (Math.abs(sent.unitPrice - before.unitPrice) > 1e-9) line = { priceSource: "MANUAL", unitPrice: sent.unitPrice };
  else line = priceAfterSync(cur, options).line;
  return { ok: true, purchasedKg: sent.purchasedKg, unitPrice: line.unitPrice, priceSource: line.priceSource, options };
}
