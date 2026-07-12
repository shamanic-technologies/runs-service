import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Decimal } from "decimal.js";
import {
  resolveUsageDiscount,
  netFromGross,
  UsageDiscountError,
  __clearUsageDiscountCache,
} from "../../src/services/usage-discount.js";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe("netFromGross — freeze math", () => {
  it("net == gross when pct is 0", () => {
    expect(netFromGross("10.0000000000", new Decimal(0))).toBe("10.0000000000");
  });

  it("net = gross * (1 - pct) for a discounted org", () => {
    // 50% off 3.2345678903 = 1.61728394515 → 10-dp
    expect(netFromGross("3.2345678903", new Decimal("0.5"))).toBe("1.6172839452");
  });

  it("preserves numeric(16,10) scale for a fractional discount", () => {
    expect(netFromGross("1.2345678901", new Decimal("0.4"))).toBe("0.7407407341");
  });

  it("net == 0 when pct is 1 (100% discount)", () => {
    expect(netFromGross("99.9999999999", new Decimal(1))).toBe("0.0000000000");
  });
});

describe("resolveUsageDiscount", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    __clearUsageDiscountCache();
    process.env.BILLING_SERVICE_URL = "http://localhost:9998";
    process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 0 without a billing call when orgId is absent", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    expect((await resolveUsageDiscount(undefined)).toNumber()).toBe(0);
    expect((await resolveUsageDiscount(null)).toNumber()).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("resolves the discount fraction from billing on 200", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { discount_pct: "0.5" }));
    vi.stubGlobal("fetch", mockFetch);

    const pct = await resolveUsageDiscount(ORG_ID);
    expect(pct.toNumber()).toBe(0.5);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:9998/internal/accounts/by-org/11111111-1111-1111-1111-111111111111/usage-discount",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "test-billing-key" }) }),
    );
  });

  it("returns 0 on 404 (unknown org / no billing account)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(404, {}));
    vi.stubGlobal("fetch", mockFetch);

    expect((await resolveUsageDiscount(ORG_ID)).toNumber()).toBe(0);
  });

  it("caches the resolved value per org (no second billing call within TTL)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { discount_pct: "0.25" }));
    vi.stubGlobal("fetch", mockFetch);

    expect((await resolveUsageDiscount(ORG_ID)).toNumber()).toBe(0.25);
    expect((await resolveUsageDiscount(ORG_ID)).toNumber()).toBe(0.25);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("FAILS LOUD (throws) when billing 500s — never silently writes gross-as-net", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    vi.stubGlobal("fetch", mockFetch);

    const promise = resolveUsageDiscount(ORG_ID);
    const assertion = expect(promise).rejects.toBeInstanceOf(UsageDiscountError);
    // 500 is not in the retryable set → throws immediately, no backoff needed.
    await assertion;
  });

  it("retries a transient 502 then throws after max retries", async () => {
    vi.useFakeTimers();
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(502, {}));
    vi.stubGlobal("fetch", mockFetch);

    const promise = resolveUsageDiscount(ORG_ID);
    const assertion = expect(promise).rejects.toBeInstanceOf(UsageDiscountError);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("FAILS LOUD when billing returns a malformed (missing) discount_pct", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { something_else: 1 }));
    vi.stubGlobal("fetch", mockFetch);

    await expect(resolveUsageDiscount(ORG_ID)).rejects.toBeInstanceOf(UsageDiscountError);
  });

  it("FAILS LOUD when discount_pct is out of the [0,1] range", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { discount_pct: "1.5" }));
    vi.stubGlobal("fetch", mockFetch);

    await expect(resolveUsageDiscount(ORG_ID)).rejects.toBeInstanceOf(UsageDiscountError);
  });

  it("FAILS LOUD when BILLING_SERVICE_URL is missing", async () => {
    delete process.env.BILLING_SERVICE_URL;
    await expect(resolveUsageDiscount(ORG_ID)).rejects.toBeInstanceOf(UsageDiscountError);
  });
});
