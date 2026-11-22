-- Offers remember which APPROVED snapshot they were built from and how their lines were laid out.
-- Purely additive and idempotent: three nullable columns, nothing altered or dropped; older offers keep NULL.

ALTER TABLE "estimate_offers"
  ADD COLUMN IF NOT EXISTS "snapshotId" TEXT,
  ADD COLUMN IF NOT EXISTS "snapshotVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "layout" TEXT;
