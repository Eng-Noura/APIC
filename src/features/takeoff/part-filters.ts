import type { TakeoffPartRow, PartType, PartSide } from "./types";

/** Filter value meaning "parts that have no assembly / scope / work order". */
export const UNASSIGNED = "NONE";

export interface PartFilters {
  type: PartType | "ALL";
  thickness: string; // exact-match text, blank = any
  description: string; // substring search, case-insensitive
  side: PartSide | "ALL";
  /** "ALL" | UNASSIGNED | an assembly id (its sub-assemblies count too) */
  assembly: string;
  /** "ALL" | UNASSIGNED | a scope id */
  scope: string;
  /** "ALL" | UNASSIGNED | a work-order id */
  workOrder: string;
}

export const emptyFilters: PartFilters = {
  type: "ALL", thickness: "", description: "", side: "ALL", assembly: "ALL", scope: "ALL", workOrder: "ALL",
};

export function filtersActive(f: PartFilters): boolean {
  return (
    f.type !== "ALL" || f.side !== "ALL" || f.thickness.trim() !== "" || f.description.trim() !== "" ||
    f.assembly !== "ALL" || f.scope !== "ALL" || f.workOrder !== "ALL"
  );
}

/** The assembly with the given id plus every assembly below it (sub-assemblies, their sub-assemblies, …). */
export function assemblyWithDescendants(assemblies: { id: string; parentId: string | null }[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of assemblies) {
      if (a.parentId && out.has(a.parentId) && !out.has(a.id)) {
        out.add(a.id);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * A filter that points at an assembly / scope / work order which no longer exists (deleted meanwhile) would hide every
 * part with no way to see why: such a filter counts as "All". Only judged once the lists are loaded.
 */
export function dropStaleFilters(
  f: PartFilters,
  lists: { assemblies: { id: string }[]; scopes: { id: string }[]; workOrders: { id: string }[] } | null,
): PartFilters {
  if (!lists) return f;
  const ok = (v: string, rows: { id: string }[]) => v === "ALL" || v === UNASSIGNED || rows.some((r) => r.id === v);
  return {
    ...f,
    assembly: ok(f.assembly, lists.assemblies) ? f.assembly : "ALL",
    scope: ok(f.scope, lists.scopes) ? f.scope : "ALL",
    workOrder: ok(f.workOrder, lists.workOrders) ? f.workOrder : "ALL",
  };
}

/** The assembly ids a filter accepts (the chosen one and its sub-assemblies), or null when the assembly is not filtered by id. */
export function assemblyScope(f: PartFilters, assemblies: { id: string; parentId: string | null }[]): Set<string> | null {
  return f.assembly === "ALL" || f.assembly === UNASSIGNED ? null : assemblyWithDescendants(assemblies, f.assembly);
}

/** `asmIds` = result of `assemblyScope` for the same filters (computed once, not per part). */
export function matchesFilters(part: TakeoffPartRow, f: PartFilters, asmIds: Set<string> | null = null): boolean {
  if (f.type !== "ALL" && part.partType !== f.type) return false;
  if (f.side !== "ALL" && part.side !== f.side) return false;
  if (f.thickness.trim() !== "") {
    const wanted = Number(f.thickness);
    if (!Number.isFinite(wanted) || part.thicknessMm !== wanted) return false;
  }
  if (f.description.trim() !== "") {
    if (!part.description.toLowerCase().includes(f.description.trim().toLowerCase())) return false;
  }
  if (f.assembly === UNASSIGNED) {
    if (part.groupId) return false;
  } else if (f.assembly !== "ALL") {
    const ids = asmIds ?? new Set([f.assembly]);
    if (!part.groupId || !ids.has(part.groupId)) return false;
  }
  if (f.scope === UNASSIGNED) {
    if (part.scopeId) return false;
  } else if (f.scope !== "ALL" && part.scopeId !== f.scope) return false;
  if (f.workOrder === UNASSIGNED) {
    if (part.workOrderGroupId) return false;
  } else if (f.workOrder !== "ALL" && part.workOrderGroupId !== f.workOrder) return false;
  return true;
}
