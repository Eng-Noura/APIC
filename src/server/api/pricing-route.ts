import { NextResponse } from "next/server";
import { ZodError, type ZodTypeAny, type z } from "zod";
import { PricingError } from "@/server/services/pricing.service";

/** Runs a route body and maps validation / pricing errors to JSON responses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof PricingError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof ZodError) return NextResponse.json({ error: e.issues[0]?.message ?? "Invalid input", issues: e.flatten() }, { status: 400 });
    throw e;
  }
}
export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try { body = await req.json(); } catch { throw new PricingError("Invalid JSON body"); }
  return schema.parse(body);
}
