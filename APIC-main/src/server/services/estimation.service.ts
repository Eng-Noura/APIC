// Pricing & Estimation service. Inputs live in the estimate_* tables; every figure shown or stored is recalculated here
// from those inputs with src/features/estimation/calc.ts — a total sent by the browser is never trusted (none is accepted).

import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { logActivity } from "./activity-log.service";
import { getMaterialRequirements } from "./material-usage.service";
import { ensureNestInSync } from "./nest-sync-guard";
import { nextNumber } from "./quotations.service";
import { calcEstimate, fromCents, type EstimateInputs, type ItemInput } from "@/features/estimation/calc";
import { DEFAULT_OPERATIONS, DEFAULT_PROJECT_COSTS } from "@/features/estimation/defaults";
import type { SaveEstimateInput } from "@/server/validators/estimation";
import type { EstimateDoc } from "@/features/estimation/types";

export class EstimationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const include = {
  materials: { orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
  items: { orderBy: { sortOrder: "asc" as const }, include: { operations: { orderBy: { sortOrder: "asc" as const } } } },
  subcontracts: { orderBy: { sortOrder: "asc" as const } },
  projectCosts: { orderBy: { sortOrder: "asc" as const } },
} satisfies Prisma.ProjectEstimateInclude;

async function ensureEstimate(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new EstimationError("Project not found", 404);
  const existing = await prisma.projectEstimate.findUnique({ where: { projectId }, select: { id: true } });
  if (existing) return existing.id;
  try {
    const e = await prisma.projectEstimate.create({
      data: {
        projectId, createdById: userId,
        projectCosts: { create: DEFAULT_PROJECT_COSTS.map((c, n) => ({ name: c.name, method: c.method, unit: c.unit, percentBase: c.percentBase ?? null, rate: 0, enabled: true, source: "DEFAULT", sortOrder: n })) },
      },
    });
    return e.id;
  } catch {
    // two requests raced to create it: the unique projectId made one fail — use the winner's
    const e = await prisma.projectEstimate.findUnique({ where: { projectId }, select: { id: true } });
    if (!e) throw new EstimationError("Could not create the estimate", 500);
    return e.id;
  }
}

// ---------------------------------------------------------------- synchronisation with Part List / Nesting / Procurement

/** Brings the automatic material lines in step with the project's Material Requirements (nesting → part list fallback). */
async function syncMaterials(estimateId: string, projectId: string) {
  const req = await getMaterialRequirements(projectId);
  if (!req) return;
  const rows = req.rows.filter((r) => r.weightKg != null && r.weightKg > 0);

  // kg the parts really need per thickness/grade (plates), so a nest row can show used vs purchased
  const parts = await prisma.takeoffPart.findMany({ where: { drawing: { projectId }, partType: { in: ["PLATE", "CONE"] } }, select: { thicknessMm: true, material: true, weightKg: true } });
  const usedKg = (th: number | null, grade: string) =>
    th == null ? null : parts.filter((p) => p.thicknessMm != null && Math.abs(p.thicknessMm - th) < 0.01 && (!grade || grade === "—" || !p.material || p.material.trim().toLowerCase() === grade.toLowerCase())).reduce((a, p) => a + p.weightKg, 0);

  // price suggestion from purchase orders: weighted average EGP per kg
  const materialIds = rows.map((r) => r.materialId).filter(Boolean) as string[];
  const orders = materialIds.length ? await prisma.planMaterialOrder.findMany({ where: { materialId: { in: materialIds }, unitPrice: { not: null }, orderedQty: { gt: 0 } }, select: { materialId: true, orderedQty: true, unitPrice: true } }) : [];

  const existing = await prisma.estimateMaterial.findMany({ where: { estimateId } });
  const byRef = new Map(existing.filter((m) => m.sourceRef).map((m) => [m.sourceRef!, m]));
  const seen = new Set<string>();
  let order = existing.length;

  for (const r of rows) {
    const ref = r.materialId ? `MAT:${r.materialId}` : `PL:${r.id}`;
    seen.add(ref);
    const isNest = r.source === "MATERIALS" && r.widthMm != null;
    const purchasedKg = r.weightKg!;
    const perUnitKg = r.required > 0 ? purchasedKg / r.required : 1; // kg per ordered unit (a sheet, or 1 when ordered in kg)
    const mine = orders.filter((o) => o.materialId === r.materialId);
    const qtySum = mine.reduce((a, o) => a + o.orderedQty, 0);
    const suggested = qtySum > 0 && perUnitKg > 0 ? mine.reduce((a, o) => a + o.orderedQty * (o.unitPrice ?? 0), 0) / qtySum / perUnitKg : null;
    const requiredKg = isNest ? usedKg(r.thicknessMm, r.grade) : purchasedKg;
    const base = {
      name: r.type === "Plate" ? `Steel Plate` : r.type === "Profile" || r.type === "Flat" ? r.spec : r.type,
      grade: r.grade === "—" ? null : r.grade, thicknessMm: r.thicknessMm,
      sourceRequiredKg: requiredKg, sourcePurchasedKg: purchasedKg,
      suggestedUnitPrice: suggested, suggestedPriceSource: suggested != null ? "PROCUREMENT" : null, sourceMissing: false,
    };
    const cur = byRef.get(ref);
    if (!cur) {
      await prisma.estimateMaterial.create({ data: { estimateId, source: isNest ? "NESTING" : "PART_LIST", sourceRef: ref, ...base, requiredKg, purchasedKg, unitPrice: suggested ?? 0, sortOrder: order++ } });
    } else {
      // keep what the user changed: purchased qty only follows the source while it still equals the old source value; price likewise
      const qtyEdited = cur.sourcePurchasedKg != null && Math.abs(cur.purchasedKg - cur.sourcePurchasedKg) > 1e-6;
      const priceEdited = cur.unitPrice !== (cur.suggestedUnitPrice ?? 0);
      await prisma.estimateMaterial.update({
        where: { id: cur.id },
        data: { ...base, source: isNest ? "NESTING" : "PART_LIST", requiredKg, purchasedKg: qtyEdited ? cur.purchasedKg : purchasedKg, unitPrice: priceEdited ? cur.unitPrice : suggested ?? 0 },
      });
    }
  }
  // a source row that vanished: drop the line if untouched, otherwise keep it and flag it
  for (const m of existing) {
    if (m.source === "MANUAL" || !m.sourceRef || seen.has(m.sourceRef)) continue;
    const touched = (m.sourcePurchasedKg != null && Math.abs(m.purchasedKg - m.sourcePurchasedKg) > 1e-6) || m.unitPrice !== (m.suggestedUnitPrice ?? 0);
    if (touched) await prisma.estimateMaterial.update({ where: { id: m.id }, data: { sourceMissing: true } });
    else await prisma.estimateMaterial.delete({ where: { id: m.id } });
  }
}

/** One manufacturing item per project Scope; new ones start with the default (unselected) operations. */
async function syncItems(estimateId: string, projectId: string) {
  const scopes = await prisma.scopeItem.findMany({ where: { projectId }, select: { id: true, description: true }, orderBy: { createdAt: "asc" } });
  const linked = new Set((await prisma.estimateItem.findMany({ where: { estimateId, scopeItemId: { not: null } }, select: { scopeItemId: true } })).map((i) => i.scopeItemId));
  let order = await prisma.estimateItem.count({ where: { estimateId } });
  for (const s of scopes) {
    if (linked.has(s.id)) continue;
    try {
      await prisma.estimateItem.create({ data: { estimateId, scopeItemId: s.id, name: s.description, sortOrder: order++, operations: { create: defaultOps() } } });
    } catch { /* unique (estimateId, scopeItemId): created by a parallel request */ }
  }
}
const defaultOps = () => DEFAULT_OPERATIONS.map((o, n) => ({ name: o.name, costType: o.costType, unit: o.unit, percentBase: o.percentBase ?? null, rate: 0, selected: false, source: "DEFAULT", sortOrder: n }));

async function scopeMetrics(projectId: string) {
  const parts = await prisma.takeoffPart.findMany({ where: { drawing: { projectId }, scopeId: { not: null }, partType: { not: "ACCESSORY" } }, select: { scopeId: true, weightKg: true, qty: true } });
  const m = new Map<string, { weightKg: number; pieces: number }>();
  for (const p of parts) { const c = m.get(p.scopeId!) ?? { weightKg: 0, pieces: 0 }; c.weightKg += p.weightKg; c.pieces += p.qty; m.set(p.scopeId!, c); }
  return m;
}

// ---------------------------------------------------------------- view

type Full = Prisma.ProjectEstimateGetPayload<{ include: typeof include }>;

function toInputs(e: Full, metrics: Map<string, { weightKg: number; pieces: number }>): { inputs: EstimateInputs; weights: Map<string, { weightKg: number; pieces: number }> } {
  const weights = new Map<string, { weightKg: number; pieces: number }>();
  const items: ItemInput[] = e.items.map((i) => {
    const w = i.scopeItemId ? metrics.get(i.scopeItemId) ?? { weightKg: 0, pieces: 0 } : { weightKg: i.manualWeightKg ?? 0, pieces: i.manualPieces ?? 0 };
    weights.set(i.id, w);
    return { id: i.id, weightKg: w.weightKg, pieces: w.pieces, operations: i.operations.map((o) => ({ id: o.id, selected: o.selected, costType: o.costType as never, rate: o.rate, quantity: o.quantity, percentBase: o.percentBase as never })) };
  });
  return {
    weights,
    inputs: {
      materials: e.materials.map((m) => ({ id: m.id, source: m.source as never, name: m.name, requiredKg: m.requiredKg, purchasedKg: m.purchasedKg, unitPrice: m.unitPrice })),
      scrap: { usedLaterPct: e.scrapUsedLaterPct, usedLaterPricePerKg: e.scrapUsedLaterPrice, scrapSellPricePerKg: e.scrapSellPrice, creditRecoveredScrap: e.creditRecoveredScrap },
      items,
      subcontracts: e.subcontracts.map((s) => ({ id: s.id, quantity: s.quantity, unitPrice: s.unitPrice })),
      projectCosts: e.projectCosts.map((c) => ({ id: c.id, enabled: c.enabled, method: c.method as never, rate: c.rate, quantity: c.quantity, percentBase: c.percentBase as never })),
      commercial: { profitMode: e.profitMode as never, profitValue: e.profitValue, insuranceMode: e.insuranceMode as never, insuranceValue: e.insuranceValue, taxPct: e.taxPct },
    },
  };
}

export async function getEstimateView(projectId: string, userId: string): Promise<EstimateDoc> {
  await ensureNestInSync(projectId);
  const estimateId = await ensureEstimate(projectId, userId);
  await syncMaterials(estimateId, projectId);
  await syncItems(estimateId, projectId);
  return loadDoc(projectId);
}

async function loadDoc(projectId: string): Promise<EstimateDoc> {
  const [e, project, metrics] = await Promise.all([
    prisma.projectEstimate.findUnique({ where: { projectId }, include: { ...include, offers: { orderBy: { createdAt: "desc" }, include: { quotation: { select: { id: true, number: true, revision: true, status: true } } } } } }),
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true, number: true, name: true, status: true, updatedAt: true, customer: { select: { name: true } } } }),
    scopeMetrics(projectId),
  ]);
  if (!e || !project) throw new EstimationError("Estimate not found", 404);
  const { inputs, weights } = toInputs(e, metrics);
  const result = calcEstimate(inputs);
  return {
    project: { id: project.id, number: project.number, name: project.name, customer: project.customer?.name ?? "" },
    currency: e.currency, updatedAt: e.updatedAt.toISOString(),
    stageDone: { material: e.materialDone, manufacturing: e.manufacturingDone, project: e.projectCostDone, commercial: e.offers.length > 0 },
    settings: {
      scrapUsedLaterPct: e.scrapUsedLaterPct, scrapUsedLaterPrice: e.scrapUsedLaterPrice, scrapSellPrice: e.scrapSellPrice, creditRecoveredScrap: e.creditRecoveredScrap,
      profitMode: e.profitMode as never, profitValue: e.profitValue, insuranceMode: e.insuranceMode as never, insuranceValue: e.insuranceValue, taxPct: e.taxPct,
      paymentTerms: e.paymentTerms, offerValidityDays: e.offerValidityDays, deliveryDays: e.deliveryDays, exclusions: e.exclusions, commercialNotes: e.commercialNotes,
    },
    materials: e.materials.map((m) => ({ id: m.id, source: m.source as never, name: m.name, grade: m.grade, thicknessMm: m.thicknessMm, requiredKg: m.requiredKg, purchasedKg: m.purchasedKg, unitPrice: m.unitPrice, sourceRequiredKg: m.sourceRequiredKg, sourcePurchasedKg: m.sourcePurchasedKg, suggestedUnitPrice: m.suggestedUnitPrice, sourceMissing: m.sourceMissing })),
    items: e.items.map((i) => ({ id: i.id, name: i.name, linked: !!i.scopeItemId, weightKg: weights.get(i.id)!.weightKg, pieces: weights.get(i.id)!.pieces, manualWeightKg: i.manualWeightKg, manualPieces: i.manualPieces, operations: i.operations.map((o) => ({ id: o.id, name: o.name, costType: o.costType as never, unit: o.unit, rate: o.rate, quantity: o.quantity, percentBase: o.percentBase as never, selected: o.selected, source: o.source as never })) })),
    subcontracts: e.subcontracts.map((s) => ({ id: s.id, name: s.name, company: s.company, unit: s.unit, quantity: s.quantity, unitPrice: s.unitPrice, notes: s.notes })),
    projectCosts: e.projectCosts.map((c) => ({ id: c.id, name: c.name, method: c.method as never, unit: c.unit, quantity: c.quantity, rate: c.rate, percentBase: c.percentBase as never, enabled: c.enabled, source: c.source as never })),
    offers: e.offers.map((o) => ({ id: o.id, quotationId: o.quotation.id, number: o.quotation.number, revision: o.quotation.revision, status: o.quotation.status, finalPrice: o.finalPrice, createdAt: o.createdAt.toISOString() })),
    totals: { ...result.totals, ...result.commercial },
  };
}

// ---------------------------------------------------------------- save

/** Replaces the editable inputs with what the page sent, in one transaction. Ids must belong to this estimate. */
export async function saveEstimate(projectId: string, input: SaveEstimateInput, userId: string): Promise<EstimateDoc> {
  const estimateId = await ensureEstimate(projectId, userId);
  const cur = await prisma.projectEstimate.findUnique({ where: { id: estimateId }, include });
  if (!cur) throw new EstimationError("Estimate not found", 404);
  if (cur.updatedAt.toISOString() !== input.baseUpdatedAt) throw new EstimationError("Someone else saved this estimate while you were editing. Reload to see their changes.", 409);

  const isNew = (id: string) => id.startsWith("new-");
  const own = (rows: { id: string }[]) => { const set = new Set(rows.map((r) => r.id)); return (id: string) => set.has(id); };
  const matIds = own(cur.materials), itemIds = own(cur.items), subIds = own(cur.subcontracts), costIds = own(cur.projectCosts);
  const opIds = new Set(cur.items.flatMap((i) => i.operations.map((o) => o.id)));
  const check = (ok: boolean, what: string) => { if (!ok) throw new EstimationError(`${what} does not belong to this project's estimate`, 400); };

  await prisma.$transaction(async (tx) => {
    const s = input.settings;
    await tx.projectEstimate.update({
      where: { id: estimateId },
      data: {
        scrapUsedLaterPct: s.scrapUsedLaterPct, scrapUsedLaterPrice: s.scrapUsedLaterPrice, scrapSellPrice: s.scrapSellPrice, creditRecoveredScrap: s.creditRecoveredScrap,
        profitMode: s.profitMode, profitValue: s.profitValue, insuranceMode: s.insuranceMode, insuranceValue: s.insuranceValue, taxPct: s.taxPct,
        paymentTerms: s.paymentTerms || null, offerValidityDays: s.offerValidityDays, deliveryDays: s.deliveryDays ?? null, exclusions: s.exclusions || null, commercialNotes: s.commercialNotes || null,
        materialDone: input.stageDone?.material ?? undefined, manufacturingDone: input.stageDone?.manufacturing ?? undefined, projectCostDone: input.stageDone?.project ?? undefined,
        updatedById: userId,
      },
    });

    // materials — automatic lines: only price and purchased kg are editable; manual lines: everything; only manual lines can be removed
    const sentMat = new Set(input.materials.map((m) => m.id));
    for (const m of cur.materials) if (m.source === "MANUAL" && !sentMat.has(m.id)) await tx.estimateMaterial.delete({ where: { id: m.id } });
    let n = 0;
    for (const m of input.materials) {
      if (isNew(m.id)) {
        await tx.estimateMaterial.create({ data: { estimateId, source: "MANUAL", name: m.name, grade: m.grade || null, thicknessMm: m.thicknessMm ?? null, requiredKg: m.requiredKg ?? null, purchasedKg: m.purchasedKg, unitPrice: m.unitPrice, sortOrder: 1000 + n++ } });
        continue;
      }
      check(matIds(m.id), "A material line");
      const old = cur.materials.find((x) => x.id === m.id)!;
      await tx.estimateMaterial.update({ where: { id: m.id }, data: old.source === "MANUAL"
        ? { name: m.name, grade: m.grade || null, thicknessMm: m.thicknessMm ?? null, requiredKg: m.requiredKg ?? null, purchasedKg: m.purchasedKg, unitPrice: m.unitPrice }
        : { purchasedKg: m.purchasedKg, unitPrice: m.unitPrice } });
    }

    // items (scope-linked items cannot be removed here; they follow the project's Scope list) and their operations
    const sentItems = new Set(input.items.map((i) => i.id));
    for (const i of cur.items) if (!i.scopeItemId && !sentItems.has(i.id)) await tx.estimateItem.delete({ where: { id: i.id } });
    n = 0;
    for (const it of input.items) {
      let itemId = it.id;
      if (isNew(it.id)) {
        const c = await tx.estimateItem.create({ data: { estimateId, name: it.name, manualWeightKg: it.manualWeightKg ?? null, manualPieces: it.manualPieces ?? null, sortOrder: 1000 + n++ } });
        itemId = c.id;
      } else {
        check(itemIds(it.id), "An item");
        const old = cur.items.find((x) => x.id === it.id)!;
        if (!old.scopeItemId) await tx.estimateItem.update({ where: { id: it.id }, data: { name: it.name, manualWeightKg: it.manualWeightKg ?? null, manualPieces: it.manualPieces ?? null } });
        const sentOps = new Set(it.operations.map((o) => o.id));
        for (const o of old.operations) if (!sentOps.has(o.id)) await tx.estimateOperation.delete({ where: { id: o.id } });
      }
      let k = 0;
      for (const o of it.operations) {
        const data = { name: o.name, costType: o.costType, unit: o.unit, rate: o.rate, quantity: o.costType === "FIXED" || o.costType === "PERCENTAGE" ? null : o.quantity ?? null, percentBase: o.costType === "PERCENTAGE" ? o.percentBase ?? null : null, selected: o.selected, sortOrder: k++ };
        if (isNew(o.id)) await tx.estimateOperation.create({ data: { ...data, itemId, source: "MANUAL" } });
        else { check(opIds.has(o.id) && !isNew(it.id), "An operation"); await tx.estimateOperation.update({ where: { id: o.id }, data }); }
      }
    }

    const sentSub = new Set(input.subcontracts.map((x) => x.id));
    for (const x of cur.subcontracts) if (!sentSub.has(x.id)) await tx.estimateSubcontract.delete({ where: { id: x.id } });
    n = 0;
    for (const x of input.subcontracts) {
      const data = { name: x.name, company: x.company || null, unit: x.unit, quantity: x.quantity, unitPrice: x.unitPrice, notes: x.notes || null, sortOrder: n++ };
      if (isNew(x.id)) await tx.estimateSubcontract.create({ data: { ...data, estimateId } });
      else { check(subIds(x.id), "A subcontractor service"); await tx.estimateSubcontract.update({ where: { id: x.id }, data }); }
    }

    const sentCost = new Set(input.projectCosts.map((x) => x.id));
    for (const x of cur.projectCosts) if (!sentCost.has(x.id)) await tx.estimateProjectCost.delete({ where: { id: x.id } });
    n = 0;
    for (const x of input.projectCosts) {
      const data = { name: x.name, method: x.method, unit: x.unit, quantity: x.method === "FIXED" || x.method === "PERCENTAGE" ? null : x.quantity ?? null, rate: x.rate, percentBase: x.method === "PERCENTAGE" ? x.percentBase ?? null : null, enabled: x.enabled, sortOrder: n++ };
      if (isNew(x.id)) await tx.estimateProjectCost.create({ data: { ...data, estimateId, source: "MANUAL" } });
      else { check(costIds(x.id), "A cost item"); await tx.estimateProjectCost.update({ where: { id: x.id }, data }); }
    }
  });
  await logActivity({ userId, action: "UPDATE", entity: "PROJECT", entityId: projectId, detail: "Pricing estimate saved" });
  return loadDoc(projectId);
}

// ---------------------------------------------------------------- offer

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * Turns the saved estimate into a DRAFT quotation. The first offer gets a new quotation number; every later one is the
 * next revision of that number, so earlier revisions — approved ones included — are never overwritten or reset.
 */
export async function createOffer(projectId: string, user: { id: string; name: string }) {
  const doc = await loadDoc(projectId);
  if (doc.totals.estimatedCostCents <= 0) throw new EstimationError("There is no cost to price yet. Complete the earlier stages first.", 422);
  if (doc.totals.issue) throw new EstimationError(doc.totals.issue, 422);
  const bad = [...doc.projectCosts.filter((c) => c.enabled && c.method === "PERCENTAGE" && !c.percentBase)];
  if (bad.length) throw new EstimationError(`Choose what the percentage applies to for "${bad[0].name}".`, 422);

  const estimate = await prisma.projectEstimate.findUniqueOrThrow({ where: { projectId }, select: { id: true } });
  const last = await prisma.estimateOffer.findFirst({ where: { estimateId: estimate.id }, orderBy: { createdAt: "desc" }, include: { quotation: { select: { number: true } } } });
  const today = new Date();
  const s = doc.settings;
  const terms = [s.paymentTerms ? `Payment terms: ${s.paymentTerms}` : null, s.deliveryDays != null ? `Delivery period: ${s.deliveryDays} days` : null, s.exclusions ? `Exclusions: ${s.exclusions}` : null].filter(Boolean).join("\n");
  const profitPct = doc.totals.costCents > 0 ? Math.round((doc.totals.profitCents / doc.totals.costCents) * 10000) / 100 : null;

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
        issueDate: today, validUntil: addDays(today, s.offerValidityDays), profitMargin: profitPct, preparedBy: user.name,
        terms: terms || null, notes: s.commercialNotes || null, createdById: user.id,
        items: { create: [{ sortOrder: 0, description: `${doc.project.name} — supply & fabrication (all inclusive)`, qty: 1, unit: "lot", unitRate: fromCents(doc.totals.finalCents), type: "SUPPLY" }] },
        events: { create: [{ kind: revision ? "REVISED" : "CREATED", message: `Offer generated from the pricing estimate${revision ? ` (Rev. ${revision})` : ""}`, userId: user.id }] },
      },
    });
    await tx.estimateOffer.create({
      data: { estimateId: estimate.id, quotationId: q.id, finalPrice: fromCents(doc.totals.finalCents), createdById: user.id, snapshot: JSON.parse(JSON.stringify({ settings: doc.settings, totals: doc.totals, materials: doc.materials, items: doc.items, subcontracts: doc.subcontracts, projectCosts: doc.projectCosts })) },
    });
    return q;
  });
  await logActivity({ userId: user.id, action: "CREATE", entity: "QUOTATION", entityId: created.id, detail: `${created.number} Rev. ${created.revision} (from estimate)` });
  return { quotationId: created.id, number: created.number, revision: created.revision };
}

export { loadDoc as getSavedEstimate };
