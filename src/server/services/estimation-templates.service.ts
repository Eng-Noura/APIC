// Pricing sheet templates: reusable operations, project costs and subcontractor services.
//
// Templates are company-wide (not per project). Applying one to a sheet is an edit like any other: it is refused while the
// sheet is APPROVED, it drops a CALCULATED sheet back to DRAFT (the inputs changed), it is guarded against a concurrent save,
// and it is written to the field-level audit. A line the user already priced or typed in is never overwritten.

import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { logActivity } from "./activity-log.service";
import { audit, EstimationError, getSavedEstimate } from "./estimation.service";
import { diffFields, transition, type FieldChange, type SheetStatus } from "@/features/estimation/workflow";
import {
  nameKey, operationSeed, planApply, projectCostSeed, subcontractSeed,
  type OperationTemplateData, type ProjectCostTemplateData, type SubcontractTemplateData, type TemplateKind,
} from "@/features/estimation/templates";
import { templateDataSchemas, type TemplateInput } from "@/server/validators/estimation";
import type { EstimateDoc } from "@/features/estimation/types";

export interface TemplateRow { id: string; kind: TemplateKind; name: string; data: unknown; createdById: string; createdAt: string }

const json = (x: unknown) => x as Prisma.InputJsonValue;
const row = (t: Prisma.EstimateTemplateGetPayload<object>): TemplateRow => ({ id: t.id, kind: t.kind as TemplateKind, name: t.name, data: t.data, createdById: t.createdById, createdAt: t.createdAt.toISOString() });
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const DUPLICATE = "A template with this name already exists for this type.";

export async function listTemplates(kind?: TemplateKind): Promise<TemplateRow[]> {
  const rows = await prisma.estimateTemplate.findMany({ where: kind ? { kind } : undefined, orderBy: [{ kind: "asc" }, { name: "asc" }], take: 500 });
  return rows.map(row);
}

/** Case-insensitive duplicate check: the database unique key is case-sensitive, so "welding" and "Welding" would both pass it. */
async function assertNameFree(kind: TemplateKind, name: string, exceptId?: string) {
  const same = await prisma.estimateTemplate.findMany({ where: { kind }, select: { id: true, name: true } });
  if (same.some((t) => t.id !== exceptId && nameKey(t.name) === nameKey(name))) throw new EstimationError(DUPLICATE, 409);
}

export async function createTemplate(input: TemplateInput, userId: string): Promise<TemplateRow> {
  await assertNameFree(input.kind, input.name);
  try {
    const t = await prisma.estimateTemplate.create({ data: { kind: input.kind, name: input.name, data: json(input.data), createdById: userId } });
    await logActivity({ userId, action: "CREATE", entity: "SETTINGS", entityId: t.id, detail: `Pricing template created: ${input.kind} “${input.name}”` });
    return row(t);
  } catch (e) {
    if (isUniqueViolation(e)) throw new EstimationError(DUPLICATE, 409);
    throw e;
  }
}

export async function updateTemplate(id: string, input: TemplateInput, userId: string): Promise<TemplateRow> {
  const cur = await prisma.estimateTemplate.findUnique({ where: { id } });
  if (!cur) throw new EstimationError("Template not found", 404);
  if (cur.kind !== input.kind) throw new EstimationError("A template's type cannot be changed. Create a new template instead.", 400);
  await assertNameFree(input.kind, input.name, id);
  try {
    // Sheets that already used this template keep their own copy of the values, so editing a template never changes a sheet.
    const t = await prisma.estimateTemplate.update({ where: { id }, data: { name: input.name, data: json(input.data) } });
    await logActivity({ userId, action: "UPDATE", entity: "SETTINGS", entityId: id, detail: `Pricing template updated: ${input.kind} “${input.name}”` });
    return row(t);
  } catch (e) {
    if (isUniqueViolation(e)) throw new EstimationError(DUPLICATE, 409);
    throw e;
  }
}

export async function deleteTemplate(id: string, userId: string): Promise<void> {
  const cur = await prisma.estimateTemplate.findUnique({ where: { id } });
  if (!cur) throw new EstimationError("Template not found", 404);
  await prisma.estimateTemplate.delete({ where: { id } });
  await logActivity({ userId, action: "DELETE", entity: "SETTINGS", entityId: id, detail: `Pricing template deleted: ${cur.kind} “${cur.name}”` });
}

// ---------------------------------------------------------------- apply

const estimateInclude = {
  items: { select: { id: true, name: true, operations: { orderBy: { sortOrder: "asc" as const } } } },
  projectCosts: { orderBy: { sortOrder: "asc" as const } },
  subcontracts: { orderBy: { sortOrder: "asc" as const } },
} satisfies Prisma.ProjectEstimateInclude;

const OP_FIELDS = ["costType", "unit", "rate", "quantity", "percentBase", "selected", "description", "notes"] as const;
const COST_FIELDS = ["method", "unit", "rate", "quantity", "percentBase", "enabled", "category", "notes"] as const;

/**
 * Adds a template's line to the project's sheet — an operation to one item, a project cost or a subcontractor service to one
 * item or (itemId null) to the whole project. A same-named untouched default line is filled in instead of duplicated.
 */
export async function applyTemplate(projectId: string, input: { templateId: string; itemId?: string | null }, userId: string): Promise<EstimateDoc> {
  const e = await prisma.projectEstimate.findUnique({ where: { projectId }, include: estimateInclude });
  if (!e) throw new EstimationError("Estimate not found", 404);
  const edit = transition(e.status as SheetStatus, "EDIT");
  if (!edit.ok) throw new EstimationError(edit.reason, edit.status);

  const t = await prisma.estimateTemplate.findUnique({ where: { id: input.templateId } });
  if (!t) throw new EstimationError("Template not found", 404);
  const kind = t.kind as TemplateKind;
  const parsed = templateDataSchemas[kind].safeParse(t.data);
  if (!parsed.success) throw new EstimationError(`This template is not valid any more (${parsed.error.issues[0]?.message ?? "bad data"}). Edit and save it again.`, 422);

  const itemId = input.itemId ?? null;
  if (kind === "OPERATION" && !itemId) throw new EstimationError("Choose the item this operation belongs to.", 400);
  const item = itemId ? e.items.find((i) => i.id === itemId) : undefined;
  if (itemId && !item) throw new EstimationError("That item does not belong to this project's estimate", 400); // never trust an id from the client

  const guard = { id: e.id, version: e.version, updatedAt: e.updatedAt, status: { not: "APPROVED" } };
  const touch = { status: "DRAFT", updatedById: userId };
  const stale = () => new EstimationError("The sheet changed while the template was being applied. Reload and try again.", 409);
  const changes: FieldChange[] = [];
  let summary = "";

  if (kind === "OPERATION") {
    const d = parsed.data as OperationTemplateData;
    const ops = item!.operations;
    const same = ops.find((o) => nameKey(o.name) === nameKey(t.name));
    const plan = planApply(kind, t.name, same);
    if (plan.action === "CONFLICT") throw new EstimationError(plan.reason, 409);
    const seed = operationSeed(t.name, d);
    await prisma.$transaction(async (tx) => {
      if ((await tx.projectEstimate.updateMany({ where: guard, data: touch })).count !== 1) throw stale();
      if (plan.action === "FILL") {
        const { name: _n, ...fill } = seed; void _n;
        changes.push(...diffFields("operation", `${item!.name} · ${t.name}`, same as never, fill, OP_FIELDS));
        await tx.estimateOperation.update({ where: { id: plan.id }, data: fill });
        summary = `Template “${t.name}” filled the operation on ${item!.name}`;
      } else {
        await tx.estimateOperation.create({ data: { ...seed, itemId: item!.id, source: "MANUAL", sortOrder: Math.max(-1, ...ops.map((o) => o.sortOrder)) + 1 } });
        changes.push({ entity: "operation", label: `${item!.name} · ${t.name}`, field: "(line)", from: null, to: "added from template" });
        summary = `Template “${t.name}” added an operation to ${item!.name}`;
      }
      await audit(tx, e.id, userId, e.version, "TEMPLATE", summary, changes);
    });
  } else if (kind === "PROJECT_COST") {
    const d = parsed.data as ProjectCostTemplateData;
    const scope = e.projectCosts.filter((c) => (c.itemId ?? null) === itemId);
    const same = scope.find((c) => nameKey(c.name) === nameKey(t.name));
    const plan = planApply(kind, t.name, same);
    if (plan.action === "CONFLICT") throw new EstimationError(plan.reason, 409);
    const seed = projectCostSeed(t.name, d);
    const where = item ? item.name : "whole project";
    await prisma.$transaction(async (tx) => {
      if ((await tx.projectEstimate.updateMany({ where: guard, data: touch })).count !== 1) throw stale();
      if (plan.action === "FILL") {
        const { name: _n, ...fill } = seed; void _n;
        changes.push(...diffFields("projectCost", `${where} · ${t.name}`, same as never, fill, COST_FIELDS));
        await tx.estimateProjectCost.update({ where: { id: plan.id }, data: fill });
        summary = `Template “${t.name}” filled the project cost (${where})`;
      } else {
        await tx.estimateProjectCost.create({ data: { ...seed, estimateId: e.id, itemId, source: "MANUAL", sortOrder: Math.max(-1, ...e.projectCosts.map((c) => c.sortOrder)) + 1 } });
        changes.push({ entity: "projectCost", label: `${where} · ${t.name}`, field: "(line)", from: null, to: "added from template" });
        summary = `Template “${t.name}” added a project cost (${where})`;
      }
      await audit(tx, e.id, userId, e.version, "TEMPLATE", summary, changes);
    });
  } else {
    const d = parsed.data as SubcontractTemplateData;
    const seed = subcontractSeed(t.name, d);
    const where = item ? item.name : "whole project";
    await prisma.$transaction(async (tx) => {
      if ((await tx.projectEstimate.updateMany({ where: guard, data: touch })).count !== 1) throw stale();
      await tx.estimateSubcontract.create({ data: { ...seed, estimateId: e.id, itemId, sortOrder: Math.max(-1, ...e.subcontracts.map((s) => s.sortOrder)) + 1 } });
      changes.push({ entity: "subcontract", label: `${where} · ${t.name}`, field: "(line)", from: null, to: "added from template" });
      await audit(tx, e.id, userId, e.version, "TEMPLATE", `Template “${t.name}” added a subcontractor service (${where})`, changes);
    });
  }

  await logActivity({ userId, action: "UPDATE", entity: "PROJECT", entityId: projectId, detail: `Pricing template “${t.name}” applied` });
  return getSavedEstimate(projectId);
}
