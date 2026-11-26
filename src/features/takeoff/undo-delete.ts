import { toast } from "sonner";

/** One Ctrl+Z / Ctrl+Y step on the server. */
export async function applyStep(projectId: string, direction: "undo" | "redo", entryId?: string): Promise<{ ok: boolean; label?: string; error?: string }> {
  try {
    const res = await fetch("/api/takeoff/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, direction, entryId }),
    });
    const j = (await res.json().catch(() => null)) as { label?: string; error?: string } | null;
    return res.ok ? { ok: true, label: j?.label } : { ok: false, error: j?.error ?? "Could not apply this step" };
  } catch {
    return { ok: false, error: "Could not apply this step" };
  }
}

/** Restores parts from the Trash (the Trash dialog); returns how many came back and the first reason for the ones that did not. */
export async function restoreFromTrash(trashIds: string[]): Promise<{ restored: number; error: string | null }> {
  let restored = 0;
  let error: string | null = null;
  await Promise.all(trashIds.map(async (id) => {
    try {
      const res = await fetch(`/api/takeoff/trash/${id}/restore`, { method: "POST" });
      if (res.ok) { restored++; return; }
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      error ??= j?.error ?? "Could not restore";
    } catch { error ??= "Could not restore"; }
  }));
  return { restored, error };
}

/** "N deleted — Undo" for 10 seconds: the same step Ctrl+Z would undo. The parts stay in the Trash for 30 days after that. */
export function showUndoToast(message: string, projectId: string, undoIds: string[], onRestored: () => void) {
  if (!undoIds.length) { toast.success(message); return; }
  toast(message, {
    duration: 10000,
    action: {
      label: "Undo",
      onClick: async () => {
        let done = 0;
        let error: string | undefined;
        for (const id of undoIds) {
          const r = await applyStep(projectId, "undo", id);
          if (r.ok) done++; else error ??= r.error;
        }
        if (done) toast.success(`${done} step(s) undone`);
        if (error) toast.error(error);
        if (done) onRestored();
      },
    },
  });
}
