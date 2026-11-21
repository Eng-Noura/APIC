import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { EstimationError } from "@/server/services/estimation.service";

/** Runs a route body and maps validation / estimation errors to JSON responses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof EstimationError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof ZodError) return NextResponse.json({ error: e.issues[0]?.message ?? "Invalid input", path: e.issues[0]?.path }, { status: 400 });
    throw e;
  }
}

/** Reads a JSON request body; a missing or malformed body is a 400, not a crash. */
export async function readJson(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { throw new EstimationError("Invalid JSON body", 400); }
}
