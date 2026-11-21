// applyTemplate / template CRUD against a mocked Prisma client. There is no database here, so this checks the service's own
// decisions (what it refuses, what it writes, what it audits) — not SQL behaviour, transactions or constraints.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class EstimationError extends Error { constructor(message: string, public status = 400) { super(message); } }
  const db = {
    projectEstimate: { findUnique: vi.fn(), updateMany: vi.fn() },
    estimateTemplate: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    estimateOperation: { create: vi.fn(), update: vi.fn() },
    estimateProjectCost: { create: vi.fn(), update: vi.fn() },
    estimateSubcontract: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  return { EstimationError, db, audit: vi.fn(), getSavedEstimate: vi.fn(), logActivity: vi.fn() };
});

vi.mock("@/server/db/client", () => ({ prisma: h.db }));
vi.mock("./activity-log.service", () => ({ logActivity: h.logActivity }));
vi.mock("./estimation.service", () => ({ EstimationError: h.EstimationError, audit: h.audit, getSavedEstimate: h.getSavedEstimate }));

import { applyTemplate, createTemplate, deleteTemplate, listTemplates, updateTemplate } from "./estimation-templates.service";

const UPDATED = new Date("2026-11-01T10:00:00Z");
const sheet = (over: Record<string, unknown> = {}) => ({
  id: "e1", version: 2, status: "DRAFT", updatedAt: UPDATED,
  items: [{
    id: "i1", name: "Riser", operations: [
      { id: "o1", name: "Welding", source: "DEFAULT", rate: 0, selected: false, sortOrder: 1 },
      { id: "o2", name: "Cutting", source: "MANUAL", rate: 4, selected: true, sortOrder: 0 },
    ],
  }, { id: "i2", name: "Skid", operations: [] }],
  projectCosts: [
    { id: "c1", name: "Engineering", source: "DEFAULT", rate: 0, itemId: null, sortOrder: 0 },
    { id: "c2", name: "NDT", source: "MANUAL", rate: 40, itemId: null, sortOrder: 1 },
  ],
  subcontracts: [{ id: "s1", name: "Blasting", sortOrder: 3 }],
  ...over,
});
const tpl = (kind: string, name: string, data: unknown) => ({ id: "t1", kind, name, data, createdById: "u0", createdAt: new Date() });
const opData = { costType: "PER_METER", unit: "M", rate: 12.5 };
const costData = { method: "PER_TEST", unit: "test", rate: 40 };
const subData = { unit: "m²", quantity: 100, unitPrice: 3, company: "ACME" };

beforeEach(() => {
  for (const g of Object.values(h.db)) if (typeof g === "function") (g as ReturnType<typeof vi.fn>).mockReset(); else for (const f of Object.values(g)) f.mockReset();
  h.audit.mockReset(); h.getSavedEstimate.mockReset(); h.logActivity.mockReset();
  h.db.$transaction.mockImplementation(async (fn: (tx: typeof h.db) => unknown) => fn(h.db));
  h.db.projectEstimate.updateMany.mockResolvedValue({ count: 1 });
  h.getSavedEstimate.mockResolvedValue({ doc: true });
});

const refuses = async (p: Promise<unknown>, status: number, text?: string) => {
  const e = await p.then(() => null, (x: unknown) => x as InstanceType<typeof h.EstimationError>);
  expect(e, "expected a refusal").toBeInstanceOf(h.EstimationError);
  expect(e!.status).toBe(status);
  if (text) expect(e!.message).toContain(text);
};
const noWrites = () => {
  expect(h.db.projectEstimate.updateMany).not.toHaveBeenCalled();
  for (const w of [h.db.estimateOperation.create, h.db.estimateOperation.update, h.db.estimateProjectCost.create, h.db.estimateProjectCost.update, h.db.estimateSubcontract.create, h.audit]) expect(w).not.toHaveBeenCalled();
};

describe("applyTemplate — refusals (nothing is written)", () => {
  it("no estimate → 404", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(null);
    await refuses(applyTemplate("p1", { templateId: "t1", itemId: "i1" }, "u1"), 404); noWrites();
  });

  it("an APPROVED sheet is locked → 409", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet({ status: "APPROVED" }));
    await refuses(applyTemplate("p1", { templateId: "t1", itemId: "i1" }, "u1"), 409, "locked"); noWrites();
  });

  it("unknown template → 404", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(null);
    await refuses(applyTemplate("p1", { templateId: "nope", itemId: "i1" }, "u1"), 404); noWrites();
  });

  it("a stored template with invalid data is refused with 422, not applied", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("OPERATION", "Fitting", { costType: "PERCENTAGE", unit: "%", rate: 5 })); // no percentBase
    await refuses(applyTemplate("p1", { templateId: "t1", itemId: "i1" }, "u1"), 422, "not valid"); noWrites();
  });

  it("an operation template without an item → 400", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("OPERATION", "Fitting", opData));
    await refuses(applyTemplate("p1", { templateId: "t1" }, "u1"), 400, "item"); noWrites();
  });

  it("an item id that is not in this project's estimate → 400 (client ids are never trusted)", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    for (const kind of [["OPERATION", opData], ["PROJECT_COST", costData], ["SUBCONTRACT", subData]] as const) {
      h.db.estimateTemplate.findUnique.mockResolvedValue(tpl(kind[0], "Anything", kind[1]));
      await refuses(applyTemplate("p1", { templateId: "t1", itemId: "foreign-item" }, "u1"), 400, "does not belong");
    }
    noWrites();
  });

  it("a same-named operation the user already priced is a conflict, not overwritten", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("OPERATION", "cutting", opData)); // matches "Cutting" ignoring case
    await refuses(applyTemplate("p1", { templateId: "t1", itemId: "i1" }, "u1"), 409, "already on the sheet"); noWrites();
  });

  it("a same-named project cost with a price is a conflict", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("PROJECT_COST", "NDT", costData));
    await refuses(applyTemplate("p1", { templateId: "t1", itemId: null }, "u1"), 409); noWrites();
  });

  it("someone saved in between (the guarded update matches no row) → 409 and no line is written", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("OPERATION", "Fitting", opData));
    h.db.projectEstimate.updateMany.mockResolvedValue({ count: 0 });
    await refuses(applyTemplate("p1", { templateId: "t1", itemId: "i1" }, "u1"), 409, "changed");
    expect(h.db.estimateOperation.create).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("applyTemplate — what it writes", () => {
  it("adds a new operation to the chosen item: selected, MANUAL source, after the last sort order, audited", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("OPERATION", "Fitting", opData));
    const doc = await applyTemplate("p1", { templateId: "t1", itemId: "i1" }, "u1");
    expect(doc).toEqual({ doc: true });
    expect(h.db.estimateOperation.create).toHaveBeenCalledTimes(1);
    expect(h.db.estimateOperation.create.mock.calls[0][0].data).toMatchObject({ name: "Fitting", itemId: "i1", source: "MANUAL", selected: true, rate: 12.5, costType: "PER_METER", sortOrder: 2 });
    expect(h.audit).toHaveBeenCalledTimes(1);
    const [, estimateId, userId, version, action, , changes] = h.audit.mock.calls[0];
    expect([estimateId, userId, version, action]).toEqual(["e1", "u1", 2, "TEMPLATE"]);
    expect(changes).toEqual([expect.objectContaining({ entity: "operation", field: "(line)", to: "added from template" })]);
  });

  it("the sheet goes back to DRAFT and is guarded by version + updatedAt + not APPROVED", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet({ status: "CALCULATED" }));
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("OPERATION", "Fitting", opData));
    await applyTemplate("p1", { templateId: "t1", itemId: "i1" }, "u1");
    const arg = h.db.projectEstimate.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "e1", version: 2, updatedAt: UPDATED, status: { not: "APPROVED" } });
    expect(arg.data).toMatchObject({ status: "DRAFT", updatedById: "u1" });
  });

  it("fills an untouched default operation instead of adding a duplicate, with a field-level audit", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("OPERATION", "Welding", opData));
    await applyTemplate("p1", { templateId: "t1", itemId: "i1" }, "u1");
    expect(h.db.estimateOperation.create).not.toHaveBeenCalled();
    expect(h.db.estimateOperation.update).toHaveBeenCalledTimes(1);
    const u = h.db.estimateOperation.update.mock.calls[0][0];
    expect(u.where).toEqual({ id: "o1" });
    expect(u.data).toMatchObject({ rate: 12.5, costType: "PER_METER", selected: true });
    expect(u.data).not.toHaveProperty("name"); // the line keeps its own name
    const changes = h.audit.mock.calls[0][6] as { field: string; from: unknown; to: unknown }[];
    expect(changes.find((c) => c.field === "rate")).toEqual({ entity: "operation", label: "Riser · Welding", field: "rate", from: 0, to: 12.5 });
    expect(changes.find((c) => c.field === "selected")).toMatchObject({ from: false, to: true });
  });

  it("fills a default project cost; adds a new one to the whole project (itemId null) or to one item", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("PROJECT_COST", "Engineering", { method: "FIXED", unit: "", rate: 9000, category: "Engineering" }));
    await applyTemplate("p1", { templateId: "t1", itemId: null }, "u1");
    expect(h.db.estimateProjectCost.update.mock.calls[0][0]).toMatchObject({ where: { id: "c1" }, data: { rate: 9000, category: "Engineering" } });
    expect(h.db.estimateProjectCost.create).not.toHaveBeenCalled();

    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("PROJECT_COST", "Crane", { method: "PER_TON", unit: "ton", rate: 25 }));
    await applyTemplate("p1", { templateId: "t1", itemId: null }, "u1");
    expect(h.db.estimateProjectCost.create.mock.calls[0][0].data).toMatchObject({ name: "Crane", estimateId: "e1", itemId: null, source: "MANUAL", enabled: true, sortOrder: 2 });

    await applyTemplate("p1", { templateId: "t1", itemId: "i2" }, "u1");
    expect(h.db.estimateProjectCost.create.mock.calls[1][0].data).toMatchObject({ itemId: "i2" });
  });

  it("the same project-cost name on a different scope is not a conflict (item scope vs whole project)", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("PROJECT_COST", "NDT", costData)); // NDT exists for the whole project only
    await applyTemplate("p1", { templateId: "t1", itemId: "i1" }, "u1");
    expect(h.db.estimateProjectCost.create.mock.calls[0][0].data).toMatchObject({ name: "NDT", itemId: "i1" });
  });

  it("subcontractor services are always added, to an item or the whole project", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("SUBCONTRACT", "Blasting", subData)); // same name as s1
    await applyTemplate("p1", { templateId: "t1", itemId: null }, "u1");
    await applyTemplate("p1", { templateId: "t1", itemId: "i1" }, "u1");
    expect(h.db.estimateSubcontract.create).toHaveBeenCalledTimes(2);
    expect(h.db.estimateSubcontract.create.mock.calls[0][0].data).toMatchObject({ name: "Blasting", company: "ACME", estimateId: "e1", itemId: null, selected: true, costType: "PER_UNIT", sortOrder: 4 });
    expect(h.db.estimateSubcontract.create.mock.calls[1][0].data).toMatchObject({ itemId: "i1" });
  });

  it("the audit entry is written in the same transaction as the line", async () => {
    h.db.projectEstimate.findUnique.mockResolvedValue(sheet());
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("SUBCONTRACT", "Blasting", subData));
    await applyTemplate("p1", { templateId: "t1", itemId: null }, "u1");
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(h.db); // the tx handle, not a separate connection
  });
});

describe("template CRUD", () => {
  const input = { kind: "OPERATION", name: "Welding", data: opData } as never;

  it("create refuses a name that only differs by case or spacing", async () => {
    h.db.estimateTemplate.findMany.mockResolvedValue([{ id: "x", name: "welding" }]);
    await refuses(createTemplate(input, "u1"), 409, "already exists");
    expect(h.db.estimateTemplate.create).not.toHaveBeenCalled();
  });

  it("create maps a database unique violation (a race) to 409", async () => {
    const { Prisma } = await import("@prisma/client");
    h.db.estimateTemplate.findMany.mockResolvedValue([]);
    h.db.estimateTemplate.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "5.22.0" }));
    await refuses(createTemplate(input, "u1"), 409, "already exists");
  });

  it("create stores kind, name, data and the creator, and logs it", async () => {
    h.db.estimateTemplate.findMany.mockResolvedValue([]);
    h.db.estimateTemplate.create.mockResolvedValue(tpl("OPERATION", "Welding", opData));
    const r = await createTemplate(input, "u1");
    expect(h.db.estimateTemplate.create.mock.calls[0][0].data).toEqual({ kind: "OPERATION", name: "Welding", data: opData, createdById: "u1" });
    expect(r.name).toBe("Welding");
    expect(h.logActivity).toHaveBeenCalledTimes(1);
  });

  it("update: unknown id → 404; changing the kind → 400; renaming onto another template → 409; renaming to itself is fine", async () => {
    h.db.estimateTemplate.findUnique.mockResolvedValue(null);
    await refuses(updateTemplate("t1", input, "u1"), 404);
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("PROJECT_COST", "Welding", costData));
    await refuses(updateTemplate("t1", input, "u1"), 400, "cannot be changed");
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("OPERATION", "Old", opData));
    h.db.estimateTemplate.findMany.mockResolvedValue([{ id: "other", name: "Welding" }]);
    await refuses(updateTemplate("t1", input, "u1"), 409);
    h.db.estimateTemplate.findMany.mockResolvedValue([{ id: "t1", name: "Welding" }]);
    h.db.estimateTemplate.update.mockResolvedValue(tpl("OPERATION", "Welding", opData));
    await updateTemplate("t1", input, "u1");
    expect(h.db.estimateTemplate.update).toHaveBeenCalledTimes(1);
  });

  it("update never touches any sheet", async () => {
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("OPERATION", "Welding", opData));
    h.db.estimateTemplate.findMany.mockResolvedValue([]);
    h.db.estimateTemplate.update.mockResolvedValue(tpl("OPERATION", "Welding", opData));
    await updateTemplate("t1", input, "u1");
    expect(h.db.projectEstimate.updateMany).not.toHaveBeenCalled();
    expect(h.db.estimateOperation.update).not.toHaveBeenCalled();
  });

  it("delete: unknown → 404; otherwise removes only the template", async () => {
    h.db.estimateTemplate.findUnique.mockResolvedValue(null);
    await refuses(deleteTemplate("t1", "u1"), 404);
    h.db.estimateTemplate.findUnique.mockResolvedValue(tpl("OPERATION", "Welding", opData));
    await deleteTemplate("t1", "u1");
    expect(h.db.estimateTemplate.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(h.db.estimateOperation.update).not.toHaveBeenCalled();
  });

  it("list filters by kind when given", async () => {
    h.db.estimateTemplate.findMany.mockResolvedValue([tpl("SUBCONTRACT", "Blasting", subData)]);
    const r = await listTemplates("SUBCONTRACT");
    expect(h.db.estimateTemplate.findMany.mock.calls[0][0].where).toEqual({ kind: "SUBCONTRACT" });
    expect(r[0]).toMatchObject({ kind: "SUBCONTRACT", name: "Blasting" });
    await listTemplates();
    expect(h.db.estimateTemplate.findMany.mock.calls[1][0].where).toBeUndefined();
  });
});
