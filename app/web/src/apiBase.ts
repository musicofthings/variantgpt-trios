/**
 * Resolve the API base URL.
 *
 * Dev: empty string → relative `/api/*` paths hit the Vite middleware.
 * Prod: VITE_API_BASE is set to the deployed Worker URL (e.g.
 *       `https://variantgpt-api.workers.dev`) and gets prepended.
 *
 * Use `api("/cases/foo/status")` instead of writing `/api/cases/...` directly.
 * The `/api` prefix is part of every Worker route, so we don't include it here.
 */
const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

export function api(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${BASE}/api${p}`;
}
