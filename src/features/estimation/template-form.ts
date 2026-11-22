/**
 * Template editor: validation of the form (shown next to each field) and the payload it sends. Pure TypeScript.
 * The server validates again (src/server/validators/estimation.ts); this only lets the user see the problem before the request.
 */
import { COST_TYPES, PROJECT_METHODS, SUB_COST_TYPES, type OpPercentBase, type ProjectPercentBase, type SubPercentBase } from "./calc";
import type { TemplateKind } from "./templates";

export interface TemplateForm {
  name: string;
  /** OPERATION: cost type · PROJECT_COST: method · SUBCONTRACT: cost type */
  type: string;
  unit: string; rate: string; quantity: string; percentBase: string;
  category: string; company: string; description: string; notes: string;
}
export const emptyTemplateForm = (kind: TemplateKind): TemplateForm => ({
  name: "", type: kind === "OPERATION" ? "FIXED" : kind === "PROJECT_COST" ? "FIXED" : "PER_UNIT", unit: "", rate: "", quantity: "", percentBase: "", category: "", company: "", description: "", notes: "",
});

export type TemplateFormErrors = Partial<Record<keyof TemplateForm, string>>;

const num = (s: string) => (s.trim() === "" ? null : Number(s));
const bad = (s: string, min = 0) => { const n = num(s); return n !== null && !(Number.isFinite(n) && n >= min); };

export function validateTemplateForm(kind: TemplateKind, f: TemplateForm): TemplateFormErrors {
  const e: TemplateFormErrors = {};
  if (!f.name.trim()) e.name = "Template name is required";
  else if (f.name.trim().length > 80) e.name = "Use 80 characters or fewer";
  const types: readonly string[] = kind === "OPERATION" ? COST_TYPES : kind === "PROJECT_COST" ? PROJECT_METHODS : SUB_COST_TYPES;
  if (!types.includes(f.type)) e.type = "Choose a cost type";
  if (kind === "SUBCONTRACT" && !f.unit.trim()) e.unit = "Unit is required";
  if (f.unit.length > 20) e.unit = "Use 20 characters or fewer";
  if (f.rate.trim() === "") e.rate = kind === "SUBCONTRACT" ? "Enter the unit price (0 if quoted later)" : "Enter the rate (0 if not known yet)";
  else if (bad(f.rate)) e.rate = "Must be 0 or more";
  else if (f.type === "PERCENTAGE" && Number(f.rate) > 1000) e.rate = "Percentage is too large";
  if (bad(f.quantity)) e.quantity = "Must be 0 or more";
  if (kind === "SUBCONTRACT" && f.quantity.trim() === "") e.quantity = "Enter the quantity";
  if (f.type === "PERCENTAGE" && !f.percentBase) e.percentBase = "Choose what the percentage applies to";
  return e;
}

/** Body for POST / PUT /api/estimation-templates. Blank optional fields are omitted, never sent as invented values. */
export function toTemplatePayload(kind: TemplateKind, f: TemplateForm) {
  const pct = f.type === "PERCENTAGE";
  const q = num(f.quantity);
  if (kind === "OPERATION") {
    return { kind, name: f.name.trim(), data: { costType: f.type, unit: f.unit.trim(), rate: Number(f.rate), quantity: q, percentBase: pct ? (f.percentBase as OpPercentBase) : null, description: f.description.trim() || null, notes: f.notes.trim() || null } };
  }
  if (kind === "PROJECT_COST") {
    return { kind, name: f.name.trim(), data: { method: f.type, unit: f.unit.trim(), rate: Number(f.rate), quantity: q, percentBase: pct ? (f.percentBase as ProjectPercentBase) : null, ...(f.category.trim() ? { category: f.category.trim() } : {}), notes: f.notes.trim() || null } };
  }
  return { kind, name: f.name.trim(), data: { company: f.company.trim() || null, unit: f.unit.trim(), quantity: q ?? 0, unitPrice: Number(f.rate), costType: f.type, percentBase: pct ? (f.percentBase as SubPercentBase) : null, description: f.description.trim() || null, notes: f.notes.trim() || null } };
}

/** Loads a stored template back into the form (stored JSON is untrusted: wrong types become blanks). */
export function formFromTemplate(kind: TemplateKind, name: string, data: unknown): TemplateForm {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  const f = emptyTemplateForm(kind);
  return {
    ...f, name,
    type: s(kind === "PROJECT_COST" ? d.method : d.costType) || f.type, unit: s(d.unit), rate: n(kind === "SUBCONTRACT" ? d.unitPrice : d.rate), quantity: n(d.quantity),
    percentBase: s(d.percentBase), category: s(d.category), company: s(d.company), description: s(d.description), notes: s(d.notes),
  };
}
