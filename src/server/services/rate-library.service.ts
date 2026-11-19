import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { parseUnit } from "@/features/pricing/engine";
import { CHAIN_METHOD, checkComponent, isLineKey, LINE_TYPE_CATEGORY, newLineKey, allowedChainKeys, type ProfileType } from "@/features/pricing/rate-library";
import { lineComponent } from "@/features/pricing/sheet-calc";
import { PricingError } from "./pricing.service";

const profileInclude = { components: { orderBy: { sortOrder: "asc" as const } }, project: { select: { name: true } } };

export async function listProfiles(projectId?: string | null) {
  const rows = await prisma.rateProfile.findMany({
    where: { OR: [{ scope: "GLOBAL" }, ...(projectId ? [{ scope: "PROJECT" as const, projectId }] : [])] },
    include: profileInclude, orderBy: [{ type: "asc" }, { name: "asc" }],
  });
  return rows.map((p) => ({
    id: p.id, type: p.type, name: p.name, description: p.description, scope: p.scope, active: p.active, projectId: p.projectId, projectName: p.project?.name ?? null,
    components: p.components.map((c) => ({ id: c.id, key: c.key, name: c.name, category: c.category, method: c.method, rate: c.rate, fixed: c.fixed, unit: c.unit, base: c.base, enabled: c.enabled, notes: c.notes })),
  }));
}

export async function createProfile(d: { type: ProfileType; name: string; description?: string; scope: "GLOBAL" | "PROJECT"; projectId?: string }, userId: string) {
  if (d.scope === "PROJECT") {
    const p = await prisma.project.findUnique({ where: { id: d.projectId! }, select: { id: true } });
    if (!p) throw new PricingError("Project not found", 404);
  }
  const dup = await prisma.rateProfile.findFirst({ where: { type: d.type, name: d.name, scope: d.scope, projectId: d.scope === "PROJECT" ? d.projectId : null }, select: { id: true } });
  if (dup) throw new PricingError("A profile with this name already exists for this type", 409);
  return prisma.rateProfile.create({ data: { type: d.type, name: d.name, description: d.description, scope: d.scope, projectId: d.scope === "PROJECT" ? d.projectId : null, createdById: userId }, select: { id: true } });
}

export async function patchProfile(id: string, d: { name?: string; description?: string | null; active?: boolean }) {
  const p = await prisma.rateProfile.findUnique({ where: { id }, select: { id: true } });
  if (!p) throw new PricingError("Profile not found", 404);
  await prisma.rateProfile.update({ where: { id }, data: d });
}

/** Item rows that selected this profile (profileRefs is JSON, so this is checked in code). */
async function usedBy(profileId: string) {
  const items = await prisma.pricingItem.findMany({ where: { profileRefs: { not: Prisma.DbNull } }, select: { profileRefs: true, sheet: { select: { status: true } } } });
  return items.filter((i) => Object.values((i.profileRefs as Record<string, string>) ?? {}).includes(profileId)).length;
}
export async function deleteProfile(id: string) {
  const n = await usedBy(id);
  if (n > 0) throw new PricingError(`This profile is selected by ${n} pricing item(s). Deactivate it instead of deleting.`, 409);
  await prisma.rateProfile.delete({ where: { id } }).catch(() => { throw new PricingError("Profile not found", 404); });
}

type CompInput = { key: string; name: string; category: string; method: string; rate: number; fixed?: number | null; unit?: string | null; base?: string | null; enabled?: boolean; notes?: string };

export async function addComponent(profileId: string, input: CompInput) {
  const prof = await prisma.rateProfile.findUnique({ where: { id: profileId }, select: { type: true } });
  if (!prof) throw new PricingError("Profile not found", 404);
  const type = prof.type as ProfileType;
  const d = { ...input };
  if (d.key === "line.new") d.key = newLineKey(); // the client asks for a fresh template line
  const chk = checkComponent(type, d);
  if (!chk.ok) throw new PricingError(chk.error);
  if (chk.kind === "line") {
    d.category = LINE_TYPE_CATEGORY[type]!;
    if (d.unit && !parseUnit(d.unit)) throw new PricingError(`Unknown unit "${d.unit}".`);
    // the same validation the calculation applies, so an unusable template can never be saved
    const t = lineComponent({ id: "check", category: d.category, name: d.name, method: d.method, rate: d.rate, fixed: d.fixed, unit: d.unit, base: d.base, enabled: true });
    if (t.issue) throw new PricingError(t.issue.message);
  } else {
    const meta = allowedChainKeys(type).find((r) => r.key === d.key)!;
    d.method = CHAIN_METHOD[meta.kind]; d.category = "RATE"; d.name = meta.label; d.fixed = null; d.unit = null; d.base = null;
    const exists = await prisma.rateComponent.findUnique({ where: { profileId_key: { profileId, key: d.key } }, select: { id: true } });
    if (exists) throw new PricingError(`"${meta.label}" is already in this profile. Edit it instead.`, 409);
  }
  const last = await prisma.rateComponent.findFirst({ where: { profileId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  await prisma.rateComponent.create({ data: { profileId, key: d.key, name: d.name, category: d.category, method: d.method, rate: d.rate, fixed: d.fixed ?? null, unit: d.unit ?? null, base: d.base ?? null, enabled: d.enabled ?? true, notes: d.notes, sortOrder: (last?.sortOrder ?? -1) + 1 } });
}

export async function patchComponent(id: string, d: { name?: string; rate?: number; fixed?: number | null; unit?: string | null; base?: string | null; enabled?: boolean; notes?: string }) {
  const c = await prisma.rateComponent.findUnique({ where: { id }, include: { profile: { select: { type: true } } } });
  if (!c) throw new PricingError("Rate not found", 404);
  const chk = checkComponent(c.profile.type as ProfileType, { key: c.key, rate: d.rate ?? c.rate });
  if (!chk.ok) throw new PricingError(chk.error);
  if (!isLineKey(c.key)) { delete d.name; delete d.fixed; delete d.unit; delete d.base; } // chain rates only change value / on-off / notes
  else if (d.unit && !parseUnit(d.unit)) throw new PricingError(`Unknown unit "${d.unit}".`);
  await prisma.rateComponent.update({ where: { id }, data: d });
}
export async function deleteComponent(id: string) {
  await prisma.rateComponent.delete({ where: { id } }).catch(() => { throw new PricingError("Rate not found", 404); });
}
