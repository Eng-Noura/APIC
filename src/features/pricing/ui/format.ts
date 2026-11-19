import { roundMoney, roundRate } from "../engine";

/** Display-only rounding (2 dp money, 4 dp rates in the engine policy; the grid shows 2 dp). */
export const money = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : roundMoney(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const rate4 = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : roundRate(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
export const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(2)}%`);
export const qty = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 3 });

export const SOURCE_LABEL: Record<string, string> = { NESTING: "Nesting", STOCK: "Stock", PROCUREMENT: "Procurement", MANUAL: "Manual" };
export const CATEGORY_LABEL: Record<string, string> = { FABRICATION: "Fabrication", SUBCONTRACTOR: "Subcontractor", INSTALLATION: "Installation", ADD_ON: "Add-ons" };
export const METHOD_LABEL: Record<string, string> = {
  PER_TON: "Per ton", PER_KG: "Per kg", PER_SQM: "Per m²", PER_METER: "Per meter", PER_UNIT: "Per unit",
  FIXED_LUMP_SUM: "Fixed amount", FIXED_PLUS_VARIABLE: "Fixed + variable", PERCENT_OF_BASE: "Percentage",
};
