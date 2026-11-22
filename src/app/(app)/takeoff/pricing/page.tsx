import { redirect } from "next/navigation";
import { auth } from "@/server/auth/config";
import { can } from "@/server/rbac/permissions";
import { ActiveProjectEstimation } from "@/features/estimation/ui/active-project-estimation";

// "Pricing" in Nesting & Costing = the four-stage Pricing & Estimation workflow for the ACTIVE project.
export default async function PricingPage() {
  const role = (await auth())?.user.role;
  if (!can(role, "pricing.view")) redirect("/takeoff");
  return <ActiveProjectEstimation canEdit={can(role, "pricing.edit")} canOffer={can(role, "pricing.edit") && can(role, "quotations.edit")} canApprove={can(role, "pricing.approve")} canManageTemplates={can(role, "pricing.edit")} />;
}
