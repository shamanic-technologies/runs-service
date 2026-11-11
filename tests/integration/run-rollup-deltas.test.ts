import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { sql as rawSql } from "../../src/db/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { drainRunRollupDeltas } from "../../src/services/run-rollup-drain.js";
import { rebuildRollup } from "../../src/services/stats-rollup.js";

// SEND-RUN-LATENCY-1111 (migration 0109): a session with `runs.defer_run_rollups = on` queues a new
// run's rollup +1s (and the day x status counter's moves) in run_rollup_deltas; the drain folds them.
// Guard: the same writes made by a SYNCHRONOUS session (org SYNC) and a DEFERRED one (org DEF), then
// drained, leave the seven rollups' rows identical (org column aside), and nothing is counted until
// the drain. Red if a trigger still upserts while deferring, or the drain miscounts a key.

const SYNC = "0109aaaa-1111-4aaa-8aaa-111111111111";
const DEF = "0109aaaa-2222-4aaa-8aaa-222222222222";
const TAG = `rrd-${randomUUID().slice(0, 8)}`;
const url = process.env.RUNS_SERVICE_DATABASE_URL!;
const deferred = postgres(url, { max: 4, connection: { "runs.defer_run_rollups": "on" } });
const sync = postgres(url, { max: 4 });

type Spec = { campaign: string | null; brands: string[] | null; audience: string | null; feature: string; workflow: string | null; task: string; startedAt: string; complete?: boolean };

const BASE = Date.parse("2026-11-10T22:30:00Z");
const specs: Spec[] = Array.from({ length: 24 }, (_, i) => ({
  campaign: i % 3 === 0 ? null : `${TAG}-c${i % 3}`,
  brands: i % 4 === 0 ? null : [`${TAG}-b${i % 2}`],
  audience: i % 5 === 0 ? null : `${TAG}-a${i % 2}`,
  feature: `${TAG}-f${i % 2}`,
  workflow: i % 2 === 0 ? null : `${TAG}-w`,
  task: `POST /t${i % 3}`,
  // Spans an hour and a UTC midnight, so hour + day keys differ within one batch.
  startedAt: new Date(BASE + i * 7 * 60_000).toISOString(),
  complete: i % 2 === 0,
}));

async function write(client: postgres.Sql, org: string, s: Spec) {
  const id = randomUUID();
  const payload = {
    runId: id, parentRunId: null, organizationId: org, userId: null, brandIds: s.brands, campaignId: s.campaign,
    workflowSlug: s.workflow, featureSlug: s.feature, audienceId: s.audience, serviceName: "postmark-service",
    taskName: s.task, idempotencyKey: null,
  };
  // started_at = the event's occurred_at (projection): pinned so both orgs share the same day / hour keys.
  await client`INSERT INTO run_lifecycle_events (run_id, event_type, payload, identity, occurred_at) VALUES (${id}, 'run.created', ${client.json(payload)}, ${client.json({ orgId: org })}, ${s.startedAt}::timestamptz)`;
  if (s.complete) {
    await client`INSERT INTO run_lifecycle_events (run_id, event_type, payload, identity) VALUES (${id}, 'run.completed', ${client.json({ from: "running", to: "completed" })}, ${client.json({ orgId: org })})`;
  }
  return id;
}

const ORG_TABLES: Record<string, string> = {
  stats_rollup_campaign_runs: "campaign_id, day, brand_ids, feature_slug, workflow_slug, run_count, min_started_at, max_started_at, minmax_stale",
  stats_rollup_audience_runs: "campaign_id, day, brand_ids, feature_slug, workflow_slug, audience_id, run_count, min_started_at, max_started_at, minmax_stale",
  stats_rollup_org_hour: "brand_ids, campaign_id, hour, run_count, min_started_at, max_started_at, minmax_stale",
  stats_rollup_org_task: "service_name, task_name, campaign_id, day, run_count, min_started_at, max_started_at, minmax_stale",
  stats_rollup_task_day: "campaign_id, feature_slug, service_name, task_name, day, brand_ids, run_count, committed_run_count, min_started_at, max_started_at, minmax_stale",
};

async function orgRows(org: string) {
  const out: Record<string, unknown[]> = {};
  for (const [t, cols] of Object.entries(ORG_TABLES)) {
    out[t] = await rawSql.unsafe(`SELECT ${cols} FROM ${t} WHERE organization_id = $1 AND run_count <> 0 ORDER BY ${cols}`, [org]);
  }
  return out;
}

const featureRuns = () => rawSql`SELECT feature_slug, workflow_slug, run_count FROM stats_rollup_runs WHERE feature_slug LIKE ${TAG + "%"} ORDER BY 1, 2`;
const runDay = () => rawSql`SELECT day::text, status, run_count::int FROM stats_rollup_run_day ORDER BY 1, 2`;

describe("SEND-RUN-LATENCY-1111: deferred run rollups", () => {
  beforeAll(async () => {
    await cleanTestData([SYNC, DEF]);
    await drainRunRollupDeltas(rawSql);
  });
  afterAll(async () => {
    await cleanTestData([SYNC, DEF]);
    await deferred.end();
    await sync.end();
    await closeDb();
  });

  it("queues instead of upserting, and the drain lands on exactly the synchronous rows", async () => {
    const day0 = await runDay();
    for (const s of specs) await write(sync, SYNC, s);
    const daySync = await runDay();
    const syncFeature = await featureRuns();

    for (const s of specs) await write(deferred, DEF, s);
    // Nothing counted yet: the deferred org has no rollup row, the fleet counters did not move.
    const before = await orgRows(DEF);
    for (const rows of Object.values(before)) expect(rows).toEqual([]);
    expect(await runDay()).toEqual(daySync);
    expect(await featureRuns()).toEqual(syncFeature);
    const [{ n }] = await rawSql`SELECT count(*)::int AS n FROM run_rollup_deltas`;
    expect(n).toBe(specs.length + specs.filter((s) => s.complete).length * 2);

    expect(await drainRunRollupDeltas(rawSql)).toBe(n);
    expect(await orgRows(DEF)).toEqual(await orgRows(SYNC));

    // Fleet counters moved by exactly twice the synchronous org's move.
    const delta = (a: { day: string; status: string; run_count: number }[], b: typeof a) => {
      const m = new Map<string, number>();
      for (const r of b) m.set(`${r.day}|${r.status}`, r.run_count);
      for (const r of a) m.set(`${r.day}|${r.status}`, (m.get(`${r.day}|${r.status}`) ?? 0) - r.run_count);
      return [...m.entries()].filter(([, v]) => v !== 0).sort();
    };
    const syncMove = delta(day0 as any, daySync as any);
    expect(syncMove.length).toBeGreaterThan(0);
    expect(delta(daySync as any, (await runDay()) as any)).toEqual(syncMove);
    expect((await featureRuns()).map((r: any) => [r.feature_slug, r.workflow_slug, Number(r.run_count)]))
      .toEqual(syncFeature.map((r: any) => [r.feature_slug, r.workflow_slug, Number(r.run_count) * 2]));
  });

  it("a rebuild folds the queue under its lock: nothing counted twice", async () => {
    await cleanTestData([SYNC, DEF]);
    await drainRunRollupDeltas(rawSql);
    for (const s of specs.slice(0, 6)) await write(sync, SYNC, s);
    for (const s of specs.slice(0, 6)) await write(deferred, DEF, s);
    // Queued, not drained, when the rebuild starts.
    const [{ n }] = await rawSql`SELECT count(*)::int AS n FROM run_rollup_deltas`;
    expect(n).toBeGreaterThan(0);
    await rebuildRollup(url, {
      name: "rrd_test_org_task",
      tables: ["stats_rollup_org_task"],
      aggregate: async (b) => {
        await b`CREATE TEMP TABLE rebuild_rrd AS
          SELECT organization_id, service_name, task_name, campaign_id, (started_at AT TIME ZONE 'UTC')::date AS day,
            count(*)::bigint AS run_count, min(started_at) AS mn, max(started_at) AS mx
          FROM runs GROUP BY 1, 2, 3, 4, 5`;
      },
      merge: async (tx) => {
        await tx`INSERT INTO stats_rollup_org_task (organization_id, service_name, task_name, campaign_id, day, run_count, min_started_at, max_started_at)
          SELECT organization_id, service_name, task_name, campaign_id, day, run_count, mn, mx FROM rebuild_rrd
          ON CONFLICT ON CONSTRAINT stats_rollup_org_task_key DO UPDATE SET
            run_count = stats_rollup_org_task.run_count + EXCLUDED.run_count,
            min_started_at = LEAST(stats_rollup_org_task.min_started_at, EXCLUDED.min_started_at),
            max_started_at = GREATEST(stats_rollup_org_task.max_started_at, EXCLUDED.max_started_at)`;
        return { runGroups: 0, costGroups: 0 };
      },
    } as any);
    await drainRunRollupDeltas(rawSql);
    const [{ q }] = await rawSql`SELECT count(*)::int AS q FROM run_rollup_deltas`;
    expect(q).toBe(0);
    const count = async (org: string) =>
      (await rawSql`SELECT coalesce(sum(run_count), 0)::int AS c FROM stats_rollup_org_task WHERE organization_id = ${org}`)[0].c;
    expect(await count(DEF)).toBe(6);
    expect(await count(SYNC)).toBe(6);
  });
});
