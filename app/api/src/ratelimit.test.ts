import { describe, expect, it } from "vitest";
import {
  isRateLimitExempt,
  rateLimitKeyFrom,
  RATE_LIMIT_WINDOW_SECONDS,
} from "./ratelimit";

describe("isRateLimitExempt", () => {
  it("exempts internal machine + health/root paths", () => {
    expect(isRateLimitExempt("/health")).toBe(true);
    expect(isRateLimitExempt("/")).toBe(true);
    expect(isRateLimitExempt("/api/internal/engine-callback/abc")).toBe(true);
    expect(isRateLimitExempt("/api/internal/indigen-proxy")).toBe(true);
  });

  it("does not exempt normal user surface", () => {
    expect(isRateLimitExempt("/api/cases")).toBe(false);
    expect(isRateLimitExempt("/api/ai/synopsis")).toBe(false);
    expect(isRateLimitExempt("/cases/123")).toBe(false);
  });
});

describe("rateLimitKeyFrom", () => {
  it("buckets by authenticated user id", () => {
    expect(rateLimitKeyFrom("user_2abc", "1.2.3.4")).toBe("user:user_2abc");
  });

  it("falls back to IP for the dev-unauthenticated sentinel", () => {
    expect(rateLimitKeyFrom("dev-unauthenticated", "1.2.3.4")).toBe("ip:1.2.3.4");
  });

  it("falls back to IP when no user id", () => {
    expect(rateLimitKeyFrom(undefined, "9.9.9.9")).toBe("ip:9.9.9.9");
  });

  it("uses an unknown-IP sentinel when both are missing", () => {
    expect(rateLimitKeyFrom(undefined, undefined)).toBe("ip:unknown");
  });
});

describe("window constant", () => {
  it("matches the wrangler period used for Retry-After", () => {
    expect(RATE_LIMIT_WINDOW_SECONDS).toBe(60);
  });
});
