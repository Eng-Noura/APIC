// createOffer against a mocked Prisma client. There is no database here, so this checks the service's own decisions (which snapshot
// it builds from, what it refuses, what it writes and audits) — not SQL behaviour, the transaction or constraints.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class EstimationError extends Error { constructor(message: string, public status = 400) { super(message); } }
  const tx = {
    quotation: { findFirst: vi.fn(), create: vi.fn() },
    estimateOffer: { create: vi.fn() },
  };
  const db = {
    projectEstimate: { findUnique: vi.fn() },
    estimateSnapshot: { findMany: vi.fn() },
    estimateOffer: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { EstimationError, db, tx, audit: vi.fn(), getSavedEstimate: vi.fn(), logActivity: vi.fn(), nextNumber: vi.fn() };
});
vi.mock("@/server/db/client", () => ({ prisma: h.db }));
vi.mock("./activity-log.service", () => ({ logActivity: h.logActivity }));
vi.mock("./quotations.service", () => ({ nextNumber: h.nextNumber }));
vi.mock("./estimation.service", () => ({ EstimationError: h.EstimationError, audit: h.audit, getSavedEstimate: h.getSavedEstimate }));

import { createOffer } from "./estimation-offer.service";
import { buildSnapshot } from "@/features/estimation/workflow";
import type { EstimateInputs } from "@/features/estimation/calc";

const inputs: EstimateInputs = {
  materials: [
    { id: "m1", source: "PART_LIST", name: "A", itemId: "i1", requiredKg: 100, purchasedKg: 100, unitPrice: 20, priceSource: "PROCUREMENT" },
    { id: "m2", source: "PART_LIST", name: "B", itemId: "i2", requiredKg: 50, purchasedKg: 60, unitPrice: 25, priceSource: "PROCUREMENT" },
  ],
  scrap: { usedLaterPct: 0, usedLaterPricePerKg: 0, scrapSellPricePerKg: 0, creditRecoveredScrap: false },
  items: [{ id: "i1", weightKg: 100, pieces: 1, operations: [] }, { id: "i2", weightKg: 50, pieces: 1, operations: [] }],
  subcontracts: [], projectCosts: [],
  commercial: { profitMode: "MARKUP_ON_COST", profitValue: 10, insuranceMode: "FIXED", insuranceValue: 0, taxPct: 14 },
};
const payload = buildSnapshot(inputs);
const FINAL = payload.result.commercial.finalCents;
const snapRow = (over: Record<string, unknown> = {}) => ({ id: "s9", kind: "APPROVED", version: 2, inputs: payload.inputs, result: payload.result, createdAt: new Date("2026-11-02T10:00:00Z"), ...over });
const doc = (over: Record<string, unknown> = {}) => ({
  project: { id: "p1", name: "Plant A", number: "P-1", customer: "ACME" }, currency: "EGP", sheet: { status: "APPROVED", version: 2 },
  items: [{ id: "i1", name: "Riser" }, { id: "i2", name: "Skid" }],
  settings: { offerValidityDays: 30, paymentTerms: "30% advance", deliveryDays: 45, exclusions: null, commercialNotes: "note" },
  // what the SAVED sheet says now: deliberately different from the approved snapshot
  totals: { finalCents: 999999999, estimatedCostCents: 1, issue: null }, ...over,
});
const user = { id: "u1", name: "Sara" };

beforeEach(() => {
  for (const f of [h.db.projectEstimate.findUnique, h.db.estimateSnapshot.findMany, h.db.estimateOffer.findFirst, h.tx.quotation.findFirst, h.tx.quotation.create, h.tx.estimateOffer.create, h.audit, h.getSavedEstimate, h.logActivity, h.nextNumber]) f.mockReset();
  h.db.$transaction.mockClear();
  h.db.projectEstimate.findUnique.mockResolvedValue({ id: "e1" });
  h.db.estimateSnapshot.findMany.mockResolvedValue([snapRow()]);
  h.db.estimateOffer.findFirst.mockResolvedValue(null);
  h.getSavedEstimate.mockResolvedValue(doc());
  h.nextNumber.mockResolvedValue("QT-2026-001");
  h.tx.quotation.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "q1", number: data.number, revision: data.revision }));
});

describe("what it builds from", () => {
  it("reads only APPROVED snapshots of this project's sheet, newest first", async () => {
    await createOffer("p1", user);
    expect(h.db.estimateSnapshot.findMany).toHaveBeenCalledWith({ where: { estimateId: "e1", kind: "APPROVED" }, orderBy: { createdAt: "desc" }, take: 1 });
  });
  it("prices the offer with the approved snapshot's final price, not the saved sheet's (which may be a draft with other numbers)", async () => {
    await createOffer("p1", user);
    const data = h.tx.quotation.create.mock.calls[0][0].data;
    expect(data.items.create).toHaveLength(1);
    expect(data.items.create[0].unitRate).toBe(FINAL / 100);
    expect(h.tx.estimateOffer.create.mock.calls[0][0].data.finalPrice).toBe(FINAL / 100);
  });
  it("is refused (409) when nothing is approved, and writes nothing", async () => {
    h.db.estimateSnapshot.findMany.mockResolvedValue([]);
    await expect(createOffer("p1", user)).rejects.toMatchObject({ status: 409 });
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it("is refused (409) when the approved snapshot does not match its own inputs", async () => {
    const tampered = JSON.parse(JSON.stringify(payload.result)); tampered.commercial.finalCents += 100;
    h.db.estimateSnapshot.findMany.mockResolvedValue([snapRow({ result: tampered })]);
    await expect(createOffer("p1", user)).rejects.toMatchObject({ status: 409 });
    expect(h.tx.quotation.create).not.toHaveBeenCalled();
  });
  it("is a 404 when the project has no sheet", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(null);
    await expect(createOffer("p1", user)).rejects.toMatchObject({ status: 404 });
  });
});

describe("layout", () => {
  it("default is lump sum (needs approval)", async () => {
    const r = await createOffer("p1", user);
    expect(r.layout).toBe("LUMP_SUM");
    expect(h.tx.estimateOffer.create.mock.calls[0][0].data.layout).toBe("LUMP_SUM");
  });
  it("per item writes one quotation line per item, with the sheet's names, adding up to the final price", async () => {
    await createOffer("p1", user, { layout: "PER_ITEM" });
    const lines = h.tx.quotation.create.mock.calls[0][0].data.items.create as { description: string; unitRate: number; sortOrder: number }[];
    expect(lines.map((l) => l.description)).toEqual(expect.arrayContaining(["Riser", "Skid"]));
    expect(lines.map((l) => l.sortOrder)).toEqual(lines.map((_l, i) => i));
    expect(Math.round(lines.reduce((a, l) => a + l.unitRate * 100, 0))).toBe(FINAL);
  });
  it("per item is refused (422) when an item's name is no longer on the sheet, and nothing is written", async () => {
    h.getSavedEstimate.mockResolvedValue(doc({ items: [{ id: "i1", name: "Riser" }] }));
    await expect(createOffer("p1", user, { layout: "PER_ITEM" })).rejects.toMatchObject({ status: 422 });
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
});

describe("numbering, revisions and records", () => {
  it("the first offer takes a new number as revision 0 and never touches another quotation", async () => {
    const r = await createOffer("p1", user);
    expect(h.nextNumber).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ number: "QT-2026-001", revision: 0 });
    expect(h.tx.quotation.create.mock.calls[0][0].data.status).toBe("DRAFT");
  });
  it("a later offer is the next revision of the SAME number: it only creates, it never updates or deletes an existing revision", async () => {
    h.db.estimateOffer.findFirst.mockResolvedValue({ quotation: { number: "QT-2026-001" } });
    h.tx.quotation.findFirst.mockResolvedValue({ revision: 3 });
    const r = await createOffer("p1", user);
    expect(h.nextNumber).not.toHaveBeenCalled();
    expect(r).toMatchObject({ number: "QT-2026-001", revision: 4 });
    expect(h.tx.quotation.create).toHaveBeenCalledTimes(1);
    expect(h.tx.quotation.create.mock.calls[0][0].data.events.create[0].kind).toBe("REVISED");
  });
  it("records which snapshot and layout the offer came from, and audits it inside the same transaction", async () => {
    await createOffer("p1", user, { layout: "PER_ITEM" });
    const o = h.tx.estimateOffer.create.mock.calls[0][0].data;
    expect(o).toMatchObject({ snapshotId: "s9", snapshotVersion: 2, layout: "PER_ITEM", quotationId: "q1" });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(h.tx);
    expect(h.audit.mock.calls[0].slice(1, 5)).toEqual(["e1", "u1", 2, "OFFER"]);
  });
  it("tells the caller when the terms came from a sheet that is no longer approved (a snapshot stores figures, not terms)", async () => {
    expect((await createOffer("p1", user)).termsFromCurrentSheet).toBe(false);
    h.getSavedEstimate.mockResolvedValue(doc({ sheet: { status: "DRAFT", version: 3 } }));
    expect((await createOffer("p1", user)).termsFromCurrentSheet).toBe(true);
  });
  it("copies the terms and notes from the sheet's settings", async () => {
    await createOffer("p1", user);
    const d = h.tx.quotation.create.mock.calls[0][0].data;
    expect(d.terms).toBe("Payment terms: 30% advance\nDelivery period: 45 days");
    expect(d.notes).toBe("note");
  });
});
