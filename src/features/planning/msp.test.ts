import { describe, expect, it } from "vitest";
import { isMspXml, mspToSchedule } from "./msp";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
<Name>Riser.xml</Name><Title>Riser Duct</Title><StartDate>2026-11-01T08:00:00</StartDate><StatusDate>2026-11-11T08:00:00</StatusDate>
<MinutesPerDay>480</MinutesPerDay><CalendarUID>1</CalendarUID>
<Calendars><Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID>
<WeekDays>
<WeekDay><DayType>1</DayType><DayWorking>1</DayWorking></WeekDay>
<WeekDay><DayType>2</DayType><DayWorking>1</DayWorking></WeekDay>
<WeekDay><DayType>3</DayType><DayWorking>1</DayWorking></WeekDay>
<WeekDay><DayType>4</DayType><DayWorking>1</DayWorking></WeekDay>
<WeekDay><DayType>5</DayType><DayWorking>1</DayWorking></WeekDay>
<WeekDay><DayType>6</DayType><DayWorking>0</DayWorking></WeekDay>
<WeekDay><DayType>7</DayType><DayWorking>0</DayWorking></WeekDay>
</WeekDays>
<Exceptions><Exception><TimePeriod><FromDate>2026-12-25T00:00:00</FromDate><ToDate>2026-12-26T23:59:00</ToDate></TimePeriod><DayWorking>0</DayWorking></Exception></Exceptions>
</Calendar></Calendars>
<Tasks>
<Task><UID>0</UID><ID>0</ID><Name>Riser Duct</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
<Task><UID>1</UID><ID>1</ID><Name>Engineering &amp; Design</Name><OutlineNumber>1</OutlineNumber><OutlineLevel>1</OutlineLevel><Summary>1</Summary></Task>
<Task><UID>2</UID><ID>2</ID><Name>Drawings</Name><OutlineNumber>1.1</OutlineNumber><OutlineLevel>2</OutlineLevel><Duration>PT160H0M0S</Duration><RemainingDuration>PT0H0M0S</RemainingDuration><PercentComplete>100</PercentComplete><Start>2026-11-01T08:00:00</Start><Finish>2026-11-26T17:00:00</Finish><ActualStart>2026-11-01T08:00:00</ActualStart><ActualFinish>2026-11-26T17:00:00</ActualFinish>
<Baseline><Number>0</Number><Start>2026-01-01T08:00:00</Start></Baseline></Task>
<Task><UID>3</UID><ID>3</ID><Name>Fabrication</Name><OutlineNumber>1.2</OutlineNumber><OutlineLevel>2</OutlineLevel><Duration>PT560H0M0S</Duration><RemainingDuration>PT560H0M0S</RemainingDuration><PercentComplete>0</PercentComplete><Start>2026-12-14T08:00:00</Start><Finish>2027-02-26T17:00:00</Finish><ConstraintType>4</ConstraintType><ConstraintDate>2026-12-14T08:00:00</ConstraintDate>
<PredecessorLink><PredecessorUID>2</PredecessorUID><Type>3</Type><LinkLag>4800</LinkLag></PredecessorLink></Task>
<Task><UID>4</UID><ID>4</ID><Name>Done</Name><OutlineNumber>1.3</OutlineNumber><OutlineLevel>2</OutlineLevel><Milestone>1</Milestone><Duration>PT0H0M0S</Duration>
<PredecessorLink><PredecessorUID>3</PredecessorUID><Type>1</Type><LinkLag>0</LinkLag></PredecessorLink></Task>
</Tasks></Project>`;

describe("MS Project XML import", () => {
  const s = mspToSchedule(SAMPLE);
  it("detects the format", () => { expect(isMspXml(SAMPLE)).toBe(true); expect(isMspXml("ERMHDR\t19")).toBe(false); });
  it("maps project, calendar and WBS", () => {
    expect(s.name).toBe("Riser Duct");
    expect(s.startDate).toBe("2026-11-01");
    expect(s.calendars[0].workDays).toEqual([true, true, true, true, true, false, false]);
    expect(s.calendars[0].holidays).toEqual(["2026-12-25", "2026-12-26"]);
    expect(s.wbs).toHaveLength(1);
    expect(s.wbs[0].name).toBe("Engineering & Design");
  });
  it("maps activities and skips the project summary row", () => {
    expect(s.activities.map((a) => a.p6Id)).toEqual(["2", "3", "4"]);
    const [a, b, m] = s.activities;
    expect(a.durationDays).toBe(20); expect(a.percentComplete).toBe(100); expect(a.wbsP6Id).toBe("1");
    expect(a.plannedStart).toBe("2026-11-01"); // baseline start must not leak in
    expect(b.constraintType).toBe("SNET");
    expect(m.type).toBe("MILESTONE_FINISH"); expect(m.durationDays).toBe(0);
  });
  it("maps links with type and lag", () => {
    expect(s.relationships).toEqual([
      { predP6Id: "2", succP6Id: "3", type: "SS", lagDays: 1 },
      { predP6Id: "3", succP6Id: "4", type: "FS", lagDays: 0 },
    ]);
  });
  it("rejects other files", () => { expect(() => mspToSchedule("hello")).toThrow(); });
});
