/**
 * Pricing sheet calculation — pure TypeScript (no DB, no React).
 * Maps stored rows (items, material lines, extra components, overrides, rate profiles) onto the engine
 * and returns one result per item plus sheet totals. Every formula lives in the engine; this file only
 * adapts data and aggregates.
 */
import {
  CALC_PROFILES, deriveQuantities, priceItem, parseUnit,
  type CalcProfileId, type Category, type Component, type Issue, type Method, type PricingResult, type RateLayers, type RateMap, type Unit,
} from "./engine";

export type MaterialSource = "NESTING" | "STOCK" | "PROCUREMENT" | "MANUAL";

export interface MaterialLineRow { id: string; source: MaterialSource; name: string; grade?: string | null; qty: number; unit: string; unitCost: number; importedRef?: string | null }
export interface ComponentRow { id: string; category: string; name: string; method: string; rate: number; fixed?: number | null; unit?: string | null; base?: string | null; enabled: boolean }
export interface OverrideRow { rateKey: string; value: number }
export interface ItemRow {
  id: string; itemNo: string; description: string; unit: string; qty: number; unitWeightKg?: number | null;
  calcProfile?: string | null; profileRefs?: Record<string, string> | null;
  materials: MaterialLineRow[]; components: ComponentRow[]; overrides: OverrideRow[];
}
export interface RateProfileComponentRow { key: string; rate: number; enabled: boolean; name?: string; category?: string; method?: string; fixed?: number | null; unit?: string | null; base?: string | null }
export interface RateProfileRow { id: string; name?: string; scope: "GLOBAL" | "PROJECT"; components: RateProfileComponentRow[] }

export const LINE_CATEGORIES = ["FABRICATION", "SUBCONTRACTOR", "INSTALLATION", "ADD_ON"] as const;
const LINE_METHODS: Method[] = ["PER_TON", "PER_KG", "PER_SQM", "PER_METER", "PER_UNIT", "FIXED_LUMP_SUM", "FIXED_PLUS_VARIABLE", "PERCENT_OF_BASE"];
/** Bases a user-entered percentage line may use. A line can never use its own category's total (that would be a cycle). */
export const PERCENT_BASES: { id: string; label: string; category: Category }[] = [
  { id: "MATERIAL_COST", label: "Material cost", category: "MATERIAL" },
  { id: "FAB_DIRECT", label: "Fabrication direct", category: "FABRICATION" },
  { id: "SUB_DIRECT", label: "Subcontractor direct", category: "SUBCONTRACTOR" },
];
const METHOD_UNIT: Partial<Record<Method, Unit>> = { PER_TON: "TON", PER_KG: "KG", PER_SQM: "SQM", PER_METER: "M", PER_UNIT: "EA" };

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(+n.toPrecision(10)));

/** Merges the active components of the given profiles into one rate map. Disabled components are skipped. */
export function profileRateMap(profiles: RateProfileRow[]): RateMap {
  const m: RateMap = {};
  for (const p of profiles) for (const c of p.components) if (c.enabled && !c.key.startsWith("line.")) m[c.key] = c.rate;
  return m;
}

export function buildLayers(item: ItemRow, profiles: RateProfileRow[]): RateLayers {
  const refs = new Set(Object.values(item.profileRefs ?? {}));
  return {
    global: profileRateMap(profiles.filter((p) => p.scope === "GLOBAL")),
    project: profileRateMap(profiles.filter((p) => p.scope === "PROJECT")),
    profile: profileRateMap(profiles.filter((p) => refs.has(p.id))),
    override: Object.fromEntries(item.overrides.map((o) => [o.rateKey, o.value])),
  };
}

/** A material line is quantity × unit cost: a fixed amount whose source text shows the arithmetic. */
export function materialComponent(l: MaterialLineRow): { component?: Component; issue?: Issue } {
  const id = `mat:${l.id}`;
  if (!parseUnit(l.unit)) return { issue: { code: "INVALID_UNIT", severity: "error", nodeId: id, message: `Material "${l.name}": unknown unit "${l.unit}".` } };
  if (!Number.isFinite(l.qty) || l.qty < 0 || !Number.isFinite(l.unitCost) || l.unitCost < 0) {
    return { issue: { code: "INVALID_QUANTITY", severity: "error", nodeId: id, message: `Material "${l.name}": quantity and unit cost must be numbers ≥ 0.` } };
  }
  return {
    component: {
      id, name: l.name, category: "MATERIAL", ledger: "COST", method: "FIXED_LUMP_SUM", rate: l.qty * l.unitCost, enabled: true,
      source: `${l.source.toLowerCase()} line: ${fmt(l.qty)} ${l.unit} × ${fmt(l.unitCost)}`,
    },
  };
}

export function lineComponent(c: ComponentRow): { component?: Component; issue?: Issue } {
  const id = `line:${c.id}`;
  const bad = (message: string): { issue: Issue } => ({ issue: { code: "INVALID_RATE", severity: "error", nodeId: id, message } });
  if (!(LINE_CATEGORIES as readonly string[]).includes(c.category)) return bad(`"${c.name}": category ${c.category} is not allowed for a line.`);
  if (!LINE_METHODS.includes(c.method as Method)) return bad(`"${c.name}": unsupported method ${c.method}.`);
  const method = c.method as Method;
  const unit = c.unit ? parseUnit(c.unit) : undefined;
  if (c.unit && !unit) return { issue: { code: "INVALID_UNIT", severity: "error", nodeId: id, message: `"${c.name}": unknown unit "${c.unit}".` } };
  if (method === "PERCENT_OF_BASE") {
    const b = PERCENT_BASES.find((x) => x.id === c.base);
    if (!b) return { issue: { code: "MISSING_BASE", severity: "error", nodeId: id, message: `"${c.name}": choose what the percentage applies to.` } };
    if (b.category === c.category) return bad(`"${c.name}": a ${c.category.toLowerCase()} line cannot be a percentage of its own category.`);
  }
  return {
    component: {
      id, name: c.name, category: c.category as Category, ledger: "COST", method, rate: c.rate, fixed: c.fixed ?? undefined,
      unit: unit ?? METHOD_UNIT[method], base: method === "PERCENT_OF_BASE" ? c.base ?? undefined : undefined, enabled: c.enabled, source: "line",
    },
  };
}

/** Line templates of the profiles an item selected become cost lines of that item (ids are stable: prof:<profile>:<key>). */
export function profileLines(item: ItemRow, profiles: RateProfileRow[]): ComponentRow[] {
  const refs = new Set(Object.values(item.profileRefs ?? {}));
  const out: ComponentRow[] = [];
  for (const p of profiles) {
    if (!refs.has(p.id)) continue;
    for (const c of p.components) {
      if (!c.key.startsWith("line.") || !c.category || !c.method) continue;
      out.push({ id: `${p.id}:${c.key}`, category: c.category, name: `${c.name ?? c.key}${p.name ? ` (${p.name})` : ""}`, method: c.method, rate: c.rate, fixed: c.fixed, unit: c.unit, base: c.base, enabled: c.enabled });
    }
  }
  return out;
}

export interface ItemCalc {
  itemId: string;
  profile: CalcProfileId;
  result: PricingResult;
  totalWeightKg: number | null;
  issues: Issue[];
}

export function isCalcProfile(x: string | null | undefined): x is CalcProfileId {
  return !!x && Object.prototype.hasOwnProperty.call(CALC_PROFILES, x);
}

export function calcItem(item: ItemRow, sheetProfile: string, profiles: RateProfileRow[]): ItemCalc {
  const preIssues: Issue[] = [];
  const pid = isCalcProfile(item.calcProfile) ? item.calcProfile : isCalcProfile(sheetProfile) ? sheetProfile : "STANDARD";
  const dq = deriveQuantities({ qty: item.qty, unit: item.unit, unitWeightKg: item.unitWeightKg ?? undefined });
  const empty = (issues: Issue[]): ItemCalc => ({
    itemId: item.id, profile: pid, totalWeightKg: null, issues,
    result: { ok: false, values: {}, trace: {}, order: [], issues, summary: null },
  });
  if (!dq.quantities || !dq.unit) return empty(dq.issues);
  preIssues.push(...dq.issues);

  const components: Component[] = [];
  for (const m of item.materials) { const r = materialComponent(m); if (r.component) components.push(r.component); else preIssues.push(r.issue!); }
  for (const c of [...item.components, ...profileLines(item, profiles)]) { const r = lineComponent(c); if (r.component) components.push(r.component); else preIssues.push(r.issue!); }
  if (preIssues.some((i) => i.severity === "error" && i.code !== "ZERO_WEIGHT")) return empty(preIssues);

  const result = priceItem({ quantities: dq.quantities, divisorQty: item.qty, profile: pid, components, layers: buildLayers(item, profiles) });
  const issues = [...preIssues, ...result.issues];
  return { itemId: item.id, profile: pid, result: { ...result, issues }, totalWeightKg: dq.quantities.weightKg ?? null, issues };
}

export interface SheetTotals { directCost: number; indirectCost: number; totalCost: number; salePrice: number; profit: number; profitPct: number; priced: number; failed: number; }

/** Sheet totals are summed from unrounded item results; items with errors are counted but contribute nothing. */
export function sheetTotals(calcs: ItemCalc[]): SheetTotals {
  const t: SheetTotals = { directCost: 0, indirectCost: 0, totalCost: 0, salePrice: 0, profit: 0, profitPct: 0, priced: 0, failed: 0 };
  for (const c of calcs) {
    const s = c.result.summary;
    if (!s) { t.failed++; continue; }
    t.priced++;
    t.directCost += s.directCost; t.indirectCost += s.indirectCost; t.totalCost += s.totalCost; t.salePrice += s.salePrice; t.profit += s.profit;
  }
  t.profitPct = t.totalCost > 0 ? t.profit / t.totalCost : 0;
  return t;
}

/** Re-import safety: returns only the lines whose importedRef is not already on the item (and not repeated in the batch). */
export function dedupeImported<T extends { importedRef: string }>(existingRefs: Iterable<string | null | undefined>, incoming: T[]): T[] {
  const seen = new Set<string>();
  for (const r of existingRefs) if (r) seen.add(r);
  const out: T[] = [];
  for (const l of incoming) { if (seen.has(l.importedRef)) continue; seen.add(l.importedRef); out.push(l); }
  return out;
}
