import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveUnitCost, resolveMultipleUnitCosts, CostNotFoundError, UpstreamError } from "../../src/services/cost-resolver.js";

describe("cost-resolver", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  const okResponse = (name: string, cost = "0.0003000000") => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ name, costPerUnitInUsdCents: cost }),
  });

  describe("resolveUnitCost", () => {
    it("resolves a cost unit from costs-service", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("gpt-4o-input-token")));

      const promise = resolveUnitCost("gpt-4o-input-token");
      const result = await promise;
      expect(result.name).toBe("gpt-4o-input-token");
      expect(result.costPerUnitInUsdCents).toBe("0.0003000000");
    });

    it("throws CostNotFoundError on 404 without retrying", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      vi.stubGlobal("fetch", mockFetch);

      await expect(resolveUnitCost("unknown")).rejects.toThrow(CostNotFoundError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws UpstreamError on non-retryable non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));

      await expect(resolveUnitCost("test")).rejects.toThrow(UpstreamError);
      await expect(resolveUnitCost("test")).rejects.toThrow("costs-service returned 400");
    });

    it("retries on 502 and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 502 })
        .mockResolvedValueOnce(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test");

      // Advance past the 1s backoff for retry #1
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.name).toBe("test");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on 503 and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test");
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.name).toBe("test");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on 429 and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429 })
        .mockResolvedValueOnce(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test");
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.name).toBe("test");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on network error (TypeError) and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test");
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.name).toBe("test");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("gives up after max retries and throws UpstreamError", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test");
      // Prevent unhandled rejection while timers advance
      promise.catch(() => {});

      // Advance through all retry backoffs: 1s + 2s + 4s
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(promise).rejects.toThrow(UpstreamError);
      // 1 initial + 3 retries = 4 total
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("uses exponential backoff between retries", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 502 }) // attempt 0
        .mockResolvedValueOnce({ ok: false, status: 502 }) // attempt 1 (after 1s)
        .mockResolvedValueOnce({ ok: false, status: 502 }) // attempt 2 (after 2s)
        .mockResolvedValueOnce(okResponse("test", "0.01")); // attempt 3 (after 4s)
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test");

      // After 999ms, only 1 call (the initial attempt)
      await vi.advanceTimersByTimeAsync(999);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // At 1000ms, retry #1 fires
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // After another 1999ms (total ~3s), still only 2 calls
      await vi.advanceTimersByTimeAsync(1999);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // At 2000ms after retry #1, retry #2 fires
      await vi.advanceTimersByTimeAsync(1);
      expect(mockFetch).toHaveBeenCalledTimes(3);

      // At 4000ms after retry #2, retry #3 fires
      await vi.advanceTimersByTimeAsync(4_000);
      expect(mockFetch).toHaveBeenCalledTimes(4);

      const result = await promise;
      expect(result.name).toBe("test");
    });

    it("does not retry on 400", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400 });
      vi.stubGlobal("fetch", mockFetch);

      await expect(resolveUnitCost("test")).rejects.toThrow(UpstreamError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("passes an abort signal to fetch", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      await resolveUnitCost("test");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    it("sends API key header when configured", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      await resolveUnitCost("test");

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/costs/test"),
        expect.objectContaining({
          headers: expect.objectContaining({ "X-API-Key": "test-costs-key" }),
        })
      );
    });
  });

  describe("resolveMultipleUnitCosts", () => {
    it("resolves multiple costs in parallel with dedup", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        const name = url.split("/v1/costs/")[1];
        return Promise.resolve(okResponse(name));
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await resolveMultipleUnitCosts([
        "cost-a",
        "cost-b",
        "cost-a",
      ]);

      expect(result.size).toBe(2);
      expect(result.get("cost-a")).toBe("0.0003000000");
      expect(result.get("cost-b")).toBe("0.0003000000");
      // Should only fetch 2 unique names, not 3
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("propagates CostNotFoundError", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

      await expect(
        resolveMultipleUnitCosts(["missing"])
      ).rejects.toThrow(CostNotFoundError);
    });
  });
});
