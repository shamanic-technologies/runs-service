import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  fetchVendorCostCatalog,
  resetVendorCostCache,
  VendorCostCatalogError,
} from "../../src/services/vendor-costs.js";

// The payload shape costs-service serves on GET /internal/vendor-costs.
const VERSION = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "anthropic-haiku-4.5-tokens-input",
  provider: "anthropic",
  planTier: "pay-as-you-go",
  billingCycle: "monthly",
  unit: "1M tokens",
  pricingBasis: "marked-up",
  pricingRegime: null,
  billedPricePerUnitInUsdCents: "0.0005000000",
  vendorCostPerUnitInUsdCents: "0.0001000000",
  vendorCostKnown: true,
  vendorCostUnknownReason: null,
  markupMultiplier: "5.0000",
  vendorCostDerivation: "seed-literal",
  effectiveFrom: "2026-09-15T08:47:00.000Z",
  createdAt: "2026-09-15T09:02:11.000Z",
};

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe("fetchVendorCostCatalog", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => resetVendorCostCache());
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads the service-auth catalogue and serves a version from the later of effectiveFrom/createdAt", async () => {
    const f = mockFetch(200, {
      versions: [
        VERSION,
        { ...VERSION, name: "x", vendorCostPerUnitInUsdCents: null, vendorCostKnown: false, vendorCostUnknownReason: "no-evidence" },
        { ...VERSION, name: "delisted", billedPricePerUnitInUsdCents: null, vendorCostPerUnitInUsdCents: null, vendorCostKnown: false },
      ],
    });
    globalThis.fetch = f as any;

    const versions = await fetchVendorCostCatalog();
    expect(f).toHaveBeenCalledWith("http://localhost:9999/internal/vendor-costs", expect.objectContaining({
      headers: { "x-api-key": "test-costs-key" },
    }));
    expect(versions).toEqual([
      { costName: VERSION.name, provider: "anthropic", servedFrom: "2026-09-15T09:02:11.000Z", billedUnitCostInUsdCents: "0.0005000000", vendorUnitCostInUsdCents: "0.0001000000" },
      { costName: "x", provider: "anthropic", servedFrom: "2026-09-15T09:02:11.000Z", billedUnitCostInUsdCents: "0.0005000000", vendorUnitCostInUsdCents: null },
      { costName: "delisted", provider: "anthropic", servedFrom: "2026-09-15T09:02:11.000Z", billedUnitCostInUsdCents: null, vendorUnitCostInUsdCents: null },
    ]);

    // cached: a second read does not refetch
    await fetchVendorCostCatalog();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("fails loud on a non-OK answer", async () => {
    globalThis.fetch = mockFetch(503, { error: "down" }) as any;
    await expect(fetchVendorCostCatalog()).rejects.toBeInstanceOf(VendorCostCatalogError);
  });

  it("fails loud on a malformed version rather than treating it as unpriced", async () => {
    globalThis.fetch = mockFetch(200, { versions: [{ ...VERSION, vendorCostPerUnitInUsdCents: "abc" }] }) as any;
    await expect(fetchVendorCostCatalog()).rejects.toThrow(/vendorCostPerUnitInUsdCents/);
    resetVendorCostCache();
    globalThis.fetch = mockFetch(200, { versions: [{ ...VERSION, vendorCostPerUnitInUsdCents: null }] }) as any;
    await expect(fetchVendorCostCatalog()).rejects.toThrow(/known but carries no vendor cost/);
    resetVendorCostCache();
    globalThis.fetch = mockFetch(200, { nope: [] }) as any;
    await expect(fetchVendorCostCatalog()).rejects.toThrow(/no versions array/);
  });
});
