import { prisma } from "@/server/db/client";

export async function logActivity(params: {
  userId: string;
  action: "CREATE" | "UPDATE" | "DELETE" | "LOGIN" | "ACTIVATE" | "DEACTIVATE" | "RESET_PASSWORD";
  entity: "PROJECT" | "CUSTOMER" | "DOCUMENT" | "USER" | "SETTINGS" | "TAKEOFF_DRAWING" | "TAKEOFF_PART" | "SCOPE_ITEM" | "NOTICE" | "MEETING_MINUTE" | "PART_DXF" | "NESTING_JOB" | "NESTING_JOB_ITEM" | "NESTING_SOURCE" | "NESTING_RUN" | "PLAN_SCHEDULE" | "PLAN_ACTIVITY" | "PLAN_WBS" | "PLAN_MATERIAL" | "QUOTATION" | "SUPPLIER" | "PURCHASE_ORDER" | "GOODS_RECEIPT" | "STOCK_ITEM" | "WORK_ORDER" | "PART_GROUP";
  entityId?: string;
  detail?: string;
  projectId?: string;
}) {
  return prisma.activityLog.create({ data: params });
}

export async function getRecentActivity(take = 8) {
  return prisma.activityLog.findMany({
    orderBy: { timestamp: "desc" },
    take,
    include: { user: { select: { name: true, role: true } } },
  });
}

export interface PartEvent {
  partId: string;
  action: "CREATE" | "UPDATE" | "DELETE";
  /** what happened, in words a person can read ("qty 2 → 4", "added to assembly A1") */
  detail: string;
}

/**
 * One log line per part, so every part has its own history: who did what and when. Used for every way a part can
 * change (typed in the Part List, quantity from an assembly or from a nest, group assignment, DXF, delete, restore).
 * A failure to write the log is reported but never blocks the work itself.
 */
export async function logPartEvents(userId: string, projectId: string | null, events: PartEvent[]): Promise<void> {
  if (!events.length) return;
  try {
    await prisma.activityLog.createMany({
      data: events.map((e) => ({ userId, projectId, entity: "TAKEOFF_PART", entityId: e.partId, action: e.action, detail: e.detail })),
    });
  } catch (err) {
    console.error("[activity] could not record the part history", err);
  }
}

const PROJECT_FEED_ENTITIES = ["TAKEOFF_PART", "TAKEOFF_DRAWING", "PART_GROUP", "SCOPE_ITEM", "NESTING_RUN", "PART_DXF"];

/** Who did what and when in a project's Part List — or, with `partId`, the history of one part (also after it was deleted). */
export async function listTakeoffActivity(projectId: string, partId: string | null, take = 200) {
  const rows = await prisma.activityLog.findMany({
    where: partId
      ? { entityId: partId, entity: "TAKEOFF_PART", OR: [{ projectId }, { projectId: null }] }
      : { projectId, entity: { in: PROJECT_FEED_ENTITIES } },
    orderBy: { timestamp: "desc" },
    take: Math.min(Math.max(take, 1), 500),
    include: { user: { select: { name: true, role: true } } },
  });
  return rows.map((r) => ({
    id: r.id, timestamp: r.timestamp, action: r.action, entity: r.entity, detail: r.detail,
    userName: r.user.name, userRole: r.user.role,
  }));
}
