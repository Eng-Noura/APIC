-- Pricing & Estimation (four-stage workflow) — purely additive: 7 new tables, indexes and foreign keys.
-- No existing table or column is touched (the Prisma back-relations on projects / scope_items / quotations are virtual).
-- Idempotent (safe to re-run) in the same style as the earlier migrations.

CREATE TABLE IF NOT EXISTS "project_estimates" (
  "id" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'EGP',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "materialDone" BOOLEAN NOT NULL DEFAULT false,
  "manufacturingDone" BOOLEAN NOT NULL DEFAULT false,
  "projectCostDone" BOOLEAN NOT NULL DEFAULT false,
  "scrapUsedLaterPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "scrapUsedLaterPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "scrapSellPrice" DOUBLE PRECISION NOT NULL DEFAULT 15,
  "creditRecoveredScrap" BOOLEAN NOT NULL DEFAULT false,
  "profitMode" TEXT NOT NULL DEFAULT 'MARKUP_ON_COST',
  "profitValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "insuranceMode" TEXT NOT NULL DEFAULT 'FIXED',
  "insuranceValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "taxPct" DOUBLE PRECISION NOT NULL DEFAULT 14,
  "paymentTerms" TEXT,
  "offerValidityDays" INTEGER NOT NULL DEFAULT 30,
  "deliveryDays" INTEGER,
  "exclusions" TEXT,
  "commercialNotes" TEXT,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT,
  "projectId" TEXT NOT NULL,
  CONSTRAINT "project_estimates_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_estimates_projectId_key" ON "project_estimates"("projectId");

CREATE TABLE IF NOT EXISTS "estimate_materials" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "sourceRef" TEXT,
  "name" TEXT NOT NULL,
  "grade" TEXT,
  "thicknessMm" DOUBLE PRECISION,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "requiredKg" DOUBLE PRECISION,
  "purchasedKg" DOUBLE PRECISION NOT NULL,
  "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "sourceRequiredKg" DOUBLE PRECISION,
  "sourcePurchasedKg" DOUBLE PRECISION,
  "suggestedUnitPrice" DOUBLE PRECISION,
  "suggestedPriceSource" TEXT,
  "sourceMissing" BOOLEAN NOT NULL DEFAULT false,
  "estimateId" TEXT NOT NULL,
  CONSTRAINT "estimate_materials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_materials_estimateId_sourceRef_key" ON "estimate_materials"("estimateId","sourceRef");
CREATE INDEX IF NOT EXISTS "estimate_materials_estimateId_sortOrder_idx" ON "estimate_materials"("estimateId","sortOrder");

CREATE TABLE IF NOT EXISTS "estimate_items" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "manualWeightKg" DOUBLE PRECISION,
  "manualPieces" INTEGER,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "estimateId" TEXT NOT NULL,
  "scopeItemId" TEXT,
  CONSTRAINT "estimate_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_items_estimateId_scopeItemId_key" ON "estimate_items"("estimateId","scopeItemId");
CREATE INDEX IF NOT EXISTS "estimate_items_estimateId_sortOrder_idx" ON "estimate_items"("estimateId","sortOrder");

CREATE TABLE IF NOT EXISTS "estimate_operations" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "costType" TEXT NOT NULL,
  "unit" TEXT NOT NULL DEFAULT '',
  "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "quantity" DOUBLE PRECISION,
  "percentBase" TEXT,
  "selected" BOOLEAN NOT NULL DEFAULT false,
  "source" TEXT NOT NULL DEFAULT 'DEFAULT',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "itemId" TEXT NOT NULL,
  CONSTRAINT "estimate_operations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "estimate_operations_itemId_sortOrder_idx" ON "estimate_operations"("itemId","sortOrder");

CREATE TABLE IF NOT EXISTS "estimate_subcontracts" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "company" TEXT,
  "unit" TEXT NOT NULL DEFAULT 'lot',
  "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
  "unitPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "notes" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "estimateId" TEXT NOT NULL,
  CONSTRAINT "estimate_subcontracts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "estimate_subcontracts_estimateId_sortOrder_idx" ON "estimate_subcontracts"("estimateId","sortOrder");

CREATE TABLE IF NOT EXISTS "estimate_project_costs" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "unit" TEXT NOT NULL DEFAULT '',
  "quantity" DOUBLE PRECISION,
  "rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "percentBase" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "source" TEXT NOT NULL DEFAULT 'DEFAULT',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "estimateId" TEXT NOT NULL,
  CONSTRAINT "estimate_project_costs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "estimate_project_costs_estimateId_sortOrder_idx" ON "estimate_project_costs"("estimateId","sortOrder");

CREATE TABLE IF NOT EXISTS "estimate_offers" (
  "id" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "finalPrice" DOUBLE PRECISION NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "estimateId" TEXT NOT NULL,
  "quotationId" TEXT NOT NULL,
  CONSTRAINT "estimate_offers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_offers_quotationId_key" ON "estimate_offers"("quotationId");
CREATE INDEX IF NOT EXISTS "estimate_offers_estimateId_createdAt_idx" ON "estimate_offers"("estimateId","createdAt");

DO $$ BEGIN ALTER TABLE "project_estimates" ADD CONSTRAINT "project_estimates_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_materials" ADD CONSTRAINT "estimate_materials_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "project_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_items" ADD CONSTRAINT "estimate_items_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "project_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_items" ADD CONSTRAINT "estimate_items_scopeItemId_fkey" FOREIGN KEY ("scopeItemId") REFERENCES "scope_items"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_operations" ADD CONSTRAINT "estimate_operations_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "estimate_items"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_subcontracts" ADD CONSTRAINT "estimate_subcontracts_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "project_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_project_costs" ADD CONSTRAINT "estimate_project_costs_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "project_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_offers" ADD CONSTRAINT "estimate_offers_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "project_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "estimate_offers" ADD CONSTRAINT "estimate_offers_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
