// Scrap Management — pure calculation engine (no I/O, safe to import on the client so the page
// can recalculate instantly while the user edits a price or a percentage).
//
// Material flow for ONE source (material + thickness + stock-sheet size):
//
//   Bought  = Used (in parts) + Primary Scrap (what the nesting leaves over)
//   Primary Scrap = Used Later (kept as remnants, re-used)  +  Sold Scrap (sold as scrap)
//
// Money:
//   Buy cost        = Bought kg x Cost/kg
//   Used cost       = Used kg   x Cost/kg
//   Recovered value = Used-later kg x Used-later price  +  Sold kg x Scrap sell price
//   Net scrap loss  = Buy cost - Used cost - Recovered value      (what the scrap really costs the project)
//   Effective cost/kg = (Used cost + Net scrap loss) / Used kg    (the price per kg to hand to Pricing)

export interface ScrapRowInput {
  key: string;
  label: string;
  material: string;
  thicknessMm: number;
  widthMm: number;
  lengthMm: number;

  // From the nesting result (read-only on the page)
  usedAreaSqm: number;
  usedWeightKg: number;
  buyQty: number;
  buyAreaSqm: number;
  buyWeightKg: number;

  // Entered by the user, per row
  costPerKg: number;
  usedLaterPct: number; // 0..1 — share of the primary scrap that is kept and re-used
  usedLaterPriceLEPerKg: number;
  scrapSellPriceLEPerKg: number;
}

export interface ScrapRowResult extends ScrapRowInput {
  /** Used kg > bought kg: the purchase quantity is too low for the nesting. */
  shortage: boolean;
  shortageKg: number;

  primaryScrapKg: number; // max(0, buy - used)
  primaryScrapPct: number; // of bought weight
  usedLaterKg: number;
  soldScrapKg: number;
  /** Share of the bought weight that ends up sold as scrap (after re-use). */
  wastePct: number;

  buyCostLE: number;
  usedCostLE: number;
  usedLaterCostLE: number; // cost basis of the kept remnants
  usedLaterValueLE: number; // what they are worth when re-used
  soldScrapCostLE: number; // cost basis of the sold scrap
  soldScrapValueLE: number; // what the sale brings
  recoveredLE: number; // usedLaterValue + soldScrapValue
  netScrapLossLE: number;
  /** Financial scrap % = net loss / buy cost. */
  financialScrapPct: number;
  effectiveCostPerKg: number;
}

export interface ScrapTotals {
  usedAreaSqm: number;
  usedWeightKg: number;
  buyAreaSqm: number;
  buyWeightKg: number;
  primaryScrapKg: number;
  usedLaterKg: number;
  soldScrapKg: number;
  buyCostLE: number;
  usedCostLE: number;
  recoveredLE: number;
  usedLaterValueLE: number;
  soldScrapValueLE: number;
  netScrapLossLE: number;
  primaryScrapPct: number;
  wastePct: number;
  financialScrapPct: number;
  /** Net loss as a share of the used cost (the "% from used material" figure of the old sheet). */
  lossPctOfUsedCost: number;
  avgCostPerKg: number;
  effectiveCostPerKg: number;
  shortageRows: number;
}

const div = (a: number, b: number) => (b === 0 || !isFinite(b) ? 0 : a / b);
const clamp01 = (n: number) => Math.min(1, Math.max(0, isFinite(n) ? n : 0));

export function calculateScrapRow(input: ScrapRowInput): ScrapRowResult {
  const { buyWeightKg, usedWeightKg, costPerKg } = input;
  const usedLaterPct = clamp01(input.usedLaterPct);

  const shortageKg = Math.max(0, usedWeightKg - buyWeightKg);
  const primaryScrapKg = Math.max(0, buyWeightKg - usedWeightKg);
  const usedLaterKg = primaryScrapKg * usedLaterPct;
  const soldScrapKg = primaryScrapKg - usedLaterKg;

  const buyCostLE = buyWeightKg * costPerKg;
  const usedCostLE = usedWeightKg * costPerKg;
  const usedLaterCostLE = usedLaterKg * costPerKg;
  const usedLaterValueLE = usedLaterKg * input.usedLaterPriceLEPerKg;
  const soldScrapCostLE = soldScrapKg * costPerKg;
  const soldScrapValueLE = soldScrapKg * input.scrapSellPriceLEPerKg;
  const recoveredLE = usedLaterValueLE + soldScrapValueLE;
  const netScrapLossLE = usedLaterCostLE + soldScrapCostLE - recoveredLE;

  return {
    ...input,
    usedLaterPct,
    shortage: shortageKg > 1e-9,
    shortageKg,
    primaryScrapKg,
    primaryScrapPct: div(primaryScrapKg, buyWeightKg),
    usedLaterKg,
    soldScrapKg,
    wastePct: div(soldScrapKg, buyWeightKg),
    buyCostLE,
    usedCostLE,
    usedLaterCostLE,
    usedLaterValueLE,
    soldScrapCostLE,
    soldScrapValueLE,
    recoveredLE,
    netScrapLossLE,
    financialScrapPct: div(netScrapLossLE, buyCostLE),
    effectiveCostPerKg: usedWeightKg > 0 ? div(usedCostLE + netScrapLossLE, usedWeightKg) : costPerKg,
  };
}

/** Sum-based totals — percentages are always ratios of sums, never an average of row percentages. */
export function calculateScrapTotals(rows: ScrapRowResult[]): ScrapTotals {
  const sum = (f: (r: ScrapRowResult) => number) => rows.reduce((s, r) => s + f(r), 0);
  const usedWeightKg = sum((r) => r.usedWeightKg);
  const buyWeightKg = sum((r) => r.buyWeightKg);
  const primaryScrapKg = sum((r) => r.primaryScrapKg);
  const soldScrapKg = sum((r) => r.soldScrapKg);
  const buyCostLE = sum((r) => r.buyCostLE);
  const usedCostLE = sum((r) => r.usedCostLE);
  const netScrapLossLE = sum((r) => r.netScrapLossLE);

  return {
    usedAreaSqm: sum((r) => r.usedAreaSqm),
    usedWeightKg,
    buyAreaSqm: sum((r) => r.buyAreaSqm),
    buyWeightKg,
    primaryScrapKg,
    usedLaterKg: sum((r) => r.usedLaterKg),
    soldScrapKg,
    buyCostLE,
    usedCostLE,
    recoveredLE: sum((r) => r.recoveredLE),
    usedLaterValueLE: sum((r) => r.usedLaterValueLE),
    soldScrapValueLE: sum((r) => r.soldScrapValueLE),
    netScrapLossLE,
    primaryScrapPct: div(primaryScrapKg, buyWeightKg),
    wastePct: div(soldScrapKg, buyWeightKg),
    financialScrapPct: div(netScrapLossLE, buyCostLE),
    lossPctOfUsedCost: div(netScrapLossLE, usedCostLE),
    avgCostPerKg: div(usedCostLE, usedWeightKg),
    effectiveCostPerKg: div(usedCostLE + netScrapLossLE, usedWeightKg),
    shortageRows: rows.filter((r) => r.shortage).length,
  };
}

export interface ScrapScenario {
  usedLaterPct: number;
  totals: ScrapTotals;
}

/** "What if" — the same inputs, but every row keeps `pct` of its primary scrap. */
export function calculateScrapScenarios(inputs: ScrapRowInput[], pcts: number[]): ScrapScenario[] {
  return pcts.map((usedLaterPct) => ({
    usedLaterPct,
    totals: calculateScrapTotals(inputs.map((i) => calculateScrapRow({ ...i, usedLaterPct }))),
  }));
}
