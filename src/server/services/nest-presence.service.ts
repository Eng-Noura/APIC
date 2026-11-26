import { prisma } from "@/server/db/client";
import { activeOthers, HERE_MS, type Other } from "@/server/calc/nest-presence";
import type { WorkspaceKind } from "./nesting-workspace.service";

/** A heartbeat from an open nest tab. Returns the other people who have the same nest open. */
export async function beat(projectId: string, kind: WorkspaceKind, userId: string, editing: boolean): Promise<Other[]> {
  const now = new Date();
  await prisma.nestingPresence.upsert({
    where: { projectId_kind_userId: { projectId, kind, userId } },
    update: { lastSeenAt: now, ...(editing ? { lastEditAt: now } : {}) },
    create: { projectId, kind, userId, lastSeenAt: now, lastEditAt: editing ? now : null },
  });
  if (Math.random() < 0.05) await prisma.nestingPresence.deleteMany({ where: { lastSeenAt: { lt: new Date(Date.now() - 24 * 3600 * 1000) } } }); // housekeeping
  const rows = await prisma.nestingPresence.findMany({
    where: { projectId, kind, userId: { not: userId }, lastSeenAt: { gte: new Date(Date.now() - HERE_MS) } },
    select: { userId: true, lastSeenAt: true, lastEditAt: true },
  });
  if (!rows.length) return [];
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true } });
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  return activeOthers(rows.map((r) => ({ ...r, name: nameOf.get(r.userId) ?? "Someone" })), userId);
}

/** The tab was closed: the person is no longer here. */
export async function leave(projectId: string, kind: WorkspaceKind, userId: string): Promise<void> {
  await prisma.nestingPresence.deleteMany({ where: { projectId, kind, userId } });
}
