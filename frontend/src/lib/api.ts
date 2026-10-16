/** A failed request: the HTTP status, and the backend's `{error, code}` body when it sent one. */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * A JSON request to this plugin's own backend. `path` is relative: a `/`-led path would reach cc's API.
 * Never cached: every answer carries a live probe, so a cached one would be a stale claim.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (path.startsWith('/')) throw new Error(`api('${path}'): root-relative, so it would reach cc, not this plugin`);
  const res = await fetch(path, { ...init, cache: 'no-store' });
  if (!res.ok) {
    const body: { error?: unknown; code?: unknown } | null = await res.json().catch(() => null);
    throw new ApiError(
      res.status,
      typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`,
      typeof body?.code === 'string' ? body.code : undefined,
    );
  }
  return (await res.json()) as T;
}

/** The `init` for a request with `method` and, when given, a JSON `body`. */
export function json(method: string, body?: unknown): RequestInit {
  if (body === undefined) return { method };
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
