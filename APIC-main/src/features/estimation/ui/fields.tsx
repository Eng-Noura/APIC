"use client";
import * as React from "react";
import { cn } from "@/lib/utils";
import { fromCents } from "../calc";

export const egp = (cents: number) => fromCents(cents).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const egp0 = (cents: number) => fromCents(cents).toLocaleString("en-US", { maximumFractionDigits: 0 });
export const kg = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-US", { maximumFractionDigits: 1 }));

export const selectCls = "h-8 w-full rounded-md border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";
export const inputCls = "h-8 w-full rounded-md border border-input bg-card px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

/** Number input that lets the user type "1." or an empty box without the value jumping; commits valid numbers on every keystroke. */
export function NumInput({ value, onChange, disabled, nullable, className, min = 0, placeholder }: { value: number | null; onChange: (v: number | null) => void; disabled?: boolean; nullable?: boolean; className?: string; min?: number; placeholder?: string }) {
  const [text, setText] = React.useState(value == null ? "" : String(value));
  const [focus, setFocus] = React.useState(false);
  const shown = focus ? text : value == null ? "" : String(value);
  const bad = shown !== "" && !(Number.isFinite(Number(shown)) && Number(shown) >= min);
  return (
    <input
      inputMode="decimal" disabled={disabled} placeholder={placeholder} value={shown} aria-invalid={bad}
      className={cn(inputCls, "text-right tabular-nums", bad && "border-destructive ring-1 ring-destructive", className)}
      onFocus={() => { setText(value == null ? "" : String(value)); setFocus(true); }}
      onBlur={() => setFocus(false)}
      onChange={(e) => {
        const t = e.target.value; setText(t);
        if (t.trim() === "") { if (nullable) onChange(null); else onChange(0); return; }
        const n = Number(t);
        if (Number.isFinite(n) && n >= min) onChange(n);
      }}
    />
  );
}

export function SourceBadge({ source }: { source: string }) {
  const tone: Record<string, string> = {
    NESTING: "bg-blue-50 text-blue-700", PART_LIST: "bg-emerald-50 text-emerald-700", PROCUREMENT: "bg-emerald-50 text-emerald-700",
    MANUAL: "bg-slate-100 text-slate-600", DEFAULT: "bg-slate-100 text-slate-600",
  };
  const label: Record<string, string> = { NESTING: "From Nesting", PART_LIST: "From Part List", PROCUREMENT: "Procurement", MANUAL: "Manual", DEFAULT: "Default" };
  return <span className={cn("inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium", tone[source] ?? tone.MANUAL)}>{label[source] ?? source}</span>;
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-semibold text-foreground">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
