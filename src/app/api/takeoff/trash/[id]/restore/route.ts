import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { restoreFromTrash, TrashError } from "@/server/services/part-trash.service";

type Ctx = { params: Promise<{ id: string }> };

// Puts a deleted part back (the "Undo" of the delete toast, and "Restore" in the Trash).
export async function POST(_req: NextRequest, { params }: Ctx) {
  const { session, res } = await requirePermission("takeoff.edit");
  if (res) return res;
  const { id } = await params;
  try {
    const part = await restoreFromTrash(id, session!.user.id);
    return NextResponse.json({ ok: true, id: part.id });
  } catch (err) {
    if (err instanceof TrashError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[trash] restore failed", err);
    return NextResponse.json({ error: "Could not restore this item" }, { status: 500 });
  }
}
