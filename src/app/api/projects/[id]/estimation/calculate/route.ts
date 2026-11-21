import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle } from "@/server/api/estimation-route";
import { calculateSheet } from "@/server/services/estimation.service";

// POST → synchronises with Part List / Nesting / Procurement, recalculates on the server and stores an immutable snapshot.
// DRAFT/CALCULATED → CALCULATED. Refused while the sheet is APPROVED or has error-level issues.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    return NextResponse.json(await calculateSheet(id, session!.user.id));
  });
}
