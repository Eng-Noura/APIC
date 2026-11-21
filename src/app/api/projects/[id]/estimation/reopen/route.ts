import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, readJson } from "@/server/api/estimation-route";
import { reopenSchema } from "@/server/validators/estimation";
import { reopenSheet } from "@/server/services/estimation.service";

// POST { reason } → APPROVED → DRAFT with version + 1. The approved snapshot and offers made from it stay untouched. Needs pricing.approve.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, res } = await requirePermission("pricing.approve");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    const { reason } = reopenSchema.parse(await readJson(req));
    return NextResponse.json(await reopenSheet(id, { id: session!.user.id, role: session!.user.role }, reason));
  });
}
