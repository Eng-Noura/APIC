// Pricing sheet templates — pure logic (no React, no DB). A template is a saved, reusable line: a manufacturing operation,
// a project cost, or a subcontractor service. Templates carry exactly the rates the estimator typed in; nothing is invented
// here, and applying one never touches a line the user has already worked on (see planApply).

import type { CostType, OpPercentBase, ProjectMethod, ProjectPercentBase, SubCostType, SubPercentBase } from "./calc";

export const TEMPLATE_KINDS = ["OPERATION", "PROJECT_COST", "SUBCONTRACT"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/** What a template stores in `data` — the name lives in its own column. */
export interface OperationTemplateData { costType: CostType; unit: string; rate: number; quantity?: number | null; percentBase?: OpPercentBase | null; description?: string | null; notes?: string | null }
export interface ProjectCostTemplateData { method: ProjectMethod; unit: string; rate: number; quantity?: number | null; percentBase?: ProjectPercentBase | null; category?: string; notes?: string | null }
export interface SubcontractTemplateData { company?: string | null; unit: string; quantity: number; unitPrice: number; costType?: SubCostType; percentBase?: SubPercentBase | null; description?: string | null; notes?: string | null }

export interface TemplateDataByKind { OPERATION: OperationTemplateData; PROJECT_COST: ProjectCostTemplateData; SUBCONTRACT: SubcontractTemplateData }

/** Create-data for a new line (relations such as estimateId / itemId / sortOrder are added by the service). */
export const operationSeed = (name: string, d: OperationTemplateData) => ({
  name, costType: d.costType, unit: d.unit, rate: d.rate, quantity: d.quantity ?? null,
  percentBase: d.costType === "PERCENTAGE" ? d.percentBase ?? null : null,
  selected: true, description: d.description || null, notes: d.notes || null,
});

export const projectCostSeed = (name: string, d: ProjectCostTemplateData) => ({
  name, method: d.method, unit: d.unit, rate: d.rate, quantity: d.quantity ?? null,
  percentBase: d.method === "PERCENTAGE" ? d.percentBase ?? null : null,
  enabled: true, category: d.category ?? "", notes: d.notes || null,
});

export const subcontractSeed = (name: string, d: SubcontractTemplateData) => ({
  name, company: d.company || null, unit: d.unit, quantity: d.quantity, unitPrice: d.unitPrice,
  costType: d.costType ?? "PER_UNIT",
  percentBase: d.costType === "PERCENTAGE" ? d.percentBase ?? null : null,
  selected: true, description: d.description || null, notes: d.notes || null,
});

/** The line already on the sheet with the same name in the same place (same item / same project scope), if any. */
export interface ExistingLine { id: string; source: string; rate: number; selected?: boolean }

export type ApplyPlan =
  | { action: "ADD" }
  | { action: "FILL"; id: string }
  | { action: "CONFLICT"; reason: string };

const untouched = (kind: TemplateKind, l: ExistingLine) => l.source === "DEFAULT" && l.rate === 0 && (kind !== "OPERATION" || !l.selected);

/**
 * Decides what applying a template does. The sheet starts with empty default lines (Cutting, Welding, Engineering…): a
 * template with the same name fills such an untouched line in. A line the user already priced, selected or typed in is never
 * overwritten — the user is told to edit it instead. Subcontractor services are always added (several per item are normal).
 */
export function planApply(kind: TemplateKind, name: string, existing: ExistingLine | undefined): ApplyPlan {
  if (kind === "SUBCONTRACT" || !existing) return { action: "ADD" };
  if (untouched(kind, existing)) return { action: "FILL", id: existing.id };
  return { action: "CONFLICT", reason: `"${name}" is already on the sheet with your own values. Edit that line instead of applying the template over it.` };
}

/** Case- and whitespace-insensitive name key, so "welding" and " Welding " are the same line. */
export const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
