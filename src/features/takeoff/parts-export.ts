import type ExcelJS from "exceljs";
import type { TakeoffDrawingRow, TakeoffPartRow } from "./types";
import { UNASSIGNED, type PartFilters } from "./part-filters";

/**
 * Part List export: every assembly with the parts under it, one part per row, every cell filled
 * ("-" where a column does not apply to the part's type, e.g. Width of a pipe).
 * The same model feeds the Excel file (two sheets) and the CSV file (flat, one row per part).
 */

interface AssemblyLite { id: string; code: string; name: string; qty: number; parentId: string | null }
interface Lists {
  assemblies: AssemblyLite[];
  scopes: { id: string; description: string }[];
  workOrders: { id: string; code: string; name: string }[];
}

export const NA = "-";

export const EXPORT_HEADERS = [
  "Assembly", "Drawing", "Item", "Pos No", "Description", "Type", "Material", "Profile / Spec",
  "Width (m)", "Length (m)", "Thk (mm)", "OD (m)", "D1 (m)", "D2 (m)", "Height (m)",
  "Qty", "Qty / Asm", "Unit Wt (kg)", "Total Wt (kg)", "Area (m²)", "Paint Area (m²)",
  "Side", "Scope", "Work Order", "Remark",
] as const;

const COL = Object.fromEntries(EXPORT_HEADERS.map((h, i) => [h, i])) as Record<(typeof EXPORT_HEADERS)[number], number>;
const NUM_COLS = {
  dims: [COL["Width (m)"], COL["Length (m)"], COL["OD (m)"], COL["D1 (m)"], COL["D2 (m)"], COL["Height (m)"]],
  thk: [COL["Thk (mm)"]],
  weight: [COL["Unit Wt (kg)"], COL["Total Wt (kg)"]],
  area: [COL["Area (m²)"], COL["Paint Area (m²)"]],
};

export type Cell = string | number;

export interface ExportRow { cells: Cell[]; qty: number; weightKg: number; areaSqm: number; paintSqm: number }
export interface ExportSection {
  key: string;
  /** "A › A1 — Name" */
  title: string;
  /** how many of the assembly are built (null for "No assembly") */
  asmQty: number | null;
  rows: ExportRow[];
  totals: { qty: number; weightKg: number; areaSqm: number; paintSqm: number };
}
export interface ExportModel {
  sections: ExportSection[];
  totals: { parts: number; qty: number; weightKg: number; areaSqm: number; paintSqm: number };
}

const n = (v: unknown): number => {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};
const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const dim = (v: unknown): Cell => (n(v) > 0 ? r(n(v), 4) : NA);
const text = (v: string | null | undefined): string => (v && v.trim() !== "" ? v.trim() : NA);

const TYPE_LABEL: Record<TakeoffPartRow["partType"], string> = {
  PLATE: "Plate", HOT_ROLLED: "Hot Rolled", CONE: "Cone", PIPE: "Pipe", ACCESSORY: "Accessory",
};
const SIDE_LABEL: Record<TakeoffPartRow["side"], string> = { INTERNAL: "Internal", EXTERNAL: "External", BOTH: "Both" };

function specOf(p: TakeoffPartRow, g: Record<string, unknown>): string {
  if (p.partType === "HOT_ROLLED") {
    const wpm = n(g.weightPerMeter);
    return `${text(String(g.profile ?? ""))}${wpm > 0 ? ` · ${r(wpm, 3)} kg/m` : ""}`;
  }
  if (p.partType === "ACCESSORY") {
    const uw = n(g.unitWeightKg);
    return `per ${text(String(g.unit ?? "")) === NA ? "pcs" : String(g.unit)}${uw > 0 ? ` · ${r(uw, 3)} kg each` : ""}`;
  }
  if (p.partType === "PLATE" && g.cutoffFormula) return "With cut-out";
  return NA;
}

export function partRow(p: TakeoffPartRow, drawingNumber: string, assemblyLabel: string, lists: Lists | null): ExportRow {
  const g = (p.geometry ?? {}) as Record<string, unknown>;
  const qty = n(p.qty);
  const scope = p.scopeId ? lists?.scopes.find((s) => s.id === p.scopeId)?.description : null;
  const wo = p.workOrderGroupId ? lists?.workOrders.find((w) => w.id === p.workOrderGroupId) : null;
  const t = p.partType;
  const area = n(p.totalArea) > 0 ? n(p.totalArea) : 0;
  const cells: Cell[] = [
    assemblyLabel,
    text(drawingNumber),
    p.itemNo,
    text(p.posNo),
    text(p.description),
    TYPE_LABEL[t],
    text(p.material),
    specOf(p, g),
    t === "PLATE" ? dim(g.width) : NA,
    t === "PLATE" || t === "PIPE" || t === "HOT_ROLLED" ? dim(g.length) : NA,
    t === "ACCESSORY" || t === "HOT_ROLLED" ? NA : p.thicknessMm != null && n(p.thicknessMm) > 0 ? n(p.thicknessMm) : NA,
    t === "PIPE" ? dim(g.od) : NA,
    t === "CONE" ? dim(g.d1) : NA,
    t === "CONE" ? dim(g.d2) : NA,
    t === "CONE" ? dim(g.height) : NA,
    qty,
    n(p.qtyPerAssembly) > 0 ? n(p.qtyPerAssembly) : NA,
    qty > 0 ? r(n(p.weightKg) / qty, 3) : 0,
    r(n(p.weightKg), 3),
    area > 0 ? r(area, 4) : 0,
    r(n(p.paintAreaSqm), 4),
    SIDE_LABEL[p.side],
    text(scope),
    wo ? text(`${wo.code}${wo.name ? ` — ${wo.name}` : ""}`) : NA,
    text(p.remark),
  ];
  return { cells, qty, weightKg: n(p.weightKg), areaSqm: area, paintSqm: n(p.paintAreaSqm) };
}

const sum = (rows: ExportRow[]) => ({
  qty: rows.reduce((s, x) => s + x.qty, 0),
  weightKg: rows.reduce((s, x) => s + x.weightKg, 0),
  areaSqm: rows.reduce((s, x) => s + x.areaSqm, 0),
  paintSqm: rows.reduce((s, x) => s + x.paintSqm, 0),
});

/** Assemblies in tree order (parent first, then its sub-assemblies), each with the path of codes down to it. */
function assemblyOrder(asms: AssemblyLite[]): { a: AssemblyLite; path: string }[] {
  const byParent = new Map<string | null, AssemblyLite[]>();
  const ids = new Set(asms.map((a) => a.id));
  for (const a of asms) {
    const key = a.parentId && ids.has(a.parentId) ? a.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), a]);
  }
  const out: { a: AssemblyLite; path: string }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, prefix: string) => {
    for (const a of byParent.get(parent) ?? []) {
      if (seen.has(a.id)) continue; // guards a parent loop
      seen.add(a.id);
      const path = prefix ? `${prefix} › ${a.code}` : a.code;
      out.push({ a, path });
      walk(a.id, path);
    }
  };
  walk(null, "");
  return out;
}

/** `drawings` = what is on screen (already filtered), so the file always matches the list. */
export function buildExportModel(drawings: TakeoffDrawingRow[], lists: Lists | null): ExportModel {
  const asmList = lists?.assemblies ?? [];
  const known = new Set(asmList.map((a) => a.id));
  const labelOf = new Map<string, string>();
  const ordered = assemblyOrder(asmList);
  for (const { a, path } of ordered) labelOf.set(a.id, `${path}${a.name ? ` — ${a.name}` : ""}`);

  const bucket = new Map<string, ExportRow[]>();
  const NONE = "__none__";
  for (const d of drawings) {
    for (const p of d.parts) {
      const key = p.groupId && known.has(p.groupId) ? p.groupId : NONE;
      const label = key === NONE ? (lists ? "No assembly" : "All parts") : labelOf.get(key)!;
      bucket.set(key, [...(bucket.get(key) ?? []), partRow(p, d.drawingNumber, label, lists)]);
    }
  }

  const sections: ExportSection[] = [];
  for (const { a } of ordered) {
    const rows = bucket.get(a.id);
    if (rows?.length) sections.push({ key: a.id, title: labelOf.get(a.id)!, asmQty: a.qty, rows, totals: sum(rows) });
  }
  const loose = bucket.get(NONE);
  if (loose?.length) sections.push({ key: NONE, title: lists ? "No assembly" : "All parts", asmQty: null, rows: loose, totals: sum(loose) });

  const all = sections.flatMap((s) => s.rows);
  return { sections, totals: { parts: all.length, ...sum(all) } };
}

/** What the filters are, in words, for the header of the file. */
export function describeFilters(f: PartFilters, lists: Lists | null): string {
  const bits: string[] = [];
  if (f.type !== "ALL") bits.push(`Type: ${TYPE_LABEL[f.type]}`);
  if (f.thickness.trim() !== "") bits.push(`Thk: ${f.thickness.trim()} mm`);
  if (f.description.trim() !== "") bits.push(`Description contains "${f.description.trim()}"`);
  if (f.side !== "ALL") bits.push(`Side: ${SIDE_LABEL[f.side]}`);
  if (f.assembly === UNASSIGNED) bits.push("No assembly");
  else if (f.assembly !== "ALL") {
    const a = lists?.assemblies.find((x) => x.id === f.assembly);
    bits.push(`Assembly: ${a ? `${a.code}${a.name ? ` — ${a.name}` : ""}` : "?"} (with its sub-assemblies)`);
  }
  if (f.scope === UNASSIGNED) bits.push("No scope");
  else if (f.scope !== "ALL") bits.push(`Scope: ${lists?.scopes.find((x) => x.id === f.scope)?.description ?? "?"}`);
  if (f.workOrder === UNASSIGNED) bits.push("No work order");
  else if (f.workOrder !== "ALL") {
    const w = lists?.workOrders.find((x) => x.id === f.workOrder);
    bits.push(`Work order: ${w ? `${w.code}${w.name ? ` — ${w.name}` : ""}` : "?"}`);
  }
  return bits.length ? `Filtered: ${bits.join(" · ")}` : "All parts (no filter)";
}

// ------------------------------------------------------------------------------------------------ CSV

/** A text cell that starts with = + @ (or - followed by more) would be run as a formula by a spreadsheet: defuse it. */
const safeText = (s: string) => (/^[=+@]/.test(s) || /^-.+/.test(s) ? `'${s}` : s);

export function toCsv(model: ExportModel): string {
  const esc = (c: Cell) => {
    const s = typeof c === "number" ? String(c) : safeText(c);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [EXPORT_HEADERS.map(esc).join(",")];
  for (const s of model.sections) for (const row of s.rows) lines.push(row.cells.map(esc).join(","));
  // BOM so Excel reads the file as UTF-8 (m², ›, —)
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------------------------------------ Excel

const WIDTHS = [34, 12, 7, 9, 38, 11, 12, 22, 10, 10, 9, 8, 8, 8, 9, 7, 9, 12, 13, 11, 13, 10, 20, 24, 24];
const BLUE = "FF1D4ED8";
const fill = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });

function formatRow(row: ExcelJS.Row) {
  for (const i of NUM_COLS.dims) row.getCell(i + 1).numFmt = "0.000";
  for (const i of NUM_COLS.thk) row.getCell(i + 1).numFmt = "0.##";
  for (const i of NUM_COLS.weight) row.getCell(i + 1).numFmt = "#,##0.00";
  for (const i of NUM_COLS.area) row.getCell(i + 1).numFmt = "#,##0.000";
  for (const i of [...NUM_COLS.dims, ...NUM_COLS.thk, COL.Qty, COL["Qty / Asm"], ...NUM_COLS.weight, ...NUM_COLS.area, COL.Item]) {
    row.getCell(i + 1).alignment = { horizontal: "right", vertical: "middle" };
  }
}

function headerRow(ws: ExcelJS.Worksheet) {
  const head = ws.addRow([...EXPORT_HEADERS]);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.height = 30;
  head.eachCell((c) => { c.fill = fill(BLUE); c.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; });
  return head;
}

/** `info` = lines shown above the table (project, filter, date). */
export function buildWorkbook(ExcelJSLib: typeof ExcelJS, model: ExportModel, info: { title: string; filter: string; date: string }): ExcelJS.Workbook {
  const wb = new ExcelJSLib.Workbook();
  const cols = EXPORT_HEADERS.length;

  // Sheet 1 — by assembly: a band per assembly, its parts, a subtotal
  const ws = wb.addWorksheet("By Assembly");
  ws.addRow([info.title]).font = { bold: true, size: 14 };
  ws.addRow([info.filter]).font = { italic: true, color: { argb: "FF64748B" } };
  ws.addRow([`Exported ${info.date} · Total ${model.totals.parts} part(s) · ${r(model.totals.weightKg, 1).toLocaleString("en-US")} kg`]).font = { size: 9, color: { argb: "FF64748B" } };
  ws.addRow([]);
  headerRow(ws);
  ws.views = [{ state: "frozen", ySplit: 5 }];

  for (const s of model.sections) {
    const band = ws.addRow([`${s.title}${s.asmQty != null ? `   ·   Assembly qty: ${s.asmQty}` : ""}   ·   ${s.rows.length} part(s)`]);
    ws.mergeCells(band.number, 1, band.number, cols);
    band.font = { bold: true, color: { argb: "FF1E3A8A" } };
    band.getCell(1).fill = fill("FFDBEAFE");
    band.getCell(1).alignment = { vertical: "middle" };
    band.height = 22;
    for (const row of s.rows) formatRow(ws.addRow(row.cells));
    const sub: Cell[] = Array(cols).fill("");
    sub[COL.Assembly] = s.title;
    sub[COL.Description] = "Subtotal";
    sub[COL.Qty] = s.totals.qty;
    sub[COL["Total Wt (kg)"]] = r(s.totals.weightKg, 3);
    sub[COL["Area (m²)"]] = r(s.totals.areaSqm, 4);
    sub[COL["Paint Area (m²)"]] = r(s.totals.paintSqm, 4);
    const sr = ws.addRow(sub);
    sr.font = { bold: true };
    sr.eachCell({ includeEmpty: true }, (c) => { c.fill = fill("FFF1F5F9"); });
    formatRow(sr);
    ws.addRow([]);
  }
  const gt: Cell[] = Array(cols).fill("");
  gt[COL.Description] = "GRAND TOTAL";
  gt[COL.Qty] = model.totals.qty;
  gt[COL["Total Wt (kg)"]] = r(model.totals.weightKg, 3);
  gt[COL["Area (m²)"]] = r(model.totals.areaSqm, 4);
  gt[COL["Paint Area (m²)"]] = r(model.totals.paintSqm, 4);
  const gr = ws.addRow(gt);
  gr.font = { bold: true, color: { argb: "FFFFFFFF" } };
  gr.eachCell({ includeEmpty: true }, (c) => { c.fill = fill(BLUE); });
  formatRow(gr);
  WIDTHS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // Sheet 2 — flat, one row per part, with a filter on every column
  const flat = wb.addWorksheet("All Parts", { views: [{ state: "frozen", ySplit: 1 }] });
  headerRow(flat);
  for (const s of model.sections) for (const row of s.rows) formatRow(flat.addRow(row.cells));
  flat.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols } };
  WIDTHS.forEach((w, i) => { flat.getColumn(i + 1).width = w; });

  return wb;
}
