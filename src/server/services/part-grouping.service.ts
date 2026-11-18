// Part List grouping, three ways: by ASSEMBLY (part-group.service.ts), by SCOPE and by WORK ORDER (this file).
// A part belongs to at most one of each, so every part can answer "which assembly, which scope, which work order?".
//   - Scope  = the project's Scope list (ScopeItem — the same list shown on the project page).
//   - Work order group = a package of parts that go to the shop together (WorkOrderGroup).

import { prisma } from "@/server/db/client";
import { dateToIso, isoToDate } from "@/features/planning/calendar";
import type { AssignGroupingInput, GroupingInput, GroupingKind } from "@/server/validators/part-grouping";
import { logActivity } from "./activity-log.service";

export class PartGroupingError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}
const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

export interface ScopeRowDTO { id: string; description: string; partCount: number; totalKg: number }
export interface WorkOrderGroupRowDTO { id: string; code: string; name: string; dueDate: string | null; remark: string | null; partCount: number; totalKg: number }
export interface AssemblyOptionDTO { id: string; code: string; name: string; qty: number; parentId: string | null }
export interface GroupingsData {
  assemblies: AssemblyOptionDTO[];
  scopes: ScopeRowDTO[];
  workOrders: WorkOrderGroupRowDTO[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export async function getGroupings(projectId: string): Promise<GroupingsData> {
  const [assemblies, scopes, wos, parts] = await Promise.all([
    prisma.partGroup.findMany({ where: { projectId }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }], select: { id: true, code: true, name: true, qty: true, parentId: true } }),
    prisma.scopeItem.findMany({ where: { projectId }, orderBy: { createdAt: "asc" }, select: { id: true, description: true } }),
    prisma.workOrderGroup.findMany({ where: { projectId }, orderBy: [{ sortOrder: "asc" }, { code: "asc" }] }),
    prisma.takeoffPart.findMany({ where: { drawing: { projectId }, OR: [{ scopeId: { not: null } }, { workOrderGroupId: { not: null } }] }, select: { scopeId: true, workOrderGroupId: true, weightKg: true } }),
  ]);
  const sc = new Map<string, { n: number; kg: number }>();
  const wo = new Map<string, { n: number; kg: number }>();
  const bump = (m: Map<string, { n: number; kg: number }>, id: string | null, kg: number) => {
    if (!id) return;
    const cur = m.get(id) ?? { n: 0, kg: 0 };
    m.set(id, { n: cur.n + 1, kg: cur.kg + kg });
  };
  for (const p of parts) { bump(sc, p.scopeId, p.weightKg); bump(wo, p.workOrderGroupId, p.weightKg); }
  return {
    assemblies,
    scopes: scopes.map((s) => ({ id: s.id, description: s.description, partCount: sc.get(s.id)?.n ?? 0, totalKg: round1(sc.get(s.id)?.kg ?? 0) })),
    workOrders: wos.map((w) => ({
      id: w.id, code: w.code, name: w.name, dueDate: w.dueDate ? dateToIso(w.dueDate) : null, remark: w.remark,
      partCount: wo.get(w.id)?.n ?? 0, totalKg: round1(wo.get(w.id)?.kg ?? 0),
    })),
  };
}

// ------------------------------------------------------------------------------------------------ create / edit / delete

async function nextWorkOrderCode(projectId: string) {
  const rows = await prisma.workOrderGroup.findMany({ where: { projectId }, select: { code: true } });
  const used = new Set(rows.map((r) => r.code));
  for (let n = rows.length + 1; ; n++) {
    const code = `WO-${String(n).padStart(2, "0")}`;
    if (!used.has(code)) return code;
  }
}

async function assertProject(projectId: string) {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!p) throw new PartGroupingError("Project not found", 404);
}

export async function createGrouping(data: GroupingInput, userId: string) {
  await assertProject(data.projectId);
  if (data.kind === "scope") {
    const item = await prisma.scopeItem.create({ data: { description: data.description, projectId: data.projectId, createdById: userId } });
    await logActivity({ userId, action: "CREATE", entity: "SCOPE_ITEM", entityId: item.id, detail: item.description });
    return { kind: "scope" as const, id: item.id };
  }
  const code = data.code?.trim() || (await nextWorkOrderCode(data.projectId));
  const count = await prisma.workOrderGroup.count({ where: { projectId: data.projectId } });
  try {
    const g = await prisma.workOrderGroup.create({
      data: { projectId: data.projectId, code, name: data.name, dueDate: data.dueDate ? isoToDate(data.dueDate) : null, remark: data.remark?.trim() || null, sortOrder: count },
    });
    await logActivity({ userId, action: "CREATE", entity: "PART_GROUP", entityId: g.id, detail: `Work order ${g.code} — ${g.name}` });
    return { kind: "workOrder" as const, id: g.id };
  } catch (e) {
    if (isUnique(e)) throw new PartGroupingError(`A work order with code ${code} already exists in this project`, 409);
    throw e;
  }
}

export async function updateGrouping(id: string, data: GroupingInput, userId: string) {
  if (data.kind === "scope") {
    const existing = await prisma.scopeItem.findUnique({ where: { id }, select: { projectId: true } });
    if (!existing || existing.projectId !== data.projectId) throw new PartGroupingError("Scope not found", 404);
    const item = await prisma.scopeItem.update({ where: { id }, data: { description: data.description } });
    await logActivity({ userId, action: "UPDATE", entity: "SCOPE_ITEM", entityId: id, detail: item.description });
    return;
  }
  const existing = await prisma.workOrderGroup.findUnique({ where: { id }, select: { projectId: true, code: true } });
  if (!existing || existing.projectId !== data.projectId) throw new PartGroupingError("Work order not found", 404);
  const code = data.code?.trim() || existing.code;
  try {
    const g = await prisma.workOrderGroup.update({ where: { id }, data: { code, name: data.name, dueDate: data.dueDate ? isoToDate(data.dueDate) : null, remark: data.remark?.trim() || null } });
    await logActivity({ userId, action: "UPDATE", entity: "PART_GROUP", entityId: id, detail: `Work order ${g.code} — ${g.name}` });
  } catch (e) {
    if (isUnique(e)) throw new PartGroupingError(`A work order with code ${code} already exists in this project`, 409);
    throw e;
  }
}

/** Deleting only removes the label: the parts stay in the take-off, just without a scope / work order. */
export async function deleteGrouping(kind: GroupingKind, id: string, userId: string) {
  if (kind === "scope") {
    const s = await prisma.scopeItem.findUnique({ where: { id }, select: { description: true } });
    if (!s) throw new PartGroupingError("Scope not found", 404);
    await prisma.scopeItem.delete({ where: { id } });
    await logActivity({ userId, action: "DELETE", entity: "SCOPE_ITEM", entityId: id, detail: s.description });
    return;
  }
  const g = await prisma.workOrderGroup.findUnique({ where: { id }, select: { code: true, name: true } });
  if (!g) throw new PartGroupingError("Work order not found", 404);
  await prisma.workOrderGroup.delete({ where: { id } });
  await logActivity({ userId, action: "DELETE", entity: "PART_GROUP", entityId: id, detail: `Work order ${g.code} — ${g.name}` });
}

// ------------------------------------------------------------------------------------------------ moving parts

export async function assignGrouping(data: AssignGroupingInput, userId: string): Promise<{ assigned: number }> {
  const ids = [...new Set(data.partIds)];
  const found = await prisma.takeoffPart.count({ where: { id: { in: ids }, drawing: { projectId: data.projectId } } });
  if (found !== ids.length) throw new PartGroupingError("Some of the selected parts do not belong to this project", 409);

  if (data.targetId) {
    const target = data.kind === "scope"
      ? await prisma.scopeItem.findUnique({ where: { id: data.targetId }, select: { projectId: true } })
      : await prisma.workOrderGroup.findUnique({ where: { id: data.targetId }, select: { projectId: true } });
    if (!target || target.projectId !== data.projectId) throw new PartGroupingError(`That ${data.kind === "scope" ? "scope" : "work order"} does not belong to this project`, 409);
  }
  await prisma.takeoffPart.updateMany({
    where: { id: { in: ids } },
    data: data.kind === "scope" ? { scopeId: data.targetId } : { workOrderGroupId: data.targetId },
  });
  await logActivity({
    userId, action: "UPDATE", entity: data.kind === "scope" ? "SCOPE_ITEM" : "PART_GROUP", entityId: data.targetId ?? data.projectId,
    detail: `${ids.length} part${ids.length === 1 ? "" : "s"} ${data.targetId ? "added to" : "taken out of"} a ${data.kind === "scope" ? "scope" : "work order"}`,
  });
  return { assigned: ids.length };
}
