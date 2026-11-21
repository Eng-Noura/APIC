import { NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, parseBody } from "@/server/api/pricing-route";
import { componentPatchSchema, materialSchema } from "@/server/validators/pricing";
import { deleteComponent, deleteMaterial, patchComponent, patchMaterial, PricingError } from "@/server/services/pricing.service";

type P = { params: Promise<{ kind: string; id: string }> };
const kindOf = (k: string) => { if (k !== "material" && k !== "component") throw new PricingError("Unknown line kind", 404); return k; };

export async function PATCH(req: Request, { params }: P) {
  const { res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { kind, id } = await params;
    if (kindOf(kind) === "material") await patchMaterial(id, await parseBody(req, materialSchema.partial()));
    else await patchComponent(id, await parseBody(req, componentPatchSchema));
    return NextResponse.json({ ok: true });
  });
}
export async function DELETE(_req: Request, { params }: P) {
  const { res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { kind, id } = await params;
    if (kindOf(kind) === "material") await deleteMaterial(id); else await deleteComponent(id);
    return NextResponse.json({ ok: true });
  });
}
