// Pieces of a saved 1D Nesting workspace -> parts of Part List (the 1D counterpart of nest-parts.ts).
//
// The 1D tool stores every piece as profile + material + cut length (mm) + quantity (see Piece1D in
// nesting/nest-boost-1d/engine.ts). Part List needs a type-specific geometry, so a piece becomes:
//   - HOT_ROLLED (IPE / FB / UPN / ...) : profile, length (m) and weight per metre;
//   - PIPE                              : outer diameter (m), length (m) and wall thickness (mm),
//                                         read from a profile name like "PIPE OD60.3x3.2".
// Nothing is invented: a profile whose weight per metre is not known (and not typed by the person) or a pipe
// whose size cannot be read is reported with the reason instead of being added with a guess.
// Pure functions only (no React, no fetch, no database), so they are easy to test.

import { profileWeightPerMeter } from "@/features/nesting/report/profile-weight";

export type Piece1DKind = "HOT_ROLLED" | "PIPE" | "PLATE";

export interface NestPiece {
  /** Id of the piece inside the 1D nest (stable while the piece exists). */
  id: number;
  name: string;
  profile: string;
  material: string;
  /** Cut length in mm (0 = not filled in yet). */
  lengthMm: number;
  qty: number;
  partType: Piece1DKind;
  /** Set when the piece was sent to the nest FROM a Part List part (that part is the original). */
  partId: string | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The pieces of a 1D nesting snapshot (`data` of /api/nesting/workspace?kind=1D). Anything unusable is skipped. */
export function parseNestPieces(data: unknown): NestPiece[] {
  const pieces = (data as { pieces?: unknown } | null)?.pieces;
  if (!Array.isArray(pieces)) return [];
  const out: NestPiece[] = [];
  for (const p of pieces as Record<string, unknown>[]) {
    if (!p || typeof p !== "object") continue;
    if (!isNum(p.id)) continue;
    // a segment of a part that is longer than every bar: the part itself is the item, its segments are nesting detail
    if (p.segment != null) continue;
    const qty = isNum(p.qty) ? Math.round(p.qty) : 0;
    if (qty <= 0) continue;
    const type = p.partType === "PLATE" || p.partType === "PIPE" ? p.partType : "HOT_ROLLED";
    out.push({
      id: p.id,
      name: str(p.name),
      profile: str(p.profile),
      material: str(p.material),
      lengthMm: isNum(p.length) && p.length > 0 ? p.length : 0,
      qty,
      partType: type,
      partId: str(p.partId) || null,
    });
  }
  return out;
}

const round = (x: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
const fmt = (x: number) => String(round(x, 2));

/** "PIPE OD60.3x3.2" -> outer diameter 60.3 mm, wall 3.2 mm. Null when the size cannot be read. */
export function parsePipeProfile(profile: string): { odMm: number; thicknessMm: number } | null {
  const m = /^\s*PIPE\s*OD\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*$/i.exec(profile);
  if (!m) return null;
  const odMm = Number(m[1]);
  const thicknessMm = Number(m[2]);
  return odMm > 0 && thicknessMm > 0 ? { odMm, thicknessMm } : null;
}

/** Key that identifies a Part List part by what the 1D tool shows for it: "<drawing> #<item> <description>". */
export const partListLabel = (drawingNumber: string, itemNo: number, description: string) => `${drawingNumber} #${itemNo} ${description}`;

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * True when the piece came from a Part List part (so it must never be taken back into Part List as a new part).
 * New pieces carry the part's id; pieces saved before that existed are recognised by their name, which the 1D tool
 * builds from drawing number, item number and description (see partListLabel).
 */
export function isFromPartList(p: Pick<NestPiece, "name" | "partId">, labels: Set<string>): boolean {
  return p.partId !== null || labels.has(norm(p.name));
}
export const labelSet = (labels: string[]) => new Set(labels.map(norm));

/** Row name in Part List. A generic name ("Part #3") is replaced by the profile; the length is added unless the name shows it. */
export function pieceDescription(p: Pick<NestPiece, "name" | "profile" | "lengthMm">): string {
  const name = p.name.replace(/\.dxf$/i, "").trim();
  const generic = !name || /^part\s*#?\s*\d+$/i.test(name);
  let base = generic ? p.profile || "Part" : name;
  if (p.lengthMm > 0) {
    const len = fmt(p.lengthMm);
    if (!new RegExp(`(^|\\D)${len.replace(".", "\\.")}(\\D|$)`).test(base)) base += ` L=${len}`;
  }
  return base;
}

/** Values the person can supply for what the nest does not say (weight per metre of an unknown profile, pipe size). */
export interface PieceOverrides {
  weightPerMeter?: number;
  odMm?: number;
  thicknessMm?: number;
}

export interface PartDraft {
  partType: "HOT_ROLLED" | "PIPE";
  description: string;
  material: string;
  qty: number;
  thicknessMm: number | null;
  geometry: Record<string, unknown>;
}

export type DraftResult = { ok: true; draft: PartDraft } | { ok: false; reason: string };

/** What it takes to make this piece a part: the part's fields, or the reason it cannot be made. */
export function buildPartFromPiece(p: NestPiece, over: PieceOverrides = {}): DraftResult {
  const description = pieceDescription(p);
  const material = p.material || "Steel";
  if (p.partType === "PLATE") return { ok: false, reason: "Plate — plates are taken from the 2D nest" };
  if (!(p.lengthMm > 0)) return { ok: false, reason: "no cut length yet" };
  const length = round(p.lengthMm / 1000, 6);

  if (p.partType === "PIPE") {
    const read = parsePipeProfile(p.profile);
    const odMm = over.odMm && over.odMm > 0 ? over.odMm : read?.odMm;
    const thicknessMm = over.thicknessMm && over.thicknessMm > 0 ? over.thicknessMm : read?.thicknessMm;
    if (!odMm || !thicknessMm) {
      return { ok: false, reason: `pipe size not readable from "${p.profile || "(no profile)"}" — name it like PIPE OD60.3x3.2` };
    }
    return { ok: true, draft: { partType: "PIPE", description, material, qty: p.qty, thicknessMm, geometry: { od: round(odMm / 1000, 6), length } } };
  }

  if (!p.profile) return { ok: false, reason: "no profile" };
  const known = profileWeightPerMeter(p.profile);
  const weight = over.weightPerMeter && over.weightPerMeter > 0 ? over.weightPerMeter : known;
  if (!weight) return { ok: false, reason: `weight per metre of profile ${p.profile} is not known` };
  return {
    ok: true,
    draft: { partType: "HOT_ROLLED", description, material, qty: p.qty, thicknessMm: null, geometry: { profile: p.profile, length, weightPerMeter: round(weight, 4) } },
  };
}

/** Weight per metre the standard table gives for this piece's profile (null = unknown), to prefill an input. */
export const knownWeightPerMeter = (p: Pick<NestPiece, "profile" | "partType">): number | null =>
  p.partType === "HOT_ROLLED" && p.profile ? (() => { const w = profileWeightPerMeter(p.profile); return w ? round(w, 4) : null; })() : null;
