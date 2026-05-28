/**
 * Resolve the API base URL + thin auth-aware fetch wrapper.
 *
 * Dev: empty string → relative `/api/*` paths hit the Vite middleware.
 * Prod: VITE_API_BASE is set to the deployed Worker URL (e.g.
 *       `https://variantgpt-api.workers.dev`) and gets prepended.
 *
 * Use `api("/cases/foo/status")` for URLs and `apiFetch(...)` for
 * requests that need the Clerk JWT attached. Plain `fetch` still works
 * for unauthenticated requests (R2 presigned PUT/GET, public assets).
 */
const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export function api(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${BASE}/api${p}`;
}

/** Provider for the current Clerk JWT, or null if Clerk isn't configured.
 *  Set once at app boot by auth.tsx via setTokenProvider() so non-React
 *  modules (caseData.ts, RunMonitor, etc.) can call apiFetch without
 *  having to thread Clerk hooks through every call site. */
type TokenProvider = () => Promise<string | null>;
let tokenProvider: TokenProvider | null = null;

export function setTokenProvider(p: TokenProvider | null) {
  tokenProvider = p;
}

/** Drop-in for fetch() that attaches the Clerk JWT (when available) as
 *  `Authorization: Bearer <jwt>`. Same signature as native fetch, so call
 *  sites read identically. When Clerk isn't configured (no provider set)
 *  this is just `fetch()` — matches the Worker's dev-mode pass-through. */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let token: string | null = null;
  if (tokenProvider) {
    try {
      token = await tokenProvider();
    } catch {
      // Token fetch failed (e.g. session expired). Send the request without
      // a token; the Worker will respond 401 and the SPA's Clerk gate will
      // re-prompt for sign-in on the next render.
      token = null;
    }
  }
  if (!token) return fetch(input, init);

  const headers = new Headers(init?.headers ?? {});
  headers.set("authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
