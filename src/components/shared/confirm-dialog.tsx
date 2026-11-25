"use client";
import * as React from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";

const MAX_NAMES = 8;

export function ConfirmDialog({
  open,
  onOpenChange,
  title = "Are you sure?",
  description,
  confirmLabel = "Delete",
  onConfirm,
  loading,
  items,
  requireText,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title?: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  loading?: boolean;
  /** What is about to be affected, by name (the first few are listed, the rest are counted). */
  items?: string[];
  /** The person must type this word before the button works — for the actions that touch many things at once. */
  requireText?: string;
}) {
  const [typed, setTyped] = React.useState("");
  React.useEffect(() => { if (!open) setTyped(""); }, [open]);
  const locked = !!requireText && typed.trim().toLowerCase() !== requireText.toLowerCase();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {items && items.length > 0 && (
          <ul className="max-h-48 space-y-0.5 overflow-auto rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            {items.slice(0, MAX_NAMES).map((n, i) => <li key={i} className="truncate">• {n}</li>)}
            {items.length > MAX_NAMES && <li className="text-muted-foreground">… and {items.length - MAX_NAMES} more</li>}
          </ul>
        )}
        {requireText && (
          <div className="space-y-1.5">
            <p className="text-sm text-muted-foreground">Type <span className="font-semibold text-foreground">{requireText}</span> to confirm.</p>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={loading || locked}
            onClick={(e) => { if (locked) { e.preventDefault(); return; } onConfirm(); }}
          >
            {loading ? "Please wait…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
