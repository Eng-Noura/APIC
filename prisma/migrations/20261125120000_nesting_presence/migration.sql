-- Who has a project's 2D / 1D nest open right now (heartbeat), so people see each other and do not overwrite each other.
-- Purely additive: one new table.

CREATE TABLE IF NOT EXISTS "nesting_presence" (
  "id"         TEXT NOT NULL,
  "projectId"  TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastEditAt" TIMESTAMP(3),
  CONSTRAINT "nesting_presence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "nesting_presence_projectId_kind_userId_key" ON "nesting_presence"("projectId", "kind", "userId");
CREATE INDEX IF NOT EXISTS "nesting_presence_projectId_kind_lastSeenAt_idx" ON "nesting_presence"("projectId", "kind", "lastSeenAt");

DO $$ BEGIN
  ALTER TABLE "nesting_presence"
    ADD CONSTRAINT "nesting_presence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
