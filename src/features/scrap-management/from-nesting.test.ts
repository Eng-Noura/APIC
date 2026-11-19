import { describe, expect, it } from "vitest";
import { sourcesFromMaterialLines } from "./from-nesting";
import type { MaterialRequestLine } from "@/features/nesting/nest-boost/material-requests";

const line = (o: Partial<MaterialRequestLine>): MaterialRequestLine => ({
  code: "NEST-20-ANY-1500x6000", description: "Steel plate 20 mm", spec: "1500 × 6000 mm sheet", sheets: 4,
  widthMm: 1500, heightMm: 6000, thicknessMm: 20, material: "", sheetKg: 5652, partsKg: 2968.3, scrapKg: 2683.7, scrapPct: 47.5,
  exactPieces: 10, approxPieces: 0, ...o,
});

describe("sourcesFromMaterialLines", () => {
  it("maps a request line to buy / used figures", () => {
    const { sources, unweighable } = sourcesFromMaterialLines([line({})]);
    expect(unweighable).toBe(0);
    expect(sources[0]).toMatchObject({ key: "NEST-20-ANY-1500x6000", material: "Steel", buyQty: 4, buyWeightKg: 5652, usedWeightKg: 2968.3, lengthMm: 6000 });
    expect(sources[0].buyAreaSqm).toBeCloseTo(36, 6);
    expect(sources[0].usedAreaSqm).toBeCloseTo(2968.3 / (20 * 7.85), 6);
  });

  it("skips lines with no thickness instead of treating them as 0 kg", () => {
    const r = sourcesFromMaterialLines([line({ thicknessMm: 0, sheetKg: null, partsKg: null, scrapKg: null }), line({})]);
    expect(r.sources).toHaveLength(1);
    expect(r.unweighable).toBe(1);
  });
});
