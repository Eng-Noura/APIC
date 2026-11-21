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
