import { evaluateGraph } from "./graph";
import { resolveRate } from "./rates";
import type { Category, Component, DerivedNode, GraphResult, Issue, Ledger, Method, NodeSpec, Quantities, RateLayers } from "./types";

/** Stable keys for the chain-level rates. Rate Profiles (Phase B/D) store values under these keys. */
export const RATE_KEYS = {
  fabricationIndirectPct: "fabrication.indirectPct",
  subcontractorIndirectPct: "subcontractor.indirectPct",
  installHeightFactorPct: "installation.heightFactorPct",
  installIndirectPct: "installation.indirectPct",
  markupMaterial: "markup.material",
  markupFabrication: "markup.fabrication",
  markupSubcontractor: "markup.subcontractor",
  markupInstallation: "markup.installation",
  markupAddOn: "markup.addOn",
  engineeringPct: "sale.engineeringPct",
  thirdPartyPct: "sale.thirdPartyPct",
  commissioningLump: "sale.commissioningLump",
  commissioningPct: "sale.commissioningPct",
  mobDemobPct: "sale.mobDemobPct",
  insuranceDivisor: "sale.insuranceDivisor",
  extraDivisor: "sale.extraDivisor",
  taxPct: "sale.taxPct",
} as const;

/** Well-known node ids (the Summary tab and the tests address results through these). */
export const N = {
  MATERIAL_COST: "MATERIAL_COST",
  FAB_DIRECT: "FAB_DIRECT", FAB_INDIRECT: "FAB_INDIRECT",
  SUB_DIRECT: "SUB_DIRECT", SUB_INDIRECT: "SUB_INDIRECT",
  ADDON_DIRECT: "ADDON_DIRECT",
  INSTALL_LINES_SUM: "INSTALL_LINES_SUM", HEIGHT_FACTOR: "HEIGHT_FACTOR",
  INSTALL_DIRECT: "INSTALL_DIRECT", INSTALL_INDIRECT: "INSTALL_INDIRECT",
  EXTERNAL_SUPPLY_COST: "EXTERNAL_SUPPLY_COST", EXTERNAL_SUPPLY_SALE: "EXTERNAL_SUPPLY_SALE",
  DIRECT_COST: "DIRECT_COST", INDIRECT_COST: "INDIRECT_COST",
  MATERIAL_SALE: "MATERIAL_SALE", FAB_SALE: "FAB_SALE", SUB_SALE: "SUB_SALE", INSTALL_SALE: "INSTALL_SALE", ADDON_SALE: "ADDON_SALE",
  SUPPLY_SALE: "SUPPLY_SALE", SUPPLY_AND_INSTALL: "SUPPLY_AND_INSTALL",
  ENGINEERING: "ENGINEERING", THIRD_PARTY: "THIRD_PARTY", COMMISSIONING: "COMMISSIONING",
  SUBTOTAL: "SUBTOTAL", MOB_DEMOB: "MOB_DEMOB", TOTAL_BEFORE_INSURANCE: "TOTAL_BEFORE_INSURANCE",
  EXTRA_DIVISOR: "EXTRA_DIVISOR", INSURANCE_BASE: "INSURANCE_BASE", INSURANCE: "INSURANCE", INSURANCE_TOTAL: "INSURANCE_TOTAL",
  INSURED_PRICE: "INSURED_PRICE", TAX: "TAX", SALE_PRICE: "SALE_PRICE", UNIT_RATE: "UNIT_RATE", RATE_PER_TON: "RATE_PER_TON",
  TOTAL_COST: "TOTAL_COST", PROFIT: "PROFIT", PROFIT_PCT: "PROFIT_PCT",
} as const;

export type CalcProfileId = "STANDARD" | "LEGACY_MOB_DOUBLE_COUNT" | "LEGACY_EQUIPMENT";

export interface CalcProfile {
  id: CalcProfileId;
  label: string;
  description: string;
  /** Height factor is part of Installation Direct. */
  heightInDirect: boolean;
  /** Mob/Demob is a % of the subtotal, or of Supply & Install sale. */
  mobBase: "SUBTOTAL" | "SUPPLY_AND_INSTALL";
  /** Mob/Demob already sits inside SUBTOTAL (legacy). */
  mobInSubtotal: boolean;
  commissioning: { mode: "LUMP" | "PERCENT_OF_SUBTOTAL"; inCost: boolean };
  /** What is added to SUBTOTAL to get the price before insurance. */
  totalBeforeInsuranceAdds: "MOB_DEMOB" | "COMMISSIONING";
  /** Second divisor applied before the insurance divisor (legacy equipment). */
  extraDivisor: boolean;
  applyTax: boolean;
}

export const CALC_PROFILES: Record<CalcProfileId, CalcProfile> = {
  STANDARD: {
    id: "STANDARD",
    label: "Standard chain",
    description: "Mob/Demob on the subtotal (commissioning included), insurance as a divisor, then tax on the insured price.",
    heightInDirect: true, mobBase: "SUBTOTAL", mobInSubtotal: false,
    commissioning: { mode: "LUMP", inCost: true },
    totalBeforeInsuranceAdds: "MOB_DEMOB", extraDivisor: false, applyTax: true,
  },
  LEGACY_MOB_DOUBLE_COUNT: {
    id: "LEGACY_MOB_DOUBLE_COUNT",
    label: "Legacy workbook — Mob/Demob counted twice",
    description: "Reproduces the older workbook rows literally: Mob/Demob on Supply & Install sale, already inside the subtotal and added again; commissioning is a % of subtotal that is in cost but not in price; height factor not in Direct.",
    heightInDirect: false, mobBase: "SUPPLY_AND_INSTALL", mobInSubtotal: true,
    commissioning: { mode: "PERCENT_OF_SUBTOTAL", inCost: true },
    totalBeforeInsuranceAdds: "MOB_DEMOB", extraDivisor: false, applyTax: true,
  },
  LEGACY_EQUIPMENT: {
    id: "LEGACY_EQUIPMENT",
    label: "Legacy workbook — equipment",
    description: "Reproduces the equipment rows literally: Mob/Demob once, commissioning in price but not in cost, a second divisor then the insurance divisor, no tax.",
    heightInDirect: true, mobBase: "SUPPLY_AND_INSTALL", mobInSubtotal: true,
    commissioning: { mode: "PERCENT_OF_SUBTOTAL", inCost: false },
    totalBeforeInsuranceAdds: "COMMISSIONING", extraDivisor: true, applyTax: false,
  },
};

export interface PricingItemInput {
  quantities: Quantities;
  /** Quantity (in the item's own unit) that turns the sale price into the Unit Rate. */
  divisorQty: number;
  profile: CalcProfileId;
  /** Line components: category MATERIAL / FABRICATION / SUBCONTRACTOR / INSTALLATION / ADD_ON, ledger COST. */
  components: Component[];
  layers: RateLayers;
  /** Supply cost/sale computed elsewhere (e.g. a supply-only sheet). Added as-is. */
  externalSupply?: { cost: number; sale: number };
}

export interface PricingSummary {
  materialCost: number; fabricationDirect: number; subcontractorDirect: number;
  installationDirect: number; addOnsDirect: number;
  directCost: number; indirectCost: number; totalCost: number;
  salePrice: number; unitRate: number; ratePerTon: number | null;
  profit: number; profitPct: number;
}
export interface PricingResult extends GraphResult {
  summary: PricingSummary | null;
}

const derived = (id: string, label: string, ledger: Ledger, deps: string[], formula: string, fn: (v: Record<string, number>) => number, category?: Category): NodeSpec =>
  ({ kind: "derived", id, label, ledger, deps, formula, fn, category } satisfies DerivedNode & { kind: "derived" });
const sum = (ids: string[]) => (v: Record<string, number>) => ids.reduce((s, id) => s + v[id], 0);

/**
 * Builds the node graph for one item. ONE place per formula: every profile is this builder with different switches.
 * Returns the specs plus build-time issues (optional rates that were missing are DISABLED with a visible warning).
 */
export function buildPricingGraph(input: PricingItemInput): { specs: NodeSpec[]; issues: Issue[] } {
  const p = CALC_PROFILES[input.profile];
  const issues: Issue[] = [];
  const specs: NodeSpec[] = [];
  const L = input.layers;
  const lines = (cat: Category) => input.components.filter((c) => c.category === cat);
  const active = (cat: Category) => lines(cat).some((c) => c.enabled);

  /** A chain component. `required` ⇒ a missing rate is an error; optional ⇒ disabled + warning. */
  const chain = (id: string, name: string, category: Category, ledger: Ledger, method: Method, rateKey: string, opts: { base?: string; on?: boolean; required?: boolean }) => {
    let enabled = opts.on ?? true;
    if (enabled && !opts.required && !resolveRate(rateKey, L)) {
      enabled = false;
      issues.push({ code: "OPTIONAL_RATE_MISSING", severity: "warning", nodeId: id, message: `"${name}" has no rate ("${rateKey}") — treated as not applied, not as 0%.` });
    }
    specs.push({ kind: "component", component: { id, name, category, ledger, method, rateKey, base: opts.base, enabled, source: input.profile } });
  };

  for (const c of input.components) specs.push({ kind: "component", component: c });

  // ---- direct cost by category
  const catSum = (id: string, label: string, cat: Category) =>
    specs.push(derived(id, label, "COST", lines(cat).map((c) => c.id), lines(cat).length ? `Σ ${cat.toLowerCase()} lines` : "no lines", sum(lines(cat).map((c) => c.id)), cat));
  catSum(N.MATERIAL_COST, "Material cost", "MATERIAL");
  catSum(N.FAB_DIRECT, "Fabrication direct", "FABRICATION");
  catSum(N.SUB_DIRECT, "Subcontractor direct", "SUBCONTRACTOR");
  catSum(N.ADDON_DIRECT, "Add-ons", "ADD_ON");
  catSum(N.INSTALL_LINES_SUM, "Installation lines", "INSTALLATION");

  const hasFab = active("FABRICATION"), hasSub = active("SUBCONTRACTOR"), hasInst = active("INSTALLATION");
  chain(N.FAB_INDIRECT, "Fabrication indirect", "INDIRECT", "INDIRECT", "PERCENT_OF_BASE", RATE_KEYS.fabricationIndirectPct, { base: N.FAB_DIRECT, on: hasFab, required: true });
  chain(N.SUB_INDIRECT, "Subcontractor indirect", "INDIRECT", "INDIRECT", "PERCENT_OF_BASE", RATE_KEYS.subcontractorIndirectPct, { base: N.SUB_DIRECT, on: hasSub, required: true });
  chain(N.HEIGHT_FACTOR, "Height factor", "INSTALLATION", "COST", "PERCENT_OF_BASE", RATE_KEYS.installHeightFactorPct, { base: N.INSTALL_LINES_SUM, on: hasInst });
  specs.push(derived(N.INSTALL_DIRECT, "Installation direct", "COST",
    p.heightInDirect ? [N.INSTALL_LINES_SUM, N.HEIGHT_FACTOR] : [N.INSTALL_LINES_SUM],
    p.heightInDirect ? "lines + height factor" : "lines (height factor not included)",
    p.heightInDirect ? sum([N.INSTALL_LINES_SUM, N.HEIGHT_FACTOR]) : (v) => v[N.INSTALL_LINES_SUM], "INSTALLATION"));
  chain(N.INSTALL_INDIRECT, "Installation indirect", "INDIRECT", "INDIRECT", "PERCENT_OF_BASE", RATE_KEYS.installIndirectPct, { base: N.INSTALL_DIRECT, on: hasInst, required: true });

  if (input.externalSupply) {
    const ex = input.externalSupply;
    specs.push(derived(N.EXTERNAL_SUPPLY_COST, "Supply cost (external)", "COST", [], "supplied", () => ex.cost, "MATERIAL"));
    specs.push(derived(N.EXTERNAL_SUPPLY_SALE, "Supply sale (external)", "SALE", [], "supplied", () => ex.sale, "SALE"));
  }
  const extCost = input.externalSupply ? [N.EXTERNAL_SUPPLY_COST] : [];
  specs.push(derived(N.DIRECT_COST, "Direct cost", "COST", [N.MATERIAL_COST, N.FAB_DIRECT, N.SUB_DIRECT, N.INSTALL_DIRECT, N.ADDON_DIRECT, ...extCost], "material + fabrication + subcontractor + installation + add-ons", sum([N.MATERIAL_COST, N.FAB_DIRECT, N.SUB_DIRECT, N.INSTALL_DIRECT, N.ADDON_DIRECT, ...extCost])));
  specs.push(derived(N.INDIRECT_COST, "Indirect cost", "INDIRECT", [N.FAB_INDIRECT, N.SUB_INDIRECT, N.INSTALL_INDIRECT], "fabrication + subcontractor + installation indirect", sum([N.FAB_INDIRECT, N.SUB_INDIRECT, N.INSTALL_INDIRECT])));

  // ---- cost -> price through category markups (the ONLY place cost becomes price)
  const costWithIndirect = (id: string, label: string, direct: string, indirect: string) =>
    specs.push(derived(id, label, "INDIRECT", [direct, indirect], `${direct} + ${indirect}`, sum([direct, indirect])));
  costWithIndirect("FAB_COST_WITH_INDIRECT", "Fabrication cost incl. indirect", N.FAB_DIRECT, N.FAB_INDIRECT);
  costWithIndirect("SUB_COST_WITH_INDIRECT", "Subcontractor cost incl. indirect", N.SUB_DIRECT, N.SUB_INDIRECT);
  costWithIndirect("INSTALL_COST_WITH_INDIRECT", "Installation cost incl. indirect", N.INSTALL_DIRECT, N.INSTALL_INDIRECT);
  chain(N.MATERIAL_SALE, "Material sale", "SALE", "SALE", "MARKUP", RATE_KEYS.markupMaterial, { base: N.MATERIAL_COST, on: active("MATERIAL"), required: true });
  chain(N.FAB_SALE, "Fabrication sale", "SALE", "SALE", "MARKUP", RATE_KEYS.markupFabrication, { base: "FAB_COST_WITH_INDIRECT", on: hasFab, required: true });
  chain(N.SUB_SALE, "Subcontractor sale", "SALE", "SALE", "MARKUP", RATE_KEYS.markupSubcontractor, { base: "SUB_COST_WITH_INDIRECT", on: hasSub, required: true });
  chain(N.INSTALL_SALE, "Installation sale", "SALE", "SALE", "MARKUP", RATE_KEYS.markupInstallation, { base: "INSTALL_COST_WITH_INDIRECT", on: hasInst, required: true });
  chain(N.ADDON_SALE, "Add-ons sale", "SALE", "SALE", "MARKUP", RATE_KEYS.markupAddOn, { base: N.ADDON_DIRECT, on: active("ADD_ON"), required: true });
  const supplyParts = [N.MATERIAL_SALE, N.FAB_SALE, N.SUB_SALE, N.ADDON_SALE, ...(input.externalSupply ? [N.EXTERNAL_SUPPLY_SALE] : [])];
  specs.push(derived(N.SUPPLY_SALE, "Supply, fabrication & other sale", "SALE", supplyParts, "material + fabrication + subcontractor + add-ons sale", sum(supplyParts)));
  specs.push(derived(N.SUPPLY_AND_INSTALL, "Supply & install sale", "SALE", [N.SUPPLY_SALE, N.INSTALL_SALE], "supply sale + installation sale", sum([N.SUPPLY_SALE, N.INSTALL_SALE])));

  // ---- sale-side additions
  chain(N.ENGINEERING, "Engineering", "SALE", "SALE", "PERCENT_OF_BASE", RATE_KEYS.engineeringPct, { base: N.SUPPLY_AND_INSTALL });
  chain(N.THIRD_PARTY, "Third-party certificate", "SALE", "SALE", "PERCENT_OF_BASE", RATE_KEYS.thirdPartyPct, { base: N.SUPPLY_AND_INSTALL });
  const standard = p.commissioning.mode === "LUMP";
  const mobBase = p.mobBase === "SUBTOTAL" ? N.SUBTOTAL : N.SUPPLY_AND_INSTALL;
  if (standard) {
    chain(N.COMMISSIONING, "Commissioning", "SALE", "SALE", "FIXED_LUMP_SUM", RATE_KEYS.commissioningLump, {});
    specs.push(derived(N.SUBTOTAL, "Subtotal before Mob/Demob", "SALE", [N.SUPPLY_AND_INSTALL, N.COMMISSIONING, N.ENGINEERING, N.THIRD_PARTY], "supply & install + commissioning + engineering + third party", sum([N.SUPPLY_AND_INSTALL, N.COMMISSIONING, N.ENGINEERING, N.THIRD_PARTY])));
    chain(N.MOB_DEMOB, "Mob / Demob", "SALE", "SALE", "PERCENT_OF_BASE", RATE_KEYS.mobDemobPct, { base: mobBase });
  } else {
    chain(N.MOB_DEMOB, "Mob / Demob", "SALE", "SALE", "PERCENT_OF_BASE", RATE_KEYS.mobDemobPct, { base: mobBase });
    specs.push(derived(N.SUBTOTAL, "Subtotal", "SALE", [N.SUPPLY_AND_INSTALL, N.MOB_DEMOB, N.ENGINEERING, N.THIRD_PARTY], "supply & install + Mob/Demob + engineering + third party", sum([N.SUPPLY_AND_INSTALL, N.MOB_DEMOB, N.ENGINEERING, N.THIRD_PARTY])));
    chain(N.COMMISSIONING, "Commissioning", "SALE", "SALE", "PERCENT_OF_BASE", RATE_KEYS.commissioningPct, { base: N.SUBTOTAL });
  }
  const adds = p.totalBeforeInsuranceAdds === "MOB_DEMOB" ? N.MOB_DEMOB : N.COMMISSIONING;
  specs.push(derived(N.TOTAL_BEFORE_INSURANCE, "Total before insurance", "SALE", [N.SUBTOTAL, adds], `subtotal + ${adds.toLowerCase().replace("_", "/")}`, sum([N.SUBTOTAL, adds])));

  // ---- insurance (divisor), optional second divisor, tax
  if (p.extraDivisor) {
    chain(N.EXTRA_DIVISOR, "Additional divisor", "SALE", "SALE", "DIVISOR", RATE_KEYS.extraDivisor, { base: N.TOTAL_BEFORE_INSURANCE, required: true });
    specs.push(derived(N.INSURANCE_BASE, "Price before insurance", "SALE", [N.TOTAL_BEFORE_INSURANCE, N.EXTRA_DIVISOR], "total + additional divisor increase", sum([N.TOTAL_BEFORE_INSURANCE, N.EXTRA_DIVISOR])));
  } else {
    specs.push(derived(N.INSURANCE_BASE, "Price before insurance", "SALE", [N.TOTAL_BEFORE_INSURANCE], "total before insurance", (v) => v[N.TOTAL_BEFORE_INSURANCE]));
  }
  chain(N.INSURANCE, "Social insurance", "SALE", "SALE", "DIVISOR", RATE_KEYS.insuranceDivisor, { base: N.INSURANCE_BASE, required: true });
  const insDeps = p.extraDivisor ? [N.INSURANCE, N.EXTRA_DIVISOR] : [N.INSURANCE];
  specs.push(derived(N.INSURANCE_TOTAL, "Insurance (total increase)", "SALE", insDeps, insDeps.join(" + ").toLowerCase(), sum(insDeps)));
  specs.push(derived(N.INSURED_PRICE, "Price after insurance", "SALE", [N.INSURANCE_BASE, N.INSURANCE], "price before insurance + insurance", sum([N.INSURANCE_BASE, N.INSURANCE])));
  chain(N.TAX, "Tax", "SALE", "SALE", "PERCENT_OF_BASE", RATE_KEYS.taxPct, { base: N.INSURED_PRICE, on: p.applyTax, required: true });
  specs.push(derived(N.SALE_PRICE, "Sale price", "SALE", [N.INSURED_PRICE, N.TAX], "price after insurance + tax", sum([N.INSURED_PRICE, N.TAX])));

  const dq = input.divisorQty;
  if (!(dq > 0)) issues.push({ code: "ZERO_QUANTITY", severity: "warning", nodeId: N.UNIT_RATE, message: "Quantity is 0: Unit Rate cannot be computed and is reported as 0." });
  specs.push(derived(N.UNIT_RATE, "Unit rate", "RESULT", [N.SALE_PRICE], "sale price ÷ quantity", (v) => (dq > 0 ? v[N.SALE_PRICE] / dq : 0)));
  const wt = input.quantities.weightTon;
  if (wt !== undefined) {
    if (!(wt > 0)) issues.push({ code: "ZERO_WEIGHT", severity: "warning", nodeId: N.RATE_PER_TON, message: "Weight is 0: rate per ton cannot be computed and is reported as 0." });
    specs.push(derived(N.RATE_PER_TON, "Rate per ton", "RESULT", [N.SALE_PRICE], "sale price ÷ weight (t)", (v) => (wt > 0 ? v[N.SALE_PRICE] / wt : 0)));
  }

  // ---- total cost, profit
  const costDeps = [N.DIRECT_COST, N.INDIRECT_COST, ...(p.commissioning.inCost ? [N.COMMISSIONING] : []), N.MOB_DEMOB, N.ENGINEERING, N.THIRD_PARTY, N.INSURANCE_TOTAL, N.TAX];
  specs.push(derived(N.TOTAL_COST, "Total cost", "TOTAL_COST", costDeps, "direct + indirect + " + costDeps.slice(2).join(" + ").toLowerCase(), sum(costDeps)));
  specs.push(derived(N.PROFIT, "Profit", "RESULT", [N.SALE_PRICE, N.TOTAL_COST], "sale price − total cost", (v) => v[N.SALE_PRICE] - v[N.TOTAL_COST]));
  specs.push(derived(N.PROFIT_PCT, "Profit %", "RESULT", [N.PROFIT, N.TOTAL_COST], "profit ÷ total cost (derived, not an input)", (v) => (v[N.TOTAL_COST] > 0 ? v[N.PROFIT] / v[N.TOTAL_COST] : 0)));
  return { specs, issues };
}

export function priceItem(input: PricingItemInput): PricingResult {
  const { specs, issues: buildIssues } = buildPricingGraph(input);
  const r = evaluateGraph(specs, { quantities: input.quantities, layers: input.layers });
  const issues = [...buildIssues, ...r.issues];
  if (r.ok && r.values[N.TOTAL_COST] === 0) issues.push({ code: "ZERO_COST", severity: "warning", nodeId: N.PROFIT_PCT, message: "Total cost is 0: Profit % is reported as 0." });
  const ok = r.ok;
  const v = r.values;
  return {
    ...r, issues, ok,
    summary: ok ? {
      materialCost: v[N.MATERIAL_COST], fabricationDirect: v[N.FAB_DIRECT], subcontractorDirect: v[N.SUB_DIRECT],
      installationDirect: v[N.INSTALL_DIRECT], addOnsDirect: v[N.ADDON_DIRECT],
      directCost: v[N.DIRECT_COST], indirectCost: v[N.INDIRECT_COST], totalCost: v[N.TOTAL_COST],
      salePrice: v[N.SALE_PRICE], unitRate: v[N.UNIT_RATE], ratePerTon: v[N.RATE_PER_TON] ?? null,
      profit: v[N.PROFIT], profitPct: v[N.PROFIT_PCT],
    } : null,
  };
}
