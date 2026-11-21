import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, readJson } from "@/server/api/estimation-route";
import { restoreLineSchema } from "@/server/validators/estimation";
import { restoreMaterialLine } from "@/server/services/estimation.service";

// POST { materialId } → puts one automatic material line back to its imported purchased kg and default price source.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    const { materialId } = restoreLineSchema.parse(await readJson(req));
    return NextResponse.json(await restoreMaterialLine(id, materialId, session!.user.id));
  });
}
