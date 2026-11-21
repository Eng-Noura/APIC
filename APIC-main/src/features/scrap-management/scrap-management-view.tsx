"use client";
import * as React from "react";
import { AlertTriangle, Banknote, Boxes, Download, Loader2, Percent, Recycle, RotateCcw, Scale, TrendingDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { KpiCard } from "@/components/shared/kpi-card";
import { useTakeoffProject } from "@/features/takeoff/project-context";
import { decodeSnapshot } from "@/features/nesting/nest-boost/persist";
import { buildMaterialRequests } from "@/features/nesting/nest-boost/material-requests";
import { sourcesFromMaterialLines, type ScrapSource } from "./from-nesting";
import {
  calculateScrapRow, calculateScrapScenarios, calculateScrapTotals,
  type ScrapRowInput,
} from "@/server/calc/scrap-management";
import { ApplyToSourcesDialog } from "./apply-dialog";
import { DEFAULT_SCRAP_DEFAULTS, loadScrapState, saveScrapState, type ScrapRowEdit } from "./storage";

type SourceGroup = ScrapSource;

const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (n: number, d = 1) => `${fmt(n * 100, d)}%`;
const SCENARIOS = [0, 0.25, 0.5, 0.75, 1];

/** Number cell that lets the field be empty while typing and only commits real numbers. */
function NumCell({ value, onChange, step = "any", max, className }: {
  value: number; onChange: (n: number) => void; step?: string; max?: number; className?: string;
}) {
  // While the field is focused we show exactly what is typed (so it can be empty or "4."); otherwise the value.
  const [draft, setDraft] = React.useState<string | null>(null);
  const text = draft ?? String(Number(value.toFixed(4)));
  return (
    <Input
      type="number" inputMode="decimal" step={step} min={0} max={max} value={text}
      className={`h-8 w-24 bg-sky-50 px-2 text-right dark:bg-sky-950/30 ${className ?? ""}`}
      onBlur={() => setDraft(null)}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== "" && isFinite(n) && n >= 0) onChange(max != null ? Math.min(n, max) : n);
      }}
    />
  );
}

export function ScrapManagementView({ canExport }: { canExport: boolean }) {
  const { projectId, projects } = useTakeoffProject();
  const project = projects.find((p) => p.id === projectId);

  const [signature, setSignature] = React.useState("");
  const [unplaced, setUnplaced] = React.useState(0);
  const [unweighable, setUnweighable] = React.useState(0);
  const [hasNesting, setHasNesting] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [groups, setGroups] = React.useState<SourceGroup[]>([]);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [applyOpen, setApplyOpen] = React.useState(false);
  const [overrides, setOverrides] = React.useState<Record<string, Partial<ScrapRowEdit>>>({});
  const [runChanged, setRunChanged] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const loaded = React.useRef(false);

  // 1) Read the project's 2D nesting (the same saved nest the 2D Nesting tab shows) and turn it into sources.
  React.useEffect(() => {
    let cancelled = false;
    loaded.current = false;
    if (!projectId) return;
    (async () => {
      setSignature(""); setHasNesting(false); setGroups([]); setRunChanged(false); setUnplaced(0); setUnweighable(0);
      setLoading(true);
      try {
        const res = await fetch(`/api/nesting/workspace?kind=2D&projectId=${projectId}`).catch(() => null);
        if (!res?.ok || cancelled) return;
        const snap = decodeSnapshot((await res.json())?.data);
        if (!snap || snap.groups.length === 0 || cancelled) return;
        setHasNesting(true);
        if (!snap.result || snap.result.sheets.length === 0 || !snap.resS) return;

        const { sources, unweighable: skipped } = sourcesFromMaterialLines(buildMaterialRequests(snap.result, snap.resS));
        const sig = sources.map((g) => `${g.key}:${g.buyQty}:${g.buyWeightKg}:${g.usedWeightKg}`).join("|");
        const saved = loadScrapState(projectId);
        if (saved) {
          const keep = new Set(sources.map((g) => g.key));
          setOverrides(Object.fromEntries(Object.entries(saved.overrides).filter(([k]) => keep.has(k))));
          setRunChanged(!!saved.nestSignature && saved.nestSignature !== sig);
        } else {
          setOverrides({});
        }
        setUnplaced(snap.result.un.length);
        setUnweighable(skipped);
        setGroups(sources);
        setSignature(sig);
        loaded.current = true;
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  // 2) Remember the inputs per project.
  React.useEffect(() => {
    if (projectId && signature && loaded.current) saveScrapState(projectId, { nestSignature: signature, overrides });
  }, [projectId, signature, overrides]);

  // 3) Apply defaults + per-row edits, then calculate. Instant — no server round-trip.
  const inputs: ScrapRowInput[] = React.useMemo(() => groups.map((g) => {
    const o = overrides[g.key] ?? {};
    const defaults = DEFAULT_SCRAP_DEFAULTS; // starting values until you type or apply your own
    const costPerKg = o.costPerKg ?? defaults.costPerKg;
    return {
      ...g,
      costPerKg,
      usedLaterPct: o.usedLaterPct ?? defaults.usedLaterPct,
      usedLaterPriceLEPerKg: o.usedLaterPriceLEPerKg ?? costPerKg, // kept remnants are valued at cost unless told otherwise
      scrapSellPriceLEPerKg: o.scrapSellPriceLEPerKg ?? defaults.scrapSellPriceLEPerKg,
    };
  }), [groups, overrides]);
  const rows = React.useMemo(() => inputs.map(calculateScrapRow), [inputs]);
  const totals = React.useMemo(() => calculateScrapTotals(rows), [rows]);
  const scenarios = React.useMemo(() => calculateScrapScenarios(inputs, SCENARIOS), [inputs]);

  const setRow = (key: string, patch: Partial<ScrapRowEdit>) => setOverrides((s) => ({ ...s, [key]: { ...s[key], ...patch } }));
  const targets = selected.size > 0 ? [...selected].filter((k) => groups.some((g) => g.key === k)) : groups.map((g) => g.key);
  const applyToTargets = (patch: Partial<ScrapRowEdit>) =>
    setOverrides((s) => ({ ...s, ...Object.fromEntries(targets.map((k) => [k, { ...s[k], ...patch }])) }));
  const toggleRow = (key: string) => setSelected((s) => { const n = new Set(s); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const allSelected = groups.length > 0 && groups.every((g) => selected.has(g.key));
  const resetRow = (key: string) => setOverrides((s) => { const n = { ...s }; delete n[key]; return n; });

  async function handleExport() {
    if (!signature || !projectId) return;
    setExporting(true);
    const body = {
      projectId,
      rows: inputs.map((i) => ({
        key: i.key, label: i.label, material: i.material, thicknessMm: i.thicknessMm, widthMm: i.widthMm, lengthMm: i.lengthMm,
        usedAreaSqm: i.usedAreaSqm, usedWeightKg: i.usedWeightKg, buyQty: i.buyQty, buyAreaSqm: i.buyAreaSqm, buyWeightKg: i.buyWeightKg,
        costPerKg: i.costPerKg, usedLaterPct: i.usedLaterPct,
        usedLaterPriceLEPerKg: i.usedLaterPriceLEPerKg, scrapSellPriceLEPerKg: i.scrapSellPriceLEPerKg,
      })),
    };
    const res = await fetch("/api/scrap-management/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setExporting(false);
    if (!res.ok) { toast.error("Failed to export"); return; }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = `SteelFlow_Scrap_Management_${project?.number ?? "project"}.xlsx`; a.click();
    URL.revokeObjectURL(url);
    toast.success("Exported");
  }

  if (!projectId) return <EmptyState icon={<Boxes className="h-5 w-5" />} title="No project selected" description="Pick the active project in the sidebar to manage its scrap." />;
  if (loading) return <div className="rounded-xl border border-dashed border-border py-16 text-center text-sm text-muted-foreground">Loading…</div>;
  if (!hasNesting) return <EmptyState icon={<Boxes className="h-5 w-5" />} title="No nesting yet" description="Add parts in 2D Nesting for this project first — Scrap Management reads its saved result." />;
  if (!signature) return <EmptyState icon={<Boxes className="h-5 w-5" />} title="Nesting not run yet" description="Run the 2D Nesting first, then come back — this page always reflects the project's current nest." />;
  if (groups.length === 0) return <EmptyState icon={<Boxes className="h-5 w-5" />} title="Nothing to show" description="None of the nested sheets has a thickness, so their weight can't be worked out. Set a thickness on the parts in 2D Nesting." />;

  return (
    <div className="space-y-6">
      {runChanged && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>The 2D nest changed since you last used this page. Bought and used weights below are from the new result — re-check your percentages.</span>
          <Button size="sm" variant="ghost" className="ml-auto h-7" onClick={() => setRunChanged(false)}>Dismiss</Button>
        </div>
      )}

      {unplaced > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>{unplaced} part(s) were not placed in the nest, so the used weight is incomplete until they fit.</span>
        </div>
      )}
      {unweighable > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>{unweighable} sheet size(s) have no thickness set and are left out. Set the thickness in 2D Nesting to include them.</span>
        </div>
      )}

      {/* KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <KpiCard label="Buy cost" value={`${fmt(totals.buyCostLE, 0)} LE`} icon={Banknote} tone="slate" hint={`${fmt(totals.buyWeightKg, 0)} kg bought`} />
        <KpiCard label="Recovered from scrap" value={`${fmt(totals.recoveredLE, 0)} LE`} icon={Recycle} tone="accent" hint={`${fmt(totals.usedLaterKg, 0)} kg kept · ${fmt(totals.soldScrapKg, 0)} kg sold`} />
        <KpiCard label="Net scrap loss" value={`${fmt(totals.netScrapLossLE, 0)} LE`} icon={TrendingDown} tone="warning" hint={`${pct(totals.lossPctOfUsedCost)} of used cost`} />
        <KpiCard label="Financial scrap %" value={pct(totals.financialScrapPct)} icon={Percent} tone="primary" hint="net loss ÷ buy cost" />
        <KpiCard label="Physical scrap %" value={pct(totals.primaryScrapPct)} icon={Scale} tone="violet" hint={`${pct(totals.wastePct)} actually sold as scrap`} />
        <KpiCard label="Effective cost / kg" value={`${fmt(totals.effectiveCostPerKg)} LE`} icon={Banknote} tone="primary" hint={`vs ${fmt(totals.avgCostPerKg)} purchase price — use this in Pricing`} />
      </div>

      {/* Bulk entry */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Same numbers for many sources? Tick the rows you want (or none for all of them) and enter them once.
        </p>
        <Button onClick={() => setApplyOpen(true)}>
          {selected.size > 0 ? `Apply to ${targets.length} selected` : `Apply to all ${groups.length} sources`}
        </Button>
      </div>
      <ApplyToSourcesDialog open={applyOpen} onOpenChange={setApplyOpen} targetCount={targets.length} onApply={applyToTargets} />

      {/* Sources table */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[1290px] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th rowSpan={2} className="w-8 px-3 py-2">
                <input type="checkbox" aria-label="Select all sources" checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(groups.map((g) => g.key)))} />
              </th>
              <th rowSpan={2} className="px-3 py-2 text-left font-medium">Source</th>
              <th colSpan={3} className="border-l border-border px-3 py-1 text-center font-medium">From nesting</th>
              <th colSpan={4} className="border-l border-border px-3 py-1 text-center font-medium text-sky-700 dark:text-sky-300">Your inputs</th>
              <th colSpan={4} className="border-l border-border px-3 py-1 text-center font-medium">Scrap</th>
              <th colSpan={3} className="border-l border-border px-3 py-1 text-center font-medium">Money (LE)</th>
              <th rowSpan={2} className="border-l border-border px-3 py-2 text-right font-medium">Effective /kg</th>
              <th rowSpan={2} className="w-8" />
            </tr>
            <tr>
              {["Buy qty", "Buy kg", "Used kg"].map((h, i) => <th key={h} className={`px-3 py-1 text-right font-medium ${i === 0 ? "border-l border-border" : ""}`}>{h}</th>)}
              {["Cost/kg", "% Used later", "Later price", "Scrap price"].map((h, i) => <th key={h} className={`px-3 py-1 text-right font-medium ${i === 0 ? "border-l border-border" : ""}`}>{h}</th>)}
              {["Primary kg", "Primary %", "Kept kg", "Sold kg"].map((h, i) => <th key={h} className={`px-3 py-1 text-right font-medium ${i === 0 ? "border-l border-border" : ""}`}>{h}</th>)}
              {["Recovered", "Net loss", "Fin. scrap %"].map((h, i) => <th key={h} className={`px-3 py-1 text-right font-medium ${i === 0 ? "border-l border-border" : ""}`}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const edited = !!overrides[r.key] && Object.keys(overrides[r.key]).length > 0;
              return (
                <tr key={r.key} className="border-t border-border align-middle">
                  <td className="px-3 py-2">
                    <input type="checkbox" aria-label={`Select ${r.label}`} checked={selected.has(r.key)} onChange={() => toggleRow(r.key)} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.material} {r.thicknessMm} mm</div>
                    <div className="text-xs text-muted-foreground">{r.widthMm} × {r.lengthMm} mm</div>
                    {r.shortage && (
                      <div className="mt-1 inline-flex items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
                        <AlertTriangle className="h-3 w-3" /> Short by {fmt(r.shortageKg, 0)} kg — buy qty too low
                      </div>
                    )}
                  </td>
                  <td className="border-l border-border px-3 py-2 text-right tabular-nums">{fmt(r.buyQty, 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(r.buyWeightKg)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(r.usedWeightKg)}</td>
                  <td className="border-l border-border px-2 py-1.5"><NumCell value={r.costPerKg} onChange={(n) => setRow(r.key, { costPerKg: n })} /></td>
                  <td className="px-2 py-1.5"><NumCell max={100} value={r.usedLaterPct * 100} onChange={(n) => setRow(r.key, { usedLaterPct: n / 100 })} /></td>
                  <td className="px-2 py-1.5"><NumCell value={r.usedLaterPriceLEPerKg} onChange={(n) => setRow(r.key, { usedLaterPriceLEPerKg: n })} /></td>
                  <td className="px-2 py-1.5"><NumCell value={r.scrapSellPriceLEPerKg} onChange={(n) => setRow(r.key, { scrapSellPriceLEPerKg: n })} /></td>
                  <td className="border-l border-border px-3 py-2 text-right tabular-nums">{fmt(r.primaryScrapKg)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(r.primaryScrapPct)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(r.usedLaterKg)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(r.soldScrapKg)}</td>
                  <td className="border-l border-border px-3 py-2 text-right tabular-nums">{fmt(r.recoveredLE, 0)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt(r.netScrapLossLE, 0)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">{pct(r.financialScrapPct)}</td>
                  <td className="border-l border-border px-3 py-2 text-right font-semibold tabular-nums">{fmt(r.effectiveCostPerKg)}</td>
                  <td className="px-1">
                    {edited && (
                      <Button size="icon" variant="ghost" className="h-7 w-7" title="Reset this source to the starting values" onClick={() => resetRow(r.key)}>
                        <RotateCcw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-border bg-muted/40 font-semibold">
            <tr>
              <td />
              <td className="px-3 py-2">Total</td>
              <td className="border-l border-border px-3 py-2 text-right tabular-nums" />
              <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.buyWeightKg)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.usedWeightKg)}</td>
              <td className="border-l border-border px-3 py-2 text-right tabular-nums">{fmt(totals.avgCostPerKg)}</td>
              <td colSpan={3} />
              <td className="border-l border-border px-3 py-2 text-right tabular-nums">{fmt(totals.primaryScrapKg)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{pct(totals.primaryScrapPct)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.usedLaterKg)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.soldScrapKg)}</td>
              <td className="border-l border-border px-3 py-2 text-right tabular-nums">{fmt(totals.recoveredLE, 0)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt(totals.netScrapLossLE, 0)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{pct(totals.financialScrapPct)}</td>
              <td className="border-l border-border px-3 py-2 text-right tabular-nums">{fmt(totals.effectiveCostPerKg)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Scenarios */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">What if we keep more of the scrap?</p>
            <p className="text-xs text-muted-foreground">Same prices as above, with every source keeping the same share of its primary scrap.</p>
          </div>
          {canExport && (
            <Button variant="outline" onClick={handleExport} disabled={exporting}>
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Export to Excel
            </Button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-1 text-left font-medium">% Used later</th>
                <th className="py-1 text-right font-medium">Sold scrap (kg)</th>
                <th className="py-1 text-right font-medium">Net loss (LE)</th>
                <th className="py-1 text-right font-medium">Financial scrap %</th>
                <th className="py-1 text-right font-medium">Effective cost/kg</th>
              </tr>
            </thead>
            <tbody>
              {scenarios.map((s) => (
                <tr key={s.usedLaterPct} className="border-t border-border">
                  <td className="py-1.5">{pct(s.usedLaterPct, 0)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmt(s.totals.soldScrapKg, 0)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmt(s.totals.netScrapLossLE, 0)}</td>
                  <td className="py-1.5 text-right tabular-nums">{pct(s.totals.financialScrapPct)}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmt(s.totals.effectiveCostPerKg)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
