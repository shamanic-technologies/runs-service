import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveUnitCost, resolveMultipleUnitCosts, CostNotFoundError, UpstreamError, CostResolverContext } from "../../src/services/cost-resolver.js";

const TEST_CTX: CostResolverContext = {
  orgId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};

describe("cost-resolver", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  const okResponse = (name: string, cost = "0.0003000000") => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ name, pricePerUnitInUsdCents: cost }),
  });

  describe("resolveUnitCost", () => {
    it("resolves a cost unit from costs-service", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse("gpt-4o-input-token")));

      const promise = resolveUnitCost("gpt-4o-input-token", TEST_CTX);
      const result = await promise;
      expect(result.name).toBe("gpt-4o-input-token");
      expect(result.pricePerUnitInUsdCents).toBe("0.0003000000");
    });

    it("throws CostNotFoundError on 404 without retrying", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
      vi.stubGlobal("fetch", mockFetch);

      await expect(resolveUnitCost("unknown", TEST_CTX)).rejects.toThrow(CostNotFoundError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws UpstreamError on non-retryable non-ok response and includes body", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"missing required field"}'),
      }));

      await expect(resolveUnitCost("test", TEST_CTX)).rejects.toThrow(UpstreamError);
      await expect(resolveUnitCost("test", TEST_CTX)).rejects.toThrow(
        'costs-service returned 400: {"error":"missing required field"}'
      );
    });

    it("retries on 502 and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 502, text: () => Promise.resolve("Bad Gateway") })
        .mockResolvedValueOnce(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test", TEST_CTX);

      // Advance past the 1s backoff for retry #1
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.name).toBe("test");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on 503 and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503, text: () => Promise.resolve("Service Unavailable") })
        .mockResolvedValueOnce(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test", TEST_CTX);
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.name).toBe("test");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("retries on 429 and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 429, text: () => Promise.resolve("Too Many Requests") })
        .mockResolvedValueOnce(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test", TEST_CTX);
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

      const promise = resolveUnitCost("test", TEST_CTX);
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.name).toBe("test");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("gives up after max retries and throws UpstreamError", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 502, text: () => Promise.resolve("Bad Gateway") });
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test", TEST_CTX);
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
      const err502 = { ok: false, status: 502, text: () => Promise.resolve("Bad Gateway") };
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(err502) // attempt 0
        .mockResolvedValueOnce(err502) // attempt 1 (after 1s)
        .mockResolvedValueOnce(err502) // attempt 2 (after 2s)
        .mockResolvedValueOnce(okResponse("test", "0.01")); // attempt 3 (after 4s)
      vi.stubGlobal("fetch", mockFetch);

      const promise = resolveUnitCost("test", TEST_CTX);

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
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 400, text: () => Promise.resolve("Bad Request") });
      vi.stubGlobal("fetch", mockFetch);

      await expect(resolveUnitCost("test", TEST_CTX)).rejects.toThrow(UpstreamError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("passes an abort signal to fetch", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      await resolveUnitCost("test", TEST_CTX);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });

    it("sends API key and identity headers", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      await resolveUnitCost("test", TEST_CTX);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1/platform-prices/test"),
        expect.objectContaining({
          headers: expect.objectContaining({
            "X-API-Key": "test-costs-key",
            "x-org-id": TEST_CTX.orgId,
            "x-user-id": TEST_CTX.userId,
            "x-run-id": TEST_CTX.runId,
          }),
        })
      );
    });

    it("omits x-user-id and x-run-id when not provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      await resolveUnitCost("test", { orgId: TEST_CTX.orgId });

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders["x-org-id"]).toBe(TEST_CTX.orgId);
      expect(callHeaders).not.toHaveProperty("x-user-id");
      expect(callHeaders).not.toHaveProperty("x-run-id");
    });

    it("omits x-org-id when orgId not provided (platform context)", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okResponse("test", "0.01"));
      vi.stubGlobal("fetch", mockFetch);

      await resolveUnitCost("test", {});

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders).not.toHaveProperty("x-org-id");
      expect(callHeaders).not.toHaveProperty("x-user-id");
      expect(callHeaders).not.toHaveProperty("x-run-id");
    });
  });

  describe("resolveMultipleUnitCosts", () => {
    it("resolves multiple costs in parallel with dedup", async () => {
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        const name = url.split("/v1/platform-prices/")[1];
        return Promise.resolve(okResponse(name));
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await resolveMultipleUnitCosts([
        "cost-a",
        "cost-b",
        "cost-a",
      ], TEST_CTX);

      expect(result.size).toBe(2);
      expect(result.get("cost-a")).toBe("0.0003000000");
      expect(result.get("cost-b")).toBe("0.0003000000");
      // Should only fetch 2 unique names, not 3
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("propagates CostNotFoundError", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

      await expect(
        resolveMultipleUnitCosts(["missing"], TEST_CTX)
      ).rejects.toThrow(CostNotFoundError);
    });
  });
});
