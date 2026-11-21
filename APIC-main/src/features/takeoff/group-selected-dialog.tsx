"use client";
import * as React from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { GroupingsData } from "@/server/services/part-grouping.service";

/** The three ways to group parts. Assembly also fixes quantities; Scope and Work Order are plain labels. */
export type GroupKind = "assembly" | "scope" | "workOrder";
export const GROUP_KIND_LABEL: Record<GroupKind, string> = { assembly: "Assembly", scope: "Scope", workOrder: "Work Order" };

const NEW = "__new__";
const NONE = "__none__";

async function errorOf(res: Response, fallback: string) {
  const body = await res.json().catch(() => null);
  return typeof body?.error === "string" ? body.error : fallback;
}
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function Body({ kind, projectId, partIds, data, onClose, onDone }: {
  kind: GroupKind; projectId: string; partIds: string[]; data: GroupingsData | null; onClose: () => void; onDone: () => void;
}) {
  const options = React.useMemo(() => {
    if (!data) return [] as { id: string; label: string }[];
    if (kind === "assembly") return data.assemblies.map((a) => ({ id: a.id, label: `${a.code} — ${a.name}` }));
    if (kind === "scope") return data.scopes.map((s) => ({ id: s.id, label: s.description }));
    return data.workOrders.map((w) => ({ id: w.id, label: `${w.code} — ${w.name}` }));
  }, [data, kind]);

  const [target, setTarget] = React.useState(options.length ? options[0].id : NEW);
  const [f, setF] = React.useState({ code: "", name: "", description: "", qty: "1", perAsm: "" });
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const label = GROUP_KIND_LABEL[kind];

  async function submit() {
    setBusy(true);
    try {
      let targetId: string | null = target === NONE ? null : target;

      if (target === NEW) {
        if (kind === "assembly") {
          const qty = Number(f.qty);
          if (!f.code.trim() || !f.name.trim() || !Number.isInteger(qty) || qty < 0) throw new Error("Assembly code, name and a whole-number quantity are required");
          const res = await post("/api/part-groups", { projectId, code: f.code.trim(), name: f.name.trim(), qty });
          if (!res.ok) throw new Error(await errorOf(res, "Could not create the assembly"));
          targetId = (await res.json()).id as string;
        } else if (kind === "scope") {
          if (f.description.trim().length < 2) throw new Error("Scope description is required");
          const res = await post("/api/part-groupings", { kind, projectId, description: f.description.trim() });
          if (!res.ok) throw new Error(await errorOf(res, "Could not create the scope"));
          targetId = (await res.json()).id as string;
        } else {
          if (!f.name.trim()) throw new Error("Work order name is required");
          const res = await post("/api/part-groupings", { kind, projectId, name: f.name.trim(), code: f.code.trim() || null });
          if (!res.ok) throw new Error(await errorOf(res, "Could not create the work order"));
          targetId = (await res.json()).id as string;
        }
      }

      if (kind === "assembly") {
        const per = f.perAsm.trim() === "" ? undefined : Number(f.perAsm);
        if (per !== undefined && (!Number.isInteger(per) || per <= 0)) throw new Error("Qty per assembly must be a whole number above 0");
        const res = await post("/api/part-groups/assign", { projectId, groupId: targetId, partIds, qtyPerAssembly: per });
        if (!res.ok) throw new Error(await errorOf(res, "Could not group the parts"));
        const body = await res.json();
        toast.success(`${body.assigned} part${body.assigned === 1 ? "" : "s"} ${targetId ? "added to the assembly" : "taken out of their assembly"}${body.quantityChanged?.length ? ` — ${body.quantityChanged.length} quantities adjusted` : ""}`);
      } else {
        const res = await post("/api/part-groupings/assign", { projectId, kind, targetId, partIds });
        if (!res.ok) throw new Error(await errorOf(res, "Could not group the parts"));
        const body = await res.json();
        toast.success(`${body.assigned} part${body.assigned === 1 ? "" : "s"} ${targetId ? `added to the ${label.toLowerCase()}` : `taken out of their ${label.toLowerCase()}`}`);
      }
      onClose();
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  }

  const noneSelected = target === NONE;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Group {partIds.length} part{partIds.length === 1 ? "" : "s"} as {label}</DialogTitle>
        <DialogDescription>
          {kind === "assembly" && "A part belongs to one assembly. Its total quantity becomes the assembly quantity × its qty per assembly."}
          {kind === "scope" && "A part belongs to one scope of work (the same Scope list shown on the project page)."}
          {kind === "workOrder" && "A part belongs to one work order — the parts that go to the shop together."}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>{label}</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {options.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
              <SelectItem value={NEW}>＋ New {label.toLowerCase()}…</SelectItem>
              <SelectItem value={NONE}>— None (take the parts out) —</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {target === NEW && kind === "assembly" && (
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5"><Label>Code</Label><Input autoFocus value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="0515-1" /></div>
            <div className="space-y-1.5"><Label>Name</Label><Input value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Gable Wall" /></div>
            <div className="space-y-1.5"><Label>Qty</Label><Input type="number" min={0} value={f.qty} onChange={(e) => set("qty", e.target.value)} /></div>
          </div>
        )}
        {target === NEW && kind === "scope" && (
          <div className="space-y-1.5"><Label>Scope description</Label><Input autoFocus value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="e.g. Riser duct fabrication" /></div>
        )}
        {target === NEW && kind === "workOrder" && (
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5"><Label>Code (optional)</Label><Input value={f.code} onChange={(e) => set("code", e.target.value)} placeholder="auto: WO-01" /></div>
            <div className="col-span-2 space-y-1.5"><Label>Name</Label><Input autoFocus value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Gable wall" /></div>
          </div>
        )}
        {kind === "assembly" && !noneSelected && (
          <div className="space-y-1.5">
            <Label>Qty per assembly (optional)</Label>
            <Input type="number" min={1} value={f.perAsm} onChange={(e) => set("perAsm", e.target.value)} placeholder="auto — keep the current quantity when it divides evenly" />
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button onClick={() => void submit()} disabled={busy}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {noneSelected ? "Take out" : target === NEW ? "Create & add" : "Add"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function GroupSelectedDialog({ open, onOpenChange, kind, projectId, partIds, data, onDone }: {
  open: boolean; onOpenChange: (v: boolean) => void; kind: GroupKind; projectId: string; partIds: string[]; data: GroupingsData | null; onDone: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* mounted fresh every time the window opens, so it always starts clean */}
        <Body key={kind} kind={kind} projectId={projectId} partIds={partIds} data={data} onClose={() => onOpenChange(false)} onDone={onDone} />
      </DialogContent>
    </Dialog>
  );
}
