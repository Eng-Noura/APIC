import { redirect } from "next/navigation";
import { auth } from "@/server/auth/config";
import { can } from "@/server/rbac/permissions";
import { ScrapManagementView } from "@/features/scrap-management/scrap-management-view";

export default async function ScrapManagementPage() {
  const role = (await auth())?.user.role;
  if (!can(role, "scrapPricing.view")) redirect("/takeoff");
  return <ScrapManagementView canExport={can(role, "scrapPricing.export")} />;
}
