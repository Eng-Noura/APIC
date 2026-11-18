import { auth } from "@/server/auth/config";
import { can } from "@/server/rbac/permissions";
import { StartView } from "@/features/start/start-view";

// First screen after signing in: Free Nesting / Open Existing Project / New Project.
export default async function StartPage() {
  const session = await auth();
  const role = session?.user.role;
  return (
    <StartView
      userName={session?.user.name ?? undefined}
      canNesting={can(role, "nesting.view")}
      canOpen={can(role, "projects.view") && can(role, "takeoff.view")}
      canCreate={can(role, "projects.create")}
    />
  );
}
