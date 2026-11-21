-- Group parts by Scope and by Work Order (next to the existing Assembly grouping). Additive only: existing rows are untouched.
CREATE TABLE "work_order_groups" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "dueDate" TIMESTAMP(3),
  "remark" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "projectId" TEXT NOT NULL,
  CONSTRAINT "work_order_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "work_order_groups_projectId_code_key" ON "work_order_groups"("projectId", "code");
CREATE INDEX "work_order_groups_projectId_sortOrder_idx" ON "work_order_groups"("projectId", "sortOrder");
ALTER TABLE "work_order_groups" ADD CONSTRAINT "work_order_groups_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "takeoff_parts" ADD COLUMN "scopeId" TEXT;
ALTER TABLE "takeoff_parts" ADD COLUMN "workOrderGroupId" TEXT;
CREATE INDEX "takeoff_parts_scopeId_idx" ON "takeoff_parts"("scopeId");
CREATE INDEX "takeoff_parts_workOrderGroupId_idx" ON "takeoff_parts"("workOrderGroupId");
ALTER TABLE "takeoff_parts" ADD CONSTRAINT "takeoff_parts_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "scope_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "takeoff_parts" ADD CONSTRAINT "takeoff_parts_workOrderGroupId_fkey" FOREIGN KEY ("workOrderGroupId") REFERENCES "work_order_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
