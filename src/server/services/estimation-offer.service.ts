import { prisma } from "@/server/db/client";
import { verifySnapshot } from "@/features/estimation/workflow";
import type { EstimateResult } from "@/features/estimation/calc";
import { DEFAULT_OFFER_LAYOUT, buildOfferLines, offerProfitPct, offerTerms, pickApprovedSnapshot, type OfferLayout } from "@/features/estimation/offer";
import { logActivity } from "./activity-log.service";
import { nextNumber } from "./quotations.service";
import { EstimationError, audit, getSavedEstimate } from "./estimation.service";

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * Creates a DRAFT quotation from the newest APPROVED snapshot of the project's pricing sheet — never from the saved sheet,
 * whatever its status is now. The first offer gets a new number; later ones are a new revision of the same number, and no
 * existing revision is touched. The offer records which snapshot and layout it came from, and the estimate's audit trail
 * gets an entry, all in one transaction. Nothing is approved or sent here.
 */
export async function createOffer(projectId: string, user: { id: string; name: string }, input: { layout?: OfferLayout } = {}) {
  const layout = input.layout ?? DEFAULT_OFFER_LAYOUT;
  const estimate = await prisma.projectEstimate.findUnique({ where: { projectId }, select: { id: true } });
  if (!estimate) throw new EstimationError("Estimate not found", 404);

  const approvedRows = await prisma.estimateSnapshot.findMany({ where: { estimateId: estimate.id, kind: "APPROVED" }, orderBy: { createdAt: "desc" }, take: 1 });
  const snap = pickApprovedSnapshot(approvedRows);
  if (!snap) throw new EstimationError("There is no approved pricing sheet yet. Approve the sheet first: an offer is built from the approved snapshot.", 409);
  if (!verifySnapshot(snap)) throw new EstimationError("The approved snapshot no longer matches its own inputs, so no offer can be built from it.", 409);

  const doc = await getSavedEstimate(projectId);
  const result = snap.result as unknown as EstimateResult;
  const built = buildOfferLines(layout, result, { projectName: doc.project.name, itemName: (id) => doc.items.find((i) => i.id === id)?.name ?? null });
  if (!built.ok) throw new EstimationError(built.reason, built.status);

  const last = await prisma.estimateOffer.findFirst({ where: { estimateId: estimate.id }, orderBy: { createdAt: "desc" }, include: { quotation: { select: { number: true } } } });
  const today = new Date();
  const s = doc.settings;
  const termsFromCurrentSheet = doc.sheet.status !== "APPROVED"; // a snapshot stores figures, not terms: they come from the saved sheet
  const final = result.commercial.finalCents;

  const created = await prisma.$transaction(async (tx) => {
    let number: string; let revision = 0;
    if (last) {
      number = last.quotation.number;
      const top = await tx.quotation.findFirst({ where: { projectId, number }, orderBy: { revision: "desc" }, select: { revision: true } });
      revision = (top?.revision ?? -1) + 1;
    } else number = await nextNumber(projectId, today.getFullYear());
    const q = await tx.quotation.create({
      data: {
        projectId, number, revision, description: `${doc.project.name} — commercial offer`, status: "DRAFT", currency: doc.currency,
        issueDate: today, validUntil: addDays(today, s.offerValidityDays), profitMargin: offerProfitPct(result.commercial), preparedBy: user.name,
        terms: offerTerms(s), notes: s.commercialNotes || null, createdById: user.id,
        items: { create: built.lines.map((l, i) => ({ sortOrder: i, description: l.description, qty: l.qty, unit: l.unit, unitRate: l.unitRateCents / 100, type: "SUPPLY" as const })) },
        events: { create: [{ kind: revision ? "REVISED" : "CREATED", message: `Offer generated from the approved pricing snapshot v${snap.version} (${layout === "PER_ITEM" ? "one line per item" : "lump sum"})${revision ? ` (Rev. ${revision})` : ""}`, userId: user.id }] },
      },
    });
    await tx.estimateOffer.create({
      data: {
        estimateId: estimate.id, quotationId: q.id, finalPrice: final / 100, createdById: user.id, snapshotId: snap.id, snapshotVersion: snap.version, layout,
        snapshot: JSON.parse(JSON.stringify({ layout, approvedSnapshotId: snap.id, approvedVersion: snap.version, termsFromCurrentSheet, lines: built.lines, totals: result.totals, commercial: result.commercial, terms: offerTerms(s) })),
      },
    });
    await audit(tx, estimate.id, user.id, doc.sheet.version, "OFFER", `Offer ${q.number} Rev. ${q.revision} created from the approved snapshot v${snap.version} (${layout})`);
    return q;
  });
  await logActivity({ userId: user.id, action: "CREATE", entity: "QUOTATION", entityId: created.id, detail: `${created.number} Rev. ${created.revision} (from approved snapshot v${snap.version})` });
  return { quotationId: created.id, number: created.number, revision: created.revision, layout, snapshotVersion: snap.version, termsFromCurrentSheet };
}
