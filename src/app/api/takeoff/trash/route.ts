import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { listTrash } from "@/server/services/part-trash.service";

// The deleted parts of a project that can still be restored (kept 30 days).
export async function GET(req: NextRequest) {
  const { res } = await requirePermission("takeoff.view");
  if (res) return res;
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  return NextResponse.json(await listTrash(projectId));
}
