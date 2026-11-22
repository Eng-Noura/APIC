import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { EXPORT_HEADERS, NA, buildExportModel, buildWorkbook, describeFilters, toCsv } from "./parts-export";
import { emptyFilters } from "./part-filters";
import type { TakeoffDrawingRow, TakeoffPartRow } from "./types";

const part = (o: Partial<TakeoffPartRow>): TakeoffPartRow => ({
  id: "p", itemNo: 1, description: "Plate", material: "S235", partType: "PLATE", side: "EXTERNAL", groupId: null, posNo: null,
  qtyPerAssembly: 1, remark: null, scopeId: null, workOrderGroupId: null, nestKind: null, nestPartId: null, qty: 2,
  thicknessMm: 8, geometry: { width: 0.5, length: 1.2 }, areaFormula: null, paintSides: 2, totalArea: 1.2, volume: 0, weightKg: 75.36,
  paintAreaSqm: 2.4, buyWeightKg: null, scrapKg: null, scrapPct: null, dxf: null, ...o,
});
const lists = {
  assemblies: [
    { id: "A", code: "A", name: "Tank shell", qty: 2, parentId: null },
    { id: "A1", code: "A1", name: "Nozzle", qty: 4, parentId: "A" },
    { id: "B", code: "B", name: "Roof", qty: 1, parentId: null },
    { id: "EMPTY", code: "E", name: "Nothing in it", qty: 1, parentId: null },
  ],
  scopes: [{ id: "S1", description: "Fabrication" }],
  workOrders: [{ id: "W1", code: "WO-1", name: "Shell shop" }],
};
const drawings: TakeoffDrawingRow[] = [
  {
    id: "d1", drawingNumber: "DWG-01", title: "", weightFromDwg: null,
    parts: [
      part({ id: "1", itemNo: 1, description: "Shell plate", groupId: "A", scopeId: "S1", workOrderGroupId: "W1" }),
      part({ id: "2", itemNo: 2, description: "Nozzle neck", partType: "PIPE", groupId: "A1", thicknessMm: 6, geometry: { od: 0.15, length: 0.3 }, weightKg: 10, totalArea: 0.3, paintAreaSqm: 0.3 }),
      part({ id: "3", itemNo: 3, description: "Roof cone", partType: "CONE", groupId: "B", geometry: { d1: 3, d2: 0.5, height: 1.1 }, weightKg: 100, totalArea: 9, paintAreaSqm: 18 }),
    ],
  },
  {
    id: "d2", drawingNumber: "DWG-02", title: "", weightFromDwg: null,
    parts: [
      part({ id: "4", itemNo: 1, description: "Beam", partType: "HOT_ROLLED", groupId: "A", thicknessMm: null, geometry: { profile: "HEA200", length: 6, weightPerMeter: 42.3 }, weightKg: 507.6, totalArea: 0, paintAreaSqm: 10 }),
      part({ id: "5", itemNo: 2, description: "Bolt M20", partType: "ACCESSORY", groupId: null, thicknessMm: null, geometry: { unit: "pcs", unitWeightKg: 0.2 }, qty: 50, weightKg: 10, totalArea: 0, paintAreaSqm: 0 }),
      part({ id: "6", itemNo: 3, description: "=SUM(A1)", groupId: "gone" }),
    ],
  },
];
const col = (h: (typeof EXPORT_HEADERS)[number]) => EXPORT_HEADERS.indexOf(h);

describe("Part List export model", () => {
  const m = buildExportModel(drawings, lists);

  it("one section per assembly in tree order, then the parts with no assembly; empty assemblies are left out", () => {
    expect(m.sections.map((s) => s.title)).toEqual(["A — Tank shell", "A › A1 — Nozzle", "B — Roof", "No assembly"]);
    expect(m.sections[0].rows.map((x) => x.cells[col("Description")])).toEqual(["Shell plate", "Beam"]);
    // a part pointing at an assembly that no longer exists lands under "No assembly"
    expect(m.sections[3].rows.map((x) => x.cells[col("Item")])).toEqual([2, 3]);
  });

  it("every cell of every part row is filled; what does not apply is '-'", () => {
    for (const s of m.sections) for (const row of s.rows) {
      expect(row.cells).toHaveLength(EXPORT_HEADERS.length);
      for (const c of row.cells) expect(c === "" || c === undefined || c === null).toBe(false);
    }
    const pipe = m.sections[1].rows[0].cells;
    expect(pipe[col("Width (m)")]).toBe(NA);
    expect(pipe[col("OD (m)")]).toBe(0.15);
    expect(pipe[col("Length (m)")]).toBe(0.3);
    expect(pipe[col("Thk (mm)")]).toBe(6);
  });

  it("plate / cone / profile / accessory dimensions", () => {
    const plate = m.sections[0].rows[0].cells;
    expect(plate[col("Width (m)")]).toBe(0.5);
    expect(plate[col("Length (m)")]).toBe(1.2);
    expect(plate[col("Thk (mm)")]).toBe(8);
    expect(plate[col("Qty")]).toBe(2);
    expect(plate[col("Unit Wt (kg)")]).toBe(37.68);
    expect(plate[col("Total Wt (kg)")]).toBe(75.36);
    expect(plate[col("Scope")]).toBe("Fabrication");
    expect(plate[col("Work Order")]).toBe("WO-1 — Shell shop");
    const cone = m.sections[2].rows[0].cells;
    expect([cone[col("D1 (m)")], cone[col("D2 (m)")], cone[col("Height (m)")]]).toEqual([3, 0.5, 1.1]);
    const beam = m.sections[0].rows[1].cells;
    expect(beam[col("Profile / Spec")]).toBe("HEA200 · 42.3 kg/m");
    expect(beam[col("Length (m)")]).toBe(6);
    expect(beam[col("Thk (mm)")]).toBe(NA);
    const bolt = m.sections[3].rows[0].cells;
    expect(bolt[col("Profile / Spec")]).toBe("per pcs · 0.2 kg each");
    expect(bolt[col("Qty")]).toBe(50);
  });

  it("section and grand totals add up", () => {
    expect(m.sections[0].totals.weightKg).toBeCloseTo(75.36 + 507.6, 6);
    expect(m.sections[0].asmQty).toBe(2);
    expect(m.totals.parts).toBe(6);
    expect(m.totals.weightKg).toBeCloseTo(75.36 + 10 + 100 + 507.6 + 10 + 75.36, 6);
  });

  it("without the assemblies list everything is one 'All parts' section", () => {
    const x = buildExportModel(drawings, null);
    expect(x.sections.map((s) => s.title)).toEqual(["All parts"]);
    expect(x.totals.parts).toBe(6);
  });

  it("only the parts it is given are exported (the filtered view)", () => {
    const onlyA = drawings.map((d) => ({ ...d, parts: d.parts.filter((p) => p.groupId === "A") }));
    const x = buildExportModel(onlyA, lists);
    expect(x.sections.map((s) => s.title)).toEqual(["A — Tank shell"]);
    expect(x.totals.weightKg).toBeCloseTo(75.36 + 507.6, 6);
  });
});

describe("CSV", () => {
  const csv = toCsv(buildExportModel(drawings, lists));
  it("starts with a BOM and the header, one line per part, formulas defused", () => {
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
    expect(lines[0].split(",")[0]).toBe("Assembly");
    expect(lines).toHaveLength(1 + 6);
    expect(csv).toContain("'=SUM(A1)");
  });
  it("quotes cells that contain commas or quotes", () => {
    const d = [{ ...drawings[0], parts: [part({ description: 'Plate, 8" thick', groupId: "A" })] }];
    expect(toCsv(buildExportModel(d, lists))).toContain('"Plate, 8"" thick"');
  });
});

describe("filter description", () => {
  it("says what is filtered, or that nothing is", () => {
    expect(describeFilters(emptyFilters, lists)).toBe("All parts (no filter)");
    const t = describeFilters({ ...emptyFilters, scope: "S1", assembly: "A", workOrder: "NONE" }, lists);
    expect(t).toContain("Scope: Fabrication");
    expect(t).toContain("Assembly: A — Tank shell (with its sub-assemblies)");
    expect(t).toContain("No work order");
  });
});

describe("Excel workbook", () => {
  it("has a grouped sheet and a flat filterable sheet that survive a write / read round trip", async () => {
    const wb = buildWorkbook(ExcelJS, buildExportModel(drawings, lists), { title: "Part List — P1", filter: "All parts (no filter)", date: "2026-11-22" });
    const buf = await wb.xlsx.writeBuffer();
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(buf);
    expect(back.worksheets.map((w) => w.name)).toEqual(["By Assembly", "All Parts"]);

    const flat = back.getWorksheet("All Parts")!;
    expect(flat.rowCount).toBe(1 + 6);
    expect(flat.getRow(1).getCell(col("Width (m)") + 1).value).toBe("Width (m)");
    expect(flat.getRow(2).getCell(col("Total Wt (kg)") + 1).value).toBe(75.36);

    const grouped = back.getWorksheet("By Assembly")!;
    const texts: string[] = [];
    grouped.eachRow((row) => { const v = row.getCell(1).value; if (typeof v === "string") texts.push(v); });
    expect(texts.some((t) => t.startsWith("A — Tank shell") && t.includes("Assembly qty: 2"))).toBe(true);
    expect(texts.some((t) => t.startsWith("A › A1 — Nozzle"))).toBe(true);
    let grand: unknown = null;
    grouped.eachRow((row) => { if (row.getCell(col("Description") + 1).value === "GRAND TOTAL") grand = row.getCell(col("Total Wt (kg)") + 1).value; });
    expect(grand).toBeCloseTo(75.36 + 10 + 100 + 507.6 + 10 + 75.36, 6);
  });
});
