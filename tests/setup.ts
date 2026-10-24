import { beforeAll, afterAll } from "vitest";

process.env.RUNS_SERVICE_DATABASE_URL =
  process.env.RUNS_SERVICE_DATABASE_URL || "postgresql://test:test@localhost/test";
process.env.RUNS_SERVICE_API_KEY = "test-api-key";
process.env.COSTS_SERVICE_URL = "http://localhost:9999";
process.env.COSTS_SERVICE_API_KEY = "test-costs-key";
process.env.BILLING_SERVICE_URL = "http://localhost:9998";
process.env.BILLING_SERVICE_API_KEY = "test-billing-key";
process.env.NODE_ENV = "test";

// Allocation v5 inputs (features-service catalogue): the served step -> lead state
// map and NO pipe targets, so a test that does not set its own reads exactly as v4.
beforeAll(async () => {
  const { setAllocationInputsForTests, setLeadStatesSourceForTests, TEST_STEP_STATES } = await import("./helpers/lead-states.js");
  setAllocationInputsForTests({ stepStates: TEST_STEP_STATES, pipeTargets: [] });
  setLeadStatesSourceForTests([]);
  console.log("Test suite starting...");
});
afterAll(() => console.log("Test suite complete."));
