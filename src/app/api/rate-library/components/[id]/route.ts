import { NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, parseBody } from "@/server/api/pricing-route";
import { rateComponentPatchSchema } from "@/server/validators/pricing";
import { deleteComponent, patchComponent } from "@/server/services/rate-library.service";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requirePermission("rateLibrary.manage");
  if (res) return res;
  return handle(async () => { await patchComponent((await params).id, await parseBody(req, rateComponentPatchSchema)); return NextResponse.json({ ok: true }); });
}
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requirePermission("rateLibrary.manage");
  if (res) return res;
  return handle(async () => { await deleteComponent((await params).id); return NextResponse.json({ ok: true }); });
}
