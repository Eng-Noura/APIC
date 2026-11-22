import { describe, expect, it } from "vitest";
import {
  buildPartFromPiece, isFromPartList, knownWeightPerMeter, labelSet, parseNestPieces, parsePipeProfile, partListLabel, pieceDescription,
  type NestPiece,
} from "./nest-1d-parts";

const piece = (over: Partial<NestPiece> = {}): NestPiece => ({
  id: 1, name: "Beam", profile: "IPE200", material: "S235", lengthMm: 3000, qty: 4, partType: "HOT_ROLLED", partId: null, ...over,
});

describe("parseNestPieces", () => {
  const snapshot = {
    v: 1,
    pieces: [
      { id: 1, sn: 1, name: " Beam ", profile: "IPE200", material: "S235", length: 3000, qty: 4 },
      { id: 2, sn: 2, name: "Tube", profile: "PIPE OD60.3x3.2", material: "", length: 1500, qty: 2, partType: "PIPE" },
      { id: 3, sn: 3, name: "Strip", profile: "", material: "", length: 800, qty: 1, partType: "PLATE" },
      { id: 4, sn: 4, name: "Zero", profile: "FB50x10", material: "", length: 500, qty: 0 },
      { id: 5, sn: 5, name: "Seg", profile: "IPE200", material: "", length: 6000, qty: 1, segment: { index: 1, total: 2, parentId: 1, parentLength: 12000 } },
      { id: 6, sn: 6, name: "From list", profile: "FB50x10", material: "", length: 500, qty: 2, partId: "cuid-1" },
      { name: "no id", qty: 1 },
      null,
    ],
  };
  const out = parseNestPieces(snapshot);

  it("keeps real pieces, trims text, and defaults the type to hot rolled", () => {
    expect(out.map((p) => p.id)).toEqual([1, 2, 3, 6]);
    expect(out[0]).toMatchObject({ name: "Beam", partType: "HOT_ROLLED", lengthMm: 3000, qty: 4, partId: null });
    expect(out[1].partType).toBe("PIPE");
    expect(out[2].partType).toBe("PLATE");
  });
  it("skips qty 0, segments and rows without an id", () => {
    expect(out.some((p) => p.id === 4 || p.id === 5)).toBe(false);
  });
  it("remembers which Part List part a piece came from", () => {
    expect(out[3].partId).toBe("cuid-1");
  });
  it("anything that is not a snapshot gives no pieces", () => {
    expect(parseNestPieces(null)).toEqual([]);
    expect(parseNestPieces({ pieces: "x" })).toEqual([]);
    expect(parseNestPieces({ groups: [] })).toEqual([]);
  });
});

describe("parsePipeProfile", () => {
  it("reads outer diameter and wall", () => {
    expect(parsePipeProfile("PIPE OD60.3x3.2")).toEqual({ odMm: 60.3, thicknessMm: 3.2 });
    expect(parsePipeProfile("pipe od 114.3 × 6")).toEqual({ odMm: 114.3, thicknessMm: 6 });
  });
  it("returns null when the size is not readable", () => {
    expect(parsePipeProfile("PIPE")).toBeNull();
    expect(parsePipeProfile('PIPE 2" SCH40')).toBeNull();
    expect(parsePipeProfile("PIPE OD60.3")).toBeNull();
    expect(parsePipeProfile("PIPE OD0x3")).toBeNull();
  });
});

describe("buildPartFromPiece", () => {
  it("hot rolled with a profile of the weight table: length in metres, weight per metre from the table", () => {
    const r = buildPartFromPiece(piece());
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) throw new Error();
    expect(r.draft).toMatchObject({ partType: "HOT_ROLLED", qty: 4, thicknessMm: null, material: "S235", description: "Beam L=3000" });
    expect(r.draft.geometry).toEqual({ profile: "IPE200", length: 3, weightPerMeter: 22.4 });
  });

  it("flat bar weight is computed from its size (w × t × 0.00785)", () => {
    const r = buildPartFromPiece(piece({ profile: "FB60x6", lengthMm: 1200 }));
    if (!r.ok) throw new Error();
    expect(r.draft.geometry).toMatchObject({ length: 1.2, weightPerMeter: 2.826 });
  });

  it("an unknown profile is NOT given a made-up weight", () => {
    const r = buildPartFromPiece(piece({ profile: "HEB200" }));
    expect(r).toEqual({ ok: false, reason: "weight per metre of profile HEB200 is not known" });
  });

  it("…but takes the weight the person types", () => {
    const r = buildPartFromPiece(piece({ profile: "HEB200" }), { weightPerMeter: 61.3 });
    if (!r.ok) throw new Error();
    expect(r.draft.geometry).toMatchObject({ profile: "HEB200", weightPerMeter: 61.3 });
  });

  it("a typed weight wins over the table", () => {
    const r = buildPartFromPiece(piece(), { weightPerMeter: 25 });
    if (!r.ok) throw new Error();
    expect(r.draft.geometry).toMatchObject({ weightPerMeter: 25 });
  });

  it("a piece without a profile or without a length is refused with the reason", () => {
    expect(buildPartFromPiece(piece({ profile: "" }))).toEqual({ ok: false, reason: "no profile" });
    expect(buildPartFromPiece(piece({ lengthMm: 0 }))).toEqual({ ok: false, reason: "no cut length yet" });
  });

  it("pipe: outer diameter in metres, wall in mm, read from the profile name", () => {
    const r = buildPartFromPiece(piece({ name: "Tube", profile: "PIPE OD60.3x3.2", partType: "PIPE", lengthMm: 1500 }));
    if (!r.ok) throw new Error();
    expect(r.draft).toMatchObject({ partType: "PIPE", thicknessMm: 3.2, geometry: { od: 0.0603, length: 1.5 } });
  });

  it("pipe with an unreadable name is refused — unless the person types the size", () => {
    const p = piece({ profile: "PIPE", partType: "PIPE" });
    const bad = buildPartFromPiece(p);
    expect(bad.ok).toBe(false);
    if (bad.ok) throw new Error();
    expect(bad.reason).toContain("PIPE OD60.3x3.2");
    const typed = buildPartFromPiece(p, { odMm: 88.9, thicknessMm: 4 });
    if (!typed.ok) throw new Error();
    expect(typed.draft).toMatchObject({ thicknessMm: 4, geometry: { od: 0.0889 } });
  });

  it("plates are left to the 2D nest", () => {
    const r = buildPartFromPiece(piece({ partType: "PLATE" }));
    expect(r.ok).toBe(false);
  });

  it("the material falls back to Steel, like the 2D import", () => {
    const r = buildPartFromPiece(piece({ material: "" }));
    if (!r.ok) throw new Error();
    expect(r.draft.material).toBe("Steel");
  });

  it("the result passes the Part List validation (what the server does with it)", async () => {
    const { takeoffPartSchema } = await import("@/server/validators/takeoff");
    for (const p of [piece(), piece({ profile: "PIPE OD60.3x3.2", partType: "PIPE" })]) {
      const r = buildPartFromPiece(p);
      if (!r.ok) throw new Error();
      const parsed = takeoffPartSchema.safeParse({ ...r.draft, drawingId: "d", itemNo: 1, side: "EXTERNAL", paintSides: 2 });
      expect(parsed.success).toBe(true);
    }
  });
});

describe("pieceDescription", () => {
  it("keeps a real name and adds the length", () => {
    expect(pieceDescription(piece())).toBe("Beam L=3000");
  });
  it("does not add the length twice", () => {
    expect(pieceDescription(piece({ name: "Beam 3000" }))).toBe("Beam 3000");
    expect(pieceDescription(piece({ name: "Beam L=3000mm" }))).toBe("Beam L=3000mm");
  });
  it("a generic name becomes the profile", () => {
    expect(pieceDescription(piece({ name: "Part #3" }))).toBe("IPE200 L=3000");
    expect(pieceDescription(piece({ name: "" }))).toBe("IPE200 L=3000");
  });
  it("drops a .dxf extension", () => {
    expect(pieceDescription(piece({ name: "arm.dxf" }))).toBe("arm L=3000");
  });
  it("a length like 300 is not mistaken for part of 3000", () => {
    expect(pieceDescription(piece({ name: "Beam 3000", lengthMm: 300 }))).toBe("Beam 3000 L=300");
  });
});

describe("isFromPartList", () => {
  const labels = labelSet([partListLabel("DWG-1", 3, "Support beam")]);
  it("a piece carrying a Part List part id came from the Part List", () => {
    expect(isFromPartList(piece({ partId: "abc" }), labels)).toBe(true);
  });
  it("an older piece is recognised by its drawing / item / description name", () => {
    expect(isFromPartList(piece({ name: "DWG-1 #3 Support beam" }), labels)).toBe(true);
    expect(isFromPartList(piece({ name: "  dwg-1  #3 support   beam " }), labels)).toBe(true);
  });
  it("a piece made in the nest tool is not", () => {
    expect(isFromPartList(piece({ name: "Beam" }), labels)).toBe(false);
  });
});

describe("knownWeightPerMeter", () => {
  it("gives the table weight for a hot-rolled profile, null otherwise", () => {
    expect(knownWeightPerMeter(piece())).toBe(22.4);
    expect(knownWeightPerMeter(piece({ profile: "HEB200" }))).toBeNull();
    expect(knownWeightPerMeter(piece({ partType: "PIPE" }))).toBeNull();
  });
});
