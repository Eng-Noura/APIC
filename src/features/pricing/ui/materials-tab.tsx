"use client";
import * as React from "react";
import { Lock, Plus, Trash2, Pencil, Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { call } from "./api";
import { money, qty as fmtQty, SOURCE_LABEL } from "./format";
import type { ItemDto, MaterialDto } from "./types";

const SOURCE_TONE: Record<string, "default" | "success" | "warning" | "gray"> = { NESTING: "default", STOCK: "success", PROCUREMENT: "warning", MANUAL: "gray" };
const UNITS = ["KG", "TON", "EA", "SQM", "M"];
const blank = { name: "", grade: "", qty: "", unit: "KG", unitCost: "" };

export function MaterialsTab({ item, canEdit, locked, onChanged }: { item: ItemDto; canEdit: boolean; locked: boolean; onChanged: () => void }) {
  const [adding, setAdding] = React.useState(false);
  const [editId, setEditId] = React.useState<string | null>(null);
  const [f, setF] = React.useState(blank);
  const editable = canEdit && !locked;

  const body = () => ({ name: f.name, grade: f.grade || undefined, qty: Number(f.qty), unit: f.unit, unitCost: Number(f.unitCost) });
  const valid = f.name.trim() && f.qty !== "" && f.unitCost !== "" && Number(f.qty) >= 0 && Number(f.unitCost) >= 0;

  async function save() {
    const ok = editId ? await call(`/api/pricing/lines/material/${editId}`, "PATCH", body()) : await call(`/api/pricing/items/${item.id}/lines`, "POST", { kind: "material", ...body() });
    if (ok) { setAdding(false); setEditId(null); setF(blank); onChanged(); }
  }
  async function remove(m: MaterialDto) {
    if (await call(`/api/pricing/lines/material/${m.id}`, "DELETE")) onChanged();
  }
  const startEdit = (m: MaterialDto) => { setEditId(m.id); setAdding(true); setF({ name: m.name, grade: m.grade ?? "", qty: String(m.qty), unit: m.unit, unitCost: String(m.unitCost) }); };
  const total = item.materials.reduce((a, m) => a + m.qty * m.unitCost, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Imported lines (Nesting / Stock / Procurement) are read-only; only manual lines can be edited or removed.
        </p>
        {editable && !adding && <Button size="sm" onClick={() => { setF(blank); setEditId(null); setAdding(true); }}><Plus /> Add material</Button>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr><th className="px-3 py-2 text-left">Source</th><th className="px-3 py-2 text-left">Material</th><th className="px-3 py-2 text-left">Grade</th><th className="px-3 py-2 text-right">Qty</th><th className="px-3 py-2 text-left">Unit</th><th className="px-3 py-2 text-right">Unit cost</th><th className="px-3 py-2 text-right">Amount</th><th className="w-20" /></tr>
          </thead>
          <tbody>
            {item.materials.map((m) => {
              const imported = m.source !== "MANUAL";
              return (
                <tr key={m.id} className={cn("border-t border-border", imported && "bg-muted/30 italic text-muted-foreground")}>
                  <td className="px-3 py-2"><Badge variant={SOURCE_TONE[m.source]}>{imported && <Lock className="h-3 w-3" />}{SOURCE_LABEL[m.source]}</Badge></td>
                  <td className="px-3 py-2">{m.name}</td><td className="px-3 py-2">{m.grade ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtQty(m.qty)}</td><td className="px-3 py-2">{m.unit}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(m.unitCost)}</td><td className="px-3 py-2 text-right tabular-nums">{money(m.qty * m.unitCost)}</td>
                  <td className="px-2 py-1 text-right">
                    {editable && !imported && (
                      <>
                        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit material" onClick={() => startEdit(m)}><Pencil /></Button>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label="Remove material" onClick={() => remove(m)}><Trash2 /></Button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {adding && (
              <tr className="border-t border-border bg-primary/5">
                <td className="px-3 py-2"><Badge variant="gray">Manual</Badge></td>
                <td className="px-2 py-1"><Input aria-label="Material name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Plate 20 mm" /></td>
                <td className="px-2 py-1"><Input aria-label="Grade" value={f.grade} onChange={(e) => setF({ ...f, grade: e.target.value })} placeholder="S355" className="w-24" /></td>
                <td className="px-2 py-1"><Input aria-label="Quantity" type="number" min={0} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} className="w-24 text-right" /></td>
                <td className="px-2 py-1"><select aria-label="Unit" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} className="h-9 rounded-lg border border-input bg-card px-2 text-sm">{UNITS.map((u) => <option key={u}>{u}</option>)}</select></td>
                <td className="px-2 py-1"><Input aria-label="Unit cost" type="number" min={0} value={f.unitCost} onChange={(e) => setF({ ...f, unitCost: e.target.value })} className="w-28 text-right" /></td>
                <td className="px-3 py-2 text-right tabular-nums">{valid ? money(Number(f.qty) * Number(f.unitCost)) : "—"}</td>
                <td className="px-2 py-1 text-right">
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-success" aria-label="Save material" disabled={!valid} onClick={save}><Check /></Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Cancel" onClick={() => { setAdding(false); setEditId(null); }}><X /></Button>
                </td>
              </tr>
            )}
            {!item.materials.length && !adding && (
              <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-muted-foreground">No material lines yet.{editable ? " Use “Add material”." : ""}</td></tr>
            )}
          </tbody>
          {item.materials.length > 0 && (
            <tfoot><tr className="border-t border-border bg-muted/30 font-medium"><td colSpan={6} className="px-3 py-2 text-right">Material cost</td><td className="px-3 py-2 text-right tabular-nums">{money(total)}</td><td /></tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
