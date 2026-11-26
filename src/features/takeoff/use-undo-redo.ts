"use client";
import * as React from "react";
import { toast } from "sonner";
import { applyStep } from "./undo-delete";

interface Step { id: string; label: string }
interface Peek { undo: Step | null; redo: Step | null }

/**
 * Ctrl+Z / Ctrl+Y (Cmd on a Mac; Ctrl+Shift+Z also redoes) for the Part List, plus the state the toolbar buttons need.
 * The steps live on the server and belong to the signed-in person. Text fields keep their own undo, and nothing happens
 * while a dialog is open. `refreshKey` = anything that changes whenever the Part List reloads.
 */
export function useUndoRedo(projectId: string | null, enabled: boolean, onApplied: () => void, refreshKey: unknown) {
  const [peek, setPeek] = React.useState<Peek>({ undo: null, redo: null });
  const busy = React.useRef(false);
  const [working, setWorking] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/takeoff/undo?projectId=${encodeURIComponent(projectId)}`);
      if (res.ok) setPeek((await res.json()) as Peek);
    } catch { /* the buttons simply stay as they were */ }
  }, [projectId]);

  React.useEffect(() => { void refresh(); }, [refresh, refreshKey]);

  const run = React.useCallback(async (direction: "undo" | "redo") => {
    if (!projectId || busy.current) return;
    busy.current = true; setWorking(true);
    const r = await applyStep(projectId, direction);
    busy.current = false; setWorking(false);
    if (r.ok) { toast.success(`${direction === "undo" ? "Undone" : "Redone"}: ${r.label ?? ""}`); onApplied(); }
    else toast.error(r.error ?? "Could not apply this step");
    void refresh();
  }, [projectId, onApplied, refresh]);

  React.useEffect(() => {
    if (!enabled || !projectId) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      const dir = k === "z" && !e.shiftKey ? "undo" : k === "y" || (k === "z" && e.shiftKey) ? "redo" : null;
      if (!dir) return;
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select,[contenteditable=true]")) return; // text fields keep their own undo
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return; // a dialog is open
      e.preventDefault();
      void run(dir);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, projectId, run]);

  return { peek, working, undo: () => run("undo"), redo: () => run("redo") };
}
