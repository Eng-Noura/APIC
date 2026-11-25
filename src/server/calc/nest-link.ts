// One part = one thing. The Part List (TakeoffPart) is the single source of a part's NAME and SPECS (thickness,
// material, and for 1D profile / length). The nest tools keep their own row only for what they own — outline, holes,
// placements, results — and never a second opinion about the name or the specs:
//
//   read   : whatever is loaded from the server is overlaid with the Part List values (overlayRows)
//   edit   : a change typed into a nest row is written through to the Part List part (extractEdits)
//   delete : removing a part in either place removes it from the other (removeRows / takeRemovedIds)
//
// Quantity keeps its own two-way rules (src/server/calc/nest-sync.ts: assemblies, conflicts), except for 1D pieces
// that were sent from the Part List (`partId`), which had no quantity link at all and are handled here.
// Pure functions only — no database, no React — so they can be tested on their own.

import type { NestKind } from "./nest-sync";

/** A Part List part, as far as the nest cares. */
export interface LinkedSpec {
  id: string;
  description: string;
  material: string | null;
  thicknessMm: number | null;
  partType: string;
  geometry: unknown;
  qty: number;
  groupId: string | null;
  drawingNumber: string;
  itemNo: number;
  nestKind: string | null;
  nestPartId: number | null;
}

/** What a nest row says about a part that the Part List owns. Only the fields that differ are present. */
export interface SpecPatch {
  description?: string;
  material?: string;
  thicknessMm?: number;
  /** 1D HOT_ROLLED */
  profile?: string;
  /** 1D, in mm */
  lengthMm?: number;
  /** 1D pieces sent from the Part List only */
  qty?: number;
}
export interface SpecEdit { partId: string; patch: SpecPatch }

type Row = Record<string, unknown>;

/** The importers write this when the nest left the material empty; for the nest it still means "not set". */
export const PLACEHOLDER_MATERIAL = "Steel";

const norm = (s: unknown) => (typeof s === "string" ? s : "").trim().replace(/\s+/g, " ").toLowerCase();
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const geo = (p: LinkedSpec) => (p.geometry && typeof p.geometry === "object" ? (p.geometry as Record<string, unknown>) : {});
const keyOf = (kind: NestKind) => (kind === "1D" ? "pieces" : "groups");

/** The material as the nest shows it ("" = not set). */
export const nestMaterialOf = (m: string | null | undefined): string => (!m || norm(m) === norm(PLACEHOLDER_MATERIAL) ? "" : m.trim());

/** "<drawing> #<item> <description>" — what the 1D tool calls a piece that was sent from the Part List. */
export const partListLabel = (p: Pick<LinkedSpec, "drawingNumber" | "itemNo" | "description">) => `${p.drawingNumber} #${p.itemNo} ${p.description}`;

/** Row of a nest that is only nesting detail of another row, never a part of its own. */
function isDerived(row: Row, kind: NestKind): boolean {
  if (kind === "2D") return row.cid != null || (row.seg as { role?: unknown } | null | undefined)?.role === "child";
  return row.segment != null;
}

/** How a nest row finds its Part List part. */
export function indexParts(parts: LinkedSpec[], kind: NestKind) {
  const byNestId = new Map<number, LinkedSpec>();
  const byPartId = new Map<string, LinkedSpec>();
  for (const p of parts) {
    byPartId.set(p.id, p);
    if (p.nestKind === kind && p.nestPartId !== null) byNestId.set(p.nestPartId, p);
  }
  return {
    /** the part a row stands for, and whether the row came FROM the Part List (1D partId) or the part came from the nest */
    find(row: Row): { part: LinkedSpec; fromPartList: boolean } | null {
      if (kind === "1D" && typeof row.partId === "string" && row.partId) {
        const p = byPartId.get(row.partId);
        return p ? { part: p, fromPartList: true } : null;
      }
      const p = isNum(row.id) ? byNestId.get(row.id) : undefined;
      return p ? { part: p, fromPartList: false } : null;
    },
  };
}

/** The values a row must show for its part (only the fields the Part List owns). */
function expected(row: Row, part: LinkedSpec, fromPartList: boolean, kind: NestKind): Row {
  const out: Row = {};
  out.name = fromPartList ? partListLabel(part) : part.description;
  out.material = nestMaterialOf(part.material);
  if (kind === "2D") {
    if (isNum(part.thicknessMm) && part.thicknessMm > 0) out.th = part.thicknessMm;
  } else {
    const g = geo(part);
    if (part.partType === "HOT_ROLLED" && typeof g.profile === "string" && g.profile) out.profile = g.profile;
    if ((part.partType === "HOT_ROLLED" || part.partType === "PIPE") && isNum(g.length) && g.length > 0) out.length = Math.round(g.length * 1e6) / 1e3;
    if (fromPartList) out.qty = part.qty;
  }
  return out;
}

const sameField = (field: string, a: unknown, b: unknown): boolean =>
  field === "name" || field === "material" || field === "profile" ? norm(a) === norm(b) : isNum(a) && isNum(b) ? Math.abs(a - b) < 1e-6 : a === b;

/** Fields of the row that differ from what its part says. */
function differences(row: Row, want: Row): string[] {
  return Object.keys(want).filter((f) => !sameField(f, row[f], want[f]));
}

/**
 * Read side: every linked row shows the Part List's name and specs. `changed` tells whether anything had to be
 * rewritten; a 1D change of profile / length / quantity also drops the saved cutting result (it no longer fits).
 */
export function overlayRows(data: unknown, kind: NestKind, parts: LinkedSpec[]): { data: unknown; changed: boolean } {
  const key = keyOf(kind);
  const rows = (data as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(rows) || parts.length === 0) return { data, changed: false };
  const idx = indexParts(parts, kind);
  let changed = false;
  let invalidates = false;
  const next = (rows as Row[]).map((row) => {
    if (!row || typeof row !== "object" || isDerived(row, kind)) return row;
    const hit = idx.find(row);
    if (!hit) return row;
    const want = expected(row, hit.part, hit.fromPartList, kind);
    const diff = differences(row, want);
    if (!diff.length) return row;
    changed = true;
    if (kind === "1D" && diff.some((f) => f !== "name")) invalidates = true;
    const patch: Row = {};
    for (const f of diff) patch[f] = want[f];
    return { ...row, ...patch };
  });
  if (!changed) return { data, changed: false };
  const out = { ...(data as object), [key]: next } as Record<string, unknown>;
  if (invalidates) { out.result = null; out.resS = null; }
  return { data: out, changed: true };
}

/**
 * Write side: what the nest rows say that the Part List does not. Call it with data that came from a tab that was
 * up to date (the version check guarantees it), so every difference is something the person typed in the nest.
 */
export function extractEdits(data: unknown, kind: NestKind, parts: LinkedSpec[], knownWeight: (profile: string) => number | null = () => null): SpecEdit[] {
  const key = keyOf(kind);
  const rows = (data as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(rows) || parts.length === 0) return [];
  const idx = indexParts(parts, kind);
  const edits = new Map<string, SpecPatch>();
  for (const row of rows as Row[]) {
    if (!row || typeof row !== "object" || isDerived(row, kind)) continue;
    const hit = idx.find(row);
    if (!hit) continue;
    const { part, fromPartList } = hit;
    const want = expected(row, part, fromPartList, kind);
    const patch: SpecPatch = {};
    for (const f of differences(row, want)) {
      const v = row[f];
      if (f === "name" && typeof v === "string" && v.trim()) {
        const prefix = `${part.drawingNumber} #${part.itemNo} `;
        const plain = fromPartList && v.startsWith(prefix) ? v.slice(prefix.length) : v;
        if (plain.trim()) patch.description = plain.trim();
      } else if (f === "material") patch.material = typeof v === "string" && v.trim() ? v.trim() : PLACEHOLDER_MATERIAL;
      else if (f === "th" && isNum(v) && v > 0) patch.thicknessMm = v;
      else if (f === "profile" && typeof v === "string" && v.trim() && knownWeight(v.trim()) !== null) patch.profile = v.trim(); // an unknown weight per metre would corrupt the weight: the Part List keeps its profile
      else if (f === "length" && isNum(v) && v > 0) patch.lengthMm = v;
      else if (f === "qty" && isNum(v) && v > 0 && !part.groupId) patch.qty = Math.round(v); // an assembly's quantity comes from the assembly
    }
    if (Object.keys(patch).length) edits.set(part.id, { ...(edits.get(part.id) ?? {}), ...patch });
  }
  return [...edits].map(([partId, patch]) => ({ partId, patch }));
}

/** Delete side (Part List -> nest): the rows of these nest ids, plus the pieces / copies that only exist because of them. */
export function removeRows(data: unknown, kind: NestKind, ids: number[], partIds: string[] = []): { data: unknown; removed: number[] } {
  const key = keyOf(kind);
  const rows = (data as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(rows) || (ids.length === 0 && partIds.length === 0)) return { data, removed: [] };
  const drop = new Set(ids);
  const dropParts = new Set(partIds);
  // 1D pieces sent from the Part List are found by the part's id, the others by their nest id
  if (kind === "1D" && dropParts.size) for (const row of rows as Row[]) if (row && typeof row.partId === "string" && dropParts.has(row.partId) && isNum(row.id)) drop.add(row.id);
  const removed: number[] = [];
  const next = (rows as Row[]).filter((row) => {
    if (!row || typeof row !== "object") return true;
    const own = isNum(row.id) && drop.has(row.id);
    const parentId = kind === "2D" ? (row.seg as { parentId?: unknown } | null | undefined)?.parentId : (row.segment as { parentId?: unknown } | null | undefined)?.parentId;
    const child = (isNum(parentId) && drop.has(parentId)) || (kind === "2D" && isNum(row.cid) && drop.has(row.cid));
    if (!own && !child) return true;
    if (own) removed.push(row.id as number);
    return false;
  });
  if (!removed.length) return { data, removed };
  const out = { ...(data as object), [key]: next } as Record<string, unknown>;
  out.result = null; // the placements / cutting plan refer to rows that are gone
  out.resS = null;
  return { data: out, removed };
}

/** The Part List parts that the given nest rows were sent from (1D `partId`), read from the snapshot as it was BEFORE they were removed. */
export function partIdsOfRows(data: unknown, kind: NestKind, ids: number[]): string[] {
  const rows = (data as Record<string, unknown> | null)?.[keyOf(kind)];
  if (kind !== "1D" || !Array.isArray(rows)) return [];
  const want = new Set(ids);
  return (rows as Row[]).flatMap((r) => (r && isNum(r.id) && want.has(r.id) && typeof r.partId === "string" && r.partId ? [r.partId] : []));
}

/** Delete side (nest -> Part List): the nest tool lists what the person removed in `removedIds`; this takes them out of the snapshot. */
export function takeRemovedIds(data: unknown): { data: unknown; ids: number[] } {
  const raw = (data as { removedIds?: unknown } | null)?.removedIds;
  if (raw === undefined) return { data, ids: [] };
  const ids = Array.isArray(raw) ? [...new Set((raw as unknown[]).filter(isNum))] : [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { removedIds: _gone, ...rest } = data as Record<string, unknown>;
  return { data: rest, ids };
}
