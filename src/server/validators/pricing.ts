import { z } from "zod";
import { PROFILE_TYPES } from "@/features/pricing/rate-library";

const num = z.number().finite();
const nonNeg = num.min(0, "Must be 0 or more");

export const createSheetSchema = z.object({ projectId: z.string().min(1) });

export const addItemsSchema = z.union([
  z.object({ scopeItemIds: z.array(z.string().min(1)).min(1).max(200) }),
  z.object({ manual: z.object({
    description: z.string().trim().min(2, "Description is required"),
    unit: z.string().trim().min(1), qty: nonNeg, unitWeightKg: nonNeg.optional(), scopeType: z.string().trim().max(60).optional(),
  }) }),
]);

export const patchItemSchema = z.object({
  itemNo: z.string().trim().min(1).max(20).optional(),
  description: z.string().trim().min(2).optional(),
  unit: z.string().trim().min(1).optional(),
  qty: nonNeg.optional(),
  unitWeightKg: nonNeg.nullable().optional(),
  scopeType: z.string().trim().max(60).optional(),
  calcProfile: z.enum(["STANDARD", "LEGACY_MOB_DOUBLE_COUNT", "LEGACY_EQUIPMENT"]).nullable().optional(),
  profileRefs: z.record(z.enum(PROFILE_TYPES), z.string().min(1)).nullable().optional(),
});

export const materialSchema = z.object({
  name: z.string().trim().min(1, "Name is required"), grade: z.string().trim().max(40).optional(),
  qty: nonNeg, unit: z.string().trim().min(1), unitCost: nonNeg, notes: z.string().max(500).optional(),
});

export const componentSchema = z.object({
  category: z.enum(["FABRICATION", "SUBCONTRACTOR", "INSTALLATION", "ADD_ON"]),
  name: z.string().trim().min(1, "Name is required"),
  method: z.enum(["PER_TON", "PER_KG", "PER_SQM", "PER_METER", "PER_UNIT", "FIXED_LUMP_SUM", "FIXED_PLUS_VARIABLE", "PERCENT_OF_BASE"]),
  rate: nonNeg, fixed: nonNeg.nullable().optional(), unit: z.string().trim().nullable().optional(),
  base: z.enum(["MATERIAL_COST", "FAB_DIRECT", "SUB_DIRECT"]).nullable().optional(), enabled: z.boolean().optional(),
});
export const componentPatchSchema = componentSchema.partial();

export const overrideSchema = z.object({ rateKey: z.string().min(1).max(80), value: nonNeg.nullable(), reason: z.string().max(300).optional() });

// ---- Rate Library
export const profileCreateSchema = z.object({
  type: z.enum(PROFILE_TYPES), name: z.string().trim().min(2, "Name is required").max(80), description: z.string().trim().max(300).optional(),
  scope: z.enum(["GLOBAL", "PROJECT"]), projectId: z.string().min(1).optional(),
}).refine((v) => v.scope === "GLOBAL" || !!v.projectId, { message: "Choose the project for a project-level profile", path: ["projectId"] });
export const profilePatchSchema = z.object({ name: z.string().trim().min(2).max(80).optional(), description: z.string().trim().max(300).nullable().optional(), active: z.boolean().optional() });

export const rateComponentSchema = z.object({
  key: z.string().min(1).max(80), name: z.string().trim().min(1).max(80), category: z.string().min(1).max(30),
  method: z.string().min(1).max(30), rate: nonNeg, fixed: nonNeg.nullable().optional(), unit: z.string().trim().nullable().optional(),
  base: z.enum(["MATERIAL_COST", "FAB_DIRECT", "SUB_DIRECT"]).nullable().optional(), enabled: z.boolean().optional(), notes: z.string().max(300).optional(),
});
export const rateComponentPatchSchema = rateComponentSchema.pick({ name: true, rate: true, fixed: true, unit: true, base: true, enabled: true, notes: true }).partial();
