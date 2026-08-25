import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { runsCosts, costLifecycleEvents } from "../../src/db/schema.js";
import {
  createTestApp,
  getAuthHeaders,
  getInternalAuthHeaders,
} from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";

// A refund says: this spend really happened, and we are not charging for it.
//
// The whole point of the state is that it splits two questions that `actual` and
// `cancelled` cannot:
//   ACCOUNTING  — what does this customer owe / what were they charged?  → stops counting it
//   PERFORMANCE — what did this workflow cost to produce an outcome?     → keeps counting it
//
// So every assertion below that checks a total DROPPED is paired with one that
// checks the spend is STILL VISIBLE. A test that only checked the drop would pass
// on a design that erased the spend from the performance view too — which is
// exactly the bug this state exists to avoid.

const ORG_ID = "5efa0000-1111-4aaa-8aaa-111111111111";
const OTHER_ORG_ID = "5efa0000-2222-4aaa-8aaa-222222222222";
const CLEANUP_ORG_IDS = [ORG_ID, OTHER_ORG_ID];

vi.mock("../../src/services/billing.js", () => ({
  notifyUsage: vi.fn().mockResolvedValue(undefined),
  fetchOrgPlatformSpent: vi.fn().mockResolvedValue(0),
}));

const app = createTestApp();
const authHeaders = getAuthHeaders({ orgId: ORG_ID });
const internalHeaders = getInternalAuthHeaders();

const REASON = "zai-glm-5.3 provider incident 2026-08-25 — spend comped";
const ACTOR = "kevin@distribute.you";

async function statusOf(costId: string) {
  const [row] = await db.select().from(runsCosts).where(eq(runsCosts.id, costId)).limit(1);
  return row?.status;
}

async function orgUsage() {
  const res = await request(app)
    .get("/internal/org-usage-total")
    .set(internalHeaders)
    .query({ org_id: ORG_ID });
  return res.body as { spent_cents: string; net_spent_cents: string };
}

async function costGroups() {
  const res = await request(app)
    .get("/v1/stats/costs")
    .set(authHeaders)
    .query({ groupBy: "serviceName" });
  expect(res.status).toBe(200);
  return res.body.groups[0];
}

describe("refunded cost status", () => {
  beforeEach(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
    await closeDb();
  });

  // -------------------------------------------------------------------------
  // State machine — allowed and refused transitions, idempotency
  // -------------------------------------------------------------------------
  describe("PATCH /v1/runs/:id/costs/:costId — state machine", () => {
    it("refunds a charged cost", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "chat-service", taskName: "complete" });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "zai-glm-5.3-input-tokens",
        quantity: "100",
        unitCostInUsdCents: "0.0100000000",
        totalCostInUsdCents: "1.0000000000",
        status: "actual",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "refunded", reason: REASON, refundedBy: ACTOR });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("refunded");
      expect(await statusOf(cost.id)).toBe("refunded");
      // The amount itself is untouched — a refund does not rewrite what was spent.
      expect(res.body.totalCostInUsdCents).toBe("1.0000000000");
    });

    it("refuses to refund a provisioned cost — it was never charged", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task" });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "held",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "provisioned",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "refunded", reason: REASON, refundedBy: ACTOR });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/provisioned/);
      expect(await statusOf(cost.id)).toBe("provisioned");
    });

    it("refuses to refund a cancelled cost", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task" });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "void",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "cancelled",
      });

      const res = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "refunded", reason: REASON, refundedBy: ACTOR });

      expect(res.status).toBe(409);
      expect(await statusOf(cost.id)).toBe("cancelled");
    });

    it("is a no-op on a second refund — no duplicate event, no second amount move", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task" });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1",
        unitCostInUsdCents: "2.0000000000",
        totalCostInUsdCents: "2.0000000000",
        status: "actual",
      });

      const first = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "refunded", reason: REASON, refundedBy: ACTOR });
      const second = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "refunded", reason: "second attempt", refundedBy: ACTOR });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.status).toBe("refunded");
      expect(second.body.totalCostInUsdCents).toBe("2.0000000000");

      const events = await db
        .select()
        .from(costLifecycleEvents)
        .where(and(eq(costLifecycleEvents.costId, cost.id), eq(costLifecycleEvents.eventType, "cost.refunded")));
      expect(events).toHaveLength(1);

      // And the money moved exactly once.
      const usage = await orgUsage();
      expect(usage.spent_cents).toBe("0.0000000000");
    });

    it("rejects a refund with no reason or actor", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task" });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "actual",
      });

      const noReason = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "refunded", refundedBy: ACTOR });
      const noActor = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "refunded", reason: REASON });

      expect(noReason.status).toBe(400);
      expect(noActor.status).toBe(400);
      expect(await statusOf(cost.id)).toBe("actual");
    });

    it("records why and by whom in the bronze audit trail", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task" });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "actual",
      });

      await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "refunded", reason: REASON, refundedBy: ACTOR });

      const [event] = await db
        .select()
        .from(costLifecycleEvents)
        .where(and(eq(costLifecycleEvents.costId, cost.id), eq(costLifecycleEvents.eventType, "cost.refunded")));

      expect(event).toBeDefined();
      expect(event.payload).toMatchObject({ from: "actual", to: "refunded", reason: REASON, refundedBy: ACTOR });
    });

    it("leaves the run's own status alone — a refund is a fact about a cost row", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task", status: "completed" });
      const cost = await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "actual",
      });

      await request(app)
        .patch(`/v1/runs/${run.id}/costs/${cost.id}`)
        .set(authHeaders)
        .send({ status: "refunded", reason: REASON, refundedBy: ACTOR });

      const res = await request(app).get(`/v1/runs/${run.id}`).set(authHeaders);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("completed");
    });

    it("still supports the pre-existing actual / cancelled transitions", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task" });
      const held = await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "provisioned",
      });
      const held2 = await insertTestRunCost({
        runId: run.id,
        costName: "token",
        quantity: "1",
        unitCostInUsdCents: "1.0000000000",
        totalCostInUsdCents: "1.0000000000",
        status: "provisioned",
      });

      const materialize = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${held.id}`)
        .set(authHeaders)
        .send({ status: "actual" });
      const cancel = await request(app)
        .patch(`/v1/runs/${run.id}/costs/${held2.id}`)
        .set(authHeaders)
        .send({ status: "cancelled" });

      expect(materialize.status).toBe(200);
      expect(await statusOf(held.id)).toBe("actual");
      expect(cancel.status).toBe(200);
      expect(await statusOf(held2.id)).toBe("cancelled");
    });

    it("refuses to CREATE a cost that is already refunded", async () => {
      const run = await insertTestRun({ organizationId: ORG_ID, serviceName: "svc", taskName: "task" });
      const res = await request(app)
        .post(`/v1/runs/${run.id}/costs`)
        .set(authHeaders)
        .send({ items: [{ costName: "token", costSource: "platform", quantity: 1, status: "refunded" }] });

      expect(res.status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Accounting vs performance across every aggregation this service exposes
  // -------------------------------------------------------------------------
  describe("accounting drops it, performance keeps it", () => {
    // 4.00 charged, of which 1.50 gets refunded. Net is frozen at half (a 50%
    // usage discount), so the accounting drop must be 1.50 gross / 0.75 net.
    async function seed() {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "chat-service",
        taskName: "complete",
        campaignId: "campaign-refund",
        featureSlug: "email-generation",
      });
      const keep = await insertTestRunCost({
        runId: run.id,
        costName: "zai-glm-5.3-input-tokens",
        quantity: "1",
        unitCostInUsdCents: "2.5000000000",
        totalCostInUsdCents: "2.5000000000",
        netCostInUsdCents: "1.2500000000",
        usageDiscountPct: "0.50000000",
        status: "actual",
      });
      const comped = await insertTestRunCost({
        runId: run.id,
        costName: "zai-glm-5.3-output-tokens",
        quantity: "1",
        unitCostInUsdCents: "1.5000000000",
        totalCostInUsdCents: "1.5000000000",
        netCostInUsdCents: "0.7500000000",
        usageDiscountPct: "0.50000000",
        status: "actual",
      });
      return { run, keep, comped };
    }

    async function refund(runId: string, costId: string) {
      const res = await request(app)
        .patch(`/v1/runs/${runId}/costs/${costId}`)
        .set(authHeaders)
        .send({ status: "refunded", reason: REASON, refundedBy: ACTOR });
      expect(res.status).toBe(200);
    }

    it("GET /internal/org-usage-total — the org stops owing it, with no credit anywhere", async () => {
      const { run, comped } = await seed();

      const before = await orgUsage();
      expect(before.spent_cents).toBe("4.0000000000");
      expect(before.net_spent_cents).toBe("2.0000000000");

      await refund(run.id, comped.id);

      const after = await orgUsage();
      // Gross drops by exactly the refunded gross; net by exactly the refunded net —
      // which is what the org's spendable balance rises by, since billing derives the
      // balance from this read alone.
      expect(after.spent_cents).toBe("2.5000000000");
      expect(after.net_spent_cents).toBe("1.2500000000");
    });

    it("GET /internal/runs-expected-totals — the refunded row stops being a committed charge", async () => {
      const { run, comped } = await seed();
      await request(app).patch(`/v1/runs/${run.id}`).set(authHeaders).send({ status: "completed" });

      const before = await request(app)
        .get("/internal/runs-expected-totals")
        .set(internalHeaders)
        .query({ org_id: ORG_ID });
      expect(before.body.total_expected_cents).toBe("4.0000000000");

      await refund(run.id, comped.id);

      const after = await request(app)
        .get("/internal/runs-expected-totals")
        .set(internalHeaders)
        .query({ org_id: ORG_ID });
      expect(after.body.total_expected_cents).toBe("2.5000000000");
      expect(after.body.net_total_expected_cents).toBe("1.2500000000");
    });

    it("GET /v1/stats/costs — drops out of the charged totals, surfaces in `refunded`", async () => {
      const { run, comped } = await seed();

      const before = await costGroups();
      expect(before.totalCostInUsdCents).toBe("4.0000000000");
      expect(before.actualCostInUsdCents).toBe("4.0000000000");
      expect(before.refundedCostInUsdCents).toBe("0.0000000000");
      expect(before.netRefundedCostInUsdCents).toBe("0.0000000000");

      await refund(run.id, comped.id);

      const after = await costGroups();
      // ACCOUNTING: what the customer owes is down by the comped amount.
      expect(after.totalCostInUsdCents).toBe("2.5000000000");
      expect(after.actualCostInUsdCents).toBe("2.5000000000");
      expect(after.netActualCostInUsdCents).toBe("1.2500000000");
      // PERFORMANCE: the money is still there, in its own column.
      expect(after.refundedCostInUsdCents).toBe("1.5000000000");
      expect(after.netRefundedCostInUsdCents).toBe("0.7500000000");
      // Real spend reconstructs exactly: actual + refunded == what was charged before.
      const realSpend =
        Number(after.actualCostInUsdCents) + Number(after.refundedCostInUsdCents);
      expect(realSpend).toBeCloseTo(Number(before.actualCostInUsdCents), 10);
      // And the run is still counted — the outcome it produced did not disappear.
      expect(after.runCount).toBe(before.runCount);
      // A refund is not a cancel: the cancelled column never moves.
      expect(after.cancelledCostInUsdCents).toBe("0.0000000000");
    });

    it("POST /v1/stats/costs (by service/task) — same split per bucket", async () => {
      const { run, comped } = await seed();
      await refund(run.id, comped.id);

      const res = await request(app)
        .post("/v1/stats/costs")
        .set(authHeaders)
        .send({ groupBy: "featureSlug", serviceTasks: [{ serviceName: "chat-service", taskName: "complete" }] });

      expect(res.status).toBe(200);
      const group = res.body.buckets[0].groups[0];
      expect(group.actualCostInUsdCents).toBe("2.5000000000");
      expect(group.refundedCostInUsdCents).toBe("1.5000000000");
      expect(group.netRefundedCostInUsdCents).toBe("0.7500000000");
    });

    it("GET /v1/stats/public/costs — both the split (runs-side) and the costName path expose it", async () => {
      const { run, comped } = await seed();
      await refund(run.id, comped.id);

      const byCampaign = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "campaignId", orgId: ORG_ID });
      expect(byCampaign.status).toBe(200);
      const campaignGroup = byCampaign.body.groups.find(
        (g: any) => g.dimensions.campaignId === "campaign-refund"
      );
      expect(campaignGroup.actualCostInUsdCents).toBe("2.5000000000");
      expect(campaignGroup.refundedCostInUsdCents).toBe("1.5000000000");
      expect(campaignGroup.netRefundedCostInUsdCents).toBe("0.7500000000");

      const byCostName = await request(app)
        .get("/v1/stats/public/costs")
        .query({ groupBy: "costName", orgId: ORG_ID });
      expect(byCostName.status).toBe(200);
      const refundedRow = byCostName.body.groups.find(
        (g: any) => g.dimensions.costName === "zai-glm-5.3-output-tokens"
      );
      expect(refundedRow.actualCostInUsdCents).toBe("0.0000000000");
      expect(refundedRow.refundedCostInUsdCents).toBe("1.5000000000");
    });

    it("GET /v1/stats/public/costs/timeseries — same split per bucket", async () => {
      const { run, comped } = await seed();
      await refund(run.id, comped.id);

      const res = await request(app)
        .get("/v1/stats/public/costs/timeseries")
        .query({ interval: "day", orgId: ORG_ID });

      expect(res.status).toBe(200);
      const bucket = res.body.buckets[0];
      expect(bucket.actualCostInUsdCents).toBe("2.5000000000");
      expect(bucket.refundedCostInUsdCents).toBe("1.5000000000");
      expect(bucket.netRefundedCostInUsdCents).toBe("0.7500000000");
    });

    it("POST /v1/stats/budget — a refunded cost is not budget spend", async () => {
      const { run, comped } = await seed();

      const body = { campaignId: "campaign-refund", windows: [{ label: "all-time" }] };
      const before = await request(app).post("/v1/stats/budget").set(authHeaders).send(body);
      expect(before.body.windows[0].actualCostInUsdCents).toBe("4.0000000000");

      await refund(run.id, comped.id);

      const after = await request(app).post("/v1/stats/budget").set(authHeaders).send(body);
      expect(after.body.windows[0].totalCostInUsdCents).toBe("2.5000000000");
      expect(after.body.windows[0].actualCostInUsdCents).toBe("2.5000000000");
      expect(after.body.windows[0].netActualCostInUsdCents).toBe("1.2500000000");
    });

    it("GET /v1/runs/:id — the run rollup shows only what is still charged", async () => {
      const { run, comped } = await seed();
      await refund(run.id, comped.id);

      const res = await request(app).get(`/v1/runs/${run.id}`).set(authHeaders);
      expect(res.status).toBe(200);
      expect(res.body.totalCostInUsdCents).toBe("2.5000000000");
      expect(res.body.actualCostInUsdCents).toBe("2.5000000000");
      // The refunded cost row itself is still listed — nothing is erased.
      expect(res.body.costs).toHaveLength(2);
      expect(res.body.costs.find((c: any) => c.id === comped.id).status).toBe("refunded");
    });

    it("POST /v1/runs/costs/batch — the billing rollup drops it too", async () => {
      const { run, comped } = await seed();
      await refund(run.id, comped.id);

      const res = await request(app)
        .post("/v1/runs/costs/batch")
        .set(authHeaders)
        .send({ runIds: [run.id] });

      expect(res.status).toBe(200);
      expect(res.body.costs[0].actualCostInUsdCents).toBe("2.5000000000");
      expect(res.body.costs[0].ownActualPlatformCostInUsdCents).toBe("2.5000000000");
    });

    it("changes NOTHING while nothing is refunded", async () => {
      await seed();

      const usage = await orgUsage();
      const group = await costGroups();

      expect(usage.spent_cents).toBe("4.0000000000");
      expect(usage.net_spent_cents).toBe("2.0000000000");
      expect(group.totalCostInUsdCents).toBe("4.0000000000");
      expect(group.actualCostInUsdCents).toBe("4.0000000000");
      expect(group.provisionedCostInUsdCents).toBe("0.0000000000");
      expect(group.cancelledCostInUsdCents).toBe("0.0000000000");
      // The new columns are present and zero — a gross-only consumer reads exactly
      // today's numbers.
      expect(group.refundedCostInUsdCents).toBe("0.0000000000");
      expect(group.netRefundedCostInUsdCents).toBe("0.0000000000");
    });
  });

  // -------------------------------------------------------------------------
  // Staff run-scoped action — preview, then apply
  // -------------------------------------------------------------------------
  describe("POST /internal/cost-refunds/{preview,apply}", () => {
    // The day-one shape: one org, one date, cost names starting with a prefix,
    // on chat-service/complete runs — plus decoys that must NOT be caught.
    async function seedFleet() {
      const parent = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "chat-service",
        taskName: "complete",
        startedAt: new Date("2026-08-25T10:00:00Z"),
      });
      const child = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "chat-service",
        taskName: "complete",
        parentRunId: parent.id,
        startedAt: new Date("2026-08-25T11:00:00Z"),
      });
      const targets = [
        await insertTestRunCost({
          runId: parent.id,
          costName: "zai-glm-5.3-input-tokens",
          quantity: "1",
          unitCostInUsdCents: "3.0000000000",
          totalCostInUsdCents: "3.0000000000",
          netCostInUsdCents: "1.5000000000",
          status: "actual",
        }),
        await insertTestRunCost({
          runId: child.id,
          costName: "zai-glm-5.3-output-tokens",
          quantity: "1",
          unitCostInUsdCents: "2.6300000000",
          totalCostInUsdCents: "2.6300000000",
          netCostInUsdCents: "1.3150000000",
          status: "actual",
        }),
      ];

      // Decoys.
      const provisioned = await insertTestRunCost({
        runId: parent.id,
        costName: "zai-glm-5.3-input-tokens",
        quantity: "1",
        unitCostInUsdCents: "9.0000000000",
        totalCostInUsdCents: "9.0000000000",
        status: "provisioned",
      });
      const byok = await insertTestRunCost({
        runId: parent.id,
        costName: "zai-glm-5.3-input-tokens",
        costSource: "org",
        quantity: "1",
        unitCostInUsdCents: "7.0000000000",
        totalCostInUsdCents: "7.0000000000",
        status: "actual",
      });
      const otherModel = await insertTestRunCost({
        runId: parent.id,
        costName: "gemini-3-input-tokens",
        quantity: "1",
        unitCostInUsdCents: "5.0000000000",
        totalCostInUsdCents: "5.0000000000",
        status: "actual",
      });
      const otherOrgRun = await insertTestRun({
        organizationId: OTHER_ORG_ID,
        serviceName: "chat-service",
        taskName: "complete",
        startedAt: new Date("2026-08-25T10:00:00Z"),
      });
      const otherOrgCost = await insertTestRunCost({
        runId: otherOrgRun.id,
        costName: "zai-glm-5.3-input-tokens",
        quantity: "1",
        unitCostInUsdCents: "4.0000000000",
        totalCostInUsdCents: "4.0000000000",
        status: "actual",
      });

      return { parent, child, targets, provisioned, byok, otherModel, otherOrgCost };
    }

    const dayOneFilter = {
      orgId: ORG_ID,
      costNamePrefix: "zai-glm-5.3",
      serviceName: "chat-service",
      taskName: "complete",
      startedAfter: "2026-08-25T00:00:00.000Z",
      startedBefore: "2026-08-26T00:00:00.000Z",
    };

    it("requires internal auth", async () => {
      const preview = await request(app).post("/internal/cost-refunds/preview").send(dayOneFilter);
      const apply = await request(app)
        .post("/internal/cost-refunds/apply")
        .send({ ...dayOneFilter, reason: REASON, refundedBy: ACTOR });
      expect(preview.status).toBe(401);
      expect(apply.status).toBe(401);
    });

    it("previews the exact set and total, and writes nothing", async () => {
      const { targets, provisioned, byok, otherModel, otherOrgCost } = await seedFleet();

      const res = await request(app)
        .post("/internal/cost-refunds/preview")
        .set(internalHeaders)
        .send(dayOneFilter);

      expect(res.status).toBe(200);
      expect(res.body.costCount).toBe(2);
      expect(res.body.runCount).toBe(2);
      expect(res.body.grossTotalInUsdCents).toBe("5.6300000000");
      expect(res.body.netTotalInUsdCents).toBe("2.8150000000");
      expect(res.body.costsTruncated).toBe(false);
      expect(res.body.costs.map((c: any) => c.id).sort()).toEqual(targets.map((t) => t.id).sort());

      // Nothing was written — every row keeps the status it had.
      for (const id of [...targets.map((t) => t.id), provisioned.id, byok.id, otherModel.id, otherOrgCost.id]) {
        expect(await statusOf(id)).not.toBe("refunded");
      }
    });

    it("applies exactly the previewed set", async () => {
      const { targets, provisioned, byok, otherModel, otherOrgCost } = await seedFleet();

      const preview = await request(app)
        .post("/internal/cost-refunds/preview")
        .set(internalHeaders)
        .send(dayOneFilter);
      const apply = await request(app)
        .post("/internal/cost-refunds/apply")
        .set(internalHeaders)
        .send({ ...dayOneFilter, reason: REASON, refundedBy: ACTOR });

      expect(apply.status).toBe(200);
      expect(apply.body.refundedCostCount).toBe(preview.body.costCount);
      expect(apply.body.grossTotalInUsdCents).toBe(preview.body.grossTotalInUsdCents);
      expect(apply.body.netTotalInUsdCents).toBe(preview.body.netTotalInUsdCents);

      for (const t of targets) expect(await statusOf(t.id)).toBe("refunded");
      // Untouched: a hold, a BYOK row, another model, another org.
      expect(await statusOf(provisioned.id)).toBe("provisioned");
      expect(await statusOf(byok.id)).toBe("actual");
      expect(await statusOf(otherModel.id)).toBe("actual");
      expect(await statusOf(otherOrgCost.id)).toBe("actual");
    });

    it("is idempotent — a second apply refunds nothing and moves no amount twice", async () => {
      await seedFleet();

      const first = await request(app)
        .post("/internal/cost-refunds/apply")
        .set(internalHeaders)
        .send({ ...dayOneFilter, reason: REASON, refundedBy: ACTOR });
      const usageAfterFirst = await orgUsage();

      const second = await request(app)
        .post("/internal/cost-refunds/apply")
        .set(internalHeaders)
        .send({ ...dayOneFilter, reason: REASON, refundedBy: ACTOR });
      const usageAfterSecond = await orgUsage();

      expect(first.body.refundedCostCount).toBe(2);
      expect(second.body.refundedCostCount).toBe(0);
      expect(second.body.grossTotalInUsdCents).toBe("0.0000000000");
      expect(usageAfterSecond.spent_cents).toBe(usageAfterFirst.spent_cents);
      expect(usageAfterSecond.net_spent_cents).toBe(usageAfterFirst.net_spent_cents);
    });

    it("scopes to a run AND its descendants when given a rootRunId", async () => {
      const { parent, child } = await seedFleet();
      const unrelated = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "chat-service",
        taskName: "complete",
        startedAt: new Date("2026-08-25T12:00:00Z"),
      });
      const unrelatedCost = await insertTestRunCost({
        runId: unrelated.id,
        costName: "zai-glm-5.3-input-tokens",
        quantity: "1",
        unitCostInUsdCents: "8.0000000000",
        totalCostInUsdCents: "8.0000000000",
        status: "actual",
      });

      const res = await request(app)
        .post("/internal/cost-refunds/apply")
        .set(internalHeaders)
        .send({ orgId: ORG_ID, rootRunId: parent.id, costNamePrefix: "zai-glm-5.3", reason: REASON, refundedBy: ACTOR });

      expect(res.status).toBe(200);
      // The parent's charged row and the CHILD's — without enumerating either.
      expect(res.body.refundedCostCount).toBe(2);
      expect(res.body.runCount).toBe(2);
      expect(await statusOf(unrelatedCost.id)).toBe("actual");
      expect(child.parentRunId).toBe(parent.id);
    });

    it("requires a reason and an actor, and records them", async () => {
      const { targets } = await seedFleet();

      const missing = await request(app)
        .post("/internal/cost-refunds/apply")
        .set(internalHeaders)
        .send(dayOneFilter);
      expect(missing.status).toBe(400);
      for (const t of targets) expect(await statusOf(t.id)).toBe("actual");

      await request(app)
        .post("/internal/cost-refunds/apply")
        .set(internalHeaders)
        .send({ ...dayOneFilter, reason: REASON, refundedBy: ACTOR });

      const events = await db
        .select()
        .from(costLifecycleEvents)
        .where(eq(costLifecycleEvents.costId, targets[0].id));
      const refundEvent = events.find((e) => e.eventType === "cost.refunded");
      expect(refundEvent!.payload).toMatchObject({ reason: REASON, refundedBy: ACTOR });
    });

    it("the day-one case: the org's usage drops by exactly the comped amount", async () => {
      await seedFleet();

      const before = await orgUsage();
      const apply = await request(app)
        .post("/internal/cost-refunds/apply")
        .set(internalHeaders)
        .send({ ...dayOneFilter, reason: REASON, refundedBy: ACTOR });
      const after = await orgUsage();

      const grossDrop = Number(before.spent_cents) - Number(after.spent_cents);
      const netDrop = Number(before.net_spent_cents) - Number(after.net_spent_cents);
      expect(grossDrop).toBeCloseTo(Number(apply.body.grossTotalInUsdCents), 10);
      expect(netDrop).toBeCloseTo(Number(apply.body.netTotalInUsdCents), 10);

      // ...and the same money is still visible as real spend.
      const res = await request(app)
        .get("/v1/stats/costs")
        .set(authHeaders)
        .query({ groupBy: "costName" });
      const refundedTotal = res.body.groups
        .map((g: any) => Number(g.refundedCostInUsdCents))
        .reduce((a: number, b: number) => a + b, 0);
      expect(refundedTotal).toBeCloseTo(Number(apply.body.grossTotalInUsdCents), 10);
    });

    it("rejects an unknown org id shape", async () => {
      const res = await request(app)
        .post("/internal/cost-refunds/preview")
        .set(internalHeaders)
        .send({ orgId: "not-a-uuid" });
      expect(res.status).toBe(400);
    });
  });
});
