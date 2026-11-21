import type { ScrapRowInput } from "@/server/calc/scrap-management";

/** The four numbers the user types, per source row. */
export type ScrapRowEdit = Pick<ScrapRowInput, "costPerKg" | "usedLaterPct" | "usedLaterPriceLEPerKg" | "scrapSellPriceLEPerKg">;

export interface ScrapDefaults {
  costPerKg: number;
  usedLaterPct: number; // 0..1
  scrapSellPriceLEPerKg: number;
}

export interface ScrapSavedState {
  /** Fingerprint of the nest the inputs were entered against — a different one means the nest was re-run. */
  nestSignature: string;
  /** Per-row edits; only the fields the user actually changed. `usedLaterPriceLEPerKg` left out = follows Cost/kg. */
  overrides: Record<string, Partial<ScrapRowEdit>>;
}

export const DEFAULT_SCRAP_DEFAULTS: ScrapDefaults = { costPerKg: 46, usedLaterPct: 0, scrapSellPriceLEPerKg: 15 };

const keyFor = (projectId: string) => `scrapManagement.v1.${projectId}`;

export function loadScrapState(projectId: string): ScrapSavedState | null {
  try {
    const raw = localStorage.getItem(keyFor(projectId));
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<ScrapSavedState>;
    return {
      nestSignature: typeof s.nestSignature === "string" ? s.nestSignature : "",
      overrides: s.overrides && typeof s.overrides === "object" ? s.overrides : {},
    };
  } catch {
    return null;
  }
}

export function saveScrapState(projectId: string, state: ScrapSavedState) {
  try {
    localStorage.setItem(keyFor(projectId), JSON.stringify(state));
  } catch {
    /* storage unavailable (private mode / quota) — the page still works, it just won't remember */
  }
}
