import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { duplicateProject } from "@/server/services/project.service";

type Ctx = { params: Promise<{ id: string }> };

// "Duplicate project": an independent copy with a new name.
export async function POST(req: NextRequest, { params }: Ctx) {
  const { session, res } = await requirePermission("projects.create");
  if (res) return res;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (name.length < 2) return NextResponse.json({ error: "A project name is required" }, { status: 400 });

  const project = await duplicateProject(id, name, session!.user.id);
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(project, { status: 201 });
}
