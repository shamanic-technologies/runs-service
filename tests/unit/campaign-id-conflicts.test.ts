import { describe, it, expect } from "vitest";
import { campaignIdConflicts } from "../../src/services/feature-slug.js";

// SOURCE CAMPAIGNS: a sourcing serve under an outreach run is filed under its own
// source campaign; every other campaign mismatch stays a conflict.
describe("campaignIdConflicts", () => {
  const base = { childCampaignId: "src", parentCampaignId: "outreach" };
  it("a sourcing child under a non-sourcing parent may carry its own campaign", () => {
    expect(campaignIdConflicts({ ...base, childFeatureSlug: "sourcing-apollo-cold-filters", parentFeatureSlug: "sales-cold-email-outreach" })).toBe(false);
  });
  // Prod 2026-10-08: workflow-service opens many execute-workflow runs with NO
  // feature slug; a lead-serve under one carried its source campaign and got 409.
  it("a sourcing child under a parent with NO feature slug may carry its own campaign", () => {
    expect(campaignIdConflicts({ ...base, childFeatureSlug: "sourcing-apollo-cold-filters", parentFeatureSlug: null })).toBe(false);
  });
  it("the same campaign never conflicts", () => {
    expect(campaignIdConflicts({ childCampaignId: "a", parentCampaignId: "a", childFeatureSlug: null, parentFeatureSlug: null })).toBe(false);
  });
  it("every other mismatch conflicts", () => {
    const cases: Array<[string | null, string | null]> = [
      [null, "sales-cold-email-outreach"],
      ["sales-cold-email-outreach", "sales-cold-email-outreach"],
      ["sourcing-apollo-cold-filters", "sourcing-apollo-cold-filters"],
      ["sales-cold-email-outreach", "sourcing-apollo-cold-filters"],
      [null, null],
      ["sales-cold-email-outreach", null],
    ];
    for (const [child, parent] of cases) {
      expect(campaignIdConflicts({ ...base, childFeatureSlug: child, parentFeatureSlug: parent }), `${child} under ${parent}`).toBe(true);
    }
  });
});
