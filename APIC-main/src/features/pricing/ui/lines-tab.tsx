"use client";
import * as React from "react";
import { Plus, Trash2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { PERCENT_BASES } from "../sheet-calc";
import { call } from "./api";
import { CATEGORY_LABEL, METHOD_LABEL, money } from "./format";
import type { ItemDto } from "./types";

const METHODS = Object.keys(METHOD_LABEL);
const UNIT_FOR: Record<string, string> = { PER_TON: "TON", PER_KG: "KG", PER_SQM: "SQM", PER_METER: "M", PER_UNIT: "EA" };
const HINTS: Record<string, string> = {
  FABRICATION: "Cutting, rolling, fit-up & welding, NDT, painting … Indirect % and the markup come from the rates (Summary tab).",
  SUBCONTRACTOR: "Work priced by subcontractors. Indirect % and markup come from the rates (Summary tab).",
  INSTALLATION: "Per-ton site lines (crane, scaffolding, man-hour …). Height factor, indirect % and markup come from the rates.",
  ADD_ON: "Transportation, accommodation, bus, container … Each line can be fixed, a percentage, per ton or per unit — never assumed to be a percentage.",
};

export function LinesTab({ item, category, canEdit, locked, onChanged }: { item: ItemDto; category: keyof typeof CATEGORY_LABEL; canEdit: boolean; locked: boolean; onChanged: () => void }) {
  const lines = item.components.filter((c) => c.category === category);
  const [adding, setAdding] = React.useState(false);
  const [f, setF] = React.useState({ name: "", method: "PER_TON", rate: "", fixed: "", base: "MATERIAL_COST" });
  const editable = canEdit && !locked;
  const bases = PERCENT_BASES.filter((b) => b.category !== category); // a line can never be a % of its own category
  const isPct = f.method === "PERCENT_OF_BASE";
  const unit = UNIT_FOR[f.method] ?? (f.method === "FIXED_PLUS_VARIABLE" ? "TON" : undefined);
  const valid = f.name.trim() && f.rate !== "" && Number(f.rate) >= 0 && (f.method !== "FIXED_PLUS_VARIABLE" || (f.fixed !== "" && Number(f.fixed) >= 0));

  async function add() {
    const body = { kind: "component", category, name: f.name, method: f.method, rate: isPct ? Number(f.rate) / 100 : Number(f.rate), fixed: f.method === "FIXED_PLUS_VARIABLE" ? Number(f.fixed) : undefined, unit, base: isPct ? f.base : undefined };
    if (await call(`/api/pricing/items/${item.id}/lines`, "POST", body)) { setAdding(false); setF({ name: "", method: "PER_TON", rate: "", fixed: "", base: "MATERIAL_COST" }); onChanged(); }
  }
  const amountOf = (id: string) => item.calc.trace[`line:${id}`];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{HINTS[category]}</p>
        {editable && !adding && <Button size="sm" onClick={() => setAdding(true)}><Plus /> Add line</Button>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[620px] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground"><tr><th className="px-3 py-2 text-left">Line</th><th className="px-3 py-2 text-left">Method</th><th className="px-3 py-2 text-right">Rate</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-center">On</th><th className="w-12" /></tr></thead>
          <tbody>
            {lines.map((c) => {
              const t = amountOf(c.id);
              const pctLine = c.method === "PERCENT_OF_BASE";
              return (
                <tr key={c.id} className="border-t border-border">
                  <td className="px-3 py-2">{c.name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{METHOD_LABEL[c.method]}{pctLine && c.base ? ` of ${PERCENT_BASES.find((b) => b.id === c.base)?.label.toLowerCase()}` : ""}{c.method === "FIXED_PLUS_VARIABLE" ? ` (${money(c.fixed)} + per ${c.unit ?? "TON"})` : ""}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pctLine ? `${(c.rate * 100).toFixed(2)}%` : money(c.rate)}</td>
                  <td className="px-3 py-2 text-right tabular-nums" title={t?.expression}>{t?.value != null ? money(t.value) : <span className="text-destructive">error</span>}</td>
                  <td className="px-3 py-2 text-center"><Switch aria-label={`Enable ${c.name}`} checked={c.enabled} disabled={!editable} onCheckedChange={async (v) => { if (await call(`/api/pricing/lines/component/${c.id}`, "PATCH", { enabled: v })) onChanged(); }} /></td>
                  <td className="px-2 py-1 text-right">{editable && <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label={`Remove ${c.name}`} onClick={async () => { if (await call(`/api/pricing/lines/component/${c.id}`, "DELETE")) onChanged(); }}><Trash2 /></Button>}</td>
                </tr>
              );
            })}
            {adding && (
              <tr className="border-t border-border bg-primary/5">
                <td className="px-2 py-1"><Input aria-label="Line name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Crane" /></td>
                <td className="px-2 py-1">
                  <select aria-label="Method" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} className="h-9 w-full rounded-lg border border-input bg-card px-2 text-sm">{METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select>
                  {isPct && <select aria-label="Percentage of" value={f.base} onChange={(e) => setF({ ...f, base: e.target.value })} className="mt-1 h-9 w-full rounded-lg border border-input bg-card px-2 text-sm">{bases.map((b) => <option key={b.id} value={b.id}>of {b.label.toLowerCase()}</option>)}</select>}
                  {f.method === "FIXED_PLUS_VARIABLE" && <Input aria-label="Fixed part" type="number" min={0} value={f.fixed} onChange={(e) => setF({ ...f, fixed: e.target.value })} placeholder="Fixed part (EGP)" className="mt-1" />}
                </td>
                <td className="px-2 py-1"><Input aria-label={isPct ? "Percentage" : "Rate"} type="number" min={0} value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} placeholder={isPct ? "%" : unit ? `EGP / ${unit}` : "EGP"} className="w-28 text-right" /></td>
                <td /><td />
                <td className="px-2 py-1 text-right whitespace-nowrap">
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-success" aria-label="Save line" disabled={!valid} onClick={add}><Check /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Cancel" onClick={() => setAdding(false)}><X /></Button>
                </td>
              </tr>
            )}
            {!lines.length && !adding && <tr><td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">No {CATEGORY_LABEL[category].toLowerCase()} lines.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
