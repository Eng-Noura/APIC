import { getNestingRun } from "./nesting-run.service";
import { STEEL_DENSITY_KG_PER_M2_MM } from "@/server/calc/takeoff";
import type { SourceRequirementRow } from "@/features/nesting/types";

export class ScrapManagementError extends Error {}

// One source's raw geometry (material + thickness + stock-sheet size) — pure nesting output, no prices.
export interface ScrapSourceGroup {
  key: string;
  label: string;
  material: string;
  thicknessMm: number;
  widthMm: number;
  lengthMm: number;
  usedAreaSqm: number;
  usedWeightKg: number;
  buyQty: number;
  buyAreaSqm: number;
  buyWeightKg: number;
}

export const scrapSourceKey = (material: string, thicknessMm: number, widthMm: number, lengthMm: number) =>
  `${material}||${thicknessMm}||${widthMm}x${lengthMm}`;

/**
 * Groups a nesting run by source. Used = actual DXF area the engine placed on each sheet (never bounding box);
 * bought = the run's required sheet quantity x the sheet's area. Both weigh in at thickness x 7.85 kg/m2/mm.
 */
export async function getScrapSourceGroups(nestingRunId: string): Promise<ScrapSourceGroup[]> {
  const run = await getNestingRun(nestingRunId);
  if (!run) throw new ScrapManagementError("Nesting run not found");

  const requirement = (run.sourceRequirementJson as unknown as SourceRequirementRow[] | null) ?? [];
  const map = new Map<string, ScrapSourceGroup>();
  const entryFor = (material: string, thicknessMm: number, widthMm: number, lengthMm: number) => {
    const key = scrapSourceKey(material, thicknessMm, widthMm, lengthMm);
    let e = map.get(key);
    if (!e) {
      e = {
        key, label: `${material} ${thicknessMm} mm — ${widthMm} x ${lengthMm}`, material, thicknessMm, widthMm, lengthMm,
        usedAreaSqm: 0, usedWeightKg: 0, buyQty: 0, buyAreaSqm: 0, buyWeightKg: 0,
      };
      map.set(key, e);
    }
    return e;
  };

  for (const sheet of run.sheets) {
    entryFor(sheet.material, sheet.thicknessMm, sheet.widthMm, sheet.lengthMm).usedAreaSqm += sheet.usedAreaSqm ?? 0;
  }
  for (const req of requirement) {
    const e = entryFor(req.material, req.thicknessMm, req.widthMm, req.lengthMm);
    e.buyQty += req.requiredQty;
    e.buyAreaSqm += (req.widthMm / 1000) * (req.lengthMm / 1000) * req.requiredQty;
  }
  for (const e of map.values()) {
    e.usedWeightKg = e.usedAreaSqm * e.thicknessMm * STEEL_DENSITY_KG_PER_M2_MM;
    e.buyWeightKg = e.buyAreaSqm * e.thicknessMm * STEEL_DENSITY_KG_PER_M2_MM;
  }
  return [...map.values()].sort((a, b) => a.material.localeCompare(b.material) || a.thicknessMm - b.thicknessMm || a.widthMm - b.widthMm);
}
