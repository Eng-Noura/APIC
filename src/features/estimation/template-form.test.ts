import { describe, expect, it } from "vitest";
import { emptyTemplateForm, formFromTemplate, toTemplatePayload, validateTemplateForm } from "./template-form";
import { templateSchema } from "@/server/validators/estimation";

const f = (kind: "OPERATION" | "PROJECT_COST" | "SUBCONTRACT", over: Record<string, string> = {}) => ({ ...emptyTemplateForm(kind), ...over });

describe("validateTemplateForm", () => {
  it("name and rate are required; messages are per field", () => {
    const e = validateTemplateForm("OPERATION", f("OPERATION"));
    expect(e.name).toMatch(/required/); expect(e.rate).toBeDefined();
  });
  it("a valid operation has no errors", () => expect(validateTemplateForm("OPERATION", f("OPERATION", { name: "Welding", type: "PER_METER", unit: "M", rate: "12" }))).toEqual({}));
  it("a PERCENTAGE template needs its base, and a negative rate is refused", () => {
    const e = validateTemplateForm("OPERATION", f("OPERATION", { name: "Assembly", type: "PERCENTAGE", rate: "8" }));
    expect(e.percentBase).toMatch(/applies to/);
    expect(validateTemplateForm("OPERATION", f("OPERATION", { name: "X", rate: "-1" })).rate).toMatch(/0 or more/);
    expect(validateTemplateForm("OPERATION", f("OPERATION", { name: "X", type: "PERCENTAGE", percentBase: "ITEM_OPERATIONS", rate: "5000" })).rate).toMatch(/too large/);
  });
  it("a subcontract needs unit, quantity and price", () => {
    const e = validateTemplateForm("SUBCONTRACT", f("SUBCONTRACT", { name: "Blasting" }));
    expect(e.unit).toBeDefined(); expect(e.quantity).toBeDefined(); expect(e.rate).toBeDefined();
    expect(validateTemplateForm("SUBCONTRACT", f("SUBCONTRACT", { name: "Blasting", unit: "m²", quantity: "100", rate: "3" }))).toEqual({});
  });
  it("an unknown cost type is refused", () => expect(validateTemplateForm("PROJECT_COST", f("PROJECT_COST", { name: "X", type: "NOPE", rate: "1" })).type).toBeDefined());
});

describe("toTemplatePayload is accepted by the server's schema", () => {
  const cases: [string, ReturnType<typeof toTemplatePayload>][] = [
    ["operation", toTemplatePayload("OPERATION", f("OPERATION", { name: "Welding", type: "PER_METER", unit: "M", rate: "12" }))],
    ["percentage operation", toTemplatePayload("OPERATION", f("OPERATION", { name: "Assembly", type: "PERCENTAGE", unit: "%", rate: "8", percentBase: "ITEM_OPERATIONS" }))],
    ["project cost", toTemplatePayload("PROJECT_COST", f("PROJECT_COST", { name: "NDT", type: "PER_TEST", unit: "test", rate: "40", category: "Quality" }))],
    ["subcontract", toTemplatePayload("SUBCONTRACT", f("SUBCONTRACT", { name: "Blasting", unit: "m²", quantity: "100", rate: "3", company: "ACME" }))],
  ];
  it.each(cases)("%s", (_n, payload) => expect(templateSchema.safeParse(payload).success).toBe(true));
  it("blank optional fields are not invented: no quantity, no category, null notes", () => {
    const p = toTemplatePayload("PROJECT_COST", f("PROJECT_COST", { name: "NDT", rate: "0" }));
    expect(p.data).not.toHaveProperty("category");
    expect(p.data).toMatchObject({ quantity: null, notes: null });
  });
  it("the percentage base is dropped when the type is not PERCENTAGE", () => {
    expect(toTemplatePayload("OPERATION", f("OPERATION", { name: "W", type: "PER_KG", rate: "1", percentBase: "ITEM_OPERATIONS" })).data).toMatchObject({ percentBase: null });
  });
});

describe("formFromTemplate", () => {
  it("round-trips what the payload wrote", () => {
    const form = f("SUBCONTRACT", { name: "Blasting", unit: "m²", quantity: "100", rate: "3", company: "ACME", notes: "n" });
    const p = toTemplatePayload("SUBCONTRACT", form);
    expect(formFromTemplate("SUBCONTRACT", p.name, p.data)).toMatchObject({ name: "Blasting", unit: "m²", quantity: "100", rate: "3", company: "ACME", notes: "n", type: "PER_UNIT" });
  });
  it("stored JSON of the wrong shape becomes blanks, not a crash", () => {
    expect(formFromTemplate("OPERATION", "X", null)).toMatchObject({ name: "X", rate: "", unit: "" });
    expect(formFromTemplate("OPERATION", "X", { rate: "abc", unit: 5 })).toMatchObject({ rate: "", unit: "" });
  });
});
