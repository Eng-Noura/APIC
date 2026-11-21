import { NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle } from "@/server/api/pricing-route";
import { calculateSheet } from "@/server/services/pricing.service";

export async function POST(_req: Request, { params }: { params: Promise<{ sheetId: string }> }) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { sheetId } = await params;
    return NextResponse.json({ totals: await calculateSheet(sheetId, session!.user.id) });
  });
}
