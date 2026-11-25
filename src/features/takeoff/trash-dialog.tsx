"use client";
import * as React from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { restoreFromTrash } from "./undo-delete";

interface TrashRow {
  id: string;
  description: string;
  drawingNumber: string;
  deletedAt: string;
  deletedBy: string | null;
  partType: string | null;
  qty: number | null;
  expiresAt: string;
}

const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000));

/** The deleted parts of the project, kept 30 days. "Restore" puts a part back where it was. */
export function TrashDialog({ open, onOpenChange, projectId, onRestored }: { open: boolean; onOpenChange: (v: boolean) => void; projectId: string; onRestored: () => void }) {
  const [rows, setRows] = React.useState<TrashRow[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/takeoff/trash?projectId=${encodeURIComponent(projectId)}`);
      if (!res.ok) throw new Error();
      setRows((await res.json()) as TrashRow[]);
    } catch {
      setRows([]);
      toast.error("Could not load the trash");
    }
  }, [projectId]);

  React.useEffect(() => { if (open) { setRows(null); void load(); } }, [open, load]);

  async function restore(id: string) {
    setBusy(id);
    const { restored, error } = await restoreFromTrash([id]);
    setBusy(null);
    if (error) toast.error(error);
    if (restored) { toast.success("Item restored"); onRestored(); }
    await load();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Trash2 className="h-4 w-4" /> Trash</DialogTitle>
          <DialogDescription>
            Deleted parts are kept for 30 days. A restored part comes back to its drawing, assembly, scope and work order — send it to Nesting again if it was in a nest.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] overflow-auto">
          {rows === null ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">The trash is empty.</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.description}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.drawingNumber}{r.qty !== null ? ` · qty ${r.qty}` : ""} · deleted {new Date(r.deletedAt).toLocaleString()}{r.deletedBy ? ` by ${r.deletedBy}` : ""} · {daysLeft(r.expiresAt)} day(s) left
                    </p>
                  </div>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => restore(r.id)}>
                    {busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />} Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
