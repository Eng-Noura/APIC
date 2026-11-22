import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { auth } from "@/server/auth/config";
import { can } from "@/server/rbac/permissions";
import { getProject } from "@/server/services/project.service";
import { EstimationView } from "@/features/estimation/ui/estimation-view";

export default async function ProjectPricingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const role = (await auth())?.user.role;
  if (!can(role, "pricing.view")) notFound();
  const project = await getProject(id);
  if (!project) notFound();
  return (
    <div className="space-y-5">
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
        <Link href="/projects" className="hover:text-foreground">Projects</Link><ChevronRight className="h-3.5 w-3.5" />
        <Link href={`/projects/${project.id}`} className="max-w-[240px] truncate hover:text-foreground">{project.name}</Link><ChevronRight className="h-3.5 w-3.5" />
        <span className="font-medium text-foreground">Pricing</span>
      </nav>
      <EstimationView projectId={project.id} canEdit={can(role, "pricing.edit")} canOffer={can(role, "pricing.edit") && can(role, "quotations.edit")} canApprove={can(role, "pricing.approve")} canManageTemplates={can(role, "pricing.edit")} />
    </div>
  );
}
