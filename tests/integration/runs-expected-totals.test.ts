import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";

// File-local org ids keep this file isolated from other integration files running in parallel.
const ORG_ID = "55555555-5555-4555-a555-555555555555";
const OTHER_ORG_ID = "66666666-6666-4666-a666-666666666666";
const ORG_IDS = [ORG_ID, OTHER_ORG_ID];

describe("GET /internal/runs-expected-totals", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();

  beforeEach(async () => {
    await cleanTestData(ORG_IDS);
  });

  afterAll(async () => {
    await cleanTestData(ORG_IDS);
    await closeDb();
  });

  it("returns 401 without API key", async () => {
    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .query({ org_id: ORG_ID });
    expect(res.status).toBe(401);
  });

  it("returns 400 when org_id missing", async () => {
    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers);
    expect(res.status).toBe(400);
  });

  it("returns 400 when org_id is not a UUID", async () => {
    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: "not-a-uuid" });
    expect(res.status).toBe(400);
  });

  it("returns empty payload for org with no runs", async () => {
    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_expected_cents: "0", net_total_expected_cents: "0", runs: [] });
  });

  it("sums platform actual costs for completed/failed runs and returns exact decimal", async () => {
    const run1 = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-1",
      status: "completed",
    });
    await insertTestRunCost({
      runId: run1.id,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: "0.5000000000",
      totalCostInUsdCents: "0.5000000000",
    });

    const run2 = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-2",
      status: "failed",
    });
    await insertTestRunCost({
      runId: run2.id,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: "1.2500000000",
      totalCostInUsdCents: "1.2500000000",
    });

    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    const map = new Map<string, string>(
      res.body.runs.map((r: { run_id: string; expected_cents: string }) => [r.run_id, r.expected_cents])
    );
    expect(map.get(run1.id)).toBe("0.5000000000");
    expect(map.get(run2.id)).toBe("1.2500000000");
    expect(res.body.total_expected_cents).toBe("1.7500000000");
    // AC2 — no discount on these rows → net == gross.
    expect(res.body.net_total_expected_cents).toBe("1.7500000000");
  });

  it("sums multiple cost rows per run", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-multi",
      status: "completed",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens-in",
      quantity: "1",
      unitCostInUsdCents: "0.1000000000",
      totalCostInUsdCents: "0.1000000000",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens-out",
      quantity: "1",
      unitCostInUsdCents: "0.2000000000",
      totalCostInUsdCents: "0.2000000000",
    });

    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].run_id).toBe(run.id);
    expect(res.body.runs[0].expected_cents).toBe("0.3000000000");
    expect(res.body.total_expected_cents).toBe("0.3000000000");
  });

  it("excludes BYOK rows (cost_source='org')", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-byok",
      status: "completed",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens",
      costSource: "org",
      quantity: "1",
      unitCostInUsdCents: "10.0000000000",
      totalCostInUsdCents: "10.0000000000",
    });

    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_expected_cents: "0", net_total_expected_cents: "0", runs: [] });
  });

  it("excludes provisioned and cancelled cost rows (only 'actual' counts)", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-prov",
      status: "completed",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens",
      status: "provisioned",
      quantity: "1",
      unitCostInUsdCents: "5.0000000000",
      totalCostInUsdCents: "5.0000000000",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens",
      status: "cancelled",
      quantity: "1",
      unitCostInUsdCents: "3.0000000000",
      totalCostInUsdCents: "3.0000000000",
    });

    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_expected_cents: "0", net_total_expected_cents: "0", runs: [] });
  });

  it("excludes non-terminal runs (running/pending)", async () => {
    const runningRun = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-running",
      status: "running",
    });
    await insertTestRunCost({
      runId: runningRun.id,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: "2.0000000000",
      totalCostInUsdCents: "2.0000000000",
    });

    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_expected_cents: "0", net_total_expected_cents: "0", runs: [] });
  });

  it("excludes runs with SUM = 0 (free runs)", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-free",
      status: "completed",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens",
      quantity: "0",
      unitCostInUsdCents: "1.0000000000",
      totalCostInUsdCents: "0.0000000000",
    });

    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_expected_cents: "0", net_total_expected_cents: "0", runs: [] });
  });

  it("preserves fractional precision exactly (no rounding)", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-frac",
      status: "completed",
    });
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: "1.2345678901",
      totalCostInUsdCents: "1.2345678901",
    });

    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].expected_cents).toBe("1.2345678901");
    expect(res.body.total_expected_cents).toBe("1.2345678901");
    expect(res.body.net_total_expected_cents).toBe("1.2345678901");
  });

  it("net total == gross for an org with only pre-discount rows (AC2)", async () => {
    const run = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-nodisc",
      status: "completed",
    });
    // netCostInUsdCents omitted → column NULL → reader COALESCEs to gross.
    await insertTestRunCost({
      runId: run.id,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: "4.0000000000",
      totalCostInUsdCents: "4.0000000000",
    });

    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body.total_expected_cents).toBe("4.0000000000");
    expect(res.body.net_total_expected_cents).toBe("4.0000000000");
  });

  it("mid-history discount: net = gross_pre + net_post, strictly below gross (AC3)", async () => {
    // Pre-discount run — no frozen net (NULL) → contributes gross to both.
    const preRun = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-pre",
      status: "completed",
    });
    await insertTestRunCost({
      runId: preRun.id,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: "10.0000000000",
      totalCostInUsdCents: "10.0000000000",
    });

    // Post-discount run — 20% usage discount frozen at write → net = gross × 0.8.
    const postRun = await insertTestRun({
      organizationId: ORG_ID,
      serviceName: "svc-a",
      taskName: "task-post",
      status: "completed",
    });
    await insertTestRunCost({
      runId: postRun.id,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: "10.0000000000",
      totalCostInUsdCents: "10.0000000000",
      netCostInUsdCents: "8.0000000000",
      usageDiscountPct: "0.20000000",
    });

    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    // gross = 10 + 10 = 20; net = 10 (pre, net==gross) + 8 (post) = 18.
    expect(res.body.total_expected_cents).toBe("20.0000000000");
    expect(res.body.net_total_expected_cents).toBe("18.0000000000");
    // Strictly below gross by exactly the discounted portion ($2).
    expect(
      Number(res.body.net_total_expected_cents) < Number(res.body.total_expected_cents)
    ).toBe(true);
  });

  it("excludes runs from other organizations", async () => {
    const otherRun = await insertTestRun({
      organizationId: OTHER_ORG_ID,
      serviceName: "svc-a",
      taskName: "task-other",
      status: "completed",
    });
    await insertTestRunCost({
      runId: otherRun.id,
      costName: "tokens",
      quantity: "1",
      unitCostInUsdCents: "9.9999999999",
      totalCostInUsdCents: "9.9999999999",
    });

    const res = await request(app)
      .get("/internal/runs-expected-totals")
      .set(headers)
      .query({ org_id: ORG_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_expected_cents: "0", net_total_expected_cents: "0", runs: [] });
  });
});
