"use client";
import * as React from "react";
import { AlertTriangle, Check, CircleAlert, Eye, FileText, LayoutTemplate, Loader2, Lock, LockOpen, Save, ShieldCheck, Calculator } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { CalcIssue } from "../calc";
import type { SheetStatus } from "../workflow";
import { ISSUE_TAB, countIssues, type ActionState, type SheetActions, type TrackerStage } from "../sheet-view";
import type { EstimateDoc } from "../types";

/** Marks something that is a working assumption the company has not approved yet (listed in the README). */
export function NeedsApproval({ why }: { why: string }) {
  return <span title={`Needs approval: ${why}`} className="ml-1.5 inline-flex items-center whitespace-nowrap rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">needs approval</span>;
}

const STATUS_TONE: Record<SheetStatus, string> = { DRAFT: "bg-slate-100 text-slate-700", CALCULATED: "bg-blue-50 text-blue-700", APPROVED: "bg-emerald-50 text-emerald-700" };
export function SheetStatusBadge({ status }: { status: SheetStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold", STATUS_TONE[status])}>
      {status === "APPROVED" ? <Lock className="h-3 w-3" /> : status === "CALCULATED" ? <Calculator className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
      {status === "DRAFT" ? "Draft" : status === "CALCULATED" ? "Calculated" : "Approved"}
    </span>
  );
}

/** Messages of one line shown right under its field: errors in red, warnings in amber. */
export function FieldIssues({ issues }: { issues: CalcIssue[] }) {
  if (!issues.length) return null;
  return <div className="mt-0.5 space-y-0.5">{issues.map((i, n) => <div key={n} role={i.level === "error" ? "alert" : undefined} className={cn("text-[11px] leading-snug", i.level === "error" ? "text-destructive" : "text-amber-700")}>{i.message}</div>)}</div>;
}

// ------------------------------------------------------------------ header

export function SheetHeader({ doc, dirty, stages, onStage }: { doc: EstimateDoc; dirty: boolean; stages: TrackerStage[]; onStage: (k: TrackerStage["key"]) => void }) {
  const s = doc.sheet;
  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold text-primary">{doc.project.name}</h1>
          <p className="text-sm text-muted-foreground">{doc.project.number} · Customer: {doc.project.customer || "—"}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl bg-secondary px-4 py-2 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">Sheet</dt><dd className="font-semibold tabular-nums">{s.number ?? "—"}{s.number && <NeedsApproval why="the PS-<project number> numbering format" />}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Version</dt><dd className="font-semibold tabular-nums">v{s.version}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Status</dt><dd className="flex items-center gap-1.5"><SheetStatusBadge status={s.status} />{dirty && <span className="text-xs font-medium text-amber-700">· unsaved</span>}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Currency</dt><dd className="font-semibold">{doc.currency}</dd></div>
        </dl>
      </div>
      <ol className="grid gap-2 sm:grid-cols-4" aria-label="Pricing stages">
        {stages.map((st, n) => (
          <li key={st.key}>
            <button type="button" onClick={() => onStage(st.key)} aria-current={st.state === "current" ? "step" : undefined}
              className={cn("flex w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition hover:border-primary/60", st.state === "current" ? "border-primary ring-1 ring-primary" : "border-border")}>
              <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white", st.state === "todo" ? "bg-slate-400" : "bg-primary")}>{st.state === "done" ? <Check className="h-3.5 w-3.5" /> : n + 1}</span>
              <span className="min-w-0"><span className="block truncate text-sm font-semibold">{st.label}</span><span className={cn("block text-[11px] font-medium", st.state === "done" ? "text-success" : st.state === "current" ? "text-primary" : "text-muted-foreground")}>{st.state === "done" ? "Completed" : st.state === "current" ? "In progress" : "Not started"}</span></span>
            </button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-x-6 gap-y-0.5 text-xs text-muted-foreground">
        <span>Last saved: {new Date(doc.updatedAt).toLocaleString()}</span>
        {s.calculatedAt && <span>Calculated: {new Date(s.calculatedAt).toLocaleString()}</span>}
        {s.approvedAt && <span>Approved: {new Date(s.approvedAt).toLocaleString()}</span>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ action bar

function Act({ state, onClick, busy, variant = "outline", icon, children }: { state: ActionState; onClick: () => void; busy?: boolean; variant?: "default" | "outline" | "destructive"; icon: React.ReactNode; children: React.ReactNode }) {
  if (!state.visible) return null;
  return (
    <span title={!state.enabled ? state.reason : undefined} className="inline-flex">
      <Button variant={variant} onClick={onClick} disabled={!state.enabled || busy}>{busy ? <Loader2 className="animate-spin" /> : icon}{children}</Button>
    </span>
  );
}

export function ActionBar({ actions, busy, onSave, onCalculate, onApprove, onReopen, onTemplates, onPreview }: { actions: SheetActions; busy: string | null; onSave: () => void; onCalculate: () => void; onApprove: () => void; onReopen: () => void; onTemplates: () => void; onPreview: () => void }) {
  const hint = actions.locked ? "This sheet is approved and locked (read-only). Reopen it to create a new version." : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Act state={actions.save} onClick={onSave} busy={busy === "save"} icon={<Save />}>Save Draft</Act>
        <Act state={actions.calculate} onClick={onCalculate} busy={busy === "calculate"} icon={<Calculator />}>Calculate</Act>
        <Act state={actions.approve} onClick={onApprove} busy={busy === "approve"} variant="default" icon={<ShieldCheck />}>Approve</Act>
        <Act state={actions.reopen} onClick={onReopen} busy={busy === "reopen"} icon={<LockOpen />}>Reopen{actions.reopen.visible && <NeedsApproval why="reopening needs pricing.approve (ADMIN only)" />}</Act>
        <span className="mx-1 hidden h-6 w-px bg-border sm:block" />
        <Act state={actions.templates} onClick={onTemplates} icon={<LayoutTemplate />}>Templates</Act>
        <Button variant="outline" onClick={onPreview}><Eye /> Quotation preview</Button>
      </div>
      {hint && <p className="flex items-center gap-1.5 text-sm text-emerald-700"><Lock className="h-3.5 w-3.5" />{hint}</p>}
    </div>
  );
}

export function ReopenDialog({ open, onOpenChange, onConfirm, busy, error }: { open: boolean; onOpenChange: (v: boolean) => void; onConfirm: (reason: string) => void; busy: boolean; error: string | null }) {
  const [reason, setReason] = React.useState("");
  const [touched, setTouched] = React.useState(false);
  const short = reason.trim().length < 3;
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { setReason(""); setTouched(false); } onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen approved sheet</DialogTitle>
          <DialogDescription>The sheet goes back to Draft as a new version. The approved snapshot and everything issued from it stay exactly as they are.</DialogDescription>
        </DialogHeader>
        <label className="block space-y-1">
          <span className="text-sm font-semibold">Reason <span className="text-destructive">*</span></span>
          <textarea className="min-h-[88px] w-full rounded-md border border-input bg-card px-2 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} onBlur={() => setTouched(true)} aria-invalid={touched && short} placeholder="Why does this approved sheet need to change?" />
          {touched && short && <span role="alert" className="block text-xs text-destructive">Give a reason of at least 3 characters.</span>}
          {error && <span role="alert" className="block text-xs text-destructive">{error}</span>}
        </label>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={() => { setTouched(true); if (!short) onConfirm(reason.trim()); }} disabled={busy || short}>{busy ? <Loader2 className="animate-spin" /> : <LockOpen />} Reopen sheet</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ issues panel

export function IssuesPanel({ issues, onGo }: { issues: CalcIssue[]; onGo: (tab: (typeof ISSUE_TAB)[CalcIssue["scope"]]) => void }) {
  const { errors, warnings } = countIssues(issues);
  const [open, setOpen] = React.useState(true);
  if (!issues.length) return <div className="flex items-center gap-2 rounded-xl border border-success/30 bg-success/5 px-4 py-2.5 text-sm"><Check className="h-4 w-4 text-success" /> No issues. The sheet can be calculated and approved.</div>;
  const sorted = [...issues].sort((a, b) => Number(b.level === "error") - Number(a.level === "error"));
  return (
    <div className={cn("rounded-xl border", errors ? "border-destructive/40 bg-destructive/5" : "border-amber-300 bg-amber-50/60")}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left" aria-expanded={open}>
        <span className="flex items-center gap-2 text-sm font-semibold">{errors ? <CircleAlert className="h-4 w-4 text-destructive" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}Issues
          {errors > 0 && <span className="rounded-full bg-destructive px-2 py-0.5 text-xs text-white">{errors} error{errors > 1 ? "s" : ""}</span>}
          {warnings > 0 && <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs text-white">{warnings} warning{warnings > 1 ? "s" : ""}</span>}
        </span>
        <span className="text-xs text-muted-foreground">{errors ? "Errors block Calculate and Approve" : "Warnings do not block anything"}</span>
      </button>
      {open && (
        <ul className="divide-y border-t">
          {sorted.map((i, n) => (
            <li key={n} className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
              <span className={i.level === "error" ? "text-destructive" : "text-amber-800"}><b className="mr-1.5 text-xs uppercase">{i.level}</b>{i.message}</span>
              <button type="button" className="shrink-0 text-xs text-primary hover:underline" onClick={() => onGo(ISSUE_TAB[i.scope])}>Go to {i.scope === "projectCost" ? "project costs" : i.scope === "operation" || i.scope === "subcontract" ? "manufacturing" : i.scope === "commercial" ? "commercial" : "materials"}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
