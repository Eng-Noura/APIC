import { NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, parseBody } from "@/server/api/pricing-route";
import { overrideSchema } from "@/server/validators/pricing";
import { setOverride } from "@/server/services/pricing.service";

// PUT { rateKey, value } sets an item-level override (always wins); value null removes it.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const b = await parseBody(req, overrideSchema);
    await setOverride((await params).id, b.rateKey, b.value, b.reason, session!.user.id);
    return NextResponse.json({ ok: true });
  });
}
