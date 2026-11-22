import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, readOptionalJson } from "@/server/api/estimation-route";
import { can } from "@/server/rbac/permissions";
import { createOfferSchema } from "@/server/validators/estimation";
import { createOffer } from "@/server/services/estimation-offer.service";

// POST { layout?: "LUMP_SUM" | "PER_ITEM" } → creates a DRAFT quotation (a new revision after the first) from the newest APPROVED
// snapshot of the pricing sheet, never from the saved sheet. 409 when nothing is approved. Never approves or sends anything.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  if (!can(session!.user.role, "quotations.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return handle(async () => {
    const { id } = await params;
    const input = createOfferSchema.parse(await readOptionalJson(req));
    return NextResponse.json(await createOffer(id, { id: session!.user.id, name: session!.user.name ?? "—" }, input), { status: 201 });
  });
}
