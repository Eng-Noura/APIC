"use client";
import * as React from "react";
import { AlertTriangle, BookMarked, Check, Loader2, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/shared/empty-state";
import { useTakeoffProject } from "@/features/takeoff/project-context";
import { cn } from "@/lib/utils";
import { PERCENT_BASES } from "../sheet-calc";
import { allowedChainKeys, findConflicts, isChainType, isLineType, PROFILE_TYPES, TYPE_LABEL, type ProfileType } from "../rate-library";
import { fromInput, toInput } from "../rate-meta";
import { call } from "./api";
import { METHOD_LABEL, money } from "./format";
import type { RateComponentDto, RateProfileDto } from "./types";

const CREATABLE = PROFILE_TYPES.filter((t) => isChainType(t) || isLineType(t)); // MATERIAL has no reusable form yet
const LINE_METHODS = Object.keys(METHOD_LABEL);
const UNIT_FOR: Record<string, string> = { PER_TON: "TON", PER_KG: "KG", PER_SQM: "SQM", PER_METER: "M", PER_UNIT: "EA" };

export function RateLibraryView({ canManage }: { canManage: boolean }) {
  const { projectId, projects } = useTakeoffProject();
  return <Inner key={projectId || "none"} canManage={canManage} projectId={projectId} projectName={projects.find((p) => p.id === projectId)?.name ?? ""} />;
}

function Inner({ canManage, projectId, projectName }: { canManage: boolean; projectId: string; projectName: string }) {
  const [profiles, setProfiles] = React.useState<RateProfileDto[] | null>(null);
  const [error, setError] = React.useState(false);
  const [tick, setTick] = React.useState(0);
  const [selId, setSelId] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const reload = React.useCallback(() => setTick((t) => t + 1), []);

  React.useEffect(() => {
    let off = false;
    call<{ profiles: RateProfileDto[] }>(`/api/rate-library?projectId=${encodeURIComponent(projectId)}`, "GET", undefined, true).then((r) => {
      if (off) return;
      if (!r) setError(true); else { setError(false); setProfiles(r.profiles); }
    });
    return () => { off = true; };
  }, [projectId, tick]);

  if (error && !profiles) return <EmptyState icon={<AlertTriangle />} title="Could not load the Rate Library" action={<Button size="sm" variant="outline" onClick={() => { setError(false); reload(); }}>Try again</Button>} />;
  if (!profiles) return <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" /> Loading rate library…</div>;

  const sel = profiles.find((p) => p.id === selId) ?? null;
  const conflicts = findConflicts(profiles);
  const groups = CREATABLE.map((t) => ({ t, list: profiles.filter((p) => p.type === t) })).filter((g) => g.list.length);

  return (
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <aside className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Rate profiles</h3>
          {canManage && <Button size="sm" variant="outline" onClick={() => setCreating((v) => !v)}><Plus /> New profile</Button>}
        </div>
        {creating && canManage && <NewProfile projectId={projectId} projectName={projectName} onDone={(id) => { setCreating(false); if (id) setSelId(id); reload(); }} />}
        {conflicts.length > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs" role="alert">
            <p className="mb-1 flex items-center gap-1.5 font-semibold text-warning"><AlertTriangle className="h-3.5 w-3.5" /> Overlapping rates</p>
            <ul className="space-y-0.5">{conflicts.map((c) => <li key={c.scope + c.key}>{c.key} is set by {c.profiles.join(", ")} — the one created last wins.</li>)}</ul>
          </div>
        )}
        {!groups.length ? <EmptyState icon={<BookMarked />} title="No profiles yet" description={canManage ? "Create your first profile, e.g. “Standard Steel Structure”." : "A manager or admin can create profiles."} /> : groups.map((g) => (
          <div key={g.t} className="rounded-xl border border-border bg-card">
            <p className="border-b border-border px-3 py-2 text-xs font-semibold text-muted-foreground">{TYPE_LABEL[g.t]}</p>
            <ul>{g.list.map((p) => (
              <li key={p.id}><button type="button" onClick={() => setSelId(p.id)} aria-current={p.id === selId} className={cn("flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50", p.id === selId && "bg-primary/10 font-medium")}>
                <span className={cn("flex-1 truncate", !p.active && "text-muted-foreground line-through")}>{p.name}</span>
                {p.scope === "PROJECT" && <Badge variant="outline">Project</Badge>}
              </button></li>
            ))}</ul>
          </div>
        ))}
      </aside>

      <section className="min-w-0">
        {sel ? <ProfileEditor key={sel.id} profile={sel} canManage={canManage} onChanged={reload} onDeleted={() => { setSelId(null); reload(); }} /> : <EmptyState icon={<BookMarked />} title="Select a profile" description="Pick a profile on the left to see and edit its rates." />}
      </section>
    </div>
  );
}

function NewProfile({ projectId, projectName, onDone }: { projectId: string; projectName: string; onDone: (id?: string) => void }) {
  const [f, setF] = React.useState({ type: "INSTALLATION" as ProfileType, name: "", description: "", scope: "GLOBAL" as "GLOBAL" | "PROJECT" });
  const [busy, setBusy] = React.useState(false);
  async function save() {
    setBusy(true);
    const r = await call<{ id: string }>("/api/rate-library", "POST", { ...f, description: f.description || undefined, projectId: f.scope === "PROJECT" ? projectId : undefined });
    setBusy(false);
    if (r) onDone(r.id);
  }
  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-3 text-xs">
      <label className="block">Type<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as ProfileType })} className="mt-0.5 h-9 w-full rounded-lg border border-input bg-card px-2 text-sm">{CREATABLE.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select></label>
      <label className="block">Name<Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Standard Steel Structure" /></label>
      <label className="block">Description<Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="When to use it" /></label>
      <label className="block">Applies to<select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as "GLOBAL" | "PROJECT" })} className="mt-0.5 h-9 w-full rounded-lg border border-input bg-card px-2 text-sm"><option value="GLOBAL">All projects (global)</option><option value="PROJECT">Only {projectName || "this project"}</option></select></label>
      <div className="flex gap-2"><Button size="sm" disabled={busy || f.name.trim().length < 2} onClick={save}>Create</Button><Button size="sm" variant="ghost" onClick={() => onDone()}>Cancel</Button></div>
    </div>
  );
}

function ProfileEditor({ profile, canManage, onChanged, onDeleted }: { profile: RateProfileDto; canManage: boolean; onChanged: () => void; onDeleted: () => void }) {
  const type = profile.type as ProfileType;
  const [name, setName] = React.useState(profile.name);
  const [desc, setDesc] = React.useState(profile.description ?? "");
  const dirty = name !== profile.name || desc !== (profile.description ?? "");

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-60 flex-1 space-y-2">
          <Input aria-label="Profile name" value={name} disabled={!canManage} onChange={(e) => setName(e.target.value)} className="font-semibold" />
          <Input aria-label="Profile description" value={desc} disabled={!canManage} onChange={(e) => setDesc(e.target.value)} placeholder="Description" />
          <p className="text-xs text-muted-foreground">{TYPE_LABEL[type]} · {profile.scope === "GLOBAL" ? "all projects" : `project ${profile.projectName ?? ""}`}</p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            {dirty && <Button size="sm" onClick={async () => { if (await call(`/api/rate-library/${profile.id}`, "PATCH", { name, description: desc || null })) onChanged(); }}><Check /> Save</Button>}
            <label className="flex items-center gap-1.5 text-xs">Active<Switch aria-label="Profile active" checked={profile.active} onCheckedChange={async (v) => { if (await call(`/api/rate-library/${profile.id}`, "PATCH", { active: v })) onChanged(); }} /></label>
            <Button size="sm" variant="outline" className="text-destructive" onClick={async () => { if (confirm(`Delete profile “${profile.name}”?`) && (await call(`/api/rate-library/${profile.id}`, "DELETE"))) onDeleted(); }}><Trash2 /> Delete</Button>
          </div>
        )}
      </div>
      {!profile.active && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">Inactive: this profile is ignored by every calculation.</p>}
      {isChainType(type) ? <ChainRates profile={profile} type={type} canManage={canManage} onChanged={onChanged} /> : <LineTemplates profile={profile} type={type} canManage={canManage} onChanged={onChanged} />}
    </div>
  );
}

function ChainRates({ profile, type, canManage, onChanged }: { profile: RateProfileDto; type: ProfileType; canManage: boolean; onChanged: () => void }) {
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const by = new Map(profile.components.map((c) => [c.key, c]));
  async function save(key: string, kind: "pct" | "mult" | "divisor" | "lump", label: string) {
    const raw = draft[key]; if (raw === undefined) return;
    const cur = by.get(key);
    if (raw === "") { if (cur && (await call(`/api/rate-library/components/${cur.id}`, "DELETE"))) { setDraft((d) => { const c = { ...d }; delete c[key]; return c; }); onChanged(); } return; }
    const n = Number(raw); if (!Number.isFinite(n)) return;
    const rate = fromInput(kind, n);
    const ok = cur ? await call(`/api/rate-library/components/${cur.id}`, "PATCH", { rate }) : await call(`/api/rate-library/${profile.id}/components`, "POST", { key, name: label, category: "RATE", method: "PERCENT_OF_BASE", rate });
    if (ok) { setDraft((d) => { const c = { ...d }; delete c[key]; return c; }); onChanged(); }
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Leave a rate empty to not set it here. {type === "PROFIT" ? "Profit is not a single percentage: these multipliers (e.g. 1.255) set the price, and Profit % is a result." : "Percentages are typed as %, markups as multipliers, divisors as numbers like 0.9505."}</p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[420px] text-sm"><tbody>
          {allowedChainKeys(type).map((r) => {
            const c: RateComponentDto | undefined = by.get(r.key);
            return (
              <tr key={r.key} className="border-t border-border first:border-t-0">
                <td className="px-3 py-2">{r.label}<span className="block text-[11px] text-muted-foreground">{r.key}</span></td>
                <td className="px-2 py-1 text-right"><Input aria-label={r.label} type="number" min={0} step="any" disabled={!canManage} value={draft[r.key] ?? (c ? String(toInput(r.kind, c.rate)) : "")} placeholder={r.kind === "pct" ? "%" : r.kind === "lump" ? "EGP" : "value"} onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })} onBlur={() => save(r.key, r.kind, r.label)} onKeyDown={(e) => e.key === "Enter" && save(r.key, r.kind, r.label)} className="ml-auto h-8 w-28 text-right" /></td>
                <td className="w-20 px-2 text-center">{c && <Switch aria-label={`Enable ${r.label}`} checked={c.enabled} disabled={!canManage} onCheckedChange={async (v) => { if (await call(`/api/rate-library/components/${c.id}`, "PATCH", { enabled: v })) onChanged(); }} />}</td>
              </tr>
            );
          })}
        </tbody></table>
      </div>
    </div>
  );
}

function LineTemplates({ profile, type, canManage, onChanged }: { profile: RateProfileDto; type: ProfileType; canManage: boolean; onChanged: () => void }) {
  const [adding, setAdding] = React.useState(false);
  const [f, setF] = React.useState({ name: "", method: "PER_TON", rate: "", fixed: "", base: "MATERIAL_COST" });
  const lines = profile.components.filter((c) => c.key.startsWith("line."));
  const isPct = f.method === "PERCENT_OF_BASE";
  const unit = UNIT_FOR[f.method] ?? (f.method === "FIXED_PLUS_VARIABLE" ? "TON" : undefined);
  const category = type === "TRANSPORT" || type === "ADD_ON" ? "ADD_ON" : type;
  const bases = PERCENT_BASES.filter((b) => b.category !== category);
  const valid = f.name.trim() && f.rate !== "" && Number(f.rate) >= 0 && (f.method !== "FIXED_PLUS_VARIABLE" || (f.fixed !== "" && Number(f.fixed) >= 0));

  async function add() {
    const body = { key: "line.new", name: f.name, category, method: f.method, rate: isPct ? Number(f.rate) / 100 : Number(f.rate), fixed: f.method === "FIXED_PLUS_VARIABLE" ? Number(f.fixed) : undefined, unit, base: isPct ? f.base : undefined };
    if (await call(`/api/rate-library/${profile.id}/components`, "POST", body)) { setAdding(false); setF({ name: "", method: "PER_TON", rate: "", fixed: "", base: "MATERIAL_COST" }); onChanged(); }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">These lines are added to every pricing item that selects this profile (Summary tab → Rate profiles).</p>
        {canManage && !adding && <Button size="sm" onClick={() => setAdding(true)}><Plus /> Add line</Button>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-left">Line</th><th className="px-3 py-2 text-left">Method</th><th className="px-3 py-2 text-right">Rate</th><th className="px-3 py-2 text-center">On</th><th className="w-12" /></tr></thead>
          <tbody>
            {lines.map((c) => (
              <tr key={c.id} className="border-t border-border">
                <td className="px-3 py-2">{c.name}</td>
                <td className="px-3 py-2 text-muted-foreground">{METHOD_LABEL[c.method]}{c.method === "PERCENT_OF_BASE" && c.base ? ` of ${PERCENT_BASES.find((b) => b.id === c.base)?.label.toLowerCase()}` : ""}{c.method === "FIXED_PLUS_VARIABLE" ? ` (${money(c.fixed)} + per ${c.unit ?? "TON"})` : ""}</td>
                <td className="px-2 py-1 text-right"><Input aria-label={`Rate of ${c.name}`} type="number" min={0} step="any" disabled={!canManage} key={`${c.id}${c.rate}`} defaultValue={c.method === "PERCENT_OF_BASE" ? toInput("pct", c.rate) : c.rate} onBlur={async (e) => { const n = Number(e.target.value); const rate = c.method === "PERCENT_OF_BASE" ? n / 100 : n; if (e.target.value !== "" && n >= 0 && rate !== c.rate && (await call(`/api/rate-library/components/${c.id}`, "PATCH", { rate }))) onChanged(); }} className="ml-auto h-8 w-28 text-right" /></td>
                <td className="px-3 py-2 text-center"><Switch aria-label={`Enable ${c.name}`} checked={c.enabled} disabled={!canManage} onCheckedChange={async (v) => { if (await call(`/api/rate-library/components/${c.id}`, "PATCH", { enabled: v })) onChanged(); }} /></td>
                <td className="px-2 text-right">{canManage && <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label={`Remove ${c.name}`} onClick={async () => { if (await call(`/api/rate-library/components/${c.id}`, "DELETE")) onChanged(); }}><Trash2 /></Button>}</td>
              </tr>
            ))}
            {adding && (
              <tr className="border-t border-border bg-primary/5">
                <td className="px-2 py-1"><Input aria-label="Line name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Crane" /></td>
                <td className="px-2 py-1">
                  <select aria-label="Method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} className="h-9 w-full rounded-lg border border-input bg-card px-2 text-sm">{LINE_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select>
                  {isPct && <select aria-label="Percentage of" value={f.base} onChange={(e) => setF({ ...f, base: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-input bg-card px-2 text-sm">{bases.map((b) => <option key={b.id} value={b.id}>of {b.label.toLowerCase()}</option>)}</select>}
                  {f.method === "FIXED_PLUS_VARIABLE" && <Input aria-label="Fixed part" type="number" min={0} value={f.fixed} onChange={(e) => setF({ ...f, fixed: e.target.value })} placeholder="Fixed part (EGP)" className="mt-1" />}
                </td>
                <td className="px-2 py-1"><Input aria-label="Rate" type="number" min={0} value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder={isPct ? "%" : unit ? `EGP / ${unit}` : "EGP"} className="w-28 text-right" /></td>
                <td />
                <td className="px-2 py-1 text-right whitespace-nowrap"><Button variant="ghost" size="icon" className="h-7 w-7 text-success" aria-label="Save line" disabled={!valid} onClick={add}><Check /></Button><Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setAdding(false)}>Cancel</Button></td>
              </tr>
            )}
            {!lines.length && !adding && <tr><td colSpan={5} className="px-3 py-8 text-center text-sm text-muted-foreground">No lines in this profile yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
