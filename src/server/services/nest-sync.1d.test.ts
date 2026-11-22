import { beforeEach, describe, expect, it, vi } from "vitest";

// BOQ <-> 1D nest sync against an in-memory database: one linked HOT_ROLLED part, one 1D workspace.
interface Part { id: string; nestKind: string; nestPartId: number; qty: number; weightKg: number; thicknessMm: number | null; material: string | null; nestSyncedQty: number | null; groupId: string | null; description: string; partType: string; geometry: unknown; paintSides: number; areaFormula: string | null; buyWeightKg: number | null; qtyPerAssembly: number }
const db = vi.hoisted(() => ({
  parts: [] as Part[],
  ws: { "1D": null as null | { dataJson: unknown; version: number }, "2D": null as null | { dataJson: unknown; version: number } },
  drawings: [] as { drawingNumber: string; parts: { itemNo: number; description: string }[] }[],
}));

vi.mock("@/server/db/client", () => ({
  prisma: {
    takeoffPart: {
      findMany: async ({ where }: { where: { nestKind: string } }) => db.parts.filter((p) => p.nestKind === where.nestKind).map((p) => ({ ...p })),
      update: async ({ where, data }: { where: { id: string }; data: Partial<Part> }) => Object.assign(db.parts.find((p) => p.id === where.id)!, data),
    },
    partGroup: { findMany: async () => [] },
    takeoffDrawing: { findMany: async () => db.drawings },
    nestingWorkspace: {
      findUnique: async ({ where }: { where: { projectId_kind: { kind: "1D" | "2D" } } }) => db.ws[where.projectId_kind.kind],
      updateMany: async ({ where, data }: { where: { kind: "1D" | "2D"; version: number }; data: { dataJson: unknown; version: { increment: number } } }) => {
        const w = db.ws[where.kind];
        if (!w || w.version !== where.version) return { count: 0 };
        w.dataJson = data.dataJson;
        w.version += data.version.increment;
        return { count: 1 };
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));
vi.mock("./activity-log.service", () => ({ logActivity: async () => undefined }));

import { applyNestSync, getNestSyncStatus } from "./nest-sync.service";

const part = (over: Partial<Part> = {}): Part => ({
  id: "a", nestKind: "1D", nestPartId: 1, qty: 4, weightKg: 4 * 3 * 22.4, thicknessMm: null, material: "S235", nestSyncedQty: 4, groupId: null,
  description: "Beam", partType: "HOT_ROLLED", geometry: { profile: "IPE200", length: 3, weightPerMeter: 22.4 }, paintSides: 2, areaFormula: null, buyWeightKg: null, qtyPerAssembly: 1, ...over,
});
const piece = (id: number, qty: number, over: Record<string, unknown> = {}) => ({ id, sn: id, name: `P${id}`, profile: "IPE200", material: "S235", length: 3000, qty, ...over });
const nest1d = () => db.ws["1D"]!.dataJson as { pieces: { id: number; qty: number }[]; result: unknown };

beforeEach(() => {
  db.parts = [part()];
  db.ws = { "1D": { dataJson: { v: 1, pieces: [piece(1, 4)], result: { bars: 1 }, resS: {} }, version: 3 }, "2D": null };
  db.drawings = [];
});

describe("1D nest <-> BOQ quantity sync", () => {
  it("nest quantity changed -> the BOQ part follows, and its weight is recomputed", async () => {
    nest1d().pieces[0].qty = 6;
    const r = await applyNestSync("proj", "u");
    expect(r.applied).toBe(1);
    expect(db.parts[0]).toMatchObject({ qty: 6, nestSyncedQty: 6 });
    expect(db.parts[0].weightKg).toBeCloseTo(6 * 3 * 22.4, 6);
    expect(db.ws["1D"]!.version).toBe(3); // reading from the nest writes nothing into it
  });

  it("BOQ quantity changed -> written into the 1D nest (version-checked), the stale cutting result is dropped", async () => {
    db.parts[0].qty = 9;
    const r = await applyNestSync("proj", "u");
    expect(r.pushed).toBe(1);
    expect(nest1d().pieces[0].qty).toBe(9);
    expect(nest1d().result).toBeNull();
    expect(db.ws["1D"]!.version).toBe(4);
    expect(db.parts[0].nestSyncedQty).toBe(9);
    // and nothing is left to do
    const again = await applyNestSync("proj", "u");
    expect([again.applied, again.pushed]).toEqual([0, 0]);
  });

  it("both changed to different values -> a conflict is reported, nothing is overwritten", async () => {
    nest1d().pieces[0].qty = 5;
    db.parts[0].qty = 7;
    const r = await applyNestSync("proj", "u");
    expect(r.summary.conflict).toBe(1);
    expect([r.applied, r.pushed]).toEqual([0, 0]);
    expect(nest1d().pieces[0].qty).toBe(5);
    expect(db.parts[0].qty).toBe(7);
  });

  it("a piece removed from the nest leaves an orphan (the part is never deleted)", async () => {
    db.ws["1D"]!.dataJson = { v: 1, pieces: [] };
    const r = await applyNestSync("proj", "u");
    expect(r.summary.orphan).toBe(1);
    expect(db.parts).toHaveLength(1);
  });

  it("a segment with the same id as a real piece is never read or written", async () => {
    nest1d().pieces.push({ ...piece(1, 1), segment: { index: 1, total: 2 } } as never);
    db.parts[0].qty = 8;
    await applyNestSync("proj", "u");
    const pcs = nest1d().pieces as { qty: number; segment?: unknown }[];
    expect(pcs[0].qty).toBe(8);
    expect(pcs[1].qty).toBe(1);
  });

  it("2D parts and 1D parts are kept apart (a 2D link with the same id is not mixed up)", async () => {
    db.parts.push(part({ id: "plate", nestKind: "2D", nestPartId: 1, qty: 99, nestSyncedQty: 99, partType: "PLATE" }));
    db.ws["2D"] = { dataJson: { groups: [{ id: 1, qty: 99, outer: [[0, 0], [1, 0], [1, 1]], th: 5 }] }, version: 1 };
    const r = await applyNestSync("proj", "u");
    expect(r.items).toHaveLength(2);
    expect(r.summary.linked).toBe(2);
    expect(db.parts.find((p) => p.id === "plate")!.qty).toBe(99);
  });

  describe("what is reported as not in the BOQ yet", () => {
    it("counts a real piece that has no part", async () => {
      nest1d().pieces.push(piece(2, 1));
      expect((await getNestSyncStatus("proj")).summary.unlinked).toBe(1);
    });
    it("does not count plates, or pieces that came from the Part List", async () => {
      db.drawings = [{ drawingNumber: "A-1", parts: [{ itemNo: 2, description: "Rib" }] }];
      nest1d().pieces.push(piece(2, 1, { partType: "PLATE" }), piece(3, 1, { partId: "x" }), piece(4, 1, { name: "A-1 #2 Rib" }));
      expect((await getNestSyncStatus("proj")).summary.unlinked).toBe(0);
    });
  });

  it("no nest at all -> hasNest is false and nothing happens", async () => {
    db.ws = { "1D": null, "2D": null };
    db.parts = [];
    const r = await applyNestSync("proj", "u");
    expect(r).toMatchObject({ hasNest: false, applied: 0, pushed: 0 });
  });
});
