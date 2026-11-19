import { UNITS, type Issue, type Quantities, type Unit } from "./types";

const ALIASES: Record<string, Unit> = {
  KG: "KG", KGS: "KG",
  TON: "TON", TONS: "TON", T: "TON",
  EA: "EA", EACH: "EA", PC: "EA", PCS: "EA", NO: "EA", NOS: "EA",
  SQM: "SQM", M2: "SQM", "M²": "SQM",
  M: "M", MTR: "M", LM: "M",
};

/** Case-insensitive; returns null for anything that is not a known unit (never guesses). */
export function parseUnit(raw: string | null | undefined): Unit | null {
  if (raw == null) return null;
  const u = ALIASES[raw.trim().toUpperCase()];
  return u && UNITS.includes(u) ? u : null;
}

/** Only KG <-> TON are convertible; every other pair must match exactly. */
export function convert(value: number, from: Unit, to: Unit): number {
  if (from === to) return value;
  if (from === "KG" && to === "TON") return value / 1000;
  if (from === "TON" && to === "KG") return value * 1000;
  throw new Error(`UNIT_CONVERSION: cannot convert ${from} to ${to} without a unit weight`);
}

export interface QuantityInput {
  qty: number;
  unit: string;
  /** kg per item unit (kg/ea, kg/m, kg/sqm). Needed to get a weight for EA / M / SQM items. */
  unitWeightKg?: number;
  /** Optional extra bases for items whose own unit is something else (e.g. paint area on a TON item). */
  areaSqm?: number;
  lengthM?: number;
}

export interface DerivedQuantities {
  unit: Unit | null;
  quantities: Quantities | null;
  issues: Issue[];
}

/** Turns "qty + unit (+ unit weight)" into the bases the methods use. Never throws; reports issues. */
export function deriveQuantities(i: QuantityInput): DerivedQuantities {
  const issues: Issue[] = [];
  const unit = parseUnit(i.unit);
  if (!unit) {
    issues.push({ code: "INVALID_UNIT", severity: "error", message: `Unknown unit "${i.unit}". Allowed: ${UNITS.join(", ")}.` });
    return { unit: null, quantities: null, issues };
  }
  if (!Number.isFinite(i.qty) || i.qty < 0) {
    issues.push({ code: "INVALID_QUANTITY", severity: "error", message: `Quantity must be a number ≥ 0 (got ${i.qty}).` });
    return { unit, quantities: null, issues };
  }
  if (i.unitWeightKg !== undefined && (!Number.isFinite(i.unitWeightKg) || i.unitWeightKg < 0)) {
    issues.push({ code: "INVALID_QUANTITY", severity: "error", message: `Unit weight must be a number ≥ 0 (got ${i.unitWeightKg}).` });
    return { unit, quantities: null, issues };
  }
  if (i.qty === 0) issues.push({ code: "ZERO_QUANTITY", severity: "warning", message: "Quantity is 0: every quantity-based amount is 0." });

  const q: Quantities = {};
  switch (unit) {
    case "KG": q.weightKg = i.qty; break;
    case "TON": q.weightKg = convert(i.qty, "TON", "KG"); break;
    case "EA": q.units = i.qty; if (i.unitWeightKg !== undefined) q.weightKg = i.qty * i.unitWeightKg; break;
    case "SQM": q.areaSqm = i.qty; if (i.unitWeightKg !== undefined) q.weightKg = i.qty * i.unitWeightKg; break;
    case "M": q.lengthM = i.qty; if (i.unitWeightKg !== undefined) q.weightKg = i.qty * i.unitWeightKg; break;
  }
  if (q.weightKg !== undefined) q.weightTon = unit === "TON" ? i.qty : convert(q.weightKg, "KG", "TON");
  if (i.areaSqm !== undefined) q.areaSqm = i.areaSqm;
  if (i.lengthM !== undefined) q.lengthM = i.lengthM;
  if (q.weightKg === undefined) {
    issues.push({ code: "ZERO_WEIGHT", severity: "warning", message: "No weight can be derived (unit weight missing); per-ton / per-kg methods will report a missing basis." });
  } else if (q.weightKg === 0 && i.qty > 0) {
    issues.push({ code: "ZERO_WEIGHT", severity: "warning", message: "Total weight is 0: per-ton / per-kg amounts are 0." });
  }
  return { unit, quantities: q, issues };
}
