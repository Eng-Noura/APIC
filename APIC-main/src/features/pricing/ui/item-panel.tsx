"use client";
import * as React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LinesTab } from "./lines-tab";
import { MaterialsTab } from "./materials-tab";
import { SummaryTab } from "./summary-tab";
import { money, pct, qty as fmtQty, rate4 } from "./format";
import type { ItemDto } from "./types";

const TABS = [
  { v: "materials", label: "Materials" }, { v: "FABRICATION", label: "Fabrication" }, { v: "SUBCONTRACTOR", label: "Subcontractor" },
  { v: "INSTALLATION", label: "Installation" }, { v: "ADD_ON", label: "Add-ons" }, { v: "summary", label: "Summary" },
] as const;

/** The expanded row: tabs on the left, the Item Pricing Summary stays visible on the right while switching tabs. */
export function ItemPanel({ item, projectId, canEdit, locked, onChanged }: { item: ItemDto; projectId: string; canEdit: boolean; locked: boolean; onChanged: () => void }) {
  const s = item.calc.summary;
  const rows: [string, number | undefined][] = [
    ["Material", s?.materialCost], ["Fabrication", s?.fabricationDirect], ["Subcontractor", s?.subcontractorDirect], ["Installation", s?.installationDirect], ["Add-ons", s?.addOnsDirect],
    ["Direct cost", s?.directCost], ["Indirect cost", s?.indirectCost], ["Total cost", s?.totalCost],
  ];
  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[1fr_280px]">
      <Tabs defaultValue="materials" className="min-w-0">
        <TabsList className="h-auto max-w-full flex-wrap justify-start">{TABS.map((t) => <TabsTrigger key={t.v} value={t.v}>{t.label}</TabsTrigger>)}</TabsList>
        <TabsContent value="materials"><MaterialsTab item={item} canEdit={canEdit} locked={locked} onChanged={onChanged} /></TabsContent>
        {(["FABRICATION", "SUBCONTRACTOR", "INSTALLATION", "ADD_ON"] as const).map((c) => (
          <TabsContent key={c} value={c}><LinesTab item={item} category={c} canEdit={canEdit} locked={locked} onChanged={onChanged} /></TabsContent>
        ))}
        <TabsContent value="summary"><SummaryTab item={item} projectId={projectId} canEdit={canEdit} locked={locked} onChanged={onChanged} /></TabsContent>
      </Tabs>

      <aside className="h-fit rounded-xl border border-border bg-card p-4 text-sm" aria-label="Item pricing summary">
        <h4 className="mb-3 text-sm font-semibold">Item Pricing Summary</h4>
        {s ? (
          <dl className="space-y-1.5">
            {rows.map(([k, val]) => <div key={k} className="flex justify-between gap-2"><dt className="text-muted-foreground">{k}</dt><dd className="tabular-nums">{money(val)}</dd></div>)}
            <div className="flex justify-between gap-2 border-t border-border pt-2 font-semibold"><dt>Sale price</dt><dd className="tabular-nums">{money(s.salePrice)}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Profit</dt><dd className="tabular-nums">{money(s.profit)}</dd></div>
            <div className="flex justify-between gap-2"><dt className="text-muted-foreground">Profit %</dt><dd className="tabular-nums">{pct(s.profitPct)}</dd></div>
            <div className="flex justify-between gap-2 rounded-lg bg-primary/10 px-2 py-1.5 font-semibold text-primary"><dt>Unit rate / {item.unit}</dt><dd className="tabular-nums">{rate4(s.unitRate)}</dd></div>
            <p className="pt-1 text-[11px] text-muted-foreground">{fmtQty(item.qty)} {item.unit} · profile {item.effectiveProfile}</p>
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">Not priced yet. {item.calc.issues.find((i) => i.severity === "error")?.message ?? "Add lines and make sure the rates are set (Summary tab)."}</p>
        )}
      </aside>
    </div>
  );
}
