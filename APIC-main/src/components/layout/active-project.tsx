"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ProjectOption } from "@/features/takeoff/types";

// ONE "active project" for the whole app. It is picked in the sidebar and every project-based tab
// (Planning, Quotations, Documents, Reports, Nesting & Costing, Scrap Management...) opens for it,
// so nobody has to choose the project again on each page. Remembered between visits.

const STORAGE_KEY = "steelflow.activeProject";

interface ActiveProjectValue {
  projects: ProjectOption[];
  setProjects: React.Dispatch<React.SetStateAction<ProjectOption[]>>;
  loadingProjects: boolean;
  /** "" = no project selected. */
  activeProjectId: string;
  setActiveProjectId: (id: string) => void;
  /** Takes a deleted project out of the list and, if it was the active one, clears the selection. */
  removeProject: (id: string) => void;
}

const ActiveProjectContext = React.createContext<ActiveProjectValue | null>(null);

/** The project id in a /projects/<id>/... address ("" on /projects/new or anywhere else). */
const projectInPath = (pathname: string) => {
  const id = pathname.match(/^\/projects\/([^/]+)/)?.[1];
  return id && id !== "new" ? id : "";
};

export function ActiveProjectProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const urlProject = projectInPath(pathname);

  const [projects, setProjects] = React.useState<ProjectOption[]>([]);
  const [loadingProjects, setLoadingProjects] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState(urlProject);

  // Opening a project's own page (/projects/<id>/...) makes it the active project. Only reacts when the
  // address CHANGES, so picking another project in the sidebar isn't undone while the old page is still open.
  const [seenUrlProject, setSeenUrlProject] = React.useState(urlProject);
  if (urlProject !== seenUrlProject) {
    setSeenUrlProject(urlProject);
    if (urlProject) setSelectedId(urlProject);
  }

  React.useEffect(() => {
    // "?project=<id>" (from the Start screen) opens that project; the parameter is then dropped from the address.
    const wanted = new URLSearchParams(window.location.search).get("project") ?? "";
    if (wanted) window.history.replaceState(null, "", window.location.pathname);
    let stored = "";
    try { stored = localStorage.getItem(STORAGE_KEY) ?? ""; } catch { /* storage unavailable */ }

    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: unknown) => {
        const list = Array.isArray(data) ? (data as ProjectOption[]) : [];
        const has = (id: string) => !!id && list.some((p) => p.id === id);
        setProjects(list);
        setSelectedId((cur) => (has(wanted) ? wanted : cur || (has(stored) ? stored : "")));
      })
      .catch(() => undefined)
      .finally(() => setLoadingProjects(false));
  }, []);

  React.useEffect(() => {
    if (loadingProjects) return; // don't overwrite the remembered project before it was read
    try { localStorage.setItem(STORAGE_KEY, selectedId); } catch { /* storage unavailable */ }
  }, [selectedId, loadingProjects]);

  const removeProject = React.useCallback((id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setSelectedId((cur) => (cur === id ? "" : cur));
  }, []);

  // a project deleted elsewhere is no longer a valid selection
  const activeProjectId = loadingProjects || projects.some((p) => p.id === selectedId) ? selectedId : "";

  return (
    <ActiveProjectContext.Provider
      value={{ projects, setProjects, loadingProjects, activeProjectId, setActiveProjectId: setSelectedId, removeProject }}
    >
      {children}
    </ActiveProjectContext.Provider>
  );
}

export function useActiveProject() {
  const ctx = React.useContext(ActiveProjectContext);
  if (!ctx) throw new Error("useActiveProject must be used within an ActiveProjectProvider");
  return ctx;
}

/** The sidebar's project selector. On a /projects/<id>/<tab> page it moves the same tab to the newly chosen project. */
export function ProjectPicker() {
  const { projects, loadingProjects, activeProjectId, setActiveProjectId } = useActiveProject();
  const pathname = usePathname();
  const router = useRouter();

  function change(id: string) {
    setActiveProjectId(id);
    const m = pathname.match(/^\/projects\/([^/]+)(\/.*)?$/);
    if (m && m[1] !== "new") router.push(id ? `/projects/${id}${m[2] ?? ""}` : "/projects");
  }

  return (
    <div className="relative px-3 pb-1">
      <label htmlFor="active-project" className="mb-1 block px-1 text-[10px] font-semibold uppercase tracking-wide text-sidebar-foreground/60">
        Active project
      </label>
      <select
        id="active-project"
        value={activeProjectId}
        disabled={loadingProjects}
        onChange={(e) => change(e.target.value)}
        className="h-9 w-full rounded-md border border-white/15 bg-white/10 px-2 text-sm text-white outline-none focus:ring-2 focus:ring-white/30 disabled:opacity-60 [&>option]:text-black"
      >
        <option value="">{loadingProjects ? "Loading…" : "— No project —"}</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.number} — {p.name}</option>
        ))}
      </select>
    </div>
  );
}
