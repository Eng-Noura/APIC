import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { groupingKindSchema, groupingSchema } from "@/server/validators/part-grouping";
import { deleteGrouping, PartGroupingError, updateGrouping } from "@/server/services/part-grouping.service";

const fail = (e: unknown) => {
  if (e instanceof PartGroupingError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[part-groupings/:kind/:id]", e);
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
};

type Ctx = { params: Promise<{ kind: string; id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { session, res } = await requirePermission("takeoff.edit");
  if (res) return res;
  const { kind, id } = await params;
  const parsed = groupingSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || parsed.data.kind !== kind) return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  try {
    await updateGrouping(id, parsed.data, session!.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) { return fail(e); }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { session, res } = await requirePermission("takeoff.delete");
  if (res) return res;
  const { kind, id } = await params;
  const k = groupingKindSchema.safeParse(kind);
  if (!k.success) return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
  try {
    await deleteGrouping(k.data, id, session!.user.id);
    return NextResponse.json({ ok: true });
  } catch (e) { return fail(e); }
}
