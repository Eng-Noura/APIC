import { describe, expect, it } from "vitest";
import { addPiece } from "./engine";

const base = { name: "A", profile: "IPE200", material: "S235", length: 3000, qty: 2 };

describe("addPiece — pieces that stand for a Part List part", () => {
  it("keeps the part id on the new piece", () => {
    const out = addPiece([], { ...base, partId: "p1" }, { id: 0, sn: 0 });
    expect(out[0].partId).toBe("p1");
  });

  it("two identical parts stay two rows (a merge would lose one link)", () => {
    const c = { id: 0, sn: 0 };
    let out = addPiece([], { ...base, partId: "p1" }, c);
    out = addPiece(out, { ...base, partId: "p2" }, c);
    expect(out.map((p) => [p.partId, p.qty])).toEqual([["p1", 2], ["p2", 2]]);
  });

  it("a manually added identical piece does not merge into a Part List piece", () => {
    const c = { id: 0, sn: 0 };
    let out = addPiece([], { ...base, partId: "p1" }, c);
    out = addPiece(out, base, c);
    expect(out).toHaveLength(2);
    expect(out[0].qty).toBe(2);
  });

  it("a Part List piece does not merge into an identical manual piece that is already there", () => {
    const c = { id: 0, sn: 0 };
    let out = addPiece([], base, c);
    out = addPiece(out, { ...base, partId: "p1" }, c);
    expect(out.map((p) => [p.partId, p.qty])).toEqual([[undefined, 2], ["p1", 2]]);
  });

  it("pieces without a part id still merge as before", () => {
    const c = { id: 0, sn: 0 };
    let out = addPiece([], base, c);
    out = addPiece(out, base, c);
    expect(out).toHaveLength(1);
    expect(out[0].qty).toBe(4);
    expect("partId" in out[0]).toBe(false);
  });
});
