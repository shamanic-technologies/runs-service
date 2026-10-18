import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { db, sql } from "../../src/db/index.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, insertTestRunCost, closeDb } from "../helpers/test-db.js";
import { CAMPAIGN_DAY_ROLLUP_NAME } from "../../src/services/stats-rollup-campaign.js";
import { ORG_HOUR_ROLLUP_NAME } from "../../src/services/stats-rollup-org-hour.js";
import { ORG_TASK_ROLLUP_NAME } from "../../src/services/stats-rollup-org-task.js";

// A cost that really happened, was never charged, and is declared late.
//
// Two questions, never conflated (CLAUDE.md "Refunded costs"):
//   ACCOUNTING — what the customer owes / was charged  → must NEVER move, at any instant
//   PERFORMANCE — what the workflow really cost         → must move, on the day it happened
// Every test that checks a charge read did not move is paired with one that checks
// the spend IS visible in the incurred (refunded) columns.

const PRICES: Record<string, string> = {
  "instantly-account-email-sent": "0.2500000000",
  "instantly-domain-email-sent": "0.2500000000",
};

vi.mock("../../src/services/cost-resolver.js", () => {
  class CostNotFoundError extends Error {
    costName: string;
    constructor(costName: string) {
      super(`Cost not found: ${costName}`);
      this.costName = costName;
    }
  }
  class UpstreamError extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.statusCode = statusCode;
    }
  }
  return {
    CostNotFoundError,
    UpstreamError,
    resolveMultipleUnitCosts: vi.fn(async (names: string[]) => {
      const m = new Map<string, string>();
      for (const n of new Set(names)) {
        const p = ({
          "instantly-account-email-sent": "0.2500000000",
          "instantly-domain-email-sent": "0.2500000000",
        } as Record<string, string>)[n];
        if (!p) throw new CostNotFoundError(n);
        m.set(n, p);
      }
      return m;
    }),
  };
});

vi.mock("../../src/services/billing.js", () => ({
  notifyUsage: vi.fn().mockResolvedValue(undefined),
  fetchOrgPlatformSpent: vi.fn().mockResolvedValue(0),
}));

// 50 % usage discount, so the frozen net is visibly different from the gross.
vi.mock("../../src/services/usage-discount.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/usage-discount.js")>();
  const { Decimal } = await import("decimal.js");
  return { ...actual, resolveUsageDiscount: vi.fn().mockResolvedValue(new Decimal("0.5")) };
});

const ORG_ID = "1c0a0000-1111-4aaa-8aaa-111111111111";
const SUFFIX = randomUUID().slice(0, 8);
const FEATURE = `incurred-${SUFFIX}`;
const WORKFLOW = `cold-email-${SUFFIX}`;
const CAMPAIGN = randomUUID();
const BRAND = randomUUID();

const app = createTestApp();
const authHeaders = getAuthHeaders({ orgId: ORG_ID });
const internal = getInternalAuthHeaders();
const REASON = "Owner decision 2026-08-23: per-email send costs absorbed, never charged";
const ACTOR = "kevin@distribute.you";

const DAY1 = "2026-09-02";
const DAY2 = "2026-09-03";

async function seed() {
  const inCampaign = await insertTestRun({
    organizationId: ORG_ID,
    serviceName: "instantly-service",
    taskName: "email-send-step-1",
    campaignId: CAMPAIGN,
    brandIds: [BRAND],
    workflowSlug: WORKFLOW,
    featureSlug: FEATURE,
    status: "completed",
    startedAt: new Date(`${DAY1}T10:00:00.000Z`),
  });
  // A live, charged cost already on the run: must stay exactly as charged.
  await insertTestRunCost({
    runId: inCampaign.id,
    costName: "apollo-email-verification",
    quantity: "1",
    unitCostInUsdCents: "2.0000000000",
    totalCostInUsdCents: "2.0000000000",
    netCostInUsdCents: "1.0000000000",
    createdAt: new Date(`${DAY1}T10:00:01.000Z`),
  });
  const noCampaign = await insertTestRun({
    organizationId: ORG_ID,
    serviceName: "instantly-service",
    taskName: "email-send-step-2",
    brandIds: [BRAND],
    workflowSlug: WORKFLOW,
    featureSlug: FEATURE,
    status: "completed",
    startedAt: new Date(`${DAY2}T07:00:00.000Z`),
  });
  return { inCampaign, noCampaign };
}

function itemsFor(runs: Awaited<ReturnType<typeof seed>>) {
  return [
    { runId: runs.inCampaign.id, costName: "instantly-account-email-sent", quantity: 1, incurredAt: `${DAY1}T10:05:00.000Z`, idempotencyKey: "incurred:s1:account" },
    { runId: runs.inCampaign.id, costName: "instantly-domain-email-sent", quantity: 1, incurredAt: `${DAY1}T10:05:00.000Z`, idempotencyKey: "incurred:s1:domain" },
    { runId: runs.noCampaign.id, costName: "instantly-account-email-sent", quantity: 1, incurredAt: `${DAY2}T08:00:00.000Z`, idempotencyKey: "incurred:s2:account" },
  ];
}

const apply = (items: unknown[]) =>
  request(app).post("/internal/incurred-costs/apply").set(internal).send({ items, reason: REASON, authorizedBy: ACTOR });
const preview = (items: unknown[]) => request(app).post("/internal/incurred-costs/preview").set(internal).send({ items });

async function ledgerCounts() {
  const [c] = await sql`SELECT count(*)::int AS n FROM runs_costs rc JOIN runs r ON r.id = rc.run_id WHERE r.organization_id = ${ORG_ID}`;
  const [b] = await sql`SELECT count(*)::int AS n FROM cost_lifecycle_events e JOIN runs r ON r.id = e.run_id WHERE r.organization_id = ${ORG_ID}`;
  return { costs: c.n as number, bronze: b.n as number };
}

/** Every read that says what the customer owes or was charged. */
async function chargeReads(runIds: string[]) {
  const get = async (path: string, query: Record<string, string>, headers = internal) => {
    const res = await request(app).get(path).set(headers).query(query);
    expect(res.status).toBe(200);
    const { as_of, asOf, ...rest } = res.body;
    return rest;
  };
  const budget = await request(app)
    .post("/v1/stats/budget")
    .set(authHeaders)
    .send({ campaignId: CAMPAIGN, windows: [{ label: "all-time" }] });
  expect(budget.status).toBe(200);
  const costs = await get("/v1/stats/costs", { groupBy: "workflowSlug" }, authHeaders);
  const runReads = [];
  for (const id of runIds) {
    const r = await request(app).get(`/v1/runs/${id}`).set(authHeaders);
    runReads.push({
      total: r.body.totalCostInUsdCents,
      actual: r.body.actualCostInUsdCents,
      provisioned: r.body.provisionedCostInUsdCents,
    });
  }
  return {
    usage: await get("/internal/org-usage-total", { org_id: ORG_ID }),
    actualTotal: await get("/internal/org-actual-total", { org_id: ORG_ID }),
    expected: await get("/internal/runs-expected-totals", { org_id: ORG_ID }),
    noCampaign: await get("/internal/org-no-campaign-total", { org_id: ORG_ID, since: "2026-08-01T00:00:00.000Z" }),
    budget: budget.body.windows,
    charged: costs.groups.map((g: any) => ({
      total: g.totalCostInUsdCents,
      actual: g.actualCostInUsdCents,
      provisioned: g.provisionedCostInUsdCents,
      netActual: g.netActualCostInUsdCents,
    })),
    runReads,
  };
}

async function stamp(name: string, ready: boolean) {
  if (ready) await sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${name}, now()) ON CONFLICT (name) DO NOTHING`;
  else await sql`DELETE FROM stats_rollups WHERE name = ${name}`;
}

describe("POST /internal/incurred-costs/{preview,apply}", () => {
  beforeEach(async () => {
    await cleanTestData([ORG_ID]);
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await closeDb();
  });

  it("401 without the internal key, 400 without reason / authorizedBy or over 500 items", async () => {
    expect((await request(app).post("/internal/incurred-costs/preview").send({ items: [] })).status).toBe(401);
    const one = [{ runId: randomUUID(), costName: "instantly-account-email-sent", quantity: 1, incurredAt: `${DAY1}T10:05:00Z`, idempotencyKey: "k" }];
    expect((await request(app).post("/internal/incurred-costs/apply").set(internal).send({ items: one })).status).toBe(400);
    expect((await request(app).post("/internal/incurred-costs/apply").set(internal).send({ items: one, reason: REASON })).status).toBe(400);
    expect((await preview(Array.from({ length: 501 }, (_, i) => ({ ...one[0], idempotencyKey: `k${i}` })))).status).toBe(400);
    // idempotencyKey is mandatory
    expect((await preview([{ ...one[0], idempotencyKey: undefined }])).status).toBe(400);
  });

  it("preview prices exactly what apply writes, and writes nothing", async () => {
    const runs = await seed();
    const before = await ledgerCounts();

    const res = await preview(itemsFor(runs));
    expect(res.status).toBe(200);
    expect(res.body.toRecordCount).toBe(3);
    expect(res.body.alreadyRecordedCount).toBe(0);
    expect(res.body.invalidCount).toBe(0);
    expect(res.body.totalCostInUsdCents).toBe("0.7500000000");
    expect(res.body.netTotalCostInUsdCents).toBe("0.3750000000");
    expect(res.body.unitPrices).toEqual(PRICES);
    expect(res.body.items.map((i: any) => i.outcome)).toEqual(["to_record", "to_record", "to_record"]);
    expect(await ledgerCounts()).toEqual(before);

    const applied = await apply(itemsFor(runs));
    expect(applied.status).toBe(200);
    expect(applied.body.recordedCount).toBe(3);
    expect(applied.body.totalCostInUsdCents).toBe(res.body.totalCostInUsdCents);
    expect(applied.body.netTotalCostInUsdCents).toBe(res.body.netTotalCostInUsdCents);
    expect(applied.body.items.map((i: any) => i.totalCostInUsdCents)).toEqual(res.body.items.map((i: any) => i.totalCostInUsdCents));
  });

  it("never changes any charge read — before or after — while the incurred columns move", async () => {
    const runs = await seed();
    const before = await chargeReads([runs.inCampaign.id, runs.noCampaign.id]);
    expect(before.usage.spent_cents).toBe("2.0000000000");

    const res = await apply(itemsFor(runs));
    expect(res.status).toBe(200);

    const after = await chargeReads([runs.inCampaign.id, runs.noCampaign.id]);
    expect(after).toEqual(before);

    // ...and the spend IS there on the performance side.
    const byWorkflow = await request(app).get("/v1/stats/costs").set(authHeaders).query({ groupBy: "workflowSlug" });
    const wf = byWorkflow.body.groups.find((g: any) => g.dimensions.workflowSlug === WORKFLOW);
    expect(wf.refundedCostInUsdCents).toBe("0.7500000000");
    expect(wf.netRefundedCostInUsdCents).toBe("0.3750000000");
    expect(wf.actualCostInUsdCents).toBe("2.0000000000");
  });

  it("is born refunded: one cost.added event per row, no transient charged state, audit carries reason + actor", async () => {
    const runs = await seed();
    const res = await apply(itemsFor(runs));
    const ids = res.body.items.map((i: any) => i.costId);
    const events = await sql`
      SELECT cost_id, event_type, payload, occurred_at FROM cost_lifecycle_events WHERE cost_id = ANY(${ids}::uuid[])`;
    expect(events.length).toBe(3);
    for (const e of events) {
      expect(e.event_type).toBe("cost.added");
      expect(e.payload.status).toBe("refunded");
      expect(e.payload.reason).toBe(REASON);
      expect(e.payload.authorizedBy).toBe(ACTOR);
      expect(e.payload.origin).toBe("incurred_uncharged");
      // Bronze records WHEN we wrote it; the row records when it happened.
      expect(Date.now() - new Date(e.occurred_at).getTime()).toBeLessThan(60_000);
    }
    const rows = await sql`
      SELECT status, cost_source, created_at, organization_id, run_started_at, run_has_campaign, total_cost_in_usd_cents::text AS total, net_cost_in_usd_cents::text AS net
        FROM runs_costs WHERE id = ANY(${ids}::uuid[]) ORDER BY created_at, cost_name`;
    expect(rows.map((r) => r.status)).toEqual(["refunded", "refunded", "refunded"]);
    expect(rows.map((r) => r.cost_source)).toEqual(["platform", "platform", "platform"]);
    expect(rows.map((r) => new Date(r.created_at).toISOString())).toEqual([
      `${DAY1}T10:05:00.000Z`,
      `${DAY1}T10:05:00.000Z`,
      `${DAY2}T08:00:00.000Z`,
    ]);
    expect(rows.every((r) => r.organization_id === ORG_ID)).toBe(true);
    expect(rows.map((r) => r.run_has_campaign)).toEqual([true, true, false]);
    expect(rows.map((r) => r.net)).toEqual(["0.1250000000", "0.1250000000", "0.1250000000"]);
  });

  it("same item twice = one row; a re-run writes nothing and reports already_recorded", async () => {
    const runs = await seed();
    const first = await apply(itemsFor(runs));
    expect(first.body.recordedCount).toBe(3);
    const counts = await ledgerCounts();

    const again = await apply(itemsFor(runs));
    expect(again.status).toBe(200);
    expect(again.body.recordedCount).toBe(0);
    expect(again.body.alreadyRecordedCount).toBe(3);
    expect(again.body.totalCostInUsdCents).toBe("0.0000000000");
    expect(again.body.alreadyRecordedTotalCostInUsdCents).toBe("0.7500000000");
    expect(again.body.items.map((i: any) => i.costId)).toEqual(first.body.items.map((i: any) => i.costId));
    expect(await ledgerCounts()).toEqual(counts);

    const dry = await preview(itemsFor(runs));
    expect(dry.body.toRecordCount).toBe(0);
    expect(dry.body.alreadyRecordedCount).toBe(3);
    expect(dry.body.items.every((i: any) => i.outcome === "already_recorded" && i.status === "refunded")).toBe(true);

    // Concurrent applies of the same batch still write each item once.
    await cleanTestData([ORG_ID]);
    const fresh = await seed();
    const results = await Promise.all([apply(itemsFor(fresh)), apply(itemsFor(fresh)), apply(itemsFor(fresh))]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.reduce((n, r) => n + r.body.recordedCount, 0)).toBe(3);
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM runs_costs WHERE run_id = ANY(${[fresh.inCampaign.id, fresh.noCampaign.id]}::uuid[]) AND status = 'refunded'`;
    expect(n).toBe(3);
  });

  it("invalid items: listed by preview, refused by apply (422) with nothing written", async () => {
    const runs = await seed();
    const good = itemsFor(runs)[0];
    const items = [
      good,
      { ...good, idempotencyKey: "future", incurredAt: new Date(Date.now() + 3_600_000).toISOString() },
      { ...good, idempotencyKey: "early", incurredAt: `${DAY1}T09:59:59.000Z` },
      { ...good, idempotencyKey: "ghost", runId: randomUUID() },
      good,
    ];
    const dry = await preview(items);
    expect(dry.status).toBe(200);
    expect(dry.body.items.map((i: any) => i.outcome)).toEqual(["to_record", "invalid", "invalid", "invalid", "invalid"]);
    expect(dry.body.invalidCount).toBe(4);
    expect(dry.body.items[1].error).toMatch(/future/);
    expect(dry.body.items[2].error).toMatch(/before the run started/);
    expect(dry.body.items[3].error).toMatch(/run not found/);
    expect(dry.body.items[4].error).toMatch(/duplicate/);

    const before = await ledgerCounts();
    const res = await apply(items);
    expect(res.status).toBe(422);
    expect(res.body.invalidCount).toBe(4);
    expect(await ledgerCounts()).toEqual(before);
  });

  it("unknown cost name = 422, nothing written", async () => {
    const runs = await seed();
    const before = await ledgerCounts();
    const res = await apply([{ ...itemsFor(runs)[0], costName: "no-such-cost" }]);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/no-such-cost/);
    expect(await ledgerCounts()).toEqual(before);
  });

  it("dated reads place it on the day it happened; rollups agree with the live reads", async () => {
    const runs = await seed();
    await apply(itemsFor(runs));

    // Public timeseries (run-dated): the past days move in the refunded column only.
    const ts = await request(app)
      .get("/v1/stats/public/costs/timeseries")
      .query({ interval: "day", orgId: ORG_ID, featureSlugs: FEATURE });
    expect(ts.status).toBe(200);
    const day = (d: string) => ts.body.buckets.find((b: any) => String(b.period).startsWith(d));
    expect(day(DAY1).refundedCostInUsdCents).toBe("0.5000000000");
    expect(day(DAY1).actualCostInUsdCents).toBe("2.0000000000");
    expect(day(DAY2).refundedCostInUsdCents).toBe("0.2500000000");
    expect(day(DAY2).actualCostInUsdCents).toBe("0.0000000000");

    // By campaign: the campaign carries its part, the no-campaign run its own.
    const byCampaign = await request(app).get("/v1/stats/costs").set(authHeaders).query({ groupBy: "campaignId", featureSlugs: FEATURE });
    const c = byCampaign.body.groups.find((g: any) => g.dimensions.campaignId === CAMPAIGN);
    const none = byCampaign.body.groups.find((g: any) => g.dimensions.campaignId === null);
    expect(c.refundedCostInUsdCents).toBe("0.5000000000");
    expect(c.actualCostInUsdCents).toBe("2.0000000000");
    expect(none.refundedCostInUsdCents).toBe("0.2500000000");

    // created_at-keyed rollup (cost-day): refunded rows on the stated days, the
    // charged row untouched on its own.
    const costDay = await sql`
      SELECT day::text AS day, status, n::int AS n, gross::text AS gross
        FROM stats_rollup_cost_day WHERE organization_id = ${ORG_ID} ORDER BY day, status, cost_name`;
    expect(costDay.map((r) => [r.day, r.status, r.n])).toEqual([
      [DAY1, "actual", 1],
      [DAY1, "refunded", 1],
      [DAY1, "refunded", 1],
      [DAY2, "refunded", 1],
    ]);

    // Rollup vs live, raw bodies, for the reads features-service ranks on.
    const compare = async (name: string, path: string, query: Record<string, string>, headers?: Record<string, string>) => {
      const call = () => {
        const r = request(app).get(path).query(query);
        return (headers ? r.set(headers) : r).then((res) => {
          expect(res.status).toBe(200);
          return res.text;
        });
      };
      await stamp(name, true);
      const rolled = await call();
      await stamp(name, false);
      const live = await call();
      await stamp(name, true);
      expect(rolled).toBe(live);
    };
    await compare(CAMPAIGN_DAY_ROLLUP_NAME, "/v1/stats/costs", { groupBy: "workflowSlug,campaignId", featureSlugs: FEATURE, brandId: BRAND }, authHeaders);
    await compare(CAMPAIGN_DAY_ROLLUP_NAME, "/v1/stats/public/costs/timeseries", { interval: "day", orgId: ORG_ID, featureSlugs: FEATURE });
    await compare(ORG_HOUR_ROLLUP_NAME, "/v1/stats/costs/timeseries", { interval: "day", startedAfter: `${DAY1}T00:00:00.000Z`, startedBefore: "2026-09-05T00:00:00.000Z" }, authHeaders);
    await compare(ORG_TASK_ROLLUP_NAME, "/v1/stats/costs", { groupBy: "serviceName,taskName,campaignId" }, authHeaders);
  });
});
