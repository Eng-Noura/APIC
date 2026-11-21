import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle } from "@/server/api/estimation-route";
import { auditQuerySchema } from "@/server/validators/estimation";
import { listAudit } from "@/server/services/estimation.service";

// GET ?take=100 → the sheet's field-level audit trail, newest first.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requirePermission("pricing.view");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    const { take } = auditQuerySchema.parse({ take: req.nextUrl.searchParams.get("take") ?? undefined });
    return NextResponse.json({ entries: await listAudit(id, take) });
  });
}
