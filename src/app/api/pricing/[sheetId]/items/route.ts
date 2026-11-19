import { NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, parseBody } from "@/server/api/pricing-route";
import { addItemsSchema } from "@/server/validators/pricing";
import { addItems } from "@/server/services/pricing.service";

export async function POST(req: Request, { params }: { params: Promise<{ sheetId: string }> }) {
  const { res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { sheetId } = await params;
    await addItems(sheetId, await parseBody(req, addItemsSchema));
    return NextResponse.json({ ok: true }, { status: 201 });
  });
}
