// Who is working in a nest right now. Each open tab sends a heartbeat every ~10 s; a person counts as "here" while
// their last heartbeat is recent, and as "editing" while they changed something recently. Pure: no database.

export const HERE_MS = 30_000; // three missed heartbeats and the person is gone
export const EDITING_MS = 20_000; // changed something in the last 20 s

export interface PresenceRow { userId: string; name: string; lastSeenAt: Date | string; lastEditAt: Date | string | null }
export interface Other { userId: string; name: string; editing: boolean }

const ms = (d: Date | string) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** The other people in the nest: editing ones first, then by name. */
export function activeOthers(rows: PresenceRow[], meId: string, now = Date.now()): Other[] {
  return rows
    .filter((r) => r.userId !== meId && now - ms(r.lastSeenAt) <= HERE_MS)
    .map((r) => ({ userId: r.userId, name: r.name, editing: r.lastEditAt !== null && now - ms(r.lastEditAt) <= EDITING_MS }))
    .sort((a, b) => Number(b.editing) - Number(a.editing) || a.name.localeCompare(b.name));
}

/** "Ahmed is editing this nest now" / "Ahmed and Mona are here" — `null` when nobody else is. */
export function describePresence(others: Other[]): { text: string; editing: boolean } | null {
  if (!others.length) return null;
  const names = (list: Other[]) => (list.length <= 2 ? list.map((o) => o.name).join(" and ") : `${list[0].name}, ${list[1].name} and ${list.length - 2} more`);
  const editing = others.filter((o) => o.editing);
  if (editing.length) return { editing: true, text: `${names(editing)} ${editing.length === 1 ? "is" : "are"} editing this nest now` };
  return { editing: false, text: `${names(others)} ${others.length === 1 ? "has" : "have"} this nest open too` };
}
