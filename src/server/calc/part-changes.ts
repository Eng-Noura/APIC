// Describes what changed between two versions of a Part List part, in words, for the part's history
// ("qty 2 → 4, thickness 12 → 15 mm"). Pure: no database.

type Rec = Record<string, unknown>;

export interface PartFields {
  itemNo?: number;
  description?: string;
  partType?: string;
  side?: string;
  qty?: number;
  thicknessMm?: number | null;
  material?: string | null;
  paintSides?: number;
  posNo?: string | null;
  remark?: string | null;
  qtyPerAssembly?: number;
  areaFormula?: string | null;
  geometry?: unknown;
}

const LABEL: Record<string, string> = {
  itemNo: "item no", partType: "type", side: "side", qty: "qty", material: "material", paintSides: "paint sides",
  posNo: "pos no", remark: "remark", qtyPerAssembly: "qty per assembly", areaFormula: "area formula",
};
const UNIT: Record<string, string> = { thicknessMm: " mm" };

const show = (v: unknown): string => (v === null || v === undefined || v === "" ? "—" : typeof v === "string" ? `"${v}"` : String(v));
const blank = (v: unknown) => (v === "" || v === undefined ? null : v);
const same = (a: unknown, b: unknown) => blank(a) === blank(b) || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) < 1e-9);

/** The changes, one short phrase each; empty when nothing a person typed has changed. */
export function describeChanges(before: PartFields, after: PartFields): string[] {
  const out: string[] = [];
  if (!same(before.description, after.description)) out.push(`name ${show(before.description)} → ${show(after.description)}`);
  for (const key of ["partType", "side", "qty", "material", "paintSides", "itemNo", "qtyPerAssembly", "posNo", "remark", "areaFormula"] as const) {
    if (after[key] === undefined) continue;
    const b = before[key] ?? null;
    const a = after[key] ?? null;
    if (!same(b, a)) out.push(`${LABEL[key]} ${show(b)} → ${show(a)}`);
  }
  if (after.thicknessMm !== undefined && !same(before.thicknessMm ?? null, after.thicknessMm ?? null)) {
    out.push(`thickness ${show(before.thicknessMm)} → ${show(after.thicknessMm)}${UNIT.thicknessMm}`);
  }
  const gb = (before.geometry && typeof before.geometry === "object" ? before.geometry : {}) as Rec;
  const ga = (after.geometry && typeof after.geometry === "object" ? after.geometry : {}) as Rec;
  if (after.geometry !== undefined) {
    for (const k of new Set([...Object.keys(gb), ...Object.keys(ga)])) {
      if (!same(gb[k], ga[k])) out.push(`${k} ${show(gb[k])} → ${show(ga[k])}`);
    }
  }
  return out;
}
