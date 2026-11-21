import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, readJson } from "@/server/api/estimation-route";
import { applyTemplateSchema } from "@/server/validators/estimation";
import { applyTemplate } from "@/server/services/estimation-templates.service";

// POST { templateId, itemId? } → adds the template's line to this project's sheet (operations need an item; project costs and
// subcontractor services take an item or, with itemId null, the whole project). Never overwrites a line the user already priced.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { id } = await params;
    const input = applyTemplateSchema.parse(await readJson(req));
    return NextResponse.json(await applyTemplate(id, input, session!.user.id));
  });
}
