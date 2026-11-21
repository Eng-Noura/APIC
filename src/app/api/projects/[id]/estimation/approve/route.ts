import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle } from "@/server/api/estimation-route";
import { approveSheet } from "@/server/services/estimation.service";

// POST → CALCULATED → APPROVED. Approves exactly what was calculated (refused if anything changed since). Needs pricing.approve.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, res } = await requirePermission("pricing.approve");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    return NextResponse.json(await approveSheet(id, { id: session!.user.id, role: session!.user.role }));
  });
}
