import { NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/server/api/guard";
import { handle, parseBody } from "@/server/api/pricing-route";
import { componentSchema, materialSchema } from "@/server/validators/pricing";
import { addComponent, addMaterial, PricingError } from "@/server/services/pricing.service";

// POST /api/pricing/items/:id/lines  { kind: "material" | "component", ...fields }
const bodySchema = z.discriminatedUnion("kind", [
  materialSchema.extend({ kind: z.literal("material") }),
  componentSchema.extend({ kind: z.literal("component") }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    const b = await parseBody(req, bodySchema);
    if (b.kind === "material") { const { kind, ...d } = b; void kind; await addMaterial(id, d); }
    else {
      const { kind, ...d } = b; void kind;
      if (d.method === "PERCENT_OF_BASE" && !d.base) throw new PricingError("Choose what the percentage applies to.");
      await addComponent(id, d);
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  });
}
