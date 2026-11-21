/**
 * Pricing engine — shared types. Pure TypeScript: no DB, no React, no rounding.
 */

export const UNITS = ["KG", "TON", "EA", "SQM", "M"] as const;
export type Unit = (typeof UNITS)[number];

export const METHODS = [
  "PER_TON",
  "PER_KG",
  "PER_SQM",
  "PER_METER",
  "PER_UNIT",
  "PERCENT_OF_BASE",
  "FIXED_LUMP_SUM",
  "FIXED_PLUS_VARIABLE",
  "DIVISOR",
  "MARKUP",
] as const;
export type Method = (typeof METHODS)[number];

export type Category = "MATERIAL" | "FABRICATION" | "SUBCONTRACTOR" | "INSTALLATION" | "ADD_ON" | "INDIRECT" | "SALE";

/**
 * Which "book" a number belongs to. Direct cost, indirect cost and sale price never mix:
 * COST / INDIRECT nodes may only depend on COST / INDIRECT nodes. A price is built from costs only
 * through an explicit MARKUP; TOTAL_COST and RESULT are the two reconciliation points that may read anything.
 */
export type Ledger = "COST" | "INDIRECT" | "SALE" | "TOTAL_COST" | "RESULT";

/** Rate layers, lowest to highest precedence: component fallback < GLOBAL < PROJECT < PROFILE < OVERRIDE. */
export type RateLayerName = "OVERRIDE" | "PROFILE" | "PROJECT" | "GLOBAL" | "COMPONENT";
export type RateMap = Record<string, number>;
export interface RateLayers {
  global?: RateMap;
  project?: RateMap;
  profile?: RateMap;
  override?: RateMap;
}

/** Quantities of one pricing item, already normalised (see `deriveQuantities`). */
export interface Quantities {
  weightKg?: number;
  weightTon?: number;
  areaSqm?: number;
  lengthM?: number;
  units?: number;
}

export interface Component {
  id: string;
  name: string;
  category: Category;
  ledger: Ledger;
  method: Method;
  /** Key looked up through the rate layers. */
  rateKey?: string;
  /** Lowest-precedence fallback when no layer holds `rateKey`. */
  rate?: number;
  /** FIXED_PLUS_VARIABLE: the fixed part (looked up like a rate when `fixedKey` is set). */
  fixed?: number;
  fixedKey?: string;
  /** Unit the rate is expressed in. Validated against the method; required for FIXED_PLUS_VARIABLE. */
  unit?: Unit;
  /** PERCENT_OF_BASE / DIVISOR / MARKUP: id of the node used as base. */
  base?: string;
  enabled: boolean;
  /** Where the line came from (profile name, "manual", …) — carried into the trace. */
  source?: string;
}

export interface DerivedNode {
  id: string;
  label: string;
  category?: Category;
  ledger: Ledger;
  deps: string[];
  /** Human-readable formula shown in the Summary tab ("a + b"). */
  formula: string;
  fn: (v: Record<string, number>) => number;
}

export type NodeSpec = { kind: "component"; component: Component } | ({ kind: "derived" } & DerivedNode);

export type IssueCode =
  | "MISSING_RATE"
  | "INVALID_RATE"
  | "OPTIONAL_RATE_MISSING"
  | "MISSING_BASIS"
  | "ZERO_BASIS"
  | "UNIT_MISMATCH"
  | "INVALID_UNIT"
  | "INVALID_QUANTITY"
  | "ZERO_QUANTITY"
  | "ZERO_WEIGHT"
  | "ZERO_COST"
  | "UNIT_CONVERSION"
  | "CYCLE"
  | "UNKNOWN_DEPENDENCY"
  | "DUPLICATE_NODE"
  | "LEDGER_MIX"
  | "MISSING_BASE"
  | "LOW_MARKUP"
  | "DEPENDENCY_FAILED";

export interface Issue {
  code: IssueCode;
  severity: "error" | "warning";
  nodeId?: string;
  message: string;
}

export type TraceStatus = "OK" | "DISABLED" | "ERROR" | "SKIPPED";

export interface TraceEntry {
  id: string;
  label: string;
  ledger: Ledger;
  category?: Category;
  status: TraceStatus;
  value: number | null;
  method?: Method;
  /** Formula with the symbolic ids; `expression` has the numbers substituted. */
  formula: string;
  expression?: string;
  inputs: { id: string; value: number }[];
  rate?: { key?: string; value: number; layer: RateLayerName };
  basis?: { name: string; value: number };
  source?: string;
}

export interface GraphResult {
  ok: boolean;
  values: Record<string, number>;
  trace: Record<string, TraceEntry>;
  /** Evaluation order actually used. */
  order: string[];
  issues: Issue[];
}
