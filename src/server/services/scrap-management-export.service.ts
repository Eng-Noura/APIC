import ExcelJS from "exceljs";
import { calculateScrapRow, calculateScrapScenarios, calculateScrapTotals, type ScrapRowInput } from "@/server/calc/scrap-management";

// Two sheets: "Scrap Management" (one row per source, formulas kept live so a changed price recalculates in
// Excel) and "Scenarios" (what-if table on % used later). Inputs are blue, nesting values grey, results plain.

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
const INPUT_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDEBF7" } };
const NEST_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDEDED" } };
const TOTAL_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCE4D6" } };
const WARN_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };

// Column letters (1-based index in comments)
const COLS = [
  "Source", // A
  "Buy Qty", // B
  "Buy Weight (kg)", // C
  "Used Weight (kg)", // D
  "Cost /kg", // E  input
  "% Used Later", // F  input
  "Used Later Price /kg", // G  input
  "Scrap Sell Price /kg", // H  input
  "Primary Scrap (kg)", // I
  "Primary Scrap %", // J
  "Used Later (kg)", // K
  "Sold Scrap (kg)", // L
  "Buy Cost (LE)", // M
  "Used Cost (LE)", // N
  "Recovered (LE)", // O
  "Net Scrap Loss (LE)", // P
  "Financial Scrap %", // Q
  "Effective Cost /kg", // R
  "Note", // S
] as const;

export function buildScrapManagementWorkbook(
  inputs: ScrapRowInput[],
  meta: { projectNumber: string; projectName: string; nestingRunId: string },
): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "SteelFlow";
  wb.created = new Date();

  const ws = wb.addWorksheet("Scrap Management", { views: [{ state: "frozen", ySplit: 1, xSplit: 1 }] });
  ws.columns = COLS.map((h, i) => ({ header: h, width: i === 0 ? 32 : Math.max(14, h.length + 2) }));
  ws.getRow(1).eachCell((c) => {
    c.fill = HEADER_FILL;
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });
  ws.getRow(1).height = 32;

  const first = 2;
  inputs.forEach((inp, i) => {
    const n = first + i;
    const r = calculateScrapRow(inp);
    const row = ws.getRow(n);
    row.values = [
      inp.label, inp.buyQty, inp.buyWeightKg, inp.usedWeightKg,
      inp.costPerKg, r.usedLaterPct, inp.usedLaterPriceLEPerKg, inp.scrapSellPriceLEPerKg,
      { formula: `MAX(0,C${n}-D${n})`, result: r.primaryScrapKg },
      { formula: `IF(C${n}=0,0,I${n}/C${n})`, result: r.primaryScrapPct },
      { formula: `I${n}*F${n}`, result: r.usedLaterKg },
      { formula: `I${n}-K${n}`, result: r.soldScrapKg },
      { formula: `C${n}*E${n}`, result: r.buyCostLE },
      { formula: `D${n}*E${n}`, result: r.usedCostLE },
      { formula: `K${n}*G${n}+L${n}*H${n}`, result: r.recoveredLE },
      { formula: `(K${n}+L${n})*E${n}-O${n}`, result: r.netScrapLossLE },
      { formula: `IF(M${n}=0,0,P${n}/M${n})`, result: r.financialScrapPct },
      { formula: `IF(D${n}=0,E${n},(N${n}+P${n})/D${n})`, result: r.effectiveCostPerKg },
      r.shortage ? `Shortage: nesting needs ${r.shortageKg.toFixed(1)} kg more than the quantity bought` : "",
    ];
    for (const c of [2, 3, 4]) row.getCell(c).fill = NEST_FILL;
    for (const c of [5, 6, 7, 8]) row.getCell(c).fill = INPUT_FILL;
    if (r.shortage) row.getCell(19).fill = WARN_FILL;
    [3, 4, 9, 11, 12, 13, 14, 15, 16].forEach((c) => (row.getCell(c).numFmt = "#,##0.00"));
    [5, 7, 8, 18].forEach((c) => (row.getCell(c).numFmt = "#,##0.00"));
    [6, 10, 17].forEach((c) => (row.getCell(c).numFmt = "0.0%"));
  });

  const last = first + inputs.length - 1;
  const t = calculateScrapTotals(inputs.map(calculateScrapRow));
  const tn = last + 2;
  const sumCol = (L: string) => ({ formula: `SUM(${L}${first}:${L}${last})` });
  const total = ws.getRow(tn);
  total.values = [
    "TOTAL", sumCol("B"), sumCol("C"), sumCol("D"), { formula: `IF(D${tn}=0,0,N${tn}/D${tn})`, result: t.avgCostPerKg }, "", "", "",
    sumCol("I"), { formula: `IF(C${tn}=0,0,I${tn}/C${tn})`, result: t.primaryScrapPct }, sumCol("K"), sumCol("L"),
    sumCol("M"), sumCol("N"), sumCol("O"), sumCol("P"),
    { formula: `IF(M${tn}=0,0,P${tn}/M${tn})`, result: t.financialScrapPct },
    { formula: `IF(D${tn}=0,0,(N${tn}+P${tn})/D${tn})`, result: t.effectiveCostPerKg }, "",
  ];
  total.eachCell((c) => { c.fill = TOTAL_FILL; c.font = { bold: true }; });
  [3, 4, 5, 9, 11, 12, 13, 14, 15, 16, 18].forEach((c) => (total.getCell(c).numFmt = "#,##0.00"));
  [10, 17].forEach((c) => (total.getCell(c).numFmt = "0.0%"));

  const notes = [
    "Blue cells are inputs; grey cells come from the project's nesting result.",
    "Financial Scrap % = Net Scrap Loss / Buy Cost. Physical Scrap % = Primary Scrap / Buy Weight.",
    "Effective Cost /kg = (Used Cost + Net Scrap Loss) / Used Weight — the material price to carry into Pricing.",
  ];
  notes.forEach((txt, i) => {
    const c = ws.getCell(`A${tn + 2 + i}`);
    c.value = txt;
    c.font = { italic: true, size: 9, color: { argb: "FF808080" } };
  });

  // Scenarios
  const sc = wb.addWorksheet("Scenarios");
  sc.columns = [
    { header: "% Used Later (all sources)", width: 26 }, { header: "Sold Scrap (kg)", width: 18 },
    { header: "Net Scrap Loss (LE)", width: 22 }, { header: "Financial Scrap %", width: 20 }, { header: "Effective Cost /kg", width: 20 },
  ];
  sc.getRow(1).eachCell((c) => { c.fill = HEADER_FILL; c.font = { bold: true, color: { argb: "FFFFFFFF" } }; });
  calculateScrapScenarios(inputs, [0, 0.25, 0.5, 0.75, 1]).forEach((s, i) => {
    const row = sc.getRow(2 + i);
    row.values = [s.usedLaterPct, s.totals.soldScrapKg, s.totals.netScrapLossLE, s.totals.financialScrapPct, s.totals.effectiveCostPerKg];
    row.getCell(1).numFmt = "0%";
    [2, 3, 5].forEach((c) => (row.getCell(c).numFmt = "#,##0.00"));
    row.getCell(4).numFmt = "0.0%";
  });

  const info = wb.addWorksheet("Project");
  info.columns = [{ header: "Field", width: 24 }, { header: "Value", width: 40 }];
  info.addRow(["Project Number", meta.projectNumber]);
  info.addRow(["Project Name", meta.projectName]);
  info.addRow(["Nesting Run ID", meta.nestingRunId]);
  info.addRow(["Generated At", new Date().toISOString()]);
  info.getRow(1).font = { bold: true };
  return wb;
}
