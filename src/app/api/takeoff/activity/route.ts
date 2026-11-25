import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { listTakeoffActivity } from "@/server/services/activity-log.service";

// Who added / changed / deleted what in the Part List, and when. `partId` = the history of one part.
export async function GET(req: NextRequest) {
  const { res } = await requirePermission("takeoff.view");
  if (res) return res;
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  const partId = req.nextUrl.searchParams.get("partId");
  const take = Number(req.nextUrl.searchParams.get("take")) || 200;
  return NextResponse.json(await listTakeoffActivity(projectId, partId, take));
}
