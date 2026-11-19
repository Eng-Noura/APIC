import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { scrapManagementExportSchema } from "@/server/validators/nesting";
import { getScrapSourceGroups, ScrapManagementError } from "@/server/services/scrap-management.service";
import { buildScrapManagementWorkbook } from "@/server/services/scrap-management-export.service";
import { getProject } from "@/server/services/project.service";
import type { ScrapRowInput } from "@/server/calc/scrap-management";

export async function POST(req: NextRequest) {
  const { res } = await requirePermission("scrapPricing.export");
  if (res) return res;

  const parsed = scrapManagementExportSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { nestingRunId, projectId, rows } = parsed.data;

  const project = await getProject(projectId);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  let inputs: ScrapRowInput[];
  try {
    const groups = await getScrapSourceGroups(nestingRunId);
    // Geometry always comes from the server's nesting run; the client only supplies prices/percentages.
    inputs = groups.map((g) => {
      const r = rows[g.key];
      return {
        ...g,
        costPerKg: r?.costPerKg ?? 0,
        usedLaterPct: r?.usedLaterPct ?? 0,
        usedLaterPriceLEPerKg: r?.usedLaterPriceLEPerKg ?? r?.costPerKg ?? 0,
        scrapSellPriceLEPerKg: r?.scrapSellPriceLEPerKg ?? 0,
      };
    });
  } catch (err) {
    if (err instanceof ScrapManagementError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }

  const wb = buildScrapManagementWorkbook(inputs, { projectNumber: project.number, projectName: project.name, nestingRunId });
  const buffer = await wb.xlsx.writeBuffer();
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="SteelFlow_Scrap_Management_${project.number}.xlsx"`,
    },
  });
}
