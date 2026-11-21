import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle } from "@/server/api/estimation-route";
import { compareSchema } from "@/server/validators/estimation";
import { compareVersions } from "@/server/services/estimation.service";

// GET ?from=<snapshotId>&to=<snapshotId> → the cost build-up difference between two snapshots of this project's sheet.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requirePermission("pricing.view");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    const q = req.nextUrl.searchParams;
    const { from, to } = compareSchema.parse({ from: q.get("from"), to: q.get("to") });
    return NextResponse.json(await compareVersions(id, from, to));
  });
}
