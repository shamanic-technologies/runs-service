import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutcomeCatalogueError, resetOutcomeCatalogueCache, unknownOutcomeKeys } from "../../src/services/outcome-catalogue.js";

const ok = (keys: string[]) => new Response(JSON.stringify({ object: "step", rows: keys.map((key) => ({ key })) }), { status: 200 });

describe("unknownOutcomeKeys (features-service step catalogue)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    resetOutcomeCatalogueCache();
    process.env.FEATURES_SERVICE_URL = "http://features.test";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads rows[].key and names the keys it does not hold", async () => {
    fetchMock.mockResolvedValue(ok(["conversation", "email_found"]));
    expect(await unknownOutcomeKeys(["conversation", "positive_reply"])).toEqual(["positive_reply"]);
    expect(fetchMock.mock.calls[0][0]).toBe("http://features.test/public/catalogue/steps");
  });

  it("caches, and re-reads once on a miss past 30 s (a key declared since is accepted)", async () => {
    fetchMock.mockResolvedValueOnce(ok(["conversation"])).mockResolvedValueOnce(ok(["conversation", "email_checked"]));
    expect(await unknownOutcomeKeys(["conversation"])).toEqual([]);
    expect(await unknownOutcomeKeys(["email_checked"])).toEqual(["email_checked"]); // < 30 s: no re-read
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31_000);
    expect(await unknownOutcomeKeys(["email_checked"])).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails loud when the catalogue is unreadable, never accepts blindly", async () => {
    fetchMock.mockResolvedValue(new Response("down", { status: 503 }));
    await expect(unknownOutcomeKeys(["conversation"])).rejects.toBeInstanceOf(OutcomeCatalogueError);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ rows: [] }), { status: 200 }));
    await expect(unknownOutcomeKeys(["conversation"])).rejects.toBeInstanceOf(OutcomeCatalogueError);
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(unknownOutcomeKeys(["conversation"])).rejects.toBeInstanceOf(OutcomeCatalogueError);
  });
});
