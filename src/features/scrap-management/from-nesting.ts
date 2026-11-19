import type { MaterialRequestLine } from "@/features/nesting/nest-boost/material-requests";

// One stock-sheet size of the 2D nest, as the Scrap Management table needs it (geometry only — no prices).
export interface ScrapSource {
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

const STEEL_KG_PER_M2_MM = 7.85;

/**
 * Material-request lines are what the 2D Nesting tab already shows as "what to order":
 * sheets bought, kg of those sheets, kg that is parts. Scrap Management reads the same numbers so both tabs agree.
 * Lines without a thickness can't be weighed, so they are returned separately instead of being priced as 0 kg.
 */
export function sourcesFromMaterialLines(lines: MaterialRequestLine[]): { sources: ScrapSource[]; unweighable: number } {
  const sources: ScrapSource[] = [];
  let unweighable = 0;
  for (const l of lines) {
    if (l.sheetKg == null || l.partsKg == null || l.thicknessMm <= 0) { unweighable++; continue; }
    const material = l.material || "Steel";
    sources.push({
      key: l.code,
      label: `${material} ${l.thicknessMm} mm — ${l.widthMm} x ${l.heightMm}`,
      material,
      thicknessMm: l.thicknessMm,
      widthMm: l.widthMm,
      lengthMm: l.heightMm,
      buyQty: l.sheets,
      buyAreaSqm: (l.widthMm * l.heightMm * l.sheets) / 1e6,
      buyWeightKg: l.sheetKg,
      usedWeightKg: l.partsKg,
      usedAreaSqm: l.partsKg / (l.thicknessMm * STEEL_KG_PER_M2_MM),
    });
  }
  return { sources, unweighable };
}
