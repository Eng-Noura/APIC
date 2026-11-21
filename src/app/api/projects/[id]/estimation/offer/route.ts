import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle } from "@/server/api/estimation-route";
import { can } from "@/server/rbac/permissions";
import { createOffer } from "@/server/services/estimation.service";

// POST → creates a DRAFT quotation (a new revision after the first) from the SAVED estimate. Never approves anything.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  if (!can(session!.user.role, "quotations.edit")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return handle(async () => {
    const { id } = await params;
    return NextResponse.json(await createOffer(id, { id: session!.user.id, name: session!.user.name ?? "—" }), { status: 201 });
  });
}
