import { describe, it, expect } from "vitest";
import { reachesOf, AllocationInputsError } from "../../src/services/lead-states.js";
import { TEST_STEP_STATES } from "../helpers/lead-states.js";

// OUR-FACTORY-OUTCOMES-1027: lead-service's whose-win answer rides every reach; a reach served without it
// (an older lead-service) fails loud instead of reading as "not ours" (which would zero every unit cost).
describe("reachesOf: whose win", () => {
  const row = (state: Record<string, unknown>) => [{ orgId: "o", brandId: "b", leadId: "L", states: { lead_interested: state as any } }];

  it("keeps lead-service's answer and reason as served (true, false, null)", () => {
    for (const v of [true, false, null]) {
      const [r] = reachesOf(row({ reachedAt: "2026-10-01T00:00:00Z", causedByOutreach: v, causeReason: "x" }), TEST_STEP_STATES);
      expect(r.causedByOutreach).toBe(v);
      expect(r.causeReason).toBe("x");
    }
  });

  it("refuses a reach served without causedByOutreach", () => {
    expect(() => reachesOf(row({ reachedAt: "2026-10-01T00:00:00Z" }), TEST_STEP_STATES)).toThrow(AllocationInputsError);
  });
});
