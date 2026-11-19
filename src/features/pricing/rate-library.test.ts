import { describe, expect, it } from "vitest";
import { findConflicts, allowedChainKeys, checkComponent, isChainType, isLineType, newLineKey } from "./rate-library";

describe("rate library rules", () => {
  it("separates rate profiles from line-template profiles", () => {
    expect(isChainType("PROFIT")).toBe(true);
    expect(isLineType("PROFIT")).toBe(false);
    expect(isLineType("TRANSPORT")).toBe(true);
    expect(isChainType("MATERIAL") || isLineType("MATERIAL")).toBe(false);
  });
  it("profit profiles hold only markup multipliers", () => {
    const keys = allowedChainKeys("PROFIT").map((k) => k.key);
    expect(keys).toContain("markup.fabrication");
    expect(keys).not.toContain("sale.taxPct");
  });
  it("accepts valid and rejects invalid components", () => {
    expect(checkComponent("PROFIT", { key: "markup.fabrication", rate: 1.255 })).toEqual({ ok: true, kind: "chain" });
    expect(checkComponent("PROFIT", { key: "markup.fabrication", rate: 0 }).ok).toBe(false);
    expect(checkComponent("TAX_INSURANCE", { key: "sale.insuranceDivisor", rate: 0 }).ok).toBe(false);
    expect(checkComponent("TAX_INSURANCE", { key: "markup.material", rate: 1.2 }).ok).toBe(false);
    expect(checkComponent("INDIRECT", { key: "installation.indirectPct", rate: -0.1 }).ok).toBe(false);
    expect(checkComponent("INSTALLATION", { key: newLineKey(), category: "INSTALLATION", rate: 5200 })).toEqual({ ok: true, kind: "line" });
    expect(checkComponent("INSTALLATION", { key: newLineKey(), category: "ADD_ON", rate: 1 }).ok).toBe(false);
    expect(checkComponent("PROFIT", { key: newLineKey(), category: "ADD_ON", rate: 1 }).ok).toBe(false);
  });
  it("generates distinct line keys", () => {
    expect(newLineKey()).not.toBe(newLineKey());
  });
  it("flags two active profiles of one scope that set the same rate", () => {
    const mk = (id: string, name: string, active = true, enabled = true) => ({ id, name, scope: "GLOBAL", active, components: [{ key: "markup.material", enabled }] });
    expect(findConflicts([mk("a", "A"), mk("b", "B")])).toEqual([{ scope: "GLOBAL", key: "markup.material", profiles: ["A", "B"] }]);
    expect(findConflicts([mk("a", "A"), mk("b", "B", false)])).toEqual([]);
    expect(findConflicts([mk("a", "A"), mk("b", "B", true, false)])).toEqual([]);
  });
});
