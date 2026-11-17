import { describe, expect, it } from "vitest";
import { writeMspXml } from "./msp-write";
import { mspToSchedule, isMspXml } from "./msp";
import type { ExportSchedule } from "./xer";

const base = { earlyStart: null, earlyFinish: null, lateStart: null, lateFinish: null, totalFloat: null, raw: null, actualStart: null, actualFinish: null, calendarId: null, constraintType: null, constraintDate: null, remainingDays: null, percentComplete: 0 };
const s: ExportSchedule = {
  name: "Test & <Plant>", code: "T", startDate: "2026-09-06", dataDate: "2026-09-06", finishDate: "2026-10-01",
  calendars: [{ id: "c1", p6Id: null, name: "Std", workDays: [true,true,true,true,true,false,false], holidays: ["2026-09-10","2026-09-11"], workExceptions: ["2026-09-12"], hoursPerDay: 8, isDefault: true }],
  wbs: [
    { id: "w1", p6Id: null, parentId: null, code: "ENG", name: "Engineering", sortOrder: 0 },
    { id: "w2", p6Id: null, parentId: "w1", code: "ENG.1", name: "Drawings", sortOrder: 1 },
  ],
  activities: [
    { ...base, id: "a1", p6Id: null, wbsId: "w2", code: "A100", name: "Draw", type: "TASK", durationDays: 5, earlyStart: "2026-09-06", earlyFinish: "2026-09-10", percentComplete: 40, actualStart: "2026-09-06", remainingDays: 3, constraintType: "SNET", constraintDate: "2026-09-06" },
    { ...base, id: "a2", p6Id: null, wbsId: "w1", code: "A200", name: "Approve", type: "TASK", durationDays: 2.5, earlyStart: "2026-09-13", earlyFinish: "2026-09-15" },
    { ...base, id: "a3", p6Id: null, wbsId: null, code: "M1", name: "Done", type: "MILESTONE_FINISH", durationDays: 0, earlyStart: "2026-09-15", earlyFinish: "2026-09-15" },
  ],
  relationships: [
    { predecessorId: "a1", successorId: "a2", type: "FS", lagDays: 2 },
    { predecessorId: "a2", successorId: "a3", type: "SS", lagDays: 0 },
  ],
};

describe("msp round trip", () => {
  it("writes and re-reads", () => {
    const xml = writeMspXml(s);
    expect(isMspXml(xml)).toBe(true);
    const r = mspToSchedule(xml);
    expect(r.name).toBe("Test & <Plant>");
    expect(r.wbs.map((w) => [w.code, w.parentP6Id ? "child" : "root"])).toEqual([["ENG", "root"], ["ENG.1", "child"]]);
    expect(r.activities).toHaveLength(3);
    const a = (c: string) => r.activities.find((x) => x.code === c)!;
    expect(a("A100").durationDays).toBe(5);
    expect(a("A100").percentComplete).toBe(40);
    expect(a("A100").remainingDays).toBe(3);
    expect(a("A100").actualStart).toBe("2026-09-06");
    expect(a("A100").constraintType).toBe("SNET");
    expect(a("A200").durationDays).toBe(2.5);
    expect(a("M1").type).toBe("MILESTONE_FINISH");
    expect(a("A100").wbsP6Id).toBe(r.wbs[1].p6Id);
    expect(a("A200").wbsP6Id).toBe(r.wbs[0].p6Id);
    expect(a("M1").wbsP6Id).toBeNull();
    expect(r.relationships.map((x) => [x.type, x.lagDays])).toEqual([["FS", 2], ["SS", 0]]);
    expect(r.calendars[0].holidays).toEqual(["2026-09-10", "2026-09-11"]);
    expect(r.calendars[0].workExceptions).toEqual(["2026-09-12"]);
    expect(r.calendars[0].workDays).toEqual(s.calendars[0].workDays);
    expect(r.warnings).toEqual([]);
  });
});
