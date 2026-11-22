// Route layer of the pricing workflow: which permission each route asks for, that nothing runs when the guard refuses, that
// bad input is a 400 (never a crash), and that service errors keep their status. The guard and the services are mocked —
// there is no database here — so this proves the wiring, not the database behaviour of the services.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const m = vi.hoisted(() => {
  class EstimationError extends Error { constructor(message: string, public status = 400) { super(message); } }
  return {
    EstimationError,
    asked: [] as string[],
    role: "ADMIN" as string,
    allow: true,
    calculateSheet: vi.fn(), approveSheet: vi.fn(), reopenSheet: vi.fn(), restoreMaterialLine: vi.fn(), listVersions: vi.fn(), compareVersions: vi.fn(), listAudit: vi.fn(), getSnapshot: vi.fn(), createOffer: vi.fn(),
    applyTemplate: vi.fn(), createTemplate: vi.fn(), updateTemplate: vi.fn(), deleteTemplate: vi.fn(), listTemplates: vi.fn(),
  };
});

vi.mock("@/server/api/guard", () => ({
  requirePermission: async (p: string) => {
    m.asked.push(p);
    if (!m.allow) return { session: null, res: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    return { session: { user: { id: "u1", role: m.role, name: "Tester" } }, res: null };
  },
}));
vi.mock("@/server/services/estimation.service", () => ({
  EstimationError: m.EstimationError,
  calculateSheet: m.calculateSheet, approveSheet: m.approveSheet, reopenSheet: m.reopenSheet, restoreMaterialLine: m.restoreMaterialLine,
  listVersions: m.listVersions, compareVersions: m.compareVersions, listAudit: m.listAudit, getSnapshot: m.getSnapshot,
}));
vi.mock("@/server/services/estimation-offer.service", () => ({ createOffer: m.createOffer }));
vi.mock("@/server/services/estimation-templates.service", () => ({
  applyTemplate: m.applyTemplate, createTemplate: m.createTemplate, updateTemplate: m.updateTemplate, deleteTemplate: m.deleteTemplate, listTemplates: m.listTemplates,
}));

import * as calculate from "@/app/api/projects/[id]/estimation/calculate/route";
import * as approve from "@/app/api/projects/[id]/estimation/approve/route";
import * as reopen from "@/app/api/projects/[id]/estimation/reopen/route";
import * as restore from "@/app/api/projects/[id]/estimation/restore/route";
import * as versions from "@/app/api/projects/[id]/estimation/versions/route";
import * as snapshot from "@/app/api/projects/[id]/estimation/versions/[snapshotId]/route";
import * as offer from "@/app/api/projects/[id]/estimation/offer/route";
import * as compare from "@/app/api/projects/[id]/estimation/versions/compare/route";
import * as auditRoute from "@/app/api/projects/[id]/estimation/audit/route";
import * as apply from "@/app/api/projects/[id]/estimation/apply-template/route";
import * as templates from "@/app/api/estimation-templates/route";
import * as templateById from "@/app/api/estimation-templates/[templateId]/route";

const ctx = { params: Promise.resolve({ id: "p1" }) };
const sctx = { params: Promise.resolve({ id: "p1", snapshotId: "s1" }) };
const tctx = { params: Promise.resolve({ templateId: "t1" }) };
const req = (method: string, body?: unknown, url = "http://localhost/api/x") =>
  new NextRequest(url, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });

const validOpTemplate = { kind: "OPERATION", name: "Welding", data: { costType: "PER_METER", unit: "M", rate: 12 } };

beforeEach(() => {
  m.asked.length = 0; m.role = "ADMIN"; m.allow = true;
  for (const k of ["calculateSheet", "approveSheet", "reopenSheet", "restoreMaterialLine", "listVersions", "compareVersions", "listAudit", "getSnapshot", "createOffer", "applyTemplate", "createTemplate", "updateTemplate", "deleteTemplate", "listTemplates"] as const) m[k].mockReset();
});

describe("permissions", () => {
  const cases: [string, () => Promise<Response>, string, ReturnType<typeof vi.fn>][] = [
    ["calculate", () => calculate.POST(req("POST"), ctx), "pricing.edit", m.calculateSheet],
    ["approve", () => approve.POST(req("POST"), ctx), "pricing.approve", m.approveSheet],
    ["reopen", () => reopen.POST(req("POST", { reason: "Customer revised the scope" }), ctx), "pricing.approve", m.reopenSheet],
    ["restore", () => restore.POST(req("POST", { materialId: "m1" }), ctx), "pricing.edit", m.restoreMaterialLine],
    ["versions", () => versions.GET(req("GET"), ctx), "pricing.view", m.listVersions],
    ["compare", () => compare.GET(req("GET", undefined, "http://localhost/api/x?from=a&to=b"), ctx), "pricing.view", m.compareVersions],
    ["snapshot", () => snapshot.GET(req("GET"), sctx), "pricing.view", m.getSnapshot],
    ["audit", () => auditRoute.GET(req("GET"), ctx), "pricing.view", m.listAudit],
    ["apply-template", () => apply.POST(req("POST", { templateId: "t1", itemId: "i1" }), ctx), "pricing.edit", m.applyTemplate],
    ["templates GET", () => templates.GET(req("GET")), "pricing.view", m.listTemplates],
    ["templates POST", () => templates.POST(req("POST", validOpTemplate)), "pricing.edit", m.createTemplate],
    ["template PUT", () => templateById.PUT(req("PUT", validOpTemplate), tctx), "pricing.edit", m.updateTemplate],
    ["template DELETE", () => templateById.DELETE(req("DELETE"), tctx), "pricing.edit", m.deleteTemplate],
  ];

  it.each(cases)("%s asks for the right permission and calls the service when allowed", async (_n, call, perm, service) => {
    service.mockResolvedValue({ ok: true });
    const r = await call();
    expect(r.status).toBeLessThan(300);
    expect(m.asked).toEqual([perm]);
    expect(service).toHaveBeenCalledTimes(1);
  });

  it.each(cases)("%s does nothing when the guard refuses", async (_n, call, _perm, service) => {
    m.allow = false;
    const r = await call();
    expect(r.status).toBe(403);
    expect(service).not.toHaveBeenCalled();
  });
});

describe("workflow routes", () => {
  it("approve passes the signed-in user's id and role to the service (the service checks pricing.approve again)", async () => {
    m.role = "MANAGER"; m.approveSheet.mockResolvedValue({});
    await approve.POST(req("POST"), ctx);
    expect(m.approveSheet).toHaveBeenCalledWith("p1", { id: "u1", role: "MANAGER" });
  });

  it("a service refusal keeps its status and message", async () => {
    m.approveSheet.mockRejectedValue(new m.EstimationError("The sheet changed after it was calculated. Recalculate before approving.", 409));
    const r = await approve.POST(req("POST"), ctx);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("Recalculate");
  });

  it("calculate on a locked sheet is a 409 from the service, passed through", async () => {
    m.calculateSheet.mockRejectedValue(new m.EstimationError("This sheet is approved and locked. Reopen it to recalculate.", 409));
    expect((await calculate.POST(req("POST"), ctx)).status).toBe(409);
  });

  it("reopen needs a reason of at least 3 characters and never reaches the service without one", async () => {
    for (const body of [{}, { reason: "" }, { reason: "ab" }, { reason: "   " }]) {
      const r = await reopen.POST(req("POST", body), ctx);
      expect(r.status).toBe(400);
    }
    expect(m.reopenSheet).not.toHaveBeenCalled();
    m.reopenSheet.mockResolvedValue({});
    expect((await reopen.POST(req("POST", { reason: "Scope changed" }), ctx)).status).toBe(200);
    expect(m.reopenSheet).toHaveBeenCalledWith("p1", { id: "u1", role: "ADMIN" }, "Scope changed");
  });

  it("a malformed JSON body is a 400, not a crash", async () => {
    const r = await reopen.POST(req("POST", "{not json"), ctx);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("Invalid JSON body");
  });

  it("restore needs a materialId", async () => {
    expect((await restore.POST(req("POST", {}), ctx)).status).toBe(400);
    expect(m.restoreMaterialLine).not.toHaveBeenCalled();
  });

  it("compare needs both snapshot ids", async () => {
    for (const url of ["http://localhost/api/x", "http://localhost/api/x?from=a", "http://localhost/api/x?to=b"]) {
      expect((await compare.GET(req("GET", undefined, url), ctx)).status).toBe(400);
    }
    expect(m.compareVersions).not.toHaveBeenCalled();
    m.compareVersions.mockResolvedValue({ deltas: [] });
    await compare.GET(req("GET", undefined, "http://localhost/api/x?from=a&to=b"), ctx);
    expect(m.compareVersions).toHaveBeenCalledWith("p1", "a", "b");
  });

  it("audit: take defaults to 100, is passed through, and is bounded", async () => {
    m.listAudit.mockResolvedValue([]);
    await auditRoute.GET(req("GET"), ctx);
    expect(m.listAudit).toHaveBeenLastCalledWith("p1", 100);
    await auditRoute.GET(req("GET", undefined, "http://localhost/api/x?take=20"), ctx);
    expect(m.listAudit).toHaveBeenLastCalledWith("p1", 20);
    for (const t of ["0", "501", "abc"]) expect((await auditRoute.GET(req("GET", undefined, `http://localhost/api/x?take=${t}`), ctx)).status).toBe(400);
  });

  it("versions are returned under a `versions` key, audit under `entries`", async () => {
    m.listVersions.mockResolvedValue([{ id: "s1" }]); m.listAudit.mockResolvedValue([{ id: "a1" }]);
    expect(await (await versions.GET(req("GET"), ctx)).json()).toEqual({ versions: [{ id: "s1" }] });
    expect(await (await auditRoute.GET(req("GET"), ctx)).json()).toEqual({ entries: [{ id: "a1" }] });
  });
});

describe("template routes", () => {
  it("create validates the shape of data for the chosen kind", async () => {
    const bad = [
      { kind: "OPERATION", name: "", data: validOpTemplate.data },
      { kind: "OPERATION", name: "X", data: { costType: "PERCENTAGE", unit: "%", rate: 5 } }, // percentage without a base
      { kind: "OPERATION", name: "X", data: { costType: "PER_KG", unit: "KG", rate: -1 } },
      { kind: "PROJECT_COST", name: "X", data: { method: "PERCENTAGE", unit: "%", rate: 2 } },
      { kind: "SUBCONTRACT", name: "X", data: { unit: "", quantity: 1, unitPrice: 1 } },
      { kind: "SUBCONTRACT", name: "X", data: { unit: "%", quantity: 1, unitPrice: 5000, costType: "PERCENTAGE", percentBase: "MATERIAL_COST" } },
      { kind: "NOPE", name: "X", data: {} },
      { name: "X", data: {} },
    ];
    for (const body of bad) expect((await templates.POST(req("POST", body))).status, JSON.stringify(body)).toBe(400);
    expect(m.createTemplate).not.toHaveBeenCalled();
  });

  it("create accepts a valid template of each kind and answers 201", async () => {
    m.createTemplate.mockResolvedValue({ id: "t1" });
    const good = [
      validOpTemplate,
      { kind: "PROJECT_COST", name: "NDT", data: { method: "PER_TEST", unit: "test", rate: 40 } },
      { kind: "SUBCONTRACT", name: "Blasting", data: { unit: "m²", quantity: 100, unitPrice: 3, company: "ACME" } },
    ];
    for (const body of good) expect((await templates.POST(req("POST", body))).status).toBe(201);
    expect(m.createTemplate).toHaveBeenCalledTimes(3);
    expect(m.createTemplate.mock.calls[0][1]).toBe("u1");
  });

  it("a duplicate name is a 409 from the service", async () => {
    m.createTemplate.mockRejectedValue(new m.EstimationError("A template with this name already exists for this type.", 409));
    expect((await templates.POST(req("POST", validOpTemplate))).status).toBe(409);
  });

  it("list filters by kind and rejects an unknown kind", async () => {
    m.listTemplates.mockResolvedValue([]);
    await templates.GET(req("GET", undefined, "http://localhost/api/x?kind=SUBCONTRACT"));
    expect(m.listTemplates).toHaveBeenLastCalledWith("SUBCONTRACT");
    await templates.GET(req("GET"));
    expect(m.listTemplates).toHaveBeenLastCalledWith(undefined);
    expect((await templates.GET(req("GET", undefined, "http://localhost/api/x?kind=BAD"))).status).toBe(400);
  });

  it("apply needs a templateId; itemId is optional and may be null", async () => {
    expect((await apply.POST(req("POST", {}), ctx)).status).toBe(400);
    m.applyTemplate.mockResolvedValue({});
    await apply.POST(req("POST", { templateId: "t1", itemId: null }), ctx);
    expect(m.applyTemplate).toHaveBeenLastCalledWith("p1", { templateId: "t1", itemId: null }, "u1");
  });

  it("apply on an approved sheet is refused by the service with its status", async () => {
    m.applyTemplate.mockRejectedValue(new m.EstimationError("This sheet is approved and locked. Reopen it to create a new version.", 409));
    expect((await apply.POST(req("POST", { templateId: "t1", itemId: "i1" }), ctx)).status).toBe(409);
  });

  it("update and delete pass the template id from the URL", async () => {
    m.updateTemplate.mockResolvedValue({}); m.deleteTemplate.mockResolvedValue(undefined);
    await templateById.PUT(req("PUT", validOpTemplate), tctx);
    expect(m.updateTemplate.mock.calls[0][0]).toBe("t1");
    expect(await (await templateById.DELETE(req("DELETE"), tctx)).json()).toEqual({ ok: true });
    expect(m.deleteTemplate).toHaveBeenCalledWith("t1", "u1");
  });
});

describe("snapshot route (what exactly was calculated / approved)", () => {
  it("passes the project id and the snapshot id from the URL to the service and returns the snapshot as is", async () => {
    const snap = { id: "s1", kind: "APPROVED", version: 2, verified: true, inputs: { materials: [] }, result: { totals: {} } };
    m.getSnapshot.mockResolvedValue(snap);
    const r = await snapshot.GET(req("GET"), sctx);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual(snap);
    expect(m.getSnapshot).toHaveBeenCalledWith("p1", "s1");
  });

  it("a snapshot of another project's sheet is a 404 from the service, passed through", async () => {
    m.getSnapshot.mockRejectedValue(new m.EstimationError("This version does not belong to this project's estimate", 404));
    const r = await snapshot.GET(req("GET"), sctx);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toContain("does not belong");
  });

  it("an empty snapshot id is a 400 and never reaches the service", async () => {
    const r = await snapshot.GET(req("GET"), { params: Promise.resolve({ id: "p1", snapshotId: "" }) });
    expect(r.status).toBe(400);
    expect(m.getSnapshot).not.toHaveBeenCalled();
  });

  it("is read-only: a viewer-level permission is enough, no edit or approve permission is asked", async () => {
    m.getSnapshot.mockResolvedValue({});
    await snapshot.GET(req("GET"), sctx);
    expect(m.asked).toEqual(["pricing.view"]);
  });
});

describe("offer route (built from the approved snapshot)", () => {
  const user = { id: "u1", name: "Tester" };
  it("asks for pricing.edit, needs quotations.edit too, and creates with the default when the body is empty", async () => {
    m.createOffer.mockResolvedValue({ quotationId: "q1" });
    const r = await offer.POST(req("POST"), ctx);
    expect(r.status).toBe(201);
    expect(m.asked).toEqual(["pricing.edit"]);
    expect(m.createOffer).toHaveBeenCalledWith("p1", user, {});
  });
  it("passes the chosen layout to the service", async () => {
    m.createOffer.mockResolvedValue({});
    await offer.POST(req("POST", { layout: "PER_ITEM" }), ctx);
    expect(m.createOffer).toHaveBeenCalledWith("p1", user, { layout: "PER_ITEM" });
  });
  it("an unknown layout or malformed JSON is a 400 and never reaches the service", async () => {
    expect((await offer.POST(req("POST", { layout: "WHATEVER" }), ctx)).status).toBe(400);
    const bad = await offer.POST(req("POST", "{nope"), ctx);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("Invalid JSON body");
    expect(m.createOffer).not.toHaveBeenCalled();
  });
  it("a role without quotations.edit gets 403 even with pricing.edit, and nothing runs", async () => {
    m.role = "VIEWER";
    expect((await offer.POST(req("POST"), ctx)).status).toBe(403);
    expect(m.createOffer).not.toHaveBeenCalled();
  });
  it("does nothing when the guard refuses", async () => {
    m.allow = false;
    expect((await offer.POST(req("POST"), ctx)).status).toBe(403);
    expect(m.createOffer).not.toHaveBeenCalled();
  });
  it("'no approved sheet' is a 409 from the service, passed through", async () => {
    m.createOffer.mockRejectedValue(new m.EstimationError("There is no approved pricing sheet yet.", 409));
    const r = await offer.POST(req("POST"), ctx);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("approved");
  });
});
