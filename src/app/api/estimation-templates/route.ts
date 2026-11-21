import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, readJson } from "@/server/api/estimation-route";
import { templateKindSchema, templateSchema } from "@/server/validators/estimation";
import { createTemplate, listTemplates } from "@/server/services/estimation-templates.service";

// GET ?kind=OPERATION|PROJECT_COST|SUBCONTRACT → saved templates (all kinds when omitted).
export async function GET(req: NextRequest) {
  const { res } = await requirePermission("pricing.view");
  if (res) return res;
  return handle(async () => {
    const raw = req.nextUrl.searchParams.get("kind");
    const kind = raw ? templateKindSchema.parse(raw) : undefined;
    return NextResponse.json({ templates: await listTemplates(kind) });
  });
}

// POST { kind, name, data } → saves a new template. The shape of `data` depends on `kind`.
export async function POST(req: NextRequest) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => NextResponse.json(await createTemplate(templateSchema.parse(await readJson(req)), session!.user.id), { status: 201 }));
}
