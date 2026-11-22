import type { AllocationBasis, CalcIssue, CommercialResult, CostType, DiscountMode, DiscountTiming, EstimateInputs, EstimateResult, InsuranceMode, ItemSummary, OpPercentBase, PriceSource, ProfitMode, ProjectMethod, ProjectPercentBase, SubCostType, SubPercentBase } from "./calc";
import type { PriceOptions, SheetStatus } from "./workflow";

export interface EstMaterial { id: string; source: "NESTING" | "PART_LIST" | "PROCUREMENT" | "MANUAL"; name: string; grade: string | null; thicknessMm: number | null; requiredKg: number | null; purchasedKg: number; unitPrice: number; sourceRequiredKg: number | null; sourcePurchasedKg: number | null; suggestedUnitPrice: number | null; sourceMissing: boolean;
  /** v2 */
  itemId?: string | null; materialType?: string | null; dimensions?: string | null; unit?: string; netKg?: number | null; notes?: string | null;
  priceSource?: PriceSource; priceOptions?: PriceOptions | null }
export interface EstOperation { id: string; name: string; costType: CostType; unit: string; rate: number; quantity: number | null; percentBase: OpPercentBase | null; selected: boolean; source: "DEFAULT" | "MANUAL"; description?: string | null; notes?: string | null }
export interface EstItem { id: string; name: string; linked: boolean; weightKg: number; pieces: number; manualWeightKg: number | null; manualPieces: number | null; notes?: string | null; scopeItemId?: string | null; operations: EstOperation[] }
export interface EstSubcontract { id: string; name: string; company: string | null; unit: string; quantity: number; unitPrice: number; notes: string | null; description?: string | null; costType?: SubCostType; percentBase?: SubPercentBase | null; selected?: boolean; itemId?: string | null }
export interface EstProjectCost { id: string; name: string; method: ProjectMethod; unit: string; quantity: number | null; rate: number; percentBase: ProjectPercentBase | null; enabled: boolean; source: "DEFAULT" | "MANUAL"; category?: string; notes?: string | null; itemId?: string | null }
export interface EstSettings {
  scrapUsedLaterPct: number; scrapUsedLaterPrice: number; scrapSellPrice: number; creditRecoveredScrap: boolean;
  profitMode: ProfitMode; profitValue: number; insuranceMode: InsuranceMode; insuranceValue: number; taxPct: number;
  paymentTerms: string | null; offerValidityDays: number; deliveryDays: number | null; exclusions: string | null; commercialNotes: string | null;
  /** v2 */
  discountMode?: DiscountMode; discountValue?: number; discountTiming?: DiscountTiming; otherChargesLabel?: string | null; otherChargesValue?: number; otherChargesTaxable?: boolean;
  targetSalePrice?: number | null; advancePct?: number | null; milestones?: string | null; warrantyMonths?: number | null; allocationBasis?: AllocationBasis;
}
export interface EstOffer { id: string; quotationId: string; number: string; revision: number; status: string; finalPrice: number; createdAt: string; /** the approved snapshot version it was built from, and its layout (null on older offers) */ snapshotVersion: number | null; layout: string | null }

/** What the server returns (and what the page edits). `totals` is the server's own recalculation. */
export interface EstimateDoc {
  project: { id: string; number: string; name: string; customer: string };
  currency: string; updatedAt: string;
  stageDone: { material: boolean; manufacturing: boolean; project: boolean; commercial: boolean };
  settings: EstSettings;
  materials: EstMaterial[]; items: EstItem[]; subcontracts: EstSubcontract[]; projectCosts: EstProjectCost[];
  offers: EstOffer[];
  /** v2 workflow. While APPROVED the figures below come from the approved snapshot, not from live data. */
  sheet: { number: string | null; version: number; status: SheetStatus; locked: boolean; calculatedAt: string | null; approvedAt: string | null; approvedById: string | null };
  issues: CalcIssue[];
  itemTotals: ItemSummary[];
  totals: { materialCents: number; manufacturingCents: number; subcontractorCents: number; projectCents: number; estimatedCostCents: number } & CommercialResult;
}

export interface EstVersionRow { id: string; version: number; kind: "CALCULATED" | "APPROVED"; costTotal: number; finalPrice: number; note: string | null; createdAt: string; createdById: string; verified: boolean }
export interface EstAuditRow { id: string; action: string; summary: string; changes: unknown; version: number; userId: string; createdAt: string }
/** One stored snapshot in full: the exact inputs and the result that was calculated from them. */
export interface EstSnapshotFull extends EstVersionRow { inputs: EstimateInputs; result: EstimateResult }
