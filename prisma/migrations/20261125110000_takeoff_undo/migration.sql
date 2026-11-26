-- Ctrl+Z / Ctrl+Y for the Part List: before / after copies of the parts a person changed, per person and project.
-- Purely additive: one new table.

CREATE TABLE IF NOT EXISTS "takeoff_undo" (
  "id"        TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "label"     TEXT NOT NULL,
  "changes"   JSONB NOT NULL,
  "state"     TEXT NOT NULL DEFAULT 'done',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "takeoff_undo_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "takeoff_undo_projectId_userId_createdAt_idx" ON "takeoff_undo"("projectId", "userId", "createdAt");

DO $$ BEGIN
  ALTER TABLE "takeoff_undo"
    ADD CONSTRAINT "takeoff_undo_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
