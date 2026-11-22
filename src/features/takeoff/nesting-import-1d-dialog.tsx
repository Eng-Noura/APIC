"use client";
import * as React from "react";
import { Loader2, Check, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useTakeoffProject } from "./project-context";
import type { TakeoffDrawingRow } from "./types";
import {
  buildPartFromPiece, isFromPartList, knownWeightPerMeter, labelSet, parseNestPieces, parsePipeProfile, partListLabel, pieceDescription,
  type NestPiece,
} from "./nest-1d-parts";

const NEW_DRAWING = "__new__";
const selectCls =
  "h-9 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Status = "idle" | "importing" | "done" | "error";
interface Row extends NestPiece {
  checked: boolean;
  /** What the person can fill in where the nest does not say (typed text; empty = use what the nest / the table says). */
  weight: string;
  od: string;
  thk: string;
  status: Status;
  error?: string;
}

const num = (s: string) => {
  const v = Number(s);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

/**
 * "Take parts from 1D Nesting": the pieces of a 1D nest (this project's saved nest, or one of the user's history
 * entries) become profile / pipe parts of a drawing in Part List. Where the nest does not say enough — the weight per
 * metre of a profile that is not in the standard table, or the size of a pipe — the person types it here; nothing is guessed.
 */
export function Nesting1DImportDialog({
  open, onOpenChange, projectId, drawings, onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: string;
  drawings: TakeoffDrawingRow[];
  onImported: () => void;
}) {
  const { history, refreshHistory } = useTakeoffProject();
  const [source, setSource] = React.useState("project"); // "project" | "h:<historyId>"
  const [loaded, setLoaded] = React.useState<{ key: string; rows: Row[] } | null>(null);
  const [target, setTarget] = React.useState<string | null>(null); // null = not touched: use the default
  const [newNo, setNewNo] = React.useState("NESTING-1D");
  const [newTitle, setNewTitle] = React.useState("Parts from 1D Nesting");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) void refreshHistory();
  }, [open, refreshHistory]);

  // load the chosen nest; `loaded.key` tells which nest the rows belong to (so a stale answer is never shown)
  const key = `${projectId}|${source}`;
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const q = source === "project" ? `projectId=${projectId}` : `historyId=${source.slice(2)}`;
    fetch(`/api/nesting/workspace?kind=1D&${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((j: { data?: unknown } | null) => {
        if (cancelled) return;
        const rows = parseNestPieces(j?.data).map((p): Row => {
          const pipe = p.partType === "PIPE" ? parsePipeProfile(p.profile) : null;
          return {
            ...p, checked: true, status: "idle",
            weight: String(knownWeightPerMeter(p) ?? ""),
            od: pipe ? String(pipe.odMm) : "",
            thk: pipe ? String(pipe.thicknessMm) : "",
          };
        });
        setLoaded({ key, rows });
      });
    return () => {
      cancelled = true;
    };
  }, [open, key, source, projectId]);

  const loading = open && loaded?.key !== key;
  const rows = React.useMemo(() => (loaded?.key === key ? loaded.rows : []), [loaded, key]);
  const patch = (id: number, u: Partial<Row>) =>
    setLoaded((prev) => (prev ? { ...prev, rows: prev.rows.map((r) => (r.id === id ? { ...r, ...u } : r)) } : prev));

  const defaultTarget = drawings.find((d) => d.drawingNumber === "NESTING-1D")?.id ?? NEW_DRAWING;
  const chosen = target ?? defaultTarget;
  const targetDrawing = drawings.find((d) => d.id === chosen);

  // pieces that came FROM the Part List are never taken back (the part is the original)
  const labels = React.useMemo(() => labelSet(drawings.flatMap((d) => d.parts.map((p) => partListLabel(d.drawingNumber, p.itemNo, p.description)))), [drawings]);
  // a part already in the chosen drawing (same name) is not offered twice
  const taken = new Set((targetDrawing?.parts ?? []).map((p) => p.description.trim().toLowerCase()));
  // parts already linked to a piece of THIS project's nest are never offered again (the link, not the name, decides)
  const linkedIds = new Set(drawings.flatMap((d) => d.parts).filter((p) => p.nestKind === "1D" && p.nestPartId !== null).map((p) => p.nestPartId));

  const overrides = (r: Row) => ({ weightPerMeter: num(r.weight), odMm: num(r.od), thicknessMm: num(r.thk) });
  /** Why this row cannot be picked, or null when it can. */
  const blocked = (r: Row): string | null => {
    if (r.status === "done") return null;
    if (isFromPartList(r, labels)) return "Came from the Part List";
    if (r.partType === "PLATE") return "Plate — use 2D Nesting";
    if (source === "project" && linkedIds.has(r.id)) return "Already in Part List";
    if (taken.has(pieceDescription(r).toLowerCase())) return "Already in drawing";
    return null;
  };
  const built = (r: Row) => buildPartFromPiece(r, overrides(r));

  const pick = rows.filter((r) => r.checked && r.status !== "done" && !blocked(r) && built(r).ok);
  const needInput = rows.filter((r) => r.checked && r.status !== "done" && !blocked(r) && !built(r).ok).length;
  const selectable = rows.filter((r) => r.status !== "done" && !blocked(r));
  const allOn = selectable.length > 0 && selectable.every((r) => r.checked);
  const newInvalid = chosen === NEW_DRAWING && (!newNo.trim() || !newTitle.trim());

  async function run() {
    setBusy(true);
    let drawingId = chosen;
    if (chosen === NEW_DRAWING) {
      const res = await fetch("/api/takeoff/drawings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, drawingNumber: newNo.trim(), title: newTitle.trim(), weightFromDwg: null }),
      }).catch(() => null);
      if (!res?.ok) {
        setBusy(false);
        toast.error("Could not create the drawing");
        return;
      }
      drawingId = ((await res.json()) as { id: string }).id;
      setTarget(drawingId);
    }
    for (const r of pick) patch(r.id, { status: "importing", error: undefined });
    const res = await fetch("/api/takeoff/nest-1d-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId, drawingId,
        items: pick.map((r) => ({
          // only the project's own nest can be synced later; a history entry has no link to this project
          ...(source === "project" ? { nestPartId: r.id } : {}),
          name: r.name, profile: r.profile, material: r.material, lengthMm: r.lengthMm, qty: r.qty,
          partType: r.partType === "PIPE" ? "PIPE" : "HOT_ROLLED",
          ...overrides(r),
        })),
      }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { results?: { index: number; ok: boolean; error?: string }[]; error?: string } | null;
    let ok = 0;
    let failed = 0;
    pick.forEach((r, i) => {
      const hit = body?.results?.find((x) => x.index === i);
      if (res?.ok && hit?.ok) { ok++; patch(r.id, { status: "done" }); }
      else { failed++; patch(r.id, { status: "error", error: hit?.error ?? body?.error ?? "Import failed" }); }
    });
    setBusy(false);
    if (ok) {
      toast.success(`${ok} part(s) taken from 1D Nesting`);
      onImported();
    }
    if (failed) toast.error(`${failed} part(s) could not be added — see the list`);
    else if (ok) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-h-[92vh] w-[calc(100vw-1rem)] overflow-y-auto p-4 sm:max-w-5xl sm:p-6">
        <DialogHeader>
          <DialogTitle>Take parts from 1D Nesting</DialogTitle>
          <DialogDescription>
            The pieces of a 1D nest become profile / pipe parts of this project. A profile that is not in the standard weight table needs its weight per metre; a pipe needs a readable size — type them here.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            From
            <select className={selectCls} value={source} disabled={busy} onChange={(e) => setSource(e.target.value)}>
              <option value="project">This project’s nest</option>
              {history.map((h) => (
                <option key={h.id} value={`h:${h.id}`}>
                  History — {h.name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Into drawing
            <select className={selectCls} value={chosen} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
              {drawings.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.drawingNumber} — {d.title}
                </option>
              ))}
              <option value={NEW_DRAWING}>+ New drawing…</option>
            </select>
          </label>
          {chosen === NEW_DRAWING && (
            <>
              <label className="space-y-1 text-xs text-muted-foreground">
                Drawing number
                <Input value={newNo} disabled={busy} onChange={(e) => setNewNo(e.target.value)} />
              </label>
              <label className="space-y-1 text-xs text-muted-foreground">
                Title
                <Input value={newTitle} disabled={busy} onChange={(e) => setNewTitle(e.target.value)} />
              </label>
            </>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-12 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the nest…
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-12 text-center text-sm text-muted-foreground">
            {source === "project"
              ? "This project has no 1D nest saved yet. Pick a history entry above, or add parts in the 1D Nesting tab first."
              : "This history entry has no 1D parts."}
          </div>
        ) : (
          <>
            {needInput > 0 && (
              <p className="flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {needInput} selected part(s) need a value (marked in amber). They are not added until it is filled in.
              </p>
            )}
            <div className="max-h-[46vh] overflow-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 bg-card text-left text-muted-foreground shadow-[0_1px_0_0_var(--border,#e5e7eb)]">
                  <tr>
                    <th className="p-2">
                      <Checkbox
                        aria-label="Select all"
                        checked={allOn}
                        disabled={busy || selectable.length === 0}
                        onCheckedChange={(v) => setLoaded((prev) => (prev ? { ...prev, rows: prev.rows.map((r) => (r.status === "done" || blocked(r) ? r : { ...r, checked: v === true })) } : prev))}
                      />
                    </th>
                    <th className="p-2">Part</th>
                    <th className="p-2">Profile</th>
                    <th className="p-2">Length (mm)</th>
                    <th className="hidden p-2 md:table-cell">Material</th>
                    <th className="p-2">Qty</th>
                    <th className="p-2">Weight (kg/m) · Pipe OD × wall (mm)</th>
                    <th className="p-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const why = blocked(r);
                    const b = built(r);
                    const locked = busy || r.status === "done" || !!why;
                    const missing = !why && r.status !== "done" && !b.ok;
                    return (
                      <tr key={r.id} className={`border-t border-border ${why ? "opacity-60" : ""}`}>
                        <td className="p-2">
                          <Checkbox
                            aria-label={`Select ${pieceDescription(r)}`}
                            checked={r.checked && !why && r.status !== "done"}
                            disabled={locked}
                            onCheckedChange={(v) => patch(r.id, { checked: v === true })}
                          />
                        </td>
                        <td className="max-w-48 break-all p-2">{pieceDescription(r)}</td>
                        <td className="p-2 whitespace-nowrap">{r.profile || "—"}</td>
                        <td className="p-2 tabular-nums">{r.lengthMm > 0 ? r.lengthMm : "—"}</td>
                        <td className="hidden p-2 md:table-cell">{r.material || "—"}</td>
                        <td className="p-2 font-semibold tabular-nums">{r.qty}</td>
                        <td className="p-1">
                          {r.partType === "PIPE" ? (
                            <div className="flex items-center gap-1">
                              <Input
                                type="number" min={0} step="any" placeholder="OD" aria-label={`Outer diameter of ${pieceDescription(r)}`}
                                className={`h-8 w-20 ${missing ? "border-amber-400" : ""}`} value={r.od} disabled={locked}
                                onChange={(e) => patch(r.id, { od: e.target.value })}
                              />
                              ×
                              <Input
                                type="number" min={0} step="any" placeholder="wall" aria-label={`Wall thickness of ${pieceDescription(r)}`}
                                className={`h-8 w-20 ${missing ? "border-amber-400" : ""}`} value={r.thk} disabled={locked}
                                onChange={(e) => patch(r.id, { thk: e.target.value })}
                              />
                            </div>
                          ) : r.partType === "PLATE" ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Input
                              type="number" min={0} step="any" placeholder="?" aria-label={`Weight per metre of ${pieceDescription(r)}`}
                              className={`h-8 w-24 ${missing ? "border-amber-400" : ""}`} value={r.weight} disabled={locked}
                              onChange={(e) => patch(r.id, { weight: e.target.value })}
                            />
                          )}
                        </td>
                        <td className="p-2 whitespace-nowrap">
                          {r.status === "importing" ? (
                            <span className="inline-flex items-center gap-1 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Adding…</span>
                          ) : r.status === "done" ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800"><Check className="h-3 w-3" /> Added</span>
                          ) : r.status === "error" ? (
                            <span className="text-destructive" title={r.error}>{r.error ?? "Failed"}</span>
                          ) : why ? (
                            <span className="text-muted-foreground">{why}</span>
                          ) : !b.ok ? (
                            <span className="text-amber-700 dark:text-amber-300" title={b.reason}>Needs a value</span>
                          ) : (
                            <span className="text-muted-foreground">Ready</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {rows.some((r) => r.status === "done") ? "Close" : "Cancel"}
          </Button>
          <Button disabled={busy || loading || pick.length === 0 || newInvalid} onClick={() => void run()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Add {pick.length > 0 ? `${pick.length} part(s)` : "parts"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
