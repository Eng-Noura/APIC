import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-ins for the database and the services around the import (no DB in unit tests).
interface Part { id: string; drawingId: string; itemNo: number; description: string; qty: number; partType: string; geometry: unknown; thicknessMm: number | null; nestKind: string | null; nestPartId: number | null; nestSyncedQty: number | null }
interface Drawing { id: string; projectId: string; drawingNumber: string; title: string }
const db = vi.hoisted(() => ({ drawings: [] as Drawing[], parts: [] as Part[], workspace: null as unknown, seq: 0, linkFails: false }));

vi.mock("@/server/db/client", () => {
  const byId = (id: string) => db.parts.find((p) => p.id === id)!;
  return {
    prisma: {
      takeoffDrawing: {
        findMany: async ({ where }: { where: { projectId: string } }) =>
          db.drawings.filter((d) => d.projectId === where.projectId).map((d) => ({ ...d, parts: db.parts.filter((p) => p.drawingId === d.id) })),
        findUnique: async ({ where }: { where: { id: string } }) => db.drawings.find((d) => d.id === where.id) ?? null,
      },
      takeoffPart: {
        findFirst: async ({ where }: { where: { drawing: { projectId: string }; nestKind: string; nestPartId: number } }) =>
          db.parts.find((p) => p.nestKind === where.nestKind && p.nestPartId === where.nestPartId && db.drawings.find((d) => d.id === p.drawingId)?.projectId === where.drawing.projectId) ?? null,
        aggregate: async ({ where }: { where: { drawingId: string } }) => ({ _max: { itemNo: Math.max(0, ...db.parts.filter((p) => p.drawingId === where.drawingId).map((p) => p.itemNo)) || null } }),
        update: async ({ where, data }: { where: { id: string }; data: Partial<Part> }) => {
          if (db.linkFails) throw new Error("link failed");
          return Object.assign(byId(where.id), data);
        },
        delete: async ({ where }: { where: { id: string } }) => { db.parts = db.parts.filter((p) => p.id !== where.id); },
      },
    },
  };
});
vi.mock("./nesting-workspace.service", () => ({ getWorkspace: async () => (db.workspace ? { dataJson: db.workspace } : null) }));
vi.mock("./activity-log.service", () => ({ logActivity: async () => undefined }));
vi.mock("./takeoff.service", () => ({
  createDrawing: async (d: { projectId: string; drawingNumber: string; title: string }) => {
    const row = { id: `d${++db.seq}`, ...d };
    db.drawings.push(row);
    return row;
  },
  createPart: async (d: Omit<Part, "id" | "nestKind" | "nestPartId" | "nestSyncedQty">) => {
    const row: Part = { id: `p${++db.seq}`, nestKind: null, nestPartId: null, nestSyncedQty: null, ...d, thicknessMm: d.thicknessMm ?? null };
    db.parts.push(row);
    return row;
  },
}));

import { importMissingNestPieces, importNestPieces } from "./nest-1d-import.service";

const piece = (id: number, over: Record<string, unknown> = {}) => ({ id, sn: id, name: `P${id}`, profile: "IPE200", material: "S235", length: 3000, qty: 2, ...over });

beforeEach(() => {
  db.drawings = [{ id: "dwg", projectId: "proj", drawingNumber: "A-1", title: "Existing" }];
  db.parts = [];
  db.workspace = null;
  db.seq = 0;
  db.linkFails = false;
});

describe("importMissingNestPieces", () => {
  it("does nothing (and creates no drawing) when the project has no 1D nest", async () => {
    expect(await importMissingNestPieces("proj", "u")).toEqual({ imported: 0, failed: 0, warnings: [] });
    expect(db.drawings).toHaveLength(1);
  });

  it("takes the pieces into a NESTING-1D drawing and links each one to its piece", async () => {
    db.workspace = { pieces: [piece(1), piece(2, { profile: "PIPE OD60.3x3.2", partType: "PIPE", length: 1500 })] };
    const r = await importMissingNestPieces("proj", "u");
    expect(r).toEqual({ imported: 2, failed: 0, warnings: [] });
    const target = db.drawings.find((d) => d.drawingNumber === "NESTING-1D")!;
    expect(target.title).toBe("Parts from 1D Nesting");
    expect(db.parts.map((p) => [p.drawingId === target.id, p.nestKind, p.nestPartId, p.nestSyncedQty, p.partType, p.qty, p.itemNo])).toEqual([
      [true, "1D", 1, 2, "HOT_ROLLED", 2, 1],
      [true, "1D", 2, 2, "PIPE", 2, 2],
    ]);
  });

  it("is safe to run again: a piece that is linked is never added twice, a NEW piece comes in", async () => {
    db.workspace = { pieces: [piece(1)] };
    await importMissingNestPieces("proj", "u");
    expect((await importMissingNestPieces("proj", "u")).imported).toBe(0);
    db.workspace = { pieces: [piece(1), piece(2)] }; // a piece added to the nest later
    expect((await importMissingNestPieces("proj", "u")).imported).toBe(1);
    expect(db.parts.map((p) => p.nestPartId)).toEqual([1, 2]);
    expect(db.drawings.filter((d) => d.drawingNumber === "NESTING-1D")).toHaveLength(1);
  });

  it("never takes back a piece that came from the Part List (by part id, or by the old composite name)", async () => {
    db.parts = [{ id: "orig", drawingId: "dwg", itemNo: 7, description: "Support", qty: 1, partType: "HOT_ROLLED", geometry: {}, thicknessMm: null, nestKind: null, nestPartId: null, nestSyncedQty: null }];
    db.workspace = { pieces: [piece(1, { partId: "orig" }), piece(2, { name: "A-1 #7 Support" }), piece(3)] };
    const r = await importMissingNestPieces("proj", "u");
    expect(r.imported).toBe(1);
    expect(db.parts.filter((p) => p.nestKind === "1D").map((p) => p.nestPartId)).toEqual([3]);
  });

  it("reports what it left out and why — an unknown profile is not given a made-up weight", async () => {
    db.workspace = { pieces: [piece(1, { name: "Column", profile: "HEB200" }), piece(2, { profile: "PIPE", partType: "PIPE" }), piece(3, { partType: "PLATE" }), piece(4)] };
    const r = await importMissingNestPieces("proj", "u");
    expect(r.imported).toBe(1);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings[0]).toBe("Column L=3000: weight per metre of profile HEB200 is not known");
    expect(r.warnings[1]).toContain("pipe size not readable");
    expect(r.warnings[2]).toContain("1 plate piece(s)");
  });

  it("creates no drawing when every piece was left out", async () => {
    db.workspace = { pieces: [piece(1, { profile: "HEB200" })] };
    const r = await importMissingNestPieces("proj", "u");
    expect(r.imported).toBe(0);
    expect(r.warnings).toHaveLength(1);
    expect(db.drawings.some((d) => d.drawingNumber === "NESTING-1D")).toBe(false);
  });

  it("uses the existing NESTING-1D drawing and continues its item numbers", async () => {
    db.drawings.push({ id: "n1", projectId: "proj", drawingNumber: "NESTING-1D", title: "x" });
    db.parts = [{ id: "old", drawingId: "n1", itemNo: 5, description: "old", qty: 1, partType: "HOT_ROLLED", geometry: {}, thicknessMm: null, nestKind: "1D", nestPartId: 1, nestSyncedQty: 1 }];
    db.workspace = { pieces: [piece(1), piece(2)] };
    await importMissingNestPieces("proj", "u");
    expect(db.drawings.filter((d) => d.drawingNumber === "NESTING-1D")).toHaveLength(1);
    expect(db.parts.filter((p) => p.drawingId === "n1").map((p) => [p.nestPartId, p.itemNo])).toEqual([[1, 5], [2, 6]]);
  });

  it("a part that cannot be linked is removed again (it would be added a second time otherwise)", async () => {
    db.workspace = { pieces: [piece(1)] };
    db.linkFails = true;
    const r = await importMissingNestPieces("proj", "u");
    expect(r.imported).toBe(0);
    expect(r.failed).toBe(1);
    expect(db.parts).toHaveLength(0);
  });

  it("a 1D part linked in ANOTHER project does not count", async () => {
    db.drawings.push({ id: "other", projectId: "proj2", drawingNumber: "NESTING-1D", title: "x" });
    db.parts = [{ id: "o", drawingId: "other", itemNo: 1, description: "o", qty: 1, partType: "HOT_ROLLED", geometry: {}, thicknessMm: null, nestKind: "1D", nestPartId: 1, nestSyncedQty: 1 }];
    db.workspace = { pieces: [piece(1)] };
    expect((await importMissingNestPieces("proj", "u")).imported).toBe(1);
  });
});

describe("importNestPieces (the manual dialog)", () => {
  const item = (over: Record<string, unknown> = {}) => ({ name: "Col", profile: "HEB200", material: "S355", lengthMm: 2000, qty: 3, partType: "HOT_ROLLED" as const, ...over });

  it("an unknown profile is added once the person typed its weight", async () => {
    const r = await importNestPieces("dwg", [item(), item({ weightPerMeter: 61.3, nestPartId: 9 })], "u");
    expect(r[0]).toMatchObject({ index: 0, ok: false });
    expect(r[1]).toEqual({ index: 1, ok: true, skipped: undefined });
    expect(db.parts[0]).toMatchObject({ nestKind: "1D", nestPartId: 9, geometry: { profile: "HEB200", length: 2, weightPerMeter: 61.3 } });
  });

  it("a history source (no nestPartId) creates an unlinked part", async () => {
    await importNestPieces("dwg", [item({ weightPerMeter: 50 })], "u");
    expect(db.parts[0]).toMatchObject({ nestKind: null, nestPartId: null });
  });

  it("a piece that is already linked is skipped, not doubled", async () => {
    await importNestPieces("dwg", [item({ weightPerMeter: 50, nestPartId: 4 })], "u");
    const again = await importNestPieces("dwg", [item({ weightPerMeter: 50, nestPartId: 4 })], "u");
    expect(again[0]).toMatchObject({ ok: true, skipped: true });
    expect(db.parts).toHaveLength(1);
  });

  it("an unknown drawing is an error", async () => {
    await expect(importNestPieces("nope", [item()], "u")).rejects.toThrow("Drawing not found");
  });
});
