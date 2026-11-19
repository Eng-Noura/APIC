import { RATE_KEYS } from "./engine";

/** How each chain-level rate is entered and shown. Percentages are stored as fractions (0.05 = 5%). */
export type RateKind = "pct" | "mult" | "divisor" | "lump";
export const RATE_META: { key: string; label: string; kind: RateKind; group: string }[] = [
  { key: RATE_KEYS.fabricationIndirectPct, label: "Fabrication indirect", kind: "pct", group: "Indirect" },
  { key: RATE_KEYS.subcontractorIndirectPct, label: "Subcontractor indirect", kind: "pct", group: "Indirect" },
  { key: RATE_KEYS.installHeightFactorPct, label: "Height factor", kind: "pct", group: "Indirect" },
  { key: RATE_KEYS.installIndirectPct, label: "Installation indirect", kind: "pct", group: "Indirect" },
  { key: RATE_KEYS.markupMaterial, label: "Material markup", kind: "mult", group: "Profit (markup multipliers)" },
  { key: RATE_KEYS.markupFabrication, label: "Fabrication markup", kind: "mult", group: "Profit (markup multipliers)" },
  { key: RATE_KEYS.markupSubcontractor, label: "Subcontractor markup", kind: "mult", group: "Profit (markup multipliers)" },
  { key: RATE_KEYS.markupInstallation, label: "Installation markup", kind: "mult", group: "Profit (markup multipliers)" },
  { key: RATE_KEYS.markupAddOn, label: "Add-ons markup", kind: "mult", group: "Profit (markup multipliers)" },
  { key: RATE_KEYS.engineeringPct, label: "Engineering", kind: "pct", group: "Sale additions" },
  { key: RATE_KEYS.thirdPartyPct, label: "Third-party certificate", kind: "pct", group: "Sale additions" },
  { key: RATE_KEYS.commissioningLump, label: "Commissioning (lump sum)", kind: "lump", group: "Sale additions" },
  { key: RATE_KEYS.commissioningPct, label: "Commissioning (% of subtotal, legacy profiles)", kind: "pct", group: "Sale additions" },
  { key: RATE_KEYS.mobDemobPct, label: "Mob / Demob", kind: "pct", group: "Sale additions" },
  { key: RATE_KEYS.insuranceDivisor, label: "Social insurance divisor", kind: "divisor", group: "Insurance & tax" },
  { key: RATE_KEYS.extraDivisor, label: "Additional divisor (legacy equipment)", kind: "divisor", group: "Insurance & tax" },
  { key: RATE_KEYS.taxPct, label: "Tax", kind: "pct", group: "Insurance & tax" },
];

export const toInput = (kind: RateKind, v: number) => (kind === "pct" ? +(v * 100).toPrecision(10) : v);
export const fromInput = (kind: RateKind, v: number) => (kind === "pct" ? v / 100 : v);
