/**
 * Offer lines built from an APPROVED snapshot. Pure TypeScript (no DB, no React).
 *
 * Nothing is invented: every amount comes from the snapshot's result, in whole cents, and the lines always add up to the
 * snapshot's final price (to the cent) or the offer is refused. Which layout is the default is a company decision
 * ("needs approval").
 */
import type { EstimateResult } from "./calc";

export const OFFER_LAYOUTS = ["LUMP_SUM", "PER_ITEM"] as const;
export type OfferLayout = (typeof OFFER_LAYOUTS)[number];
/** Needs approval: the layout used when the caller does not choose one (the behaviour before this step). */
export const DEFAULT_OFFER_LAYOUT: OfferLayout = "LUMP_SUM";
export const OFFER_LAYOUT_LABEL: Record<OfferLayout, string> = { LUMP_SUM: "Lump sum (one line)", PER_ITEM: "One line per item" };

export interface OfferLine { description: string; qty: number; unit: string; unitRateCents: number }
export type OfferLines = { ok: true; lines: OfferLine[] } | { ok: false; reason: string; status: number };

/** The newest APPROVED snapshot, whatever the sheet's status is now (a reopened sheet keeps its last approval). */
export function pickApprovedSnapshot<T extends { kind: string; createdAt: Date | string }>(rows: T[]): T | null {
  const t = (d: Date | string) => new Date(d).getTime();
  return rows.filter((r) => r.kind === "APPROVED").sort((a, b) => t(b.createdAt) - t(a.createdAt))[0] ?? null;
}

export function buildOfferLines(layout: OfferLayout, result: EstimateResult, ctx: { projectName: string; itemName: (itemId: string) => string | null }): OfferLines {
  const final = result.commercial.finalCents;
  const firstError = result.issues.find((i) => i.level === "error");
  if (firstError) return { ok: false, reason: `The approved snapshot has an error: ${firstError.message}`, status: 422 };
  if (result.totals.estimatedCostCents <= 0 || final <= 0) return { ok: false, reason: "There is no price to offer in the approved snapshot.", status: 422 };

  if (layout === "LUMP_SUM") return { ok: true, lines: [{ description: `${ctx.projectName} — supply & fabrication (all inclusive)`, qty: 1, unit: "lot", unitRateCents: final }] };

  if (!result.items.length) return { ok: false, reason: "The approved snapshot has no items. Use the lump sum layout.", status: 422 };
  const lines: OfferLine[] = [];
  for (const it of result.items) {
    const name = ctx.itemName(it.id);
    if (!name) return { ok: false, reason: `An item of the approved snapshot (${it.id.slice(0, 6)}) is no longer on the sheet, so its name is unknown. Use the lump sum layout.`, status: 422 };
    lines.push({ description: name, qty: 1, unit: "lot", unitRateCents: it.finalCents });
  }
  if (result.shared.finalCents !== 0) lines.push({ description: "Shared / project level", qty: 1, unit: "lot", unitRateCents: result.shared.finalCents });
  const sum = lines.reduce((a, l) => a + l.unitRateCents, 0);
  if (sum !== final) return { ok: false, reason: "The item prices of the approved snapshot do not add up to its final price. Use the lump sum layout.", status: 422 };
  return { ok: true, lines };
}

/** Terms text copied to the quotation (same wording the offer always had). Taken from the sheet's settings, which a snapshot does not store. */
export function offerTerms(s: { paymentTerms?: string | null; deliveryDays?: number | null; exclusions?: string | null }): string | null {
  const t = [s.paymentTerms ? `Payment terms: ${s.paymentTerms}` : null, s.deliveryDays != null ? `Delivery period: ${s.deliveryDays} days` : null, s.exclusions ? `Exclusions: ${s.exclusions}` : null].filter(Boolean).join("\n");
  return t || null;
}

/** Profit as a percentage of cost, from the snapshot's own figures; null when there is no cost. */
export const offerProfitPct = (c: { costCents: number; profitCents: number }): number | null => (c.costCents > 0 ? Math.round((c.profitCents / c.costCents) * 10000) / 100 : null);
