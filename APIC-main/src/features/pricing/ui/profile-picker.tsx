"use client";
import * as React from "react";
import { call } from "./api";
import { TYPE_LABEL, isChainType, isLineType, type ProfileType } from "../rate-library";
import type { ItemDto, RateProfileDto } from "./types";

const SLOTS = (["FABRICATION", "INSTALLATION", "SUBCONTRACTOR", "TRANSPORT", "ADD_ON", "INDIRECT", "PROFIT", "TAX_INSURANCE"] as ProfileType[]);

/** Chooses which Rate Profiles an item uses. A chosen profile's rates win over project and global rates; its lines are added to the item. */
export function ProfilePicker({ item, projectId, canEdit, onChanged }: { item: ItemDto; projectId: string; canEdit: boolean; onChanged: () => void }) {
  const [profiles, setProfiles] = React.useState<RateProfileDto[] | null>(null);
  React.useEffect(() => {
    let off = false;
    call<{ profiles: RateProfileDto[] }>(`/api/rate-library?projectId=${encodeURIComponent(projectId)}`, "GET", undefined, true).then((r) => { if (!off) setProfiles(r?.profiles ?? []); });
    return () => { off = true; };
  }, [projectId]);

  async function choose(slot: ProfileType, id: string) {
    const next = { ...item.profileRefs };
    if (id) next[slot] = id; else delete next[slot];
    if (await call(`/api/pricing/items/${item.id}`, "PATCH", { profileRefs: next })) onChanged();
  }
  if (!profiles) return null;
  const usable = SLOTS.filter((s) => profiles.some((p) => p.type === s && p.active));
  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold">Rate profiles</h4>
      <p className="text-xs text-muted-foreground">Global and project profiles apply to every item automatically. A profile chosen here wins over them; cost-line profiles (fabrication, installation …) add their lines to this item.</p>
      {!usable.length ? <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">No profiles in the Rate Library yet.</p> : (
        <div className="grid gap-2 sm:grid-cols-2">
          {usable.map((s) => (
            <label key={s} className="text-xs">
              <span className="text-muted-foreground">{TYPE_LABEL[s]} {isLineType(s) && !isChainType(s) ? "(adds lines)" : "(rates)"}</span>
              <select disabled={!canEdit} value={item.profileRefs[s] ?? ""} onChange={(e) => choose(s, e.target.value)} className="mt-0.5 h-9 w-full rounded-lg border border-input bg-card px-2 text-sm" aria-label={`${TYPE_LABEL[s]} profile`}>
                <option value="">None</option>
                {profiles.filter((p) => p.type === s && p.active).map((p) => <option key={p.id} value={p.id}>{p.name}{p.scope === "PROJECT" ? " (project)" : ""}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
