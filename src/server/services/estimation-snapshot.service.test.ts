// getSnapshot against a mocked Prisma client. There is no database here, so this checks the service's own decisions (the
// project scoping and the shape it returns), not SQL behaviour.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  db: { projectEstimate: { findUnique: vi.fn() }, estimateSnapshot: { findFirst: vi.fn() } },
}));
vi.mock("@/server/db/client", () => ({ prisma: h.db }));
vi.mock("./activity-log.service", () => ({ logActivity: vi.fn() }));
vi.mock("./nest-sync-guard", () => ({ ensureNestInSync: vi.fn() }));

import { EstimationError, getSnapshot } from "./estimation.service";
import { buildSnapshot } from "@/features/estimation/workflow";
import type { EstimateInputs } from "@/features/estimation/calc";

const inputs: EstimateInputs = {
  materials: [{ id: "m1", source: "MANUAL", name: "Plate", requiredKg: null, purchasedKg: 100, unitPrice: 10, priceSource: "MANUAL" }],
  scrap: { usedLaterPct: 0, usedLaterPricePerKg: 0, scrapSellPricePerKg: 0, creditRecoveredScrap: false },
  items: [], subcontracts: [], projectCosts: [],
  commercial: { profitMode: "MARKUP_ON_COST", profitValue: 10, insuranceMode: "FIXED", insuranceValue: 0, taxPct: 0 },
};
const payload = buildSnapshot(inputs);
const row = (over: Record<string, unknown> = {}) => ({
  id: "s1", version: 2, kind: "APPROVED", inputs: payload.inputs, result: payload.result, costTotal: payload.costTotalCents / 100,
  finalPrice: payload.finalPriceCents / 100, note: null, createdById: "u1", createdAt: new Date("2026-11-01T10:00:00Z"), estimateId: "e1", ...over,
});

beforeEach(() => { h.db.projectEstimate.findUnique.mockReset(); h.db.estimateSnapshot.findFirst.mockReset(); });

describe("getSnapshot", () => {
  it("looks the snapshot up by id AND by this project's sheet, never by id alone", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue({ id: "e1" });
    h.db.estimateSnapshot.findFirst.mockResolvedValue(row());
    await getSnapshot("p1", "s1");
    expect(h.db.projectEstimate.findUnique).toHaveBeenCalledWith({ where: { projectId: "p1" }, select: { id: true } });
    expect(h.db.estimateSnapshot.findFirst).toHaveBeenCalledWith({ where: { id: "s1", estimateId: "e1" } });
  });

  it("returns the stored inputs and result in full with the verified flag", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue({ id: "e1" });
    h.db.estimateSnapshot.findFirst.mockResolvedValue(row());
    const s = await getSnapshot("p1", "s1");
    expect(s.kind).toBe("APPROVED");
    expect(s.version).toBe(2);
    expect(s.inputs.materials[0].name).toBe("Plate");
    expect(s.result.totals.materialCents).toBe(payload.result.totals.materialCents);
    expect(s.verified).toBe(true);
    expect(s.createdAt).toBe("2026-11-01T10:00:00.000Z");
  });

  it("flags a snapshot whose stored result no longer matches its inputs as not verified", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue({ id: "e1" });
    const tampered = JSON.parse(JSON.stringify(payload.result)); tampered.totals.estimatedCostCents += 1;
    h.db.estimateSnapshot.findFirst.mockResolvedValue(row({ result: tampered }));
    expect((await getSnapshot("p1", "s1")).verified).toBe(false);
  });

  it("is a 404 when the snapshot is not found for this sheet (another project's id looks the same as a missing one)", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue({ id: "e1" });
    h.db.estimateSnapshot.findFirst.mockResolvedValue(null);
    await expect(getSnapshot("p1", "other")).rejects.toMatchObject({ status: 404 });
  });

  it("is a 404 when the project has no sheet, and reads no snapshot", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(null);
    await expect(getSnapshot("p1", "s1")).rejects.toBeInstanceOf(EstimationError);
    expect(h.db.estimateSnapshot.findFirst).not.toHaveBeenCalled();
  });
});
