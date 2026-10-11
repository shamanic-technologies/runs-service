import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { inArray, sql as dsql } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { runs, runLifecycleEvents } from "../../src/db/schema.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { CAMPAIGN_DAY_ROLLUP_NAME } from "../../src/services/stats-rollup-campaign.js";

// POST /internal/runs/feature-slug-corrections fills a feature slug a writer
// failed to state on a run subtree (AI Instant Call, DIS-373): bronze event per
// run (the audit trail), projected into runs.feature_slug by migration 0044, and
// every feature-filtered cost read of the campaign then counts the subtree.

const ORG_ID = "f5c00000-1111-4aaa-8aaa-111111111111";
const SUFFIX = randomUUID().slice(0, 8);
const FEAT = `ai-instant-call-${SUFFIX}`;
const OTHER_FEAT = `sourcing-x-${SUFFIX}`;
const BRAND = randomUUID();

const app = createTestApp();
const internal = getInternalAuthHeaders();
const orgHeaders = getAuthHeaders({ orgId: ORG_ID });
const PATH = "/internal/runs/feature-slug-corrections";

async function cleanBronze() {
  await db.execute(dsql`DELETE FROM run_lifecycle_events WHERE identity->>'orgId' = ${ORG_ID}`);
}

async function stamp(ready: boolean) {
  if (ready) {
    await sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${CAMPAIGN_DAY_ROLLUP_NAME}, now()) ON CONFLICT (name) DO NOTHING`;
  } else {
    await sql`DELETE FROM stats_rollups WHERE name = ${CAMPAIGN_DAY_ROLLUP_NAME}`;
  }
}

async function campaignCost(campaignId: string, featureSlug: string) {
  const res = await request(app)
    .get("/v1/stats/public/costs")
    .set(orgHeaders)
    .query({ campaignId, featureSlugs: featureSlug, groupBy: "campaignId" });
  expect(res.status).toBe(200);
  const groups = res.body.groups as any[];
  return groups.length === 0 ? "0" : String(groups[0].actualCostInUsdCents);
}

// A parent opened without a slug, two children inheriting none (each with a cost),
// a grandchild, and a sourcing child labelled with its own slug whose own child
// carries none (must stay untouched: the walk does not descend below it).
async function seedSubtree(campaignId: string) {
  const base = { organizationId: ORG_ID, campaignId, brandIds: [BRAND] };
  const parent = await insertTestRun({ ...base, serviceName: "instantly-service", taskName: "ai-instant-call" });
  const lookup = await insertTestRun({ ...base, serviceName: "apollo-service", taskName: "phone-reveal", parentRunId: parent.id });
  const call = await insertTestRun({ ...base, serviceName: "twilio-service", taskName: "place-call", parentRunId: parent.id });
  const grandchild = await insertTestRun({ ...base, serviceName: "twilio-service", taskName: "poll", parentRunId: call.id });
  const sourcing = await insertTestRun({ ...base, serviceName: "lead-service", taskName: "lead-serve", parentRunId: parent.id, featureSlug: OTHER_FEAT });
  const underSourcing = await insertTestRun({ ...base, serviceName: "apollo-service", taskName: "search", parentRunId: sourcing.id });
  for (const [runId, total] of [[lookup.id, "50.5"], [call.id, "35.75"], [underSourcing.id, "7"]] as const) {
    await insertTestRunCost({ runId, costName: "c", quantity: "1", unitCostInUsdCents: total, totalCostInUsdCents: total, status: "actual" });
  }
  return { parent, lookup, call, grandchild, sourcing, underSourcing };
}

async function slugsOf(ids: string[]) {
  const rows = await db.select({ id: runs.id, featureSlug: runs.featureSlug }).from(runs).where(inArray(runs.id, ids));
  return Object.fromEntries(rows.map((r) => [r.id, r.featureSlug]));
}

describe("POST /internal/runs/feature-slug-corrections", () => {
  beforeEach(async () => {
    await cleanTestData([ORG_ID]);
    await cleanBronze();
    await stamp(true);
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await cleanBronze();
    await stamp(true);
    await closeDb();
  });

  it("401 without the API key, 400 on an invalid body", async () => {
    expect((await request(app).post(PATH).send({})).status).toBe(401);
    const bad = await request(app).post(PATH).set(internal).send({ rootRunIds: [], featureSlug: FEAT, reason: "r", correctedBy: "x" });
    expect(bad.status).toBe(400);
  });

  it("fills the NULL slugs of the subtree, records one bronze event per run, and the campaign's feature cost read counts it", async () => {
    const campaignId = randomUUID();
    const t = await seedSubtree(campaignId);

    expect(await campaignCost(campaignId, FEAT)).toBe("0");

    const res = await request(app).post(PATH).set(internal).send({
      rootRunIds: [t.parent.id], featureSlug: FEAT, reason: "DIS-373 parent opened without slug", correctedBy: "staff:test",
    });
    expect(res.status).toBe(200);
    expect(res.body.correctedRuns).toBe(4);
    expect(new Set(res.body.correctedRunIds)).toEqual(new Set([t.parent.id, t.lookup.id, t.call.id, t.grandchild.id]));

    const slugs = await slugsOf(Object.values(t).map((r) => r.id));
    expect(slugs[t.parent.id]).toBe(FEAT);
    expect(slugs[t.lookup.id]).toBe(FEAT);
    expect(slugs[t.call.id]).toBe(FEAT);
    expect(slugs[t.grandchild.id]).toBe(FEAT);
    expect(slugs[t.sourcing.id]).toBe(OTHER_FEAT);
    expect(slugs[t.underSourcing.id]).toBeNull();

    const events = await db.select().from(runLifecycleEvents).where(inArray(runLifecycleEvents.runId, res.body.correctedRunIds));
    expect(events).toHaveLength(4);
    for (const e of events) {
      expect(e.eventType).toBe("run.feature_slug_corrected");
      expect(e.payload).toMatchObject({ featureSlug: FEAT, reason: "DIS-373 parent opened without slug", correctedBy: "staff:test" });
    }

    // Rollup read and live read agree, and both count the corrected costs.
    const rolled = await campaignCost(campaignId, FEAT);
    await stamp(false);
    const live = await campaignCost(campaignId, FEAT);
    await stamp(true);
    expect(Number(rolled)).toBeCloseTo(86.25, 8);
    expect(rolled).toBe(live);
  });

  it("is idempotent: a re-run corrects nothing and writes no event", async () => {
    const t = await seedSubtree(randomUUID());
    const body = { rootRunIds: [t.parent.id], featureSlug: FEAT, reason: "r", correctedBy: "staff:test" };
    expect((await request(app).post(PATH).set(internal).send(body)).body.correctedRuns).toBe(4);
    const again = await request(app).post(PATH).set(internal).send(body);
    expect(again.status).toBe(200);
    expect(again.body.correctedRuns).toBe(0);
    const events = await db.select().from(runLifecycleEvents).where(inArray(runLifecycleEvents.runId, [t.parent.id]));
    expect(events.filter((e) => e.eventType === "run.feature_slug_corrected")).toHaveLength(1);
  });

  it("404 on an unknown root, 409 on a root stating another slug; nothing written", async () => {
    const t = await seedSubtree(randomUUID());
    const missing = randomUUID();
    const r404 = await request(app).post(PATH).set(internal).send({ rootRunIds: [t.parent.id, missing], featureSlug: FEAT, reason: "r", correctedBy: "x" });
    expect(r404.status).toBe(404);
    expect(r404.body.missingRunIds).toEqual([missing]);

    const r409 = await request(app).post(PATH).set(internal).send({ rootRunIds: [t.parent.id, t.sourcing.id], featureSlug: FEAT, reason: "r", correctedBy: "x" });
    expect(r409.status).toBe(409);
    expect(r409.body.conflictingRuns).toEqual([{ runId: t.sourcing.id, featureSlug: OTHER_FEAT }]);

    expect((await slugsOf([t.parent.id]))[t.parent.id]).toBeNull();
  });
});
