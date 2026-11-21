import type { Issue, PricingSummary, TraceEntry } from "../engine";

export interface MaterialDto { id: string; source: "NESTING" | "STOCK" | "PROCUREMENT" | "MANUAL"; name: string; grade: string | null; qty: number; unit: string; unitCost: number; notes: string | null }
export interface ComponentDto { id: string; category: string; name: string; method: string; rate: number; fixed: number | null; unit: string | null; base: string | null; enabled: boolean }
export interface OverrideDto { rateKey: string; value: number; reason: string | null }
export interface ItemDto {
  id: string; itemNo: string; description: string; unit: string; qty: number; unitWeightKg: number | null; scopeType: string;
  scopeItemId: string | null; calcProfile: string | null; profileRefs: Record<string, string>; effectiveProfile: string; totalWeightKg: number | null;
  materials: MaterialDto[]; components: ComponentDto[]; overrides: OverrideDto[];
  calc: { ok: boolean; summary: PricingSummary | null; trace: Record<string, TraceEntry>; issues: Issue[] };
}
export interface SheetView {
  sheet: { id: string; reference: string; version: number; date: string; status: "DRAFT" | "CALCULATED" | "APPROVED" | "SUPERSEDED"; currency: string; calcProfile: string; projectId: string } | null;
  items?: ItemDto[];
  totals?: { directCost: number; indirectCost: number; totalCost: number; salePrice: number; profit: number; profitPct: number; priced: number; failed: number };
  availableScope?: { id: string; description: string; partCount: number; weightKg: number }[];
  history?: { id: string; action: string; message: string; createdAt: string }[];
}

export interface RateComponentDto { id: string; key: string; name: string; category: string; method: string; rate: number; fixed: number | null; unit: string | null; base: string | null; enabled: boolean; notes: string | null }
export interface RateProfileDto { id: string; type: string; name: string; description: string | null; scope: "GLOBAL" | "PROJECT"; active: boolean; projectId: string | null; projectName: string | null; components: RateComponentDto[] }
