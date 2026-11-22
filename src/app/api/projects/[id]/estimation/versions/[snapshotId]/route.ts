import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle } from "@/server/api/estimation-route";
import { snapshotIdSchema } from "@/server/validators/estimation";
import { getSnapshot } from "@/server/services/estimation.service";

// GET → one stored snapshot in full (inputs + result + verified flag): exactly what was calculated or approved.
// 404 when the snapshot does not belong to this project's sheet (the id from the URL is never trusted on its own).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; snapshotId: string }> }) {
  const { res } = await requirePermission("pricing.view");
  if (res) return res;
  return handle(async () => {
    const { id, snapshotId } = await params;
    return NextResponse.json(await getSnapshot(id, snapshotIdSchema.parse(snapshotId)));
  });
}
