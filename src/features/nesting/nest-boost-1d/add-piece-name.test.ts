import { describe, it, expect } from "vitest";
import { addPiece } from "./engine";

const base = { profile: "IPE200", material: "S235", length: 3000, qty: 2 };
const counters = () => ({ id: 1, sn: 0 });

describe("addPiece — pieces with different names are never merged", () => {
  it("same name + same profile/material/length -> one row, quantity added", () => {
    const c = counters();
    let p = addPiece([], { ...base, name: "Beam A" }, c);
    p = addPiece(p, { ...base, name: "beam  a", qty: 3 }, c); // case / spacing do not matter
    expect(p).toHaveLength(1);
    expect(p[0].qty).toBe(5);
  });

  it("different name, everything else identical -> a row of its own", () => {
    const c = counters();
    let p = addPiece([], { ...base, name: "Beam A" }, c);
    p = addPiece(p, { ...base, name: "Beam B" }, c);
    expect(p).toHaveLength(2);
    expect(p.map((x) => x.qty)).toEqual([2, 2]);
  });

  it("a piece entered without a name still merges into a matching one", () => {
    const c = counters();
    let p = addPiece([], { ...base, name: "Beam A" }, c);
    p = addPiece(p, { ...base, name: "", qty: 4 }, c);
    expect(p).toHaveLength(1);
    expect(p[0].qty).toBe(6);
  });
});
