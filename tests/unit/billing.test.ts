import { describe, it, expect, vi, beforeEach } from "vitest";
import { notifyUsage } from "../../src/services/billing.js";
import type { BillingContext } from "../../src/services/billing.js";

const TEST_CTX: BillingContext = {
  orgId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};

describe("billing client — notifyUsage", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    process.env.BILLING_SERVICE_URL = "http://localhost:9998";
    process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const okResponse = () => ({
    ok: true,
    status: 202,
    json: () => Promise.resolve({ acknowledged: true, reload_triggered: true }),
  });

  it("POSTs /v1/customer_balance/usage_apply with spent_total_cents and identity headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", mockFetch);

    await notifyUsage(TEST_CTX, { spentTotalCents: "1234.5678901234" });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:9998/v1/customer_balance/usage_apply",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-api-key": "test-billing-key",
          "x-org-id": TEST_CTX.orgId,
          "x-user-id": TEST_CTX.userId,
          "x-run-id": TEST_CTX.runId,
        }),
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.spent_total_cents).toBe("1234.5678901234");
  });

  it("swallows non-2xx and logs to console.error, never throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(notifyUsage(TEST_CTX, { spentTotalCents: "0" })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "[runs-service] notifyUsage failed:",
      expect.objectContaining({ statusCode: 404 }),
    );
  });

  it("retries on 502 then succeeds without logging error", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 })
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", mockFetch);

    const promise = notifyUsage(TEST_CTX, { spentTotalCents: "0" });
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("gives up after max retries and logs once", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    vi.stubGlobal("fetch", mockFetch);

    const promise = notifyUsage(TEST_CTX, { spentTotalCents: "0" });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await promise;

    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});
