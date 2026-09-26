import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { runs } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, closeDb } from "../helpers/test-db.js";

// GET /v1/stats/run-outcomes — completed / failed / running, success rate and the
// median duration of completed runs, per campaign (or family of campaigns).

const ORG_ID = "7a330000-1111-4aaa-8aaa-111111111111";
const OTHER_ORG_ID = "7a330000-2222-4aaa-8aaa-222222222222";
const BRAND = randomUUID();
const OTHER_BRAND = randomUUID();
const C1 = randomUUID();
const C2 = randomUUID();
const C3 = randomUUID(); // only running runs → no duration
const T0 = new Date("2026-09-20T10:00:00.000Z");

const app = createTestApp();

async function run(opts: {
  campaignId?: string;
  status: "completed" | "failed" | "running";
  durationMs?: number;
  parentRunId?: string;
  startedAt?: Date;
  orgId?: string;
  brandId?: string;
  serviceName?: string;
}) {
  const startedAt = opts.startedAt ?? T0;
  const r = await insertTestRun({
    organizationId: opts.orgId ?? ORG_ID,
    serviceName: opts.serviceName ?? "workflow",
    taskName: "execute-workflow",
    brandIds: [opts.brandId ?? BRAND],
    campaignId: opts.campaignId,
    parentRunId: opts.parentRunId,
    status: opts.status,
    startedAt,
  });
  if (opts.durationMs !== undefined) {
    await db.update(runs).set({ completedAt: new Date(startedAt.getTime() + opts.durationMs) }).where(eq(runs.id, r.id));
  }
  return r;
}

async function get(query: Record<string, string>) {
  return request(app).get("/v1/stats/run-outcomes").query(query).set(getAuthHeaders({ orgId: ORG_ID }));
}

function byCampaign(groups: any[]) {
  return Object.fromEntries(groups.map((g) => [g.dimensions.campaignId, g]));
}

beforeAll(async () => {
  await cleanTestData([ORG_ID, OTHER_ORG_ID]);

  // C1: 3 completed entry runs (1s, 2s, 10s → median 2s), 1 failed entry run.
  // A campaign-less trigger parents one of them; that run is still an entry run.
  const trigger = await run({ status: "completed", durationMs: 50, serviceName: "campaign-service" });
  const e1 = await run({ campaignId: C1, status: "completed", durationMs: 1000, parentRunId: trigger.id });
  await run({ campaignId: C1, status: "completed", durationMs: 2000 });
  await run({ campaignId: C1, status: "completed", durationMs: 10_000 });
  await run({ campaignId: C1, status: "failed", durationMs: 500 });
  // Children of e1 in the same campaign: not entry runs.
  await run({ campaignId: C1, status: "completed", durationMs: 100, parentRunId: e1.id, serviceName: "chat-service" });
  await run({ campaignId: C1, status: "failed", durationMs: 100, parentRunId: e1.id, serviceName: "lead-service" });

  // C2: 2 completed entry runs (3s, 5s → median 4s), 1 running.
  await run({ campaignId: C2, status: "completed", durationMs: 3000 });
  await run({ campaignId: C2, status: "completed", durationMs: 5000 });
  await run({ campaignId: C2, status: "running" });

  // C3: running only.
  await run({ campaignId: C3, status: "running" });

  // Outside the window / brand / org: must never count.
  await run({ campaignId: C1, status: "failed", startedAt: new Date("2026-08-01T00:00:00Z") });
  await run({ campaignId: C1, status: "failed", brandId: OTHER_BRAND });
  await run({ campaignId: C1, status: "failed", orgId: OTHER_ORG_ID });
});

afterAll(async () => {
  await cleanTestData([ORG_ID, OTHER_ORG_ID]);
  await closeDb();
});

describe("GET /v1/stats/run-outcomes", () => {
  const window = { brandId: BRAND, startedAfter: "2026-09-19T00:00:00.000Z" };

  it("counts entry runs per campaign with success rate and median duration", async () => {
    const res = await get(window);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("entry");
    const g = byCampaign(res.body.groups);

    expect(g[C1]).toMatchObject({
      runCount: 4,
      completedCount: 3,
      failedCount: 1,
      runningCount: 0,
      successRate: 0.75,
      medianDurationMs: 2000,
      minStartedAt: T0.toISOString(),
      maxStartedAt: T0.toISOString(),
    });
    expect(g[C2]).toMatchObject({ runCount: 3, completedCount: 2, failedCount: 0, runningCount: 1, successRate: 1, medianDurationMs: 4000 });
    // No run ended → no rate, no duration (null, never 0).
    expect(g[C3]).toMatchObject({ runCount: 1, completedCount: 0, failedCount: 0, runningCount: 1, successRate: null, medianDurationMs: null });
    // The campaign-less trigger is its own (null campaign) group.
    expect(g["null"] ?? res.body.groups.find((x: any) => x.dimensions.campaignId === null)).toMatchObject({ runCount: 1, completedCount: 1 });
  });

  it("scope=all counts every run and reconciles with GET /v1/runs", async () => {
    const res = await get({ ...window, scope: "all", campaignId: C1 });
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    const g = res.body.groups[0];
    expect(g).toMatchObject({ runCount: 6, completedCount: 4, failedCount: 2, runningCount: 0 });

    const list = await request(app)
      .get("/v1/runs")
      .query({ ...window, campaignId: C1 })
      .set(getAuthHeaders({ orgId: ORG_ID }));
    expect(list.status).toBe(200);
    const statuses = list.body.runs.map((r: any) => r.status);
    expect(statuses.length).toBe(g.runCount);
    expect(statuses.filter((s: string) => s === "completed").length).toBe(g.completedCount);
    expect(statuses.filter((s: string) => s === "failed").length).toBe(g.failedCount);
  });

  it("answers for a campaign family in one request, grouped per member", async () => {
    const res = await get({ ...window, campaignIds: `${C1},${C2}, ${C1}` });
    expect(res.status).toBe(200);
    expect(res.body.groups.map((x: any) => x.dimensions.campaignId).sort()).toEqual([C1, C2].sort());
    // Ordered by runCount desc.
    expect(res.body.groups[0].dimensions.campaignId).toBe(C1);
  });

  it("groupBy=featureSlug folds a family into one group with a family-wide median", async () => {
    const res = await get({ ...window, campaignIds: `${C1},${C2}`, groupBy: "featureSlug" });
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    // Completed durations 1s, 2s, 10s, 3s, 5s → median 3s.
    expect(res.body.groups[0]).toMatchObject({ runCount: 7, completedCount: 5, failedCount: 1, runningCount: 1, medianDurationMs: 3000 });
  });

  it("never reads another org", async () => {
    const res = await request(app)
      .get("/v1/stats/run-outcomes")
      .query({ campaignId: C1, scope: "all" })
      .set(getAuthHeaders({ orgId: OTHER_ORG_ID }));
    expect(res.status).toBe(200);
    expect(res.body.groups).toHaveLength(1);
    expect(res.body.groups[0]).toMatchObject({ runCount: 1, failedCount: 1 });
  });

  it("rejects bad input", async () => {
    expect((await get({ groupBy: "costName" })).status).toBe(400);
    expect((await get({ scope: "root" })).status).toBe(400);
    expect((await get({ campaignIds: " , " })).status).toBe(400);
    expect((await get({ startedAfter: "yesterday" })).status).toBe(400);
  });
});
