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

export interface CommercialInput { profitMode: ProfitMode; profitValue: number; insuranceMode: InsuranceMode; insuranceValue: number; taxPct: number }
export interface CommercialResult { costCents: number; profitCents: number; insuranceCents: number; taxableCents: number; taxCents: number; finalCents: number; issue?: string }

/**
 * Chosen formula (no earlier business rule exists in the app — the Quotation model only keeps a profit %):
 *   profit     = cost × p%            (markup on cost)   |  cost × p/(100−p)  (margin on price)  |  fixed amount
 *   insurance  = fixed amount         |  (cost + profit) × i%
 *   taxable    = cost + profit + insurance
 *   tax        = taxable × t%
 *   final      = taxable + tax
 * Tax is charged on the whole price including profit and insurance (VAT-style).
 */
export function calcCommercial(costCents: number, c: CommercialInput): CommercialResult {
  let profit = 0; let issue: string | undefined;
  if (c.profitMode === "MARKUP_ON_COST") profit = Math.round(roundMoney((costCents * num(c.profitValue)) / 100));
  else if (c.profitMode === "MARGIN_ON_PRICE") {
    if (num(c.profitValue) >= 100) issue = "A margin on price must be below 100%";
    else profit = Math.round(roundMoney((costCents * num(c.profitValue)) / (100 - num(c.profitValue))));
  } else profit = toCents(num(c.profitValue));
  const insurance = c.insuranceMode === "FIXED" ? toCents(num(c.insuranceValue)) : Math.round(roundMoney(((costCents + profit) * num(c.insuranceValue)) / 100));
  const taxable = costCents + profit + insurance;
  const tax = Math.round(roundMoney((taxable * num(c.taxPct)) / 100));
  return { costCents, profitCents: profit, insuranceCents: insurance, taxableCents: taxable, taxCents: tax, finalCents: taxable + tax, issue };
}

// --------------------------------------------------------------------------- Whole estimate

export interface EstimateInputs {
  materials: MaterialInput[]; scrap: ScrapSettings;
  items: ItemInput[]; subcontracts: SubcontractInput[]; projectCosts: ProjectCostInput[];
  commercial: CommercialInput;
}
export interface EstimateResult {
  materials: MaterialResult; manufacturing: ManufacturingResult;
  subcontract: ReturnType<typeof calcSubcontract>; project: ReturnType<typeof calcProjectCosts>;
  totals: { materialCents: number; manufacturingCents: number; subcontractorCents: number; projectCents: number; estimatedCostCents: number };
  commercial: CommercialResult;
}

export function calcEstimate(i: EstimateInputs): EstimateResult {
  const materials = calcMaterials(i.materials, i.scrap);
  const manufacturing = calcManufacturing(i.items, materials.materialCostCents);
  const subcontract = calcSubcontract(i.subcontracts);
  const totalWeightKg = i.items.reduce((a, it) => a + num(it.weightKg), 0);
  const project = calcProjectCosts(i.projectCosts, { materialCents: materials.materialCostCents, manufacturingCents: manufacturing.totalCents, subcontractorCents: subcontract.totalCents, totalWeightKg });
  const totals = {
    materialCents: materials.materialCostCents, manufacturingCents: manufacturing.totalCents, subcontractorCents: subcontract.totalCents, projectCents: project.totalCents,
    estimatedCostCents: materials.materialCostCents + manufacturing.totalCents + subcontract.totalCents + project.totalCents,
  };
  return { materials, manufacturing, subcontract, project, totals, commercial: calcCommercial(totals.estimatedCostCents, i.commercial) };
}
