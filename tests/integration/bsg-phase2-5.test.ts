import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { eq, and, sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../../src/db/index.js";
import {
  runs,
  runsCosts,
  runLifecycleEvents,
  costLifecycleEvents,
} from "../../src/db/schema.js";
import {
  createTestApp,
  getAuthHeaders,
  getPlatformAuthHeaders,
} from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, closeDb } from "../helpers/test-db.js";

// Phase 2-5 of B/S/G substrate (γ migration plan).
// Verifies: handlers write bronze events, trigger projects silver, idempotency
// suppresses bronze writes on replay, read endpoints return correct shapes
// against the gold views.

const ORG_ID = "eeeeeeee-1111-4eee-8eee-111111111111";
const USER_ID = "eeeeeeee-2222-4eee-8eee-222222222222";
const CLEANUP_ORG_IDS = [ORG_ID, null];

vi.mock("../../src/services/cost-resolver.js", () => ({
  resolveMultipleUnitCosts: vi.fn().mockResolvedValue(
    new Map([
      ["gpt-4o", "0.0010000000"],
      ["claude-haiku", "0.0005000000"],
      // Unit price ≥ 100 cents ($1) — overflows the legacy unit_cost numeric(12,10)
      // (max abs < 100). Regression guard for the widening to numeric(16,10).
      ["featured-api-pitch-submit", "200.0000000000"],
    ])
  ),
  CostNotFoundError: class CostNotFoundError extends Error {
    costName: string;
    constructor(costName: string) {
      super(`Cost not found: ${costName}`);
      this.costName = costName;
    }
  },
  UpstreamError: class UpstreamError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

vi.mock("../../src/services/billing.js", () => ({
  notifyUsage: vi.fn().mockResolvedValue(undefined),
}));

const app = createTestApp();
const authHeaders = getAuthHeaders({ orgId: ORG_ID, userId: USER_ID });
const platformHeaders = getPlatformAuthHeaders({ serviceName: "stripe-service" });

async function clearBronze() {
  // Bronze has no FK to silver. Clear by run_id ∈ silver row set we own.
  // After cleanTestData drops silver, also drop the matching bronze rows.
  await db.delete(runLifecycleEvents);
  await db.delete(costLifecycleEvents);
}

describe("B/S/G substrate — Phase 2-5", () => {
  beforeEach(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
    await clearBronze();
  });

  afterAll(async () => {
    await cleanTestData(CLEANUP_ORG_IDS);
    await clearBronze();
    await closeDb();
  });

  describe("POST /v1/runs writes bronze + projects silver", () => {
    it("writes run.created bronze event and silver row materializes via trigger", async () => {
      const res = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({ serviceName: "svc", taskName: "task" });

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.body.serviceName).toBe("svc");
      expect(res.body.status).toBe("running");

      // Bronze
      const events = await db.select().from(runLifecycleEvents).where(eq(runLifecycleEvents.runId, res.body.id));
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("run.created");
      const payload = events[0].payload as any;
      expect(payload.serviceName).toBe("svc");
      expect(payload.taskName).toBe("task");

      // Silver — projected by trigger
      const [silver] = await db.select().from(runs).where(eq(runs.id, res.body.id));
      expect(silver.serviceName).toBe("svc");
      expect(silver.status).toBe("running");
      expect(silver.organizationId).toBe(ORG_ID);
    });

    it("idempotent replay (200) does NOT write a second bronze event", async () => {
      const body = { serviceName: "svc", taskName: "task", idempotencyKey: "test:run:phase2-5:1" };
      const first = await request(app).post("/v1/runs").set(authHeaders).send(body);
      expect(first.status).toBe(201);

      const second = await request(app).post("/v1/runs").set(authHeaders).send(body);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);

      const events = await db
        .select()
        .from(runLifecycleEvents)
        .where(eq(runLifecycleEvents.runId, first.body.id));
      expect(events).toHaveLength(1); // one event, not two
    });

    it("conflicting parent run rejects with 409 and writes NO bronze event", async () => {
      const parent = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "p",
        taskName: "p",
        campaignId: "campaign-a",
      });

      const before = await db
        .select({ c: sql<string>`count(*)::text` })
        .from(runLifecycleEvents);

      const res = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": parent.id, "x-campaign-id": "campaign-b" })
        .send({ serviceName: "svc", taskName: "task" });

      expect(res.status).toBe(409);

      const after = await db
        .select({ c: sql<string>`count(*)::text` })
        .from(runLifecycleEvents);
      expect(after[0].c).toBe(before[0].c);
    });
  });

  describe("POST /v1/platform-runs", () => {
    it("writes run.created with sourceService from x-service-name header", async () => {
      const res = await request(app)
        .post("/v1/platform-runs")
        .set(platformHeaders)
        .send({ serviceName: "stripe-service", taskName: "charge.webhook" });

      expect(res.status).toBe(201);
      const [event] = await db
        .select()
        .from(runLifecycleEvents)
        .where(eq(runLifecycleEvents.runId, res.body.id));
      expect(event.sourceService).toBe("stripe-service");
    });
  });

  describe("PATCH /v1/runs/:id", () => {
    it("status=completed writes run.completed event and trigger flips silver", async () => {
      const create = await request(app)
        .post("/v1/runs")
        .set(authHeaders)
        .send({ serviceName: "s", taskName: "t" });
      expect(create.status).toBe(201);

      const patch = await request(app)
        .patch(`/v1/runs/${create.body.id}`)
        .set(authHeaders)
        .send({ status: "completed" });
      expect(patch.status).toBe(200);
      expect(patch.body.status).toBe("completed");
      expect(patch.body.completedAt).toBeDefined();

      const events = await db
        .select()
        .from(runLifecycleEvents)
        .where(eq(runLifecycleEvents.runId, create.body.id));
      expect(events).toHaveLength(2);
      const completedEvent = events.find((e) => e.eventType === "run.completed");
      expect(completedEvent).toBeDefined();
      expect((completedEvent!.payload as any).from).toBe("running");
      expect((completedEvent!.payload as any).to).toBe("completed");
    });

    it("status=failed writes run.failed event", async () => {
      const create = await request(app).post("/v1/runs").set(authHeaders).send({ serviceName: "s", taskName: "t" });
      const patch = await request(app)
        .patch(`/v1/runs/${create.body.id}`)
        .set(authHeaders)
        .send({ status: "failed" });
      expect(patch.status).toBe(200);
      const events = await db
        .select()
        .from(runLifecycleEvents)
        .where(eq(runLifecycleEvents.runId, create.body.id));
      expect(events.some((e) => e.eventType === "run.failed")).toBe(true);
    });

    it("404 on missing run writes no bronze event", async () => {
      const fakeId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
      const before = await db.select({ c: sql<string>`count(*)::text` }).from(runLifecycleEvents);
      const res = await request(app).patch(`/v1/runs/${fakeId}`).set(authHeaders).send({ status: "completed" });
      expect(res.status).toBe(404);
      const after = await db.select({ c: sql<string>`count(*)::text` }).from(runLifecycleEvents);
      expect(after[0].c).toBe(before[0].c);
    });
  });

  describe("POST /v1/runs/:id/costs", () => {
    it("writes cost.added bronze event per item, trigger projects silver runs_costs", async () => {
      const create = await request(app).post("/v1/runs").set(authHeaders).send({ serviceName: "s", taskName: "t" });
      const runId = create.body.id;

      const res = await request(app)
        .post(`/v1/runs/${runId}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o", costSource: "platform", quantity: 100 },
            { costName: "claude-haiku", costSource: "platform", quantity: 200 },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.costs).toHaveLength(2);

      const events = await db.select().from(costLifecycleEvents).where(eq(costLifecycleEvents.runId, runId));
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.eventType === "cost.added")).toBe(true);

      // Silver projected via trigger
      const silver = await db.select().from(runsCosts).where(eq(runsCosts.runId, runId));
      expect(silver).toHaveLength(2);
      expect(silver.map((s) => s.costName).sort()).toEqual(["claude-haiku", "gpt-4o"]);
    });

    it("projects a cost whose unit price ≥ $1 to silver without numeric overflow", async () => {
      // Regression: unit_cost_in_usd_cents was numeric(12,10) (max abs < 100 cents).
      // featured-api-pitch-submit resolves to 200 cents/unit → trigger INSERT into
      // runs_costs overflowed (22003), the whole cost.added txn rolled back, EQRS got 500.
      const create = await request(app).post("/v1/runs").set(authHeaders).send({ serviceName: "s", taskName: "t" });
      const runId = create.body.id;

      const res = await request(app)
        .post(`/v1/runs/${runId}/costs`)
        .set(authHeaders)
        .send({ items: [{ costName: "featured-api-pitch-submit", costSource: "platform", quantity: 1 }] });
      expect(res.status).toBe(201);
      expect(res.body.costs).toHaveLength(1);

      // Bronze event written (txn did NOT roll back).
      const events = await db.select().from(costLifecycleEvents).where(eq(costLifecycleEvents.runId, runId));
      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("cost.added");

      // Silver projected via trigger with full precision preserved.
      const silver = await db.select().from(runsCosts).where(eq(runsCosts.runId, runId));
      expect(silver).toHaveLength(1);
      expect(new Decimal(silver[0].unitCostInUsdCents).toFixed(10)).toBe("200.0000000000");
      expect(new Decimal(silver[0].totalCostInUsdCents).toFixed(10)).toBe("200.0000000000");
    });

    it("idempotent replay on cost item returns existing row and writes no new event", async () => {
      const create = await request(app).post("/v1/runs").set(authHeaders).send({ serviceName: "s", taskName: "t" });
      const runId = create.body.id;

      const body = {
        items: [{ costName: "gpt-4o", costSource: "platform", quantity: 50, idempotencyKey: "k1" }],
      };
      const first = await request(app).post(`/v1/runs/${runId}/costs`).set(authHeaders).send(body);
      expect(first.status).toBe(201);

      const second = await request(app).post(`/v1/runs/${runId}/costs`).set(authHeaders).send(body);
      expect(second.status).toBe(201);
      expect(second.body.costs[0].id).toBe(first.body.costs[0].id);

      const events = await db.select().from(costLifecycleEvents).where(eq(costLifecycleEvents.runId, runId));
      expect(events).toHaveLength(1); // one cost.added event, not two
    });
  });

  describe("PATCH /v1/runs/:id/costs/:costId", () => {
    it("provisioned→actual writes cost.materialized; trigger flips silver", async () => {
      const create = await request(app).post("/v1/runs").set(authHeaders).send({ serviceName: "s", taskName: "t" });
      const runId = create.body.id;
      const add = await request(app)
        .post(`/v1/runs/${runId}/costs`)
        .set(authHeaders)
        .send({ items: [{ costName: "gpt-4o", costSource: "platform", quantity: 100, status: "provisioned" }] });
      const costId = add.body.costs[0].id;

      const patch = await request(app)
        .patch(`/v1/runs/${runId}/costs/${costId}`)
        .set(authHeaders)
        .send({ status: "actual" });
      expect(patch.status).toBe(200);
      expect(patch.body.status).toBe("actual");

      const events = await db
        .select()
        .from(costLifecycleEvents)
        .where(and(eq(costLifecycleEvents.costId, costId), eq(costLifecycleEvents.eventType, "cost.materialized")));
      expect(events).toHaveLength(1);
    });

    it("→cancelled writes cost.cancelled", async () => {
      const create = await request(app).post("/v1/runs").set(authHeaders).send({ serviceName: "s", taskName: "t" });
      const runId = create.body.id;
      const add = await request(app)
        .post(`/v1/runs/${runId}/costs`)
        .set(authHeaders)
        .send({ items: [{ costName: "gpt-4o", costSource: "platform", quantity: 100 }] });
      const costId = add.body.costs[0].id;

      const patch = await request(app)
        .patch(`/v1/runs/${runId}/costs/${costId}`)
        .set(authHeaders)
        .send({ status: "cancelled" });
      expect(patch.status).toBe(200);
      expect(patch.body.status).toBe("cancelled");

      const events = await db
        .select()
        .from(costLifecycleEvents)
        .where(and(eq(costLifecycleEvents.costId, costId), eq(costLifecycleEvents.eventType, "cost.cancelled")));
      expect(events).toHaveLength(1);
    });
  });

  describe("Phase 4 view-swap parity", () => {
    it("POST /v1/runs/costs/batch reads from v_run_cost_rollup — descendant totals match", async () => {
      const create = await request(app).post("/v1/runs").set(authHeaders).send({ serviceName: "p", taskName: "p" });
      const parentId = create.body.id;
      const child = await request(app)
        .post("/v1/runs")
        .set({ ...authHeaders, "x-run-id": parentId })
        .send({ serviceName: "c", taskName: "c" });
      const childId = child.body.id;

      await request(app)
        .post(`/v1/runs/${parentId}/costs`)
        .set(authHeaders)
        .send({ items: [{ costName: "gpt-4o", costSource: "platform", quantity: 100 }] });
      await request(app)
        .post(`/v1/runs/${childId}/costs`)
        .set(authHeaders)
        .send({ items: [{ costName: "gpt-4o", costSource: "platform", quantity: 200 }] });

      const res = await request(app)
        .post("/v1/runs/costs/batch")
        .set(authHeaders)
        .send({ runIds: [parentId] });
      expect(res.status).toBe(200);
      expect(res.body.costs).toHaveLength(1);
      const entry = res.body.costs[0];
      expect(entry.totalCostInUsdCents).toBe("0.3000000000"); // 0.1 + 0.2
      expect(entry.ownActualPlatformCostInUsdCents).toBe("0.1000000000"); // parent only
    });

    it("GET /v1/runs/:id returns rollup that matches v_run_cost_rollup", async () => {
      const create = await request(app).post("/v1/runs").set(authHeaders).send({ serviceName: "s", taskName: "t" });
      const id = create.body.id;
      await request(app)
        .post(`/v1/runs/${id}/costs`)
        .set(authHeaders)
        .send({ items: [{ costName: "gpt-4o", costSource: "platform", quantity: 100 }] });

      const res = await request(app).get(`/v1/runs/${id}`).set(authHeaders);
      expect(res.status).toBe(200);
      expect(res.body.totalCostInUsdCents).toBe("0.1000000000");
      expect(res.body.ownCostInUsdCents).toBe("0.1000000000");
      expect(res.body.actualCostInUsdCents).toBe("0.1000000000");
      expect(res.body.childrenCostInUsdCents).toBe("0.0000000000");
    });

    it("GET /internal/org-usage-total reads v_org_platform_spend", async () => {
      const create = await request(app).post("/v1/runs").set(authHeaders).send({ serviceName: "s", taskName: "t" });
      await request(app)
        .post(`/v1/runs/${create.body.id}/costs`)
        .set(authHeaders)
        .send({
          items: [
            { costName: "gpt-4o", costSource: "platform", quantity: 100, status: "actual" },
            { costName: "claude-haiku", costSource: "platform", quantity: 200, status: "provisioned" },
            { costName: "gpt-4o", costSource: "org", quantity: 99999, status: "actual" }, // BYOK — excluded
          ],
        });

      const res = await request(app)
        .get(`/internal/org-usage-total?org_id=${ORG_ID}`)
        .set({ "X-API-Key": "test-api-key" });
      expect(res.status).toBe(200);
      // 100 * 0.001 + 200 * 0.0005 = 0.1 + 0.1 = 0.2
      expect(res.body.spent_cents).toBe("0.2000000000");
    });
  });

  describe("trigger semantics — direct bronze insert projects silver", () => {
    it("direct INSERT into run_lifecycle_events with run.created creates silver row", async () => {
      const id = "ffffffff-1111-4fff-8fff-111111111111";
      await db.insert(runLifecycleEvents).values({
        runId: id,
        eventType: "run.created",
        payload: {
          runId: id,
          organizationId: ORG_ID,
          userId: USER_ID,
          brandIds: null,
          campaignId: null,
          workflowSlug: null,
          featureSlug: null,
          serviceName: "direct-bronze-test",
          taskName: "trigger-projects",
          idempotencyKey: null,
          parentRunId: null,
        },
      });

      const [silver] = await db.select().from(runs).where(eq(runs.id, id));
      expect(silver).toBeDefined();
      expect(silver.serviceName).toBe("direct-bronze-test");
      expect(silver.status).toBe("running");
      expect(silver.organizationId).toBe(ORG_ID);
    });

    it("subsequent run.completed event flips silver status to completed", async () => {
      const id = "ffffffff-2222-4fff-8fff-222222222222";
      await db.insert(runLifecycleEvents).values({
        runId: id,
        eventType: "run.created",
        payload: {
          runId: id,
          organizationId: ORG_ID,
          userId: null,
          brandIds: null,
          campaignId: null,
          workflowSlug: null,
          featureSlug: null,
          serviceName: "s",
          taskName: "t",
          idempotencyKey: null,
          parentRunId: null,
        },
      });
      await db.insert(runLifecycleEvents).values({
        runId: id,
        eventType: "run.completed",
        payload: { from: "running", to: "completed" },
      });

      const [silver] = await db.select().from(runs).where(eq(runs.id, id));
      expect(silver.status).toBe("completed");
      expect(silver.completedAt).toBeInstanceOf(Date);
    });
  });
});
