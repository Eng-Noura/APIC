import type { RateLayerName, RateLayers } from "./types";

export interface ResolvedRate {
  value: number;
  layer: RateLayerName;
}

/**
 * Precedence (highest first): item OVERRIDE → pricing PROFILE → PROJECT → GLOBAL default → component fallback.
 * Returns null when nothing holds the key — callers must report it, never default to 0.
 */
export function resolveRate(key: string | undefined, layers: RateLayers, fallback?: number): ResolvedRate | null {
  const order: [RateLayerName, Record<string, number> | undefined][] = [
    ["OVERRIDE", layers.override],
    ["PROFILE", layers.profile],
    ["PROJECT", layers.project],
    ["GLOBAL", layers.global],
  ];
  if (key !== undefined) {
    for (const [layer, map] of order) {
      if (map && Object.prototype.hasOwnProperty.call(map, key)) return { value: map[key], layer };
    }
  }
  return fallback !== undefined ? { value: fallback, layer: "COMPONENT" } : null;
}
