"use client";
import * as React from "react";
import { Users } from "lucide-react";
import { describePresence, EDITING_MS, type Other } from "@/server/calc/nest-presence";

const BEAT_MS = 10_000;

/**
 * Tells the server this tab has the project's nest open (a heartbeat every 10 s) and returns the other people who
 * have it open too. Only while the tool is visible and the browser tab is in front; closing the tab removes the person at once.
 */
export function useNestPresence(projectId: string, kind: "2D" | "1D", enabled: boolean, lastEditAt: React.MutableRefObject<number>): Other[] {
  const [others, setOthers] = React.useState<Other[]>([]);

  React.useEffect(() => {
    if (!enabled || !projectId || projectId.startsWith("h:")) { setOthers([]); return; } // a history entry belongs to one person
    let stopped = false;
    const post = (payload: object) => fetch("/api/nesting/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, kind, ...payload }) });
    const beat = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const res = await post({ editing: Date.now() - lastEditAt.current < EDITING_MS });
        if (res.ok && !stopped) setOthers(((await res.json()) as { others: Other[] }).others);
      } catch { /* the next beat tries again */ }
    };
    const leave = () => { try { navigator.sendBeacon?.("/api/nesting/presence", new Blob([JSON.stringify({ projectId, kind, leave: true })], { type: "application/json" })); } catch { /* closing anyway */ } };
    const onVisible = () => { if (document.visibilityState === "visible") void beat(); };
    void beat();
    const id = setInterval(beat, BEAT_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", leave);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", leave);
      leave();
      setOthers([]);
    };
  }, [projectId, kind, enabled, lastEditAt]);

  return others;
}

/** "Ahmed is editing this nest now" (amber: saves can clash) or "Mona has this nest open too". Nothing when nobody else is here. */
export function PresenceBanner({ others }: { others: Other[] }) {
  const p = describePresence(others);
  if (!p) return null;
  return (
    <p
      role="status"
      title={p.editing ? "Two people changing the same nest can overwrite each other — agree who edits, or work in turns." : "They can see the same nest; nothing is wrong."}
      className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${p.editing ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200" : "border-border bg-muted/40 text-muted-foreground"}`}
    >
      <Users className="h-3.5 w-3.5 shrink-0" /> {p.text}
    </p>
  );
}
