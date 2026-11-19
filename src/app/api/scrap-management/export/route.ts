import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { scrapManagementExportSchema } from "@/server/validators/nesting";
import { buildScrapManagementWorkbook } from "@/server/services/scrap-management-export.service";
import { getProject } from "@/server/services/project.service";

// The page sends the rows it is showing (nesting figures + the user's prices); the workbook is built from them.
export async function POST(req: NextRequest) {
  const { res } = await requirePermission("scrapPricing.export");
  if (res) return res;

  const parsed = scrapManagementExportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const project = await getProject(parsed.data.projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const wb = buildScrapManagementWorkbook(parsed.data.rows, { projectNumber: project.number, projectName: project.name });
  const buffer = await wb.xlsx.writeBuffer();
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="SteelFlow_Scrap_Management_${project.number}.xlsx"`,
    },
  });
}
