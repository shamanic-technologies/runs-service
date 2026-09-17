import { describe, it, expect, vi, afterEach } from "vitest";
import { probeDatabase } from "../../src/routes/health-probe.js";

describe("probeDatabase", () => {
  afterEach(() => vi.useRealTimers());

  it("returns ok when the query resolves inside the budget", async () => {
    const status = await probeDatabase(async () => [{ "?column?": 1 }], 2000);
    expect(status).toBe("ok");
  });

  it("returns unreachable when the query rejects", async () => {
    const status = await probeDatabase(async () => {
      throw new Error("ECONNREFUSED");
    }, 2000);
    expect(status).toBe("unreachable");
  });

  it("returns slow when the query outlives the budget, without awaiting it", async () => {
    let settle: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => {
      settle = resolve;
    });

    const p = probeDatabase(() => hung, 20);
    await expect(p).resolves.toBe("slow");

    // the abandoned query settling later must not throw or change the verdict
    settle?.();
    await hung;
  });

  it("clears the timeout on the fast path", async () => {
    vi.useFakeTimers();
    const p = probeDatabase(async () => [], 60_000);
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});
