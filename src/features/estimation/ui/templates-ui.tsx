"use client";
import * as React from "react";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { cn } from "@/lib/utils";
import { COST_TYPES, COST_TYPE_LABEL, OP_BASE_LABEL, OP_PERCENT_BASES, PROJECT_BASE_LABEL, PROJECT_METHODS, PROJECT_METHOD_LABEL, PROJECT_PERCENT_BASES, SUB_BASE_LABEL, SUB_COST_TYPES, SUB_COST_TYPE_LABEL, SUB_PERCENT_BASES } from "../calc";
import { applyTarget } from "../sheet-view";
import { emptyTemplateForm, formFromTemplate, toTemplatePayload, validateTemplateForm, type TemplateForm, type TemplateFormErrors } from "../template-form";
import { TEMPLATE_KINDS, type TemplateKind } from "../templates";
import type { EstimateDoc } from "../types";
import { api } from "./api";
import { Field, inputCls, selectCls } from "./fields";
import { NeedsApproval } from "./sheet-parts";

interface TemplateRow { id: string; kind: TemplateKind; name: string; data: unknown }
const KIND_LABEL: Record<TemplateKind, string> = { OPERATION: "Operation (per item)", PROJECT_COST: "Project cost", SUBCONTRACT: "Subcontractor service" };

function useTemplates(open: boolean, version: number) {
  const [rows, setRows] = React.useState<TemplateRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<{ templates: TemplateRow[] }>("/api/estimation-templates", "GET").then((r) => {
      if (cancelled) return;
      if (r.ok) { setError(null); setRows(r.data.templates); } else setError(r.error);
    });
    return () => { cancelled = true; };
  }, [open, version, tick]);
  return { rows, error, reload: () => setTick((t) => t + 1) };
}

// ------------------------------------------------------------------ apply

export function ApplyTemplateDialog({ open, onOpenChange, projectId, items, version, ensureSaved, onApplied, canManage, onManage }: {
  open: boolean; onOpenChange: (v: boolean) => void; projectId: string; items: { id: string; name: string }[]; version: number;
  ensureSaved: () => Promise<boolean>; onApplied: (doc: EstimateDoc) => void; canManage: boolean; onManage: () => void;
}) {
  const { rows, error: loadError } = useTemplates(open, version);
  const [kind, setKind] = React.useState<TemplateKind>("OPERATION");
  const [templateId, setTemplateId] = React.useState("");
  const [itemId, setItemId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [errors, setErrors] = React.useState<{ template?: string; item?: string; server?: string }>({});
  const ofKind = (rows ?? []).filter((t) => t.kind === kind);
  const savedItems = items.filter((i) => !i.id.startsWith("new-")); // an item not saved yet is not on the server

  async function apply() {
    const e: typeof errors = {};
    if (!templateId) e.template = "Choose a template";
    const target = applyTarget(kind, itemId || null);
    if (!target.ok) e.item = target.reason;
    setErrors(e);
    if (e.template || e.item || !target.ok) return;
    setBusy(true);
    if (!(await ensureSaved())) { setBusy(false); return; }
    const r = await api<EstimateDoc>(`/api/projects/${projectId}/estimation/apply-template`, "POST", { templateId, itemId: target.itemId });
    setBusy(false);
    if (!r.ok) { setErrors({ server: r.error }); return; }
    toast.success("Template applied"); onApplied(r.data); onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) setErrors({}); onOpenChange(v); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Apply a template</DialogTitle><DialogDescription>Adds a saved line to this sheet. A same-named line you have not touched is filled in; a line you priced or wrote yourself is never overwritten.</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <Field label="Type">
            <select className={selectCls} value={kind} onChange={(e) => { setKind(e.target.value as TemplateKind); setTemplateId(""); setItemId(""); setErrors({}); }}>{TEMPLATE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
          </Field>
          <Field label="Template">
            <select className={cn(selectCls, errors.template && "border-destructive")} value={templateId} aria-invalid={!!errors.template} onChange={(e) => { setTemplateId(e.target.value); setErrors((x) => ({ ...x, template: undefined, server: undefined })); }}>
              <option value="">{rows ? (ofKind.length ? "Select…" : "No templates of this type yet") : "Loading…"}</option>{ofKind.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            {errors.template && <span role="alert" className="block text-xs text-destructive">{errors.template}</span>}
            {loadError && <span role="alert" className="block text-xs text-destructive">{loadError}</span>}
          </Field>
          <Field label={kind === "OPERATION" ? "Apply to item" : "Apply to"}>
            <select className={cn(selectCls, errors.item && "border-destructive")} value={itemId} aria-invalid={!!errors.item} onChange={(e) => { setItemId(e.target.value); setErrors((x) => ({ ...x, item: undefined, server: undefined })); }}>
              <option value="">{kind === "OPERATION" ? "Select an item…" : "Whole project"}</option>{savedItems.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            {errors.item && <span role="alert" className="block text-xs text-destructive">{errors.item}</span>}
          </Field>
          {errors.server && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">{errors.server}</p>}
        </div>
        <DialogFooter className="sm:justify-between">
          {canManage ? <Button variant="ghost" onClick={onManage}>Manage templates<NeedsApproval why="template management needs pricing.edit" /></Button> : <span />}
          <div className="flex gap-2"><Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button><Button onClick={() => void apply()} disabled={busy}>{busy && <Loader2 className="animate-spin" />} Apply</Button></div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ manage

const TYPE_OPTIONS: Record<TemplateKind, { value: string; label: string }[]> = {
  OPERATION: COST_TYPES.map((v) => ({ value: v, label: COST_TYPE_LABEL[v] })),
  PROJECT_COST: PROJECT_METHODS.map((v) => ({ value: v, label: PROJECT_METHOD_LABEL[v] })),
  SUBCONTRACT: SUB_COST_TYPES.map((v) => ({ value: v, label: SUB_COST_TYPE_LABEL[v] })),
};
const BASE_OPTIONS: Record<TemplateKind, { value: string; label: string }[]> = {
  OPERATION: OP_PERCENT_BASES.map((v) => ({ value: v, label: OP_BASE_LABEL[v] })),
  PROJECT_COST: PROJECT_PERCENT_BASES.map((v) => ({ value: v, label: PROJECT_BASE_LABEL[v] })),
  SUBCONTRACT: SUB_PERCENT_BASES.map((v) => ({ value: v, label: SUB_BASE_LABEL[v] })),
};

function Err({ m }: { m?: string }) { return m ? <span role="alert" className="block text-xs text-destructive">{m}</span> : null; }

function TemplateEditor({ kind, initial, id, onDone, onCancel }: { kind: TemplateKind; initial: TemplateForm; id: string | null; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = React.useState(initial);
  const [errors, setErrors] = React.useState<TemplateFormErrors>({});
  const [server, setServer] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const set = (p: Partial<TemplateForm>) => { setF((x) => ({ ...x, ...p })); setServer(null); };
  const bad = (k: keyof TemplateForm) => (errors[k] ? "border-destructive" : "");
  async function save() {
    const e = validateTemplateForm(kind, f); setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const r = await api(id ? `/api/estimation-templates/${id}` : "/api/estimation-templates", id ? "PUT" : "POST", toTemplatePayload(kind, f));
    setBusy(false);
    if (!r.ok) { setServer(r.error); return; }
    toast.success(id ? "Template updated" : "Template saved"); onDone();
  }
  const priceLabel = kind === "SUBCONTRACT" ? "Unit price" : f.type === "PERCENTAGE" ? "Percentage (%)" : "Rate";
  return (
    <div className="space-y-3 rounded-xl border border-border bg-secondary/30 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className={cn(inputCls, bad("name"))} value={f.name} maxLength={80} aria-invalid={!!errors.name} onChange={(e) => set({ name: e.target.value })} /><Err m={errors.name} /></Field>
        <Field label={kind === "PROJECT_COST" ? "Method" : "Cost type"}><select className={cn(selectCls, bad("type"))} value={f.type} onChange={(e) => set({ type: e.target.value })}>{TYPE_OPTIONS[kind].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select><Err m={errors.type} /></Field>
        <Field label="Unit"><input className={cn(inputCls, bad("unit"))} value={f.unit} maxLength={20} aria-invalid={!!errors.unit} onChange={(e) => set({ unit: e.target.value })} /><Err m={errors.unit} /></Field>
        <Field label={priceLabel}><input className={cn(inputCls, "text-right", bad("rate"))} inputMode="decimal" value={f.rate} aria-invalid={!!errors.rate} onChange={(e) => set({ rate: e.target.value })} /><Err m={errors.rate} /></Field>
        {kind !== "OPERATION" || f.type !== "FIXED" ? <Field label="Quantity" hint={kind === "SUBCONTRACT" ? undefined : "Optional. Left blank, the sheet decides it."}><input className={cn(inputCls, "text-right", bad("quantity"))} inputMode="decimal" value={f.quantity} aria-invalid={!!errors.quantity} onChange={(e) => set({ quantity: e.target.value })} /><Err m={errors.quantity} /></Field> : null}
        {f.type === "PERCENTAGE" && <Field label="Percentage applies to"><select className={cn(selectCls, bad("percentBase"))} value={f.percentBase} aria-invalid={!!errors.percentBase} onChange={(e) => set({ percentBase: e.target.value })}><option value="">Choose base…</option>{BASE_OPTIONS[kind].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select><Err m={errors.percentBase} /></Field>}
        {kind === "PROJECT_COST" && <Field label="Category"><input className={inputCls} value={f.category} maxLength={40} onChange={(e) => set({ category: e.target.value })} /></Field>}
        {kind === "SUBCONTRACT" && <Field label="Subcontractor"><input className={inputCls} value={f.company} maxLength={120} onChange={(e) => set({ company: e.target.value })} /></Field>}
      </div>
      <Field label="Notes"><input className={inputCls} value={f.notes} maxLength={500} onChange={(e) => set({ notes: e.target.value })} /></Field>
      {server && <p role="alert" className="text-sm text-destructive">{server}</p>}
      <div className="flex gap-2"><Button size="sm" onClick={() => void save()} disabled={busy}>{busy && <Loader2 className="animate-spin" />} {id ? "Save changes" : "Save template"}</Button><Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button></div>
      <p className="text-xs text-muted-foreground">Editing or deleting a template never changes a sheet that already used it.</p>
    </div>
  );
}

export function ManageTemplatesDialog({ open, onOpenChange, onChanged }: { open: boolean; onOpenChange: (v: boolean) => void; onChanged: () => void }) {
  const [version, setVersion] = React.useState(0);
  const { rows, error } = useTemplates(open, version);
  const [kind, setKind] = React.useState<TemplateKind>("OPERATION");
  const [editing, setEditing] = React.useState<{ id: string | null; form: TemplateForm } | null>(null);
  const [del, setDel] = React.useState<TemplateRow | null>(null);
  const [delBusy, setDelBusy] = React.useState(false);
  const ofKind = (rows ?? []).filter((t) => t.kind === kind);
  const changed = () => { setVersion((v) => v + 1); onChanged(); setEditing(null); };
  async function remove() {
    if (!del) return;
    setDelBusy(true);
    const r = await api(`/api/estimation-templates/${del.id}`, "DELETE");
    setDelBusy(false); setDel(null);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success("Template deleted"); changed();
  }
  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) setEditing(null); onOpenChange(v); }}>
        <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>Templates</DialogTitle><DialogDescription>Saved operations, project costs and subcontractor services. Names are unique per type, ignoring case.</DialogDescription></DialogHeader>
          <div className="flex flex-wrap gap-2">{TEMPLATE_KINDS.map((k) => <button key={k} type="button" onClick={() => { setKind(k); setEditing(null); }} className={cn("rounded-lg px-3 py-1.5 text-sm font-medium", kind === k ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground hover:bg-secondary/80")}>{KIND_LABEL[k]}</button>)}</div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {!rows && !error && <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}
          {rows && (ofKind.length === 0 ? <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">No templates of this type yet.</p> : (
            <ul className="divide-y rounded-xl border bg-card">{ofKind.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate font-medium">{t.name}</span>
                <span className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing({ id: t.id, form: formFromTemplate(t.kind, t.name, t.data) })}><Pencil /> Edit</Button>
                  <button type="button" aria-label={`Delete ${t.name}`} className="rounded p-1.5 text-destructive hover:bg-destructive/10" onClick={() => setDel(t)}><Trash2 className="h-4 w-4" /></button>
                </span>
              </li>))}</ul>
          ))}
          {editing ? <TemplateEditor key={editing.id ?? "new"} kind={kind} id={editing.id} initial={editing.form} onDone={changed} onCancel={() => setEditing(null)} />
            : <div><Button variant="outline" size="sm" onClick={() => setEditing({ id: null, form: emptyTemplateForm(kind) })}><Plus /> New {KIND_LABEL[kind].toLowerCase()} template</Button></div>}
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={!!del} onOpenChange={(v) => !v && setDel(null)} title="Delete this template?" description={`"${del?.name ?? ""}" will be removed from the library. Sheets that already used it are not changed.`} loading={delBusy} onConfirm={() => void remove()} />
    </>
  );
}
