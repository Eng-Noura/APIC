import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, readJson } from "@/server/api/estimation-route";
import { templateSchema } from "@/server/validators/estimation";
import { deleteTemplate, updateTemplate } from "@/server/services/estimation-templates.service";

// PUT { kind, name, data } → replaces a template. Sheets that already used it keep their own copy of the values.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ templateId: string }> }) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { templateId } = await params;
    return NextResponse.json(await updateTemplate(templateId, templateSchema.parse(await readJson(req)), session!.user.id));
  });
}

// DELETE → removes a template (lines already added to sheets are not affected).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ templateId: string }> }) {
  const { session, res } = await requirePermission("pricing.edit");
  if (res) return res;
  return handle(async () => {
    const { templateId } = await params;
    await deleteTemplate(templateId, session!.user.id);
    return NextResponse.json({ ok: true });
  });
}
