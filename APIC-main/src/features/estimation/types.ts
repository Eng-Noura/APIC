import type { CommercialResult, CostType, InsuranceMode, OpPercentBase, ProfitMode, ProjectMethod, ProjectPercentBase } from "./calc";

export interface EstMaterial { id: string; source: "NESTING" | "PART_LIST" | "PROCUREMENT" | "MANUAL"; name: string; grade: string | null; thicknessMm: number | null; requiredKg: number | null; purchasedKg: number; unitPrice: number; sourceRequiredKg: number | null; sourcePurchasedKg: number | null; suggestedUnitPrice: number | null; sourceMissing: boolean }
export interface EstOperation { id: string; name: string; costType: CostType; unit: string; rate: number; quantity: number | null; percentBase: OpPercentBase | null; selected: boolean; source: "DEFAULT" | "MANUAL" }
export interface EstItem { id: string; name: string; linked: boolean; weightKg: number; pieces: number; manualWeightKg: number | null; manualPieces: number | null; operations: EstOperation[] }
export interface EstSubcontract { id: string; name: string; company: string | null; unit: string; quantity: number; unitPrice: number; notes: string | null }
export interface EstProjectCost { id: string; name: string; method: ProjectMethod; unit: string; quantity: number | null; rate: number; percentBase: ProjectPercentBase | null; enabled: boolean; source: "DEFAULT" | "MANUAL" }
export interface EstSettings {
  scrapUsedLaterPct: number; scrapUsedLaterPrice: number; scrapSellPrice: number; creditRecoveredScrap: boolean;
  profitMode: ProfitMode; profitValue: number; insuranceMode: InsuranceMode; insuranceValue: number; taxPct: number;
  paymentTerms: string | null; offerValidityDays: number; deliveryDays: number | null; exclusions: string | null; commercialNotes: string | null;
}
export interface EstOffer { id: string; quotationId: string; number: string; revision: number; status: string; finalPrice: number; createdAt: string }

/** What the server returns (and what the page edits). `totals` is the server's own recalculation. */
export interface EstimateDoc {
  project: { id: string; number: string; name: string; customer: string };
  currency: string; updatedAt: string;
  stageDone: { material: boolean; manufacturing: boolean; project: boolean; commercial: boolean };
  settings: EstSettings;
  materials: EstMaterial[]; items: EstItem[]; subcontracts: EstSubcontract[]; projectCosts: EstProjectCost[];
  offers: EstOffer[];
  totals: { materialCents: number; manufacturingCents: number; subcontractorCents: number; projectCents: number; estimatedCostCents: number } & CommercialResult;
}
