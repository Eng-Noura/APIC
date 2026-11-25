import { toast } from "sonner";

/** Restores parts from the trash; returns how many came back and the first reason for the ones that did not. */
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

/** "N deleted — Undo" for 10 seconds. The parts stay in the Trash for 30 days after that. */
export function showUndoToast(message: string, trashIds: string[], onRestored: () => void) {
  if (!trashIds.length) { toast.success(message); return; }
  toast(message, {
    duration: 10000,
    action: {
      label: "Undo",
      onClick: async () => {
        const { restored, error } = await restoreFromTrash(trashIds);
        if (restored) toast.success(`${restored} item(s) restored`);
        if (error) toast.error(error);
        if (restored) onRestored();
      },
    },
  });
}
