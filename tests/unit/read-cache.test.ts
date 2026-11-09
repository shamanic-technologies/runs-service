import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ReadCache } from "../../src/services/read-cache.js";

describe("ReadCache (DASH-SPEED-1110): stored answers for slow repeated reads", () => {
  beforeEach(() => {
    process.env.READ_CACHE = "on";
    vi.useFakeTimers();
  });
  afterEach(() => {
    process.env.READ_CACHE = "off";
    vi.useRealTimers();
  });

  it("serves a fresh answer without recomputing, a stale one at once while ONE refresh runs, an expired one after recomputing", async () => {
    const cache = new ReadCache({ freshMs: 1_000, maxStaleMs: 10_000, maxBytes: 1_000 });
    let n = 0;
    const compute = vi.fn(async () => `{"n":${++n}}`);
    expect(await cache.get("k", compute)).toBe('{"n":1}');
    expect(await cache.get("k", compute)).toBe('{"n":1}');
    expect(compute).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000); // stale: old answer now, one background refresh
    let release!: (v: string) => void;
    const slow = vi.fn(() => new Promise<string>((ok) => (release = ok)));
    expect(await cache.get("k", slow)).toBe('{"n":1}');
    expect(await cache.get("k", slow)).toBe('{"n":1}');
    expect(slow).toHaveBeenCalledTimes(1);
    release('{"n":2}');
    await vi.runAllTimersAsync();
    expect(await cache.get("k", compute)).toBe('{"n":2}');
    n = 2;

    vi.advanceTimersByTime(20_000); // expired: the caller waits for a new answer
    expect(await cache.get("k", compute)).toBe('{"n":3}');
  });

  it("concurrent first callers share one computation; a failure is never stored", async () => {
    const cache = new ReadCache({ freshMs: 1_000, maxStaleMs: 10_000, maxBytes: 1_000 });
    let release!: (v: string) => void;
    const compute = vi.fn(() => new Promise<string>((ok) => (release = ok)));
    const a = cache.get("k", compute);
    const b = cache.get("k", compute);
    release("{}");
    expect(await a).toBe("{}");
    expect(await b).toBe("{}");
    expect(compute).toHaveBeenCalledTimes(1);

    const failing = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(cache.get("x", failing)).rejects.toThrow("boom");
    const ok = vi.fn(async () => '{"ok":true}');
    expect(await cache.get("x", ok)).toBe('{"ok":true}');
  });

  it("never keeps an answer above maxBytes; READ_CACHE=off computes every call", async () => {
    const cache = new ReadCache({ freshMs: 1_000, maxStaleMs: 10_000, maxBytes: 5 });
    const big = vi.fn(async () => "0123456789");
    await cache.get("b", big);
    await cache.get("b", big);
    expect(big).toHaveBeenCalledTimes(2);

    process.env.READ_CACHE = "off";
    const c = vi.fn(async () => "{}");
    await cache.get("c", c);
    await cache.get("c", c);
    expect(c).toHaveBeenCalledTimes(2);
  });
});
