"use client";
import * as React from "react";
import { AlertTriangle, Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { CommercialResult } from "../calc";
import { quotationPreview } from "../sheet-view";
import type { EstSettings } from "../types";
import type { SheetStatus } from "../workflow";
import { egp } from "./fields";

/**
 * Customer-facing build-up (no internal costs). It is a PREVIEW: it has no number and creates nothing.
 * An approved sheet shows the approved snapshot's figures; any other sheet shows the saved figures and says so.
 */
export function QuotationPreviewDialog({ open, onOpenChange, status, version, projectName, customer, currency, commercial, settings, loading, error }: {
  open: boolean; onOpenChange: (v: boolean) => void; status: SheetStatus; version: number; projectName: string; customer: string; currency: string;
  commercial: CommercialResult | null; settings: EstSettings; loading: boolean; error: string | null;
}) {
  const approved = status === "APPROVED";
  const p = commercial ? quotationPreview(commercial, settings) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Quotation preview</DialogTitle><DialogDescription>{projectName}{customer ? ` · ${customer}` : ""}. Preview only: not an issued offer.</DialogDescription></DialogHeader>
        {approved
          ? <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"><Check className="h-4 w-4" /> Built from the approved snapshot of v{version}.</div>
          : <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>This sheet is {status === "CALCULATED" ? "calculated but not approved" : "a draft"}. The figures below can still change and are not an approved price.</span></div>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {loading && !error && <p className="py-4 text-sm text-muted-foreground">Loading the approved figures…</p>}
        {p && !loading && (
          <div className="space-y-4">
            <table className="w-full text-sm"><tbody>{p.lines.map((l, i) => (
              <tr key={i} className={cn("border-b", l.kind === "total" && "bg-secondary font-bold", l.kind === "info" && "text-muted-foreground")}>
                <td className={cn("px-2 py-2", l.kind === "info" && "pl-6 text-xs italic")}>{l.label}{l.kind === "info" && " (information)"}</td>
                <td className={cn("px-2 py-2 text-right tabular-nums", l.amountCents < 0 && "text-emerald-700")}>{l.amountCents < 0 ? "−" : ""}{egp(Math.abs(l.amountCents))}{l.kind === "total" ? ` ${currency}` : ""}</td>
              </tr>))}</tbody></table>
            <dl className="space-y-2 text-sm">{p.terms.map((t) => <div key={t.label}><dt className="font-semibold">{t.label}</dt><dd className="whitespace-pre-line text-muted-foreground">{t.value}</dd></div>)}</dl>
            <p className="text-xs text-muted-foreground">The line order shown is the one documented in the calculation (profit, insurance, other charges, discount, tax). <span className="font-semibold uppercase text-amber-800">needs approval</span> until the company confirms it.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
