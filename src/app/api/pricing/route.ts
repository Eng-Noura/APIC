import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, parseBody } from "@/server/api/pricing-route";
import { createSheetSchema } from "@/server/validators/pricing";
import { createSheet, findCurrentSheet, getSheetView } from "@/server/services/pricing.service";

// GET /api/pricing?projectId=… → the project's current pricing sheet (computed from live data), or { sheet: null }.
export async function GET(req: NextRequest) {
  const { res } = await requirePermission("pricing.view");
  if (res) return res;
  return handle(async () => {
    const projectId = req.nextUrl.searchParams.get("projectId");
    if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    const cur = await findCurrentSheet(projectId);
    return NextResponse.json(cur ? await getSheetView(cur.id) : { sheet: null });
  });
}

export async function POST(req: Request) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { projectId } = await parseBody(req, createSheetSchema);
    const id = await createSheet(projectId, session!.user.id);
    return NextResponse.json(await getSheetView(id), { status: 201 });
  });
}
