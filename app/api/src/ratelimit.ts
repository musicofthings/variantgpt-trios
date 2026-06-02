/** Per-user rate limiting for the Worker's /api/* surface.
 *
 * Backed by Cloudflare's native Rate Limiting binding (open beta) — a
 * stateless, per-colo token counter declared in wrangler.toml. No D1/KV writes
 * on the hot path, so it adds negligible latency.
 *
 * Keying: the limiter buckets by Clerk user id (set upstream by clerkAuth) so
 * one user can't exhaust the surface for everyone. Unauthenticated traffic
 * (dev mode, or requests that slipped past a disabled auth gate) falls back to
 * the client IP. Internal machine-to-machine paths (engine callbacks, the
 * IndiGen proxy) and health probes are exempt — they have their own auth and
 * shouldn't share a user's quota.
 *
 * Dev-mode pass-through: when the RATE_LIMITER binding is absent (local
 * `wrangler dev` without the binding, or a preview deploy), the middleware is a
 * no-op — exactly like the CLERK_ISSUER-less auth pass-through.
 */
import type { MiddlewareHandler } from "hono";
import type { Bindings, Variables } from "./bindings";
import { isPublicPath } from "./auth";

/** Must match the `period` in wrangler.toml's [[unsafe.bindings]] ratelimit
 *  config. Used only to populate the Retry-After hint on a 429. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** A request is exempt from per-user rate limiting when it's an internal
 *  machine path or a health/root probe — the same set auth bypasses. */
export function isRateLimitExempt(path: string): boolean {
  return isPublicPath(path);
}

/** Derive the rate-limit bucket key. Prefer the authenticated user id; fall
 *  back to client IP for unauthenticated / dev traffic. Returns a stable
 *  string the limiter buckets on. */
export function rateLimitKeyFrom(
  userId: string | undefined,
  ip: string | undefined,
): string {
  if (userId && userId !== "dev-unauthenticated") return `user:${userId}`;
  return `ip:${ip || "unknown"}`;
}

/** Cloudflare Rate Limiting binding shape (open beta). */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export const rateLimitGated: MiddlewareHandler<{
  Bindings: Bindings;
  Variables: Variables;
}> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (isRateLimitExempt(path)) return next();

  const limiter = c.env.RATE_LIMITER;
  // Binding absent → dev/preview pass-through.
  if (!limiter) return next();

  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("CF-Connecting-IP") ??
    undefined;
  const key = rateLimitKeyFrom(c.get("userId"), ip);

  const { success } = await limiter.limit({ key });
  if (!success) {
    return c.json(
      { error: "rate limit exceeded, slow down" },
      429,
      { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) },
    );
  }
  return next();
};
