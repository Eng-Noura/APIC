// CSV import for the parts that are NOT drawn as a DXF: hot-rolled sections
// (bars, angles, beams…), pipes and accessories (bought-out bolts, nuts, washers…). Same forgiving reader as the 1D nesting
// tool (delimiter , ; or tab, UTF-8 BOM, decimal comma). Values stay strings
// so the preview table can edit them freely before anything is saved.

import { splitLine, norm, parsePartType } from "../nesting/csv-parts";

export type CsvPartType = "HOT_ROLLED" | "PIPE" | "ACCESSORY";

export interface CsvPartRow {
  description: string;
  partType: CsvPartType;
  profile: string;
  length: string; // in `lengthUnit`
  qty: string;
  weightPerMeter: string; // kg/m (hot rolled)
  od: string; // mm (pipe)
  thickness: string; // mm (pipe)
  material: string;
  side: "INTERNAL" | "EXTERNAL" | "BOTH";
  paintSides: "1" | "2";
  unit: string; // accessory: pcs / m / set …
  unitWeightKg: string; // accessory: kg per unit (optional)
}

export const TAKEOFF_CSV_TEMPLATE =
  "description,type,profile,length_mm,qty,kg_per_m,material,side,paint_sides,od_mm,thickness_mm,unit,unit_weight_kg\r\n" +
  "Column leg,hot rolled,IPE120,2450,4,10.4,S235,external,2,,,,\r\n" +
  "Bracket,hot rolled,FB50x10,600,12,3.93,S235,external,2,,,,\r\n" +
  "Pipe support,pipe,,1200,2,,S235,internal,1,114.3,6,,\r\n" +
  "Hex-Head Bolt DIN 933 - M16 x 50,accessory,,,120,,8.8,,,,,pcs,0.11582\r\n";

/** Accessory file: no length column needed (bought-out items are counted, not cut). */
export const ACCESSORY_CSV_TEMPLATE =
  "description,type,qty,unit,unit_weight_kg,material\r\n" +
  "Washer DIN 125 - A 17,accessory,120,pcs,0.0113,8.8\r\n" +
  "Hex-Head Bolt DIN 933 - M16 x 50,accessory,120,pcs,0.11582,8.8\r\n" +
  "Hex Nut DIN 934 - M16 x 2,accessory,152,pcs,0.03443,8.8\r\n";

const ALIASES = {
  description: ["description", "name", "part", "partname", "desc", "item"],
  partType: ["type", "parttype", "kind"],
  profile: ["profile", "section", "size"],
  length: ["length", "lengthmm", "lengthm", "len", "cutlength", "lmm"],
  qty: ["qty", "quantity", "pcs", "count", "nos"],
  weightPerMeter: ["kgperm", "kgm", "weightperm", "weightpermeter", "weightm", "unitweight", "wpm"],
  od: ["od", "odmm", "diameter", "outerdiameter"],
  thickness: ["thickness", "thicknessmm", "thk", "thkmm", "wall", "wallmm", "t"],
  material: ["material", "grade", "mat"],
  side: ["side", "location"],
  paintSides: ["paintsides", "paint", "coats"],
  unit: ["unit", "uom"],
  unitWeightKg: ["unitweightkg", "kgperpc", "kgpc", "kgpcs", "kgeach", "kgperunit", "weightperpc", "weightkg", "wtkg"],
} as const;

/** "accessory", "bought-out", "bolt", "nut", "washer"… -> true. */
function isAccessoryType(v: string): boolean {
  return ["accessory", "accessories", "acc", "boughtout", "boughtoutitem", "fastener", "fasteners", "bolt", "nut", "washer"].includes(norm(v));
}
type Field = keyof typeof ALIASES;

export interface TakeoffCsvResult {
  rows: CsvPartRow[];
  /** "m" only when the length column is explicitly in metres (header length_m). */
  lengthUnit: "mm" | "m";
  errors: string[];
}

const clean = (s: string) => s.trim().replace(",", ".");

/** Drawing (section) that holds the bought-out items: bolts, nuts, washers… Its CSV rows default to Accessory. */
export const ACCESSORIES_DRAWING = "ACCESSORIES";
export const ACCESSORIES_DRAWING_TITLE = "Accessories (bolts, nuts, washers)";

export function parseTakeoffCsv(text: string, opts: { defaultAccessory?: boolean } = {}): TakeoffCsvResult {
  const errors: string[] = [];
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { rows: [], lengthUnit: "mm", errors: ["The file is empty."] };

  const head = lines[0];
  const d = [",", ";", "\t"].map((c) => [c, head.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const header = splitLine(head, d).map(norm);
  const idx = {} as Record<Field, number>;
  (Object.keys(ALIASES) as Field[]).forEach((k) => {
    idx[k] = header.findIndex((h) => (ALIASES[k] as readonly string[]).includes(h));
  });
  if (idx.qty < 0) {
    return { rows: [], lengthUnit: "mm", errors: ["The header row must contain a qty column (and a length column, e.g. length_mm, unless every row is an accessory)."] };
  }
  const lengthUnit = header[idx.length] === "lengthm" ? "m" : "mm";

  const rows: CsvPartRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = splitLine(lines[i], d);
    const get = (k: Field) => (idx[k] >= 0 ? c[idx[k]] ?? "" : "");
    const accessory = isAccessoryType(get("partType")) || (opts.defaultAccessory === true && norm(get("partType")) === "");
    if (!accessory && !(Number(clean(get("length"))) > 0)) { errors.push(`Row ${i + 1}: invalid length "${get("length")}"`); continue; }
    if (!(Number(clean(get("qty"))) > 0)) { errors.push(`Row ${i + 1}: invalid qty "${get("qty")}"`); continue; }
    if (accessory) {
      const sideAcc = norm(get("side"));
      rows.push({
        description: get("description"), partType: "ACCESSORY", profile: "", length: "",
        qty: String(Math.round(Number(clean(get("qty"))))), weightPerMeter: "", od: "", thickness: "",
        material: get("material"),
        side: sideAcc === "both" ? "BOTH" : sideAcc === "internal" || sideAcc === "int" || sideAcc === "in" ? "INTERNAL" : "EXTERNAL",
        paintSides: "2", unit: get("unit").trim() || "pcs", unitWeightKg: clean(get("unitWeightKg")),
      });
      continue;
    }

    const typeCell = parsePartType(get("partType"));
    // Only 1D-style types belong here; a plate row means the user should use a DXF.
    if (typeCell === "PLATE") { errors.push(`Row ${i + 1}: plates are imported from DXF files, not CSV`); continue; }
    const partType: CsvPartType = typeCell === "PIPE" ? "PIPE" : "HOT_ROLLED";
    const description = get("description");
    const sideCell = norm(get("side"));
    rows.push({
      description: description || get("profile"),
      partType,
      // No profile column/cell: the part label is the section (e.g. "IPE 300").
      profile: get("profile") || (partType === "HOT_ROLLED" ? description : ""),
      length: clean(get("length")),
      qty: String(Math.round(Number(clean(get("qty"))))),
      weightPerMeter: clean(get("weightPerMeter")),
      od: clean(get("od")),
      thickness: clean(get("thickness")),
      material: get("material"),
      side: sideCell === "both" ? "BOTH" : sideCell === "internal" || sideCell === "int" || sideCell === "in" ? "INTERNAL" : "EXTERNAL",
      paintSides: norm(get("paintSides")) === "1" ? "1" : "2",
      unit: "", unitWeightKg: "",
    });
  }
  return { rows, lengthUnit, errors };
}

const num = (v: string): number => {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) ? n : 0;
};

/** Why a row can't be saved yet (null = ready). */
export function csvRowProblem(r: CsvPartRow): string | null {
  if (!r.description.trim()) return "Description is required";
  if (!(Math.round(num(r.qty)) > 0)) return "Qty must be 1 or more";
  if (r.partType === "ACCESSORY") {
    if (!r.unit.trim()) return "Unit is required for an accessory";
    if (r.unitWeightKg.trim() !== "" && !(Number(r.unitWeightKg) >= 0)) return "Unit weight must be 0 or more";
    return null;
  }
  if (!(num(r.length) > 0)) return "Length is required";
  if (r.partType === "HOT_ROLLED") {
    if (!r.profile.trim()) return "Profile is required";
    if (!(num(r.weightPerMeter) > 0)) return "kg/m is required for hot rolled";
  } else {
    if (!(num(r.od) > 0)) return "OD is required for pipe";
    if (!(num(r.thickness) > 0)) return "Wall thickness is required for pipe";
  }
  return null;
}

/** Payload for POST /api/takeoff/parts (lengths converted to metres). */
export function csvRowToPayload(r: CsvPartRow, drawingId: string, itemNo: number, lengthUnit: "mm" | "m") {
  const lengthM = lengthUnit === "mm" ? num(r.length) / 1000 : num(r.length);
  if (r.partType === "ACCESSORY") {
    return {
      drawingId, itemNo, description: r.description.trim(), material: r.material.trim() || null, side: r.side,
      qty: Math.round(num(r.qty)), paintSides: (r.paintSides === "1" ? 1 : 2) as 1 | 2, buyWeightKg: null,
      partType: "ACCESSORY" as const, thicknessMm: null,
      geometry: { unit: r.unit.trim() || "pcs", unitWeightKg: r.unitWeightKg.trim() === "" ? null : num(r.unitWeightKg) },
      areaFormula: null,
    };
  }
  const base = {
    drawingId,
    itemNo,
    description: r.description.trim(),
    material: r.material.trim() || null,
    side: r.side,
    qty: Math.round(num(r.qty)),
    paintSides: (r.paintSides === "1" ? 1 : 2) as 1 | 2,
    buyWeightKg: null,
  };
  if (r.partType === "HOT_ROLLED") {
    return {
      ...base,
      partType: "HOT_ROLLED" as const,
      thicknessMm: null,
      geometry: { profile: r.profile.trim(), length: Number(lengthM.toFixed(6)), weightPerMeter: num(r.weightPerMeter), paintAreaPerMeter: null },
    };
  }
  return {
    ...base,
    partType: "PIPE" as const,
    thicknessMm: num(r.thickness),
    geometry: { od: Number((num(r.od) / 1000).toFixed(6)), length: Number(lengthM.toFixed(6)) }, // OD is stored in metres, the CSV column is mm
    areaFormula: null,
  };
}
