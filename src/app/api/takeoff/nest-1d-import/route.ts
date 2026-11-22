import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/server/api/guard";
import { importMissingNestPieces, importNestPieces } from "@/server/services/nest-1d-import.service";

const itemSchema = z.object({
  // set when the piece comes from the project's own 1D nest: links the part to that piece
  nestPartId: z.number().int().nonnegative().optional(),
  name: z.string().max(200),
  profile: z.string().max(100),
  material: z.string().max(100),
  lengthMm: z.number().positive(),
  qty: z.number().int().positive(),
  partType: z.enum(["HOT_ROLLED", "PIPE"]),
  // typed in by the person where the nest does not say (a profile that is not in the weight table, an unreadable pipe size)
  weightPerMeter: z.number().positive().optional(),
  odMm: z.number().positive().optional(),
  thicknessMm: z.number().positive().optional(),
});

const bodySchema = z.object({
  projectId: z.string().min(1),
  // with drawingId + items: the parts the person picked; without them: everything of the project's 1D nest that is not in yet
  drawingId: z.string().min(1).optional(),
  items: z.array(itemSchema).min(1).max(500).optional(),
});

// POST { projectId } — the automatic import of the project's 1D nest. Returns { imported, failed, warnings }.
// POST { projectId, drawingId, items } — the picked pieces into that drawing. Returns { results }.
export async function POST(req: NextRequest) {
  const { session, res } = await requirePermission("takeoff.create");
  if (res) return res;
  const body = bodySchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { projectId, drawingId, items } = body.data;
  try {
    if (items) {
      if (!drawingId) return NextResponse.json({ error: "drawingId is required" }, { status: 400 });
      return NextResponse.json({ results: await importNestPieces(drawingId, items, session!.user.id) });
    }
    return NextResponse.json(await importMissingNestPieces(projectId, session!.user.id));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Import failed" }, { status: 400 });
  }
}
