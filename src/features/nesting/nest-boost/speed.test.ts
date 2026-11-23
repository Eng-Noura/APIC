import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bbox, canContinueOn, makeSettings, placedCounts, runOptimize, sameSheetSettings, setCellCanvasFactory, sides,
  type Group, type OptResult, type Pt,
} from "./engine";
import { fakeCanvasFactory } from "./fake-canvas";

const rect = (w: number, h: number): Pt[] => [[0, 0], [w, 0], [w, h], [0, h]];
const grp = (id: number, w: number, h: number, qty: number): Group => ({
  id, sn: id, name: `p${id}`, qty, th: 5, material: "st37", outer: rect(w, h), holes: [], w, h, area: w * h, per: 2 * (w + h),
});
const S = makeSettings({ W: 6000, H: 1500, mg: 5, gp: 5, cell: 5, ro: 0 });

// the optimiser rasterises with real Path2D / canvas; stand-ins good enough for axis-aligned rectangles
class FakePath2D {
  rings: number[][][] = [];
  moveTo(x: number, y: number) { this.rings.push([[x, y]]); }
  lineTo(x: number, y: number) { this.rings[this.rings.length - 1].push([x, y]); }
  closePath() {}
}
function pathCanvas(w: number, h: number) {
  let tf = [1, 0, 0, 1, 0, 0];
  let lw = 0;
  let stroked = false;
  let P: FakePath2D | null = null;
  const ctx = {
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => (tf = [a, b, c, d, e, f]),
    fill: (p: FakePath2D) => { P = p; },
    stroke: () => { stroked = true; },
    set lineWidth(v: number) { lw = v; },
    set lineJoin(_v: string) {},
    getImageData: () => {
      const pts = (P as FakePath2D).rings.flat().map(([x, y]) => [x * tf[0] + tf[4], y * tf[3] + tf[5]]);
      const g = stroked ? (lw / 2) * tf[0] : 0;
      const x0 = Math.min(...pts.map((p) => p[0])) - g, x1 = Math.max(...pts.map((p) => p[0])) + g;
      const y0 = Math.min(...pts.map((p) => p[1])) - g, y1 = Math.max(...pts.map((p) => p[1])) + g;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let r = 0; r < h; r++)
        for (let q = 0; q < w; q++) if (q + 1 > x0 + 1e-9 && q < x1 - 1e-9 && r + 1 > y0 + 1e-9 && r < y1 - 1e-9) data[(r * w + q) * 4 + 3] = 255;
      return { data };
    },
  };
  return { width: w, height: h, getContext: () => ctx };
}

beforeAll(() => {
  setCellCanvasFactory(fakeCanvasFactory);
  const g = globalThis as Record<string, unknown>;
  g.Path2D = FakePath2D;
  g.document = { createElement: () => pathCanvas(0, 0) };
});
afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  delete g.Path2D;
  delete g.document;
});

// document.createElement("canvas") sets width/height after creation, so the stand-in reads them lazily
const patchDoc = () => {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => {
      const cv = { width: 0, height: 0 } as { width: number; height: number; getContext?: () => unknown };
      cv.getContext = () => (pathCanvas(cv.width, cv.height) as { getContext: () => unknown }).getContext();
      return cv;
    },
  };
};

const opts = (over: Partial<Parameters<typeof runOptimize>[1]> = {}) => ({
  S, pair: false, common: false, timeSec: 0.05, base: null, shouldStop: () => false, onBest: () => {}, onStatus: () => {}, ...over,
});

describe("big quantities and Stop", () => {
  it("nests every piece of a big quantity (full sheets are skipped, not rescanned)", async () => {
    patchDoc();
    const A = grp(1, 400, 300, 120);
    const B = { ...grp(2, 250, 250, 60), th: 8, material: "S355" };
    const r = (await runOptimize([A, B], opts())) as OptResult;
    expect(r.un).toHaveLength(0);
    const pc = placedCounts(r);
    expect(pc.get(1)).toBe(120);
    expect(pc.get(2)).toBe(60);
    // sheets only mix parts of the same thickness AND material
    r.sheets.forEach((sh) => {
      const lots = new Set(sh.items.map((x) => `${x.g.th}|${x.g.material}`));
      expect(lots.size).toBe(1);
      expect(`${sh.th}|${sh.material}`).toBe([...lots][0]);
    });
  });

  it("Stop before the first attempt ends keeps what was placed and lists the rest as not nested", async () => {
    patchDoc();
    const A = grp(1, 400, 300, 80);
    let calls = 0;
    const r = (await runOptimize([A], opts({ shouldStop: () => ++calls > 30 }))) as OptResult;
    expect(r).not.toBeNull();
    const placed = placedCounts(r).get(1) ?? 0;
    expect(placed).toBeGreaterThan(0);
    expect(placed + r.un.length).toBe(80); // nothing is lost
  });
});
