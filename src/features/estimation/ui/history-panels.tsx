"use client";
import * as React from "react";
import { Check, ChevronDown, ChevronRight, GitCompare, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { defaultComparePair, formatValue, normalizeChanges, snapshotOverview } from "../sheet-view";
import type { SnapshotDelta } from "../workflow";
import type { EstAuditRow, EstSnapshotFull, EstVersionRow } from "../types";
import { api } from "./api";
import { SourceBadge, egp, kg, selectCls } from "./fields";

const fmtTime = (iso: string) => new Date(iso).toLocaleString();
const Loading = ({ what }: { what: string }) => <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading {what}…</div>;
const ErrorBox = ({ message, onRetry }: { message: string; onRetry: () => void }) => <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{message} <Button variant="outline" size="sm" className="ml-3" onClick={onRetry}>Retry</Button></div>;

export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified
    ? <span title="Recomputing the stored inputs gives exactly the stored result" className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"><Check className="h-3 w-3" /> Verified</span>
    : <span title="Recomputing the stored inputs does NOT give the stored result. Do not rely on this snapshot." className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"><ShieldAlert className="h-3 w-3" /> Not verified</span>;
}

// ------------------------------------------------------------------ versions

/** Stored snapshots of the sheet (calculated and approved), what exactly one of them holds, and the difference between two. */
export function VersionsPanel({ projectId, refreshKey, cur, nameOf }: { projectId: string; refreshKey: number; cur: string; nameOf: (itemId: string) => string | null }) {
  const [rows, setRows] = React.useState<EstVersionRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const [view, setView] = React.useState<string | null>(null);
  const [pair, setPair] = React.useState<{ from: string; to: string } | null>(null);
  const [cmp, setCmp] = React.useState<{ from: EstVersionRow; to: EstVersionRow; deltas: SnapshotDelta[] } | null>(null);
  const [cmpError, setCmpError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    api<{ versions: EstVersionRow[] }>(`/api/projects/${projectId}/estimation/versions`, "GET").then((r) => {
      if (cancelled) return;
      if (r.ok) { setError(null); setRows(r.data.versions); setPair((p) => p ?? defaultComparePair(r.data.versions)); } else setError(r.error);
    });
    return () => { cancelled = true; };
  }, [projectId, refreshKey, tick]);

  async function compare() {
    if (!pair) return;
    setCmpError(null); setCmp(null);
    if (pair.from === pair.to) { setCmpError("Choose two different versions."); return; }
    const r = await api<{ from: EstVersionRow; to: EstVersionRow; deltas: SnapshotDelta[] }>(`/api/projects/${projectId}/estimation/versions/compare?from=${encodeURIComponent(pair.from)}&to=${encodeURIComponent(pair.to)}`, "GET");
    if (r.ok) setCmp(r.data); else setCmpError(r.error);
  }

  if (error) return <ErrorBox message={error} onRetry={() => setTick((t) => t + 1)} />;
  if (!rows) return <Loading what="versions" />;
  if (!rows.length) return <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No versions yet. Each Calculate and each Approve stores an immutable snapshot here.</div>;
  const label = (r: EstVersionRow) => `v${r.version} · ${r.kind === "APPROVED" ? "Approved" : "Calculated"} · ${fmtTime(r.createdAt)}`;
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b bg-secondary/50"><tr>{["Version", "Kind", "Created", "Cost", "Final price", "Check", ""].map((h, i) => <th key={i} className={cn("px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground", (h === "Cost" || h === "Final price") && "text-right")}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className="border-b last:border-0">
              <td className="px-3 py-2 font-semibold tabular-nums">v{r.version}</td>
              <td className="px-3 py-2"><span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", r.kind === "APPROVED" ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700")}>{r.kind === "APPROVED" ? "Approved" : "Calculated"}</span>{r.note && <span className="ml-2 text-xs text-muted-foreground">{r.note}</span>}</td>
              <td className="px-3 py-2 text-muted-foreground">{fmtTime(r.createdAt)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{r.costTotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
              <td className="px-3 py-2 text-right font-semibold tabular-nums">{r.finalPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })} {cur}</td>
              <td className="px-3 py-2"><VerifiedBadge verified={r.verified} /></td>
              <td className="px-3 py-2 text-right"><Button variant="outline" size="sm" onClick={() => setView(r.id)}>What was {r.kind === "APPROVED" ? "approved" : "calculated"}</Button></td>
            </tr>))}</tbody>
        </table>
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-2 font-semibold"><GitCompare className="h-4 w-4 text-primary" /> Compare two versions</div>
        {rows.length < 2 ? <p className="text-sm text-muted-foreground">At least two versions are needed to compare.</p> : (
          <>
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="block space-y-1"><span className="text-xs font-semibold">From</span><select className={selectCls} value={pair?.from ?? ""} onChange={(e) => setPair((p) => ({ from: e.target.value, to: p?.to ?? "" }))}>{rows.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}</select></label>
              <label className="block space-y-1"><span className="text-xs font-semibold">To</span><select className={selectCls} value={pair?.to ?? ""} onChange={(e) => setPair((p) => ({ from: p?.from ?? "", to: e.target.value }))}>{rows.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}</select></label>
              <Button onClick={() => void compare()} disabled={!pair}>Compare</Button>
            </div>
            {cmpError && <p role="alert" className="text-xs text-destructive">{cmpError}</p>}
            {cmp && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="border-b"><tr><th className="py-2 text-left text-xs font-semibold uppercase text-muted-foreground">Line</th><th className="py-2 text-right text-xs font-semibold uppercase text-muted-foreground">v{cmp.from.version} ({cmp.from.kind === "APPROVED" ? "approved" : "calc."})</th><th className="py-2 text-right text-xs font-semibold uppercase text-muted-foreground">v{cmp.to.version} ({cmp.to.kind === "APPROVED" ? "approved" : "calc."})</th><th className="py-2 text-right text-xs font-semibold uppercase text-muted-foreground">Change</th></tr></thead>
                  <tbody>{cmp.deltas.map((d) => (
                    <tr key={d.key} className="border-b last:border-0"><td className="py-1.5">{d.label}</td><td className="py-1.5 text-right tabular-nums">{egp(d.fromCents)}</td><td className="py-1.5 text-right tabular-nums">{egp(d.toCents)}</td>
                      <td className={cn("py-1.5 text-right font-semibold tabular-nums", d.deltaCents > 0 ? "text-destructive" : d.deltaCents < 0 ? "text-emerald-700" : "text-muted-foreground")}>{d.deltaCents > 0 ? "+" : ""}{egp(d.deltaCents)}</td></tr>))}</tbody>
                </table>
                {cmp.deltas.every((d) => d.deltaCents === 0) && <p className="mt-2 text-sm text-muted-foreground">No difference in the cost build-up.</p>}
              </div>
            )}
          </>
        )}
      </div>
      <SnapshotDialog projectId={projectId} snapshotId={view} onClose={() => setView(null)} cur={cur} nameOf={nameOf} />
    </div>
  );
}

// ------------------------------------------------------------------ one snapshot in full

export function SnapshotDialog({ projectId, snapshotId, onClose, cur, nameOf }: { projectId: string; snapshotId: string | null; onClose: () => void; cur: string; nameOf: (itemId: string) => string | null }) {
  const [snap, setSnap] = React.useState<{ id: string; data: EstSnapshotFull } | null>(null);
  const [err, setErr] = React.useState<{ id: string; message: string } | null>(null);
  React.useEffect(() => {
    if (!snapshotId) return;
    let cancelled = false;
    api<EstSnapshotFull>(`/api/projects/${projectId}/estimation/versions/${encodeURIComponent(snapshotId)}`, "GET").then((r) => {
      if (cancelled) return;
      if (r.ok) setSnap({ id: snapshotId, data: r.data }); else setErr({ id: snapshotId, message: r.error });
    });
    return () => { cancelled = true; };
  }, [projectId, snapshotId]);
  const data = snapshotId && snap?.id === snapshotId ? snap.data : null;
  const error = snapshotId && err?.id === snapshotId ? err.message : null;
  const o = data ? snapshotOverview(data, nameOf) : null;
  return (
    <Dialog open={!!snapshotId} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-h-[88vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{data ? `v${data.version} · ${data.kind === "APPROVED" ? "Approved" : "Calculated"} snapshot` : "Snapshot"}</DialogTitle>
          <DialogDescription>Exactly what was stored: the inputs and the figures calculated from them. It cannot change.</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!o && !error && <Loading what="snapshot" />}
        {o && data && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-3"><VerifiedBadge verified={o.verified} /><span className="text-muted-foreground">{fmtTime(data.createdAt)}</span></div>
            <dl className="grid gap-x-6 gap-y-1 rounded-xl bg-secondary/60 p-3 sm:grid-cols-3">
              {([["Material", o.totals.materialCents], ["Manufacturing", o.totals.manufacturingCents], ["Subcontractor", o.totals.subcontractorCents], ["Project costs", o.totals.projectCents], ["Estimated cost", o.totals.estimatedCostCents], ["Profit", o.commercial.profitCents], ["Insurance", o.commercial.insuranceCents], ["Other charges", o.commercial.otherChargesCents], ["Discount", o.commercial.discountCents], ["Tax", o.commercial.taxCents]] as [string, number][]).map(([l, v]) => <div key={l} className="flex justify-between gap-3"><dt className="text-muted-foreground">{l}</dt><dd className="tabular-nums">{egp(v)}</dd></div>)}
              <div className="flex justify-between gap-3 font-bold sm:col-span-3"><dt>Final price ({cur})</dt><dd className="tabular-nums text-primary">{egp(o.commercial.finalCents)}</dd></div>
            </dl>
            <p className="text-xs text-muted-foreground">{o.counts.materials} material lines · {o.counts.items} items · {o.counts.operations} selected operations · {o.counts.subcontracts} subcontractor services · {o.counts.projectCosts} project costs</p>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Items</div>
              <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-[640px] text-xs"><thead className="bg-secondary/50"><tr>{["Item", "Weight kg", "Material", "Manuf.", "Subcontract", "Project", "Cost", "Price share"].map((h, i) => <th key={h} className={cn("px-2 py-1.5 font-semibold", i ? "text-right" : "text-left")}>{h}</th>)}</tr></thead>
                <tbody>{o.items.map((i) => <tr key={i.id} className="border-t"><td className="px-2 py-1">{i.name}</td><td className="px-2 py-1 text-right tabular-nums">{kg(i.weightKg)}</td><td className="px-2 py-1 text-right tabular-nums">{egp(i.materialCents)}</td><td className="px-2 py-1 text-right tabular-nums">{egp(i.manufacturingCents)}</td><td className="px-2 py-1 text-right tabular-nums">{egp(i.subcontractCents)}</td><td className="px-2 py-1 text-right tabular-nums">{egp(i.projectCents)}</td><td className="px-2 py-1 text-right tabular-nums font-medium">{egp(i.costCents)}</td><td className="px-2 py-1 text-right tabular-nums font-medium">{egp(i.finalCents)}</td></tr>)}</tbody></table></div>
            </div>
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Material lines</div>
              <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-[560px] text-xs"><thead className="bg-secondary/50"><tr>{["Material", "Price source", "Purchased kg", "Price / kg", "Cost"].map((h, i) => <th key={h} className={cn("px-2 py-1.5 font-semibold", i > 1 ? "text-right" : "text-left")}>{h}</th>)}</tr></thead>
                <tbody>{o.materials.map((m) => <tr key={m.id} className="border-t"><td className="px-2 py-1">{m.name}</td><td className="px-2 py-1"><SourceBadge source={m.priceSource} /></td><td className="px-2 py-1 text-right tabular-nums">{kg(m.purchasedKg)}</td><td className="px-2 py-1 text-right tabular-nums">{m.unitPrice}</td><td className="px-2 py-1 text-right tabular-nums font-medium">{egp(m.totalCents)}</td></tr>)}</tbody></table></div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ audit

const ACTION_TONE: Record<string, string> = { APPROVE: "bg-emerald-50 text-emerald-700", REOPEN: "bg-amber-50 text-amber-800", RECALCULATE: "bg-blue-50 text-blue-700", TEMPLATE: "bg-violet-50 text-violet-700", RESTORE: "bg-slate-100 text-slate-700", SYNC: "bg-slate-100 text-slate-700", SAVE: "bg-slate-100 text-slate-700" };

/** Who changed what, field by field (the server writes these entries inside the same transaction as the change). */
export function AuditPanel({ projectId, refreshKey }: { projectId: string; refreshKey: number }) {
  const [rows, setRows] = React.useState<EstAuditRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const [action, setAction] = React.useState("");
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    let cancelled = false;
    api<{ entries: EstAuditRow[] }>(`/api/projects/${projectId}/estimation/audit?take=200`, "GET").then((r) => {
      if (cancelled) return;
      if (r.ok) { setError(null); setRows(r.data.entries); } else setError(r.error);
    });
    return () => { cancelled = true; };
  }, [projectId, refreshKey, tick]);
  if (error) return <ErrorBox message={error} onRetry={() => setTick((t) => t + 1)} />;
  if (!rows) return <Loading what="audit trail" />;
  const actions = [...new Set(rows.map((r) => r.action))];
  const shown = action ? rows.filter((r) => r.action === action) : rows;
  if (!rows.length) return <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No changes recorded yet.</div>;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3"><label className="text-sm font-semibold" htmlFor="audit-filter">Action</label><select id="audit-filter" className={cn(selectCls, "w-48")} value={action} onChange={(e) => setAction(e.target.value)}><option value="">All</option>{actions.map((a) => <option key={a} value={a}>{a}</option>)}</select><span className="text-xs text-muted-foreground">{shown.length} entr{shown.length === 1 ? "y" : "ies"}</span></div>
      <ul className="divide-y rounded-xl border border-border bg-card">
        {shown.map((r) => {
          const changes = normalizeChanges(r.changes); const isOpen = open.has(r.id);
          return (
            <li key={r.id} className="px-4 py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-semibold", ACTION_TONE[r.action] ?? ACTION_TONE.SAVE)}>{r.action}</span>
                <span className="min-w-0 flex-1">{r.summary}</span>
                <span className="text-xs text-muted-foreground">v{r.version} · user {r.userId.slice(0, 8)} · {fmtTime(r.createdAt)}</span>
                {changes.length > 0 && <button type="button" className="flex items-center gap-1 text-xs text-primary hover:underline" aria-expanded={isOpen} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })}>{isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}{changes.length} field change{changes.length > 1 ? "s" : ""}</button>}
              </div>
              {isOpen && (
                <div className="mt-2 overflow-x-auto rounded-lg border">
                  <table className="w-full min-w-[520px] text-xs"><thead className="bg-secondary/50"><tr><th className="px-2 py-1.5 text-left font-semibold">Record</th><th className="px-2 py-1.5 text-left font-semibold">Field</th><th className="px-2 py-1.5 text-left font-semibold">From</th><th className="px-2 py-1.5 text-left font-semibold">To</th></tr></thead>
                    <tbody>{changes.map((c, i) => <tr key={i} className="border-t"><td className="px-2 py-1"><span className="text-muted-foreground">{c.entity}</span> · {c.label}</td><td className="px-2 py-1">{c.field}</td><td className="px-2 py-1 text-muted-foreground">{formatValue(c.from)}</td><td className="px-2 py-1 font-medium">{formatValue(c.to)}</td></tr>)}</tbody></table>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
