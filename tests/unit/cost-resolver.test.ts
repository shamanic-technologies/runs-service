import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveUnitCost, resolveMultipleUnitCosts, CostNotFoundError } from "../../src/services/cost-resolver.js";

describe("cost-resolver", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolveUnitCost", () => {
    it("resolves a cost unit from costs-service", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              name: "gpt-4o-input-token",
              costPerUnitInUsdCents: "0.0003000000",
            }),
        })
      );

      const result = await resolveUnitCost("gpt-4o-input-token");
      expect(result.name).toBe("gpt-4o-input-token");
      expect(result.costPerUnitInUsdCents).toBe("0.0003000000");
    });

    it("throws CostNotFoundError on 404", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        })
      );

      await expect(resolveUnitCost("unknown")).rejects.toThrow(CostNotFoundError);
    });

    it("throws on non-ok response", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
        })
      );

      await expect(resolveUnitCost("test")).rejects.toThrow(
        "costs-service returned 500"
      );
    });

    it("sends API key header when configured", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            name: "test",
            costPerUnitInUsdCents: "0.01",
          }),
      });
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
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              name,
              costPerUnitInUsdCents: "0.0001000000",
            }),
        });
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await resolveMultipleUnitCosts([
        "cost-a",
        "cost-b",
        "cost-a",
      ]);

      expect(result.size).toBe(2);
      expect(result.get("cost-a")).toBe("0.0001000000");
      expect(result.get("cost-b")).toBe("0.0001000000");
      // Should only fetch 2 unique names, not 3
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("propagates CostNotFoundError", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 404,
        })
      );

      await expect(
        resolveMultipleUnitCosts(["missing"])
      ).rejects.toThrow(CostNotFoundError);
    });
  });
});
