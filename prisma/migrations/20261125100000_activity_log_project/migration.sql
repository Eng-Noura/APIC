-- Every change of a Part List part is recorded with the person and the time. This adds the project to the log so a
-- project can show its own history (also for parts that were deleted). Additive: one nullable column and two indexes.

ALTER TABLE "activity_logs" ADD COLUMN IF NOT EXISTS "projectId" TEXT;

CREATE INDEX IF NOT EXISTS "activity_logs_projectId_timestamp_idx" ON "activity_logs"("projectId", "timestamp");
CREATE INDEX IF NOT EXISTS "activity_logs_entityId_idx" ON "activity_logs"("entityId");
