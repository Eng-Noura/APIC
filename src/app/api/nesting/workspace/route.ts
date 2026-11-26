import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { prisma } from "@/server/db/client";
import { getWorkspace, getWorkspaceVersion, saveWorkspace, type WorkspaceKind } from "@/server/services/nesting-workspace.service";
import { getHistoryData, saveHistoryData } from "@/server/services/nesting-history.service";
import { applyNestSideEffects, overlayForRead, splitRemovals } from "@/server/services/nest-link.service";

const kindOf = (v: unknown): WorkspaceKind | null => (v === "2D" || v === "1D" ? v : null);

// `projectId` = the workspace of a project; `historyId` = an entry of the signed-in user's nesting history.
export async function GET(req: NextRequest) {
  const { session, res } = await requirePermission("takeoff.view");
  if (res) return res;
  const projectId = req.nextUrl.searchParams.get("projectId");
  const historyId = req.nextUrl.searchParams.get("historyId");
  const kind = kindOf(req.nextUrl.searchParams.get("kind"));
  if ((!projectId && !historyId) || !kind) return NextResponse.json({ error: "projectId (or historyId) and kind are required" }, { status: 400 });
  if (historyId) {
    const h = await getHistoryData(session!.user.id, historyId, kind);
    if (h === undefined) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(h.data ? { data: h.data, updatedAt: h.updatedAt } : { data: null });
  }
  // ?versionOnly=1: a cheap poll so an open tab notices that the nest was changed from the BOQ
  if (req.nextUrl.searchParams.get("versionOnly") === "1") return NextResponse.json({ version: await getWorkspaceVersion(projectId!, kind) });
  const ws = await getWorkspace(projectId!, kind);
  // One part = one thing: the nest shows the Part List's name and specs, whatever was stored in the snapshot
  return NextResponse.json(ws ? { data: await overlayForRead(projectId!, kind, ws.dataJson), updatedAt: ws.updatedAt, version: ws.version } : { data: null, version: null });
}

export async function PUT(req: NextRequest) {
  const { session, res } = await requirePermission("takeoff.edit");
  if (res) return res;
  const body = await req.json().catch(() => null);
  const kind = kindOf(body?.kind);
  const projectId = typeof body?.projectId === "string" && body.projectId ? body.projectId : null;
  const historyId = typeof body?.historyId === "string" && body.historyId ? body.historyId : null;
  if ((!projectId && !historyId) || !kind || body?.data == null) {
    return NextResponse.json({ error: "projectId (or historyId), kind and data are required" }, { status: 400 });
  }
  if (historyId) {
    // a history entry has no Part List behind it: the removal list is only meaningful for a project
    if (!(await saveHistoryData(session!.user.id, historyId, kind, splitRemovals(body.data).data))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, updatedAt: new Date().toISOString() });
  }
  const userId = session!.user.id;
  const baseVersion = Number.isInteger(body?.baseVersion) ? (body.baseVersion as number) : undefined;
  // The tool lists the parts the person removed (`removedIds`); they leave the snapshot and are deleted from the Part List below.
  const { data, ids: removedIds } = splitRemovals(body.data);
  const previous = removedIds.length ? await getWorkspace(projectId!, kind) : null;
  const saved = await saveWorkspace(projectId!, kind, data, userId, baseVersion);
  // 409: the nest changed on the server since this tab loaded it (e.g. a quantity synced from the BOQ)
  if (!saved.ok) {
    // say who wrote the newer copy: "Ahmed saved at 10:48" (or "you, in another tab / from the Part List")
    const by = saved.updatedById ? await prisma.user.findUnique({ where: { id: saved.updatedById }, select: { name: true } }) : null;
    return NextResponse.json({ error: "STALE", version: saved.version, by: by?.name ?? null, byMe: saved.updatedById === userId, at: saved.updatedAt }, { status: 409 });
  }

  // Nest -> Part List: removed parts are deleted there, name / spec edits are written to the part, quantities are synced.
  let effects = { deleted: 0, blocked: 0, updated: 0 };
  try {
    effects = await applyNestSideEffects({ projectId: projectId!, kind, userId, data, removedIds, previousData: previous?.dataJson });
    const { autoSyncAfterBoqChange } = await import("@/server/services/nest-sync.service");
    await autoSyncAfterBoqChange(projectId!, userId);
  } catch (e) {
    console.error("[nesting/workspace] carrying the nest changes into the Part List failed", e); // the save itself succeeded
  }
  // `version` stays the one of THIS save: if the server wrote into the nest afterwards (quantity push), the tab notices and reloads
  return NextResponse.json({ ok: true, updatedAt: saved.updatedAt, version: saved.version, ...effects });
}
