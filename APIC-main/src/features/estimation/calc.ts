/**
 * Pricing & Estimation — calculation module. Pure TypeScript (no DB, no React): the server recalculates every
 * figure from stored inputs with these functions and the page uses the SAME functions to update instantly while
 * the user types.
 *
 * Money rules: each line is rounded to 2 dp (half away from zero, the app-wide policy in pricing/engine/rounding),
 * and totals are sums of those rounded lines held as integer cents, so totals always equal the sum of what is shown.
 *
 * v2 (item-based): material lines, subcontractor lines and project costs may belong to one BOQ item (itemId) or to the
 * whole project (itemId null). Item figures are summed into the project totals exactly once; shared project costs are
 * spread over the items with largest-remainder rounding so the parts always add up to the whole.
 *
 * Scrap: material cost = PURCHASED weight × unit price. The scrap is already inside that number (we pay for the
 * sheets, not for the parts), so it is never added again. Recovered scrap value is only deducted when the
 * estimator turns "credit recovered scrap" on.
 */
import { roundMoney } from "@/features/pricing/engine/rounding";
import { calculateScrapRow, calculateScrapTotals, type ScrapTotals } from "@/server/calc/scrap-management";

export const toCents = (x: number): number => (Number.isFinite(x) ? Math.round(roundMoney(x) * 100) : 0);
export const fromCents = (c: number): number => c / 100;
const num = (x: number | null | undefined, fallback = 0) => (typeof x === "number" && Number.isFinite(x) ? x : fallback);

// --------------------------------------------------------------------------- Stage 1 · Materials

export const PRICE_SOURCES = ["MANUAL", "PROCUREMENT", "STOCK", "SCRAP"] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];
export const PRICE_SOURCE_LABEL: Record<PriceSource, string> = { MANUAL: "Manual", PROCUREMENT: "Procurement", STOCK: "Stock", SCRAP: "Scrap (effective)" };

export interface MaterialInput {
  id: string;
  source: "NESTING" | "PART_LIST" | "PROCUREMENT" | "MANUAL";
  name: string;
  /** BOQ item the line belongs to; null / undefined = project-level. */
  itemId?: string | null;
  /** kg the parts need (from nesting / part list). null on manual lines = same as purchased. */
  requiredKg: number | null;
  /** kg actually bought (already the user's override when there is one). */
  purchasedKg: number;
  unitPrice: number; // per kg
  /**
   * Which price unitPrice holds. SCRAP means the Scrap Management EFFECTIVE cost per kg, which already contains the scrap
   * loss; it is therefore applied to the kg the parts USE (not the purchased kg) and never credited for recovered scrap again.
   */
  priceSource?: PriceSource;
}
export interface ScrapSettings { usedLaterPct: number; usedLaterPricePerKg: number; scrapSellPricePerKg: number; creditRecoveredScrap: boolean }
export interface MaterialLineResult { id: string; itemId: string | null; basisKg: number; grossCents: number; recoveredCents: number; creditedCents: number; /** gross − credited: what flows into the estimate */ totalCents: number; effectiveCostPerKg: number; issue?: string }
export interface MaterialResult {
  lines: MaterialLineResult[];
  purchasedKg: number; requiredKg: number;
  grossCents: number;
  scrap: { scrapKg: number; scrapPct: number; scrapValueCents: number; recoveredCents: number; netLossCents: number; shortageKg: number; totals: ScrapTotals };
  /** what flows into the project: gross, minus recovered scrap only when credited (and never for SCRAP-priced lines) */
  materialCostCents: number;
  /** (gross − recoverable scrap value) per kg the parts use — the figure Scrap Management calls effective cost; informational. */
  effectiveCostPerKg: number;
  /** cost of lines per BOQ item; project-level lines are under "" (empty key). */
  byItem: Record<string, number>;
}

export function calcMaterials(lines: MaterialInput[], s: ScrapSettings): MaterialResult {
  const rows = lines.map((l) => calculateScrapRow({
    key: l.id, label: l.name, material: l.name, thicknessMm: 0, widthMm: 0, lengthMm: 0,
    usedAreaSqm: 0, usedWeightKg: num(l.requiredKg ?? l.purchasedKg), buyQty: 0, buyAreaSqm: 0, buyWeightKg: num(l.purchasedKg),
    costPerKg: num(l.unitPrice), usedLaterPct: s.usedLaterPct,
    usedLaterPriceLEPerKg: s.usedLaterPricePerKg, scrapSellPriceLEPerKg: s.scrapSellPricePerKg,
  }));
  const results: MaterialLineResult[] = lines.map((l, i) => {
    const effective = l.priceSource === "SCRAP";
    const basisKg = effective ? num(l.requiredKg ?? l.purchasedKg) : num(l.purchasedKg);
    const grossCents = toCents(basisKg * num(l.unitPrice));
    const recoveredCents = effective ? 0 : toCents(rows[i].recoveredLE);
    const creditedCents = s.creditRecoveredScrap ? recoveredCents : 0;
    return {
      id: l.id, itemId: l.itemId ?? null, basisKg, grossCents, recoveredCents, creditedCents,
      totalCents: grossCents - creditedCents,
      effectiveCostPerKg: rows[i].effectiveCostPerKg,
      issue: num(l.unitPrice) <= 0 && basisKg > 0 ? "No price: enter one or pick a source" : undefined,
    };
  });
  const grossCents = results.reduce((a, r) => a + r.grossCents, 0);
  const recoveredCents = results.reduce((a, r) => a + r.recoveredCents, 0);
  const materialCostCents = results.reduce((a, r) => a + r.totalCents, 0);
  const totals = calculateScrapTotals(rows);
  const byItem: Record<string, number> = {};
  for (const r of results) byItem[r.itemId ?? ""] = (byItem[r.itemId ?? ""] ?? 0) + r.totalCents;
  const usedKg = totals.usedWeightKg;
  return {
    lines: results,
    purchasedKg: totals.buyWeightKg, requiredKg: usedKg,
    grossCents,
    scrap: {
      scrapKg: totals.primaryScrapKg, scrapPct: totals.primaryScrapPct,
      scrapValueCents: toCents(rows.reduce((a, r) => a + r.primaryScrapKg * r.costPerKg, 0)), // what the scrap cost to buy
      recoveredCents, netLossCents: toCents(totals.netScrapLossLE),
      shortageKg: rows.reduce((a, r) => a + r.shortageKg, 0), totals,
    },
    materialCostCents,
    effectiveCostPerKg: usedKg > 0 ? fromCents(grossCents - recoveredCents) / usedKg : 0,
    byItem,
  };
}

// --------------------------------------------------------------------------- Stage 2 · Manufacturing

export const COST_TYPES = ["FIXED", "PERCENTAGE", "PER_KG", "PER_TON", "PER_METER", "PER_SQM", "PER_HOUR", "PER_PIECE", "PER_HOLE", "CUSTOM"] as const;
export type CostType = (typeof COST_TYPES)[number];
export const OP_PERCENT_BASES = ["ITEM_OPERATIONS", "ITEM_MATERIAL_SHARE"] as const;
export type OpPercentBase = (typeof OP_PERCENT_BASES)[number];

export const COST_TYPE_LABEL: Record<CostType, string> = {
  FIXED: "Fixed", PERCENTAGE: "Percentage", PER_KG: "Per KG", PER_TON: "Per Ton", PER_METER: "Per M", PER_SQM: "Per SQM", PER_HOUR: "Per Hour", PER_PIECE: "Per Piece", PER_HOLE: "Per Hole", CUSTOM: "Custom unit",
};
/** Default unit shown for a cost type (CUSTOM and FIXED have none: the user types it / it is not needed). */
export const COST_TYPE_UNIT: Record<CostType, string> = { FIXED: "", PERCENTAGE: "%", PER_KG: "KG", PER_TON: "TON", PER_METER: "M", PER_SQM: "SQM", PER_HOUR: "HR", PER_PIECE: "PC", PER_HOLE: "Hole", CUSTOM: "" };
export const OP_BASE_LABEL: Record<OpPercentBase, string> = {
  ITEM_OPERATIONS: "Other selected operations of this item",
  ITEM_MATERIAL_SHARE: "This item's material cost (own lines, else weight share of shared material)",
};

export interface OperationInput {
  id: string; selected: boolean; costType: CostType; rate: number;
  /** null = take it from the item (kg / ton / pieces); manual types (m, h, hole, custom) need a value. */
  quantity: number | null;
  percentBase: OpPercentBase | null;
}
export interface ItemInput { id: string; weightKg: number; pieces: number; operations: OperationInput[] }
export interface OperationResult { id: string; quantity: number; amountCents: number; contributes: boolean; issue?: string }
export interface ItemResult { id: string; operations: OperationResult[]; totalCents: number }
export interface ManufacturingResult { items: ItemResult[]; totalCents: number }

export function operationQuantity(op: Pick<OperationInput, "costType" | "quantity">, item: Pick<ItemInput, "weightKg" | "pieces">): number | null {
  if (op.costType === "FIXED" || op.costType === "PERCENTAGE") return null;
  if (op.quantity != null) return num(op.quantity);
  if (op.costType === "PER_KG") return num(item.weightKg);
  if (op.costType === "PER_TON") return num(item.weightKg) / 1000;
  if (op.costType === "PER_PIECE") return num(item.pieces);
  return null; // per m / sqm / hour / hole / custom: no data source, the estimator must enter it
}

/**
 * `materialCostCents` is the SHARED material pool (lines not tied to an item); an item that has its own material lines
 * (`itemMaterialCents[item.id]`) uses those instead of a weight share of the pool.
 */
export function calcManufacturing(items: ItemInput[], materialCostCents: number, itemMaterialCents: Record<string, number> = {}): ManufacturingResult {
  const totalKg = items.reduce((a, i) => a + num(i.weightKg), 0);
  const out: ItemResult[] = items.map((item) => {
    // 1) non-percentage operations
    const results = new Map<string, OperationResult>();
    let opsSubtotal = 0;
    for (const op of item.operations) {
      if (op.costType === "PERCENTAGE") continue;
      let amount = 0; let quantity = 0; let issue: string | undefined;
      if (op.costType === "FIXED") amount = toCents(num(op.rate));
      else {
        const q = operationQuantity(op, item);
        if (q == null) issue = "Enter a quantity";
        quantity = q ?? 0;
        amount = toCents(quantity * num(op.rate));
      }
      results.set(op.id, { id: op.id, quantity, amountCents: amount, contributes: op.selected, issue });
      if (op.selected) opsSubtotal += amount;
    }
    // 2) percentage operations — explicit base; never based on other percentage operations
    const materialShare = item.id in itemMaterialCents ? itemMaterialCents[item.id] : totalKg > 0 ? Math.round((materialCostCents * num(item.weightKg)) / totalKg) : 0;
    for (const op of item.operations) {
      if (op.costType !== "PERCENTAGE") continue;
      const base = op.percentBase === "ITEM_MATERIAL_SHARE" ? materialShare : op.percentBase === "ITEM_OPERATIONS" ? opsSubtotal : null;
      results.set(op.id, { id: op.id, quantity: 0, amountCents: base == null ? 0 : Math.round(roundMoney((base * num(op.rate)) / 100)), contributes: op.selected, issue: base == null ? "Choose what the percentage applies to" : undefined });
    }
    const operations = item.operations.map((o) => results.get(o.id)!);
    return { id: item.id, operations, totalCents: operations.reduce((a, r) => a + (r.contributes ? r.amountCents : 0), 0) };
  });
  return { items: out, totalCents: out.reduce((a, i) => a + i.totalCents, 0) };
}

export const SUB_COST_TYPES = ["FIXED", "PERCENTAGE", "PER_UNIT"] as const;
export type SubCostType = (typeof SUB_COST_TYPES)[number];
export const SUB_COST_TYPE_LABEL: Record<SubCostType, string> = { FIXED: "Fixed", PERCENTAGE: "Percentage", PER_UNIT: "Per unit" };
/** Of the item the service belongs to; of the whole project when the service is not tied to an item. */
export const SUB_PERCENT_BASES = ["MATERIAL_COST", "MANUFACTURING_COST", "MATERIAL_PLUS_MANUFACTURING"] as const;
export type SubPercentBase = (typeof SUB_PERCENT_BASES)[number];
export const SUB_BASE_LABEL: Record<SubPercentBase, string> = { MATERIAL_COST: "Material cost", MANUFACTURING_COST: "Internal manufacturing cost", MATERIAL_PLUS_MANUFACTURING: "Material + internal manufacturing" };

export interface SubcontractInput {
  id: string; quantity: number; unitPrice: number;
  itemId?: string | null; selected?: boolean; costType?: SubCostType; percentBase?: SubPercentBase | null;
}
export interface SubcontractContext {
  /** cost per item (key = item id) and project-wide (key "") */
  materialCents: Record<string, number>; manufacturingCents: Record<string, number>;
  projectMaterialCents: number; projectManufacturingCents: number;
}
export interface SubcontractLineResult { id: string; itemId: string | null; totalCents: number; contributes: boolean; issue?: string }
export interface SubcontractResult { lines: SubcontractLineResult[]; totalCents: number; byItem: Record<string, number> }

/** Externally outsourced work. A unit price of 0 on a selected line is a warning, not an error: some services are quoted later. */
export function calcSubcontract(rows: SubcontractInput[], ctx?: SubcontractContext): SubcontractResult {
  const lines: SubcontractLineResult[] = rows.map((r) => {
    const contributes = r.selected !== false;
    const type = r.costType ?? "PER_UNIT";
    const itemId = r.itemId ?? null;
    let totalCents = 0; let issue: string | undefined;
    if (type === "FIXED") totalCents = toCents(num(r.unitPrice));
    else if (type === "PER_UNIT") totalCents = toCents(num(r.quantity) * num(r.unitPrice));
    else {
      const mat = itemId ? ctx?.materialCents[itemId] ?? 0 : ctx?.projectMaterialCents ?? 0;
      const man = itemId ? ctx?.manufacturingCents[itemId] ?? 0 : ctx?.projectManufacturingCents ?? 0;
      const base = r.percentBase === "MATERIAL_COST" ? mat : r.percentBase === "MANUFACTURING_COST" ? man : r.percentBase === "MATERIAL_PLUS_MANUFACTURING" ? mat + man : null;
      if (base == null) issue = "Choose what the percentage applies to";
      else totalCents = Math.round(roundMoney((base * num(r.unitPrice)) / 100));
    }
    return { id: r.id, itemId, totalCents, contributes, issue };
  });
  const byItem: Record<string, number> = {};
  for (const l of lines) if (l.contributes) byItem[l.itemId ?? ""] = (byItem[l.itemId ?? ""] ?? 0) + l.totalCents;
  return { lines, totalCents: lines.reduce((a, l) => a + (l.contributes ? l.totalCents : 0), 0), byItem };
}

/** Splits `totalCents` by `weights` so the parts add up to exactly the total (largest remainder; equal split if all weights are 0). */
export function allocateCents(totalCents: number, weights: number[]): number[] {
  if (weights.length === 0) return [];
  const w = weights.map((x) => Math.max(0, num(x)));
  const sum = w.reduce((a, b) => a + b, 0);
  const shares = sum > 0 ? w.map((x) => (totalCents * x) / sum) : w.map(() => totalCents / w.length);
  const floors = shares.map((x) => Math.floor(x));
  let left = totalCents - floors.reduce((a, b) => a + b, 0);
  const order = shares.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) { if (left <= 0) break; floors[i] += 1; left -= 1; }
  return floors;
}

// --------------------------------------------------------------------------- Stage 3 · Project costs

export const PROJECT_METHODS = ["FIXED", "PERCENTAGE", "PER_TRIP", "PER_TON", "PER_KG", "PER_HOUR", "PER_TEST", "PER_UNIT", "CUSTOM"] as const;
export type ProjectMethod = (typeof PROJECT_METHODS)[number];
export const PROJECT_METHOD_LABEL: Record<ProjectMethod, string> = { FIXED: "Fixed", PERCENTAGE: "Percentage", PER_TRIP: "Per Trip", PER_TON: "Per Ton", PER_KG: "Per KG", PER_HOUR: "Per Hour", PER_TEST: "Per Test", PER_UNIT: "Per Unit", CUSTOM: "Custom" };
export const PROJECT_METHOD_UNIT: Record<ProjectMethod, string> = { FIXED: "", PERCENTAGE: "%", PER_TRIP: "trip", PER_TON: "ton", PER_KG: "kg", PER_HOUR: "hr", PER_TEST: "test", PER_UNIT: "unit", CUSTOM: "" };
/** Percentages in this stage apply to earlier stages only, so a project cost can never depend on another project cost. */
export const PROJECT_PERCENT_BASES = ["MATERIAL_COST", "MANUFACTURING_COST", "SUBCONTRACTOR_COST", "DIRECT_COST"] as const;
export type ProjectPercentBase = (typeof PROJECT_PERCENT_BASES)[number];
export const PROJECT_BASE_LABEL: Record<ProjectPercentBase, string> = {
  MATERIAL_COST: "Material cost", MANUFACTURING_COST: "Manufacturing cost", SUBCONTRACTOR_COST: "Subcontractor cost", DIRECT_COST: "Material + Manufacturing + Subcontractor",
};
export const ALLOCATION_BASES = ["WEIGHT", "DIRECT_COST", "EQUAL"] as const;
export type AllocationBasis = (typeof ALLOCATION_BASES)[number];
export const ALLOCATION_LABEL: Record<AllocationBasis, string> = { WEIGHT: "By item weight", DIRECT_COST: "By item direct cost", EQUAL: "Equally" };

export interface ProjectCostInput { id: string; enabled: boolean; method: ProjectMethod; rate: number; quantity: number | null; percentBase: ProjectPercentBase | null; /** null = shared by the project; set = belongs to that item only */ itemId?: string | null }
export interface ProjectCostResult { id: string; itemId: string | null; quantity: number; amountCents: number; contributes: boolean; issue?: string }
export interface ProjectCostContext {
  materialCents: number; manufacturingCents: number; subcontractorCents: number; totalWeightKg: number;
  /** per item (key = item id) — used for costs assigned to one item */
  itemMaterialCents?: Record<string, number>; itemManufacturingCents?: Record<string, number>; itemSubcontractorCents?: Record<string, number>; itemWeightKg?: Record<string, number>;
}

export function calcProjectCosts(rows: ProjectCostInput[], ctx: ProjectCostContext) {
  const lines: ProjectCostResult[] = rows.map((r) => {
    const itemId = r.itemId ?? null;
    const scoped = itemId != null && ctx.itemMaterialCents != null;
    const mat = scoped ? ctx.itemMaterialCents![itemId!] ?? 0 : ctx.materialCents;
    const man = scoped ? ctx.itemManufacturingCents?.[itemId!] ?? 0 : ctx.manufacturingCents;
    const sub = scoped ? ctx.itemSubcontractorCents?.[itemId!] ?? 0 : ctx.subcontractorCents;
    const kg = scoped ? ctx.itemWeightKg?.[itemId!] ?? 0 : ctx.totalWeightKg;
    const bases: Record<ProjectPercentBase, number> = { MATERIAL_COST: mat, MANUFACTURING_COST: man, SUBCONTRACTOR_COST: sub, DIRECT_COST: mat + man + sub };
    if (r.method === "FIXED") return { id: r.id, itemId, quantity: 1, amountCents: toCents(num(r.rate)), contributes: r.enabled };
    if (r.method === "PERCENTAGE") {
      const base = r.percentBase ? bases[r.percentBase] : null;
      return { id: r.id, itemId, quantity: 0, amountCents: base == null ? 0 : Math.round(roundMoney((base * num(r.rate)) / 100)), contributes: r.enabled, issue: base == null ? "Choose what the percentage applies to" : undefined };
    }
    const quantity = r.quantity != null ? num(r.quantity) : r.method === "PER_TON" ? kg / 1000 : r.method === "PER_KG" ? kg : 1;
    return { id: r.id, itemId, quantity, amountCents: toCents(quantity * num(r.rate)), contributes: r.enabled };
  });
  return { lines, totalCents: lines.reduce((a, l) => a + (l.contributes ? l.amountCents : 0), 0) };
}

// --------------------------------------------------------------------------- Stage 4 · Commercial price

export const PROFIT_MODES = ["MARKUP_ON_COST", "MARGIN_ON_PRICE", "FIXED"] as const;
export type ProfitMode = (typeof PROFIT_MODES)[number];
export const PROFIT_MODE_LABEL: Record<ProfitMode, string> = { MARKUP_ON_COST: "% markup on cost", MARGIN_ON_PRICE: "% margin on price", FIXED: "Fixed amount" };
export const INSURANCE_MODES = ["FIXED", "PERCENT"] as const;
export type InsuranceMode = (typeof INSURANCE_MODES)[number];
export const DISCOUNT_MODES = ["NONE", "PERCENT", "FIXED"] as const;
export type DiscountMode = (typeof DISCOUNT_MODES)[number];
export const DISCOUNT_TIMINGS = ["BEFORE_TAX", "AFTER_TAX"] as const;
export type DiscountTiming = (typeof DISCOUNT_TIMINGS)[number];

export interface CommercialInput {
  profitMode: ProfitMode; profitValue: number; insuranceMode: InsuranceMode; insuranceValue: number; taxPct: number;
  discountMode?: DiscountMode; discountValue?: number; discountTiming?: DiscountTiming;
  otherChargesValue?: number; otherChargesTaxable?: boolean;
  /** optional goal; only compared with the result, never forced onto it */
  targetSaleCents?: number | null;
}
export interface CommercialResult {
  costCents: number; profitCents: number; insuranceCents: number; otherChargesCents: number; discountCents: number;
  /** insurance + other charges − discount (tax is separate) */
  adjustmentsCents: number;
  /** profit after the discount has been given away */
  netProfitCents: number;
  taxableCents: number; taxCents: number; finalCents: number;
  /** profit ÷ cost (markup) and profit ÷ (cost + profit) (margin) — two different numbers, never interchangeable */
  markupPct: number; marginPct: number;
  /** final − target; null when no target was set */
  targetGapCents: number | null;
  issue?: string;
}

/**
 * Order of calculation (explicit; the only company rule found in the app is a profit %, so the rest is a documented choice
 * that the estimator can change through the parameters, and it is labelled for approval):
 *   1. profit      = cost × p%  (markup on cost)  |  cost × p/(100−p)  (margin on price)  |  fixed amount
 *   2. insurance   = fixed amount  |  (cost + profit) × i%
 *   3. other       = fixed amount (taxable or not)
 *   4. discount    = fixed | % of (cost + profit + insurance + other)
 *   5. taxable     = cost + profit + insurance + (other if taxable) − (discount when BEFORE_TAX)
 *   6. tax         = taxable × t%
 *   7. final       = cost + profit + insurance + other + tax − discount
 * Costs that already contain tax must not be entered again here (nothing in the cost stages adds tax).
 */
export function calcCommercial(costCents: number, c: CommercialInput): CommercialResult {
  let profit = 0; let issue: string | undefined;
  if (c.profitMode === "MARKUP_ON_COST") profit = Math.round(roundMoney((costCents * num(c.profitValue)) / 100));
  else if (c.profitMode === "MARGIN_ON_PRICE") {
    if (num(c.profitValue) >= 100) issue = "A margin on price must be below 100%";
    else profit = Math.round(roundMoney((costCents * num(c.profitValue)) / (100 - num(c.profitValue))));
  } else profit = toCents(num(c.profitValue));
  const insurance = c.insuranceMode === "FIXED" ? toCents(num(c.insuranceValue)) : Math.round(roundMoney(((costCents + profit) * num(c.insuranceValue)) / 100));
  const other = toCents(num(c.otherChargesValue));
  const otherTaxable = c.otherChargesTaxable !== false;
  const subtotal = costCents + profit + insurance + other;
  let discount = 0;
  const dMode = c.discountMode ?? "NONE";
  if (dMode === "PERCENT") {
    if (num(c.discountValue) > 100) issue = issue ?? "A discount cannot exceed 100%";
    discount = Math.round(roundMoney((subtotal * Math.min(100, num(c.discountValue))) / 100));
  } else if (dMode === "FIXED") discount = toCents(num(c.discountValue));
  if (discount > subtotal) { issue = issue ?? "The discount is larger than the price"; discount = subtotal; }
  const before = (c.discountTiming ?? "BEFORE_TAX") === "BEFORE_TAX";
  const taxable = Math.max(0, costCents + profit + insurance + (otherTaxable ? other : 0) - (before ? discount : 0));
  const tax = Math.round(roundMoney((taxable * num(c.taxPct)) / 100));
  const final = subtotal + tax - discount;
  return {
    costCents, profitCents: profit, insuranceCents: insurance, otherChargesCents: other, discountCents: discount,
    adjustmentsCents: insurance + other - discount, netProfitCents: profit - discount,
    taxableCents: taxable, taxCents: tax, finalCents: final,
    markupPct: costCents > 0 ? Math.round((profit / costCents) * 10000) / 100 : 0,
    marginPct: costCents + profit > 0 ? Math.round((profit / (costCents + profit)) * 10000) / 100 : 0,
    targetGapCents: c.targetSaleCents != null ? final - c.targetSaleCents : null,
    issue,
  };
}

// --------------------------------------------------------------------------- Whole estimate

export interface EstimateInputs {
  materials: MaterialInput[]; scrap: ScrapSettings;
  items: ItemInput[]; subcontracts: SubcontractInput[]; projectCosts: ProjectCostInput[];
  commercial: CommercialInput;
  /** how shared project costs are spread over the items (default WEIGHT) */
  allocationBasis?: AllocationBasis;
}
export interface CalcIssue { level: "error" | "warning"; scope: "material" | "operation" | "subcontract" | "projectCost" | "commercial"; id?: string; message: string }
export interface ItemSummary {
  id: string; weightKg: number;
  materialCents: number; manufacturingCents: number; subcontractCents: number;
  /** project costs assigned to this item + its allocated share of the shared ones */
  projectCents: number; costCents: number;
  /** the item's share of the final price (proportional to cost; shares add up to the final price) */
  finalCents: number; finalPerKg: number | null;
}
export interface EstimateResult {
  materials: MaterialResult; manufacturing: ManufacturingResult;
  subcontract: SubcontractResult; project: ReturnType<typeof calcProjectCosts>;
  totals: { materialCents: number; manufacturingCents: number; subcontractorCents: number; projectCents: number; estimatedCostCents: number };
  commercial: CommercialResult;
  /** per BOQ item, plus the pool of things not tied to any item (shared materials / services, and shared project costs when there are no items) */
  items: ItemSummary[];
  shared: { materialCents: number; subcontractCents: number; projectCents: number; costCents: number; finalCents: number };
  rates: { totalWeightKg: number; finalPerKg: number | null; finalPerTon: number | null };
  issues: CalcIssue[];
}

export function calcEstimate(i: EstimateInputs): EstimateResult {
  const materials = calcMaterials(i.materials, i.scrap);
  const itemIds = new Set(i.items.map((it) => it.id));
  // a material line pointing at an item that no longer exists is treated as shared, never dropped
  const key = (id: string | null | undefined) => (id && itemIds.has(id) ? id : "");
  const itemMaterial: Record<string, number> = {};
  for (const it of i.items) if (it.id in materials.byItem) itemMaterial[it.id] = materials.byItem[it.id];
  const sharedMaterial = materials.materialCostCents - i.items.reduce((a, it) => a + (itemMaterial[it.id] ?? 0), 0);
  const manufacturing = calcManufacturing(i.items, sharedMaterial, itemMaterial);
  const manByItem: Record<string, number> = Object.fromEntries(manufacturing.items.map((m) => [m.id, m.totalCents]));
  const matByItem: Record<string, number> = Object.fromEntries(i.items.map((it) => [it.id, itemMaterial[it.id] ?? 0]));
  // items without own material lines get a weight share of the shared pool for % bases only (done inside calcManufacturing)
  const subcontract = calcSubcontract(i.subcontracts.map((s) => ({ ...s, itemId: key(s.itemId) || null })), {
    materialCents: matByItem, manufacturingCents: manByItem,
    projectMaterialCents: materials.materialCostCents, projectManufacturingCents: manufacturing.totalCents,
  });
  const subByItem: Record<string, number> = {};
  for (const it of i.items) subByItem[it.id] = subcontract.byItem[it.id] ?? 0;
  const totalWeightKg = i.items.reduce((a, it) => a + num(it.weightKg), 0);
  const weightByItem = Object.fromEntries(i.items.map((it) => [it.id, num(it.weightKg)]));
  const project = calcProjectCosts(i.projectCosts.map((c) => ({ ...c, itemId: key(c.itemId) || null })), {
    materialCents: materials.materialCostCents, manufacturingCents: manufacturing.totalCents, subcontractorCents: subcontract.totalCents, totalWeightKg,
    itemMaterialCents: matByItem, itemManufacturingCents: manByItem, itemSubcontractorCents: subByItem, itemWeightKg: weightByItem,
  });
  const totals = {
    materialCents: materials.materialCostCents, manufacturingCents: manufacturing.totalCents, subcontractorCents: subcontract.totalCents, projectCents: project.totalCents,
    estimatedCostCents: materials.materialCostCents + manufacturing.totalCents + subcontract.totalCents + project.totalCents,
  };
  const commercial = calcCommercial(totals.estimatedCostCents, i.commercial);

  // ---- per item
  const assigned: Record<string, number> = {}; let sharedProject = 0;
  for (const l of project.lines) {
    if (!l.contributes) continue;
    if (l.itemId) assigned[l.itemId] = (assigned[l.itemId] ?? 0) + l.amountCents; else sharedProject += l.amountCents;
  }
  const direct = i.items.map((it) => (matByItem[it.id] ?? 0) + (manByItem[it.id] ?? 0) + (subByItem[it.id] ?? 0));
  const basis = i.allocationBasis ?? "WEIGHT";
  const w = basis === "EQUAL" ? i.items.map(() => 1) : basis === "DIRECT_COST" ? direct : i.items.map((it) => num(it.weightKg));
  const spread = i.items.length ? allocateCents(sharedProject, w) : [];
  const sharedSub = subcontract.byItem[""] ?? 0;
  const sharedPool = { materialCents: sharedMaterial, subcontractCents: sharedSub, projectCents: i.items.length ? 0 : sharedProject };
  const sharedCost = sharedPool.materialCents + sharedPool.subcontractCents + sharedPool.projectCents;
  const itemCosts = i.items.map((it, n) => direct[n] + (assigned[it.id] ?? 0) + spread[n]);
  const finals = allocateCents(commercial.finalCents, [...itemCosts, sharedCost]);
  const items: ItemSummary[] = i.items.map((it, n) => ({
    id: it.id, weightKg: num(it.weightKg), materialCents: matByItem[it.id] ?? 0, manufacturingCents: manByItem[it.id] ?? 0, subcontractCents: subByItem[it.id] ?? 0,
    projectCents: (assigned[it.id] ?? 0) + spread[n], costCents: itemCosts[n], finalCents: finals[n],
    finalPerKg: num(it.weightKg) > 0 ? Math.round((finals[n] / 100 / num(it.weightKg)) * 100) / 100 : null,
  }));

  // ---- issues
  const issues: CalcIssue[] = [];
  for (const l of materials.lines) if (l.issue) issues.push({ level: "warning", scope: "material", id: l.id, message: l.issue });
  if (materials.scrap.shortageKg > 0) issues.push({ level: "warning", scope: "material", message: `Purchased weight is ${Math.round(materials.scrap.shortageKg)} kg below what the parts need` });
  for (const it of manufacturing.items) for (const o of it.operations) if (o.contributes && o.issue) issues.push({ level: "error", scope: "operation", id: o.id, message: o.issue });
  for (const l of subcontract.lines) if (l.contributes && l.issue) issues.push({ level: "error", scope: "subcontract", id: l.id, message: l.issue });
  for (const l of project.lines) if (l.contributes && l.issue) issues.push({ level: "error", scope: "projectCost", id: l.id, message: l.issue });
  if (commercial.issue) issues.push({ level: "error", scope: "commercial", message: commercial.issue });

  return {
    materials, manufacturing, subcontract, project, totals, commercial, items,
    shared: { ...sharedPool, costCents: sharedCost, finalCents: finals[finals.length - 1] },
    rates: {
      totalWeightKg,
      finalPerKg: totalWeightKg > 0 ? Math.round((commercial.finalCents / 100 / totalWeightKg) * 100) / 100 : null,
      finalPerTon: totalWeightKg > 0 ? Math.round((commercial.finalCents / 100 / (totalWeightKg / 1000)) * 100) / 100 : null,
    },
    issues,
  };
}
