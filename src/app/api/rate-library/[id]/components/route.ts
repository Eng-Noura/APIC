import { NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, parseBody } from "@/server/api/pricing-route";
import { rateComponentSchema } from "@/server/validators/pricing";
import { addComponent } from "@/server/services/rate-library.service";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requirePermission("rateLibrary.manage");
  if (res) return res;
  return handle(async () => { await addComponent((await params).id, await parseBody(req, rateComponentSchema)); return NextResponse.json({ ok: true }, { status: 201 }); });
}
