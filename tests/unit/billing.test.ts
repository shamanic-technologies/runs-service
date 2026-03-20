import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  deductCredits,
  provisionCredits,
  confirmProvision,
  cancelProvision,
  BillingError,
} from "../../src/services/billing.js";
import type { BillingContext } from "../../src/services/billing.js";

const TEST_CTX: BillingContext = {
  orgId: "11111111-1111-1111-1111-111111111111",
  userId: "22222222-2222-2222-2222-222222222222",
  runId: "33333333-3333-3333-3333-333333333333",
};

describe("billing client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    process.env.BILLING_SERVICE_URL = "http://localhost:9998";
    process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
  });

  const okDeductResponse = () => ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        success: true,
        balance_cents: 5000,
        billing_mode: "payg",
        depleted: false,
      }),
  });

  const okProvisionResponse = () => ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        provision_id: "prov_abc123",
        balance_cents: 4500,
      }),
  });

  const okConfirmResponse = () => ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        success: true,
        balance_cents: 4500,
      }),
  });

  const okCancelResponse = () => ({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        success: true,
        balance_cents: 5500,
      }),
  });

  describe("deductCredits", () => {
    it("calls billing-service /v1/credits/deduct with correct payload", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okDeductResponse());
      vi.stubGlobal("fetch", mockFetch);

      const result = await deductCredits(150, "run:abc — 2 cost items", TEST_CTX);

      expect(result.success).toBe(true);
      expect(result.balance_cents).toBe(5000);

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9998/v1/credits/deduct",
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
      expect(body.amount_cents).toBe(150);
      expect(body.description).toBe("run:abc — 2 cost items");
    });

    it("throws BillingError on non-ok response", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400 }));

      await expect(deductCredits(100, "test", TEST_CTX)).rejects.toThrow(BillingError);
    });

    it("retries on 502 and succeeds", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 502 })
        .mockResolvedValueOnce(okDeductResponse());
      vi.stubGlobal("fetch", mockFetch);

      const promise = deductCredits(100, "test", TEST_CTX);
      await vi.advanceTimersByTimeAsync(1_000);

      const result = await promise;
      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("gives up after max retries", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });
      vi.stubGlobal("fetch", mockFetch);

      const promise = deductCredits(100, "test", TEST_CTX);
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(promise).rejects.toThrow(BillingError);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it("omits optional headers when not provided", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okDeductResponse());
      vi.stubGlobal("fetch", mockFetch);

      await deductCredits(100, "test", { orgId: TEST_CTX.orgId });

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders["x-org-id"]).toBe(TEST_CTX.orgId);
      expect(callHeaders).not.toHaveProperty("x-user-id");
      expect(callHeaders).not.toHaveProperty("x-run-id");
    });
  });

  describe("provisionCredits", () => {
    it("calls billing-service /v1/credits/provision", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okProvisionResponse());
      vi.stubGlobal("fetch", mockFetch);

      const result = await provisionCredits(500, "run:xyz — 1 provisioned items", TEST_CTX);

      expect(result.provision_id).toBe("prov_abc123");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9998/v1/credits/provision",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws BillingError on failure", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      await expect(provisionCredits(500, "test", TEST_CTX)).rejects.toThrow(BillingError);
    });
  });

  describe("confirmProvision", () => {
    it("calls billing-service /v1/credits/provision/:id/confirm", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okConfirmResponse());
      vi.stubGlobal("fetch", mockFetch);

      const result = await confirmProvision("prov_abc123", 480, TEST_CTX);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9998/v1/credits/provision/prov_abc123/confirm",
        expect.objectContaining({ method: "POST" }),
      );

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.actual_amount_cents).toBe(480);
    });
  });

  describe("cancelProvision", () => {
    it("calls billing-service /v1/credits/provision/:id/cancel", async () => {
      const mockFetch = vi.fn().mockResolvedValue(okCancelResponse());
      vi.stubGlobal("fetch", mockFetch);

      const result = await cancelProvision("prov_abc123", TEST_CTX);

      expect(result.success).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9998/v1/credits/provision/prov_abc123/cancel",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
});
