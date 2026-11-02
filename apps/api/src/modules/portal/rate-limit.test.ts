import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  const start = new Date("2026-11-02T10:00:00.000Z");

  function limiter(limit = 3, windowMs = 60_000) {
    let now = start;
    const instance = new RateLimiter({ limit, windowMs, clock: () => now });
    return { instance, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
  }

  it("allows the limit, then refuses and says how long to wait", () => {
    const { instance, advance } = limiter();
    for (let i = 0; i < 3; i++) expect(instance.hit("a")).toEqual({ allowed: true });
    advance(20_000);
    expect(instance.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 40 });
  });

  it("starts a fresh window once the old one ends", () => {
    const { instance, advance } = limiter();
    for (let i = 0; i < 4; i++) instance.hit("a");
    advance(60_000);
    expect(instance.hit("a")).toEqual({ allowed: true });
  });

  it("doesn't extend the window for refused attempts", () => {
    const { instance, advance } = limiter(1);
    instance.hit("a");
    advance(30_000);
    instance.hit("a");
    advance(30_000);
    expect(instance.hit("a")).toEqual({ allowed: true });
  });

  it("counts keys separately", () => {
    const { instance } = limiter(1);
    expect(instance.hit("a").allowed).toBe(true);
    expect(instance.hit("b").allowed).toBe(true);
    expect(instance.hit("a").allowed).toBe(false);
  });

  it("sweeps expired windows when the table is full, so memory stays bounded", () => {
    let now = start;
    const instance = new RateLimiter({ limit: 1, windowMs: 1000, maxKeys: 2, clock: () => now });
    instance.hit("a");
    instance.hit("b");
    now = new Date(now.getTime() + 1000);
    expect(instance.hit("c").allowed).toBe(true);
    // "a" and "b" were swept, so they start over instead of being refused.
    expect(instance.hit("a").allowed).toBe(true);
  });
});
