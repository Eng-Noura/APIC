import { redirect } from "next/navigation";
import { auth } from "@/server/auth/config";
import { can } from "@/server/rbac/permissions";
import { PricingView } from "@/features/pricing/ui/pricing-view";

export default async function PricingPage() {
  const role = (await auth())?.user.role;
  if (!can(role, "pricing.view")) redirect("/takeoff");
  return <PricingView canEdit={can(role, "pricing.edit")} />;
}
