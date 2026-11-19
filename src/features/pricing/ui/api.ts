import { toast } from "sonner";

/** JSON request helper: toasts the server's message on failure and returns null. */
export async function call<T = unknown>(url: string, method: string, body?: unknown, quiet = false): Promise<T | null> {
  try {
    const res = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) { if (!quiet) toast.error(json?.error ?? `Request failed (${res.status})`); return null; }
    return json as T;
  } catch {
    if (!quiet) toast.error("Network error");
    return null;
  }
}
