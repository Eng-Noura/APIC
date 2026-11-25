-- Trash of the Part List: a deleted part keeps a full copy here for 30 days so it can be restored.
-- Purely additive: one new table, nothing altered or dropped.

CREATE TABLE IF NOT EXISTS "takeoff_part_trash" (
  "id"            TEXT NOT NULL,
  "projectId"     TEXT NOT NULL,
  "drawingId"     TEXT NOT NULL,
  "drawingNumber" TEXT NOT NULL,
  "partId"        TEXT NOT NULL,
  "description"   TEXT NOT NULL,
  "snapshot"      JSONB NOT NULL,
  "dxf"           JSONB,
  "deletedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedById"   TEXT,
  CONSTRAINT "takeoff_part_trash_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "takeoff_part_trash_projectId_deletedAt_idx" ON "takeoff_part_trash"("projectId", "deletedAt");

DO $$ BEGIN
  ALTER TABLE "takeoff_part_trash"
    ADD CONSTRAINT "takeoff_part_trash_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
