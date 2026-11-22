"use client";
import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { COST_TYPE_LABEL, PROJECT_METHOD_LABEL, type EstimateResult } from "../calc";
import type { ItemRow } from "../sheet-view";
import { SourceBadge, egp, kg } from "./fields";

const Cell = ({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) => <td className={cn("px-3 py-2", right && "text-right tabular-nums", className)}>{children}</td>;
const H = ({ children, right }: { children?: React.ReactNode; right?: boolean }) => <th className={cn("px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground", right ? "text-right" : "text-left")}>{children}</th>;
const Sub = ({ title, children }: { title: string; children: React.ReactNode }) => <div><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>{children}</div>;

/** Items with their cost build-up; a row opens to the lines that make it up. Figures come from the server (itemTotals) and the result passed in. */
export function ItemsTable({ rows, result, cur }: { rows: ItemRow[]; result: EstimateResult | null; cur: string }) {
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const matAmount = (id: string) => result?.materials.lines.find((l) => l.id === id)?.totalCents;
  if (!rows.length) return <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">No items yet. Group parts as a Scope in Part List, or add an item in the Manufacturing tab.</div>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full min-w-[860px] text-sm">
        <thead className="border-b bg-secondary/50"><tr><H /><H>Item</H><H right>Weight (kg)</H><H right>Material</H><H right>Manufacturing</H><H right>Subcontract</H><H right>Project</H><H right>Cost</H><H right>Price share ({cur})</H></tr></thead>
        <tbody>
          {rows.map((r) => {
            const k = r.id ?? "shared"; const isOpen = open.has(k);
            const opResult = result?.manufacturing.items.find((x) => x.id === r.id);
            const selectedOps = r.operations.filter((o) => o.selected);
            return (
              <React.Fragment key={k}>
                <tr className="cursor-pointer border-b hover:bg-secondary/30" onClick={() => toggle(k)}>
                  <Cell className="w-8"><button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${r.name}`} onClick={(e) => { e.stopPropagation(); toggle(k); }}>{isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></Cell>
                  <Cell className="font-medium">{r.name}{!r.shared && !r.linked && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">manual</span>}</Cell>
                  <Cell right>{r.shared ? "—" : kg(r.weightKg)}</Cell>
                  <Cell right>{egp(r.materialCents)}</Cell><Cell right>{egp(r.manufacturingCents)}</Cell><Cell right>{egp(r.subcontractCents)}</Cell><Cell right>{egp(r.projectCents)}</Cell>
                  <Cell right className="font-semibold">{egp(r.costCents)}</Cell><Cell right className="font-semibold text-primary">{egp(r.finalCents)}</Cell>
                </tr>
                {isOpen && (
                  <tr className="border-b bg-secondary/20"><td colSpan={9} className="px-4 py-3">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <Sub title={`Materials (${r.materials.length})`}>
                        {r.materials.length === 0 ? <p className="text-xs text-muted-foreground">None</p> : (
                          <table className="w-full text-xs"><tbody>{r.materials.map((m) => (
                            <tr key={m.id} className="border-t first:border-0"><td className="py-1 pr-2">{m.name}{m.grade ? ` · ${m.grade}` : ""}{m.thicknessMm != null ? ` · ${m.thicknessMm} mm` : ""}</td>
                              <td className="py-1 pr-2"><SourceBadge source={m.priceSource ?? "MANUAL"} /></td>
                              <td className="py-1 pr-2 text-right tabular-nums">{kg(m.purchasedKg)} kg × {m.unitPrice}</td>
                              <td className="py-1 text-right font-medium tabular-nums">{matAmount(m.id) != null ? egp(matAmount(m.id)!) : "—"}</td></tr>))}</tbody></table>)}
                      </Sub>
                      <Sub title={`Operations (${selectedOps.length} selected of ${r.operations.length})`}>
                        {selectedOps.length === 0 ? <p className="text-xs text-muted-foreground">No operation selected</p> : (
                          <table className="w-full text-xs"><tbody>{selectedOps.map((o) => (
                            <tr key={o.id} className="border-t first:border-0"><td className="py-1 pr-2">{o.name}</td><td className="py-1 pr-2 text-muted-foreground">{COST_TYPE_LABEL[o.costType]}</td>
                              <td className="py-1 pr-2 text-right tabular-nums">{o.rate}</td>
                              <td className="py-1 text-right font-medium tabular-nums">{opResult?.operations.find((x) => x.id === o.id) ? egp(opResult.operations.find((x) => x.id === o.id)!.amountCents) : "—"}</td></tr>))}</tbody></table>)}
                      </Sub>
                      <Sub title={`Subcontractors (${r.subcontracts.length})`}>
                        {r.subcontracts.length === 0 ? <p className="text-xs text-muted-foreground">None</p> : (
                          <table className="w-full text-xs"><tbody>{r.subcontracts.map((s) => (
                            <tr key={s.id} className="border-t first:border-0"><td className="py-1 pr-2">{s.name}{s.company ? ` · ${s.company}` : ""}</td><td className="py-1 pr-2 text-right tabular-nums">{s.quantity} {s.unit} × {s.unitPrice}</td>
                              <td className="py-1 text-right font-medium tabular-nums">{result?.subcontract.lines.find((x) => x.id === s.id) ? egp(result.subcontract.lines.find((x) => x.id === s.id)!.totalCents) : "—"}</td></tr>))}</tbody></table>)}
                      </Sub>
                      <Sub title={`Project costs assigned here (${r.projectCosts.length})`}>
                        {r.projectCosts.length === 0 ? <p className="text-xs text-muted-foreground">None assigned. Shared project costs are spread over the items by the allocation basis.</p> : (
                          <table className="w-full text-xs"><tbody>{r.projectCosts.map((c) => (
                            <tr key={c.id} className={cn("border-t first:border-0", !c.enabled && "text-muted-foreground line-through")}><td className="py-1 pr-2">{c.name}</td><td className="py-1 pr-2 text-muted-foreground">{PROJECT_METHOD_LABEL[c.method]}</td>
                              <td className="py-1 text-right font-medium tabular-nums">{result?.project.lines.find((x) => x.id === c.id) ? egp(result.project.lines.find((x) => x.id === c.id)!.amountCents) : "—"}</td></tr>))}</tbody></table>)}
                      </Sub>
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
