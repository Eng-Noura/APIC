import { prisma } from "@/server/db/client";
import type { ProjectInput } from "@/server/validators/project";
import { logActivity } from "./activity-log.service";

export async function listProjects() {
  return prisma.project.findMany({
    include: { customer: true, createdBy: { select: { name: true } }, _count: { select: { documents: true } } },
    orderBy: { createdAt: "desc" },
  });
}

export async function getProject(id: string) {
  return prisma.project.findUnique({
    where: { id },
    include: {
      customer: true,
      createdBy: { select: { name: true, email: true } },
      documents: { orderBy: { uploadDate: "desc" }, include: { uploadedBy: { select: { name: true } } } },
      scopeItems: { orderBy: { createdAt: "desc" }, include: { createdBy: { select: { name: true } } } },
      notices: { orderBy: { noticeDate: "desc" }, include: { createdBy: { select: { name: true } } } },
      meetingMinutes: { orderBy: { meetingDate: "desc" }, include: { createdBy: { select: { name: true } } } },
    },
  });
}

export async function createProject(data: ProjectInput, userId: string) {
  const project = await prisma.project.create({
    data: {
      number: data.number,
      name: data.name,
      customerId: data.customerId,
      description: data.description || null,
      stage: data.stage,
      status: data.status,
      revision: data.revision,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
      createdById: userId,
    },
  });
  await logActivity({ userId, action: "CREATE", entity: "PROJECT", entityId: project.id, detail: project.number });
  return project;
}

export async function updateProject(id: string, data: ProjectInput, userId: string) {
  const project = await prisma.project.update({
    where: { id },
    data: {
      number: data.number,
      name: data.name,
      customerId: data.customerId,
      description: data.description || null,
      stage: data.stage,
      status: data.status,
      revision: data.revision,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
      startDate: data.startDate ? new Date(data.startDate) : null,
      endDate: data.endDate ? new Date(data.endDate) : null,
    },
  });
  await logActivity({ userId, action: "UPDATE", entity: "PROJECT", entityId: project.id, detail: project.number });
  return project;
}

export async function renameProject(id: string, name: string, userId: string) {
  const exists = await prisma.project.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return null;
  const project = await prisma.project.update({ where: { id }, data: { name }, select: { id: true, name: true, number: true } });
  await logActivity({ userId, action: "UPDATE", entity: "PROJECT", entityId: id, detail: `${project.number} (renamed)` });
  return project;
}

export async function deleteProject(id: string, userId: string) {
  const project = await prisma.project.delete({ where: { id } });
  await logActivity({ userId, action: "DELETE", entity: "PROJECT", entityId: id, detail: project.number });
  return project;
}

export async function projectStats() {
  const [total, tendering, inProgress, onHold, completed, submitted, archived] = await Promise.all([
    prisma.project.count(),
    prisma.project.count({ where: { stage: "TENDERING" } }),
    prisma.project.count({ where: { status: "IN_PROGRESS" } }),
    prisma.project.count({ where: { status: "ON_HOLD" } }),
    prisma.project.count({ where: { status: "COMPLETED" } }),
    prisma.project.count({ where: { status: "SUBMITTED" } }),
    prisma.project.count({ where: { status: "ARCHIVED" } }),
  ]);
  return { total, tendering, inProgress, onHold, completed, submitted, archived };
}

/**
 * Duplicate a project into an independent copy with a new name.
 * Copies: project details, Nesting workspaces (2D + 1D), Take-off (drawings, parts, DXF records),
 * assemblies (PartGroup), work-order groups and scope items — with every link re-pointed to the NEW rows,
 * so editing one project never touches the other.
 * Not copied: documents/files, quotations, pricing, planning, estimation, purchasing, work orders, notices, minutes.
 */
export async function duplicateProject(sourceId: string, name: string, userId: string) {
  const src = await prisma.project.findUnique({
    where: { id: sourceId },
    include: {
      nestingWorkspaces: true,
      partGroups: true,
      workOrderGroups: true,
      scopeItems: true,
      takeoffDrawings: { include: { parts: { include: { dxf: true } } } },
    },
  });
  if (!src) return null;

  const cleanName = name.trim().slice(0, 120);
  const base = `${src.number}-COPY`;

  return prisma.$transaction(
    async (tx) => {
      // Project.number is unique: -COPY, -COPY2, -COPY3 ...
      let number = base;
      for (let i = 2; await tx.project.findUnique({ where: { number }, select: { id: true } }); i++) number = `${base}${i}`;

      const project = await tx.project.create({
        data: {
          number,
          name: cleanName,
          description: src.description,
          stage: src.stage,
          status: src.status,
          revision: src.revision,
          dueDate: src.dueDate,
          startDate: src.startDate,
          endDate: src.endDate,
          customerId: src.customerId,
          createdById: userId,
        },
      });

      // Nesting workspaces (the nest shown in "Nesting & Costing").
      for (const w of src.nestingWorkspaces) {
        await tx.nestingWorkspace.create({
          data: { projectId: project.id, kind: w.kind, dataJson: w.dataJson as object, updatedById: userId },
        });
      }

      // Assemblies: create first, then re-link parents.
      const groupMap = new Map<string, string>();
      for (const g of src.partGroups) {
        const c = await tx.partGroup.create({
          data: { projectId: project.id, code: g.code, name: g.name, dwgNo: g.dwgNo, qty: g.qty, remark: g.remark, sortOrder: g.sortOrder },
        });
        groupMap.set(g.id, c.id);
      }
      for (const g of src.partGroups) {
        if (g.parentId) await tx.partGroup.update({ where: { id: groupMap.get(g.id)! }, data: { parentId: groupMap.get(g.parentId) ?? null } });
      }

      const woMap = new Map<string, string>();
      for (const w of src.workOrderGroups) {
        const c = await tx.workOrderGroup.create({
          data: { projectId: project.id, code: w.code, name: w.name, dueDate: w.dueDate, remark: w.remark, sortOrder: w.sortOrder },
        });
        woMap.set(w.id, c.id);
      }

      const scopeMap = new Map<string, string>();
      for (const s of src.scopeItems) {
        const c = await tx.scopeItem.create({ data: { projectId: project.id, description: s.description, createdById: userId } });
        scopeMap.set(s.id, c.id);
      }

      // Take-off drawings, parts and their DXF records.
      for (const d of src.takeoffDrawings) {
        const nd = await tx.takeoffDrawing.create({
          data: { projectId: project.id, drawingNumber: d.drawingNumber, title: d.title, weightFromDwg: d.weightFromDwg, sortOrder: d.sortOrder },
        });
        for (const p of d.parts) {
          const np = await tx.takeoffPart.create({
            data: {
              drawingId: nd.id,
              itemNo: p.itemNo,
              description: p.description,
              material: p.material,
              partType: p.partType,
              side: p.side,
              qty: p.qty,
              thicknessMm: p.thicknessMm,
              geometry: p.geometry as object,
              areaFormula: p.areaFormula,
              paintSides: p.paintSides,
              totalArea: p.totalArea,
              volume: p.volume,
              weightKg: p.weightKg,
              paintAreaSqm: p.paintAreaSqm,
              buyWeightKg: p.buyWeightKg,
              scrapKg: p.scrapKg,
              scrapPct: p.scrapPct,
              groupId: p.groupId ? groupMap.get(p.groupId) ?? null : null,
              posNo: p.posNo,
              qtyPerAssembly: p.qtyPerAssembly,
              remark: p.remark,
              scopeId: p.scopeId ? scopeMap.get(p.scopeId) ?? null : null,
              workOrderGroupId: p.workOrderGroupId ? woMap.get(p.workOrderGroupId) ?? null : null,
              nestKind: p.nestKind,
              nestPartId: p.nestPartId,
              nestSyncedQty: p.nestSyncedQty,
              nestSyncedAt: p.nestSyncedAt,
            },
          });
          if (p.dxf) {
            const x = p.dxf;
            await tx.partDxf.create({
              data: {
                takeoffPartId: np.id,
                uploadedById: userId,
                fileName: x.fileName,
                filePath: x.filePath,
                fileSize: x.fileSize,
                valid: x.valid,
                errorMessage: x.errorMessage,
                unitsDetected: x.unitsDetected,
                areaSqm: x.areaSqm,
                bboxWidthMm: x.bboxWidthMm,
                bboxHeightMm: x.bboxHeightMm,
                outerContourCount: x.outerContourCount,
                holeCount: x.holeCount,
                unitsWarning: x.unitsWarning,
                geometryJson: (x.geometryJson as object) ?? undefined,
              },
            });
          }
        }
      }

      await logActivity({ userId, action: "CREATE", entity: "PROJECT", entityId: project.id, detail: `${project.number} (duplicated from ${src.number})` });
      return project;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}
