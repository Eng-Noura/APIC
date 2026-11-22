import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { planningHandler } from "@/server/api/planning-route";
import { exportMsp, exportXer, getPlanningData, PlanningError } from "@/server/services/planning.service";
import { buildScheduleWorkbook } from "@/server/services/planning-export.service";
import { getProject } from "@/server/services/project.service";

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "schedule";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { res } = await requirePermission("planning.view");
  if (res) return res;
  return planningHandler(async () => {
    const { id } = await params;
    const q = req.nextUrl.searchParams.get("format");
    const format = q === "xlsx" ? "xlsx" : q === "msp" ? "msp" : "xer";
    const project = await getProject(id);
    if (!project) throw new PlanningError("Project not found", 404);
    const base = safe(`${project.number}_schedule`);

    if (format === "xer") {
      const text = await exportXer(id);
      return new NextResponse(text, {
        headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="${base}.xer"`, "Cache-Control": "no-store" },
      });
    }
    if (format === "msp") {
      const text = await exportMsp(id);
      return new NextResponse(text, {
        headers: { "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="${base}.xml"`, "Cache-Control": "no-store" },
      });
    }
    const data = await getPlanningData(id);
    if (!data) throw new PlanningError("This project has no schedule yet.", 404);
    const buf = await buildScheduleWorkbook(data, `${project.number} — ${project.name}`);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${base}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  });
}
