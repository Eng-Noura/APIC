"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, BadgeDollarSign, Calculator, Check, CheckCheck, ChevronDown, ChevronRight, ClipboardCheck, ClipboardList, Download, FileText, Handshake, History, Layers, Loader2, Package, Plus, Send, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { cn } from "@/lib/utils";
import {
  ALLOCATION_BASES, COST_TYPES, COST_TYPE_LABEL, COST_TYPE_UNIT, DISCOUNT_MODES, DISCOUNT_TIMINGS, OP_BASE_LABEL, OP_PERCENT_BASES, PROFIT_MODES, PROFIT_MODE_LABEL, PROJECT_BASE_LABEL, PROJECT_METHODS, PROJECT_METHOD_LABEL, PROJECT_PERCENT_BASES, PROJECT_METHOD_UNIT,
  operationQuantity, type CostType, type EstimateResult, type ProjectMethod,
} from "../calc";
import { DEFAULT_OPERATIONS, PAYMENT_TERMS } from "../defaults";
import { approvedSnapshotFor, buildItemRows, countIssues, indexIssues, issuesFor, liveEstimate, liveIssues, sheetActions, stageTracker, type Draft, type IssueIndex, type TrackerStage } from "../sheet-view";
import type { EstimateDoc, EstItem, EstOperation, EstProjectCost, EstSettings, EstSnapshotFull, EstSubcontract, EstVersionRow } from "../types";
import { api } from "./api";
import { Field, NumInput, SourceBadge, egp, egp0, inputCls, kg, selectCls } from "./fields";
import { AuditPanel, VersionsPanel } from "./history-panels";
import { ItemsTable } from "./items-table";
import { MaterialsTable } from "./materials-table";
import { OfferDialog } from "./offer-dialog";
import { QuotationPreviewDialog } from "./quotation-preview";
import { ActionBar, FieldIssues, IssuesPanel, NeedsApproval, ReopenDialog, SheetHeader } from "./sheet-parts";
import { ApplyTemplateDialog, ManageTemplatesDialog } from "./templates-ui";

type TabId = "materials" | "manufacturing" | "project" | "commercial" | "versions" | "audit";
const STAGE_TAB: Record<TrackerStage["key"], TabId> = { material: "materials", manufacturing: "manufacturing", project: "project", commercial: "commercial" };
const TAB_STAGE: Partial<Record<TabId, "material" | "manufacturing" | "project">> = { materials: "material", manufacturing: "manufacturing", project: "project" };
const TAB_LABEL: Record<TabId, string> = { materials: "Materials", manufacturing: "Manufacturing", project: "Project Costs", commercial: "Commercial Summary", versions: "Versions", audit: "Audit" };
let seq = 0;
const newId = () => `new-${Date.now().toString(36)}-${seq++}`;

export function EstimationView({ projectId, canEdit, canOffer, canApprove = false, canManageTemplates = false }: { projectId: string; canEdit: boolean; canOffer: boolean; canApprove?: boolean; canManageTemplates?: boolean }) {
  const router = useRouter();
  const [doc, setDoc] = React.useState<EstimateDoc | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<TabId>("materials");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [dirty, setDirty] = React.useState(false);
  const [confirm, setConfirm] = React.useState<{ title: string; description: string; run: () => void } | null>(null);
  const [dialog, setDialog] = React.useState<"approve" | "reopen" | "apply" | "manage" | "preview" | "offer" | null>(null);
  const [reopenError, setReopenError] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState<string | null>(null);
  const [refreshKey, setRefreshKey] = React.useState(0);

  const adopt = React.useCallback((d: EstimateDoc) => {
    setDoc(d); setDraft({ materials: d.materials, items: d.items, subcontracts: d.subcontracts, projectCosts: d.projectCosts, settings: d.settings }); setDirty(false); setRefreshKey((k) => k + 1);
  }, []);
  // Re-reads the estimate; bumping `tick` re-runs the effect (no setState is called synchronously inside it).
  const [tick, setTick] = React.useState(0);
  const load = React.useCallback(async () => { setTick((t) => t + 1); }, []);
  React.useEffect(() => {
    let cancelled = false;
    api<EstimateDoc>(`/api/projects/${projectId}/estimation`, "GET").then((r) => {
      if (cancelled) return;
      if (r.ok) { setError(null); adopt(r.data); } else setError(r.error);
    });
    return () => { cancelled = true; };
  }, [projectId, tick, adopt]);
  React.useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const locked = doc?.sheet.locked ?? false;
  const version = doc?.sheet.version ?? 0;

  // An APPROVED sheet shows what was approved: the figures of its approved snapshot, loaded from the server (never recalculated here).
  const [approvedSnap, setApprovedSnap] = React.useState<{ version: number; snap: EstSnapshotFull } | null>(null);
  const [snapError, setSnapError] = React.useState<string | null>(null);
  const [snapTick, setSnapTick] = React.useState(0);
  React.useEffect(() => {
    if (!locked) return;
    let cancelled = false;
    (async () => {
      const v = await api<{ versions: EstVersionRow[] }>(`/api/projects/${projectId}/estimation/versions`, "GET");
      if (cancelled) return;
      if (!v.ok) { setSnapError(v.error); return; }
      const row = approvedSnapshotFor(v.data.versions, version);
      if (!row) { setSnapError("The approved snapshot of this version was not found."); return; }
      const s = await api<EstSnapshotFull>(`/api/projects/${projectId}/estimation/versions/${encodeURIComponent(row.id)}`, "GET");
      if (cancelled) return;
      if (s.ok) { setSnapError(null); setApprovedSnap({ version, snap: s.data }); } else setSnapError(s.error);
    })();
    return () => { cancelled = true; };
  }, [projectId, locked, version, snapTick]);
  const approved = locked && approvedSnap?.version === version ? approvedSnap.snap : null;

  // Live recalculation with the SAME functions and the SAME inputs the server uses; the server's figures replace these after every save.
  const live = React.useMemo(() => (draft ? liveEstimate(draft) : null), [draft]);

  const edit = (fn: (d: Draft) => Draft) => { setDraft((d) => (d ? fn(d) : d)); setDirty(true); };

  /** Problems that must be fixed before saving (the server checks the same things again). */
  function validate(d: Draft): string | null {
    for (const m of d.materials) if (!m.name.trim()) return "Every material needs a name.";
    for (const i of d.items) {
      if (!i.name.trim()) return "Every item needs a name.";
      for (const o of i.operations) {
        if (!o.name.trim()) return `Give every operation of "${i.name}" a name.`;
        if (o.costType === "PERCENTAGE" && !o.percentBase) return `Choose what the percentage applies to for "${o.name}" (${i.name}).`;
      }
    }
    for (const s of d.subcontracts) { if (!s.name.trim()) return "Every subcontractor service needs a name."; if (!s.unit.trim()) return `Enter a unit for "${s.name}".`; }
    for (const c of d.projectCosts) { if (!c.name.trim()) return "Every project cost needs a name."; if (c.method === "PERCENTAGE" && !c.percentBase) return `Choose what the percentage applies to for "${c.name}".`; }
    if (d.settings.profitMode === "MARGIN_ON_PRICE" && d.settings.profitValue >= 100) return "A margin on price must be below 100%.";
    return null;
  }

  async function save(stageDone?: { material?: boolean; manufacturing?: boolean; project?: boolean }, quiet = false): Promise<boolean> {
    if (!doc || !draft) return false;
    const problem = validate(draft);
    if (problem) { toast.error(problem); return false; }
    setBusy("save");
    const r = await api<EstimateDoc>(`/api/projects/${projectId}/estimation`, "PUT", { baseUpdatedAt: doc.updatedAt, settings: draft.settings, materials: draft.materials, items: draft.items, subcontracts: draft.subcontracts, projectCosts: draft.projectCosts, stageDone });
    setBusy(null);
    if (!r.ok) { toast.error(r.error); return false; }
    adopt(r.data); if (!quiet) toast.success("Draft saved");
    return true;
  }
  /** Unsaved edits are saved first, so the server always works on exactly what is on the screen. */
  const ensureSaved = async () => (dirty ? save(undefined, true) : true);

  /** POST a workflow action; the server answers with the whole sheet, which replaces the page's copy. */
  async function act(name: string, path: string, body: unknown, ok: string): Promise<boolean> {
    setBusy(name);
    const r = await api<EstimateDoc>(`/api/projects/${projectId}/estimation/${path}`, "POST", body);
    setBusy(null);
    if (!r.ok) { toast.error(r.error); return false; }
    adopt(r.data); toast.success(ok);
    return true;
  }
  async function calculate() { if (await ensureSaved()) await act("calculate", "calculate", undefined, "Calculated: snapshot stored"); }
  async function approve() { setDialog(null); await act("approve", "approve", undefined, "Approved: the sheet is locked"); }
  async function reopen(reason: string) {
    setReopenError(null); setBusy("reopen");
    const r = await api<EstimateDoc>(`/api/projects/${projectId}/estimation/reopen`, "POST", { reason });
    setBusy(null);
    if (!r.ok) { setReopenError(r.error); return; }
    adopt(r.data); setDialog(null); toast.success(`Reopened as v${r.data.sheet.version}`);
  }
  async function restore(materialId: string) {
    if (!(await ensureSaved())) return;
    setRestoring(materialId);
    const r = await api<EstimateDoc>(`/api/projects/${projectId}/estimation/restore`, "POST", { materialId });
    setRestoring(null);
    if (!r.ok) { toast.error(r.error); return; }
    adopt(r.data); toast.success("Imported values restored");
  }
  async function markDone(key: "material" | "manufacturing" | "project") { await save({ [key]: true }); }
  async function download() {
    if (canEdit && dirty && !(await save(undefined, true))) return;
    window.open(`/print/projects/${projectId}/estimate-quotation`, "_blank");
  }

  if (error) return <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">{error} <Button variant="outline" size="sm" className="ml-3" onClick={() => void load()}>Retry</Button></div>;
  if (!doc || !draft || !live) return <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Loading estimate…</div>;

  const cur = doc.currency;
  const status = doc.sheet.status;
  // Figures: an approved sheet and a saved one show the server's totals; only unsaved edits show the live recalculation.
  const t = locked || !dirty ? doc.totals : { ...live.totals, ...live.commercial };
  const c = t;
  const issues = locked || !dirty ? doc.issues : liveIssues(live, draft.materials);
  const ix: IssueIndex = indexIssues(issues);
  const { errors } = countIssues(issues);
  const actions = sheetActions({ status, dirty, errors, canEdit, canApprove });
  const dis = !actions.fieldsEditable;
  const result: EstimateResult | null = locked ? approved?.result ?? null : live;
  const stages = stageTracker(status, doc.stageDone);
  const rows = buildItemRows(doc);
  const ask = (title: string, description: string, run: () => void) => setConfirm({ title, description, run });
  const nameOf = (id: string) => doc.items.find((i) => i.id === id)?.name ?? null;
  const stageKey = TAB_STAGE[tab];
  const stageDone = stageKey ? doc.stageDone[stageKey] : false;
  const waitingForSnapshot = locked && !result;

  return (
    <div className="space-y-5">
      <SheetHeader doc={doc} dirty={dirty} stages={stages} onStage={(k) => setTab(STAGE_TAB[k])} />
      <ActionBar actions={actions} busy={busy} onSave={() => void save()} onCalculate={() => void calculate()} onApprove={() => setDialog("approve")} onReopen={() => { setReopenError(null); setDialog("reopen"); }} onTemplates={() => setDialog("apply")} onPreview={() => setDialog("preview")} />
      <IssuesPanel issues={issues} onGo={(tb) => setTab(tb)} />
      {snapError && locked && <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{snapError} <Button variant="outline" size="sm" className="ml-3" onClick={() => setSnapTick((x) => x + 1)}>Retry</Button></div>}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-5">
          <section className="space-y-2" aria-label="Items">
            <h2 className="flex items-center gap-2 text-lg font-bold text-primary"><Layers className="h-5 w-5" /> Items</h2>
            <ItemsTable rows={rows} result={result} cur={cur} />
          </section>

          <Tabs value={tab} onChange={(v) => setTab(v as TabId)} tabs={[
            { id: "materials", label: TAB_LABEL.materials, icon: Package }, { id: "manufacturing", label: TAB_LABEL.manufacturing, icon: Settings2 }, { id: "project", label: TAB_LABEL.project, icon: ClipboardList },
            { id: "commercial", label: TAB_LABEL.commercial, icon: Calculator }, { id: "versions", label: TAB_LABEL.versions, icon: History }, { id: "audit", label: TAB_LABEL.audit, icon: ClipboardCheck },
          ]} />

          {tab === "versions" && <VersionsPanel projectId={projectId} refreshKey={refreshKey} cur={cur} nameOf={nameOf} />}
          {tab === "audit" && <AuditPanel projectId={projectId} refreshKey={refreshKey} />}
          {waitingForSnapshot && ["materials", "manufacturing", "project"].includes(tab) && !snapError && <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the approved figures…</div>}
          {result && !waitingForSnapshot && tab === "materials" && <MaterialStage draft={draft} result={result} edit={edit} dis={dis} cur={cur} ask={ask} ix={ix} restoring={restoring} onRestore={(id) => void restore(id)} />}
          {result && !waitingForSnapshot && tab === "manufacturing" && <ManufacturingStage draft={draft} result={result} edit={edit} dis={dis} ask={ask} ix={ix} />}
          {result && !waitingForSnapshot && tab === "project" && <ProjectStage draft={draft} result={result} edit={edit} dis={dis} cur={cur} ask={ask} ix={ix} />}
          {tab === "commercial" && <CommercialStage doc={doc} draft={draft} edit={edit} dis={dis} ix={ix} totals={t} />}
        </div>

        {/* Estimation summary */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="flex items-center gap-2 bg-sidebar px-4 py-3 font-semibold text-white"><BadgeDollarSign className="h-4 w-4" /> Estimation Summary</div>
            <div className="space-y-3 p-4">
              <SumRow icon={Package} label="Material Cost" value={t.materialCents} cur={cur} />
              <SumRow icon={Settings2} label="Manufacturing Cost" value={t.manufacturingCents} cur={cur} />
              <SumRow icon={Handshake} label="Subcontractor Cost" value={t.subcontractorCents} cur={cur} />
              <SumRow icon={ClipboardList} label="Project Costs" value={t.projectCents} cur={cur} />
              <div className="border-t pt-3">
                <div className="text-sm font-semibold">Total Estimated Cost</div>
                <div className="text-2xl font-bold text-primary tabular-nums">{egp0(t.estimatedCostCents)} <span className="text-base">{cur}</span></div>
              </div>
            </div>
          </div>
          <div className="rounded-2xl bg-gradient-to-br from-sidebar to-primary p-5 text-white shadow-sm">
            <div className="text-sm font-semibold opacity-90">Final Sale Price{locked ? " (approved)" : ""}</div>
            <div className="mt-1 text-3xl font-bold tabular-nums">{egp0(c.finalCents)} <span className="text-lg">{cur}</span></div>
            <div className="mt-1 text-xs opacity-80">{locked ? `Approved snapshot of v${version}` : dirty ? "Unsaved: the server recalculates on save" : "Saved figures"}</div>
            <dl className="mt-3 space-y-1 border-t border-white/20 pt-3 text-xs">
              {([["Estimated cost", c.costCents], ["Profit", c.profitCents], ["Insurance", c.insuranceCents], ["Other charges", c.otherChargesCents], ["Discount", -c.discountCents], ["Tax", c.taxCents]] as [string, number][]).filter(([l, v]) => v !== 0 || l === "Estimated cost").map(([l, v]) => <div key={l} className="flex justify-between"><dt className="opacity-80">{l}</dt><dd className="tabular-nums">{v < 0 ? "−" : ""}{egp(Math.abs(v))}</dd></div>)}
            </dl>
          </div>
          {c.issue && <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{c.issue}</div>}
          {doc.offers.length > 0 && (
            <div className="rounded-xl border border-border bg-card p-3 text-sm">
              <div className="mb-2 font-semibold">Offers from this estimate</div>
              <ul className="space-y-1.5">
                {doc.offers.map((o) => <li key={o.id} className="flex items-center justify-between gap-2"><Link className="text-primary hover:underline" href={`/projects/${projectId}/quotations/${o.quotationId}`}>{o.number} Rev. {o.revision}</Link><span className="text-xs text-muted-foreground">{o.status} · {egp0(Math.round(o.finalPrice * 100))}{o.snapshotVersion != null ? ` · from v${o.snapshotVersion}` : ""}{o.layout === "PER_ITEM" ? " · per item" : ""}</span></li>)}
              </ul>
            </div>
          )}
        </aside>
      </div>

      {/* Footer */}
      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-background/95 px-1 py-3 backdrop-blur">
        <Button variant="outline" asChild><Link href={`/projects/${projectId}`}><ArrowLeft /> Back to Project</Link></Button>
        <div className="flex flex-wrap gap-2">
          {stageKey && canEdit && <Button variant="outline" onClick={() => void markDone(stageKey)} disabled={!!busy || dis || stageDone} title={stageDone ? "Already marked complete" : undefined}><CheckCheck /> {stageDone ? `${TAB_LABEL[tab]} complete` : `Mark ${TAB_LABEL[tab]} complete`}</Button>}
          {tab === "commercial" && <>
            <Button variant="outline" onClick={() => void download()} disabled={!!busy || t.estimatedCostCents <= 0}><Download /> Download Quotation</Button>
            {canOffer && <Button onClick={() => setDialog("offer")} disabled={!!busy}><Send /> Create Offer</Button>}
          </>}
        </div>
      </div>

      <ConfirmDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)} title={confirm?.title} description={confirm?.description} onConfirm={() => { confirm?.run(); setConfirm(null); }} />
      <ConfirmDialog open={dialog === "approve"} onOpenChange={(o) => !o && setDialog(null)} title="Approve this pricing sheet?" description={`v${version} will be locked as calculated (${egp0(doc.totals.finalCents)} ${cur}). To change it later you reopen it, which creates a new version; the approved snapshot stays readable.`} confirmLabel="Approve" onConfirm={() => void approve()} />
      <ReopenDialog open={dialog === "reopen"} onOpenChange={(o) => !o && setDialog(null)} onConfirm={(r) => void reopen(r)} busy={busy === "reopen"} error={reopenError} />
      <ApplyTemplateDialog open={dialog === "apply"} onOpenChange={(o) => !o && setDialog(null)} projectId={projectId} items={draft.items.map((i) => ({ id: i.id, name: i.name }))} version={refreshKey} ensureSaved={ensureSaved} onApplied={adopt} canManage={canManageTemplates} onManage={() => setDialog("manage")} />
      <ManageTemplatesDialog open={dialog === "manage"} onOpenChange={(o) => !o && setDialog(null)} onChanged={() => setRefreshKey((k) => k + 1)} />
      <OfferDialog open={dialog === "offer"} onOpenChange={(o) => !o && setDialog(null)} projectId={projectId} status={status} dirty={dirty} cur={cur}
        onCreated={(o) => { void load(); router.push(`/projects/${projectId}/quotations/${o.quotationId}`); }} />
      <QuotationPreviewDialog open={dialog === "preview"} onOpenChange={(o) => !o && setDialog(null)} status={status} version={version} projectName={doc.project.name} customer={doc.project.customer} currency={cur}
        commercial={locked ? approved?.result.commercial ?? null : doc.totals} settings={doc.settings} loading={locked && !approved && !snapError} error={locked ? snapError : null} />
    </div>
  );
}

function SumRow({ icon: Icon, label, value, cur }: { icon: typeof Package; label: string; value: number; cur: string }) {
  return <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span><div><div className="text-sm text-muted-foreground">{label}</div><div className="font-bold tabular-nums">{egp0(value)} {cur}</div></div></div>;
}

type StageProps = { draft: Draft; result: EstimateResult; edit: (fn: (d: Draft) => Draft) => void; dis: boolean; ask: (t: string, d: string, run: () => void) => void; cur?: string; ix: IssueIndex };
const Tabs = ({ tabs, value, onChange }: { tabs: { id: string; label: string; icon: typeof Package }[]; value: string; onChange: (v: string) => void }) => (
  <div className="flex flex-wrap gap-2">{tabs.map((x) => <button key={x.id} type="button" onClick={() => onChange(x.id)} className={cn("flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition", value === x.id ? "bg-primary text-primary-foreground shadow-sm" : "bg-secondary text-secondary-foreground hover:bg-secondary/70")}><x.icon className="h-4 w-4" />{x.label}</button>)}</div>
);
const Info = ({ children }: { children: React.ReactNode }) => <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-2.5 text-sm text-primary">{children}</div>;
const Th = ({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) => <th className={cn("px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground", right && "text-right", className)}>{children}</th>;
const TableWrap = ({ children }: { children: React.ReactNode }) => <div className="overflow-x-auto rounded-xl border border-border bg-card"><table className="w-full min-w-[720px] text-sm">{children}</table></div>;
const DelBtn = ({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) => <button type="button" aria-label="Delete" disabled={disabled} onClick={onClick} className="rounded p-1.5 text-destructive hover:bg-destructive/10 disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>;

// ============================================================ Stage 1
function MaterialStage({ draft, result, edit, dis, cur, ask, ix, restoring, onRestore }: StageProps & { restoring: string | null; onRestore: (id: string) => void }) {
  const [tab, setTab] = React.useState("materials");
  const [adding, setAdding] = React.useState(false);
  const [nm, setNm] = React.useState({ name: "", grade: "", thicknessMm: "", purchasedKg: "", unitPrice: "" });
  const mr = result.materials; const sc = mr.scrap;
  const add = () => {
    if (!nm.name.trim()) return toast.error("Enter the material name.");
    const kgv = Number(nm.purchasedKg), pr = Number(nm.unitPrice || 0);
    if (!(kgv > 0)) return toast.error("Enter the purchased quantity (kg).");
    edit((d) => ({ ...d, materials: [...d.materials, { id: newId(), source: "MANUAL", name: nm.name.trim(), grade: nm.grade.trim() || null, thicknessMm: nm.thicknessMm ? Number(nm.thicknessMm) : null, requiredKg: null, purchasedKg: kgv, unitPrice: Number.isFinite(pr) ? pr : 0, sourceRequiredKg: null, sourcePurchasedKg: null, suggestedUnitPrice: null, sourceMissing: false }] }));
    setNm({ name: "", grade: "", thicknessMm: "", purchasedKg: "", unitPrice: "" }); setAdding(false);
  };
  const s = draft.settings;
  const setS = (p: Partial<EstSettings>) => edit((d) => ({ ...d, settings: { ...d.settings, ...p } }));
  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "materials", label: "Materials", icon: Package }, { id: "scrap", label: "Scrap Management", icon: Layers }, { id: "summary", label: "Summary", icon: FileText }]} />
      {tab === "materials" && <>
        <Info>Materials are taken automatically from Part List and Nesting. You can edit prices (and purchased quantities) or add new materials.</Info>
        {draft.materials.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No materials yet. Add parts in Part List (or run a nest), or add a material manually.</div> : (
          <>
            <MaterialsTable materials={draft.materials} items={draft.items} settings={draft.settings} lines={mr.lines} cur={cur ?? "EGP"} dis={dis} issues={ix} restoring={restoring} onRestore={onRestore}
              onChange={(next) => edit((d) => ({ ...d, materials: d.materials.map((m) => (m.id === next.id ? next : m)) }))}
              onDelete={(m) => ask("Delete this material?", `"${m.name}" will be removed from the estimate.`, () => edit((d) => ({ ...d, materials: d.materials.filter((x) => x.id !== m.id) })))} />
            <div className="flex items-center justify-between rounded-xl bg-secondary/40 px-3 py-3"><span className="font-semibold">Total Material Cost</span><span className="text-base font-bold text-primary tabular-nums">{egp(mr.materialCostCents)} {cur}</span></div>
          </>
        )}
        {!dis && (adding ? (
          <div className="grid gap-2 rounded-xl border border-border bg-card p-3 sm:grid-cols-6">
            <input className={cn(inputCls, "sm:col-span-2")} placeholder="Material (e.g. IPE Profile)" value={nm.name} onChange={(e) => setNm({ ...nm, name: e.target.value })} />
            <input className={inputCls} placeholder="Grade" value={nm.grade} onChange={(e) => setNm({ ...nm, grade: e.target.value })} />
            <input className={inputCls} placeholder="Thickness mm" inputMode="decimal" value={nm.thicknessMm} onChange={(e) => setNm({ ...nm, thicknessMm: e.target.value })} />
            <input className={inputCls} placeholder="Purchased kg" inputMode="decimal" value={nm.purchasedKg} onChange={(e) => setNm({ ...nm, purchasedKg: e.target.value })} />
            <input className={inputCls} placeholder={`Price ${cur}/kg`} inputMode="decimal" value={nm.unitPrice} onChange={(e) => setNm({ ...nm, unitPrice: e.target.value })} />
            <div className="flex gap-2 sm:col-span-6"><Button size="sm" onClick={add}>Add material</Button><Button size="sm" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button></div>
          </div>
        ) : <Button variant="outline" size="sm" onClick={() => setAdding(true)}><Plus /> Add Material</Button>)}
        <ScrapSummary result={result} cur={cur ?? "EGP"} credit={s.creditRecoveredScrap} />
      </>}
      {tab === "scrap" && (
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <Info>Scrap is already inside the material cost (you pay for the whole sheets). These inputs only decide how much of it is recovered.</Info>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Scrap kept for re-use (%)" hint="Share of the scrap kept as usable remnants"><NumInput disabled={dis} value={Math.round(s.scrapUsedLaterPct * 10000) / 100} onChange={(v) => setS({ scrapUsedLaterPct: Math.min(1, (v ?? 0) / 100) })} /></Field>
            <Field label={`Re-used remnant value (${cur}/kg)`}><NumInput disabled={dis} value={s.scrapUsedLaterPrice} onChange={(v) => setS({ scrapUsedLaterPrice: v ?? 0 })} /></Field>
            <Field label={`Scrap sell price (${cur}/kg)`}><NumInput disabled={dis} value={s.scrapSellPrice} onChange={(v) => setS({ scrapSellPrice: v ?? 0 })} /></Field>
          </div>
          <label className="flex items-center gap-3 rounded-lg bg-secondary/60 p-3 text-sm"><Switch disabled={dis} checked={s.creditRecoveredScrap} onCheckedChange={(v) => setS({ creditRecoveredScrap: v })} /><span><b>Credit recovered scrap</b> — deduct its recovered value from the material cost. Off by default (scrap stays a cost).</span></label>
          <ScrapSummary result={result} cur={cur ?? "EGP"} credit={s.creditRecoveredScrap} />
        </div>
      )}
      {tab === "summary" && (
        <div className="rounded-xl border border-border bg-card p-4 text-sm">
          <dl className="grid gap-y-2 sm:grid-cols-2">
            <dt className="text-muted-foreground">Lines</dt><dd className="font-semibold">{draft.materials.length} ({draft.materials.filter((m) => m.source === "MANUAL").length} manual)</dd>
            <dt className="text-muted-foreground">Required by parts</dt><dd className="font-semibold tabular-nums">{kg(mr.requiredKg)} kg</dd>
            <dt className="text-muted-foreground">Purchased</dt><dd className="font-semibold tabular-nums">{kg(mr.purchasedKg)} kg</dd>
            <dt className="text-muted-foreground">Material cost (purchased × price)</dt><dd className="font-semibold tabular-nums">{egp(mr.grossCents)} {cur}</dd>
            <dt className="text-muted-foreground">Recovered scrap credited</dt><dd className="font-semibold tabular-nums">{s.creditRecoveredScrap ? `− ${egp(sc.recoveredCents)}` : "not credited"}</dd>
            <dt className="font-semibold">Material cost used in the estimate</dt><dd className="text-base font-bold text-primary tabular-nums">{egp(mr.materialCostCents)} {cur}</dd>
          </dl>
        </div>
      )}
    </>
  );
}

function ScrapSummary({ result, cur, credit }: { result: EstimateResult; cur: string; credit: boolean }) {
  const mr = result.materials; const sc = mr.scrap;
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4">
      <div className="mb-3 font-semibold">Scrap Summary</div>
      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label="Total Purchased" value={`${kg(mr.purchasedKg)} kg`} />
        <Stat label="Used" value={`${kg(mr.requiredKg)} kg`} />
        <Stat label="Scrap" value={`${kg(sc.scrapKg)} kg (${(sc.scrapPct * 100).toFixed(1)}%)`} />
        <Stat label="Scrap Value (at cost)" value={`${egp(sc.scrapValueCents)} ${cur}`} />
        <Stat label="Recovered Value" value={`${egp(sc.recoveredCents)} ${cur}`} />
        <Stat label="Net Scrap Loss" value={`${egp(sc.netLossCents)} ${cur}`} />
        <div className="sm:col-span-2 flex items-center gap-2 rounded-lg bg-card p-3 text-sm"><Check className="h-4 w-4 text-success" />{credit ? "Recovered scrap is deducted from the material cost" : "Scrap is included in the material cost (not added again)"}</div>
      </div>
      {sc.shortageKg > 0.05 && <p className="mt-3 text-sm text-amber-700">⚠ Purchased quantity is {kg(sc.shortageKg)} kg below what the parts need.</p>}
    </div>
  );
}
const Stat = ({ label, value }: { label: string; value: string }) => <div><div className="text-xs text-muted-foreground">{label}</div><div className="font-bold tabular-nums">{value}</div></div>;

// ============================================================ Stage 2
function ManufacturingStage({ draft, result, edit, dis, ask, ix }: StageProps) {
  const [tab, setTab] = React.useState("ops");
  const [open, setOpen] = React.useState<Set<string>>(new Set(draft.items.map((i) => i.id)));
  const [addingItem, setAddingItem] = React.useState(false);
  const [itemForm, setItemForm] = React.useState({ name: "", kg: "", pcs: "" });
  const mf = result.manufacturing;
  const patchItem = (id: string, fn: (i: EstItem) => EstItem) => edit((d) => ({ ...d, items: d.items.map((i) => (i.id === id ? fn(i) : i)) }));
  const patchOp = (itemId: string, opId: string, p: Partial<EstOperation>) => patchItem(itemId, (i) => ({ ...i, operations: i.operations.map((o) => (o.id === opId ? { ...o, ...p } : o)) }));

  return (
    <>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "ops", label: "Manufacturing Operations", icon: Settings2 }, { id: "sub", label: "Subcontractor", icon: Handshake }]} />
      {tab === "ops" ? (
        <>
          <Info>Select the required operations for each item and define the cost. You can add custom operations if needed.</Info>
          {draft.items.length === 0 && <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">No items yet. Group parts as a Scope in Part List (they appear here automatically) or add an item manually.</div>}
          {draft.items.map((item) => {
            const ir = mf.items.find((x) => x.id === item.id) ?? { id: item.id, operations: [], totalCents: 0 };
            const w = item.linked ? item.weightKg : item.manualWeightKg ?? 0;
            const pcs = item.linked ? item.pieces : item.manualPieces ?? 0;
            const isOpen = open.has(item.id);
            const allSel = item.operations.length > 0 && item.operations.every((o) => o.selected);
            return (
              <div key={item.id} className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <button type="button" className="flex items-center gap-2 font-semibold" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(item.id)) n.delete(item.id); else n.add(item.id); return n; })}>
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{item.name}
                    <span className="text-sm font-normal text-muted-foreground">(Qty: {kg(w)} kg · {pcs} pcs{item.linked ? "" : " · manual"})</span>
                  </button>
                  <div className="flex items-center gap-3">
                    {!item.linked && !dis && <DelBtn onClick={() => ask("Delete this item?", `"${item.name}" and its operations will be removed from the estimate.`, () => edit((d) => ({ ...d, items: d.items.filter((x) => x.id !== item.id) })))} />}
                    <label className="flex items-center gap-2 text-sm text-primary"><span>Select All</span><Checkbox disabled={dis} checked={allSel} onCheckedChange={(v) => patchItem(item.id, (i) => ({ ...i, operations: i.operations.map((o) => ({ ...o, selected: !!v })) }))} /></label>
                  </div>
                </div>
                {isOpen && (
                  <>
                    {!item.linked && <div className="flex flex-wrap gap-3 border-t bg-secondary/30 px-4 py-2 text-sm"><label className="flex items-center gap-2">Weight (kg)<NumInput className="w-28" disabled={dis} nullable value={item.manualWeightKg} onChange={(v) => patchItem(item.id, (i) => ({ ...i, manualWeightKg: v }))} /></label><label className="flex items-center gap-2">Pieces<NumInput className="w-20" disabled={dis} nullable value={item.manualPieces} onChange={(v) => patchItem(item.id, (i) => ({ ...i, manualPieces: v == null ? null : Math.round(v) }))} /></label></div>}
                    <div className="overflow-x-auto border-t">
                      <table className="w-full min-w-[860px] text-sm">
                        <thead className="bg-secondary/50"><tr><Th className="w-10" /><Th>Operation</Th><Th>Cost Type</Th><Th>Unit</Th><Th right>Qty / Base</Th><Th right>Rate / Amount</Th><Th right>Total Cost</Th><Th>Source</Th><Th /></tr></thead>
                        <tbody>
                          {item.operations.map((o) => {
                            const r = ir.operations.find((x) => x.id === o.id) ?? { id: o.id, quantity: 0, amountCents: 0, contributes: false, issue: undefined };
                            const autoQty = operationQuantity({ costType: o.costType, quantity: null }, { weightKg: w, pieces: pcs });
                            return (
                              <tr key={o.id} className={cn("border-t", !o.selected && "text-muted-foreground")}>
                                <td className="px-3 py-2"><Checkbox disabled={dis} checked={o.selected} onCheckedChange={(v) => patchOp(item.id, o.id, { selected: !!v })} aria-label={`Require ${o.name}`} /></td>
                                <td className="px-3 py-2 font-medium">{o.source === "MANUAL" ? <><input className={cn(inputCls, "w-36", !o.name.trim() && "border-destructive")} disabled={dis} value={o.name} aria-invalid={!o.name.trim()} onChange={(e) => patchOp(item.id, o.id, { name: e.target.value })} />{!o.name.trim() && <span role="alert" className="block text-[11px] text-destructive">Name is required</span>}</> : o.name}</td>
                                <td className="px-3 py-2"><select className={cn(selectCls, "w-32")} disabled={dis} value={o.costType} onChange={(e) => { const ct = e.target.value as CostType; patchOp(item.id, o.id, { costType: ct, unit: ct === "CUSTOM" ? (o.unit && !Object.values(COST_TYPE_UNIT).includes(o.unit) ? o.unit : "") : COST_TYPE_UNIT[ct], quantity: null, percentBase: ct === "PERCENTAGE" ? o.percentBase ?? "ITEM_OPERATIONS" : null }); }}>{COST_TYPES.map((t) => <option key={t} value={t}>{COST_TYPE_LABEL[t]}</option>)}</select></td>
                                <td className="px-3 py-2">{o.costType === "CUSTOM" ? <input className={cn(inputCls, "w-20")} disabled={dis} placeholder="unit" value={o.unit} onChange={(e) => patchOp(item.id, o.id, { unit: e.target.value })} /> : o.unit || "–"}</td>
                                <td className="px-3 py-2 text-right">
                                  {o.costType === "FIXED" ? "–" : o.costType === "PERCENTAGE" ? (
                                    <select className={cn(selectCls, "w-56")} disabled={dis} value={o.percentBase ?? ""} onChange={(e) => patchOp(item.id, o.id, { percentBase: (e.target.value || null) as never })}><option value="">Choose base…</option>{OP_PERCENT_BASES.map((b) => <option key={b} value={b}>{OP_BASE_LABEL[b]}</option>)}</select>
                                  ) : <NumInput className="w-24" disabled={dis} nullable value={o.quantity} placeholder={autoQty != null ? String(Math.round(autoQty * 100) / 100) : "enter qty"} onChange={(v) => patchOp(item.id, o.id, { quantity: v })} />}
                                  <FieldIssues issues={issuesFor(ix, "operation", o.id)} />
                                </td>
                                <td className="px-3 py-2 text-right"><NumInput className="w-24" disabled={dis} value={o.rate} onChange={(v) => patchOp(item.id, o.id, { rate: v ?? 0 })} /></td>
                                <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", !o.selected && "line-through opacity-60")}>{egp(r.amountCents)}</td>
                                <td className="px-3 py-2"><SourceBadge source={o.source} /></td>
                                <td className="px-2 py-2"><DelBtn disabled={dis} onClick={() => ask("Delete this operation?", `"${o.name}" will be removed from ${item.name}.`, () => patchItem(item.id, (i) => ({ ...i, operations: i.operations.filter((x) => x.id !== o.id) })))} /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    {!dis && <div className="border-t px-4 py-2"><Button variant="outline" size="sm" onClick={() => patchItem(item.id, (i) => ({ ...i, operations: [...i.operations, { id: newId(), name: "Custom operation", costType: "FIXED", unit: "", rate: 0, quantity: null, percentBase: null, selected: true, source: "MANUAL" }] }))}><Plus /> Add custom operation</Button></div>}
                    <div className="flex items-center justify-end gap-6 border-t bg-secondary/40 px-4 py-3"><span className="text-sm font-semibold">Total Manufacturing Cost ({item.name})</span><span className="text-lg font-bold text-primary tabular-nums">{egp(ir.totalCents)} EGP</span></div>
                  </>
                )}
              </div>
            );
          })}
          {!dis && (addingItem ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
              <input className={cn(inputCls, "w-56")} placeholder="Item / scope name" value={itemForm.name} onChange={(e) => setItemForm({ ...itemForm, name: e.target.value })} />
              <input className={cn(inputCls, "w-32")} inputMode="decimal" placeholder="Weight kg" value={itemForm.kg} onChange={(e) => setItemForm({ ...itemForm, kg: e.target.value })} />
              <input className={cn(inputCls, "w-24")} inputMode="numeric" placeholder="Pieces" value={itemForm.pcs} onChange={(e) => setItemForm({ ...itemForm, pcs: e.target.value })} />
              <Button size="sm" onClick={() => {
                if (!itemForm.name.trim()) return toast.error("Enter the item name.");
                const id = newId();
                edit((d) => ({ ...d, items: [...d.items, { id, name: itemForm.name.trim(), linked: false, weightKg: 0, pieces: 0, manualWeightKg: itemForm.kg ? Number(itemForm.kg) || 0 : null, manualPieces: itemForm.pcs ? Math.round(Number(itemForm.pcs)) || 0 : null, operations: DEFAULT_OPS_UI() }] }));
                setOpen((s) => new Set(s).add(id)); setItemForm({ name: "", kg: "", pcs: "" }); setAddingItem(false);
              }}>Add item</Button>
              <Button size="sm" variant="ghost" onClick={() => setAddingItem(false)}>Cancel</Button>
            </div>
          ) : <Button variant="outline" size="sm" onClick={() => setAddingItem(true)}><Plus /> Add Item / Scope</Button>)}
          <div className="rounded-xl bg-secondary/60 px-4 py-3 text-right text-sm"><span className="font-semibold">Total Manufacturing Cost (all items): </span><span className="text-lg font-bold text-primary tabular-nums">{egp(mf.totalCents)} EGP</span></div>
        </>
      ) : <SubcontractorTab draft={draft} result={result} edit={edit} dis={dis} ask={ask} ix={ix} />}
    </>
  );
}
// Default operations for a manually added item (same list the server uses for scope items).
const DEFAULT_OPS_UI = (): EstOperation[] => DEFAULT_OPERATIONS.map((o) => ({ id: newId(), name: o.name, costType: o.costType, unit: o.unit, rate: 0, quantity: null, percentBase: o.percentBase ?? null, selected: false, source: "DEFAULT" as const }));

function SubcontractorTab({ draft, result, edit, dis, ask, ix }: StageProps) {
  const set = (id: string, p: Partial<EstSubcontract>) => edit((d) => ({ ...d, subcontracts: d.subcontracts.map((s) => (s.id === id ? { ...s, ...p } : s)) }));
  return (
    <>
      <Info>Processes APIC cannot perform in-house and must outsource. Costs here are kept separate from internal manufacturing.</Info>
      {draft.subcontracts.length === 0 ? <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No subcontractor services yet.</div> : (
        <TableWrap>
          <thead className="border-b bg-secondary/50"><tr><Th>Service / Process</Th><Th>Subcontractor</Th><Th>Unit</Th><Th right>Quantity</Th><Th right>Unit Price</Th><Th right>Total Cost</Th><Th>Notes</Th><Th /></tr></thead>
          <tbody>
            {draft.subcontracts.map((s, i) => (
              <tr key={s.id} className="border-b last:border-0">
                <td className="px-3 py-2"><input className={cn(inputCls, !s.name.trim() && "border-destructive")} disabled={dis} value={s.name} aria-invalid={!s.name.trim()} aria-label="Service name" onChange={(e) => set(s.id, { name: e.target.value })} />{!s.name.trim() && <span role="alert" className="block text-[11px] text-destructive">Service name is required</span>}<FieldIssues issues={issuesFor(ix, "subcontract", s.id)} /></td>
                <td className="px-3 py-2"><input className={inputCls} disabled={dis} placeholder="optional" value={s.company ?? ""} onChange={(e) => set(s.id, { company: e.target.value || null })} /></td>
                <td className="px-3 py-2"><input className={cn(inputCls, "w-20")} disabled={dis} value={s.unit} onChange={(e) => set(s.id, { unit: e.target.value })} /></td>
                <td className="px-3 py-2"><NumInput className="w-24" disabled={dis} value={s.quantity} onChange={(v) => set(s.id, { quantity: v ?? 0 })} /></td>
                <td className="px-3 py-2"><NumInput className="w-28" disabled={dis} value={s.unitPrice} onChange={(v) => set(s.id, { unitPrice: v ?? 0 })} /></td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{egp(result.subcontract.lines[i]?.totalCents ?? 0)}</td>
                <td className="px-3 py-2"><input className={inputCls} disabled={dis} value={s.notes ?? ""} onChange={(e) => set(s.id, { notes: e.target.value || null })} /></td>
                <td className="px-2 py-2"><DelBtn disabled={dis} onClick={() => ask("Delete this service?", `"${s.name}" will be removed.`, () => edit((d) => ({ ...d, subcontracts: d.subcontracts.filter((x) => x.id !== s.id) })))} /></td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr className="bg-secondary/40"><td colSpan={5} className="px-3 py-3 text-right font-semibold">Total Subcontractor Cost</td><td className="px-3 py-3 text-right font-bold text-primary tabular-nums">{egp(result.subcontract.totalCents)}</td><td colSpan={2} /></tr></tfoot>
        </TableWrap>
      )}
      {!dis && <Button variant="outline" size="sm" onClick={() => edit((d) => ({ ...d, subcontracts: [...d.subcontracts, { id: newId(), name: "", company: null, unit: "lot", quantity: 1, unitPrice: 0, notes: null }] }))}><Plus /> Add Service</Button>}
    </>
  );
}

// ============================================================ Stage 3
function ProjectStage({ draft, result, edit, dis, cur, ask, ix }: StageProps) {
  const set = (id: string, p: Partial<EstProjectCost>) => edit((d) => ({ ...d, projectCosts: d.projectCosts.map((c) => (c.id === id ? { ...c, ...p } : c)) }));
  const totalTon = draft.items.reduce((a, i) => a + (i.linked ? i.weightKg : i.manualWeightKg ?? 0), 0) / 1000;
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="flex items-center gap-2 text-lg font-bold text-primary"><ClipboardList className="h-5 w-5" /> Project-Level Costs</h2><p className="text-sm text-muted-foreground">Costs that are not tied to a specific operation or item. Disable a row to leave it out.</p></div>
        {!dis && <Button variant="outline" size="sm" onClick={() => edit((d) => ({ ...d, projectCosts: [...d.projectCosts, { id: newId(), name: "", method: "FIXED", unit: "", quantity: null, rate: 0, percentBase: null, enabled: true, source: "MANUAL" }] }))}><Plus /> Add Custom Cost</Button>}
      </div>
      <TableWrap>
        <thead className="border-b bg-secondary/50"><tr><Th className="w-10">On</Th><Th>Cost Item</Th><Th>Method</Th><Th>Unit</Th><Th right>Quantity / Base</Th><Th right>Amount / Rate</Th><Th right>Total ({cur})</Th><Th>Source</Th><Th /></tr></thead>
        <tbody>
          {draft.projectCosts.map((c, i) => {
            const r = result.project.lines[i];
            return (
              <tr key={c.id} className={cn("border-b last:border-0", !c.enabled && "text-muted-foreground")}>
                <td className="px-3 py-2"><Switch disabled={dis} checked={c.enabled} onCheckedChange={(v) => set(c.id, { enabled: v })} /></td>
                <td className="px-3 py-2 font-medium">{c.source === "MANUAL" ? <><input className={cn(inputCls, "w-40", !c.name.trim() && "border-destructive")} disabled={dis} value={c.name} placeholder="Cost name" aria-invalid={!c.name.trim()} onChange={(e) => set(c.id, { name: e.target.value })} />{!c.name.trim() && <span role="alert" className="block text-[11px] text-destructive">Cost name is required</span>}</> : c.name}</td>
                <td className="px-3 py-2"><select className={cn(selectCls, "w-28")} disabled={dis} value={c.method} onChange={(e) => { const m = e.target.value as ProjectMethod; set(c.id, { method: m, unit: m === "CUSTOM" ? "" : PROJECT_METHOD_UNIT[m], quantity: null, percentBase: m === "PERCENTAGE" ? c.percentBase ?? "DIRECT_COST" : null }); }}>{PROJECT_METHODS.map((m) => <option key={m} value={m}>{PROJECT_METHOD_LABEL[m]}</option>)}</select></td>
                <td className="px-3 py-2">{c.method === "CUSTOM" ? <input className={cn(inputCls, "w-20")} disabled={dis} placeholder="unit" value={c.unit} onChange={(e) => set(c.id, { unit: e.target.value })} /> : c.unit || "–"}</td>
                <td className="px-3 py-2 text-right">
                  {c.method === "FIXED" ? "–" : c.method === "PERCENTAGE" ? (
                    <select className={cn(selectCls, "w-56")} disabled={dis} value={c.percentBase ?? ""} onChange={(e) => set(c.id, { percentBase: (e.target.value || null) as never })}><option value="">Choose base…</option>{PROJECT_PERCENT_BASES.map((b) => <option key={b} value={b}>{PROJECT_BASE_LABEL[b]}</option>)}</select>
                  ) : <NumInput className="w-24" disabled={dis} nullable value={c.quantity} placeholder={c.method === "PER_TON" ? String(Math.round(totalTon * 100) / 100) : "1"} onChange={(v) => set(c.id, { quantity: v })} />}
                  <FieldIssues issues={issuesFor(ix, "projectCost", c.id)} />
                </td>
                <td className="px-3 py-2 text-right"><NumInput className="w-28" disabled={dis} value={c.rate} onChange={(v) => set(c.id, { rate: v ?? 0 })} />{c.method === "PERCENTAGE" && <span className="ml-1 text-muted-foreground">%</span>}</td>
                <td className={cn("px-3 py-2 text-right font-semibold tabular-nums", !c.enabled && "line-through opacity-60")}>{egp(r?.amountCents ?? 0)}</td>
                <td className="px-3 py-2"><SourceBadge source={c.source} /></td>
                <td className="px-2 py-2"><DelBtn disabled={dis} onClick={() => ask("Delete this cost?", `"${c.name || "This cost"}" will be removed. You can switch it off instead to keep it.`, () => edit((d) => ({ ...d, projectCosts: d.projectCosts.filter((x) => x.id !== c.id) })))} /></td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
      <div className="mt-3 flex items-center justify-between rounded-xl bg-primary/10 px-4 py-3"><span className="font-semibold">Total Project Cost</span><span className="text-xl font-bold text-primary tabular-nums">{egp(result.project.totalCents)} {cur}</span></div>
    </div>
  );
}

// ============================================================ Stage 4 (Commercial Summary)
const ALLOC_LABEL: Record<(typeof ALLOCATION_BASES)[number], string> = { WEIGHT: "By weight", DIRECT_COST: "By direct cost", EQUAL: "Equally" };
const DISCOUNT_LABEL: Record<(typeof DISCOUNT_MODES)[number], string> = { NONE: "No discount", PERCENT: "Percentage", FIXED: "Fixed amount" };
const TIMING_LABEL: Record<(typeof DISCOUNT_TIMINGS)[number], string> = { BEFORE_TAX: "Before tax", AFTER_TAX: "After tax" };

function CommercialStage({ doc, draft, edit, dis, ix, totals }: { doc: EstimateDoc; draft: Draft; edit: StageProps["edit"]; dis: boolean; ix: IssueIndex; totals: EstimateDoc["totals"] }) {
  const s = draft.settings; const cur = doc.currency;
  const set = (p: Partial<EstSettings>) => edit((d) => ({ ...d, settings: { ...d.settings, ...p } }));
  const custom = !!s.paymentTerms && !PAYMENT_TERMS.includes(s.paymentTerms);
  const [useCustom, setUseCustom] = React.useState(custom);
  const mode = s.discountMode ?? "NONE";
  const msgs = issuesFor(ix, "commercial");
  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
      <div><h2 className="flex items-center gap-2 text-lg font-bold text-primary"><Calculator className="h-5 w-5" /> Commercial Summary</h2><p className="text-sm text-muted-foreground">Pricing terms and the build-up from cost to final price.</p></div>
      <FieldIssues issues={msgs} />
      <div className="overflow-hidden rounded-xl border">
        <table className="w-full text-sm"><tbody>
          {([["Estimated cost", totals.costCents, false], ["Profit", totals.profitCents, false], ["Insurance", totals.insuranceCents, false], [s.otherChargesLabel?.trim() || "Other charges", totals.otherChargesCents, false], ["Tax", totals.taxCents, false], ["Discount", -totals.discountCents, false]] as [string, number, boolean][]).map(([l, v]) => <tr key={l} className="border-b"><td className="px-3 py-1.5 text-muted-foreground">{l}</td><td className="px-3 py-1.5 text-right tabular-nums">{v < 0 ? "−" : ""}{egp(Math.abs(v))}</td></tr>)}
          <tr className="bg-secondary font-bold"><td className="px-3 py-2">Final price ({cur})</td><td className="px-3 py-2 text-right tabular-nums text-primary">{egp(totals.finalCents)}</td></tr>
        </tbody></table>
        <p className="border-t bg-secondary/30 px-3 py-1.5 text-xs text-muted-foreground">Margin on price {(totals.marginPct * 100).toFixed(1)}% · markup on cost {(totals.markupPct * 100).toFixed(1)}%. Order of profit, insurance, other charges, discount and tax is the one documented in the calculation.<NeedsApproval why="the order of insurance, tax and discount" /></p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2 rounded-xl border p-3">
          <Field label="Profit Margin"><div className="flex gap-2"><NumInput disabled={dis} value={s.profitValue} onChange={(v) => set({ profitValue: v ?? 0 })} /><span className="flex items-center text-sm text-muted-foreground">{s.profitMode === "FIXED" ? cur : "%"}</span></div></Field>
          <select className={selectCls} disabled={dis} aria-label="Profit mode" value={s.profitMode} onChange={(e) => set({ profitMode: e.target.value as never })}>{PROFIT_MODES.map((m) => <option key={m} value={m}>{PROFIT_MODE_LABEL[m]}</option>)}</select>
        </div>
        <div className="space-y-2 rounded-xl border p-3">
          <Field label="Insurance"><div className="flex gap-2"><NumInput disabled={dis} value={s.insuranceValue} onChange={(v) => set({ insuranceValue: v ?? 0 })} /><span className="flex items-center text-sm text-muted-foreground">{s.insuranceMode === "FIXED" ? cur : "%"}</span></div></Field>
          <select className={selectCls} disabled={dis} aria-label="Insurance mode" value={s.insuranceMode} onChange={(e) => set({ insuranceMode: e.target.value as never })}><option value="FIXED">Fixed amount</option><option value="PERCENT">% of (cost + profit)</option></select>
        </div>
        <div className="space-y-2 rounded-xl border p-3">
          <Field label="Tax"><div className="flex gap-2"><NumInput disabled={dis} value={s.taxPct} onChange={(v) => set({ taxPct: Math.min(100, v ?? 0) })} /><span className="flex items-center text-sm text-muted-foreground">%</span></div></Field>
          <p className="text-xs text-muted-foreground">Charged on the taxable amount.</p>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="space-y-2 rounded-xl border p-3">
          <Field label="Discount">
            <div className="flex gap-2"><NumInput disabled={dis || mode === "NONE"} value={s.discountValue ?? 0} onChange={(v) => set({ discountValue: v ?? 0 })} /><span className="flex items-center text-sm text-muted-foreground">{mode === "PERCENT" ? "%" : cur}</span></div>
            {mode === "PERCENT" && (s.discountValue ?? 0) > 100 && <span role="alert" className="block text-xs text-destructive">A percentage discount cannot exceed 100</span>}
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <select className={selectCls} disabled={dis} aria-label="Discount mode" value={mode} onChange={(e) => set({ discountMode: e.target.value as never })}>{DISCOUNT_MODES.map((m) => <option key={m} value={m}>{DISCOUNT_LABEL[m]}</option>)}</select>
            <select className={selectCls} disabled={dis || mode === "NONE"} aria-label="Discount timing" value={s.discountTiming ?? "BEFORE_TAX"} onChange={(e) => set({ discountTiming: e.target.value as never })}>{DISCOUNT_TIMINGS.map((m) => <option key={m} value={m}>{TIMING_LABEL[m]}</option>)}</select>
          </div>
        </div>
        <div className="space-y-2 rounded-xl border p-3">
          <Field label="Other charges"><div className="flex gap-2"><NumInput disabled={dis} value={s.otherChargesValue ?? 0} onChange={(v) => set({ otherChargesValue: v ?? 0 })} /><span className="flex items-center text-sm text-muted-foreground">{cur}</span></div></Field>
          <Input className="h-8" disabled={dis} aria-label="Other charges label" placeholder="Label (e.g. Freight)" maxLength={80} value={s.otherChargesLabel ?? ""} onChange={(e) => set({ otherChargesLabel: e.target.value || null })} />
          <label className="flex items-center gap-2 text-xs"><Switch disabled={dis} checked={s.otherChargesTaxable ?? false} onCheckedChange={(v) => set({ otherChargesTaxable: v })} /> Taxable</label>
        </div>
        <div className="space-y-2 rounded-xl border p-3">
          <Field label={`Target sale price (${cur})`} hint="Optional goal. It is only compared with the result, never forced onto it."><NumInput disabled={dis} nullable value={s.targetSalePrice ?? null} onChange={(v) => set({ targetSalePrice: v })} /></Field>
          {totals.targetGapCents != null && <p className={cn("text-xs font-medium", totals.targetGapCents > 0 ? "text-destructive" : "text-emerald-700")}>{totals.targetGapCents > 0 ? `${egp(totals.targetGapCents)} above the target` : totals.targetGapCents < 0 ? `${egp(-totals.targetGapCents)} below the target` : "On target"}</p>}
          <Field label="Shared project costs are spread"><select className={selectCls} disabled={dis} value={s.allocationBasis ?? "WEIGHT"} onChange={(e) => set({ allocationBasis: e.target.value as never })}>{ALLOCATION_BASES.map((b) => <option key={b} value={b}>{ALLOC_LABEL[b]}</option>)}</select></Field>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Payment Terms">
          <select className={selectCls} disabled={dis} value={useCustom ? "__custom" : s.paymentTerms ?? ""} onChange={(e) => { if (e.target.value === "__custom") { setUseCustom(true); set({ paymentTerms: "" }); } else { setUseCustom(false); set({ paymentTerms: e.target.value || null }); } }}>
            <option value="">Select…</option>{PAYMENT_TERMS.map((p) => <option key={p} value={p}>{p}</option>)}<option value="__custom">Custom…</option>
          </select>
          {useCustom && <Input className="mt-2 h-8" disabled={dis} placeholder="Enter payment terms" maxLength={200} value={s.paymentTerms ?? ""} onChange={(e) => set({ paymentTerms: e.target.value })} />}
        </Field>
        <Field label="Advance payment (%)"><NumInput disabled={dis} nullable value={s.advancePct ?? null} onChange={(v) => set({ advancePct: v == null ? null : Math.min(100, v) })} /></Field>
        <Field label="Warranty (months)"><NumInput disabled={dis} nullable value={s.warrantyMonths ?? null} onChange={(v) => set({ warrantyMonths: v == null ? null : Math.round(v) })} /></Field>
        <Field label="Offer Validity (days)"><NumInput disabled={dis} value={s.offerValidityDays} min={1} onChange={(v) => set({ offerValidityDays: Math.max(1, Math.round(v ?? 30)) })} /></Field>
        <Field label="Delivery Period (days)"><NumInput disabled={dis} nullable value={s.deliveryDays} onChange={(v) => set({ deliveryDays: v == null ? null : Math.round(v) })} /></Field>
      </div>
      <Field label="Payment milestones"><textarea className={cn(inputCls, "h-20 py-2")} disabled={dis} maxLength={2000} placeholder="Free text. Copied to the offer as written." value={s.milestones ?? ""} onChange={(e) => set({ milestones: e.target.value || null })} /></Field>
      <Field label="Exclusions"><textarea className={cn(inputCls, "h-20 py-2")} disabled={dis} maxLength={500} placeholder="e.g. Site installation, special tools…" value={s.exclusions ?? ""} onChange={(e) => set({ exclusions: e.target.value })} /><span className="block text-right text-xs text-muted-foreground">{(s.exclusions ?? "").length}/500</span></Field>
      <Field label="Commercial Notes"><textarea className={cn(inputCls, "h-24 py-2")} disabled={dis} maxLength={1000} placeholder="Additional notes for the customer…" value={s.commercialNotes ?? ""} onChange={(e) => set({ commercialNotes: e.target.value })} /><span className="block text-right text-xs text-muted-foreground">{(s.commercialNotes ?? "").length}/1000</span></Field>
    </div>
  );
}
