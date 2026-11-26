import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { beat, leave } from "@/server/services/nest-presence.service";

// Heartbeat of an open nest tab: { projectId, kind, editing } -> the other people who have the same nest open.
// { leave: true } (sent when the tab closes) removes the person right away.
export async function POST(req: NextRequest) {
  const { session, res } = await requirePermission("takeoff.view");
  if (res) return res;
  const body = (await req.json().catch(() => null)) as { projectId?: unknown; kind?: unknown; editing?: unknown; leave?: unknown } | null;
  if (typeof body?.projectId !== "string" || (body.kind !== "2D" && body.kind !== "1D")) return NextResponse.json({ error: "projectId and kind are required" }, { status: 400 });
  if (body.leave === true) { await leave(body.projectId, body.kind, session!.user.id); return NextResponse.json({ ok: true }); }
  return NextResponse.json({ others: await beat(body.projectId, body.kind, session!.user.id, body.editing === true) });
}
