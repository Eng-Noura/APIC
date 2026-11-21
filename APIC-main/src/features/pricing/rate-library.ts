/**
 * Rate Library rules — pure TypeScript. A Rate Profile holds either
 *  - CHAIN RATES: values for the engine's fixed rate keys (indirect %, markup multipliers, insurance divisor …), or
 *  - LINE TEMPLATES: reusable cost lines (e.g. crane per ton) that are added to an item when it selects the profile.
 */
import { RATE_META, type RateKind } from "./rate-meta";

export const PROFILE_TYPES = ["MATERIAL", "FABRICATION", "INSTALLATION", "SUBCONTRACTOR", "TRANSPORT", "INDIRECT", "PROFIT", "ADD_ON", "TAX_INSURANCE"] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];

export const TYPE_LABEL: Record<ProfileType, string> = {
  MATERIAL: "Material Rates", FABRICATION: "Fabrication", INSTALLATION: "Installation", SUBCONTRACTOR: "Subcontractor", TRANSPORT: "Transportation",
  INDIRECT: "Indirect Cost Rules", PROFIT: "Profit Rules", ADD_ON: "Add-ons", TAX_INSURANCE: "Tax / Insurance",
};

/** Profile types that hold chain rates, and which rate groups each may contain. */
const CHAIN_GROUPS: Partial<Record<ProfileType, string[]>> = {
  INDIRECT: ["Indirect", "Sale additions"],
  PROFIT: ["Profit (markup multipliers)"],
  TAX_INSURANCE: ["Insurance & tax"],
};
/** Profile types that hold line templates, and the item category each template lands in. */
export const LINE_TYPE_CATEGORY: Partial<Record<ProfileType, string>> = {
  FABRICATION: "FABRICATION", INSTALLATION: "INSTALLATION", SUBCONTRACTOR: "SUBCONTRACTOR", TRANSPORT: "ADD_ON", ADD_ON: "ADD_ON",
};

export const isChainType = (t: ProfileType) => t in CHAIN_GROUPS;
export const isLineType = (t: ProfileType) => t in LINE_TYPE_CATEGORY;
export const allowedChainKeys = (t: ProfileType) => RATE_META.filter((r) => CHAIN_GROUPS[t]?.includes(r.group));

export const CHAIN_METHOD: Record<RateKind, string> = { pct: "PERCENT_OF_BASE", mult: "MARKUP", divisor: "DIVISOR", lump: "FIXED_LUMP_SUM" };
export const isLineKey = (key: string) => key.startsWith("line.");
export const newLineKey = () => `line.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export type ComponentCheck = { ok: true; kind: "chain" | "line" } | { ok: false; error: string };

/** Validates one component against its profile type (used by the API; the engine re-validates at calculation). */
export function checkComponent(type: ProfileType, c: { key: string; method?: string; category?: string; rate: number }): ComponentCheck {
  if (!Number.isFinite(c.rate) || c.rate < 0) return { ok: false, error: "Rate must be a number ≥ 0." };
  if (isLineKey(c.key)) {
    const cat = LINE_TYPE_CATEGORY[type];
    if (!cat) return { ok: false, error: `${TYPE_LABEL[type]} profiles hold rates, not cost lines.` };
    if (c.category && c.category !== cat) return { ok: false, error: `Lines in a ${TYPE_LABEL[type]} profile must be ${cat}.` };
    return { ok: true, kind: "line" };
  }
  const meta = allowedChainKeys(type).find((r) => r.key === c.key);
  if (!meta) return { ok: false, error: `"${c.key}" is not a rate a ${TYPE_LABEL[type]} profile can hold.` };
  if (meta.kind === "mult" && c.rate <= 0) return { ok: false, error: "A markup multiplier must be greater than 0." };
  if (meta.kind === "divisor" && c.rate <= 0) return { ok: false, error: "A divisor must be greater than 0." };
  return { ok: true, kind: "chain" };
}

/**
 * Two active profiles of the same scope that both set the same chain rate: the later-created one silently wins in the
 * calculation, so the library warns about it. Returns one entry per (scope, key).
 */
export function findConflicts(profiles: { id: string; name: string; scope: string; active: boolean; components: { key: string; enabled: boolean }[] }[]) {
  const seen = new Map<string, string[]>();
  for (const p of profiles) {
    if (!p.active) continue;
    for (const c of p.components) {
      if (!c.enabled || isLineKey(c.key)) continue;
      const k = `${p.scope}|${c.key}`;
      seen.set(k, [...(seen.get(k) ?? []), p.name]);
    }
  }
  return [...seen].filter(([, names]) => names.length > 1).map(([k, names]) => ({ scope: k.split("|")[0], key: k.split("|")[1], profiles: names }));
}
