"use client";
import * as React from "react";
import { AlertTriangle, Check, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { DEFAULT_OFFER_LAYOUT, OFFER_LAYOUTS, OFFER_LAYOUT_LABEL, pickApprovedSnapshot, type OfferLayout } from "../offer";
import type { SheetStatus } from "../workflow";
import type { EstVersionRow } from "../types";
import { api } from "./api";
import { VerifiedBadge } from "./history-panels";
import { NeedsApproval } from "./sheet-parts";

export interface CreatedOffer { quotationId: string; number: string; revision: number; layout: OfferLayout; snapshotVersion: number; termsFromCurrentSheet: boolean }

const HINT: Record<OfferLayout, string> = {
  LUMP_SUM: "One line with the approved final price.",
  PER_ITEM: "One line per item (its share of the approved final price). Needs every item to still be on the sheet.",
};

/** Creates a DRAFT quotation from the newest APPROVED snapshot. The saved sheet's numbers are never used. */
export function OfferDialog({ open, onOpenChange, projectId, status, dirty, cur, onCreated }: {
  open: boolean; onOpenChange: (v: boolean) => void; projectId: string; status: SheetStatus; dirty: boolean; cur: string; onCreated: (o: CreatedOffer) => void;
}) {
  const [rows, setRows] = React.useState<EstVersionRow[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [layout, setLayout] = React.useState<OfferLayout>(DEFAULT_OFFER_LAYOUT);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<{ versions: EstVersionRow[] }>(`/api/projects/${projectId}/estimation/versions`, "GET").then((r) => {
      if (cancelled) return;
      if (r.ok) { setLoadError(null); setRows(r.data.versions); } else setLoadError(r.error);
    });
    return () => { cancelled = true; };
  }, [open, projectId]);
  const approved = rows ? pickApprovedSnapshot(rows) : null;

  async function create() {
    setBusy(true); setError(null);
    const r = await api<CreatedOffer>(`/api/projects/${projectId}/estimation/offer`, "POST", { layout });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    toast.success(`Offer ${r.data.number} Rev. ${r.data.revision} created as a draft`);
    onCreated(r.data); onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Create offer</DialogTitle><DialogDescription>Creates a draft quotation. The first offer gets a new number; later ones are a new revision of the same number and never overwrite an earlier revision.</DialogDescription></DialogHeader>
        {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
        {!rows && !loadError && <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking the approved snapshot…</div>}
        {rows && !approved && <div role="alert" className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> This sheet has not been approved yet. Calculate and approve it first: an offer is built from the approved snapshot, never from the saved sheet.</div>}
        {approved && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800"><Check className="h-4 w-4" /> Built from the approved snapshot of v{approved.version}: <b className="tabular-nums">{approved.finalPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })} {cur}</b><VerifiedBadge verified={approved.verified} /></div>
            {status !== "APPROVED" && <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>The sheet was reopened after that approval. The prices are the approved ones; payment terms, delivery period, exclusions and notes are copied from the sheet as it is now.</span></div>}
            {dirty && <p className="text-xs text-muted-foreground">Your unsaved edits are not used.</p>}
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-semibold">Offer lines{layout === DEFAULT_OFFER_LAYOUT && <NeedsApproval why="lump sum as the default layout" />}</legend>
              {OFFER_LAYOUTS.map((l) => (
                <label key={l} className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm", layout === l ? "border-primary bg-primary/5" : "border-border")}>
                  <input type="radio" name="offer-layout" className="mt-1" checked={layout === l} onChange={() => { setLayout(l); setError(null); }} />
                  <span><span className="block font-semibold">{OFFER_LAYOUT_LABEL[l]}</span><span className="block text-xs text-muted-foreground">{HINT[l]}</span></span>
                </label>
              ))}
            </fieldset>
          </div>
        )}
        {error && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">{error}</p>}
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button><Button onClick={() => void create()} disabled={busy || !approved || !approved.verified}>{busy ? <Loader2 className="animate-spin" /> : <Send />} Create draft offer</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
