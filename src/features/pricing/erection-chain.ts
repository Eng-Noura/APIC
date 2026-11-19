/**
 * Erection price chain — mirrors the "BOQ - Full" sheet of `Cost_Estimation-1.xlsx`
 * (Alex Fort Worth / Misr Cement Minya), item 1 (Erection – Steel Structure, 250 t).
 *
 * Pure TypeScript: no DB, no React, no rounding. Callers round only for display
 * (the workbook never rounds either), so results match Excel to floating-point precision.
 *
 * Order (workbook columns in brackets):
 *   installation lines (AD–AL) → + height factor on their sum (AM) → Direct (AN)
 *   → + indirect on Direct (AO) → × markup (AP) → + supply sale price (AQ)
 *   → + engineering / third-party on AQ (AR, AS) + commissioning (AT) → AU
 *   → + mob/demob on AU (AV) → AW
 *   → ÷ insurance divisor (AX) → + tax on AX (AY) → Sale price (AZ)
 *   Cost (BB) = supply cost + Direct + indirect + commissioning + mob + engineering
 *               + third-party + insurance + tax;  Profit (BC) = AZ − BB.
 *
 * This file is now a thin adapter over the component engine (`./engine`): the formulas live ONLY there.
 *
 * Known workbook inconsistencies NOT reproduced here (need an owner decision):
 *  - rows 19–24 compute mob/demob on AQ and count it twice in AU+AV;
 *  - equipment rows (25+) divide by 0.97 then 0.9505 and skip the 3.8% tax.
 */
import { N, RATE_KEYS, priceItem } from "./engine";
import type { Component } from "./engine";

export interface ChainLine {
  key: string;
  /** Quantity basis (e.g. tons). */
  basis: number;
  /** Rate per basis unit. */
  rate: number;
}

export interface ChainInput {
  /** Quantity used to turn the sale price into a unit rate (workbook: Weight Ton, J). */
  weight: number;
  /** Direct installation lines (AD–AL). Amount = basis × rate. */
  lines: ChainLine[];
  /** Height factor, fraction of the lines' sum (AM13 = 0.05). */
  heightFactor: number;
  /** Installation indirect, fraction of Direct (AO15 = 0.04). */
  installIndirect: number;
  /** Installation markup multiplier (AP15 = 1.255). */
  installMarkup: number;
  /** Supply & fabrication cost (W+X+Z+AA) and supply sale price (Y). 0 for erection-only. */
  supplyCost?: number;
  supplySale?: number;
  engineering?: number; // fraction of AQ (AR15)
  thirdParty?: number; // fraction of AQ (AS15 = 0.01)
  commissioning?: number; // lump sum (AT)
  mobDemob?: number; // fraction of AU (AV15 = 0.10)
  /** Social insurance divisor (AX15 = 0.9505). */
  insuranceDivisor: number;
  /** Tax, fraction of the insured price (AY15 = 0.038). */
  tax: number;
}

export interface ChainResult {
  linesTotal: number;
  heightFactorAmount: number;
  installDirect: number;
  installIndirect: number;
  installSale: number;
  supplyAndInstall: number;
  engineering: number;
  thirdParty: number;
  commissioning: number;
  subtotalBeforeMob: number;
  mobDemob: number;
  totalBeforeInsurance: number;
  insurance: number;
  tax: number;
  salePrice: number;
  unitRate: number;
  totalCost: number;
  profit: number;
  profitPct: number;
}

export function calcErectionChain(i: ChainInput): ChainResult {
  const components: Component[] = i.lines.map((l) => ({
    id: `line.${l.key}`, name: l.key, category: "INSTALLATION", ledger: "COST", method: "FIXED_LUMP_SUM",
    rate: l.basis * l.rate, enabled: true, source: "erection-chain",
  }));
  const r = priceItem({
    quantities: { weightTon: i.weight },
    divisorQty: i.weight,
    profile: "STANDARD",
    components,
    externalSupply: { cost: i.supplyCost ?? 0, sale: i.supplySale ?? 0 },
    layers: {
      global: {
        [RATE_KEYS.installHeightFactorPct]: i.heightFactor,
        [RATE_KEYS.installIndirectPct]: i.installIndirect,
        [RATE_KEYS.markupInstallation]: i.installMarkup,
        [RATE_KEYS.engineeringPct]: i.engineering ?? 0,
        [RATE_KEYS.thirdPartyPct]: i.thirdParty ?? 0,
        [RATE_KEYS.commissioningLump]: i.commissioning ?? 0,
        [RATE_KEYS.mobDemobPct]: i.mobDemob ?? 0,
        [RATE_KEYS.insuranceDivisor]: i.insuranceDivisor,
        [RATE_KEYS.taxPct]: i.tax,
      },
    },
  });
  if (!r.ok) throw new Error(`Erection chain failed: ${r.issues.filter((x) => x.severity === "error").map((x) => x.message).join(" ")}`);
  const v = r.values;
  return {
    linesTotal: v[N.INSTALL_LINES_SUM], heightFactorAmount: v[N.HEIGHT_FACTOR], installDirect: v[N.INSTALL_DIRECT],
    installIndirect: v[N.INSTALL_INDIRECT], installSale: v[N.INSTALL_SALE], supplyAndInstall: v[N.SUPPLY_AND_INSTALL],
    engineering: v[N.ENGINEERING], thirdParty: v[N.THIRD_PARTY], commissioning: v[N.COMMISSIONING],
    subtotalBeforeMob: v[N.SUBTOTAL], mobDemob: v[N.MOB_DEMOB], totalBeforeInsurance: v[N.TOTAL_BEFORE_INSURANCE],
    insurance: v[N.INSURANCE_TOTAL], tax: v[N.TAX], salePrice: v[N.SALE_PRICE], unitRate: v[N.UNIT_RATE],
    totalCost: v[N.TOTAL_COST], profit: v[N.PROFIT], profitPct: v[N.PROFIT_PCT],
  };
}
