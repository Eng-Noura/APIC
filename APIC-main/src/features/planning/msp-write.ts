// Microsoft Project XML (MSPDI) export — the counterpart of msp.ts (import).
//
// Open the result in Microsoft Project with File → Open (choose "XML Format").
// Mapping: WBS elements → summary tasks, activities → tasks, finish/start milestones → milestones,
// relationships → predecessor links, calendars → base calendars.
// Not written: resources, assignments, costs, baselines.
//
// Durations are written in project hours (MinutesPerDay of the default calendar), which is how
// Microsoft Project itself converts "days"; msp.ts reads them back the same way, so an
// export → import round trip keeps durations and lags unchanged.

import { dayToIso, DEFAULT_WORK_DAYS, isoToDay } from "./calendar";
import type { RelType } from "./types";
import type { ExportSchedule } from "./xer";

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TYPE: Record<RelType, number> = { FF: 0, FS: 1, SF: 2, SS: 3 };
const CSTR: Record<string, number> = { SNET: 4, SNLT: 5, FNET: 6, FNLT: 7 };

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;

/** ISO-8601 duration from a number of hours (`PT8H0M0S`). */
function dur(hours: number): string {
  const total = Math.max(0, Math.round(hours * 60));
  return `PT${Math.floor(total / 60)}H${total % 60}M0S`;
}

/** Working periods of one day: starts 08:00, one hour break after the first four hours. */
function workingTimes(hours: number): { from: string; to: string }[] {
  const mins = Math.max(60, Math.round(hours * 60));
  const start = 8 * 60;
  if (mins <= 240) return [{ from: hm(start), to: hm(start + mins) }];
  return [
    { from: hm(start), to: hm(start + 240) },
    { from: hm(start + 300), to: hm(start + 300 + (mins - 240)) },
  ];
}
const dayEndMinutes = (hours: number) => {
  const mins = Math.max(60, Math.round(hours * 60));
  return mins <= 240 ? 8 * 60 + mins : 8 * 60 + 300 + (mins - 240);
};

/** Collapse a list of ISO dates into consecutive runs. */
function runs(dates: string[]): { from: string; to: string }[] {
  const days = [...new Set(dates.map(isoToDay))].sort((a, b) => a - b);
  const out: { from: string; to: string }[] = [];
  for (const d of days) {
    const last = out[out.length - 1];
    if (last && isoToDay(last.to) === d - 1) last.to = dayToIso(d);
    else out.push({ from: dayToIso(d), to: dayToIso(d) });
  }
  return out;
}

/** Keep numeric ids that came from an earlier import; hand out fresh ones otherwise. `used` is shared so ids never collide. */
function assign<T extends { id: string; p6Id: string | null }>(items: T[], used: Set<string>, firstFree: number): Map<string, string> {
  const map = new Map<string, string>();
  for (const it of items) {
    if (it.p6Id && /^[1-9]\d*$/.test(it.p6Id) && !used.has(it.p6Id)) { map.set(it.id, it.p6Id); used.add(it.p6Id); }
  }
  let next = firstFree;
  for (const it of items) {
    if (map.has(it.id)) continue;
    while (used.has(String(next))) next++;
    map.set(it.id, String(next)); used.add(String(next));
  }
  return map;
}

export function writeMspXml(s: ExportSchedule): string {
  const calendars = s.calendars.length
    ? s.calendars
    : [{ id: "__std", p6Id: null, name: "Standard", workDays: DEFAULT_WORK_DAYS, holidays: [], workExceptions: [], hoursPerDay: 8, isDefault: true }];
  const defCal = calendars.find((c) => c.isDefault) ?? calendars[0];
  const projHours = defCal.hoursPerDay > 0 ? defCal.hoursPerDay : 8;
  const minutesPerDay = Math.round(projHours * 60);
  const daysPerWeek = defCal.workDays.filter(Boolean).length || 5;

  const calUid = assign(calendars, new Set<string>(), 1);
  const taskUsed = new Set<string>(["0"]); // UID 0 is the project summary row
  const wbsUid = assign(s.wbs, taskUsed, 1);
  const actUid = assign(s.activities, taskUsed, 1);

  const x: string[] = [];
  const w = (line: string) => x.push(line);

  w(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`);
  w(`<Project xmlns="http://schemas.microsoft.com/project">`);
  w(`<SaveVersion>14</SaveVersion>`);
  w(`<Name>${esc(s.name)}.xml</Name>`);
  w(`<Title>${esc(s.name)}</Title>`);
  w(`<ScheduleFromStart>1</ScheduleFromStart>`);
  w(`<StartDate>${s.startDate}T08:00:00</StartDate>`);
  w(`<FinishDate>${(s.finishDate ?? s.startDate)}T${hm(dayEndMinutes(projHours))}</FinishDate>`);
  w(`<CalendarUID>${calUid.get(defCal.id)}</CalendarUID>`);
  w(`<MinutesPerDay>${minutesPerDay}</MinutesPerDay>`);
  w(`<MinutesPerWeek>${minutesPerDay * daysPerWeek}</MinutesPerWeek>`);
  w(`<DaysPerMonth>20</DaysPerMonth>`);
  w(`<StatusDate>${s.dataDate}T08:00:00</StatusDate>`);
  w(`<CurrentDate>${s.dataDate}T08:00:00</CurrentDate>`);

  // ---- calendars (all written as base calendars so tasks can point at any of them)
  w(`<Calendars>`);
  for (const c of calendars) {
    const times = workingTimes(c.hoursPerDay > 0 ? c.hoursPerDay : projHours);
    const wt = times.map((t) => `<WorkingTime><FromTime>${t.from}</FromTime><ToTime>${t.to}</ToTime></WorkingTime>`).join("");
    w(`<Calendar><UID>${calUid.get(c.id)}</UID><Name>${esc(c.name)}</Name><IsBaseCalendar>1</IsBaseCalendar><WeekDays>`);
    for (let t = 1; t <= 7; t++) { // DayType 1 = Sunday
      const working = !!c.workDays[t - 1];
      w(`<WeekDay><DayType>${t}</DayType><DayWorking>${working ? 1 : 0}</DayWorking>${working ? `<WorkingTimes>${wt}</WorkingTimes>` : ""}</WeekDay>`);
    }
    w(`</WeekDays>`);
    const ex: string[] = [];
    for (const r of runs(c.holidays)) {
      ex.push(`<Exception><EnteredByOccurrences>0</EnteredByOccurrences><TimePeriod><FromDate>${r.from}T00:00:00</FromDate><ToDate>${r.to}T23:59:00</ToDate></TimePeriod><Name>Holiday</Name><DayWorking>0</DayWorking></Exception>`);
    }
    for (const r of runs(c.workExceptions)) {
      ex.push(`<Exception><EnteredByOccurrences>0</EnteredByOccurrences><TimePeriod><FromDate>${r.from}T00:00:00</FromDate><ToDate>${r.to}T23:59:00</ToDate></TimePeriod><Name>Working day</Name><DayWorking>1</DayWorking><WorkingTimes>${wt}</WorkingTimes></Exception>`);
    }
    if (ex.length) w(`<Exceptions>${ex.join("")}</Exceptions>`);
    w(`</Calendar>`);
  }
  w(`</Calendars>`);

  // ---- tasks, in outline order: project summary, then each WBS element followed by its activities
  const actsByWbs = new Map<string | null, typeof s.activities>();
  for (const a of s.activities) {
    const k = a.wbsId && s.wbs.some((b) => b.id === a.wbsId) ? a.wbsId : null;
    (actsByWbs.get(k) ?? actsByWbs.set(k, []).get(k)!).push(a);
  }
  const kids = new Map<string | null, typeof s.wbs>();
  for (const b of s.wbs) {
    const k = b.parentId && s.wbs.some((p) => p.id === b.parentId) ? b.parentId : null;
    (kids.get(k) ?? kids.set(k, []).get(k)!).push(b);
  }
  for (const list of kids.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);

  const actById = new Map(s.activities.map((a) => [a.id, a]));
  const hoursOfCal = (id: string | null) => {
    const c = calendars.find((k) => k.id === id) ?? defCal;
    return c.hoursPerDay > 0 ? c.hoursPerDay : projHours;
  };
  const startOf = (a: (typeof s.activities)[number]) => a.actualStart ?? a.earlyStart ?? s.startDate;
  const finishOf = (a: (typeof s.activities)[number]) => a.actualFinish ?? a.earlyFinish ?? startOf(a);

  const preds = new Map<string, typeof s.relationships>();
  for (const r of s.relationships) (preds.get(r.successorId) ?? preds.set(r.successorId, []).get(r.successorId)!).push(r);

  let rowId = 0;
  const taskXml: string[] = [];

  taskXml.push(
    `<Task><UID>0</UID><ID>0</ID><Name>${esc(s.name)}</Name><Type>1</Type><OutlineNumber>0</OutlineNumber><OutlineLevel>0</OutlineLevel>` +
    `<Start>${s.startDate}T08:00:00</Start><Finish>${(s.finishDate ?? s.startDate)}T${hm(dayEndMinutes(projHours))}</Finish>` +
    `<Duration>${dur(0)}</Duration><Summary>1</Summary></Task>`,
  );

  function emitActivity(a: (typeof s.activities)[number], level: number, outline: string) {
    const isMile = a.type === "MILESTONE_FINISH" || a.type === "MILESTONE_START";
    const st = isMile && a.type === "MILESTONE_FINISH" ? finishOf(a) : startOf(a);
    const fin = isMile ? st : finishOf(a);
    const endMin = dayEndMinutes(projHours);
    const startT = isMile && a.type === "MILESTONE_FINISH" ? hm(endMin) : "08:00:00";
    const finT = isMile ? startT : hm(endMin);
    const pct = Math.round(Math.max(0, Math.min(100, a.percentComplete)));
    const cType = a.constraintType && CSTR[a.constraintType] != null && a.constraintDate ? CSTR[a.constraintType] : null;
    let t = `<Task><UID>${actUid.get(a.id)}</UID><ID>${++rowId}</ID><Name>${esc(a.name)}</Name><Type>0</Type>`;
    t += `<WBS>${esc(a.code)}</WBS><OutlineNumber>${outline}</OutlineNumber><OutlineLevel>${level}</OutlineLevel>`;
    t += `<Start>${st}T${startT}</Start><Finish>${fin}T${finT}</Finish>`;
    t += `<Duration>${dur(isMile ? 0 : a.durationDays * projHours)}</Duration>`;
    t += `<Milestone>${isMile ? 1 : 0}</Milestone><Summary>0</Summary>`;
    t += `<PercentComplete>${pct}</PercentComplete>`;
    if (a.actualStart) t += `<ActualStart>${a.actualStart}T08:00:00</ActualStart>`;
    if (a.actualFinish) t += `<ActualFinish>${a.actualFinish}T${hm(endMin)}</ActualFinish>`;
    if (a.remainingDays != null && !isMile) t += `<RemainingDuration>${dur(a.remainingDays * projHours)}</RemainingDuration>`;
    t += `<ConstraintType>${cType ?? 0}</ConstraintType>`;
    if (a.calendarId && calUid.has(a.calendarId)) t += `<CalendarUID>${calUid.get(a.calendarId)}</CalendarUID>`;
    if (cType != null) t += `<ConstraintDate>${a.constraintDate}T08:00:00</ConstraintDate>`;
    const notes = a.raw?.notes;
    if (notes) t += `<Notes>${esc(notes)}</Notes>`;
    for (const r of preds.get(a.id) ?? []) {
      const pu = actUid.get(r.predecessorId);
      if (!pu || !actById.has(r.predecessorId)) continue;
      // LinkLag is in tenths of a minute
      const lag = Math.round(r.lagDays * hoursOfCal(a.calendarId) * 60 * 10);
      t += `<PredecessorLink><PredecessorUID>${pu}</PredecessorUID><Type>${TYPE[r.type] ?? 1}</Type><CrossProject>0</CrossProject><LinkLag>${lag}</LinkLag><LagFormat>7</LagFormat></PredecessorLink>`;
    }
    t += `</Task>`;
    taskXml.push(t);
  }

  function emitWbs(b: (typeof s.wbs)[number], level: number, outline: string) {
    const acts = actsByWbs.get(b.id) ?? [];
    const subs = kids.get(b.id) ?? [];
    const dates = acts.flatMap((a) => [startOf(a), finishOf(a)]).sort();
    const st = dates[0] ?? s.startDate, fin = dates[dates.length - 1] ?? st;
    taskXml.push(
      `<Task><UID>${wbsUid.get(b.id)}</UID><ID>${++rowId}</ID><Name>${esc(b.name)}</Name><Type>0</Type><WBS>${esc(b.code)}</WBS>` +
      `<OutlineNumber>${outline}</OutlineNumber><OutlineLevel>${level}</OutlineLevel>` +
      `<Start>${st}T08:00:00</Start><Finish>${fin}T${hm(dayEndMinutes(projHours))}</Finish><Duration>${dur(0)}</Duration><Summary>1</Summary></Task>`,
    );
    let n = 0;
    for (const a of acts) emitActivity(a, level + 1, `${outline}.${++n}`);
    for (const sub of subs) emitWbs(sub, level + 1, `${outline}.${++n}`);
  }

  let top = 0;
  for (const b of kids.get(null) ?? []) emitWbs(b, 1, String(++top));
  for (const a of actsByWbs.get(null) ?? []) emitActivity(a, 1, String(++top));

  w(`<Tasks>`);
  for (const t of taskXml) w(t);
  w(`</Tasks>`);
  w(`</Project>`);
  return x.join("\n");
}
