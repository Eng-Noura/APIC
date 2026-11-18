"use client";
import * as React from "react";
import { ChevronDown, ChevronRight, ClipboardList, Loader2, Pencil, Plus, Target, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import type { GroupingsData, ScopeRowDTO, WorkOrderGroupRowDTO } from "@/server/services/part-grouping.service";

const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

async function errorOf(res: Response, fallback: string) {
  const body = await res.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}

type Editing = { kind: "scope"; row: ScopeRowDTO | null } | { kind: "workOrder"; row: WorkOrderGroupRowDTO | null } | null;

function FormBody({ editing, projectId, onClose, onSaved }: { editing: NonNullable<Editing>; projectId: string; onClose: () => void; onSaved: () => void }) {
  const isScope = editing.kind === "scope";
  const wo = editing.kind === "workOrder" ? editing.row : null;
  const sc = editing.kind === "scope" ? editing.row : null;
  const [f, setF] = React.useState({
    description: sc?.description ?? "", code: wo?.code ?? "", name: wo?.name ?? "", dueDate: wo?.dueDate ?? "", remark: wo?.remark ?? "",
  });
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const existing = isScope ? sc : wo;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (isScope ? f.description.trim().length < 2 : !f.name.trim()) { toast.error(isScope ? "Scope description is required" : "Work order name is required"); return; }
    setBusy(true);
    const body = isScope
      ? { kind: "scope", projectId, description: f.description.trim() }
      : { kind: "workOrder", projectId, code: f.code.trim() || null, name: f.name.trim(), dueDate: f.dueDate || null, remark: f.remark.trim() || null };
    const res = await fetch(existing ? `/api/part-groupings/${editing.kind}/${existing.id}` : "/api/part-groupings", {
      method: existing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) { toast.error(await errorOf(res, "Failed to save")); return; }
    toast.success(existing ? "Saved" : isScope ? "Scope created" : "Work order created");
    onClose();
    onSaved();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <DialogHeader>
        <DialogTitle>{existing ? "Edit" : "New"} {isScope ? "Scope" : "Work Order"}</DialogTitle>
        <DialogDescription>{isScope ? "Scopes are shared with the project's Scope list." : "A work order is the set of parts that go to the shop together."}</DialogDescription>
      </DialogHeader>
      {isScope ? (
        <div className="space-y-1.5"><Label>Description</Label><Input autoFocus value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Riser duct fabrication" /></div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5"><Label>Code</Label><Input value={f.code} onChange={(e) => set("code", e.target.value)} placeholder={existing ? "" : "auto: WO-01"} /></div>
            <div className="col-span-2 space-y-1.5"><Label>Name</Label><Input autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Gable wall" /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5"><Label>Due date (optional)</Label><Input type="date" value={f.dueDate} onChange={(e) => set("dueDate", e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Remark (optional)</Label><Input value={f.remark} onChange={(e) => set("remark", e.target.value)} /></div>
          </div>
        </>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{existing ? "Save" : "Create"}</Button>
      </DialogFooter>
    </form>
  );
}

function Section({ title, icon: Icon, addLabel, canCreate, onAdd, empty, headers, children }: {
  title: string; icon: typeof Target; addLabel: string; canCreate: boolean; onAdd: () => void; empty: string | null; headers: string[]; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-2">
        <p className="flex items-center gap-2 text-sm font-semibold"><Icon className="h-4 w-4 text-muted-foreground" /> {title}</p>
        {canCreate && <Button size="sm" variant="outline" onClick={onAdd}><Plus className="h-4 w-4" /> {addLabel}</Button>}
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            {headers.map((h, i) => <th key={h} className={`px-3 py-1.5 font-medium ${i > 0 ? "text-right" : ""}`}>{h}</th>)}
            <th className="w-20" />
          </tr>
        </thead>
        <tbody>
          {empty && <tr><td colSpan={headers.length + 1} className="px-4 py-4 text-center text-muted-foreground">{empty}</td></tr>}
          {children}
        </tbody>
      </table>
    </div>
  );
}

/** Scopes and Work Orders of the project: how many parts and how many kg each holds. Parts are added from the Part List ("Group as…"). */
export function GroupingsPanel({ projectId, data, canCreate, canDelete, onChanged }: {
  projectId: string; data: GroupingsData | null; canCreate: boolean; canDelete: boolean; onChanged: () => void;
}) {
  const [open, setOpen] = React.useState(true);
  const [editing, setEditing] = React.useState<Editing>(null);
  const [deleting, setDeleting] = React.useState<{ kind: "scope" | "workOrder"; id: string; label: string } | null>(null);
  const [delBusy, setDelBusy] = React.useState(false);

  async function confirmDelete() {
    if (!deleting) return;
    setDelBusy(true);
    const res = await fetch(`/api/part-groupings/${deleting.kind}/${deleting.id}`, { method: "DELETE" });
    setDelBusy(false);
    if (!res.ok) { toast.error(await errorOf(res, "Failed to delete")); return; }
    toast.success("Deleted — its parts stay in the take-off");
    setDeleting(null);
    onChanged();
  }

  const actions = (onEdit: () => void, onDelete: () => void) => (
    <td className="px-2 py-1">
      <div className="flex justify-end gap-0.5">
        {canCreate && <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit" onClick={onEdit}><Pencil className="h-3.5 w-3.5" /></Button>}
        {canDelete && <Button size="icon" variant="ghost" className="h-7 w-7" title="Delete" onClick={onDelete}><Trash2 className="h-3.5 w-3.5 text-destructive" /></Button>}
      </div>
    </td>
  );

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
        <button type="button" className="flex items-center gap-2 text-sm font-semibold" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Scopes &amp; Work Orders
        </button>
        <p className="hidden text-xs text-muted-foreground sm:block">Tick parts in a drawing, then use “Group as…” to put them in an assembly, a scope or a work order.</p>
      </div>
      {open && (
        <div className="divide-y divide-border">
          <Section title="Scopes" icon={Target} addLabel="New Scope" canCreate={canCreate} onAdd={() => setEditing({ kind: "scope", row: null })}
            empty={data && data.scopes.length === 0 ? "No scopes yet." : null} headers={["Scope", "Parts", "Weight (kg)"]}>
            {(data?.scopes ?? []).map((s) => (
              <tr key={s.id} className="border-b border-border last:border-0 hover:bg-muted/10">
                <td className="px-3 py-1.5">{s.description}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{s.partCount}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(s.totalKg)}</td>
                {actions(() => setEditing({ kind: "scope", row: s }), () => setDeleting({ kind: "scope", id: s.id, label: s.description }))}
              </tr>
            ))}
          </Section>
          <Section title="Work Orders" icon={ClipboardList} addLabel="New Work Order" canCreate={canCreate} onAdd={() => setEditing({ kind: "workOrder", row: null })}
            empty={data && data.workOrders.length === 0 ? "No work orders yet." : null} headers={["Work order", "Due", "Parts", "Weight (kg)"]}>
            {(data?.workOrders ?? []).map((w) => (
              <tr key={w.id} className="border-b border-border last:border-0 hover:bg-muted/10">
                <td className="px-3 py-1.5"><span className="font-semibold">{w.code}</span> {w.name}{w.remark && <span className="ml-2 text-muted-foreground">({w.remark})</span>}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{w.dueDate ?? "—"}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{w.partCount}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{fmt(w.totalKg)}</td>
                {actions(() => setEditing({ kind: "workOrder", row: w }), () => setDeleting({ kind: "workOrder", id: w.id, label: `${w.code} — ${w.name}` }))}
              </tr>
            ))}
          </Section>
        </div>
      )}

      <Dialog open={!!editing} onOpenChange={(v) => !v && setEditing(null)}>
        <DialogContent className="sm:max-w-lg">
          {editing && <FormBody editing={editing} projectId={projectId} onClose={() => setEditing(null)} onSaved={onChanged} />}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!deleting} onOpenChange={(v) => !v && setDeleting(null)}
        title={deleting?.kind === "scope" ? "Delete scope?" : "Delete work order?"}
        description={`"${deleting?.label ?? ""}" will be removed${deleting?.kind === "scope" ? " (it also disappears from the project's Scope list)" : ""}. Its parts stay in the take-off.`}
        confirmLabel="Delete" loading={delBusy} onConfirm={confirmDelete}
      />
    </div>
  );
}
