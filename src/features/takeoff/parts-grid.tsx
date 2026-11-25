"use client";
import { isNestable, nestKindOf } from "@/features/nesting/part-routing";
import * as React from "react";
import { Pencil, Trash2, MoreVertical, History, Plus, Sigma, X, Upload, FileCheck2, FileX2, Loader2, Download, TriangleAlert, Layers, FileUp, FileSpreadsheet, ListTree, Target, ClipboardList } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTakeoffProject } from "./project-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { showUndoToast } from "./undo-delete";
import { ActivityDialog } from "./activity-dialog";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { toast } from "sonner";
import { explainTakeoffPart } from "@/server/calc/takeoff";
import { PartForm } from "./part-form";
import { DxfImportDialog } from "./dxf-import-dialog";
import { CsvImportDialog } from "./csv-import-dialog";
import { GroupSelectedDialog, type GroupKind } from "./group-selected-dialog";
import type { GroupingsData } from "@/server/services/part-grouping.service";
import type { TakeoffPartRow, PartType } from "./types";

// Defensive: legacy/partial rows can come back from the API as null —
// never let that turn a running total into NaN.
function n(v: number | null | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

const PART_TYPE_LABEL: Record<PartType, string> = {
  PLATE: "Plate",
  HOT_ROLLED: "Hot Rolled",
  CONE: "Cone",
  PIPE: "Pipe",
  ACCESSORY: "Accessory",
};

function geometrySummary(part: TakeoffPartRow): string {
  const g = (part.geometry ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
  switch (part.partType) {
    case "PLATE":
      return `${num(g.width) || "—"} × ${num(g.length) || "—"} m${g.cutoffFormula ? ", cut-out" : ""}`;
    case "CONE":
      return `D1 ${num(g.d1) || "—"} / D2 ${num(g.d2) || "—"} / H ${num(g.height) || "—"} m`;
    case "PIPE":
      return `OD ${num(g.od) || "—"} m × L ${num(g.length) || "—"} m`;
    case "HOT_ROLLED":
      return `${String(g.profile ?? "—")}, L ${num(g.length) || "—"} m`;
    case "ACCESSORY":
      return `per ${String(g.unit ?? "pcs")}${num(g.unitWeightKg) > 0 ? `, ${num(g.unitWeightKg)} kg each` : ", no weight"}`;
    default:
      return "—";
  }
}

/** A small label chip for the Assembly / Scope / Work Order columns ("—" when the part has none). */
function GroupChip({ text, title }: { text: string | null; title?: string }) {
  if (!text) return <span className="text-muted-foreground/50">—</span>;
  return <span title={title ?? text} className="inline-block max-w-[9rem] truncate rounded bg-muted px-1.5 py-0.5 align-middle text-[11px] font-medium text-foreground">{text}</span>;
}

export function PartsGrid({
  drawingId, projectId, parts, canCreate, canDelete, onChanged, groupings = null, onGroupingsChanged, accessoriesDefault = false,
}: {
  drawingId: string;
  projectId: string;
  parts: TakeoffPartRow[];
  canCreate: boolean;
  canDelete: boolean;
  onChanged: () => void;
  /** the project's assemblies / scopes / work orders — used for the three group columns and the "Group as…" buttons */
  groupings?: GroupingsData | null;
  onGroupingsChanged?: () => void;
  /** This drawing is the Accessories section (CSV rows default to Accessory). */
  accessoriesDefault?: boolean;
}) {
  const [groupKind, setGroupKind] = React.useState<GroupKind>("assembly");
  const [groupOpen, setGroupOpen] = React.useState(false);
  const openGroup = (k: GroupKind) => { setGroupKind(k); setGroupOpen(true); };
  const asmById = React.useMemo(() => new Map((groupings?.assemblies ?? []).map((a) => [a.id, a])), [groupings]);
  const scopeById = React.useMemo(() => new Map((groupings?.scopes ?? []).map((s) => [s.id, s])), [groupings]);
  const woById = React.useMemo(() => new Map((groupings?.workOrders ?? []).map((w) => [w.id, w])), [groupings]);
  const [formOpen, setFormOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [csvOpen, setCsvOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TakeoffPartRow | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = React.useState(false);
  // Multi-select: ticked part ids + the bulk-delete confirmation.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [historyPart, setHistoryPart] = React.useState<{ id: string; description: string } | null>(null);
  const [bulkDeleteLoading, setBulkDeleteLoading] = React.useState(false);
  const [uploadingId, setUploadingId] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const uploadTargetId = React.useRef<string | null>(null);

  const nextItemNo = parts.reduce((max, p) => Math.max(max, p.itemNo), 0) + 1;

  function openAdd() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(part: TakeoffPartRow) {
    setEditing(part);
    setFormOpen(true);
  }

  async function handleDelete() {
    if (!deletingId) return;
    setDeleteLoading(true);
    const res = await fetch(`/api/takeoff/parts/${deletingId}`, { method: "DELETE" });
    setDeleteLoading(false);
    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      toast.error(typeof j?.error === "string" ? j.error : "Failed to delete item");
      return;
    }
    const { trashId } = (await res.json().catch(() => ({}))) as { trashId?: string | null };
    showUndoToast("Item deleted", trashId ? [trashId] : [], onChanged);
    setDeletingId(null);
    onChanged();
  }

  // Drop ids of parts that no longer exist (after a delete / reload).
  React.useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(parts.map((p) => p.id));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [parts]);

  const allSelected = parts.length > 0 && parts.every((p) => selected.has(p.id));
  const someSelected = selected.size > 0 && !allSelected;
  function toggleOne(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }
  function toggleAll(on: boolean) {
    setSelected(on ? new Set(parts.map((p) => p.id)) : new Set());
  }

  async function handleBulkDelete() {
    setBulkDeleteLoading(true);
    const ids = [...selected];
    const results = await Promise.all(
      ids.map((id) =>
        fetch(`/api/takeoff/parts/${id}`, { method: "DELETE" })
          .then(async (r) => (r.ok ? ((await r.json().catch(() => ({}))) as { trashId?: string | null }).trashId ?? "" : null))
          .catch(() => null),
      ),
    );
    setBulkDeleteLoading(false);
    const failed = results.filter((r) => r === null).length;
    const trashIds = results.filter((r): r is string => !!r);
    if (failed) toast.error(`${failed} of ${ids.length} item(s) could not be deleted`);
    if (ids.length - failed > 0) showUndoToast(`${ids.length - failed} item(s) deleted`, trashIds, onChanged);
    setBulkDeleteOpen(false);
    setSelected(new Set());
    onChanged();
  }

  function triggerUpload(partId: string) {
    uploadTargetId.current = partId;
    fileInputRef.current?.click();
  }

  async function handleFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const partId = uploadTargetId.current;
    e.target.value = "";
    if (!file || !partId) return;
    setUploadingId(partId);
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/takeoff/parts/${partId}/dxf`, { method: "POST", body: form });
    setUploadingId(null);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error ?? "Failed to upload DXF");
      return;
    }
    const dxf = await res.json();
    if (dxf.valid) {
      toast.success("DXF uploaded and validated");
      if (dxf.unitsWarning) toast.warning(dxf.unitsWarning, { duration: 10000 });
    } else {
      toast.error(dxf.errorMessage ?? "DXF uploaded but invalid");
    }
    onChanged();
  }

  async function handleRemoveDxf(partId: string) {
    setUploadingId(partId);
    const res = await fetch(`/api/takeoff/parts/${partId}/dxf`, { method: "DELETE" });
    setUploadingId(null);
    if (!res.ok) { toast.error("Failed to remove DXF"); return; }
    toast.success("DXF removed");
    onChanged();
  }

  const router = useRouter();
  const { queueForNesting } = useTakeoffProject();
  // Plates go to the 2D tool (need a valid DXF); every other type goes to 1D.
  function sendToNesting(ids: string[]) {
    const chosen = parts.filter((p) => ids.includes(p.id) && isNestable(p));
    const ids2D = chosen.filter((p) => nestKindOf(p.partType) === "2D").map((p) => p.id);
    const ids1D = chosen.filter((p) => nestKindOf(p.partType) === "1D").map((p) => p.id);
    if (ids2D.length) queueForNesting(ids2D, "2D");
    if (ids1D.length) queueForNesting(ids1D, "1D");
    toast.success(
      [ids2D.length && `${ids2D.length} plate(s) → 2D`, ids1D.length && `${ids1D.length} part(s) → 1D`].filter(Boolean).join(", ") || "Nothing to send",
    );
    // only bars / pipes / profiles were sent: open the 1D workspace, otherwise the 2D one
    router.push(ids1D.length && !ids2D.length ? "/takeoff/nesting?view=1d" : "/takeoff/nesting");
  }
  const nestableIds = parts.filter(isNestable).map((p) => p.id);

  const totalArea = parts.reduce((s, p) => s + n(p.totalArea), 0);
  const totalPaintArea = parts.reduce((s, p) => s + n(p.paintAreaSqm), 0);
  const totalWeight = parts.reduce((s, p) => s + n(p.weightKg), 0);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/20 text-left text-xs text-muted-foreground">
              <th className="w-8 px-2 py-1.5">
                <Checkbox
                  aria-label="Select all items"
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={(v) => toggleAll(v === true)}
                  disabled={parts.length === 0}
                />
              </th>
              <th className="px-2 py-1.5 font-medium">Item</th>
              <th className="px-2 py-1.5 font-medium">Description</th>
              <th className="border-l border-border px-2 py-1.5 font-medium">Type</th>
              <th className="px-2 py-1.5 font-medium">Geometry</th>
              <th className="border-l border-border px-2 py-1.5 font-medium">Side</th>
              <th className="px-2 py-1.5 text-right font-medium">Qty</th>
              <th className="px-2 py-1.5 text-right font-medium">Thk (mm)</th>
              <th className="px-2 py-1.5 text-center font-medium">Paint</th>
              <th className="border-l border-border px-2 py-1.5 text-right font-medium">Total Area</th>
              <th className="px-2 py-1.5 text-right font-medium">Paint Area</th>
              <th className="px-2 py-1.5 text-right font-medium">Weight (kg)</th>
              <th className="border-l border-border px-2 py-1.5 font-medium">Assembly</th>
              <th className="px-2 py-1.5 font-medium">Scope</th>
              <th className="px-2 py-1.5 font-medium">Work Order</th>
              <th className="border-l border-border px-2 py-1.5 text-center font-medium">DXF</th>
              <th className="px-1 py-1.5" />
              <th className="px-1 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {parts.length === 0 && (
              <tr>
                <td colSpan={19} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No items yet — use &quot;Add Item&quot; to enter the first part.
                </td>
              </tr>
            )}
            {parts.map((part) => {
              const isExpanded = expandedId === part.id;
              const explanation = isExpanded
                ? explainTakeoffPart({
                    partType: part.partType,
                    geometry: part.geometry,
                    qty: part.qty,
                    thicknessMm: part.thicknessMm,
                    paintSides: part.paintSides,
                    areaFormula: part.areaFormula,
                    buyWeightKg: part.buyWeightKg,
                  })
                : null;
              return (
                <React.Fragment key={part.id}>
                  <tr className={`border-b border-border hover:bg-muted/10 ${selected.has(part.id) ? "bg-primary/5" : ""}`}>
                    <td className="w-8 px-2 py-1.5">
                      <Checkbox
                        aria-label={`Select item ${part.itemNo}`}
                        checked={selected.has(part.id)}
                        onCheckedChange={(v) => toggleOne(part.id, v === true)}
                      />
                    </td>
                    <td className="px-2 py-1.5 tabular-nums">{part.itemNo}</td>
                    <td className="px-2 py-1.5">{part.description}</td>
                    <td className="border-l border-border px-2 py-1.5">{PART_TYPE_LABEL[part.partType]}</td>
                    <td className="px-2 py-1.5 text-xs text-muted-foreground">{geometrySummary(part)}</td>
                    <td className="border-l border-border px-2 py-1.5 text-xs">{part.side === "INTERNAL" ? "Internal" : part.side === "BOTH" ? "Both" : "External"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{part.qty}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{part.thicknessMm ?? "—"}</td>
                    <td className="px-2 py-1.5 text-center text-xs">{part.paintSides === 1 ? "1 side" : "2 sides"}</td>
                    <td className="border-l border-border px-2 py-1.5 text-right tabular-nums">{n(part.totalArea).toFixed(3)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{n(part.paintAreaSqm).toFixed(3)}</td>
                    <td className="px-2 py-1.5 text-right font-medium tabular-nums text-primary">{n(part.weightKg).toFixed(1)}</td>
                    <td className="border-l border-border px-2 py-1.5"><GroupChip text={part.groupId ? asmById.get(part.groupId)?.code ?? "?" : null} title={part.groupId ? `${asmById.get(part.groupId)?.code ?? ""} — ${asmById.get(part.groupId)?.name ?? ""}` : undefined} /></td>
                    <td className="px-2 py-1.5"><GroupChip text={part.scopeId ? scopeById.get(part.scopeId)?.description ?? "?" : null} /></td>
                    <td className="px-2 py-1.5"><GroupChip text={part.workOrderGroupId ? woById.get(part.workOrderGroupId)?.code ?? "?" : null} title={part.workOrderGroupId ? `${woById.get(part.workOrderGroupId)?.code ?? ""} — ${woById.get(part.workOrderGroupId)?.name ?? ""}` : undefined} /></td>
                    <td className="border-l border-border px-2 py-1.5 text-center">
                      {uploadingId === part.id ? (
                        <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      ) : part.dxf ? (
                        <div className="flex items-center justify-center gap-1.5">
                          <a
                            href={part.dxf.filePath}
                            download={part.dxf.fileName}
                            title={`Download ${part.dxf.fileName}`}
                            className="flex items-center justify-center text-muted-foreground hover:text-foreground"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                          {part.dxf.valid && part.qty > 0 ? (
                            <button
                              type="button"
                              title="Send this part to 2D Nesting"
                              className="flex items-center justify-center text-muted-foreground hover:text-primary"
                              onClick={() => sendToNesting([part.id])}
                            >
                              <Layers className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="flex items-center gap-1 text-xs"
                            title={part.dxf.valid
                              ? `${part.dxf.fileName} — ${part.dxf.areaSqm?.toFixed(3) ?? "?"} m², ${part.dxf.bboxWidthMm?.toFixed(0)}×${part.dxf.bboxHeightMm?.toFixed(0)} mm${part.dxf.holeCount ? `, ${part.dxf.holeCount} hole(s)` : ""} — click to remove`
                              : `${part.dxf.fileName} — ${part.dxf.errorMessage ?? "Invalid"} — click to re-upload`}
                            onClick={() => (part.dxf?.valid ? handleRemoveDxf(part.id) : triggerUpload(part.id))}
                          >
                            {part.dxf.valid
                              ? <FileCheck2 className="h-3.5 w-3.5 text-emerald-600" />
                              : <FileX2 className="h-3.5 w-3.5 text-destructive" />}
                          </button>
                          {part.dxf.valid && part.dxf.unitsWarning ? (
                            <span title={part.dxf.unitsWarning}>
                              <TriangleAlert className="h-3.5 w-3.5 text-amber-500" />
                            </span>
                          ) : null}
                        </div>
                      ) : canCreate ? (
                        <button type="button" title="Upload DXF" className="mx-auto flex items-center justify-center text-muted-foreground hover:text-foreground" onClick={() => triggerUpload(part.id)}>
                          <Upload className="h-3.5 w-3.5" />
                        </button>
                      ) : (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-1 py-1.5 text-center">
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="Show the equation for this row" onClick={() => setExpandedId(isExpanded ? null : part.id)}>
                        {isExpanded ? <X className="h-3.5 w-3.5 text-muted-foreground" /> : <Sigma className="h-3.5 w-3.5 text-muted-foreground" />}
                      </Button>
                    </td>
                    <td className="px-1 py-1.5">
                      <div className="flex items-center justify-end gap-1">
                        {canCreate && (
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(part)} title="Edit item">
                            <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                          </Button>
                        )}
                        {/* delete lives in a menu, away from the edit button (one click on the wrong icon can no longer delete) */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="icon" variant="ghost" className="ml-1 h-7 w-7" title="More actions" aria-label="More actions">
                              <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setExpandedId(isExpanded ? null : part.id)}>
                              <Sigma className="h-3.5 w-3.5" /> {isExpanded ? "Hide the equation" : "Show the equation"}
                            </DropdownMenuItem>
                            {canCreate && (
                              <DropdownMenuItem onSelect={() => openEdit(part)}><Pencil className="h-3.5 w-3.5" /> Edit item</DropdownMenuItem>
                            )}
                            <DropdownMenuItem onSelect={() => setHistoryPart({ id: part.id, description: part.description })}>
                              <History className="h-3.5 w-3.5" /> History — who changed it
                            </DropdownMenuItem>
                            {canDelete && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => setDeletingId(part.id)}>
                                  <Trash2 className="h-3.5 w-3.5" /> Delete item…
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                  </tr>
                  {isExpanded && explanation && (
                    <tr className="border-b border-border bg-primary/5">
                      <td colSpan={18} className="px-4 py-3">
                        <div className="flex flex-wrap gap-x-8 gap-y-1.5 text-xs">
                          {explanation.lines.map((line) => (
                            <div key={line.label} className="min-w-[180px]">
                              <div className="text-muted-foreground">{line.label}</div>
                              <div className="font-mono text-foreground">
                                {line.formula} <span className="text-muted-foreground">=</span> <span className="font-semibold">{line.result}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-3 py-2">
        {canCreate ? (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5" /> Add Item
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setImportOpen(true)} title="Import DXF files — a sheet with several labelled parts is split into items">
              <FileUp className="h-3.5 w-3.5" /> Import DXF
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCsvOpen(true)} title="Import hot-rolled sections, pipes and accessories (bolts, nuts, washers) from a CSV file">
              <FileSpreadsheet className="h-3.5 w-3.5" /> Import CSV
            </Button>
          </div>
        ) : <span />}
        {selected.size > 0 && (
          // Floating bar pinned to the bottom of the window, so the actions are always in reach however long the list is
          <div role="toolbar" aria-label="Actions for the selected parts" className="fixed bottom-4 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-xs shadow-xl animate-in fade-in slide-in-from-bottom-4">
            <span className="font-medium">{selected.size} selected</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={!parts.some((p) => selected.has(p.id) && isNestable(p))}
              onClick={() => sendToNesting(parts.filter((p) => selected.has(p.id) && isNestable(p)).map((p) => p.id))}
              title="Send the selected parts to Nesting — plates (with a valid DXF) go to 2D, everything else goes to 1D"
            >
              <Layers className="h-3.5 w-3.5" /> Send selected to Nesting
            </Button>
            {canCreate && (
              <>
                <span className="ml-1 text-muted-foreground">Group as:</span>
                <Button size="sm" variant="secondary" onClick={() => openGroup("assembly")} title="Put the selected parts in an assembly"><ListTree className="h-3.5 w-3.5" /> Assembly</Button>
                <Button size="sm" variant="secondary" onClick={() => openGroup("scope")} title="Put the selected parts in a scope"><Target className="h-3.5 w-3.5" /> Scope</Button>
                <Button size="sm" variant="secondary" onClick={() => openGroup("workOrder")} title="Put the selected parts in a work order"><ClipboardList className="h-3.5 w-3.5" /> Work Order</Button>
              </>
            )}
            {canDelete && (
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setBulkDeleteOpen(true)}>
                <Trash2 className="h-3.5 w-3.5" /> Delete selected
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}
        <Button size="sm" variant="ghost" disabled={!nestableIds.length} onClick={() => sendToNesting(nestableIds)} title="Send every nestable part in this drawing — plates (with a valid DXF) to 2D, everything else to 1D">
          <Layers className="h-3.5 w-3.5" /> Send all to Nesting ({nestableIds.length})
        </Button>
        <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
          <span>Total Area: <span className="font-semibold text-foreground">{totalArea.toFixed(3)} m²</span></span>
          <span>Paint Area: <span className="font-semibold text-foreground">{totalPaintArea.toFixed(3)} m²</span></span>
          <span>Total Weight: <span className="font-semibold text-primary">{totalWeight.toFixed(1)} kg</span></span>
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept=".dxf" className="hidden" onChange={handleFileChosen} />

      {canCreate && (
        <DxfImportDialog open={importOpen} onOpenChange={setImportOpen} drawingId={drawingId} onImported={onChanged} />
      )}

      {canCreate && (
        <CsvImportDialog open={csvOpen} onOpenChange={setCsvOpen} drawingId={drawingId} nextItemNo={nextItemNo} onImported={onChanged} accessoriesDefault={accessoriesDefault} />
      )}

      {canCreate && (
        <PartForm
          open={formOpen}
          onOpenChange={setFormOpen}
          drawingId={drawingId}
          editing={editing}
          nextItemNo={nextItemNo}
          onSaved={onChanged}
        />
      )}

      {historyPart && (
        <ActivityDialog open onOpenChange={(v) => !v && setHistoryPart(null)} projectId={projectId} partId={historyPart.id} title={`History — ${historyPart.description}`} />
      )}

      <ConfirmDialog
        open={!!deletingId}
        onOpenChange={(v) => !v && setDeletingId(null)}
        title="Delete this item?"
        items={deletingId ? [parts.find((p) => p.id === deletingId)?.description ?? ""] : undefined}
        description="It is removed from the drawing and from the 2D / 1D nest it is in. You can undo it right after, or restore it from the Trash for 30 days."
        confirmLabel="Delete"
        loading={deleteLoading}
        onConfirm={handleDelete}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${selected.size} item(s)?`}
        items={parts.filter((p) => selected.has(p.id)).map((p) => p.description)}
        requireText={selected.size > 5 ? "DELETE" : undefined}
        description="They are removed from the drawing and from the 2D / 1D nests they are in. You can undo it right after, or restore them from the Trash for 30 days."
        confirmLabel={`Delete ${selected.size} item(s)`}
        loading={bulkDeleteLoading}
        onConfirm={handleBulkDelete}
      />

      {canCreate && (
        <GroupSelectedDialog
          open={groupOpen}
          onOpenChange={setGroupOpen}
          kind={groupKind}
          projectId={projectId}
          partIds={[...selected]}
          data={groupings}
          onDone={() => { setSelected(new Set()); onChanged(); onGroupingsChanged?.(); }}
        />
      )}
    </div>
  );
}
