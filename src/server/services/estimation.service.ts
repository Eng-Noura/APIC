// Pricing & Estimation service. Inputs live in the estimate_* tables; every figure shown or stored is recalculated here
// from those inputs with src/features/estimation/calc.ts — a total sent by the browser is never trusted (none is accepted).
//
// v2: per-item material lines, selectable price sources, DRAFT → CALCULATED → APPROVED workflow with immutable snapshots,
// field-level audit. Every status change goes through transition() (src/features/estimation/workflow.ts).

import type { Prisma, Role } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { logActivity } from "./activity-log.service";
import { getMaterialRequirements } from "./material-usage.service";
import { ensureNestInSync } from "./nest-sync-guard";
import { nextNumber } from "./quotations.service";
import { can } from "@/server/rbac/permissions";
import {
  calcEstimate, fromCents, toCents,
  type AllocationBasis, type DiscountMode, type DiscountTiming, type EstimateInputs, type EstimateResult, type ItemInput, type PriceSource, type ScrapSettings, type SubCostType, type SubPercentBase,
} from "@/features/estimation/calc";
import {
  allocateMaterialRow, buildPriceOptions, buildSnapshot, compareSnapshots, diffFields, initialPrice, partMatchesRow, priceAfterSync, resolveSavedLine, sameJson,
  splitRequiredAmongRows, transition, verifySnapshot, type FieldChange, type PriceOptions, type SheetAction, type SheetStatus,
} from "@/features/estimation/workflow";
import { DEFAULT_OPERATIONS, DEFAULT_PROJECT_COSTS } from "@/features/estimation/defaults";
import type { SaveEstimateInput } from "@/server/validators/estimation";
import type { EstAuditRow, EstimateDoc, EstVersionRow } from "@/features/estimation/types";

export class EstimationError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const include = {
  materials: { orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
  items: { orderBy: { sortOrder: "asc" as const }, include: { operations: { orderBy: { sortOrder: "asc" as const } } } },
  subcontracts: { orderBy: { sortOrder: "asc" as const } },
  projectCosts: { orderBy: { sortOrder: "asc" as const } },
} satisfies Prisma.ProjectEstimateInclude;

export type Db = Prisma.TransactionClient | typeof prisma;
const json = (x: unknown) => x as Prisma.InputJsonValue;
const money2 = (cents: number) => (cents / 100).toFixed(2);

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

export async function audit(db: Db, estimateId: string, userId: string, version: number, action: string, summary: string, changes?: FieldChange[]) {
  await db.estimateAuditEntry.create({ data: { estimateId, userId, version, action, summary, changes: changes && changes.length ? json(changes) : undefined } });
}

// ---------------------------------------------------------------- synchronisation with Part List / Nesting / Procurement

const scrapOf = (e: { scrapUsedLaterPct: number; scrapUsedLaterPrice: number; scrapSellPrice: number; creditRecoveredScrap: boolean }): ScrapSettings =>
  ({ usedLaterPct: e.scrapUsedLaterPct, usedLaterPricePerKg: e.scrapUsedLaterPrice, scrapSellPricePerKg: e.scrapSellPrice, creditRecoveredScrap: e.creditRecoveredScrap });

const EPS = 1e-6;

/**
 * Brings the automatic material lines in step with the project's Material Requirements (nesting → part list fallback).
 *
 * v2: every requirement row is split into one line per BOQ item, pro rata by the NET weight of that item's parts that use the
 * material; parts without a scope item form one shared line (itemId null). What the user changed survives: purchased kg of an
 * edited line, and a MANUAL price. A line whose price source is Procurement / Scrap follows that source. Lines created by
 * the v1 sync (one project-level line per row, no "#" in the key) are converted: the user's price and purchased-kg edit are
 * carried onto the new per-item lines, then the old line is removed so nothing is counted twice.
 */
async function syncMaterials(estimateId: string, projectId: string, scrap: ScrapSettings, userId: string, version: number) {
  const req = await getMaterialRequirements(projectId);
  if (!req) return;
  const rows = req.rows.filter((r) => r.weightKg != null && r.weightKg > 0);

  const [parts, items, existing] = await Promise.all([
    prisma.takeoffPart.findMany({ where: { drawing: { projectId }, partType: { not: "ACCESSORY" } }, select: { scopeId: true, partType: true, material: true, thicknessMm: true, description: true, weightKg: true } }),
    prisma.estimateItem.findMany({ where: { estimateId, scopeItemId: { not: null } }, select: { id: true, scopeItemId: true } }),
    prisma.estimateMaterial.findMany({ where: { estimateId } }),
  ]);
  const scopeToItem = new Map(items.map((i) => [i.scopeItemId!, i.id]));

  // weighted purchase price per kg from supplier orders
  const materialIds = rows.map((r) => r.materialId).filter(Boolean) as string[];
  const orders = materialIds.length ? await prisma.planMaterialOrder.findMany({ where: { materialId: { in: materialIds }, unitPrice: { not: null }, orderedQty: { gt: 0 } }, select: { materialId: true, orderedQty: true, unitPrice: true } }) : [];

  const keyOf = (r: (typeof rows)[number]) => ({ type: r.type, grade: r.grade, thicknessMm: r.thicknessMm, spec: r.spec });
  const matched = (r: (typeof rows)[number]) => parts.filter((p) => partMatchesRow(keyOf(r), { partType: p.partType, material: p.material, thicknessMm: p.thicknessMm, description: p.description }));

  // nest rows of the same thickness + grade share the same parts: share the part weight between them (pro rata purchased kg)
  const isNestRow = (r: (typeof rows)[number]) => r.source === "MATERIALS" && r.widthMm != null;
  const groups = new Map<string, (typeof rows)>();
  for (const r of rows.filter(isNestRow)) {
    const k = `${r.thicknessMm}|${(r.grade ?? "").trim().toLowerCase()}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const requiredByRow = new Map<string, number | null>();
  for (const g of groups.values()) {
    const used = matched(g[0]).reduce((a, p) => a + p.weightKg, 0);
    const split = splitRequiredAmongRows(used, g.map((r) => ({ key: r.id, purchasedKg: r.weightKg! })));
    for (const r of g) requiredByRow.set(r.id, used > 0 ? split[r.id] : null);
  }

  const byRef = new Map(existing.filter((m) => m.sourceRef).map((m) => [m.sourceRef!, m]));
  const seen = new Set<string>();
  let order = existing.length;
  let created = 0, converted = 0, removed = 0, flagged = 0;

  for (const r of rows) {
    const base = r.materialId ? `MAT:${r.materialId}` : `PL:${r.id}`;
    seen.add(base);
    const nest = isNestRow(r);
    const purchasedKg = r.weightKg!;
    const perUnitKg = r.required > 0 ? purchasedKg / r.required : 1;
    const mine = orders.filter((o) => o.materialId === r.materialId);
    const qtySum = mine.reduce((a, o) => a + o.orderedQty, 0);
    const procurement = qtySum > 0 && perUnitKg > 0 ? mine.reduce((a, o) => a + o.orderedQty * (o.unitPrice ?? 0), 0) / qtySum / perUnitKg : null;
    const requiredKg = nest ? requiredByRow.get(r.id) ?? null : purchasedKg;
    const mp = matched(r).map((p) => ({ scopeId: p.scopeId, netKg: p.weightKg }));

    // a v1 project-level line for this row: carry the user's edits onto the new lines, then retire it
    const legacy = byRef.get(base);
    const legacyQtyEdited = !!legacy && legacy.sourcePurchasedKg != null && Math.abs(legacy.purchasedKg - legacy.sourcePurchasedKg) > EPS;
    const legacyPriceEdited = !!legacy && legacy.unitPrice !== (legacy.suggestedUnitPrice ?? 0);
    const reqForAlloc = requiredKg ?? purchasedKg;
    const fromSource = allocateMaterialRow({ purchasedKg, requiredKg: reqForAlloc }, mp);
    const effective = legacyQtyEdited ? allocateMaterialRow({ purchasedKg: legacy!.purchasedKg, requiredKg: reqForAlloc }, mp) : fromSource;

    for (let n = 0; n < fromSource.length; n++) {
      const src = fromSource[n], eff = effective[n];
      const ref = `${base}#${src.scopeId ?? "SHARED"}`;
      seen.add(ref);
      const itemId = src.scopeId ? scopeToItem.get(src.scopeId) ?? null : null;
      const sliceRequired = requiredKg == null ? null : src.requiredKg;
      const common = {
        name: r.type === "Plate" ? "Steel Plate" : r.type === "Profile" || r.type === "Flat" ? r.spec : r.type,
        grade: r.grade === "—" ? null : r.grade, thicknessMm: r.thicknessMm,
        materialType: r.type, dimensions: r.spec, unit: "KG", netKg: sliceRequired ?? src.netKg, itemId,
        source: nest ? "NESTING" : "PART_LIST",
        sourceRequiredKg: sliceRequired, sourcePurchasedKg: src.purchasedKg, requiredKg: sliceRequired,
        suggestedUnitPrice: procurement, suggestedPriceSource: procurement != null ? "PROCUREMENT" : null, sourceMissing: false,
      };
      const cur = byRef.get(ref);
      if (!cur) {
        const options = buildPriceOptions({ procurementPrice: procurement, stockPrice: null, requiredKg: sliceRequired, purchasedKg: eff.purchasedKg, scrap });
        const price = legacy && legacyPriceEdited ? { priceSource: "MANUAL" as PriceSource, unitPrice: legacy.unitPrice } : initialPrice(options);
        await prisma.estimateMaterial.create({ data: { estimateId, sourceRef: ref, ...common, purchasedKg: eff.purchasedKg, unitPrice: price.unitPrice, priceSource: price.priceSource, priceOptions: json(options), sortOrder: order++ } });
        created++;
        continue;
      }
      const qtyEdited = cur.sourcePurchasedKg != null && Math.abs(cur.purchasedKg - cur.sourcePurchasedKg) > EPS;
      const nextKg = qtyEdited ? cur.purchasedKg : src.purchasedKg;
      const options = buildPriceOptions({ procurementPrice: procurement, stockPrice: null, requiredKg: sliceRequired, purchasedKg: nextKg, scrap });
      const { line } = priceAfterSync({ priceSource: cur.priceSource as PriceSource, unitPrice: cur.unitPrice }, options);
      const next = { ...common, purchasedKg: nextKg, unitPrice: line.unitPrice, priceSource: line.priceSource };
      const same =
        cur.name === next.name && cur.grade === next.grade && cur.thicknessMm === next.thicknessMm && cur.materialType === next.materialType && cur.dimensions === next.dimensions &&
        cur.netKg === next.netKg && cur.itemId === next.itemId && cur.source === next.source && cur.requiredKg === next.requiredKg && cur.sourceRequiredKg === next.sourceRequiredKg &&
        cur.sourcePurchasedKg === next.sourcePurchasedKg && cur.purchasedKg === next.purchasedKg && cur.unitPrice === next.unitPrice && cur.priceSource === next.priceSource &&
        cur.suggestedUnitPrice === next.suggestedUnitPrice && !cur.sourceMissing && sameJson(cur.priceOptions, options);
      if (!same) await prisma.estimateMaterial.update({ where: { id: cur.id }, data: { ...next, priceOptions: json(options) } });
    }
    if (legacy) { await prisma.estimateMaterial.delete({ where: { id: legacy.id } }); converted++; }
  }

  // a source row that vanished: drop the line if untouched, otherwise keep it and flag it (the issues panel warns about it)
  for (const m of existing) {
    if (m.source === "MANUAL" || !m.sourceRef || seen.has(m.sourceRef)) continue;
    const isSlice = m.sourceRef.includes("#");
    const qtyEdited = m.sourcePurchasedKg != null && Math.abs(m.purchasedKg - m.sourcePurchasedKg) > EPS;
    const touched = isSlice ? qtyEdited || (m.priceSource === "MANUAL" && m.unitPrice !== 0) : qtyEdited || m.unitPrice !== (m.suggestedUnitPrice ?? 0);
    if (touched) { if (!m.sourceMissing) { await prisma.estimateMaterial.update({ where: { id: m.id }, data: { sourceMissing: true } }); flagged++; } }
    else { await prisma.estimateMaterial.delete({ where: { id: m.id } }); removed++; }
  }
  if (created || converted || removed || flagged) {
    await audit(prisma, estimateId, userId, version, "SYNC", `Materials synchronised: ${created} added, ${converted} converted to per-item lines, ${removed} removed, ${flagged} flagged as source missing`);
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

/** Live data changes the inputs. A CALCULATED sheet whose inputs no longer equal its calculation goes back to DRAFT. */
async function refreshStatus(projectId: string, estimateId: string) {
  const e = await prisma.projectEstimate.findUnique({ where: { id: estimateId }, include });
  if (!e || e.status !== "CALCULATED") return;
  const { inputs } = toInputs(e, await scopeMetrics(projectId));
  const snap = await latestSnapshot(estimateId, e.version, "CALCULATED");
  if (!snap || !sameJson(snap.inputs, inputs)) await prisma.projectEstimate.updateMany({ where: { id: estimateId, status: "CALCULATED" }, data: { status: "DRAFT" } });
}

/** Locked (APPROVED) sheets are never synchronised. */
async function syncAll(projectId: string, estimateId: string, userId: string) {
  const e = await prisma.projectEstimate.findUnique({ where: { id: estimateId }, select: { status: true, version: true, scrapUsedLaterPct: true, scrapUsedLaterPrice: true, scrapSellPrice: true, creditRecoveredScrap: true } });
  if (!e || e.status === "APPROVED") return;
  await syncItems(estimateId, projectId);
  await syncMaterials(estimateId, projectId, scrapOf(e), userId, e.version);
  await refreshStatus(projectId, estimateId);
}

// ---------------------------------------------------------------- snapshots

const latestSnapshot = (estimateId: string, version: number, kind: "CALCULATED" | "APPROVED") =>
  prisma.estimateSnapshot.findFirst({ where: { estimateId, version, kind }, orderBy: { createdAt: "desc" } });

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
      materials: e.materials.map((m) => ({ id: m.id, source: m.source as never, name: m.name, itemId: m.itemId, requiredKg: m.requiredKg, purchasedKg: m.purchasedKg, unitPrice: m.unitPrice, priceSource: m.priceSource as PriceSource })),
      scrap: scrapOf(e),
      items,
      subcontracts: e.subcontracts.map((s) => ({ id: s.id, quantity: s.quantity, unitPrice: s.unitPrice, itemId: s.itemId, selected: s.selected, costType: s.costType as SubCostType, percentBase: s.percentBase as SubPercentBase | null })),
      projectCosts: e.projectCosts.map((c) => ({ id: c.id, enabled: c.enabled, method: c.method as never, rate: c.rate, quantity: c.quantity, percentBase: c.percentBase as never, itemId: c.itemId })),
      commercial: {
        profitMode: e.profitMode as never, profitValue: e.profitValue, insuranceMode: e.insuranceMode as never, insuranceValue: e.insuranceValue, taxPct: e.taxPct,
        discountMode: e.discountMode as DiscountMode, discountValue: e.discountValue, discountTiming: e.discountTiming as DiscountTiming,
        otherChargesValue: e.otherChargesValue, otherChargesTaxable: e.otherChargesTaxable,
        targetSaleCents: e.targetSalePrice != null ? toCents(e.targetSalePrice) : null,
      },
      allocationBasis: e.allocationBasis as AllocationBasis,
    },
  };
}

export async function getEstimateView(projectId: string, userId: string): Promise<EstimateDoc> {
  await ensureNestInSync(projectId);
  const estimateId = await ensureEstimate(projectId, userId);
  await syncAll(projectId, estimateId, userId);
  return loadDoc(projectId);
}

async function loadDoc(projectId: string): Promise<EstimateDoc> {
  const [e, project, metrics] = await Promise.all([
    prisma.projectEstimate.findUnique({ where: { projectId }, include: { ...include, offers: { orderBy: { createdAt: "desc" }, include: { quotation: { select: { id: true, number: true, revision: true, status: true } } } } } }),
    prisma.project.findUnique({ where: { id: projectId }, select: { id: true, number: true, name: true, status: true, updatedAt: true, customer: { select: { name: true } } } }),
    scopeMetrics(projectId),
  ]);
  if (!e || !project) throw new EstimationError("Estimate not found", 404);
  const status = e.status as SheetStatus;

  // An APPROVED sheet shows what was approved: weights and totals come from the approved snapshot, never from live data.
  let { inputs, weights } = toInputs(e, metrics);
  let result: EstimateResult = calcEstimate(inputs);
  if (status === "APPROVED") {
    const snap = await latestSnapshot(e.id, e.version, "APPROVED");
    if (snap) {
      inputs = snap.inputs as unknown as EstimateInputs;
      result = snap.result as unknown as EstimateResult;
      weights = new Map(inputs.items.map((i) => [i.id, { weightKg: i.weightKg, pieces: i.pieces }]));
    }
  }
  const w = (id: string) => weights.get(id) ?? { weightKg: 0, pieces: 0 };
  const issues = [...result.issues];
  for (const m of e.materials) if (m.sourceMissing) issues.push({ level: "warning", scope: "material", id: m.id, message: "The source row of this line disappeared. It is still counted in the cost: check it or remove it." });

  return {
    project: { id: project.id, number: project.number, name: project.name, customer: project.customer?.name ?? "" },
    currency: e.currency, updatedAt: e.updatedAt.toISOString(),
    stageDone: { material: e.materialDone, manufacturing: e.manufacturingDone, project: e.projectCostDone, commercial: e.offers.length > 0 },
    sheet: { number: e.sheetNumber, version: e.version, status, locked: status === "APPROVED", calculatedAt: e.calculatedAt?.toISOString() ?? null, approvedAt: e.approvedAt?.toISOString() ?? null, approvedById: e.approvedById },
    issues, itemTotals: result.items,
    settings: {
      scrapUsedLaterPct: e.scrapUsedLaterPct, scrapUsedLaterPrice: e.scrapUsedLaterPrice, scrapSellPrice: e.scrapSellPrice, creditRecoveredScrap: e.creditRecoveredScrap,
      profitMode: e.profitMode as never, profitValue: e.profitValue, insuranceMode: e.insuranceMode as never, insuranceValue: e.insuranceValue, taxPct: e.taxPct,
      paymentTerms: e.paymentTerms, offerValidityDays: e.offerValidityDays, deliveryDays: e.deliveryDays, exclusions: e.exclusions, commercialNotes: e.commercialNotes,
      discountMode: e.discountMode as DiscountMode, discountValue: e.discountValue, discountTiming: e.discountTiming as DiscountTiming,
      otherChargesLabel: e.otherChargesLabel, otherChargesValue: e.otherChargesValue, otherChargesTaxable: e.otherChargesTaxable,
      targetSalePrice: e.targetSalePrice, advancePct: e.advancePct, milestones: e.milestones, warrantyMonths: e.warrantyMonths, allocationBasis: e.allocationBasis as AllocationBasis,
    },
    materials: e.materials.map((m) => ({
      id: m.id, source: m.source as never, name: m.name, grade: m.grade, thicknessMm: m.thicknessMm, requiredKg: m.requiredKg, purchasedKg: m.purchasedKg, unitPrice: m.unitPrice,
      sourceRequiredKg: m.sourceRequiredKg, sourcePurchasedKg: m.sourcePurchasedKg, suggestedUnitPrice: m.suggestedUnitPrice, sourceMissing: m.sourceMissing,
      itemId: m.itemId, materialType: m.materialType, dimensions: m.dimensions, unit: m.unit, netKg: m.netKg, notes: m.notes,
      priceSource: m.priceSource as PriceSource, priceOptions: (m.priceOptions as unknown as PriceOptions | null) ?? null,
    })),
    items: e.items.map((i) => ({
      id: i.id, name: i.name, linked: !!i.scopeItemId, weightKg: w(i.id).weightKg, pieces: w(i.id).pieces, manualWeightKg: i.manualWeightKg, manualPieces: i.manualPieces, notes: i.notes, scopeItemId: i.scopeItemId,
      operations: i.operations.map((o) => ({ id: o.id, name: o.name, costType: o.costType as never, unit: o.unit, rate: o.rate, quantity: o.quantity, percentBase: o.percentBase as never, selected: o.selected, source: o.source as never, description: o.description, notes: o.notes })),
    })),
    subcontracts: e.subcontracts.map((s) => ({ id: s.id, name: s.name, company: s.company, unit: s.unit, quantity: s.quantity, unitPrice: s.unitPrice, notes: s.notes, description: s.description, costType: s.costType as SubCostType, percentBase: s.percentBase as SubPercentBase | null, selected: s.selected, itemId: s.itemId })),
    projectCosts: e.projectCosts.map((c) => ({ id: c.id, name: c.name, method: c.method as never, unit: c.unit, quantity: c.quantity, rate: c.rate, percentBase: c.percentBase as never, enabled: c.enabled, source: c.source as never, category: c.category, notes: c.notes, itemId: c.itemId })),
    offers: e.offers.map((o) => ({ id: o.id, quotationId: o.quotation.id, number: o.quotation.number, revision: o.quotation.revision, status: o.quotation.status, finalPrice: o.finalPrice, createdAt: o.createdAt.toISOString() })),
    totals: { ...result.totals, ...result.commercial },
  };
}

// ---------------------------------------------------------------- save

const SETTINGS_REQUIRED = ["scrapUsedLaterPct", "scrapUsedLaterPrice", "scrapSellPrice", "creditRecoveredScrap", "profitMode", "profitValue", "insuranceMode", "insuranceValue", "taxPct", "offerValidityDays"] as const;
const SETTINGS_V1_NULLABLE = ["paymentTerms", "deliveryDays", "exclusions", "commercialNotes"] as const; // v1 page: omitted = cleared
const SETTINGS_V2 = ["discountMode", "discountValue", "discountTiming", "otherChargesLabel", "otherChargesValue", "otherChargesTaxable", "targetSalePrice", "advancePct", "milestones", "warrantyMonths", "allocationBasis"] as const; // omitted = untouched
const SETTINGS_FIELDS = [...SETTINGS_REQUIRED, ...SETTINGS_V1_NULLABLE, ...SETTINGS_V2] as const;

const orNull = <T>(v: T | undefined, old: T | null): T | null => (v === undefined ? old : (v as unknown) === "" ? null : v);
const added = (entity: string, label: string): FieldChange => ({ entity, label, field: "(line)", from: null, to: "added" });
const removedLine = (entity: string, label: string): FieldChange => ({ entity, label, field: "(line)", from: "present", to: "removed" });

type MatIn = SaveEstimateInput["materials"][number];

/** Price and purchased kg of a material line after a save (rules: resolveSavedLine in workflow.ts). */
function resolveMaterial(old: Full["materials"][number], m: MatIn, scrap: ScrapSettings): { purchasedKg: number; unitPrice: number; priceSource: PriceSource; priceOptions: PriceOptions | null } {
  const r = resolveSavedLine(
    { source: old.source, priceSource: old.priceSource as PriceSource, unitPrice: old.unitPrice, requiredKg: old.requiredKg, procurementPrice: old.suggestedPriceSource === "PROCUREMENT" ? old.suggestedUnitPrice : null },
    { purchasedKg: m.purchasedKg, unitPrice: m.unitPrice, priceSource: m.priceSource }, scrap,
  );
  if (!r.ok) throw new EstimationError(`${old.name}: ${r.reason}`, 422);
  return { purchasedKg: r.purchasedKg, unitPrice: r.unitPrice, priceSource: r.priceSource, priceOptions: r.options };
}

/** Replaces the editable inputs with what the page sent, in one transaction. Ids must belong to this estimate. An APPROVED sheet cannot be edited. */
export async function saveEstimate(projectId: string, input: SaveEstimateInput, userId: string): Promise<EstimateDoc> {
  const estimateId = await ensureEstimate(projectId, userId);
  const cur = await prisma.projectEstimate.findUnique({ where: { id: estimateId }, include });
  if (!cur) throw new EstimationError("Estimate not found", 404);
  const edit = transition(cur.status as SheetStatus, "EDIT");
  if (!edit.ok) throw new EstimationError(edit.reason, edit.status);
  if (cur.updatedAt.toISOString() !== input.baseUpdatedAt) throw new EstimationError("Someone else saved this estimate while you were editing. Reload to see their changes.", 409);

  const isNew = (id: string) => id.startsWith("new-");
  const own = (rows: { id: string }[]) => { const set = new Set(rows.map((r) => r.id)); return (id: string) => set.has(id); };
  const matIds = own(cur.materials), itemIds = own(cur.items), subIds = own(cur.subcontracts), costIds = own(cur.projectCosts);
  const check = (ok: boolean, what: string) => { if (!ok) throw new EstimationError(`${what} does not belong to this project's estimate`, 400); };
  const checkItemRef = (itemId: string | null | undefined, what: string) => { if (itemId) check(itemIds(itemId), what); };

  // ---- settings (resolved once: used for the audit diff and for the write)
  const sIn = input.settings as Record<string, unknown>, curS = cur as unknown as Record<string, unknown>;
  const afterS: Record<string, unknown> = {};
  for (const f of SETTINGS_REQUIRED) afterS[f] = sIn[f];
  for (const f of SETTINGS_V1_NULLABLE) afterS[f] = sIn[f] === undefined || sIn[f] === "" ? null : sIn[f];
  for (const f of SETTINGS_V2) afterS[f] = sIn[f] === undefined ? curS[f] : sIn[f] === "" ? null : sIn[f];
  const scrapAfter = scrapOf(afterS as never);
  const changes: FieldChange[] = diffFields("settings", "Sheet settings", curS, afterS, SETTINGS_FIELDS);

  // ---- materials (automatic lines: purchased kg, price source/price and notes; manual lines: everything; manual or source-missing lines can be removed)
  const sentMat = new Set(input.materials.map((m) => m.id));
  const removableMat = (m: Full["materials"][number]) => m.source === "MANUAL" || m.sourceMissing;
  const matDeletes = cur.materials.filter((m) => removableMat(m) && !sentMat.has(m.id));
  for (const m of matDeletes) changes.push(removedLine("material", m.name));
  const matWrites = input.materials.map((m) => {
    if (isNew(m.id)) { checkItemRef(m.itemId, "A material line's item"); changes.push(added("material", m.name)); return { m, old: undefined, r: undefined }; }
    check(matIds(m.id), "A material line");
    const old = cur.materials.find((x) => x.id === m.id)!;
    checkItemRef(m.itemId, "A material line's item");
    const r = resolveMaterial(old, m, scrapAfter);
    const before: Record<string, unknown> = { purchasedKg: old.purchasedKg, unitPrice: old.unitPrice, priceSource: old.priceSource, notes: old.notes, name: old.name, grade: old.grade, thicknessMm: old.thicknessMm, requiredKg: old.requiredKg, itemId: old.itemId, materialType: old.materialType, dimensions: old.dimensions };
    const after: Record<string, unknown> = { ...before, purchasedKg: r.purchasedKg, unitPrice: r.unitPrice, priceSource: r.priceSource, notes: orNull(m.notes, old.notes) };
    if (old.source === "MANUAL") Object.assign(after, { name: m.name, grade: m.grade || null, thicknessMm: m.thicknessMm ?? null, requiredKg: m.requiredKg ?? null, itemId: m.itemId === undefined ? old.itemId : m.itemId, materialType: orNull(m.materialType, old.materialType), dimensions: orNull(m.dimensions, old.dimensions) });
    changes.push(...diffFields("material", old.name, before, after, ["purchasedKg", "unitPrice", "priceSource", "notes", "name", "grade", "thicknessMm", "requiredKg", "itemId", "materialType", "dimensions"]));
    return { m, old, r };
  });

  // ---- items & operations
  const sentItems = new Set(input.items.map((i) => i.id));
  const itemDeletes = cur.items.filter((i) => !i.scopeItemId && !sentItems.has(i.id));
  for (const i of itemDeletes) changes.push(removedLine("item", i.name));
  for (const it of input.items) {
    if (isNew(it.id)) { changes.push(added("item", it.name)); continue; }
    check(itemIds(it.id), "An item");
    const old = cur.items.find((x) => x.id === it.id)!;
    if (!old.scopeItemId) changes.push(...diffFields("item", old.name, old as never, { name: it.name, manualWeightKg: it.manualWeightKg ?? null, manualPieces: it.manualPieces ?? null, notes: orNull(it.notes, old.notes) }, ["name", "manualWeightKg", "manualPieces", "notes"]));
    else if (it.notes !== undefined) changes.push(...diffFields("item", old.name, old as never, { notes: orNull(it.notes, old.notes) }, ["notes"]));
    const sentOps = new Set(it.operations.map((o) => o.id));
    for (const o of old.operations) if (!sentOps.has(o.id)) changes.push(removedLine("operation", `${old.name} › ${o.name}`));
    for (const o of it.operations) {
      const label = `${old.name} › ${o.name}`;
      if (isNew(o.id)) { changes.push(added("operation", label)); continue; }
      const oldOp = old.operations.find((x) => x.id === o.id);
      check(!!oldOp, "An operation");
      changes.push(...diffFields("operation", label, oldOp as never, { ...o, quantity: o.costType === "FIXED" || o.costType === "PERCENTAGE" ? null : o.quantity ?? null, percentBase: o.costType === "PERCENTAGE" ? o.percentBase ?? null : null, description: orNull(o.description, oldOp!.description), notes: orNull(o.notes, oldOp!.notes) }, ["name", "costType", "unit", "rate", "quantity", "percentBase", "selected", "description", "notes"]));
    }
  }

  // ---- subcontractors
  const sentSub = new Set(input.subcontracts.map((x) => x.id));
  const subDeletes = cur.subcontracts.filter((x) => !sentSub.has(x.id));
  for (const x of subDeletes) changes.push(removedLine("subcontract", x.name));
  const subWrites = input.subcontracts.map((x, n) => {
    const old = isNew(x.id) ? undefined : (check(subIds(x.id), "A subcontractor service"), cur.subcontracts.find((y) => y.id === x.id)!);
    checkItemRef(x.itemId, "A subcontractor service's item");
    const costType = (x.costType ?? old?.costType ?? "PER_UNIT") as SubCostType;
    const data = {
      name: x.name, company: x.company || null, unit: x.unit, quantity: x.quantity, unitPrice: x.unitPrice, notes: x.notes || null, sortOrder: n,
      description: orNull(x.description, old?.description ?? null), costType,
      percentBase: costType === "PERCENTAGE" ? (x.percentBase ?? old?.percentBase ?? null) : null,
      selected: x.selected ?? old?.selected ?? true, itemId: x.itemId === undefined ? old?.itemId ?? null : x.itemId,
    };
    if (old) changes.push(...diffFields("subcontract", old.name, old as never, data, ["name", "company", "unit", "quantity", "unitPrice", "notes", "description", "costType", "percentBase", "selected", "itemId"]));
    else changes.push(added("subcontract", x.name));
    return { x, old, data };
  });

  // ---- project costs
  const sentCost = new Set(input.projectCosts.map((x) => x.id));
  const costDeletes = cur.projectCosts.filter((x) => !sentCost.has(x.id));
  for (const x of costDeletes) changes.push(removedLine("projectCost", x.name));
  const costWrites = input.projectCosts.map((x, n) => {
    const old = isNew(x.id) ? undefined : (check(costIds(x.id), "A cost item"), cur.projectCosts.find((y) => y.id === x.id)!);
    checkItemRef(x.itemId, "A project cost's item");
    const data = {
      name: x.name, method: x.method, unit: x.unit, quantity: x.method === "FIXED" || x.method === "PERCENTAGE" ? null : x.quantity ?? null, rate: x.rate,
      percentBase: x.method === "PERCENTAGE" ? x.percentBase ?? null : null, enabled: x.enabled, sortOrder: n,
      category: x.category ?? old?.category ?? "", notes: orNull(x.notes, old?.notes ?? null), itemId: x.itemId === undefined ? old?.itemId ?? null : x.itemId,
    };
    if (old) changes.push(...diffFields("projectCost", old.name, old as never, data, ["name", "method", "unit", "quantity", "rate", "percentBase", "enabled", "category", "notes", "itemId"]));
    else changes.push(added("projectCost", x.name));
    return { x, old, data };
  });

  await prisma.$transaction(async (tx) => {
    await tx.projectEstimate.update({
      where: { id: estimateId },
      data: {
        ...(afterS as Prisma.ProjectEstimateUpdateInput),
        materialDone: input.stageDone?.material ?? undefined, manufacturingDone: input.stageDone?.manufacturing ?? undefined, projectCostDone: input.stageDone?.project ?? undefined,
        status: changes.length ? edit.next : undefined, // any real change invalidates a calculation
        updatedById: userId,
      },
    });

    for (const m of matDeletes) await tx.estimateMaterial.delete({ where: { id: m.id } });
    let n = 0;
    for (const { m, old, r } of matWrites) {
      if (!old || !r) {
        await tx.estimateMaterial.create({ data: { estimateId, source: "MANUAL", name: m.name, grade: m.grade || null, thicknessMm: m.thicknessMm ?? null, requiredKg: m.requiredKg ?? null, purchasedKg: m.purchasedKg, unitPrice: m.unitPrice, priceSource: "MANUAL", itemId: m.itemId ?? null, materialType: m.materialType || null, dimensions: m.dimensions || null, unit: m.unit || "KG", notes: m.notes || null, sortOrder: 1000 + n++ } });
        continue;
      }
      const base = { purchasedKg: r.purchasedKg, unitPrice: r.unitPrice, priceSource: r.priceSource, notes: orNull(m.notes, old.notes) };
      await tx.estimateMaterial.update({
        where: { id: m.id },
        data: old.source === "MANUAL"
          ? { ...base, name: m.name, grade: m.grade || null, thicknessMm: m.thicknessMm ?? null, requiredKg: m.requiredKg ?? null, itemId: m.itemId === undefined ? undefined : m.itemId, materialType: m.materialType === undefined ? undefined : m.materialType || null, dimensions: m.dimensions === undefined ? undefined : m.dimensions || null }
          : { ...base, priceOptions: r.priceOptions ? json(r.priceOptions) : undefined },
      });
    }

    // scope-linked items cannot be removed here; they follow the project's Scope list
    for (const i of itemDeletes) await tx.estimateItem.delete({ where: { id: i.id } });
    n = 0;
    for (const it of input.items) {
      let itemId = it.id;
      if (isNew(it.id)) {
        const c = await tx.estimateItem.create({ data: { estimateId, name: it.name, manualWeightKg: it.manualWeightKg ?? null, manualPieces: it.manualPieces ?? null, notes: it.notes || null, sortOrder: 1000 + n++ } });
        itemId = c.id;
      } else {
        const old = cur.items.find((x) => x.id === it.id)!;
        const notes = it.notes === undefined ? undefined : it.notes || null;
        await tx.estimateItem.update({ where: { id: it.id }, data: old.scopeItemId ? { notes } : { name: it.name, manualWeightKg: it.manualWeightKg ?? null, manualPieces: it.manualPieces ?? null, notes } });
        const sentOps = new Set(it.operations.map((o) => o.id));
        for (const o of old.operations) if (!sentOps.has(o.id)) await tx.estimateOperation.delete({ where: { id: o.id } });
      }
      let k = 0;
      for (const o of it.operations) {
        const data = {
          name: o.name, costType: o.costType, unit: o.unit, rate: o.rate, quantity: o.costType === "FIXED" || o.costType === "PERCENTAGE" ? null : o.quantity ?? null,
          percentBase: o.costType === "PERCENTAGE" ? o.percentBase ?? null : null, selected: o.selected, sortOrder: k++,
          description: o.description === undefined ? undefined : o.description || null, notes: o.notes === undefined ? undefined : o.notes || null,
        };
        if (isNew(o.id)) await tx.estimateOperation.create({ data: { ...data, itemId, source: "MANUAL" } });
        else await tx.estimateOperation.update({ where: { id: o.id }, data });
      }
    }

    for (const x of subDeletes) await tx.estimateSubcontract.delete({ where: { id: x.id } });
    for (const { x, old, data } of subWrites) {
      if (old) await tx.estimateSubcontract.update({ where: { id: x.id }, data });
      else await tx.estimateSubcontract.create({ data: { ...data, estimateId } });
    }

    for (const x of costDeletes) await tx.estimateProjectCost.delete({ where: { id: x.id } });
    for (const { x, old, data } of costWrites) {
      if (old) await tx.estimateProjectCost.update({ where: { id: x.id }, data });
      else await tx.estimateProjectCost.create({ data: { ...data, estimateId, source: "MANUAL" } });
    }

    if (changes.length) await audit(tx, estimateId, userId, cur.version, "SAVE", `${changes.length} change${changes.length === 1 ? "" : "s"} saved`, changes);
  });
  await logActivity({ userId, action: "UPDATE", entity: "PROJECT", entityId: projectId, detail: "Pricing estimate saved" });
  return loadDoc(projectId);
}

// ---------------------------------------------------------------- workflow: calculate · approve · reopen · restore

const hasErrorIssue = (r: EstimateResult) => r.issues.some((i) => i.level === "error");

function must(t: ReturnType<typeof transition>): Extract<ReturnType<typeof transition>, { ok: true }> {
  if (!t.ok) throw new EstimationError(t.reason, t.status);
  return t;
}

/** DRAFT/CALCULATED → CALCULATED. Writes an immutable snapshot (inputs + result, verified by recomputing). */
export async function calculateSheet(projectId: string, userId: string): Promise<EstimateDoc> {
  await ensureNestInSync(projectId);
  const estimateId = await ensureEstimate(projectId, userId);
  const first = await prisma.projectEstimate.findUnique({ where: { id: estimateId }, select: { status: true } });
  must(transition((first?.status ?? "DRAFT") as SheetStatus, "CALCULATE")); // a locked sheet is refused before anything is synchronised
  await syncAll(projectId, estimateId, userId);

  const [e, project] = await Promise.all([
    prisma.projectEstimate.findUnique({ where: { id: estimateId }, include }),
    prisma.project.findUnique({ where: { id: projectId }, select: { number: true } }),
  ]);
  if (!e || !project) throw new EstimationError("Estimate not found", 404);
  const { inputs } = toInputs(e, await scopeMetrics(projectId));
  const snap = buildSnapshot(inputs);
  const t = must(transition(e.status as SheetStatus, "CALCULATE", { hasErrors: hasErrorIssue(snap.result) }));
  if (!verifySnapshot(snap)) throw new EstimationError("The calculation could not be verified, so nothing was saved.", 500);

  await prisma.$transaction(async (tx) => {
    const upd = await tx.projectEstimate.updateMany({
      where: { id: estimateId, version: e.version, updatedAt: e.updatedAt, status: { not: "APPROVED" } },
      data: { status: t.next, calculatedAt: new Date(), sheetNumber: e.sheetNumber ?? `PS-${project.number}`, updatedById: userId },
    });
    if (upd.count !== 1) throw new EstimationError("The sheet changed while it was being calculated. Try again.", 409);
    await tx.estimateSnapshot.create({ data: { estimateId, version: e.version, kind: "CALCULATED", inputs: json(snap.inputs), result: json(snap.result), costTotal: money2(snap.costTotalCents), finalPrice: money2(snap.finalPriceCents), createdById: userId } });
    await audit(tx, estimateId, userId, e.version, "RECALCULATE", `Calculated: cost ${fromCents(snap.costTotalCents).toFixed(2)}, final price ${fromCents(snap.finalPriceCents).toFixed(2)} ${e.currency}`);
  });
  await logActivity({ userId, action: "UPDATE", entity: "PROJECT", entityId: projectId, detail: `Pricing sheet v${e.version} calculated` });
  return loadDoc(projectId);
}

/** CALCULATED → APPROVED. Only approves exactly what was calculated; locks the sheet and records the approved snapshot. */
export async function approveSheet(projectId: string, user: { id: string; role: Role }): Promise<EstimateDoc> {
  const e = await prisma.projectEstimate.findUnique({ where: { projectId }, include });
  if (!e) throw new EstimationError("Estimate not found", 404);
  const snap = await latestSnapshot(e.id, e.version, "CALCULATED");
  const { inputs } = toInputs(e, await scopeMetrics(projectId));
  const current = !!snap && sameJson(snap.inputs, inputs);
  const hasErrors = snap ? hasErrorIssue(snap.result as unknown as EstimateResult) : false;
  const t = must(transition(e.status as SheetStatus, "APPROVE", { canApprove: can(user.role, "pricing.approve"), calculatedInputsCurrent: current, hasErrors }));
  if (!snap || !verifySnapshot({ inputs: snap.inputs, result: snap.result })) throw new EstimationError("The stored calculation failed verification. Recalculate before approving.", 409);

  await prisma.$transaction(async (tx) => {
    const upd = await tx.projectEstimate.updateMany({
      where: { id: e.id, status: "CALCULATED", version: e.version, updatedAt: e.updatedAt },
      data: { status: t.next, approvedAt: new Date(), approvedById: user.id, updatedById: user.id },
    });
    if (upd.count !== 1) throw new EstimationError("The sheet changed while it was being approved. Reload and check it again.", 409);
    await tx.estimateSnapshot.create({ data: { estimateId: e.id, version: e.version, kind: "APPROVED", inputs: json(snap.inputs), result: json(snap.result), costTotal: snap.costTotal, finalPrice: snap.finalPrice, note: "Approved", createdById: user.id } });
    await audit(tx, e.id, user.id, e.version, "APPROVE", `Version ${e.version} approved: final price ${Number(snap.finalPrice).toFixed(2)} ${e.currency}`);
  });
  await logActivity({ userId: user.id, action: "UPDATE", entity: "PROJECT", entityId: projectId, detail: `Pricing sheet v${e.version} approved` });
  return loadDoc(projectId);
}

/** APPROVED → DRAFT with version + 1. The approved snapshot and everything issued from it stay exactly as they were. */
export async function reopenSheet(projectId: string, user: { id: string; role: Role }, reason: string): Promise<EstimateDoc> {
  const why = reason.trim();
  if (why.length < 3) throw new EstimationError("Give a reason for reopening", 400);
  const e = await prisma.projectEstimate.findUnique({ where: { projectId }, select: { id: true, status: true, version: true } });
  if (!e) throw new EstimationError("Estimate not found", 404);
  const t = must(transition(e.status as SheetStatus, "REOPEN", { canApprove: can(user.role, "pricing.approve") }));
  await prisma.$transaction(async (tx) => {
    const upd = await tx.projectEstimate.updateMany({
      where: { id: e.id, status: "APPROVED", version: e.version },
      data: { status: t.next, version: { increment: t.versionIncrement }, approvedAt: null, approvedById: null, updatedById: user.id },
    });
    if (upd.count !== 1) throw new EstimationError("The sheet changed while it was being reopened. Reload and try again.", 409);
    await audit(tx, e.id, user.id, e.version + t.versionIncrement, "REOPEN", `Reopened: version ${e.version} → ${e.version + t.versionIncrement}. Reason: ${why}`);
  });
  await logActivity({ userId: user.id, action: "UPDATE", entity: "PROJECT", entityId: projectId, detail: `Pricing sheet reopened as v${e.version + 1}` });
  return loadDoc(projectId);
}

/** Puts an automatic material line back to what the source said: source purchased kg and the default price source. */
export async function restoreMaterialLine(projectId: string, materialId: string, userId: string): Promise<EstimateDoc> {
  const e = await prisma.projectEstimate.findUnique({ where: { projectId }, include });
  if (!e) throw new EstimationError("Estimate not found", 404);
  must(transition(e.status as SheetStatus, "EDIT"));
  const m = e.materials.find((x) => x.id === materialId);
  if (!m) throw new EstimationError("A material line does not belong to this project's estimate", 400);
  if (m.source === "MANUAL" || m.sourcePurchasedKg == null) throw new EstimationError("This line was typed in by hand: there is no imported value to restore.", 422);
  const options = buildPriceOptions({ procurementPrice: m.suggestedPriceSource === "PROCUREMENT" ? m.suggestedUnitPrice : null, stockPrice: null, requiredKg: m.requiredKg, purchasedKg: m.sourcePurchasedKg, scrap: scrapOf(e) });
  const price = initialPrice(options);
  const changes = diffFields("material", m.name, m as never, { purchasedKg: m.sourcePurchasedKg, unitPrice: price.unitPrice, priceSource: price.priceSource }, ["purchasedKg", "unitPrice", "priceSource"]);
  if (!changes.length) return loadDoc(projectId);
  await prisma.$transaction(async (tx) => {
    await tx.estimateMaterial.update({ where: { id: m.id }, data: { purchasedKg: m.sourcePurchasedKg!, unitPrice: price.unitPrice, priceSource: price.priceSource, priceOptions: json(options), sourceMissing: false } });
    await tx.projectEstimate.update({ where: { id: e.id }, data: { status: "DRAFT", updatedById: userId } });
    await audit(tx, e.id, userId, e.version, "RESTORE", `Restored imported values of "${m.name}"`, changes);
  });
  return loadDoc(projectId);
}

// ---------------------------------------------------------------- versions · compare · audit

const versionRow = (s: Prisma.EstimateSnapshotGetPayload<object>): EstVersionRow => ({
  id: s.id, version: s.version, kind: s.kind as "CALCULATED" | "APPROVED", costTotal: Number(s.costTotal), finalPrice: Number(s.finalPrice), note: s.note,
  createdAt: s.createdAt.toISOString(), createdById: s.createdById, verified: verifySnapshot({ inputs: s.inputs, result: s.result }),
});

export async function listVersions(projectId: string): Promise<EstVersionRow[]> {
  const e = await prisma.projectEstimate.findUnique({ where: { projectId }, select: { id: true } });
  if (!e) return [];
  const rows = await prisma.estimateSnapshot.findMany({ where: { estimateId: e.id }, orderBy: [{ version: "desc" }, { createdAt: "desc" }], take: 100 });
  return rows.map(versionRow);
}

export async function compareVersions(projectId: string, fromId: string, toId: string) {
  const e = await prisma.projectEstimate.findUnique({ where: { projectId }, select: { id: true } });
  if (!e) throw new EstimationError("Estimate not found", 404);
  const [a, b] = await Promise.all([fromId, toId].map((id) => prisma.estimateSnapshot.findFirst({ where: { id, estimateId: e.id } })));
  if (!a || !b) throw new EstimationError("A version does not belong to this project's estimate", 404);
  return { from: versionRow(a), to: versionRow(b), deltas: compareSnapshots({ result: a.result as unknown as EstimateResult }, { result: b.result as unknown as EstimateResult }) };
}

export async function listAudit(projectId: string, take = 100): Promise<EstAuditRow[]> {
  const e = await prisma.projectEstimate.findUnique({ where: { projectId }, select: { id: true } });
  if (!e) return [];
  const rows = await prisma.estimateAuditEntry.findMany({ where: { estimateId: e.id }, orderBy: { createdAt: "desc" }, take: Math.min(Math.max(take, 1), 500) });
  return rows.map((r) => ({ id: r.id, action: r.action, summary: r.summary, changes: r.changes, version: r.version, userId: r.userId, createdAt: r.createdAt.toISOString() }));
}

export type { SheetAction };

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
