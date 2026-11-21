import { redirect } from "next/navigation";
import { auth } from "@/server/auth/config";
import { can } from "@/server/rbac/permissions";
import { RateLibraryView } from "@/features/pricing/ui/rate-library-view";

export default async function RateLibraryPage() {
  const role = (await auth())?.user.role;
  if (!can(role, "pricing.view")) redirect("/takeoff");
  return <RateLibraryView canManage={can(role, "rateLibrary.manage")} />;
}
