-- BOQ Pricing module — purely additive: 4 enums, 10 new tables, indexes, foreign keys, and an
-- immutability trigger on the snapshot tables. No existing table or column is touched.
-- Idempotent (safe to re-run) in the same style as the earlier migrations.

DO $$ BEGIN CREATE TYPE "RateProfileType" AS ENUM ('MATERIAL','FABRICATION','INSTALLATION','SUBCONTRACTOR','TRANSPORT','INDIRECT','PROFIT','ADD_ON','TAX_INSURANCE'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "RateScope" AS ENUM ('GLOBAL','PROJECT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PricingSheetStatus" AS ENUM ('DRAFT','CALCULATED','APPROVED','SUPERSEDED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "PricingMaterialSource" AS ENUM ('NESTING','STOCK','PROCUREMENT','MANUAL'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "rate_profiles" (
  "id" TEXT NOT NULL,
  "type" "RateProfileType" NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "scope" "RateScope" NOT NULL DEFAULT 'GLOBAL',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "projectId" TEXT,
  "createdById" TEXT NOT NULL,
  CONSTRAINT "rate_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "rate_components" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "rate" DOUBLE PRECISION NOT NULL,
  "fixed" DOUBLE PRECISION,
  "unit" TEXT,
  "base" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "profileId" TEXT NOT NULL,
  CONSTRAINT "rate_components_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "pricing_sheets" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "date" TIMESTAMP(3) NOT NULL,
  "status" "PricingSheetStatus" NOT NULL DEFAULT 'DRAFT',
  "currency" TEXT NOT NULL DEFAULT 'EGP',
  "calcProfile" TEXT NOT NULL DEFAULT 'STANDARD',
  "notes" TEXT,
  "basedOnId" TEXT,
  "approvedById" TEXT,
  "approvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "projectId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  CONSTRAINT "pricing_sheets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "pricing_items" (
  "id" TEXT NOT NULL,
  "itemNo" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "qty" DOUBLE PRECISION NOT NULL,
  "unitWeightKg" DOUBLE PRECISION,
  "scopeType" TEXT NOT NULL DEFAULT '',
  "calcProfile" TEXT,
  "profileRefs" JSONB,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "sheetId" TEXT NOT NULL,
  "scopeItemId" TEXT,
  CONSTRAINT "pricing_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "pricing_material_lines" (
  "id" TEXT NOT NULL,
  "source" "PricingMaterialSource" NOT NULL DEFAULT 'MANUAL',
  "name" TEXT NOT NULL,
  "grade" TEXT,
  "qty" DOUBLE PRECISION NOT NULL,
  "unit" TEXT NOT NULL,
  "unitCost" DOUBLE PRECISION NOT NULL,
  "notes" TEXT,
  "importedRef" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "itemId" TEXT NOT NULL,
  CONSTRAINT "pricing_material_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "pricing_item_components" (
  "id" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "rate" DOUBLE PRECISION NOT NULL,
  "fixed" DOUBLE PRECISION,
  "unit" TEXT,
  "base" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "itemId" TEXT NOT NULL,
  CONSTRAINT "pricing_item_components_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "pricing_item_overrides" (
  "id" TEXT NOT NULL,
  "rateKey" TEXT NOT NULL,
  "value" DOUBLE PRECISION NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "itemId" TEXT NOT NULL,
  CONSTRAINT "pricing_item_overrides_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "pricing_snapshots" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "sheetVersion" INTEGER NOT NULL,
  "engineVersion" TEXT NOT NULL,
  "roundingPolicy" JSONB NOT NULL,
  "ratesUsed" JSONB NOT NULL,
  "inputs" JSONB NOT NULL,
  "totals" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sheetId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  CONSTRAINT "pricing_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "pricing_snapshot_items" (
  "id" TEXT NOT NULL,
  "pricingItemId" TEXT,
  "scopeItemId" TEXT,
  "itemNo" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "qty" DOUBLE PRECISION NOT NULL,
  "unitRate" DOUBLE PRECISION NOT NULL,
  "salePrice" DOUBLE PRECISION NOT NULL,
  "totalCost" DOUBLE PRECISION NOT NULL,
  "profit" DOUBLE PRECISION NOT NULL,
  "profitPct" DOUBLE PRECISION NOT NULL,
  "data" JSONB NOT NULL,
  "snapshotId" TEXT NOT NULL,
  CONSTRAINT "pricing_snapshot_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "pricing_history" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "data" JSONB,
  "userId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sheetId" TEXT NOT NULL,
  CONSTRAINT "pricing_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "rate_profiles_scope_type_idx" ON "rate_profiles"("scope", "type");
CREATE INDEX IF NOT EXISTS "rate_profiles_projectId_type_idx" ON "rate_profiles"("projectId", "type");
CREATE UNIQUE INDEX IF NOT EXISTS "rate_components_profileId_key_key" ON "rate_components"("profileId", "key");
CREATE INDEX IF NOT EXISTS "rate_components_profileId_sortOrder_idx" ON "rate_components"("profileId", "sortOrder");
CREATE UNIQUE INDEX IF NOT EXISTS "pricing_sheets_projectId_reference_version_key" ON "pricing_sheets"("projectId", "reference", "version");
CREATE INDEX IF NOT EXISTS "pricing_sheets_projectId_status_idx" ON "pricing_sheets"("projectId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "pricing_items_sheetId_scopeItemId_key" ON "pricing_items"("sheetId", "scopeItemId");
CREATE INDEX IF NOT EXISTS "pricing_items_sheetId_sortOrder_idx" ON "pricing_items"("sheetId", "sortOrder");
CREATE UNIQUE INDEX IF NOT EXISTS "pricing_material_lines_itemId_importedRef_key" ON "pricing_material_lines"("itemId", "importedRef");
CREATE INDEX IF NOT EXISTS "pricing_material_lines_itemId_idx" ON "pricing_material_lines"("itemId");
CREATE INDEX IF NOT EXISTS "pricing_item_components_itemId_sortOrder_idx" ON "pricing_item_components"("itemId", "sortOrder");
CREATE UNIQUE INDEX IF NOT EXISTS "pricing_item_overrides_itemId_rateKey_key" ON "pricing_item_overrides"("itemId", "rateKey");
CREATE INDEX IF NOT EXISTS "pricing_snapshots_sheetId_kind_createdAt_idx" ON "pricing_snapshots"("sheetId", "kind", "createdAt");
CREATE INDEX IF NOT EXISTS "pricing_snapshot_items_snapshotId_idx" ON "pricing_snapshot_items"("snapshotId");
CREATE INDEX IF NOT EXISTS "pricing_snapshot_items_scopeItemId_idx" ON "pricing_snapshot_items"("scopeItemId");
CREATE INDEX IF NOT EXISTS "pricing_history_sheetId_createdAt_idx" ON "pricing_history"("sheetId", "createdAt");

DO $$ BEGIN ALTER TABLE "rate_profiles" ADD CONSTRAINT "rate_profiles_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "rate_profiles" ADD CONSTRAINT "rate_profiles_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "rate_components" ADD CONSTRAINT "rate_components_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "rate_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_sheets" ADD CONSTRAINT "pricing_sheets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_sheets" ADD CONSTRAINT "pricing_sheets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_items" ADD CONSTRAINT "pricing_items_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "pricing_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_items" ADD CONSTRAINT "pricing_items_scopeItemId_fkey" FOREIGN KEY ("scopeItemId") REFERENCES "scope_items"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_material_lines" ADD CONSTRAINT "pricing_material_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "pricing_items"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_item_components" ADD CONSTRAINT "pricing_item_components_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "pricing_items"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_item_overrides" ADD CONSTRAINT "pricing_item_overrides_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "pricing_items"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_snapshots" ADD CONSTRAINT "pricing_snapshots_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "pricing_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_snapshots" ADD CONSTRAINT "pricing_snapshots_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_snapshot_items" ADD CONSTRAINT "pricing_snapshot_items_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "pricing_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "pricing_history" ADD CONSTRAINT "pricing_history_sheetId_fkey" FOREIGN KEY ("sheetId") REFERENCES "pricing_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Snapshots are immutable: UPDATE is rejected. DELETE stays allowed so a project (and its sheets) can still be
-- removed by the existing ON DELETE CASCADE chain.
CREATE OR REPLACE FUNCTION pricing_snapshot_immutable() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'pricing snapshots are immutable (table %)', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pricing_snapshots_no_update ON "pricing_snapshots";
CREATE TRIGGER pricing_snapshots_no_update BEFORE UPDATE ON "pricing_snapshots" FOR EACH ROW EXECUTE FUNCTION pricing_snapshot_immutable();
DROP TRIGGER IF EXISTS pricing_snapshot_items_no_update ON "pricing_snapshot_items";
CREATE TRIGGER pricing_snapshot_items_no_update BEFORE UPDATE ON "pricing_snapshot_items" FOR EACH ROW EXECUTE FUNCTION pricing_snapshot_immutable();
