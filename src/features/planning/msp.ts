// Microsoft Project XML (MSPDI) import.
//
// In Microsoft Project: File → Save As → choose "XML Format (*.xml)". The binary .mpp format is
// proprietary and is NOT read here; this reads the open XML export and maps it to the same
// ImportedSchedule model the Primavera XER importer produces, so everything after the import
// (merge, CPM, Gantt, export) is shared.
//
// Mapping: summary tasks → WBS elements, normal tasks → activities, milestones → finish milestones,
// predecessor links → relationships (FF/FS/SF/SS + lag), project calendars → calendars.
// Not carried: resources, assignments, costs, custom fields, baselines.

import { dayToIso, DEFAULT_WORK_DAYS, isoToDay } from "./calendar";
import type { ActivityType, RelType } from "./types";
import type { ImportedActivity, ImportedCalendar, ImportedRel, ImportedSchedule, ImportedWbs } from "./xer";

/** True when the text looks like a Microsoft Project XML (MSPDI) export. */
export function isMspXml(text: string): boolean {
  const head = text.slice(0, 4000);
  return /<Project[\s>]/.test(head) && /schemas\.microsoft\.com\/project/i.test(head);
}

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&");

/** Inner text of every <tag>…</tag> block (non-nested use only). */
function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
const strip = (xml: string, tag: string) => xml.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g"), "");
/** First direct text value of <tag>. */
function field(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml);
  return m ? decode(m[1].trim()) : "";
}
const num = (v: string, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const iso = (v: string) => { const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** ISO-8601 duration (`PT80H0M0S`, `P2DT4H`) → hours. */
function durationHours(v: string): number {
  const m = v.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) return 0;
  return num(m[1] ?? "0") * 24 + num(m[2] ?? "0") + num(m[3] ?? "0") / 60 + num(m[4] ?? "0") / 3600;
}

const REL: Record<string, RelType> = { "0": "FF", "1": "FS", "2": "SF", "3": "SS" };
// MSP constraint types: 4 SNET, 5 SNLT, 6 FNET, 7 FNLT (others are stored by nobody, ignored by CPM).
const CSTR: Record<string, string> = { "4": "SNET", "5": "SNLT", "6": "FNET", "7": "FNLT" };

function eachDay(from: string, to: string, cap = 400): string[] {
  const a = isoToDay(from), b = isoToDay(to);
  if (b < a) return [from];
  const out: string[] = [];
  for (let d = a; d <= b && out.length < cap; d++) out.push(dayToIso(d));
  return out;
}

export function mspToSchedule(text: string): ImportedSchedule {
  if (!isMspXml(text)) throw new Error("This does not look like a Microsoft Project XML file. In MS Project use File → Save As → XML Format.");
  const warnings: string[] = [];
  const projectXml = text;

  // Project-level fields live before <Calendars>/<Tasks>; strip the big sections first.
  const head = strip(strip(strip(projectXml, "Calendars"), "Tasks"), "Resources");
  const projName = field(head, "Title") || field(head, "Name") || "Imported schedule";
  const minutesPerDay = num(field(head, "MinutesPerDay"), 480);
  const projHours = minutesPerDay / 60 || 8;
  const defaultCalUid = field(head, "CalendarUID");

  // ---- calendars
  const calBlocks = blocks(blocks(projectXml, "Calendars")[0] ?? "", "Calendar");
  const raw = calBlocks.map((c) => {
    const noEx = strip(strip(c, "Exceptions"), "WorkWeeks");
    const weekDays = blocks(noEx, "WeekDay").map((w) => ({
      type: num(field(w, "DayType")), working: field(w, "DayWorking") === "1",
    })).filter((w) => w.type >= 1 && w.type <= 7);
    const holidays: string[] = [], extra: string[] = [];
    for (const ex of blocks(blocks(c, "Exceptions")[0] ?? "", "Exception")) {
      const from = iso(field(ex, "FromDate")), to = iso(field(ex, "ToDate"));
      if (!from) continue;
      const days = eachDay(from, to ?? from);
      (field(ex, "DayWorking") === "1" ? extra : holidays).push(...days);
    }
    return {
      uid: field(c, "UID"), name: field(c, "Name"), baseUid: field(c, "BaseCalendarUID"), isBase: field(c, "IsBaseCalendar") === "1",
      weekDays, holidays, extra,
    };
  });
  const rawByUid = new Map(raw.map((c) => [c.uid, c]));
  const resolveWeek = (c: (typeof raw)[number] | undefined, depth = 0): boolean[] => {
    if (!c || depth > 5) return DEFAULT_WORK_DAYS;
    if (c.weekDays.length === 0) return c.baseUid && c.baseUid !== "-1" ? resolveWeek(rawByUid.get(c.baseUid), depth + 1) : DEFAULT_WORK_DAYS;
    const w = [false, false, false, false, false, false, false]; // index 0 = Sunday, MSP DayType 1 = Sunday
    for (const d of c.weekDays) w[d.type - 1] = d.working;
    return w.some(Boolean) ? w : DEFAULT_WORK_DAYS;
  };
  const calendars: ImportedCalendar[] = raw.map((c) => ({
    p6Id: c.uid, name: c.name || `Calendar ${c.uid}`, workDays: resolveWeek(c),
    holidays: [...new Set(c.holidays)], workExceptions: [...new Set(c.extra)], hoursPerDay: projHours,
  }));
  const calIds = new Set(calendars.map((c) => c.p6Id));
  const defaultCalendarP6Id = defaultCalUid && calIds.has(defaultCalUid) ? defaultCalUid : calendars[0]?.p6Id ?? null;

  // ---- tasks
  const taskBlocks = blocks(blocks(projectXml, "Tasks")[0] ?? "", "Task");
  interface T { uid: string; level: number; summary: boolean; milestone: boolean; xml: string; links: string[]; idx: number }
  const tasks: T[] = [];
  taskBlocks.forEach((tb, idx) => {
    const links = blocks(tb, "PredecessorLink");
    const body = strip(strip(strip(strip(tb, "PredecessorLink"), "Baseline"), "ExtendedAttribute"), "TimephasedData");
    if (field(body, "IsNull") === "1") return;
    const uid = field(body, "UID");
    if (uid === "" || uid === "0") return; // UID 0 is the project summary row
    tasks.push({
      uid, level: num(field(body, "OutlineLevel"), 1), summary: field(body, "Summary") === "1",
      milestone: field(body, "Milestone") === "1", xml: body, links, idx,
    });
  });

  // Summary tasks become WBS elements; the nearest preceding summary with a lower level is the parent.
  const wbs: ImportedWbs[] = [];
  const parentOf = new Map<string, string | null>(); // task uid → containing summary uid
  const stack: { uid: string; level: number }[] = [];
  tasks.forEach((t) => {
    while (stack.length && stack[stack.length - 1].level >= t.level) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].uid : null;
    parentOf.set(t.uid, parent);
    if (t.summary) {
      wbs.push({
        p6Id: t.uid, parentP6Id: parent, code: field(t.xml, "WBS") || field(t.xml, "OutlineNumber") || t.uid,
        name: field(t.xml, "Name") || t.uid, sortOrder: wbs.length,
      });
      stack.push({ uid: t.uid, level: t.level });
    }
  });

  const calHours = (uid: string) => calendars.find((c) => c.p6Id === uid)?.hoursPerDay ?? projHours;
  const acts = tasks.filter((t) => !t.summary);
  let hasEffortDriven = 0;
  const activities: ImportedActivity[] = acts.map((t, i) => {
    const x = t.xml;
    const calUid = field(x, "CalendarUID");
    const calP6 = calUid && calIds.has(calUid) ? calUid : null;
    const hrs = calHours(calP6 ?? defaultCalendarP6Id ?? "");
    const isMile = t.milestone;
    const type: ActivityType = isMile ? "MILESTONE_FINISH" : "TASK";
    const durationDays = isMile ? 0 : durationHours(field(x, "Duration")) / hrs;
    const remText = field(x, "RemainingDuration");
    const remaining = remText ? durationHours(remText) / hrs : null;
    const pct = Math.max(0, Math.min(100, num(field(x, "PercentComplete"))));
    if (field(x, "EffortDriven") === "1") hasEffortDriven++;
    const cType = CSTR[field(x, "ConstraintType")] ?? null;
    return {
      p6Id: t.uid, wbsP6Id: parentOf.get(t.uid) ?? null, calendarP6Id: calP6,
      code: field(x, "WBS") || field(x, "OutlineNumber") || field(x, "ID") || t.uid,
      name: field(x, "Name") || t.uid, type,
      durationDays: round3(durationDays),
      remainingDays: remaining == null ? null : round3(remaining),
      percentComplete: pct,
      actualStart: iso(field(x, "ActualStart")),
      actualFinish: pct >= 100 || field(x, "ActualFinish") ? iso(field(x, "ActualFinish")) : null,
      plannedStart: iso(field(x, "Start")), plannedFinish: iso(field(x, "Finish")),
      constraintType: cType, constraintDate: cType ? iso(field(x, "ConstraintDate")) : null,
      sortOrder: i,
      raw: { uid: t.uid, id: field(x, "ID"), outline: field(x, "OutlineNumber"), notes: field(x, "Notes").slice(0, 500) },
    };
  });
  if (hasEffortDriven) warnings.push("Microsoft Project effort-driven scheduling and resources are not carried — durations are imported as fixed.");
  const taskIds = new Set(activities.map((a) => a.p6Id));
  const hoursOf = (uid: string) => calHours(activities.find((a) => a.p6Id === uid)?.calendarP6Id ?? defaultCalendarP6Id ?? "");

  // ---- relationships (LinkLag is in tenths of a minute)
  const relationships: ImportedRel[] = [];
  let skipped = 0;
  for (const t of acts) {
    for (const l of t.links) {
      const pred = field(l, "PredecessorUID");
      if (!taskIds.has(pred)) { skipped++; continue; }
      const lagMinutes = num(field(l, "LinkLag")) / 10;
      relationships.push({
        predP6Id: pred, succP6Id: t.uid, type: REL[field(l, "Type")] ?? "FS",
        lagDays: round3(lagMinutes / 60 / hoursOf(t.uid)),
      });
    }
  }
  if (skipped) warnings.push(`${skipped} links to summary rows or missing tasks were skipped.`);
  if (tasks.some((t) => t.summary && t.links.length)) warnings.push("Links on summary tasks were ignored — link the underlying tasks instead.");

  const starts = activities.map((a) => a.plannedStart).filter(Boolean) as string[];
  const code = projName.slice(0, 40);
  return {
    name: projName, code, p6ProjectId: "msp",
    startDate: iso(field(head, "StartDate")) ?? (starts.length ? [...starts].sort()[0] : null),
    dataDate: iso(field(head, "StatusDate")) ?? iso(field(head, "CurrentDate")),
    defaultCalendarP6Id, calendars, wbs, activities, relationships, warnings,
    projects: [{ id: "msp", name: projName, code }],
  };
}
