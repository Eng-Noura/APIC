import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/server/api/guard";
import { handle, parseBody } from "@/server/api/pricing-route";
import { profileCreateSchema } from "@/server/validators/pricing";
import { createProfile, listProfiles } from "@/server/services/rate-library.service";

// GET /api/rate-library?projectId=… → global profiles plus that project's own.
export async function GET(req: NextRequest) {
  const { res } = await requirePermission("pricing.view");
  if (res) return res;
  return handle(async () => NextResponse.json({ profiles: await listProfiles(req.nextUrl.searchParams.get("projectId")) }));
}
export async function POST(req: Request) {
  const { session, res } = await requirePermission("rateLibrary.manage");
  if (res) return res;
  return handle(async () => NextResponse.json(await createProfile(await parseBody(req, profileCreateSchema), session!.user.id), { status: 201 }));
}
