"use client";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ScrapRowEdit } from "./storage";

const FIELDS: { key: keyof ScrapRowEdit; label: string; percent?: boolean }[] = [
  { key: "costPerKg", label: "Cost / kg (LE)" },
  { key: "usedLaterPct", label: "% Used later", percent: true },
  { key: "usedLaterPriceLEPerKg", label: "Used later price (LE/kg)" },
  { key: "scrapSellPriceLEPerKg", label: "Scrap sell price (LE/kg)" },
];

/**
 * One popup to enter the numbers once and apply them to many sources. A field left empty keeps whatever each
 * source has now, so a single value (say % Used later) can be set without touching the prices.
 */
export function ApplyToSourcesDialog({ open, onOpenChange, targetCount, onApply }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  targetCount: number;
  onApply: (patch: Partial<ScrapRowEdit>) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* the form only exists while the dialog is open, so it starts empty every time */}
        <ApplyForm targetCount={targetCount} onCancel={() => onOpenChange(false)} onApply={(p) => { onApply(p); onOpenChange(false); }} />
      </DialogContent>
    </Dialog>
  );
}

function ApplyForm({ targetCount, onCancel, onApply }: { targetCount: number; onCancel: () => void; onApply: (patch: Partial<ScrapRowEdit>) => void }) {
  const [text, setText] = React.useState<Record<string, string>>({});

  const parsed: Partial<ScrapRowEdit> = {};
  let invalid = false;
  for (const f of FIELDS) {
    const raw = (text[f.key] ?? "").trim();
    if (raw === "") continue;
    const n = Number(raw);
    if (!isFinite(n) || n < 0 || (f.percent && n > 100)) { invalid = true; continue; }
    parsed[f.key] = f.percent ? n / 100 : n;
  }
  const nothing = Object.keys(parsed).length === 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Apply to {targetCount} source{targetCount === 1 ? "" : "s"}</DialogTitle>
        <DialogDescription>Fill only what you want to set. Empty fields keep each source&apos;s current value.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label>{f.label}</Label>
            <Input
              type="number" inputMode="decimal" min={0} max={f.percent ? 100 : undefined} step="any"
              placeholder="keep current" value={text[f.key] ?? ""}
              onChange={(e) => setText((t) => ({ ...t, [f.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      {invalid && <p className="text-xs text-destructive">Use numbers of 0 or more (and % between 0 and 100).</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button disabled={nothing || invalid} onClick={() => onApply(parsed)}>Apply</Button>
      </DialogFooter>
    </>
  );
}
