import type { CostType, OpPercentBase, ProjectMethod, ProjectPercentBase } from "./calc";

/** Operations every item starts with (all unselected, rate 0 — the estimator decides; nothing is invented). */
export const DEFAULT_OPERATIONS: { name: string; costType: CostType; unit: string; percentBase?: OpPercentBase }[] = [
  { name: "Cutting", costType: "PER_KG", unit: "KG" },
  { name: "Beveling", costType: "PER_METER", unit: "M" },
  { name: "Welding", costType: "PER_METER", unit: "M" },
  { name: "Rolling", costType: "FIXED", unit: "" },
  { name: "Drilling", costType: "PER_HOLE", unit: "Hole" },
  { name: "Assembly", costType: "PERCENTAGE", unit: "%", percentBase: "ITEM_OPERATIONS" },
  { name: "Painting", costType: "CUSTOM", unit: "m²" },
];

export const DEFAULT_PROJECT_COSTS: { name: string; method: ProjectMethod; unit: string; percentBase?: ProjectPercentBase }[] = [
  { name: "Engineering", method: "FIXED", unit: "" },
  { name: "QA/QC", method: "PERCENTAGE", unit: "%", percentBase: "DIRECT_COST" },
  { name: "NDT", method: "PER_TEST", unit: "test" },
  { name: "Transportation", method: "PER_TRIP", unit: "trip" },
  { name: "Installation", method: "PER_TON", unit: "ton" },
  { name: "Packing", method: "FIXED", unit: "" },
  { name: "Mobilization", method: "FIXED", unit: "" },
  { name: "Project Overhead", method: "PERCENTAGE", unit: "%", percentBase: "DIRECT_COST" },
  { name: "Contingency", method: "PERCENTAGE", unit: "%", percentBase: "DIRECT_COST" },
];

export const PAYMENT_TERMS = ["100% Advance", "50% Advance, 50% on Delivery", "30% Advance, 70% on Delivery", "30 days after delivery", "Letter of credit"];
