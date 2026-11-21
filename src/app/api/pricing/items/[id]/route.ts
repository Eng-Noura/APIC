import { NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, parseBody } from "@/server/api/pricing-route";
import { patchItemSchema } from "@/server/validators/pricing";
import { deleteItem, patchItem } from "@/server/services/pricing.service";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => { await patchItem((await params).id, await parseBody(req, patchItemSchema)); return NextResponse.json({ ok: true }); });
}
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => { await deleteItem((await params).id); return NextResponse.json({ ok: true }); });
}
