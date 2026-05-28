/** Clerk JWT verification middleware for the Worker.
 *
 * Validates the `Authorization: Bearer <jwt>` header against Clerk's JWKS.
 * On success, sets `c.set("userId", sub)` for downstream handlers. On
 * failure, returns 401 — unless CLERK_ISSUER is unset, in which case the
 * middleware is a pass-through (matches the SPA's dev-mode behavior).
 *
 * Why hand-rolled instead of @clerk/backend?
 *   - @clerk/backend pulls Node polyfills the Workers runtime doesn't like.
 *   - We only need JWT verify + JWKS fetch; `jose` (~10 kB) handles both.
 *   - JWKS is cached in module scope per isolate (~5-min TTL effectively),
 *     so we hit Clerk's well-known endpoint at most once per Worker cold
 *     start.
 *
 * Routes that should be PUBLIC (no auth):
 *   - GET /                                                     (root info)
 *   - GET /health                                               (health probe)
 *   - POST /api/internal/engine-callback/:id                    (HMAC-signed)
 *   - GET  /api/internal/indigen-proxy                          (bearer-signed)
 *
 * Everything else under /api/* expects a Clerk JWT.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Bindings, Variables } from "./bindings";

/** Per-isolate cache of JWKS resolvers, keyed by issuer URL. `jose`'s
 *  createRemoteJWKSet does its own internal caching (60s default), so we
 *  just need to avoid recreating the resolver on every request. */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(issuer: string) {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    // Clerk publishes JWKS at <issuer>/.well-known/jwks.json
    const jwksUrl = new URL("/.well-known/jwks.json", issuer);
    jwks = createRemoteJWKSet(jwksUrl);
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

/** Hono middleware. Requires a valid Clerk JWT in Authorization unless
 *  CLERK_ISSUER is empty. */
export const clerkAuth: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> = async (c, next) => {
  const issuer = c.env.CLERK_ISSUER;

  // Auth disabled — dev mode. Set a synthetic userId so downstream handlers
  // that read it don't crash.
  if (!issuer) {
    c.set("userId", "dev-unauthenticated");
    return next();
  }

  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) {
    return c.json({ error: "missing bearer token" }, 401);
  }
  const token = header.slice(7).trim();
  if (!token) {
    return c.json({ error: "empty bearer token" }, 401);
  }

  try {
    const jwks = getJwks(issuer);
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: c.env.CLERK_AUDIENCE || undefined,
    });
    if (!payload.sub) {
      return c.json({ error: "token missing subject" }, 401);
    }
    c.set("userId", payload.sub);
    return next();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `invalid token: ${msg}` }, 401);
  }
};

/** Routes that bypass auth entirely. Use this for internal webhooks that
 *  have their own auth (HMAC / shared bearer) and for health probes. The
 *  middleware is attached upstream and uses path prefixes for matching. */
export function isPublicPath(path: string): boolean {
  // Engine callbacks are HMAC-verified inside the handler itself.
  if (path.startsWith("/api/internal/engine-callback/")) return true;
  // IndiGen proxy uses its own bearer header.
  if (path.startsWith("/api/internal/indigen-proxy")) return true;
  // Root + health
  if (path === "/" || path === "/health") return true;
  return false;
}

/** Wraps clerkAuth with path-based bypass. Use this as the top-level
 *  middleware in src/index.ts so the public paths above remain reachable. */
export const clerkAuthGated: MiddlewareHandler<{ Bindings: Bindings; Variables: Variables }> = async (c, next) => {
  if (isPublicPath(new URL(c.req.url).pathname)) {
    return next();
  }
  return clerkAuth(c as unknown as Context, next as unknown as Next) as Promise<Response | void>;
};
