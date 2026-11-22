"use client";
import * as React from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MaterialResult } from "../calc";
import { PRICE_SOURCE_LABEL, chooseMaterialSource, editMaterialPrice, followSources, issuesFor, materialEditState, scrapOf, sourceOptions, type IssueIndex } from "../sheet-view";
import type { EstItem, EstMaterial, EstSettings } from "../types";
import { toast } from "sonner";
import { NumInput, SourceBadge, egp, inputCls, kg, selectCls } from "./fields";
import { FieldIssues } from "./sheet-parts";

const Th = ({ children, right }: { children?: React.ReactNode; right?: boolean }) => <th className={cn("px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground", right && "text-right")}>{children}</th>;

/**
 * Material lines with their price source. Typing a price on an automatic line makes it "Manual"; picking Procurement or Scrap
 * takes that source's price (a source with no price is refused, never swapped in silently). A line you changed shows the
 * imported value and a Restore button — the server puts it back and records it in the audit.
 */
export function MaterialsTable({ materials, items, settings, lines, cur, dis, issues, onChange, onRestore, onDelete, restoring }: {
  materials: EstMaterial[]; items: EstItem[]; settings: EstSettings; lines: MaterialResult["lines"]; cur: string; dis: boolean; issues: IssueIndex;
  onChange: (next: EstMaterial) => void; onRestore: (id: string) => void; onDelete: (m: EstMaterial) => void; restoring: string | null;
}) {
  const scrap = scrapOf(settings);
  const shown = followSources(materials, scrap); // the price a line follows is what the user sees, as on the server
  const itemName = (id: string | null | undefined) => (id ? items.find((i) => i.id === id)?.name ?? "—" : "Project");
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[1040px] text-sm">
        <thead className="border-b bg-secondary/50"><tr><Th>Material</Th><Th>Grade</Th><Th>Thickness</Th><Th>Item</Th><Th>Origin</Th><Th right>Required (kg)</Th><Th right>Purchased (kg)</Th><Th>Price source</Th><Th right>Unit price ({cur}/kg)</Th><Th right>Total ({cur})</Th><Th /></tr></thead>
        <tbody>
          {materials.map((raw, i) => {
            const m = shown[i];
            const st = materialEditState(m, scrap);
            const opts = sourceOptions(m);
            const line = lines.find((l) => l.id === m.id);
            const msgs = issuesFor(issues, "material", m.id);
            const isNew = m.id.startsWith("new-");
            return (
              <tr key={m.id} className="border-b align-top last:border-0">
                <td className="px-3 py-2 font-medium">
                  {st.auto ? m.name : <><input className={cn(inputCls, !m.name.trim() && "border-destructive")} disabled={dis} value={m.name} aria-label="Material name" aria-invalid={!m.name.trim()} onChange={(e) => onChange({ ...raw, name: e.target.value })} />{!m.name.trim() && <span role="alert" className="block text-[11px] text-destructive">Material name is required</span>}</>}
                  {m.sourceMissing && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700" title="The source row no longer exists, but you had edited this line so it was kept">source removed</span>}
                  <FieldIssues issues={msgs} />
                </td>
                <td className="px-3 py-2">{st.auto ? m.grade ?? "—" : <input className={cn(inputCls, "w-24")} disabled={dis} aria-label="Grade" value={m.grade ?? ""} onChange={(e) => onChange({ ...raw, grade: e.target.value || null })} />}</td>
                <td className="px-3 py-2">{m.thicknessMm != null ? `${m.thicknessMm} mm` : "—"}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{itemName(m.itemId)}</td>
                <td className="px-3 py-2"><SourceBadge source={m.source} /></td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{st.auto ? kg(m.requiredKg) : <NumInput className="w-24" nullable disabled={dis} value={m.requiredKg} onChange={(v) => onChange({ ...raw, requiredKg: v })} />}</td>
                <td className="px-3 py-2 text-right">
                  <NumInput className="w-28" disabled={dis} value={m.purchasedKg} onChange={(v) => onChange({ ...raw, purchasedKg: v ?? 0 })} />
                  {st.qtyEdited && st.original && <div className="mt-0.5 text-[11px] text-amber-700">Edited · imported {kg(st.original.purchasedKg)} kg</div>}
                </td>
                <td className="px-3 py-2">
                  {st.auto ? (
                    <>
                      <select className={cn(selectCls, "w-36")} disabled={dis} aria-label={`Price source of ${m.name}`} value={m.priceSource ?? "MANUAL"}
                        onChange={(e) => { const r = chooseMaterialSource(m, e.target.value as never); if (!r.ok) { toast.error(r.reason); return; } onChange(r.material); }}>
                        {opts.map((o) => <option key={o.value} value={o.value} disabled={o.disabled && o.value !== (m.priceSource ?? "MANUAL")} title={o.why}>{o.label}{o.price != null ? ` · ${o.price}` : ""}{o.disabled && o.why ? " (n/a)" : ""}</option>)}
                      </select>
                      <div className="mt-1"><SourceBadge source={m.priceSource ?? "MANUAL"} /></div>
                    </>
                  ) : <SourceBadge source="MANUAL" />}
                </td>
                <td className="px-3 py-2 text-right">
                  <NumInput className="w-24" disabled={dis} value={m.unitPrice} onChange={(v) => onChange(editMaterialPrice(m, v ?? 0))} />
                  {st.priceEdited && st.original && <div className="mt-0.5 text-[11px] text-amber-700">{(m.priceSource ?? "MANUAL") === "MANUAL" ? "Edited by hand" : "Source changed"} · original {st.original.unitPrice} ({PRICE_SOURCE_LABEL[st.original.priceSource]})</div>}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{egp(line?.totalCents ?? 0)}</td>
                <td className="px-2 py-2 text-right">
                  {st.auto ? (
                    st.canRestore && !dis && !isNew
                      ? <Button variant="outline" size="sm" disabled={restoring === m.id} onClick={() => onRestore(m.id)} title="Put the imported quantity and the default price source back"><RotateCcw /> Restore</Button>
                      : <span className="text-xs text-muted-foreground" title="Automatic lines follow Part List / Nesting and cannot be deleted here">auto</span>
                  ) : <button type="button" aria-label="Delete material" disabled={dis} onClick={() => onDelete(m)} className="rounded p-1.5 text-destructive hover:bg-destructive/10 disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
