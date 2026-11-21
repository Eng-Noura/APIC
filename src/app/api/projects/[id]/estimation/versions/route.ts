import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle } from "@/server/api/estimation-route";
import { listVersions } from "@/server/services/estimation.service";

// GET → the stored snapshots (CALCULATED and APPROVED), newest first, each flagged verified when recomputing its inputs gives its result.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requirePermission("pricing.view");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    return NextResponse.json({ versions: await listVersions(id) });
  });
}
