"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FolderOpen, FolderPlus, Loader2, Scissors, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Where a chosen / new project opens. Nesting & Costing reads `?project=<id>` and opens that project.
 * Change this one function to send people somewhere else (e.g. `/projects/${id}`).
 */
const projectUrl = (id: string) => `/takeoff?project=${encodeURIComponent(id)}`;
/** Free Nesting: a standalone nest (saved in History, can be assigned to a project later). */
const FREE_NESTING_URL = "/takeoff/nesting";

interface ProjectRow { id: string; number: string; name: string; customer?: { name?: string | null } | null }

function localStamp() {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function StartCard({
  icon: Icon, title, text, disabled, disabledHint, onClick, href,
}: {
  icon: typeof FolderOpen;
  title: string;
  text: string;
  disabled?: boolean;
  disabledHint?: string;
  onClick?: () => void;
  href?: string;
}) {
  const cls = cn(
    "group flex h-full flex-col items-start gap-3 rounded-2xl border border-border bg-card p-6 text-left shadow-sm transition",
    disabled ? "cursor-not-allowed opacity-50" : "hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  );
  const inner = (
    <>
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground">
        <Icon className="h-6 w-6" />
      </span>
      <span className="text-lg font-semibold text-foreground">{title}</span>
      <span className="text-sm text-muted-foreground">{disabled && disabledHint ? disabledHint : text}</span>
    </>
  );
  if (href && !disabled) return <Link href={href} className={cls}>{inner}</Link>;
  return <button type="button" className={cls} disabled={disabled} onClick={onClick}>{inner}</button>;
}

/** Mounted fresh every time the window opens, so it always starts with an empty search and a new list. */
function ExistingProjectBody() {
  const router = useRouter();
  const [rows, setRows] = React.useState<ProjectRow[] | null>(null);
  const [q, setQ] = React.useState("");

  React.useEffect(() => {
    fetch("/api/projects")
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .catch(() => setRows([]));
  }, []);

  const shown = (rows ?? []).filter((p) => `${p.number} ${p.name} ${p.customer?.name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <>
        <DialogHeader>
          <DialogTitle>Open existing project</DialogTitle>
          <DialogDescription>Pick the project you want to work on.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus className="pl-9" placeholder="Search by number, name or client" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="max-h-80 space-y-1 overflow-y-auto" role="listbox" aria-label="Projects">
          {rows === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading projects…
            </div>
          ) : shown.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{rows.length === 0 ? "No projects yet — create a new one." : "No project matches your search."}</p>
          ) : (
            shown.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={false}
                onClick={() => router.push(projectUrl(p.id))}
                className="flex w-full flex-col rounded-lg border border-transparent px-3 py-2 text-left transition hover:border-border hover:bg-muted/50"
              >
                <span className="text-sm font-medium text-foreground">{p.number} — {p.name}</span>
                {p.customer?.name && <span className="text-xs text-muted-foreground">{p.customer.name}</span>}
              </button>
            ))
          )}
        </div>
    </>
  );
}

function ExistingProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent><ExistingProjectBody /></DialogContent>
    </Dialog>
  );
}

/** Mounted fresh every time the window opens, so the name always starts empty. */
function NewProjectBody({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/nesting/auto-project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: clean, stamp: localStamp() }),
      });
      if (!res.ok) throw new Error(res.status === 403 ? "You are not allowed to create projects" : "Could not create the project, please try again");
      const proj = (await res.json()) as { id: string };
      router.push(projectUrl(proj.id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Give the project a name. You can fill in its details later.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="start-new-name">Project name</Label>
          <Input
            id="start-new-name"
            autoFocus
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void submit()} disabled={busy || !name.trim()}>{busy ? "Please wait…" : "Create project"}</Button>
        </DialogFooter>
    </>
  );
}

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent><NewProjectBody onClose={() => onOpenChange(false)} /></DialogContent>
    </Dialog>
  );
}

/** The first screen after signing in: start a free nest, open a project, or create a new one. */
export function StartView({ canNesting, canOpen, canCreate, userName }: { canNesting: boolean; canOpen: boolean; canCreate: boolean; userName?: string }) {
  const [existingOpen, setExistingOpen] = React.useState(false);
  const [newOpen, setNewOpen] = React.useState(false);

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-4xl flex-col justify-center gap-8 py-6">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold text-foreground">{userName ? `Welcome, ${userName}` : "Welcome"}</h1>
        <p className="text-sm text-muted-foreground">How would you like to start?</p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <StartCard
          icon={Scissors}
          title="Free Nesting"
          text="Nest quickly without a project. Saved in History — assign it to a project any time."
          href={FREE_NESTING_URL}
          disabled={!canNesting}
          disabledHint="You do not have access to Nesting."
        />
        <StartCard
          icon={FolderOpen}
          title="Open Existing Project"
          text="Continue working on a project you already have."
          onClick={() => setExistingOpen(true)}
          disabled={!canOpen}
          disabledHint="You do not have access to projects."
        />
        <StartCard
          icon={FolderPlus}
          title="New Project"
          text="Start a fresh project from scratch."
          onClick={() => setNewOpen(true)}
          disabled={!canCreate}
          disabledHint="You are not allowed to create projects."
        />
      </div>
      <ExistingProjectDialog open={existingOpen} onOpenChange={setExistingOpen} />
      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}
