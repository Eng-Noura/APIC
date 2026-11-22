/** One fetch helper for the pricing page. A failed request never throws: the caller gets { ok:false, error } to show next to the control. */
export async function api<T>(url: string, method: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: json?.error ?? `Request failed (${res.status})` };
    return { ok: true, data: json as T };
  } catch { return { ok: false, error: "Network error" }; }
}
