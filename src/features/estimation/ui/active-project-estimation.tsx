"use client";
import Link from "next/link";
import { useTakeoffProject } from "@/features/takeoff/project-context";
import { EstimationView } from "./estimation-view";

/** Reads the project picked in the sidebar ("Active project") and shows its estimate; switching project remounts it with clean state. */
export function ActiveProjectEstimation({ canEdit, canOffer, canApprove, canManageTemplates }: { canEdit: boolean; canOffer: boolean; canApprove: boolean; canManageTemplates: boolean }) {
  const { projectId } = useTakeoffProject();
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Link href="/takeoff/pricing/boq" className="text-xs text-muted-foreground hover:text-primary hover:underline">Open the earlier BOQ-item pricing sheet →</Link>
      </div>
      {projectId
        ? <EstimationView key={projectId} projectId={projectId} canEdit={canEdit} canOffer={canOffer} canApprove={canApprove} canManageTemplates={canManageTemplates} />
        : <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">Select an active project in the sidebar to price it.</div>}
    </div>
  );
}
