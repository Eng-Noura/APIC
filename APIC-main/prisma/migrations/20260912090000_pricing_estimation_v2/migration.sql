-- Pricing & Estimation v2 — purely additive and idempotent (same style as 20260911090000_pricing_estimation).
-- Adds: item-scoped materials / subcontractors / project costs, price provenance, extended commercial terms,
-- sheet number / version / status workflow, immutable snapshots, audit trail and reusable templates.
-- No existing column is altered or dropped; every new column is nullable or has a default, so existing rows stay valid.

ALTER TABLE "project_estimates"
  ADD COLUMN IF NOT EXISTS "discountMode" TEXT NOT NULL DEFAULT 'NONE',
  ADD COLUMN IF NOT EXISTS "discountValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "discountTiming" TEXT NOT NULL DEFAULT 'BEFORE_TAX',
  ADD COLUMN IF NOT EXISTS "otherChargesLabel" TEXT,
  ADD COLUMN IF NOT EXISTS "otherChargesValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "otherChargesTaxable" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "targetSalePrice" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "advancePct" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "milestones" TEXT,
  ADD COLUMN IF NOT EXISTS "warrantyMonths" INTEGER,
  ADD COLUMN IF NOT EXISTS "allocationBasis" TEXT NOT NULL DEFAULT 'WEIGHT',
  ADD COLUMN IF NOT EXISTS "sheetNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS "calculatedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "approvedById" TEXT;

ALTER TABLE "estimate_materials"
  ADD COLUMN IF NOT EXISTS "materialType" TEXT,
  ADD COLUMN IF NOT EXISTS "dimensions" TEXT,
  ADD COLUMN IF NOT EXISTS "unit" TEXT NOT NULL DEFAULT 'KG',
  ADD COLUMN IF NOT EXISTS "netKg" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "priceSource" TEXT NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN IF NOT EXISTS "priceOptions" JSONB,
  ADD COLUMN IF NOT EXISTS "notes" TEXT,
  ADD COLUMN IF NOT EXISTS "itemId" TEXT;
CREATE INDEX IF NOT EXISTS "estimate_materials_itemId_idx" ON "estimate_materials"("itemId");

ALTER TABLE "estimate_items" ADD COLUMN IF NOT EXISTS "notes" TEXT;

ALTER TABLE "estimate_operations"
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "notes" TEXT;

ALTER TABLE "estimate_subcontracts"
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "costType" TEXT NOT NULL DEFAULT 'PER_UNIT',
  ADD COLUMN IF NOT EXISTS "percentBase" TEXT,
  ADD COLUMN IF NOT EXISTS "selected" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "itemId" TEXT;
CREATE INDEX IF NOT EXISTS "estimate_subcontracts_itemId_idx" ON "estimate_subcontracts"("itemId");

ALTER TABLE "estimate_project_costs"
  ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "notes" TEXT,
  ADD COLUMN IF NOT EXISTS "itemId" TEXT;

CREATE TABLE IF NOT EXISTS "estimate_snapshots" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "inputs" JSONB NOT NULL,
  "result" JSONB NOT NULL,
  "costTotal" DECIMAL(18,2) NOT NULL,
  "finalPrice" DECIMAL(18,2) NOT NULL,
  "note" TEXT,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "estimateId" TEXT NOT NULL,
  CONSTRAINT "estimate_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "estimate_snapshots_estimateId_version_createdAt_idx" ON "estimate_snapshots"("estimateId","version","createdAt");

CREATE TABLE IF NOT EXISTS "estimate_audit" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "changes" JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "estimateId" TEXT NOT NULL,
  CONSTRAINT "estimate_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "estimate_audit_estimateId_createdAt_idx" ON "estimate_audit"("estimateId","createdAt");

CREATE TABLE IF NOT EXISTS "estimate_templates" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "estimate_templates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_templates_kind_name_key" ON "estimate_templates"("kind","name");

DO $$ BEGIN ALTER TABLE "estimate_materials" ADD CONSTRAINT "estimate_materials_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "estimate_items"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_subcontracts" ADD CONSTRAINT "estimate_subcontracts_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "estimate_items"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_project_costs" ADD CONSTRAINT "estimate_project_costs_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "estimate_items"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_snapshots" ADD CONSTRAINT "estimate_snapshots_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "project_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_audit" ADD CONSTRAINT "estimate_audit_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "project_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
