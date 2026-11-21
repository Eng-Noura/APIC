import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { getScrapSourceGroups, ScrapManagementError } from "@/server/services/scrap-management.service";

// GET /api/scrap-management?nestingRunId=… → the nesting run grouped by source (no prices).
// The page applies the user's prices/percentages on the client with the shared calc engine.
export async function GET(req: NextRequest) {
  const { res } = await requirePermission("scrapPricing.view");
  if (res) return res;

  const nestingRunId = req.nextUrl.searchParams.get("nestingRunId");
  if (!nestingRunId) return NextResponse.json({ error: "nestingRunId is required" }, { status: 400 });
  try {
    return NextResponse.json({ nestingRunId, groups: await getScrapSourceGroups(nestingRunId) });
  } catch (err) {
    if (err instanceof ScrapManagementError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
