import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { applyUndoRedo, peekUndo, UndoError } from "@/server/services/part-undo.service";

// What Ctrl+Z / Ctrl+Y would do for the signed-in person in a project (the toolbar shows the labels).
export async function GET(req: NextRequest) {
  const { session, res } = await requirePermission("takeoff.view");
  if (res) return res;
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  return NextResponse.json(await peekUndo(session!.user.id, projectId));
}

// One step back or forward. `entryId` = a specific step (the toast's "Undo"); otherwise the next one in the person's stack.
export async function POST(req: NextRequest) {
  const { session, res } = await requirePermission("takeoff.edit");
  if (res) return res;
  const body = (await req.json().catch(() => null)) as { projectId?: unknown; direction?: unknown; entryId?: unknown } | null;
  if (typeof body?.projectId !== "string" || (body.direction !== "undo" && body.direction !== "redo")) {
    return NextResponse.json({ error: "projectId and direction (undo | redo) are required" }, { status: 400 });
  }
  try {
    const r = await applyUndoRedo(session!.user.id, body.projectId, body.direction, typeof body.entryId === "string" ? body.entryId : undefined);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    if (err instanceof UndoError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[undo] failed", err);
    return NextResponse.json({ error: "Could not apply this step" }, { status: 500 });
  }
}
