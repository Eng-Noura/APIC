import { redirect } from "next/navigation";
import { auth } from "@/server/auth/config";
import { can } from "@/server/rbac/permissions";
import { PricingView } from "@/features/pricing/ui/pricing-view";

// The earlier BOQ-item pricing sheet (rate profiles, snapshots, approval) — unchanged, now reached from the new Pricing page.
export default async function BoqPricingPage() {
  const role = (await auth())?.user.role;
  if (!can(role, "pricing.view")) redirect("/takeoff");
  return <PricingView canEdit={can(role, "pricing.edit")} />;
}
