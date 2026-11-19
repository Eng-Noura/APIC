import { prisma } from "@/server/db/client";
import { Prisma } from "@prisma/client";
import { buildSnapshot, ENGINE_VERSION, parseUnit } from "@/features/pricing/engine";
import {
  calcItem, sheetTotals, type ItemRow, type RateProfileRow, type MaterialSource,
} from "@/features/pricing/sheet-calc";

export class PricingError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

const sheetInclude = {
  items: {
    orderBy: { sortOrder: "asc" as const },
    include: { materials: { orderBy: { createdAt: "asc" as const } }, components: { orderBy: { sortOrder: "asc" as const } }, overrides: true },
  },
} satisfies Prisma.PricingSheetInclude;
type SheetFull = Prisma.PricingSheetGetPayload<{ include: typeof sheetInclude }>;

async function loadProfiles(projectId: string): Promise<RateProfileRow[]> {
  const rows = await prisma.rateProfile.findMany({
    where: { active: true, OR: [{ scope: "GLOBAL" }, { scope: "PROJECT", projectId }] },
    include: { components: { orderBy: { sortOrder: "asc" } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], // deterministic: when two profiles set the same rate, the later one wins
  });
  return rows.map((p) => ({
    id: p.id, name: p.name, scope: p.scope,
    components: p.components.map((c) => ({ key: c.key, rate: c.rate, enabled: c.enabled, name: c.name, category: c.category, method: c.method, fixed: c.fixed, unit: c.unit, base: c.base })),
  }));
}

function toItemRow(i: SheetFull["items"][number]): ItemRow {
  return {
    id: i.id, itemNo: i.itemNo, description: i.description, unit: i.unit, qty: i.qty, unitWeightKg: i.unitWeightKg,
    calcProfile: i.calcProfile, profileRefs: (i.profileRefs as Record<string, string> | null) ?? null,
    materials: i.materials.map((m) => ({ id: m.id, source: m.source as MaterialSource, name: m.name, grade: m.grade, qty: m.qty, unit: m.unit, unitCost: m.unitCost, importedRef: m.importedRef })),
    components: i.components.map((c) => ({ id: c.id, category: c.category, name: c.name, method: c.method, rate: c.rate, fixed: c.fixed, unit: c.unit, base: c.base, enabled: c.enabled })),
    overrides: i.overrides.map((o) => ({ rateKey: o.rateKey, value: o.value })),
  };
}

/** The sheet the page shows for a project: the latest version that is not superseded, or null. */
export async function findCurrentSheet(projectId: string) {
  return prisma.pricingSheet.findFirst({ where: { projectId, status: { not: "SUPERSEDED" } }, orderBy: [{ version: "desc" }, { createdAt: "desc" }], select: { id: true } });
}

export async function createSheet(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new PricingError("Project not found", 404);
  const existing = await findCurrentSheet(projectId);
  if (existing) throw new PricingError("This project already has a pricing sheet", 409);
  const year = new Date().getFullYear();
  const count = await prisma.pricingSheet.count({ where: { projectId } });
  const sheet = await prisma.pricingSheet.create({
    data: { projectId, createdById: userId, date: new Date(), reference: `PRC-${year}-${String(count + 1).padStart(3, "0")}`, history: { create: { action: "CREATED", message: "Pricing sheet created", userId } } },
  });
  return sheet.id;
}

/** Everything the page needs, computed from CURRENT data by the engine. Nothing here is stored. */
export async function getSheetView(sheetId: string) {
  const sheet = await prisma.pricingSheet.findUnique({ where: { id: sheetId }, include: { ...sheetInclude, history: { orderBy: { createdAt: "desc" }, take: 30 } } });
  if (!sheet) throw new PricingError("Pricing sheet not found", 404);
  const profiles = await loadProfiles(sheet.projectId);
  const calcs = sheet.items.map((i) => calcItem(toItemRow(i), sheet.calcProfile, profiles));
  const totals = sheetTotals(calcs);
  const scopeInSheet = new Set(sheet.items.map((i) => i.scopeItemId).filter(Boolean) as string[]);
  const scopeItems = await prisma.scopeItem.findMany({ where: { projectId: sheet.projectId }, select: { id: true, description: true, parts: { select: { weightKg: true, qty: true } } }, orderBy: { createdAt: "asc" } });
  const availableScope = scopeItems.filter((s) => !scopeInSheet.has(s.id)).map((s) => ({ id: s.id, description: s.description, partCount: s.parts.length, weightKg: s.parts.reduce((a, p) => a + p.weightKg, 0) }));
  const { items, history, ...head } = sheet;
  return {
    sheet: { ...head, date: head.date.toISOString(), createdAt: head.createdAt.toISOString(), updatedAt: head.updatedAt.toISOString(), approvedAt: head.approvedAt?.toISOString() ?? null },
    items: items.map((i, idx) => {
      const c = calcs[idx];
      return {
        id: i.id, itemNo: i.itemNo, description: i.description, unit: i.unit, qty: i.qty, unitWeightKg: i.unitWeightKg, scopeType: i.scopeType,
        scopeItemId: i.scopeItemId, calcProfile: i.calcProfile, profileRefs: (i.profileRefs as Record<string, string> | null) ?? {}, effectiveProfile: c.profile, totalWeightKg: c.totalWeightKg,
        materials: i.materials, components: i.components, overrides: i.overrides.map((o) => ({ rateKey: o.rateKey, value: o.value, reason: o.reason })),
        calc: { ok: c.result.ok, summary: c.result.summary, trace: c.result.trace, issues: c.result.issues },
      };
    }),
    totals, availableScope,
    history: history.map((h) => ({ id: h.id, action: h.action, message: h.message, createdAt: h.createdAt.toISOString() })),
  };
}

type Tx = Prisma.TransactionClient | typeof prisma;

async function editableSheet(tx: Tx, sheetId: string) {
  const s = await tx.pricingSheet.findUnique({ where: { id: sheetId }, select: { id: true, status: true, projectId: true } });
  if (!s) throw new PricingError("Pricing sheet not found", 404);
  if (s.status === "APPROVED" || s.status === "SUPERSEDED") throw new PricingError("An approved sheet is locked. Re-price it as a new version instead.", 409);
  return s;
}
/** Any edit to a calculated sheet makes it a draft again (its snapshot stays as it was). */
async function touch(tx: Tx, sheetId: string) {
  await tx.pricingSheet.updateMany({ where: { id: sheetId, status: "CALCULATED" }, data: { status: "DRAFT" } });
}
async function sheetOfItem(itemId: string) {
  const it = await prisma.pricingItem.findUnique({ where: { id: itemId }, select: { id: true, sheetId: true } });
  if (!it) throw new PricingError("Item not found", 404);
  await editableSheet(prisma, it.sheetId);
  return it;
}
const assertUnit = (u: string) => { const p = parseUnit(u); if (!p) throw new PricingError(`Unknown unit "${u}". Allowed: KG, TON, EA, SQM, M.`); return p; };

export async function addItems(sheetId: string, input: { scopeItemIds: string[] } | { manual: { description: string; unit: string; qty: number; unitWeightKg?: number; scopeType?: string } }) {
  return prisma.$transaction(async (tx) => {
    const sheet = await editableSheet(tx, sheetId);
    const last = await tx.pricingItem.findFirst({ where: { sheetId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    let order = (last?.sortOrder ?? -1) + 1;
    const nextNo = () => String(order + 1);
    if ("manual" in input) {
      const m = input.manual;
      const unit = assertUnit(m.unit);
      await tx.pricingItem.create({ data: { sheetId, itemNo: nextNo(), description: m.description, unit, qty: m.qty, unitWeightKg: m.unitWeightKg, scopeType: m.scopeType ?? "Manual", sortOrder: order } });
    } else {
      const scopes = await tx.scopeItem.findMany({ where: { id: { in: input.scopeItemIds }, projectId: sheet.projectId }, include: { parts: { select: { weightKg: true } } } });
      if (!scopes.length) throw new PricingError("No matching scope items in this project", 404);
      const already = new Set((await tx.pricingItem.findMany({ where: { sheetId, scopeItemId: { in: scopes.map((s) => s.id) } }, select: { scopeItemId: true } })).map((x) => x.scopeItemId));
      for (const s of scopes) {
        if (already.has(s.id)) continue;
        // Default quantity = total part weight in tons; the user can change unit/qty afterwards.
        const kg = s.parts.reduce((a, p) => a + p.weightKg, 0);
        await tx.pricingItem.create({ data: { sheetId, scopeItemId: s.id, itemNo: nextNo(), description: s.description, unit: "TON", qty: kg / 1000, scopeType: "Supply & Install", sortOrder: order } });
        order++;
      }
    }
    await touch(tx, sheetId);
  });
}

type ItemPatch = { itemNo?: string; description?: string; unit?: string; qty?: number; unitWeightKg?: number | null; scopeType?: string; calcProfile?: string | null; profileRefs?: Record<string, string> | null };
export async function patchItem(itemId: string, input: ItemPatch) {
  const it = await sheetOfItem(itemId);
  const { profileRefs, ...data } = input;
  if (data.unit) data.unit = assertUnit(data.unit);
  let refsData: { profileRefs?: Prisma.InputJsonValue | typeof Prisma.DbNull } = {};
  if (profileRefs !== undefined) {
    if (profileRefs === null || !Object.keys(profileRefs).length) refsData = { profileRefs: Prisma.DbNull };
    else {
      // every chosen profile must exist, be active, be visible to this project and sit in the slot of its own type
      const sheet = await prisma.pricingSheet.findUniqueOrThrow({ where: { id: it.sheetId }, select: { projectId: true } });
      const found = await prisma.rateProfile.findMany({ where: { id: { in: Object.values(profileRefs) }, active: true, OR: [{ scope: "GLOBAL" }, { scope: "PROJECT", projectId: sheet.projectId }] }, select: { id: true, type: true } });
      for (const [slot, id] of Object.entries(profileRefs)) {
        const p = found.find((f) => f.id === id);
        if (!p) throw new PricingError("Rate profile not found or not available for this project", 404);
        if (p.type !== slot) throw new PricingError(`Profile type ${p.type} cannot be used as ${slot}`);
      }
      refsData = { profileRefs };
    }
  }
  await prisma.$transaction([prisma.pricingItem.update({ where: { id: itemId }, data: { ...data, ...refsData } }), prisma.pricingSheet.updateMany({ where: { id: it.sheetId, status: "CALCULATED" }, data: { status: "DRAFT" } })]);
}

export async function deleteItem(itemId: string) {
  const it = await sheetOfItem(itemId);
  await prisma.$transaction([prisma.pricingItem.delete({ where: { id: itemId } }), prisma.pricingSheet.updateMany({ where: { id: it.sheetId, status: "CALCULATED" }, data: { status: "DRAFT" } })]);
}

export async function addMaterial(itemId: string, d: { name: string; grade?: string; qty: number; unit: string; unitCost: number; notes?: string }) {
  const it = await sheetOfItem(itemId);
  assertUnit(d.unit);
  await prisma.$transaction([
    prisma.pricingMaterialLine.create({ data: { itemId, source: "MANUAL", name: d.name, grade: d.grade, qty: d.qty, unit: parseUnit(d.unit)!, unitCost: d.unitCost, notes: d.notes } }),
    prisma.pricingSheet.updateMany({ where: { id: it.sheetId, status: "CALCULATED" }, data: { status: "DRAFT" } }),
  ]);
}

async function materialOf(id: string) {
  const m = await prisma.pricingMaterialLine.findUnique({ where: { id }, include: { item: { select: { sheetId: true } } } });
  if (!m) throw new PricingError("Material line not found", 404);
  await editableSheet(prisma, m.item.sheetId);
  // Imported lines are read-only: they mirror their source (Nesting / Stock / Procurement) and re-import would overwrite edits.
  if (m.source !== "MANUAL") throw new PricingError("Imported lines are read-only. Change them at the source and re-import.", 409);
  return m;
}
export async function patchMaterial(id: string, d: { name?: string; grade?: string; qty?: number; unit?: string; unitCost?: number; notes?: string }) {
  const m = await materialOf(id);
  if (d.unit) d.unit = assertUnit(d.unit);
  await prisma.$transaction([prisma.pricingMaterialLine.update({ where: { id }, data: d }), prisma.pricingSheet.updateMany({ where: { id: m.item.sheetId, status: "CALCULATED" }, data: { status: "DRAFT" } })]);
}
export async function deleteMaterial(id: string) {
  const m = await materialOf(id);
  await prisma.$transaction([prisma.pricingMaterialLine.delete({ where: { id } }), prisma.pricingSheet.updateMany({ where: { id: m.item.sheetId, status: "CALCULATED" }, data: { status: "DRAFT" } })]);
}

type ComponentData = { category: string; name: string; method: string; rate: number; fixed?: number | null; unit?: string | null; base?: string | null; enabled?: boolean };
export async function addComponent(itemId: string, d: ComponentData) {
  const it = await sheetOfItem(itemId);
  if (d.unit) d.unit = assertUnit(d.unit);
  const last = await prisma.pricingItemComponent.findFirst({ where: { itemId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  await prisma.$transaction([
    prisma.pricingItemComponent.create({ data: { ...d, itemId, sortOrder: (last?.sortOrder ?? -1) + 1 } }),
    prisma.pricingSheet.updateMany({ where: { id: it.sheetId, status: "CALCULATED" }, data: { status: "DRAFT" } }),
  ]);
}
async function componentOf(id: string) {
  const c = await prisma.pricingItemComponent.findUnique({ where: { id }, include: { item: { select: { sheetId: true } } } });
  if (!c) throw new PricingError("Line not found", 404);
  await editableSheet(prisma, c.item.sheetId);
  return c;
}
export async function patchComponent(id: string, d: Partial<ComponentData>) {
  const c = await componentOf(id);
  if (d.unit) d.unit = assertUnit(d.unit);
  await prisma.$transaction([prisma.pricingItemComponent.update({ where: { id }, data: d }), prisma.pricingSheet.updateMany({ where: { id: c.item.sheetId, status: "CALCULATED" }, data: { status: "DRAFT" } })]);
}
export async function deleteComponent(id: string) {
  const c = await componentOf(id);
  await prisma.$transaction([prisma.pricingItemComponent.delete({ where: { id } }), prisma.pricingSheet.updateMany({ where: { id: c.item.sheetId, status: "CALCULATED" }, data: { status: "DRAFT" } })]);
}

/** value = null removes the override (the rate falls back to profile / project / global). */
export async function setOverride(itemId: string, rateKey: string, value: number | null, reason: string | undefined, userId: string) {
  const it = await sheetOfItem(itemId);
  await prisma.$transaction(async (tx) => {
    if (value === null) await tx.pricingItemOverride.deleteMany({ where: { itemId, rateKey } });
    else await tx.pricingItemOverride.upsert({ where: { itemId_rateKey: { itemId, rateKey } }, create: { itemId, rateKey, value, reason }, update: { value, reason } });
    await tx.pricingHistory.create({ data: { sheetId: it.sheetId, action: "RATE_CHANGED", message: value === null ? `Override "${rateKey}" removed` : `Override "${rateKey}" set to ${value}`, data: { itemId, rateKey, value }, userId } });
    await touch(tx, it.sheetId);
  });
}

/** Recalculate: runs the engine and stores an immutable CALCULATED snapshot. Refuses while any item has errors. */
export async function calculateSheet(sheetId: string, userId: string) {
  const sheet = await prisma.pricingSheet.findUnique({ where: { id: sheetId }, include: sheetInclude });
  if (!sheet) throw new PricingError("Pricing sheet not found", 404);
  if (sheet.status === "APPROVED" || sheet.status === "SUPERSEDED") throw new PricingError("An approved sheet is locked.", 409);
  if (!sheet.items.length) throw new PricingError("Add at least one item before calculating.");
  const profiles = await loadProfiles(sheet.projectId);
  const rows = sheet.items.map(toItemRow);
  const calcs = rows.map((r) => calcItem(r, sheet.calcProfile, profiles));
  const failed = calcs.map((c, i) => ({ c, i })).filter((x) => !x.c.result.summary);
  if (failed.length) {
    const first = failed[0].c.issues.find((i) => i.severity === "error");
    throw new PricingError(`${failed.length} item(s) have errors, e.g. item ${rows[failed[0].i].itemNo}: ${first?.message ?? "calculation failed"}`, 422);
  }
  const payload = buildSnapshot(
    calcs.map((c, i) => ({ meta: { pricingItemId: rows[i].id, scopeItemId: sheet.items[i].scopeItemId, itemNo: rows[i].itemNo, description: rows[i].description, unit: rows[i].unit, qty: rows[i].qty }, result: c.result })),
    { kind: "CALCULATED", sheetVersion: sheet.version, inputs: { items: rows, calcProfile: sheet.calcProfile, profileIds: profiles.map((p) => p.id) } },
  );
  await prisma.$transaction(async (tx) => {
    await tx.pricingSnapshot.create({
      data: {
        sheetId, kind: payload.kind, sheetVersion: payload.sheetVersion, engineVersion: ENGINE_VERSION, createdById: userId,
        roundingPolicy: payload.roundingPolicy as Prisma.InputJsonValue, ratesUsed: payload.ratesUsed as Prisma.InputJsonValue,
        inputs: payload.inputs as Prisma.InputJsonValue, totals: payload.totals as Prisma.InputJsonValue,
        items: { create: payload.items.map((it) => ({ pricingItemId: it.pricingItemId, scopeItemId: it.scopeItemId, itemNo: it.itemNo, description: it.description, unit: it.unit, qty: it.qty, unitRate: it.unitRate, salePrice: it.salePrice, totalCost: it.totalCost, profit: it.profit, profitPct: it.profitPct, data: it.data as Prisma.InputJsonValue })) },
      },
    });
    await tx.pricingSheet.update({ where: { id: sheetId }, data: { status: "CALCULATED", date: new Date() } });
    await tx.pricingHistory.create({ data: { sheetId, action: "CALCULATED", message: `Calculated ${calcs.length} item(s): sale ${payload.totals.salePrice.toFixed(2)} EGP`, data: payload.totals as Prisma.InputJsonValue, userId } });
  });
  return payload.totals;
}
