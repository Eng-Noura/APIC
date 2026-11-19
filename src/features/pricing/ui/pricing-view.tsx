"use client";
import * as React from "react";
import { AlertTriangle, BadgeDollarSign, Calculator, ChevronDown, ChevronRight, FilePlus2, History, Loader2, Percent, Plus, Trash2, TrendingUp, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { KpiCard } from "@/components/shared/kpi-card";
import { useTakeoffProject } from "@/features/takeoff/project-context";
import { call } from "./api";
import { ItemPanel } from "./item-panel";
import { money, pct, qty as fmtQty, rate4 } from "./format";
import type { ItemDto, SheetView } from "./types";

const STATUS_TONE = { DRAFT: "gray", CALCULATED: "default", APPROVED: "success", SUPERSEDED: "warning" } as const;

function itemStatus(i: ItemDto): { label: string; tone: "success" | "destructive" | "warning" } {
  if (!i.calc.ok || !i.calc.summary) return { label: "Needs input", tone: "destructive" };
  if (i.calc.issues.some((x) => x.severity === "warning" && x.code !== "OPTIONAL_RATE_MISSING")) return { label: "Check", tone: "warning" };
  return { label: "Priced", tone: "success" };
}

/** Keyed by project so switching projects starts from a clean state (no reset effect needed). */
export function PricingView({ canEdit }: { canEdit: boolean }) {
  const { projectId } = useTakeoffProject();
  return <PricingInner key={projectId || "none"} canEdit={canEdit} />;
}

function PricingInner({ canEdit }: { canEdit: boolean }) {
  const { projectId, projects } = useTakeoffProject();
  const [view, setView] = React.useState<SheetView | null>(null);
  const [loading, setLoading] = React.useState(!!projectId);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [showHistory, setShowHistory] = React.useState(false);
  const [adding, setAdding] = React.useState<null | "scope" | "manual">(null);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());
  const [manual, setManual] = React.useState({ description: "", unit: "EA", qty: "1", unitWeightKg: "" });

  // Re-reads the sheet. Bumping `tick` re-runs the effect below; no state is set synchronously inside an effect.
  const [tick, setTick] = React.useState(0);
  const reload = React.useCallback(() => setTick((t) => t + 1), []);
  React.useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    call<SheetView>(`/api/pricing?projectId=${encodeURIComponent(projectId)}`, "GET", undefined, true).then((res) => {
      if (cancelled) return;
      if (!res) setError("Could not load the pricing sheet."); else { setError(null); setView(res); }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId, tick]);

  const sheet = view?.sheet ?? null;
  const items = view?.items ?? [];
  const locked = sheet?.status === "APPROVED" || sheet?.status === "SUPERSEDED";
  const projectName = projects.find((p) => p.id === projectId)?.name ?? "";

  async function createSheet() {
    setBusy(true);
    const r = await call<SheetView>("/api/pricing", "POST", { projectId });
    setBusy(false);
    if (r) { setView(r); toast.success("Pricing sheet created"); }
  }
  async function recalc() {
    if (!sheet) return;
    setBusy(true);
    const r = await call(`/api/pricing/${sheet.id}/calculate`, "POST");
    setBusy(false);
    if (r) { toast.success("Calculated and saved a snapshot"); reload(); }
  }
  async function addItems() {
    if (!sheet) return;
    const body = adding === "scope" ? { scopeItemIds: [...picked] } : { manual: { description: manual.description, unit: manual.unit, qty: Number(manual.qty), unitWeightKg: manual.unitWeightKg === "" ? undefined : Number(manual.unitWeightKg), scopeType: "Manual" } };
    setBusy(true);
    const r = await call(`/api/pricing/${sheet.id}/items`, "POST", body);
    setBusy(false);
    if (r) { setAdding(null); setPicked(new Set()); setManual({ description: "", unit: "EA", qty: "1", unitWeightKg: "" }); reload(); }
  }
  async function patch(i: ItemDto, data: Record<string, unknown>) {
    if (await call(`/api/pricing/items/${i.id}`, "PATCH", data)) reload();
  }
  async function remove(i: ItemDto) {
    if (!confirm(`Remove item ${i.itemNo} “${i.description}” from this pricing sheet?`)) return;
    if (await call(`/api/pricing/items/${i.id}`, "DELETE")) reload();
  }
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // ---------- states
  if (!projectId) return <EmptyState icon={<Wallet />} title="Select a project" description="Pricing works on the active project." />;
  if (loading && !view) return <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" /> Loading pricing…</div>;
  if (error && !view) return <EmptyState icon={<AlertTriangle />} title="Could not load pricing" description={error} action={<Button size="sm" variant="outline" onClick={() => { setError(null); setLoading(true); reload(); }}>Try again</Button>} />;
  if (!sheet) {
    return (
      <EmptyState icon={<BadgeDollarSign />} title="No pricing sheet for this project yet" description="Create one, then add the scope items from the Part List or manual lines such as equipment."
        action={canEdit ? <Button size="sm" disabled={busy} onClick={createSheet}><FilePlus2 /> Create pricing sheet</Button> : <p className="text-xs text-muted-foreground">You need edit permission to create one.</p>} />
    );
  }

  const t = view?.totals;
  const dash = !items.length || !t || t.priced === 0;
  return (
    <div className="space-y-5">
      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
        <div className="min-w-0 space-y-1">
          <p className="truncate text-sm font-semibold">{projectName}</p>
          <p className="text-xs text-muted-foreground">{sheet.reference} · v{sheet.version} · {new Date(sheet.date).toLocaleDateString("en-GB")} · {sheet.currency}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_TONE[sheet.status]}>{sheet.status.charAt(0) + sheet.status.slice(1).toLowerCase()}</Badge>
          <Button variant="outline" size="sm" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}><History /> History</Button>
          {canEdit && !locked && <Button size="sm" disabled={busy || !items.length} onClick={recalc}>{busy ? <Loader2 className="animate-spin" /> : <Calculator />} Recalculate</Button>}
        </div>
      </div>
      {showHistory && (
        <ul className="space-y-1 rounded-xl border border-border bg-card p-4 text-xs">
          {(view?.history ?? []).map((h) => <li key={h.id} className="flex gap-3"><span className="w-36 shrink-0 text-muted-foreground">{new Date(h.createdAt).toLocaleString("en-GB")}</span><span><b>{h.action}</b> — {h.message}</span></li>)}
          {!view?.history?.length && <li className="text-muted-foreground">No history yet.</li>}
        </ul>
      )}

      {/* KPIs — computed by the engine from current data */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total BOQ Cost" value={dash ? "—" : money(t!.totalCost)} icon={Wallet} tone="slate" hint="EGP" />
        <KpiCard label="Expected Profit" value={dash ? "—" : money(t!.profit)} icon={TrendingUp} tone="accent" hint="EGP" />
        <KpiCard label="Final Sale Price" value={dash ? "—" : money(t!.salePrice)} icon={BadgeDollarSign} tone="primary" hint={t && t.failed ? `${t.failed} item(s) not priced — excluded` : "EGP"} />
        <KpiCard label="Average Profit %" value={dash ? "—" : pct(t!.profitPct)} icon={Percent} tone="violet" hint="profit ÷ cost" />
      </div>

      {/* add items */}
      {canEdit && !locked && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="mr-auto text-sm font-semibold">BOQ Items</h3>
            <Button variant="outline" size="sm" onClick={() => setAdding(adding === "scope" ? null : "scope")}><Plus /> From scope items{view?.availableScope?.length ? ` (${view.availableScope.length})` : ""}</Button>
            <Button variant="outline" size="sm" onClick={() => setAdding(adding === "manual" ? null : "manual")}><Plus /> Manual line</Button>
          </div>
          {adding === "scope" && (
            <div className="space-y-2">
              {view?.availableScope?.length ? (
                <>
                  <ul className="max-h-52 space-y-1 overflow-auto text-sm">
                    {view.availableScope.map((s) => (
                      <li key={s.id}><label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-muted/50">
                        <input type="checkbox" checked={picked.has(s.id)} onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} />
                        <span className="flex-1">{s.description}</span><span className="text-xs text-muted-foreground">{s.partCount} parts · {fmtQty(s.weightKg / 1000)} t</span>
                      </label></li>
                    ))}
                  </ul>
                  <Button size="sm" disabled={busy || !picked.size} onClick={addItems}>Add {picked.size || ""} selected</Button>
                </>
              ) : <p className="text-xs text-muted-foreground">No scope items left to add. Create them in Part List → “Group as Scope”.</p>}
            </div>
          )}
          {adding === "manual" && (
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-48 flex-1 text-xs">Description<Input value={manual.description} onChange={(e) => setManual({ ...manual, description: e.target.value })} placeholder="e.g. Exhaust fan" /></label>
              <label className="w-24 text-xs">Unit<select value={manual.unit} onChange={(e) => setManual({ ...manual, unit: e.target.value })} className="h-9 w-full rounded-lg border border-input bg-card px-2 text-sm">{["EA", "TON", "KG", "SQM", "M"].map((u) => <option key={u}>{u}</option>)}</select></label>
              <label className="w-24 text-xs">Qty<Input type="number" min={0} value={manual.qty} onChange={(e) => setManual({ ...manual, qty: e.target.value })} /></label>
              <label className="w-32 text-xs">Unit weight (kg)<Input type="number" min={0} value={manual.unitWeightKg} onChange={(e) => setManual({ ...manual, unitWeightKg: e.target.value })} /></label>
              <Button size="sm" disabled={busy || manual.description.trim().length < 2 || manual.qty === "" || Number(manual.qty) < 0} onClick={addItems}>Add line</Button>
            </div>
          )}
        </div>
      )}

      {/* items table */}
      {!items.length ? (
        <EmptyState icon={<BadgeDollarSign />} title="No items on this sheet" description={canEdit ? "Add scope items or a manual line to start pricing." : "Nothing has been added yet."} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[1000px] text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="w-8" /><th className="px-3 py-2 text-left">Item</th><th className="px-3 py-2 text-left">Description</th><th className="px-3 py-2 text-left">Unit</th>
                <th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-right">Unit wt (kg)</th><th className="px-3 py-2 text-right">Total wt (kg)</th>
                <th className="px-3 py-2 text-left">Scope</th><th className="px-3 py-2 text-right">Unit rate</th><th className="px-3 py-2 text-right">Total price</th><th className="px-3 py-2 text-right">Profit %</th><th className="px-3 py-2 text-left">Status</th><th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const st = itemStatus(i);
                const isOpen = open.has(i.id);
                const editable = canEdit && !locked;
                return (
                  <React.Fragment key={i.id}>
                    <tr className="border-t border-border hover:bg-muted/30">
                      <td className="px-2"><button type="button" aria-expanded={isOpen} aria-label={isOpen ? "Collapse item" : "Expand item"} onClick={() => toggle(i.id)} className="rounded p-1 hover:bg-secondary">{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></td>
                      <td className="px-3 py-2 font-medium">{i.itemNo}</td>
                      <td className="max-w-64 truncate px-3 py-2" title={i.description}>{i.description}</td>
                      <td className="px-3 py-2">{i.unit}</td>
                      <td className="px-2 py-1 text-right">{editable ? <Input aria-label={`Quantity of item ${i.itemNo}`} type="number" min={0} step="any" defaultValue={i.qty} key={`q${i.id}${i.qty}`} onBlur={(e) => { const n = Number(e.target.value); if (e.target.value !== "" && n >= 0 && n !== i.qty) void patch(i, { qty: n }); }} className="h-8 w-24 text-right" /> : fmtQty(i.qty)}</td>
                      <td className="px-2 py-1 text-right">{editable ? <Input aria-label={`Unit weight of item ${i.itemNo}`} type="number" min={0} step="any" defaultValue={i.unitWeightKg ?? ""} key={`w${i.id}${i.unitWeightKg}`} onBlur={(e) => { const n = e.target.value === "" ? null : Number(e.target.value); if ((n === null || n >= 0) && n !== i.unitWeightKg) void patch(i, { unitWeightKg: n }); }} className="h-8 w-24 text-right" /> : fmtQty(i.unitWeightKg)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtQty(i.totalWeightKg)}</td>
                      <td className="px-3 py-2 text-muted-foreground">{i.scopeType || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{rate4(i.calc.summary?.unitRate)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{money(i.calc.summary?.salePrice)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{pct(i.calc.summary?.profitPct)}</td>
                      <td className="px-3 py-2"><Badge variant={st.tone}>{st.label}</Badge></td>
                      <td className="px-2">{editable && <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label={`Remove item ${i.itemNo}`} onClick={() => remove(i)}><Trash2 /></Button>}</td>
                    </tr>
                    {isOpen && <tr className="border-t border-border bg-muted/20"><td colSpan={13}><ItemPanel item={i} projectId={projectId} canEdit={canEdit} locked={!!locked} onChanged={reload} /></td></tr>}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
