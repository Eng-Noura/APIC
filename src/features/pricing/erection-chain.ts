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
 * Known workbook inconsistencies NOT reproduced here (need an owner decision):
 *  - rows 19–24 compute mob/demob on AQ and count it twice in AU+AV;
 *  - equipment rows (25+) divide by 0.97 then 0.9505 and skip the 3.8% tax.
 */
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
  const linesTotal = i.lines.reduce((s, l) => s + l.basis * l.rate, 0);
  const heightFactorAmount = linesTotal * i.heightFactor;
  const installDirect = linesTotal + heightFactorAmount;
  const installIndirect = installDirect * i.installIndirect;
  const installSale = (installDirect + installIndirect) * i.installMarkup;
  const supplyCost = i.supplyCost ?? 0;
  const supplyAndInstall = (i.supplySale ?? 0) + installSale;
  const engineering = supplyAndInstall * (i.engineering ?? 0);
  const thirdParty = supplyAndInstall * (i.thirdParty ?? 0);
  const commissioning = i.commissioning ?? 0;
  const subtotalBeforeMob = supplyAndInstall + commissioning + engineering + thirdParty;
  const mobDemob = subtotalBeforeMob * (i.mobDemob ?? 0);
  const totalBeforeInsurance = subtotalBeforeMob + mobDemob;
  const insured = totalBeforeInsurance / i.insuranceDivisor;
  const insurance = insured - totalBeforeInsurance;
  const tax = insured * i.tax;
  const salePrice = insured + tax;
  const totalCost =
    supplyCost + installDirect + installIndirect + commissioning + mobDemob + engineering + thirdParty + insurance + tax;
  const profit = salePrice - totalCost;
  return {
    linesTotal, heightFactorAmount, installDirect, installIndirect, installSale, supplyAndInstall,
    engineering, thirdParty, commissioning, subtotalBeforeMob, mobDemob, totalBeforeInsurance,
    insurance, tax, salePrice,
    unitRate: i.weight > 0 ? salePrice / i.weight : 0,
    totalCost, profit, profitPct: totalCost > 0 ? profit / totalCost : 0,
  };
}
