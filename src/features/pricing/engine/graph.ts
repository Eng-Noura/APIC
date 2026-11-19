import { resolveRate } from "./rates";
import type {
  Component, Issue, Ledger, Method, NodeSpec, Quantities, RateLayers, TraceEntry, GraphResult,
} from "./types";

const PER_BASIS: Partial<Record<Method, { name: string; unit: string; pick: (q: Quantities) => number | undefined }>> = {
  PER_TON: { name: "weight (t)", unit: "TON", pick: (q) => q.weightTon },
  PER_KG: { name: "weight (kg)", unit: "KG", pick: (q) => q.weightKg },
  PER_SQM: { name: "area (m²)", unit: "SQM", pick: (q) => q.areaSqm },
  PER_METER: { name: "length (m)", unit: "M", pick: (q) => q.lengthM },
  PER_UNIT: { name: "units (ea)", unit: "EA", pick: (q) => q.units },
};
const UNIT_BASIS: Record<string, Method> = { TON: "PER_TON", KG: "PER_KG", SQM: "PER_SQM", M: "PER_METER", EA: "PER_UNIT" };

/** Ledgers a node of the given ledger may read. COST/INDIRECT never read prices. */
const ALLOWED_DEPS: Record<Ledger, Ledger[]> = {
  COST: ["COST"],
  INDIRECT: ["COST", "INDIRECT"],
  SALE: ["COST", "INDIRECT", "SALE"],
  TOTAL_COST: ["COST", "INDIRECT", "SALE", "TOTAL_COST"],
  RESULT: ["COST", "INDIRECT", "SALE", "TOTAL_COST", "RESULT"],
};

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(+n.toPrecision(12)));

export interface EvalContext {
  quantities: Quantities;
  layers: RateLayers;
}

function depsOf(s: NodeSpec): string[] {
  if (s.kind === "derived") return s.deps;
  const c = s.component;
  return c.base ? [c.base] : [];
}
const idOf = (s: NodeSpec) => (s.kind === "derived" ? s.id : s.component.id);
const ledgerOf = (s: NodeSpec) => (s.kind === "derived" ? s.ledger : s.component.ledger);

/** Kahn topological order (stable); on failure returns the nodes left over plus one cycle path. */
export function topoSort(specs: NodeSpec[]): { order: string[]; cycle: string[] | null } {
  const ids = new Set(specs.map(idOf));
  const deps = new Map(specs.map((s) => [idOf(s), depsOf(s).filter((d) => ids.has(d))]));
  const indeg = new Map<string, number>();
  const users = new Map<string, string[]>();
  for (const [id, ds] of deps) {
    indeg.set(id, ds.length);
    for (const d of ds) users.set(d, [...(users.get(d) ?? []), id]);
  }
  const queue = specs.map(idOf).filter((id) => indeg.get(id) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const u of users.get(id) ?? []) {
      indeg.set(u, indeg.get(u)! - 1);
      if (indeg.get(u) === 0) queue.push(u);
    }
  }
  if (order.length === specs.length) return { order, cycle: null };
  // find one concrete cycle among the unresolved nodes
  const left = new Set([...deps.keys()].filter((id) => !order.includes(id)));
  const seen = new Set<string>();
  const stack: string[] = [];
  const dfs = (id: string): string[] | null => {
    if (stack.includes(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (seen.has(id)) return null;
    seen.add(id);
    stack.push(id);
    for (const d of deps.get(id) ?? []) if (left.has(d)) { const c = dfs(d); if (c) return c; }
    stack.pop();
    return null;
  };
  for (const id of left) { const c = dfs(id); if (c) return { order, cycle: c }; }
  return { order, cycle: [...left] };
}

/** Validates the graph and evaluates every node, producing values + a trace per node. */
export function evaluateGraph(specs: NodeSpec[], ctx: EvalContext): GraphResult {
  const issues: Issue[] = [];
  const values: Record<string, number> = {};
  const trace: Record<string, TraceEntry> = {};

  // --- structural validation
  const byId = new Map<string, NodeSpec>();
  for (const s of specs) {
    const id = idOf(s);
    if (byId.has(id)) issues.push({ code: "DUPLICATE_NODE", severity: "error", nodeId: id, message: `Duplicate node id "${id}".` });
    byId.set(id, s);
  }
  for (const s of specs) {
    for (const d of depsOf(s)) {
      const dep = byId.get(d);
      if (!dep) { issues.push({ code: "UNKNOWN_DEPENDENCY", severity: "error", nodeId: idOf(s), message: `"${idOf(s)}" depends on unknown node "${d}".` }); continue; }
      if (!ALLOWED_DEPS[ledgerOf(s)].includes(ledgerOf(dep))) {
        issues.push({ code: "LEDGER_MIX", severity: "error", nodeId: idOf(s), message: `${ledgerOf(s)} node "${idOf(s)}" may not read ${ledgerOf(dep)} node "${d}" (cost and price must stay separate).` });
      }
    }
  }
  const { order, cycle } = topoSort(specs);
  if (cycle) issues.push({ code: "CYCLE", severity: "error", message: `Circular dependency: ${cycle.join(" → ")}.` });
  if (issues.some((i) => i.severity === "error")) {
    return { ok: false, values, trace, order, issues };
  }

  // --- evaluation
  for (const id of order) {
    const s = byId.get(id)!;
    const deps = depsOf(s);
    const blocked = deps.filter((d) => trace[d]?.status === "ERROR" || trace[d]?.status === "SKIPPED");
    const base: TraceEntry = s.kind === "derived"
      ? { id, label: s.label, ledger: s.ledger, category: s.category, status: "OK", value: null, formula: s.formula, inputs: [] }
      : { id, label: s.component.name, ledger: s.component.ledger, category: s.component.category, status: "OK", value: null, method: s.component.method, formula: "", inputs: [], source: s.component.source };
    if (blocked.length) {
      trace[id] = { ...base, status: "SKIPPED" };
      issues.push({ code: "DEPENDENCY_FAILED", severity: "warning", nodeId: id, message: `"${id}" not calculated: depends on failed ${blocked.join(", ")}.` });
      continue;
    }
    try {
      if (s.kind === "derived") {
        const inputs = deps.map((d) => ({ id: d, value: values[d] }));
        const v = s.fn(Object.fromEntries(inputs.map((x) => [x.id, x.value])));
        if (!Number.isFinite(v)) throw new Issue_({ code: "INVALID_RATE", severity: "error", nodeId: id, message: `"${id}" produced a non-finite value.` });
        values[id] = v;
        trace[id] = { ...base, value: v, inputs, expression: `${s.formula} = ${fmt(v)}` };
      } else {
        const r = evalComponent(s.component, ctx, values);
        issues.push(...r.issues);
        if (r.status === "ERROR") { trace[id] = { ...base, status: "ERROR", formula: r.formula }; continue; }
        values[id] = r.amount;
        trace[id] = { ...base, status: r.status, value: r.amount, formula: r.formula, expression: r.expression, inputs: r.inputs, rate: r.rate, basis: r.basis };
      }
    } catch (e) {
      if (e instanceof Issue_) { issues.push(e.issue); trace[id] = { ...base, status: "ERROR" }; } else throw e;
    }
  }
  return { ok: !issues.some((i) => i.severity === "error"), values, trace, order, issues };
}

class Issue_ extends Error { constructor(public issue: Issue) { super(issue.message); } }

interface CompResult {
  status: "OK" | "DISABLED" | "ERROR";
  amount: number;
  formula: string;
  expression?: string;
  inputs: { id: string; value: number }[];
  rate?: TraceEntry["rate"];
  basis?: TraceEntry["basis"];
  issues: Issue[];
}

function evalComponent(c: Component, ctx: EvalContext, values: Record<string, number>): CompResult {
  const issues: Issue[] = [];
  const fail = (code: Issue["code"], message: string): CompResult => {
    issues.push({ code, severity: "error", nodeId: c.id, message });
    return { status: "ERROR", amount: 0, formula: c.method, inputs: [], issues };
  };
  if (!c.enabled) return { status: "DISABLED", amount: 0, formula: `${c.method} (disabled)`, inputs: [], issues };

  const needsRate = c.method !== "FIXED_PLUS_VARIABLE" || c.rateKey !== undefined || c.rate !== undefined;
  const rr = needsRate ? resolveRate(c.rateKey, ctx.layers, c.rate) : null;
  if (!rr) return fail("MISSING_RATE", `No rate for "${c.name}" (key "${c.rateKey ?? "—"}") in any layer.`);
  if (!Number.isFinite(rr.value) || rr.value < 0) return fail("INVALID_RATE", `Rate for "${c.name}" must be a number ≥ 0 (got ${rr.value}).`);
  const rate = rr.value;
  const rateInfo = { key: c.rateKey, value: rate, layer: rr.layer };

  const perBasis = PER_BASIS[c.method];
  if (perBasis) {
    if (c.unit && c.unit !== perBasis.unit) return fail("UNIT_MISMATCH", `"${c.name}": method ${c.method} needs unit ${perBasis.unit}, got ${c.unit}.`);
    const b = perBasis.pick(ctx.quantities);
    if (b === undefined) return fail("MISSING_BASIS", `"${c.name}": the item has no ${perBasis.name}; cannot apply ${c.method}.`);
    if (b === 0) issues.push({ code: "ZERO_BASIS", severity: "warning", nodeId: c.id, message: `"${c.name}": ${perBasis.name} is 0, amount is 0.` });
    const amount = b * rate;
    return { status: "OK", amount, formula: `${perBasis.name} × rate`, expression: `${fmt(b)} × ${fmt(rate)} = ${fmt(amount)}`, inputs: [], rate: rateInfo, basis: { name: perBasis.name, value: b }, issues };
  }

  switch (c.method) {
    case "FIXED_LUMP_SUM":
      return { status: "OK", amount: rate, formula: "lump sum", expression: `${fmt(rate)}`, inputs: [], rate: rateInfo, issues };
    case "FIXED_PLUS_VARIABLE": {
      if (!c.unit) return fail("UNIT_MISMATCH", `"${c.name}": FIXED_PLUS_VARIABLE needs the unit of its variable part.`);
      const m = UNIT_BASIS[c.unit];
      const pb = PER_BASIS[m]!;
      const fx = resolveRate(c.fixedKey, ctx.layers, c.fixed);
      if (!fx) return fail("MISSING_RATE", `No fixed part for "${c.name}" (key "${c.fixedKey ?? "—"}") in any layer.`);
      if (!Number.isFinite(fx.value) || fx.value < 0) return fail("INVALID_RATE", `Fixed part for "${c.name}" must be ≥ 0.`);
      const b = pb.pick(ctx.quantities);
      if (b === undefined) return fail("MISSING_BASIS", `"${c.name}": the item has no ${pb.name}.`);
      const amount = fx.value + b * rate;
      return { status: "OK", amount, formula: `fixed + ${pb.name} × rate`, expression: `${fmt(fx.value)} + ${fmt(b)} × ${fmt(rate)} = ${fmt(amount)}`, inputs: [], rate: rateInfo, basis: { name: pb.name, value: b }, issues };
    }
    case "PERCENT_OF_BASE":
    case "DIVISOR":
    case "MARKUP": {
      if (!c.base) return fail("MISSING_BASE", `"${c.name}": ${c.method} needs a base node.`);
      const b = values[c.base];
      const inputs = [{ id: c.base, value: b }];
      if (c.method === "PERCENT_OF_BASE") {
        const amount = b * rate;
        return { status: "OK", amount, formula: `${c.base} × rate`, expression: `${fmt(b)} × ${fmt(rate)} = ${fmt(amount)}`, inputs, rate: rateInfo, issues };
      }
      if (c.method === "MARKUP") {
        if (rate <= 0) return fail("INVALID_RATE", `"${c.name}": a markup multiplier must be > 0.`);
        if (rate < 1) issues.push({ code: "LOW_MARKUP", severity: "warning", nodeId: c.id, message: `"${c.name}": markup ${rate} is below 1 — sells under cost.` });
        const amount = b * rate;
        return { status: "OK", amount, formula: `${c.base} × markup`, expression: `${fmt(b)} × ${fmt(rate)} = ${fmt(amount)}`, inputs, rate: rateInfo, issues };
      }
      // DIVISOR (e.g. social insurance ÷ 0.9505): the amount is the INCREASE, base/divisor − base.
      if (rate <= 0) return fail("INVALID_RATE", `"${c.name}": a divisor must be > 0.`);
      const amount = b / rate - b;
      return { status: "OK", amount, formula: `${c.base} ÷ divisor − ${c.base}`, expression: `${fmt(b)} ÷ ${fmt(rate)} − ${fmt(b)} = ${fmt(amount)}`, inputs, rate: rateInfo, issues };
    }
  }
  return fail("INVALID_RATE", `Unsupported method ${c.method}.`);
}
