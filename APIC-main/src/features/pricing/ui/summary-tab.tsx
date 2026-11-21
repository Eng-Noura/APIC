"use client";
import * as React from "react";
import { AlertTriangle, Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { N } from "../engine";
import { fromInput, RATE_META, toInput } from "../rate-meta";
import { call } from "./api";
import { ProfilePicker } from "./profile-picker";
import { money, pct, rate4 } from "./format";
import type { ItemDto } from "./types";

const ROWS: { id: string; label: string; strong?: boolean; pct?: boolean }[] = [
  { id: N.MATERIAL_COST, label: "Material" }, { id: N.FAB_DIRECT, label: "Fabrication" }, { id: N.SUB_DIRECT, label: "Subcontractor" },
  { id: N.INSTALL_DIRECT, label: "Installation" }, { id: N.ADDON_DIRECT, label: "Add-ons" },
  { id: N.DIRECT_COST, label: "Direct cost", strong: true }, { id: N.INDIRECT_COST, label: "Indirect cost", strong: true },
  { id: N.SUPPLY_AND_INSTALL, label: "Supply & install sale" },
  { id: N.ENGINEERING, label: "Engineering" }, { id: N.THIRD_PARTY, label: "Third-party certificate" }, { id: N.COMMISSIONING, label: "Commissioning" }, { id: N.MOB_DEMOB, label: "Mob / Demob" },
  { id: N.INSURANCE_TOTAL, label: "Social insurance" }, { id: N.TAX, label: "Tax" },
  { id: N.TOTAL_COST, label: "Total cost", strong: true }, { id: N.PROFIT, label: "Profit" }, { id: N.PROFIT_PCT, label: "Profit %", pct: true },
  { id: N.SALE_PRICE, label: "Final sale price", strong: true }, { id: N.UNIT_RATE, label: "Final unit rate", strong: true },
];

export function SummaryTab({ item, projectId, canEdit, locked, onChanged }: { item: ItemDto; projectId: string; canEdit: boolean; locked: boolean; onChanged: () => void }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const t = item.calc.trace;
  const v = (id: string) => t[id]?.value ?? null;
  const sel = open ? t[open] : null;

  return (
    <div className="space-y-5">
      {item.calc.issues.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-border bg-muted/30 p-3 text-xs">
          {item.calc.issues.slice(0, 12).map((i, k) => (
            <li key={k} className={i.severity === "error" ? "flex gap-2 text-destructive" : "flex gap-2 text-warning"}>
              {i.severity === "error" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />}<span>{i.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-left">Component</th><th className="px-3 py-2 text-right">EGP</th></tr></thead>
            <tbody>
              {ROWS.map((r) => {
                const val = v(r.id);
                if (val == null && !t[r.id]) return null;
                const dim = t[r.id]?.status === "DISABLED";
                return (
                  <tr key={r.id} className={`border-t border-border ${r.strong ? "bg-muted/30 font-semibold" : ""} ${dim ? "text-muted-foreground" : ""}`}>
                    <td className="px-3 py-1.5">{r.label}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      <button type="button" className="rounded px-1 underline decoration-dotted underline-offset-2 hover:bg-primary/10" onClick={() => setOpen(open === r.id ? null : r.id)} aria-label={`Show how ${r.label} is calculated`}>
                        {r.pct ? pct(val) : r.id === N.UNIT_RATE ? rate4(val) : money(val)}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg border border-border bg-card p-3 text-xs" aria-live="polite">
          {sel ? (
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-2"><p className="text-sm font-semibold">{sel.label}</p><button aria-label="Close" onClick={() => setOpen(null)}><X className="h-4 w-4" /></button></div>
              <p><span className="text-muted-foreground">Status:</span> {sel.status}</p>
              <p><span className="text-muted-foreground">Formula:</span> {sel.formula || sel.method}</p>
              {sel.expression && <p className="break-words font-mono"><span className="font-sans text-muted-foreground">Numbers:</span> {sel.expression}</p>}
              {sel.rate && <p><span className="text-muted-foreground">Rate:</span> {sel.rate.value} <span className="rounded bg-muted px-1">{sel.rate.layer.toLowerCase()}</span>{sel.rate.key ? ` · ${sel.rate.key}` : ""}</p>}
              {sel.source && <p><span className="text-muted-foreground">Source:</span> {sel.source}</p>}
              {sel.inputs.length > 0 && <div><p className="text-muted-foreground">Inputs:</p><ul className="ml-3 list-disc">{sel.inputs.map((i) => <li key={i.id}>{t[i.id]?.label ?? i.id}: {money(i.value)}</li>)}</ul></div>}
            </div>
          ) : <p className="text-muted-foreground">Click any amount to see the formula, the numbers and the rate (and which level it came from) behind it.</p>}
        </div>
      </div>

      <ProfilePicker item={item} projectId={projectId} canEdit={canEdit && !locked} onChanged={onChanged} />
      <RatesEditor item={item} canEdit={canEdit && !locked} onChanged={onChanged} />
    </div>
  );
}

/** Chain-level rates for this item. Setting a value here is an item override: it always wins over profile / project / global. */
function RatesEditor({ item, canEdit, onChanged }: { item: ItemDto; canEdit: boolean; onChanged: () => void }) {
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const ov = new Map(item.overrides.map((o) => [o.rateKey, o.value]));
  const resolved = new Map(Object.values(item.calc.trace).filter((x) => x.rate?.key).map((x) => [x.rate!.key!, x.rate!]));
  const groups = [...new Set(RATE_META.map((r) => r.group))];

  async function save(key: string, kind: (typeof RATE_META)[number]["kind"]) {
    const raw = draft[key];
    if (raw === undefined || raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return;
    if (await call(`/api/pricing/items/${item.id}/overrides`, "PUT", { rateKey: key, value: fromInput(kind, n) })) { setDraft((d) => { const c = { ...d }; delete c[key]; return c; }); onChanged(); }
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Rates for this item</h4>
      <p className="text-xs text-muted-foreground">Values come from the Rate Library (global, project, profile). A value typed here is an item override and always wins. A required rate that is missing stops the calculation — it is never treated as 0.</p>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[520px] text-sm">
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g}>
                <tr className="bg-muted/50 text-xs font-semibold text-muted-foreground"><td colSpan={4} className="px-3 py-1.5">{g}</td></tr>
                {RATE_META.filter((r) => r.group === g).map((r) => {
                  const cur = resolved.get(r.key);
                  const o = ov.get(r.key);
                  return (
                    <tr key={r.key} className="border-t border-border">
                      <td className="px-3 py-1.5">{r.label}</td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">{cur ? <>{toInput(r.kind, cur.value)}{r.kind === "pct" ? "%" : ""} · {cur.layer.toLowerCase()}</> : "not set"}</td>
                      <td className="px-2 py-1"><Input aria-label={`Override ${r.label}`} type="number" min={0} step="any" disabled={!canEdit} value={draft[r.key] ?? (o !== undefined ? String(toInput(r.kind, o)) : "")} placeholder={r.kind === "pct" ? "override %" : "override"} onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })} onBlur={() => save(r.key, r.kind)} onKeyDown={(e) => e.key === "Enter" && save(r.key, r.kind)} className="h-8 w-28 text-right" /></td>
                      <td className="w-16 px-2 text-right">{o !== undefined && canEdit && <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={async () => { if (await call(`/api/pricing/items/${item.id}/overrides`, "PUT", { rateKey: r.key, value: null })) { setDraft((d) => { const c = { ...d }; delete c[r.key]; return c; }); onChanged(); } }}>Clear</Button>}</td>
                    </tr>
                  );
                })}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
