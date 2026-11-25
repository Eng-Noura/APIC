"use client";
import * as React from "react";
import { History, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface ActivityRow {
  id: string;
  timestamp: string;
  action: string;
  entity: string;
  detail: string | null;
  userName: string;
  userRole: string | null;
}

const ACTION: Record<string, { label: string; cls: string }> = {
  CREATE: { label: "Added", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  UPDATE: { label: "Changed", cls: "bg-blue-500/15 text-blue-700 dark:text-blue-400" },
  DELETE: { label: "Deleted", cls: "bg-red-500/15 text-red-700 dark:text-red-400" },
};

const when = (iso: string) => new Date(iso).toLocaleString([], { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Who did what and when. With `partId` it is the history of that one part; without, the latest changes in the whole
 * Part List of the project (added, edited, deleted, restored, quantities from an assembly or a nest, DXF files...).
 */
export function ActivityDialog({ open, onOpenChange, projectId, partId = null, title }: {
  open: boolean; onOpenChange: (v: boolean) => void; projectId: string; partId?: string | null; title?: string;
}) {
  const [rows, setRows] = React.useState<ActivityRow[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setRows(null); setFailed(false);
    const q = new URLSearchParams({ projectId });
    if (partId) q.set("partId", partId);
    fetch(`/api/takeoff/activity?${q}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((j: ActivityRow[]) => { if (!cancelled) setRows(j); })
      .catch(() => { if (!cancelled) { setRows([]); setFailed(true); } });
    return () => { cancelled = true; };
  }, [open, projectId, partId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><History className="h-4 w-4" /> {title ?? (partId ? "History of this part" : "Activity — who changed what")}</DialogTitle>
          <DialogDescription>
            {partId ? "Every change to this part: who made it and when." : "The latest additions, edits and deletions in this project's Part List: who made them and when."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          {rows === null ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
          ) : failed ? (
            <p className="py-6 text-center text-sm text-destructive">Could not load the history.</p>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nothing recorded yet. Changes made from now on appear here.</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((r) => {
                const a = ACTION[r.action] ?? { label: r.action, cls: "bg-muted text-muted-foreground" };
                return (
                  <li key={r.id} className="flex items-start gap-3 py-2">
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${a.cls}`}>{a.label}</span>
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-sm">{r.detail ?? "—"}</p>
                      <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">{r.userName}</span> · {when(r.timestamp)}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
