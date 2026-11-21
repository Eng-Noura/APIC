import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { assignGroupingSchema } from "@/server/validators/part-grouping";
import { assignGrouping, PartGroupingError } from "@/server/services/part-grouping.service";

// POST { projectId, kind: "scope" | "workOrder", targetId | null, partIds[] } — put parts into a scope / work order (or take them out).
// Assemblies keep using /api/part-groups/assign, because moving a part into an assembly also recalculates its quantity.
export async function POST(req: NextRequest) {
  const { session, res } = await requirePermission("takeoff.edit");
  if (res) return res;
  const parsed = assignGroupingSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    return NextResponse.json(await assignGrouping(parsed.data, session!.user.id));
  } catch (e) {
    if (e instanceof PartGroupingError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("[part-groupings/assign]", e);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
