import { z } from "zod";

// Scope and Work Order groups of the Part List (the Assembly grouping has its own validator: part-group.ts).
export const GROUPING_KINDS = ["scope", "workOrder"] as const;
export type GroupingKind = (typeof GROUPING_KINDS)[number];
export const groupingKindSchema = z.enum(GROUPING_KINDS);

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-09-30");

export const groupingSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scope"),
    projectId: z.string().min(1, "Project is required"),
    description: z.string().trim().min(2, "Scope description is required").max(300),
  }),
  z.object({
    kind: z.literal("workOrder"),
    projectId: z.string().min(1, "Project is required"),
    code: z.string().trim().max(60).optional().nullable(), // left empty = the next WO-01, WO-02 … is used
    name: z.string().trim().min(1, "Name is required").max(200),
    dueDate: iso.optional().nullable(),
    remark: z.string().trim().max(500).optional().nullable(),
  }),
]);
export type GroupingInput = z.infer<typeof groupingSchema>;

// move parts into a scope / work order (targetId null = take them out)
export const assignGroupingSchema = z.object({
  projectId: z.string().min(1),
  kind: groupingKindSchema,
  targetId: z.string().min(1).nullable(),
  partIds: z.array(z.string().min(1)).min(1, "Select at least one part").max(500),
});
export type AssignGroupingInput = z.infer<typeof assignGroupingSchema>;
