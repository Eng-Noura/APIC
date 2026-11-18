import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { groupingSchema } from "@/server/validators/part-grouping";
import { createGrouping, getGroupings, PartGroupingError } from "@/server/services/part-grouping.service";

const fail = (e: unknown) => {
  if (e instanceof PartGroupingError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[part-groupings]", e);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
};

// GET /api/part-groupings?projectId=... — the project's assemblies, scopes and work orders (with part counts and weights).
export async function GET(req: NextRequest) {
  const { res } = await requirePermission("takeoff.view");
  if (res) return res;
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  try {
    return NextResponse.json(await getGroupings(projectId));
  } catch (e) { return fail(e); }
}

// POST { kind: "scope", projectId, description } | { kind: "workOrder", projectId, name, code?, dueDate?, remark? }
export async function POST(req: NextRequest) {
  const { session, res } = await requirePermission("takeoff.create");
  if (res) return res;
  const parsed = groupingSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    return NextResponse.json(await createGrouping(parsed.data, session!.user.id), { status: 201 });
  } catch (e) { return fail(e); }
}
