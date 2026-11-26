import { describe, expect, it } from "vitest";
import { activeOthers, describePresence, EDITING_MS, HERE_MS } from "./nest-presence";

const NOW = 1_000_000_000_000;
const row = (userId: string, name: string, seenAgo: number, editAgo: number | null) => ({
  userId, name, lastSeenAt: new Date(NOW - seenAgo), lastEditAt: editAgo === null ? null : new Date(NOW - editAgo),
});

describe("activeOthers", () => {
  it("leaves out me and the people who stopped sending heartbeats", () => {
    const o = activeOthers([row("me", "Me", 1000, null), row("a", "Ahmed", 5000, null), row("b", "Mona", HERE_MS + 1, null)], "me", NOW);
    expect(o.map((x) => x.name)).toEqual(["Ahmed"]);
  });
  it("editing = changed something recently; the editing ones come first", () => {
    const o = activeOthers([row("a", "Ahmed", 2000, null), row("b", "Mona", 2000, 3000), row("c", "Omar", 2000, EDITING_MS + 1)], "me", NOW);
    expect(o).toEqual([
      { userId: "b", name: "Mona", editing: true },
      { userId: "a", name: "Ahmed", editing: false },
      { userId: "c", name: "Omar", editing: false },
    ]);
  });
});

describe("describePresence", () => {
  it("nobody else = nothing to say", () => {
    expect(describePresence([])).toBeNull();
  });
  it("says who is editing, and that it can clash", () => {
    expect(describePresence([{ userId: "a", name: "Ahmed", editing: true }])).toEqual({ editing: true, text: "Ahmed is editing this nest now" });
    expect(describePresence([{ userId: "a", name: "Ahmed", editing: true }, { userId: "b", name: "Mona", editing: true }])?.text).toBe("Ahmed and Mona are editing this nest now");
  });
  it("viewers are only mentioned when nobody is editing; long lists are shortened", () => {
    expect(describePresence([{ userId: "a", name: "Ahmed", editing: false }])).toEqual({ editing: false, text: "Ahmed has this nest open too" });
    const many = ["A", "B", "C", "D"].map((n) => ({ userId: n, name: n, editing: false }));
    expect(describePresence(many)?.text).toBe("A, B and 2 more have this nest open too");
  });
});
