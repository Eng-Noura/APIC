"use client";
import * as React from "react";
import { CheckCircle2, CloudOff, Loader2 } from "lucide-react";
import { useTakeoffProject } from "@/features/takeoff/project-context";

export type AutosaveState = "idle" | "loading" | "saving" | "saved" | "error" | "reloaded";

/** A save was refused because somebody saved a newer copy first: the tab took theirs, and keeps this person's edits aside. */
export interface SaveConflict {
  /** who saved the newer copy (null = unknown) */
  by: string | null;
  /** it was this same person (another tab, or the Part List / BOQ writing into the nest) */
  byMe: boolean;
  at: string | null;
}

interface Options {
  kind: "2D" | "1D";
  /** What to save into: a project id, or `h:<id>` for an entry of the user's nesting history ("" = nothing open). */
  workspaceId: string;
  /** True once if this workspace was just created for the current import (nothing to load yet). */
  consumeFresh: (workspaceId: string, kind: string) => boolean;
  /** Reads the latest state to store. */
  capture: () => unknown;
  /** Puts a stored snapshot back; `null` = this workspace has none yet (start empty). */
  restore: (data: unknown | null) => void;
  /** Called after a successful save: the tool can forget what it only had to tell the server once (e.g. removed parts). */
  onSaved?: () => void;
  /** Returns true while the user is mid-gesture (holding a part...) — the save waits. */
  busy?: () => boolean;
  /** Everything whose change should trigger a save (fixed length). */
  deps: React.DependencyList;
}

const DEBOUNCE_MS = 1500;

/** `h:<id>` addresses a history entry, anything else is a project id. */
const scopeParam = (id: string) => (id.startsWith("h:") ? { historyId: id.slice(2) } : { projectId: id });
const scopeQuery = (id: string) => {
  const [k, v] = Object.entries(scopeParam(id))[0];
  return `${k}=${encodeURIComponent(v)}`;
};

/**
 * Loads the workspace of the open project / history entry and then auto-saves every change
 * (debounced) to /api/nesting/workspace, so work survives a refresh and can be reopened later.
 */
export function useNestingAutosave(opts: Options) {
  const { kind, workspaceId: projectId, deps } = opts; // `projectId` below = the workspace id (project or history)
  const { registerFlusher } = useTakeoffProject();
  const latest = React.useRef(opts);
  React.useEffect(() => {
    latest.current = opts; // always the newest capture/restore closures, without re-running the effects below
  });

  const [state, setState] = React.useState<AutosaveState>("idle");
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const loadedFor = React.useRef(""); // project whose workspace has been loaded (saving is allowed only then)
  const dirty = React.useRef(false);
  const lastBody = React.useRef("");
  const prevProject = React.useRef("");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // version of the project workspace this tab last loaded / saved (history entries are not versioned)
  const version = React.useRef<number | null>(null);
  // the last time the person changed something here (the presence heartbeat tells others "editing now"), and the
  // edits that a refused save set aside, so they can be put back
  const lastEditAt = React.useRef(0);
  const loadedAt = React.useRef(0);
  const mine = React.useRef<string | null>(null);
  const [conflict, setConflict] = React.useState<SaveConflict | null>(null);

  // Reads the workspace again and puts it into the tool — used when the server copy moved on (e.g. the BOQ changed a quantity).
  const reload = React.useCallback(async (pid: string) => {
    const res = await fetch(`/api/nesting/workspace?${scopeQuery(pid)}&kind=${kind}`);
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as { data: unknown | null; version?: number | null };
    if (loadedFor.current !== pid) return;
    if (json.data) { latest.current.restore(json.data); lastBody.current = JSON.stringify(json.data); }
    version.current = json.version ?? null;
    dirty.current = false;
    loadedAt.current = Date.now();
    setState("reloaded");
  }, [kind]);

  const save = React.useCallback(async (pid: string, keepalive = false) => {
    if (!pid || loadedFor.current !== pid) return;
    const data = JSON.stringify(latest.current.capture());
    if (data === lastBody.current) { dirty.current = false; return; }
    const scope = JSON.stringify(scopeParam(pid)).slice(1, -1); // "projectId":"…"  or  "historyId":"…"
    const baseVersion = !pid.startsWith("h:") && version.current !== null ? `,"baseVersion":${version.current}` : "";
    const body = `{${scope},"kind":"${kind}"${baseVersion},"data":${data}}`;
    setState("saving");
    try {
      const res = await fetch("/api/nesting/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: keepalive && body.length < 60000,
      });
      if (res.status === 409) {
        // The server copy is newer (somebody saved, or a quantity was synced from the BOQ): take it instead of overwriting it —
        // but keep this person's unsaved edits aside, so they are not lost without a word ("Restore my edits").
        const info = (await res.json().catch(() => null)) as { by?: string | null; byMe?: boolean; at?: string | null } | null;
        mine.current = data;
        await reload(pid);
        setConflict({ by: info?.by ?? null, byMe: info?.byMe === true, at: info?.at ?? null });
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const saved = (await res.json().catch(() => null)) as { version?: number } | null;
      if (typeof saved?.version === "number") version.current = saved.version;
      lastBody.current = data;
      dirty.current = false;
      latest.current.onSaved?.();
      if (loadedFor.current !== pid) return; // the user already moved on to another workspace
      setSavedAt(Date.now());
      setState("saved");
    } catch {
      if (loadedFor.current === pid) setState("error");
    }
  }, [kind, reload]);

  // "Save as project" asks every open tool to write its pending changes first.
  const flushNow = React.useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (loadedFor.current) await save(loadedFor.current);
  }, [save]);
  React.useEffect(() => registerFlusher(flushNow), [registerFlusher, flushNow]);

  // Load when the project changes (flush the previous project's pending changes first).
  React.useEffect(() => {
    const prev = prevProject.current;
    prevProject.current = projectId;
    loadedFor.current = "";
    lastBody.current = "";
    if (!projectId) {
      // the open project / history entry was closed or deleted: empty the tool, ready for a new import
      if (prev) { latest.current.restore(null); setState("idle"); setSavedAt(null); }
      return;
    }
    if (latest.current.consumeFresh(projectId, kind)) { loadedFor.current = projectId; return; }

    let cancelled = false;
    setState("loading");
    fetch(`/api/nesting/workspace?${scopeQuery(projectId)}&kind=${kind}`)
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((json: { data: unknown | null; version?: number | null }) => {
        if (cancelled) return;
        version.current = json.version ?? null;
        if (json.data) {
          latest.current.restore(json.data);
          lastBody.current = JSON.stringify(json.data);
        } else if (prev) {
          latest.current.restore(null); // switching to a workspace without a nest yet: start clean
        }
        loadedFor.current = projectId;
        loadedAt.current = Date.now();
        mine.current = null; setConflict(null);
        setState("idle");
        if (!json.data && !prev) { dirty.current = true; void save(projectId); } // adopt work done before choosing a project / entry
      })
      .catch(() => { if (!cancelled) setState("error"); });

    return () => {
      cancelled = true;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      if (dirty.current) void save(projectId, true); // flush the project we are leaving
    };
  }, [projectId, kind, save]);

  // Debounced save on every change.
  React.useEffect(() => {
    if (!projectId || loadedFor.current !== projectId) return;
    dirty.current = true;
    if (Date.now() - loadedAt.current > 2500) lastEditAt.current = Date.now(); // not the restore that follows a load
    const tick = () => {
      if (latest.current.busy?.()) { timer.current = setTimeout(tick, 1000); return; }
      timer.current = null;
      void save(projectId);
    };
    timer.current = setTimeout(tick, DEBOUNCE_MS);
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, save, ...deps]);

  // While nothing is pending, notice (every 15 s) that the project's nest changed on the server and load it.
  React.useEffect(() => {
    if (!projectId || projectId.startsWith("h:")) return;
    const id = setInterval(async () => {
      if (loadedFor.current !== projectId || dirty.current || latest.current.busy?.() || version.current === null) return;
      try {
        const r = await fetch(`/api/nesting/workspace?${scopeQuery(projectId)}&kind=${kind}&versionOnly=1`);
        if (!r.ok) return;
        const { version: v } = (await r.json()) as { version: number | null };
        if (v !== null && version.current !== null && v > version.current && !dirty.current) await reload(projectId);
      } catch { /* the next tick tries again */ }
    }, 15000);
    return () => clearInterval(id);
  }, [projectId, kind, reload]);

  // Leaving the page / closing the tab: save what is pending.
  React.useEffect(() => {
    const flush = () => { if (dirty.current) void save(prevProject.current, true); };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [save]);

  /** Puts the edits that the refused save set aside back; the next auto-save writes them over the newer copy. */
  const keepMine = React.useCallback(() => {
    const saved = mine.current;
    if (!saved) return;
    try { latest.current.restore(JSON.parse(saved)); } catch { return; }
    mine.current = null;
    setConflict(null);
  }, []);
  const dismissConflict = React.useCallback(() => { mine.current = null; setConflict(null); }, []);

  return { state: projectId ? state : ("idle" as AutosaveState), savedAt, conflict, keepMine, dismissConflict, lastEditAt };
}

export function AutosaveBadge({ state, savedAt, projectLabel, conflict, onKeepMine, onDismiss }: {
  state: AutosaveState; savedAt: number | null; projectLabel?: string;
  conflict?: SaveConflict | null; onKeepMine?: () => void; onDismiss?: () => void;
}) {
  if (conflict) {
    const at = conflict.at ? new Date(conflict.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
    const who = conflict.byMe ? "This nest was changed from another tab or the Part List" : `${conflict.by ?? "Someone"} saved a newer version`;
    return (
      <div role="alert" className="flex max-w-xl flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-900 dark:text-amber-200">
        <span>{who}{at ? ` at ${at}` : ""}, so it was reloaded. Your latest edits were not saved.</span>
        {onKeepMine && <button type="button" onClick={onKeepMine} className="font-semibold underline underline-offset-2">Restore my edits</button>}
        {onDismiss && <button type="button" onClick={onDismiss} className="text-muted-foreground underline underline-offset-2">Dismiss</button>}
      </div>
    );
  }
  if (state === "idle" && !savedAt) return null;
  const time = savedAt ? new Date(savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
      {state === "saving" || state === "loading" ? (
        <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {state === "loading" ? "Loading saved nest…" : "Saving…"}</>
      ) : state === "reloaded" ? (
        <><CheckCircle2 className="h-3.5 w-3.5 text-amber-600" /> Updated from the BOQ — the nest was reloaded</>
      ) : state === "error" ? (
        <><CloudOff className="h-3.5 w-3.5 text-destructive" /> Auto-save failed — keep this page open and try changing something again</>
      ) : (
        <><CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" /> Auto-saved{time ? ` at ${time}` : ""}{projectLabel ? ` to “${projectLabel}”` : ""}</>
      )}
    </p>
  );
}
