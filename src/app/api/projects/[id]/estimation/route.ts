import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle } from "@/server/api/estimation-route";
import { can } from "@/server/rbac/permissions";
import { saveEstimateSchema } from "@/server/validators/estimation";
import { getEstimateView, getSavedEstimate, saveEstimate } from "@/server/services/estimation.service";

// GET → the project's estimate. Editors get it synchronised with Part List / Nesting first; view-only roles see what is saved.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, res } = await requirePermission("pricing.view");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    const doc = can(session!.user.role, "pricing.edit") ? await getEstimateView(id, session!.user.id) : await getSavedEstimate(id);
    return NextResponse.json(doc);
  });
}

// PUT → saves the inputs (never totals) and returns the server's recalculation.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    let body: unknown;
    try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
    const input = saveEstimateSchema.parse(body);
    return NextResponse.json(await saveEstimate(id, input, session!.user.id));
  });
}
