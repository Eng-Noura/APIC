import { z } from "zod";
import { COST_TYPES, INSURANCE_MODES, OP_PERCENT_BASES, PROFIT_MODES, PROJECT_METHODS, PROJECT_PERCENT_BASES } from "@/features/estimation/calc";

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
});

export const operationSchema = z.object({
  id, name: text(80).min(1, "Operation name is required"),
  costType: z.enum(COST_TYPES), unit: text(20).default(""),
  rate: money, quantity: qty.nullable().optional(),
  percentBase: z.enum(OP_PERCENT_BASES).nullable().optional(),
  selected: z.boolean(),
}).refine((o) => o.costType !== "PERCENTAGE" || !!o.percentBase, { message: "Choose what the percentage applies to", path: ["percentBase"] })
  .refine((o) => o.costType !== "PERCENTAGE" || o.rate <= 1000, { message: "Percentage is too large", path: ["rate"] });

export const itemSchema = z.object({
  id, name: text(120).min(1, "Item name is required"),
  manualWeightKg: qty.nullable().optional(), manualPieces: z.number().int().min(0).max(1e7).nullable().optional(),
  operations: z.array(operationSchema).max(100),
});

export const subcontractSchema = z.object({
  id, name: text(120).min(1, "Service name is required"), company: text(120).nullable().optional(),
  unit: text(20).min(1, "Unit is required"), quantity: qty, unitPrice: money, notes: text(500).nullable().optional(),
});

export const projectCostSchema = z.object({
  id, name: text(80).min(1, "Cost item name is required"),
  method: z.enum(PROJECT_METHODS), unit: text(20).default(""),
  quantity: qty.nullable().optional(), rate: money,
  percentBase: z.enum(PROJECT_PERCENT_BASES).nullable().optional(), enabled: z.boolean(),
}).refine((c) => c.method !== "PERCENTAGE" || !!c.percentBase, { message: "Choose what the percentage applies to", path: ["percentBase"] });

export const settingsSchema = z.object({
  scrapUsedLaterPct: z.number().min(0).max(1), scrapUsedLaterPrice: money, scrapSellPrice: money, creditRecoveredScrap: z.boolean(),
  profitMode: z.enum(PROFIT_MODES), profitValue: money,
  insuranceMode: z.enum(INSURANCE_MODES), insuranceValue: money,
  taxPct: z.number().finite().min(0).max(100),
  paymentTerms: text(200).nullable().optional(),
  offerValidityDays: z.number().int().min(1).max(3650), deliveryDays: z.number().int().min(0).max(3650).nullable().optional(),
  exclusions: text(500).nullable().optional(), commercialNotes: text(1000).nullable().optional(),
});

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
