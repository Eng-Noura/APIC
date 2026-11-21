import { z } from "zod";
import { ALLOCATION_BASES, COST_TYPES, DISCOUNT_MODES, DISCOUNT_TIMINGS, INSURANCE_MODES, OP_PERCENT_BASES, PRICE_SOURCES, PROFIT_MODES, PROJECT_METHODS, PROJECT_PERCENT_BASES, SUB_COST_TYPES, SUB_PERCENT_BASES } from "@/features/estimation/calc";

const money = z.number().finite().min(0, "Must be 0 or more").max(1e12);
const qty = z.number().finite().min(0, "Must be 0 or more").max(1e9);
const text = (max: number) => z.string().trim().max(max);
const id = z.string().min(1).max(60);

export const materialSchema = z.object({
  id,
  name: text(120).min(1, "Material name is required"),
  grade: text(40).nullable().optional(),
  thicknessMm: z.number().finite().min(0).max(1000).nullable().optional(),
  requiredKg: qty.nullable().optional(),
  purchasedKg: qty,
  unitPrice: money,
  /** v2 (all optional: an older page that does not send them keeps working) */
  priceSource: z.enum(PRICE_SOURCES).optional(),
  itemId: id.nullable().optional(),
  materialType: text(40).nullable().optional(),
  dimensions: text(120).nullable().optional(),
  unit: text(20).optional(),
  notes: text(500).nullable().optional(),
});

export const operationSchema = z.object({
  id, name: text(80).min(1, "Operation name is required"),
  costType: z.enum(COST_TYPES), unit: text(20).default(""),
  rate: money, quantity: qty.nullable().optional(),
  percentBase: z.enum(OP_PERCENT_BASES).nullable().optional(),
  selected: z.boolean(),
  description: text(200).nullable().optional(), notes: text(500).nullable().optional(),
}).refine((o) => o.costType !== "PERCENTAGE" || !!o.percentBase, { message: "Choose what the percentage applies to", path: ["percentBase"] })
  .refine((o) => o.costType !== "PERCENTAGE" || o.rate <= 1000, { message: "Percentage is too large", path: ["rate"] });

export const itemSchema = z.object({
  id, name: text(120).min(1, "Item name is required"),
  manualWeightKg: qty.nullable().optional(), manualPieces: z.number().int().min(0).max(1e7).nullable().optional(),
  notes: text(500).nullable().optional(),
  operations: z.array(operationSchema).max(100),
});

export const subcontractSchema = z.object({
  id, name: text(120).min(1, "Service name is required"), company: text(120).nullable().optional(),
  unit: text(20).min(1, "Unit is required"), quantity: qty, unitPrice: money, notes: text(500).nullable().optional(),
  description: text(200).nullable().optional(),
  costType: z.enum(SUB_COST_TYPES).optional(), percentBase: z.enum(SUB_PERCENT_BASES).nullable().optional(),
  selected: z.boolean().optional(), itemId: id.nullable().optional(),
}).refine((x) => x.costType !== "PERCENTAGE" || !!x.percentBase, { message: "Choose what the percentage applies to", path: ["percentBase"] })
  .refine((x) => x.costType !== "PERCENTAGE" || x.unitPrice <= 1000, { message: "Percentage is too large", path: ["unitPrice"] });

export const projectCostSchema = z.object({
  id, name: text(80).min(1, "Cost item name is required"),
  method: z.enum(PROJECT_METHODS), unit: text(20).default(""),
  quantity: qty.nullable().optional(), rate: money,
  percentBase: z.enum(PROJECT_PERCENT_BASES).nullable().optional(), enabled: z.boolean(),
  category: text(40).optional(), notes: text(500).nullable().optional(), itemId: id.nullable().optional(),
}).refine((c) => c.method !== "PERCENTAGE" || !!c.percentBase, { message: "Choose what the percentage applies to", path: ["percentBase"] });

export const settingsSchema = z.object({
  scrapUsedLaterPct: z.number().min(0).max(1), scrapUsedLaterPrice: money, scrapSellPrice: money, creditRecoveredScrap: z.boolean(),
  profitMode: z.enum(PROFIT_MODES), profitValue: money,
  insuranceMode: z.enum(INSURANCE_MODES), insuranceValue: money,
  taxPct: z.number().finite().min(0).max(100),
  paymentTerms: text(200).nullable().optional(),
  offerValidityDays: z.number().int().min(1).max(3650), deliveryDays: z.number().int().min(0).max(3650).nullable().optional(),
  exclusions: text(500).nullable().optional(), commercialNotes: text(1000).nullable().optional(),
  /** v2 */
  discountMode: z.enum(DISCOUNT_MODES).optional(), discountValue: money.optional(), discountTiming: z.enum(DISCOUNT_TIMINGS).optional(),
  otherChargesLabel: text(80).nullable().optional(), otherChargesValue: money.optional(), otherChargesTaxable: z.boolean().optional(),
  targetSalePrice: money.nullable().optional(),
  advancePct: z.number().finite().min(0).max(100).nullable().optional(),
  milestones: text(2000).nullable().optional(),
  warrantyMonths: z.number().int().min(0).max(600).nullable().optional(),
  allocationBasis: z.enum(ALLOCATION_BASES).optional(),
}).refine((s) => s.discountMode !== "PERCENT" || (s.discountValue ?? 0) <= 100, { message: "A percentage discount cannot exceed 100", path: ["discountValue"] });

export const saveEstimateSchema = z.object({
  /** ISO updatedAt the page loaded — a different value on the server means someone else saved in the meantime. */
  baseUpdatedAt: z.string().min(1),
  settings: settingsSchema,
  materials: z.array(materialSchema).max(500),
  items: z.array(itemSchema).max(200),
  subcontracts: z.array(subcontractSchema).max(200),
  projectCosts: z.array(projectCostSchema).max(200),
  /** set by "Continue": marks that stage complete */
  stageDone: z.object({ material: z.boolean().optional(), manufacturing: z.boolean().optional(), project: z.boolean().optional() }).optional(),
});
export type SaveEstimateInput = z.infer<typeof saveEstimateSchema>;

export const reopenSchema = z.object({ reason: text(500).min(3, "Give a reason for reopening") });
export const compareSchema = z.object({ from: id, to: id });
export const restoreLineSchema = z.object({ materialId: id });

// ---------------------------------------------------------------- templates

const opTemplateData = z.object({
  costType: z.enum(COST_TYPES), unit: text(20).default(""), rate: money, quantity: qty.nullable().optional(),
  percentBase: z.enum(OP_PERCENT_BASES).nullable().optional(), description: text(200).nullable().optional(), notes: text(500).nullable().optional(),
}).refine((o) => o.costType !== "PERCENTAGE" || !!o.percentBase, { message: "Choose what the percentage applies to", path: ["percentBase"] })
  .refine((o) => o.costType !== "PERCENTAGE" || o.rate <= 1000, { message: "Percentage is too large", path: ["rate"] });

const costTemplateData = z.object({
  method: z.enum(PROJECT_METHODS), unit: text(20).default(""), rate: money, quantity: qty.nullable().optional(),
  percentBase: z.enum(PROJECT_PERCENT_BASES).nullable().optional(), category: text(40).optional(), notes: text(500).nullable().optional(),
}).refine((c) => c.method !== "PERCENTAGE" || !!c.percentBase, { message: "Choose what the percentage applies to", path: ["percentBase"] });

const subTemplateData = z.object({
  company: text(120).nullable().optional(), unit: text(20).min(1, "Unit is required"), quantity: qty, unitPrice: money,
  costType: z.enum(SUB_COST_TYPES).optional(), percentBase: z.enum(SUB_PERCENT_BASES).nullable().optional(),
  description: text(200).nullable().optional(), notes: text(500).nullable().optional(),
}).refine((x) => x.costType !== "PERCENTAGE" || !!x.percentBase, { message: "Choose what the percentage applies to", path: ["percentBase"] })
  .refine((x) => x.costType !== "PERCENTAGE" || x.unitPrice <= 1000, { message: "Percentage is too large", path: ["unitPrice"] });

const templateName = text(80).min(1, "Template name is required");

/** Create / replace a template. `kind` decides which shape `data` must have. */
export const templateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("OPERATION"), name: templateName, data: opTemplateData }),
  z.object({ kind: z.literal("PROJECT_COST"), name: templateName, data: costTemplateData }),
  z.object({ kind: z.literal("SUBCONTRACT"), name: templateName, data: subTemplateData }),
]);
export type TemplateInput = z.infer<typeof templateSchema>;

/** Re-validates what is stored in a template row before it is applied (stored JSON is never trusted blindly). */
export const templateDataSchemas = { OPERATION: opTemplateData, PROJECT_COST: costTemplateData, SUBCONTRACT: subTemplateData } as const;

export const templateKindSchema = z.enum(["OPERATION", "PROJECT_COST", "SUBCONTRACT"]);

/** itemId is required for an OPERATION (operations belong to an item) and optional for the others (null = whole project). */
export const applyTemplateSchema = z.object({ templateId: id, itemId: id.nullable().optional() });
export const auditQuerySchema = z.object({ take: z.coerce.number().int().min(1).max(500).default(100) });
