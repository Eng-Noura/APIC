import { prisma } from "@/server/db/client";
import { computeTakeoffPart, buildDefaultAreaFormula } from "@/server/calc/takeoff";
import type { TakeoffDrawingInput, TakeoffPartInputData } from "@/server/validators/takeoff";
import { logActivity } from "./activity-log.service";
import { describeChanges } from "@/server/calc/part-changes";
import { resolvePartQty } from "./part-group.service";

// computeTakeoffPart() returns a `formulaError` field for the UI's benefit —
// it isn't a persisted column, so it's stripped out before every write.
// The area formula is resolved to whatever was actually used (falling back
// to the type's default) so the stored value always matches the numbers,
// and stays editable Excel-style afterwards.
function persistedFields(data: TakeoffPartInputData, qty: number) {
  const resolvedAreaFormula = data.partType === "HOT_ROLLED" || data.partType === "ACCESSORY"
    ? null
    : (data.areaFormula?.trim() || buildDefaultAreaFormula(data.partType, data.geometry));
  const { formulaError: _formulaError, unitArea: _unitArea, ...computed } = computeTakeoffPart({
    partType: data.partType,
    geometry: data.geometry,
    qty,
    thicknessMm: data.thicknessMm ?? null,
    paintSides: data.paintSides,
    areaFormula: resolvedAreaFormula,
    buyWeightKg: data.buyWeightKg,
  });
  return { resolvedAreaFormula, computed };
}

async function projectOfDrawing(drawingId: string) {
  const drawing = await prisma.takeoffDrawing.findUnique({ where: { id: drawingId }, select: { projectId: true } });
  if (!drawing) throw new Error("NOT_FOUND");
  return drawing.projectId;
}

export async function listDrawingsForProject(projectId: string) {
  return prisma.takeoffDrawing.findMany({
    where: { projectId },
    include: { parts: { orderBy: { itemNo: "asc" }, include: { dxf: true } } },
    orderBy: { sortOrder: "asc" },
  });
}

export async function createDrawing(data: TakeoffDrawingInput, userId: string) {
  const count = await prisma.takeoffDrawing.count({ where: { projectId: data.projectId } });
  const drawing = await prisma.takeoffDrawing.create({
    data: {
      projectId: data.projectId,
      drawingNumber: data.drawingNumber,
      title: data.title,
      weightFromDwg: data.weightFromDwg ?? null,
      sortOrder: count,
    },
  });
  await logActivity({
    userId,
    action: "CREATE",
    entity: "TAKEOFF_DRAWING",
    entityId: drawing.id,
    projectId: drawing.projectId,
    detail: `Drawing added: ${drawing.drawingNumber} — ${drawing.title}`,
  });
  return drawing;
}

export async function deleteDrawing(id: string, userId: string) {
  const doomed = await prisma.takeoffPart.findMany({ where: { drawingId: id }, select: { id: true, nestKind: true, nestPartId: true } });
  const drawing = await prisma.takeoffDrawing.delete({ where: { id } });
  if (doomed.length) await (await import("./nest-link.service")).removePartsFromNests(drawing.projectId, userId, doomed);
  await logActivity({
    userId,
    action: "DELETE",
    entity: "TAKEOFF_DRAWING",
    entityId: id,
    projectId: drawing.projectId,
    detail: `Drawing deleted: ${drawing.drawingNumber} — ${drawing.title} (${doomed.length} part(s), not kept in the Trash)`,
  });
  return drawing;
}

// A grouped part's quantity is always derived from its assembly (group qty x qtyPerAssembly); the qty the client
// sent only counts for an ungrouped part.
export async function createPart(data: TakeoffPartInputData, userId: string) {
  const groupId = data.groupId ?? null;
  const qtyPerAssembly = data.qtyPerAssembly ?? 1;
  const qty = groupId ? await resolvePartQty(await projectOfDrawing(data.drawingId), groupId, qtyPerAssembly, data.qty) : data.qty;
  const { resolvedAreaFormula, computed } = persistedFields(data, qty);
  const part = await prisma.takeoffPart.create({
    data: {
      drawingId: data.drawingId, itemNo: data.itemNo, description: data.description, material: data.material ?? null,
      partType: data.partType, side: data.side,
      groupId, posNo: data.posNo?.trim() || null, qtyPerAssembly, remark: data.remark?.trim() || null,
      qty, thicknessMm: data.thicknessMm ?? null, geometry: data.geometry, areaFormula: resolvedAreaFormula,
      paintSides: data.paintSides, ...computed,
    },
  });
  await logActivity({
    userId, action: "CREATE", entity: "TAKEOFF_PART", entityId: part.id, projectId: await projectOfDrawing(part.drawingId),
    detail: `Added "${part.description}" — ${part.partType}, qty ${part.qty}`,
  });
  return part;
}

export async function updatePart(id: string, data: TakeoffPartInputData, userId: string) {
  const existing = await prisma.takeoffPart.findUnique({
    where: { id },
    select: {
      drawingId: true, groupId: true, qtyPerAssembly: true, posNo: true, remark: true, qty: true, nestPartId: true,
      description: true, itemNo: true, partType: true, side: true, thicknessMm: true, material: true, paintSides: true, areaFormula: true, geometry: true,
    },
  });
  if (!existing) throw new Error("NOT_FOUND");

  // Fields left out of the payload keep their stored value; groupId: null un-groups.
  const groupId = data.groupId === undefined ? existing.groupId : data.groupId;
  const qtyPerAssembly = data.qtyPerAssembly ?? existing.qtyPerAssembly;
  const posNo = data.posNo === undefined ? existing.posNo : data.posNo?.trim() || null;
  const remark = data.remark === undefined ? existing.remark : data.remark?.trim() || null;

  const qty = groupId ? await resolvePartQty(await projectOfDrawing(existing.drawingId), groupId, qtyPerAssembly, data.qty) : data.qty;
  const { resolvedAreaFormula, computed } = persistedFields(data, qty);
  const part = await prisma.takeoffPart.update({
    where: { id },
    data: {
      itemNo: data.itemNo, description: data.description, material: data.material ?? null,
      partType: data.partType, side: data.side,
      groupId, posNo, qtyPerAssembly, remark,
      qty, thicknessMm: data.thicknessMm ?? null, geometry: data.geometry, areaFormula: resolvedAreaFormula,
      paintSides: data.paintSides, ...computed,
    },
  });
  const projectId = await projectOfDrawing(existing.drawingId);
  // who changed what, and when: one line with the old and the new values (nothing is written when nothing changed)
  const changes = describeChanges(existing, part);
  if (changes.length) {
    await logActivity({ userId, action: "UPDATE", entity: "TAKEOFF_PART", entityId: part.id, projectId, detail: `"${part.description}": ${changes.join(", ")}` });
  }
  // One part = one thing: the nests show this part's name / specs, so write them into the saved 2D / 1D nests too
  // (best effort, never fails the edit; a nest that is open in a tab reloads itself when it notices the new version).
  if (existing.nestPartId !== null || part.partType === "HOT_ROLLED" || part.partType === "PIPE") {
    await (await import("./nest-link.service")).pushSpecsToNestSafe(projectId, userId);
  }
  // a quantity changed on a plate that came from the nest: carry it over (best effort, never fails the edit)
  if (existing.nestPartId !== null && existing.qty !== qty) {
    await (await import("./nest-sync.service")).autoSyncAfterBoqChange(projectId, userId);
  }
  return part;
}

// Narrow, dependency-light check for a Prisma known-request-error code —
// avoids importing the `Prisma` namespace class just for an instanceof
// check, so this keeps working across Prisma client versions/generation
// states.
function isPrismaErrorCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === code;
}

export async function deletePart(id: string, userId: string) {
  let part;
  // a copy goes to the trash first, so a wrong delete can be undone (see part-trash.service.ts)
  const trash = await import("./part-trash.service");
  const trashId = await trash.trashPart(id, userId).catch((e) => { console.error("[trash] could not keep a copy", e); return null; });
  try {
    part = await prisma.takeoffPart.delete({ where: { id } });
  } catch (err) {
    await trash.dropTrash(trashId);
    // NestingPlacement.takeoffPart uses onDelete: Restrict — a part that
    // has ever been placed in a nesting run must not be deletable out from
    // under historical results (see schema comment on NestingPlacement).
    // Surface that as a clear, actionable error instead of a raw FK message.
    if (isPrismaErrorCode(err, "P2003")) {
      throw new Error("This part is used in a nesting job and cannot be deleted.");
    }
    // Record not found (already deleted / bad id) — let the caller map this
    // to a 404 rather than a generic failure.
    if (isPrismaErrorCode(err, "P2025")) {
      throw new Error("NOT_FOUND");
    }
    throw err;
  }
  const projectId = await projectOfDrawing(part.drawingId).catch(() => null);
  await logActivity({
    userId,
    action: "DELETE",
    entity: "TAKEOFF_PART",
    entityId: id,
    ...(projectId ? { projectId } : {}),
    detail: `Deleted "${part.description}" — qty ${part.qty}${trashId ? " (kept in the Trash for 30 days)" : ""}`,
  });
  // One part = one thing: it must not stay behind in the 2D / 1D nest (and be taken back into the Part List from there)
  if (projectId) await (await import("./nest-link.service")).removePartsFromNests(projectId, userId, [part]);
  return { ...part, trashId };
}
