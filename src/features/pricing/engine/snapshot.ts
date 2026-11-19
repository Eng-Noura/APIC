import { ROUNDING, roundFactor, roundMoney, roundRate } from "./rounding";
import { N, type PricingResult } from "./profiles";

/** Bump when a formula or rounding rule changes: snapshots record the engine that produced them. */
export const ENGINE_VERSION = "1.0.0";

export interface SnapshotItemMeta {
  pricingItemId?: string | null;
  scopeItemId?: string | null;
  itemNo: string;
  description: string;
  unit: string;
  qty: number;
}

export interface SnapshotItemData extends SnapshotItemMeta {
  unitRate: number; // 4 dp
  salePrice: number; // 2 dp
  totalCost: number;
  profit: number;
  profitPct: number; // 4 dp (fraction)
  /** Every node: rounded value + the rate layer it used. JSON-safe. */
  data: { values: Record<string, number>; rates: Record<string, { value: number; layer: string; key?: string }>; issues: { code: string; severity: string; message: string }[] };
}

export interface SnapshotPayload {
  kind: "CALCULATED" | "APPROVED";
  sheetVersion: number;
  engineVersion: string;
  roundingPolicy: typeof ROUNDING;
  ratesUsed: Record<string, Record<string, { value: number; layer: string }>>; // by item key → rate key → value
  inputs: unknown;
  totals: { directCost: number; indirectCost: number; totalCost: number; salePrice: number; profit: number; profitPct: number };
  items: SnapshotItemData[];
}

/** Rounding per node kind (policy: money 2 dp, rates 4 dp, factors 4 dp). */
function roundNode(id: string, v: number): number {
  if (id === N.PROFIT_PCT) return roundFactor(v);
  if (id === N.UNIT_RATE || id === N.RATE_PER_TON) return roundRate(v);
  return roundMoney(v);
}

export function buildSnapshotItem(meta: SnapshotItemMeta, r: PricingResult): SnapshotItemData {
  if (!r.ok || !r.summary) throw new Error(`Cannot snapshot "${meta.itemNo}": calculation has errors.`);
  const values: Record<string, number> = {};
  for (const [id, v] of Object.entries(r.values)) values[id] = roundNode(id, v);
  const rates: SnapshotItemData["data"]["rates"] = {};
  for (const t of Object.values(r.trace)) if (t.rate) rates[t.id] = { value: t.rate.value, layer: t.rate.layer, key: t.rate.key };
  const s = r.summary;
  return {
    ...meta,
    unitRate: roundRate(s.unitRate), salePrice: roundMoney(s.salePrice), totalCost: roundMoney(s.totalCost),
    profit: roundMoney(s.profit), profitPct: roundFactor(s.profitPct),
    data: { values, rates, issues: r.issues.map((i) => ({ code: i.code, severity: i.severity, message: i.message })) },
  };
}

/**
 * Builds the immutable payload to persist. Totals are summed from UNROUNDED results then rounded once,
 * so a sheet total never drifts from per-item rounding.
 */
export function buildSnapshot(
  entries: { meta: SnapshotItemMeta; result: PricingResult }[],
  opts: { kind: SnapshotPayload["kind"]; sheetVersion: number; inputs: unknown },
): SnapshotPayload {
  const items = entries.map((e) => buildSnapshotItem(e.meta, e.result));
  const sum = (f: (s: NonNullable<PricingResult["summary"]>) => number) => entries.reduce((a, e) => a + f(e.result.summary!), 0);
  const totalCost = sum((s) => s.totalCost), profit = sum((s) => s.profit);
  const ratesUsed: SnapshotPayload["ratesUsed"] = {};
  items.forEach((it, i) => {
    const k = it.pricingItemId ?? it.scopeItemId ?? `item-${i + 1}`;
    ratesUsed[k] = Object.fromEntries(Object.entries(it.data.rates).map(([id, r]) => [r.key ?? id, { value: r.value, layer: r.layer }]));
  });
  return {
    kind: opts.kind, sheetVersion: opts.sheetVersion, engineVersion: ENGINE_VERSION, roundingPolicy: { ...ROUNDING },
    ratesUsed, inputs: JSON.parse(JSON.stringify(opts.inputs)),
    totals: {
      directCost: roundMoney(sum((s) => s.directCost)), indirectCost: roundMoney(sum((s) => s.indirectCost)),
      totalCost: roundMoney(totalCost), salePrice: roundMoney(sum((s) => s.salePrice)), profit: roundMoney(profit),
      profitPct: roundFactor(totalCost > 0 ? profit / totalCost : 0),
    },
    items,
  };
}
