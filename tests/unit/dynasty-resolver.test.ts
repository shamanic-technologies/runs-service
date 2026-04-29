import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  resolveWorkflowDynastySlugs,
  resolveFeatureDynastySlugs,
  fetchAllWorkflowDynasties,
  fetchAllFeatureDynasties,
  buildSlugToDynastyMap,
  type IdentityHeaders,
} from "../../src/services/dynasty-resolver.js";

const originalEnv = { ...process.env };
const testIdentity: IdentityHeaders = {
  orgId: "00000000-0000-0000-0000-000000000001",
  userId: "00000000-0000-0000-0000-000000000002",
  runId: "00000000-0000-0000-0000-000000000003",
};

beforeEach(() => {
  process.env.WORKFLOW_SERVICE_URL = "https://workflow.test";
  process.env.WORKFLOW_SERVICE_API_KEY = "wf-key";
  process.env.FEATURES_SERVICE_URL = "https://features.test";
  process.env.FEATURES_SERVICE_API_KEY = "feat-key";
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
});

describe("resolveWorkflowDynastySlugs", () => {
  it("returns slugs from workflow-service", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ workflows: [
        { workflowSlug: "cold-email", workflowDynastySlug: "cold-email" },
        { workflowSlug: "cold-email-v2", workflowDynastySlug: "cold-email" },
        { workflowSlug: "cold-email-v3", workflowDynastySlug: "cold-email" },
      ] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const slugs = await resolveWorkflowDynastySlugs("cold-email", testIdentity);
    expect(slugs).toEqual(["cold-email", "cold-email-v2", "cold-email-v3"]);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe(
      "https://workflow.test/workflows?workflowDynastySlug=cold-email&status=all"
    );
    const headers = fetchCall[1]?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("wf-key");
    expect(headers["x-org-id"]).toBe(testIdentity.orgId);
    expect(headers["x-user-id"]).toBe(testIdentity.userId);
    expect(headers["x-run-id"]).toBe(testIdentity.runId);
  });

  it("returns empty array when dynasty has no versions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ workflows: [] }), { status: 200, headers: { "Content-Type": "application/json" } })
    );

    const slugs = await resolveWorkflowDynastySlugs("nonexistent", testIdentity);
    expect(slugs).toEqual([]);
  });

  it("throws when WORKFLOW_SERVICE_URL is not set", async () => {
    delete process.env.WORKFLOW_SERVICE_URL;
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Not Found", { status: 404 })
    );

    process.env.WORKFLOW_SERVICE_URL = "https://workflow.test";
    await expect(
      resolveWorkflowDynastySlugs("bad", testIdentity).catch(() => {
        throw new Error("upstream error");
      })
    ).rejects.toThrow();
  });

  it("throws on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 })
    );

    await expect(resolveWorkflowDynastySlugs("test", testIdentity)).rejects.toThrow(
      /Dynasty resolution failed: 500/
    );
  });
});

describe("resolveFeatureDynastySlugs", () => {
  it("returns slugs from features-service", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ slugs: ["feat-a", "feat-a-v2"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const slugs = await resolveFeatureDynastySlugs("feat-a", testIdentity);
    expect(slugs).toEqual(["feat-a", "feat-a-v2"]);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe(
      "https://features.test/features/dynasty/slugs?dynastySlug=feat-a"
    );
    const headers = fetchCall[1]?.headers as Record<string, string>;
    expect(headers["x-org-id"]).toBe(testIdentity.orgId);
  });
});

describe("fetchAllWorkflowDynasties", () => {
  it("returns all dynasties grouped from workflow list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ workflows: [
        { workflowSlug: "cold-email", workflowDynastySlug: "cold-email" },
        { workflowSlug: "cold-email-v2", workflowDynastySlug: "cold-email" },
        { workflowSlug: "warm-intro", workflowDynastySlug: "warm-intro" },
      ] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await fetchAllWorkflowDynasties(testIdentity);
    expect(result).toEqual([
      { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
      { dynastySlug: "warm-intro", slugs: ["warm-intro"] },
    ]);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe("https://workflow.test/workflows?status=all");
  });
});

describe("fetchAllFeatureDynasties", () => {
  it("returns all dynasties", async () => {
    const dynasties = [
      { dynastySlug: "feat-alpha", slugs: ["feat-alpha", "feat-alpha-v2"] },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ dynasties }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const result = await fetchAllFeatureDynasties(testIdentity);
    expect(result).toEqual(dynasties);
  });
});

describe("buildSlugToDynastyMap", () => {
  it("builds correct reverse map", () => {
    const dynasties = [
      { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2", "cold-email-v3"] },
      { dynastySlug: "warm-intro", slugs: ["warm-intro", "warm-intro-v2"] },
    ];

    const map = buildSlugToDynastyMap(dynasties);
    expect(map.get("cold-email")).toBe("cold-email");
    expect(map.get("cold-email-v2")).toBe("cold-email");
    expect(map.get("cold-email-v3")).toBe("cold-email");
    expect(map.get("warm-intro")).toBe("warm-intro");
    expect(map.get("warm-intro-v2")).toBe("warm-intro");
    expect(map.get("nonexistent")).toBeUndefined();
  });

  it("handles empty dynasties", () => {
    const map = buildSlugToDynastyMap([]);
    expect(map.size).toBe(0);
  });
});
