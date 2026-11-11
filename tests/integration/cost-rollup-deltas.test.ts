import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { sql as rawSql } from "../../src/db/index.js";
import { cleanTestData, closeDb } from "../helpers/test-db.js";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { drainCostRollupDeltas, drainRunRollupDeltas } from "../../src/services/run-rollup-drain.js";

// SEND-RUN-LATENCY-1111-COST (migration 0110): a session with `runs.defer_cost_rollups = on` queues the
// rollup effects of its cost writes (and run updates) in cost_rollup_deltas instead of upserting shared
// rows; the drain applies them. Guards:
//  1. The same history written by a SYNCHRONOUS session (org SYNC) and by a DEFERRING one (org DEF, both
//     queues on, like the service's write pool), then drained, leaves every cost rollup identical (org,
//     labels and run ids aside): inserts, provisioned -> actual, cancel, refund, re-price, an incurred
//     back-dated row, org-paid rows, run completions / failure, then a campaign move, a re-parent and a
//     run delete (which applies the queue inside its own transaction).
//  2. Billing never reads a figure missing a committed cost: before the drain, org-usage-total,
//     org-actual-total and org-no-campaign-total of DEF equal SYNC's, while the queue is not empty.
//  3. Decisions stay exact under concurrency without the shared row lock: 20 concurrent rows of one run
//     count it once per group; a cost racing its run's completion counts in org-actual-total once.

const SYNC = "0110aaaa-1111-4aaa-8aaa-111111111111";
const DEF = "0110aaaa-2222-4aaa-8aaa-222222222222";
const RACE = "0110aaaa-3333-4aaa-8aaa-333333333333";
const TAG = `crd-${randomUUID().slice(0, 8)}`;
const url = process.env.RUNS_SERVICE_DATABASE_URL!;
const deferred = postgres(url, {
  max: 24,
  connection: { "runs.defer_run_rollups": "on", "runs.defer_cost_rollups": "on" },
});
const sync = postgres(url, { max: 4 });

const T0 = Date.parse("2026-11-10T23:40:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

type Client = postgres.Sql;

async function openRun(c: Client, org: string, f: {
  parent?: string | null; campaign: string | null; brands: string[] | null; feature: string | null;
  workflow: string | null; audience: string | null; service: string; task: string; startedAt: string;
}) {
  const id = randomUUID();
  const payload = {
    runId: id, parentRunId: f.parent ?? null, organizationId: org, userId: null, brandIds: f.brands,
    campaignId: f.campaign, workflowSlug: f.workflow, featureSlug: f.feature, audienceId: f.audience,
    serviceName: f.service, taskName: f.task, idempotencyKey: null,
  };
  await c`INSERT INTO run_lifecycle_events (run_id, event_type, payload, identity, occurred_at)
    VALUES (${id}, 'run.created', ${c.json(payload)}, ${c.json({ orgId: org })}, ${f.startedAt}::timestamptz)`;
  return id;
}

async function endRun(c: Client, org: string, runId: string, to: "completed" | "failed") {
  await c`INSERT INTO run_lifecycle_events (run_id, event_type, payload, identity)
    VALUES (${runId}, ${"run." + to}, ${c.json({ from: "running", to })}, ${c.json({ orgId: org })})`;
}

async function addCost(c: Client, org: string, runId: string, f: {
  name: string; qty: string; unit: string; total: string; net?: string | null; status: "actual" | "provisioned";
  source?: "platform" | "org"; audience?: string | null; occurredAt: string; incurredAt?: string;
}) {
  const costId = randomUUID();
  const [{ started_at }] = await c`SELECT started_at FROM runs WHERE id = ${runId}`;
  const payload = {
    costId, costName: f.name, costSource: f.source ?? "platform", quantity: f.qty, unitCostInUsdCents: f.unit,
    totalCostInUsdCents: f.total, netCostInUsdCents: f.net ?? null, usageDiscountPct: null, status: f.status,
    audienceId: f.audience ?? null, runOrganizationId: org, runStartedAt: started_at, idempotencyKey: null,
    ...(f.incurredAt ? { incurredAt: f.incurredAt } : {}),
  };
  await c`INSERT INTO cost_lifecycle_events (run_id, cost_id, event_type, payload, identity, occurred_at)
    VALUES (${runId}, ${costId}, 'cost.added', ${c.json(payload)}, ${c.json({ orgId: org })}, ${f.occurredAt}::timestamptz)`;
  return costId;
}

async function costEvent(c: Client, org: string, runId: string, costId: string, type: string, payload: object = {}) {
  await c`INSERT INTO cost_lifecycle_events (run_id, cost_id, event_type, payload, identity)
    VALUES (${runId}, ${costId}, ${type}, ${c.json(payload as any)}, ${c.json({ orgId: org })})`;
}

/** Phase 1: opens, every cost lifecycle, completions. Returns run ids in a fixed order. */
async function phase1(c: Client, org: string, L: string) {
  const n = (s: string) => `${TAG}-${L}-${s}`;
  const runs: string[] = [];
  const r0 = await openRun(c, org, { campaign: n("c1"), brands: [n("b0")], feature: n("f0"), workflow: n("w0"), audience: n("a0"), service: "workflow", task: "execute-workflow", startedAt: at(0) });
  runs.push(r0);
  const r1 = await openRun(c, org, { parent: r0, campaign: n("c1"), brands: [n("b0"), n("b1")], feature: n("f0"), workflow: n("w0"), audience: n("a0"), service: "postmark-service", task: "POST /send", startedAt: at(5) });
  const r2 = await openRun(c, org, { parent: r0, campaign: null, brands: null, feature: n("f1"), workflow: null, audience: null, service: "chat-service", task: "POST /complete", startedAt: at(12) });
  const r3 = await openRun(c, org, { parent: r0, campaign: n("c1"), brands: [], feature: n("f0"), workflow: n("w1"), audience: n("a1"), service: "postmark-service", task: "POST /send", startedAt: at(21) });
  const r4 = await openRun(c, org, { parent: r1, campaign: n("c1"), brands: [n("b0")], feature: n("f0"), workflow: n("w0"), audience: null, service: "chat-service", task: "POST /judgments", startedAt: at(25) });
  const r5 = await openRun(c, org, { parent: r0, campaign: null, brands: [n("b1")], feature: null, workflow: null, audience: null, service: "apollo-service", task: "enrichment", startedAt: at(33) });
  const r6 = await openRun(c, org, { parent: r0, campaign: n("c2"), brands: [n("b0")], feature: n("f1"), workflow: n("w0"), audience: n("a0"), service: "postmark-service", task: "POST /send", startedAt: at(44) });
  runs.push(r1, r2, r3, r4, r5, r6);

  await endRun(c, org, r5, "completed"); // a cost landing on an already-settled run
  const costs: string[] = [];
  costs.push(await addCost(c, org, r1, { name: "postmark-email-send", qty: "1", unit: "0.1500000000", total: "0.1500000000", net: "0.1200000000", status: "actual", occurredAt: at(6) }));
  costs.push(await addCost(c, org, r1, { name: "postmark-email-send", qty: "1", unit: "0.1500000000", total: "0.1500000000", net: "0.1200000000", status: "actual", audience: n("aX"), occurredAt: at(7) }));
  costs.push(await addCost(c, org, r2, { name: "deepseek-tokens", qty: "1200", unit: "0.0001000000", total: "0.1200000000", status: "provisioned", occurredAt: at(13) }));
  costs.push(await addCost(c, org, r2, { name: "deepseek-tokens", qty: "300", unit: "0.0001000000", total: "0.0300000000", status: "provisioned", occurredAt: at(14) }));
  costs.push(await addCost(c, org, r3, { name: "postmark-email-send", qty: "1", unit: "0.1500000000", total: "0.1500000000", status: "actual", occurredAt: at(22) }));
  costs.push(await addCost(c, org, r4, { name: "anthropic-tokens", qty: "10", unit: "0.0300000000", total: "0.3000000000", status: "actual", source: "org", occurredAt: at(26) }));
  costs.push(await addCost(c, org, r4, { name: "jev-judgment", qty: "1", unit: "0.0200000000", total: "0.0200000000", status: "actual", occurredAt: at(27) }));
  costs.push(await addCost(c, org, r5, { name: "apollo-credit", qty: "2", unit: "1.0000000000", total: "2.0000000000", net: "1.5000000000", status: "actual", occurredAt: at(34) }));
  costs.push(await addCost(c, org, r6, { name: "postmark-email-send", qty: "1", unit: "0.1500000000", total: "0.1500000000", status: "actual", occurredAt: at(45), incurredAt: at(44.5) }));
  await costEvent(c, org, r2, costs[2], "cost.materialized");
  await costEvent(c, org, r2, costs[3], "cost.cancelled");
  await costEvent(c, org, r3, costs[4], "cost.refunded", { reason: "test", refundedBy: "test" });
  await costEvent(c, org, r5, costs[7], "cost.repriced", {
    fromUnitCostInUsdCents: "1.0000000000", newUnitCostInUsdCents: "0.9000000000",
    newTotalCostInUsdCents: "1.8000000000", newNetCostInUsdCents: "1.3500000000",
  });
  await endRun(c, org, r1, "completed");
  await endRun(c, org, r2, "completed");
  await endRun(c, org, r3, "completed");
  await endRun(c, org, r4, "failed");
  return { runs, costs };
}

/** Phase 2: a campaign move, a re-parent, a run delete (the queue is applied inside it), one more cost. */
async function phase2(c: Client, org: string, L: string, runs: string[]) {
  const n = (s: string) => `${TAG}-${L}-${s}`;
  const [r0, r1, , r3, , r5, r6] = runs;
  await c`UPDATE runs SET campaign_id = ${n("c2")} WHERE id = ${r3}`;
  await c`UPDATE runs SET parent_run_id = ${r1} WHERE id = ${r5}`;
  await c`DELETE FROM runs WHERE id = ${r6}`;
  await addCost(c, org, r0, { name: "workflow-step", qty: "1", unit: "0.0100000000", total: "0.0100000000", status: "actual", occurredAt: at(50) });
  await addCost(c, org, r3, { name: "postmark-email-send", qty: "1", unit: "0.1500000000", total: "0.1500000000", status: "actual", occurredAt: at(51) });
}

// Every cost rollup, one row set per org (keys / labels normalized), plus the per-run tables.
const ORG_TABLES = [
  "org_projected_totals", "org_actual_totals", "org_no_campaign_days", "stats_rollup_audience_costs",
  "stats_rollup_audience_runs", "stats_rollup_campaign_costs", "stats_rollup_campaign_runs",
  "stats_rollup_campaign_cost_items", "stats_rollup_cost_name_audience_day", "stats_rollup_consumption_day",
  "stats_rollup_cost_day", "stats_rollup_cost_name_day", "stats_rollup_no_campaign_day", "stats_rollup_org_hour",
  "stats_rollup_org_task", "stats_rollup_task_day", "stats_rollup_task_units",
];

async function snapshot(org: string, L: string, runIds: string[]) {
  const norm = (rows: unknown[]) => rows
    .map((r) => {
      const { updated_at: _u, ...rest } = r as Record<string, unknown>;
      let s = JSON.stringify(rest).split(org).join("ORG").split(`-${L}-`).join("-X-");
      runIds.forEach((id, i) => { s = s.split(id).join(`RUN${i}`); });
      return s;
    })
    .sort();
  const out: Record<string, string[]> = {};
  for (const t of ORG_TABLES) {
    let rows = await rawSql.unsafe(`SELECT * FROM ${t} WHERE organization_id = $1`, [org]);
    // A synchronous cost write creates the org's org_actual_totals row (its lock) even when nothing
    // counts yet; a deferring one does not touch it. A zero row reads as no row (route: '0').
    if (t === "org_actual_totals") rows = rows.filter((r: any) => Number(r.total_cost_in_usd_cents) !== 0);
    out[t] = norm(rows);
  }
  out.run_subtree_costs = norm(await rawSql`SELECT * FROM run_subtree_costs WHERE run_id = ANY(${runIds}::uuid[])`);
  out.run_subtree_cost_items = norm(await rawSql`SELECT * FROM run_subtree_cost_items WHERE run_id = ANY(${runIds}::uuid[])`);
  out.stats_rollup_root_cost = norm(await rawSql`SELECT * FROM stats_rollup_root_cost WHERE root_run_id = ANY(${runIds}::uuid[])`);
  out.stats_rollup_costs = norm(await rawSql`SELECT * FROM stats_rollup_costs WHERE feature_slug LIKE ${`${TAG}-${L}-%`}`);
  return out;
}

const fleetDay = async () =>
  rawSql`SELECT day::text, n_rows::int AS n, gross::text FROM stats_rollup_platform_cost_day ORDER BY 1`;
const fleetNullFeature = async () =>
  rawSql`SELECT cost_source, n_actual::int, n_provisioned::int, gross_actual::text, gross_provisioned::text, net_actual::text
    FROM stats_rollup_costs WHERE feature_slug IS NULL AND workflow_slug IS NULL ORDER BY 1`;

function moves<T extends Record<string, unknown>>(before: T[], after: T[], key: (r: T) => string, nums: (keyof T)[]) {
  const m = new Map<string, number[]>();
  for (const r of after) m.set(key(r), nums.map((k) => Number(r[k])));
  for (const r of before) {
    const cur = m.get(key(r)) ?? nums.map(() => 0);
    m.set(key(r), cur.map((v, i) => +(v - Number(r[nums[i]])).toFixed(10)));
  }
  return [...m.entries()].filter(([, v]) => v.some((x) => x !== 0)).sort();
}

const queued = async () => (await rawSql`SELECT count(*)::int AS n FROM cost_rollup_deltas`)[0].n as number;

describe("SEND-RUN-LATENCY-1111-COST: deferred cost rollups", () => {
  const app = createTestApp();
  const headers = getInternalAuthHeaders();
  const billing = async (org: string) => {
    const usage = await request(app).get("/internal/org-usage-total").set(headers).query({ org_id: org });
    const actual = await request(app).get("/internal/org-actual-total").set(headers).query({ org_id: org });
    const noCampaign = await request(app).get("/internal/org-no-campaign-total").set(headers)
      .query({ org_id: org, since: "2026-11-10T00:00:00.000Z" });
    expect(usage.status).toBe(200);
    expect(actual.status).toBe(200);
    expect(noCampaign.status).toBe(200);
    return {
      spent: usage.body.spent_cents, net: usage.body.net_spent_cents,
      actual: actual.body.total_expected_cents, netActual: actual.body.net_total_expected_cents,
      nc: [noCampaign.body.spent_cents, noCampaign.body.net_spent_cents, noCampaign.body.total_expected_cents, noCampaign.body.net_total_expected_cents],
    };
  };

  beforeAll(async () => {
    await cleanTestData([SYNC, DEF, RACE]);
    await drainRunRollupDeltas(rawSql);
    await drainCostRollupDeltas(rawSql);
  });
  afterAll(async () => {
    await cleanTestData([SYNC, DEF, RACE]);
    await drainCostRollupDeltas(rawSql);
    await deferred.end();
    await sync.end();
    await closeDb();
  });

  it("queues instead of upserting; billing reads exact while queued; the drain lands on the synchronous rows", async () => {
    const day0 = await fleetDay();
    const nf0 = await fleetNullFeature();
    const s = await phase1(sync, SYNC, "S");
    const day1 = await fleetDay();
    const nf1 = await fleetNullFeature();
    expect(await queued()).toBe(0);

    const d = await phase1(deferred, DEF, "D");
    // Queued, nothing applied to the org's shared rows yet.
    expect(await queued()).toBeGreaterThan(100);
    expect(await rawSql`SELECT 1 FROM org_projected_totals WHERE organization_id = ${DEF}`).toEqual([]);
    expect(await rawSql`SELECT 1 FROM stats_rollup_cost_name_day WHERE organization_id = ${DEF}`).toEqual([]);
    expect(await fleetDay()).toEqual(day1);
    // Billing reads row + queue: same figures as the synchronous org, at this instant.
    const syncBilling = await billing(SYNC);
    expect(Number(syncBilling.spent)).toBeGreaterThan(0);
    expect(Number(syncBilling.actual)).toBeGreaterThan(0);
    expect(await billing(DEF)).toEqual(syncBilling);

    await drainRunRollupDeltas(rawSql);
    expect(await drainCostRollupDeltas(rawSql)).toBeGreaterThan(100);
    expect(await queued()).toBe(0);
    expect(await billing(DEF)).toEqual(syncBilling);
    expect(await snapshot(DEF, "D", d.runs)).toEqual(await snapshot(SYNC, "S", s.runs));
    // Fleet-keyed rows (no org column) moved exactly as the synchronous history moved them.
    const day2 = await fleetDay();
    const dayKey = (r: any) => r.day;
    expect(moves(day1 as any[], day2 as any[], dayKey, ["n", "gross"])).toEqual(moves(day0 as any[], day1 as any[], dayKey, ["n", "gross"]));
    const nfKey = (r: any) => r.cost_source;
    const nfNums = ["n_actual", "n_provisioned", "gross_actual", "gross_provisioned", "net_actual"];
    expect(moves(nf1 as any[], (await fleetNullFeature()) as any[], nfKey, nfNums as any)).toEqual(moves(nf0 as any[], nf1 as any[], nfKey, nfNums as any));

    // Phase 2: moves, re-parent, delete (applies the queue in its transaction), more costs.
    await phase2(sync, SYNC, "S", s.runs);
    await phase2(deferred, DEF, "D", d.runs);
    expect(await queued()).toBeGreaterThan(0);
    expect(await billing(DEF)).toEqual(await billing(SYNC));
    await drainRunRollupDeltas(rawSql);
    await drainCostRollupDeltas(rawSql);
    expect(await snapshot(DEF, "D", d.runs)).toEqual(await snapshot(SYNC, "S", s.runs));
    expect(await billing(DEF)).toEqual(await billing(SYNC));
  });

  it("a run delete applies the queued calls inside its own transaction", async () => {
    const r = await openRun(deferred, RACE, { campaign: `${TAG}-del`, brands: null, feature: `${TAG}-del`, workflow: null, audience: null, service: "postmark-service", task: "POST /send", startedAt: at(0) });
    const child = await openRun(deferred, RACE, { parent: r, campaign: `${TAG}-del`, brands: null, feature: `${TAG}-del`, workflow: null, audience: null, service: "postmark-service", task: "POST /send", startedAt: at(1) });
    await addCost(deferred, RACE, child, { name: "postmark-email-send", qty: "1", unit: "0.1500000000", total: "0.1500000000", status: "actual", occurredAt: at(2) });
    expect(await queued()).toBeGreaterThan(0);
    await deferred`DELETE FROM runs WHERE id = ${child}`;
    // The delete's own moves are queued again; once applied, the parent's subtree no longer carries
    // the deleted child's cost and no row was re-created for the deleted run (without the in-delete
    // flush: the subtree triggers skip a run with no item row yet and the queued call re-creates it).
    await drainCostRollupDeltas(rawSql);
    const [p] = await rawSql`SELECT n_rows::int AS n, gross_actual::text AS g FROM run_subtree_costs WHERE run_id = ${r}`;
    expect(p).toEqual({ n: 0, g: "0.0000000000" });
    expect(await rawSql`SELECT 1 FROM run_subtree_costs WHERE run_id = ${child}`).toEqual([]);
    await deferred`DELETE FROM runs WHERE id = ${r}`;
    await drainRunRollupDeltas(rawSql);
    await drainCostRollupDeltas(rawSql);
  });

  it("decisions stay exact under concurrency: one run counted once, a cost racing its run's completion counted once", async () => {
    await cleanTestData([RACE]);
    await drainRunRollupDeltas(rawSql);
    await drainCostRollupDeltas(rawSql);
    const one = await openRun(deferred, RACE, { campaign: `${TAG}-race`, brands: [`${TAG}-b`], feature: `${TAG}-race`, workflow: null, audience: null, service: "chat-service", task: "POST /complete", startedAt: at(0) });
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      addCost(deferred, RACE, one, { name: "deepseek-tokens", qty: "1", unit: "0.0100000000", total: "0.0100000000", status: "actual", occurredAt: at(1 + i / 100) })));

    const racers = await Promise.all(Array.from({ length: 20 }, () =>
      openRun(deferred, RACE, { campaign: `${TAG}-race`, brands: [`${TAG}-b`], feature: `${TAG}-race`, workflow: null, audience: null, service: "postmark-service", task: "POST /send", startedAt: at(2) })));
    await Promise.all(racers.flatMap((id) => [
      addCost(deferred, RACE, id, { name: "postmark-email-send", qty: "1", unit: "0.1500000000", total: "0.1500000000", status: "actual", occurredAt: at(3) }),
      endRun(deferred, RACE, id, "completed"),
    ]));

    // While queued, billing reads the ledger's exact figures.
    const ledger = await request(app).get("/internal/runs-expected-totals").set(headers).query({ org_id: RACE });
    const actual = await request(app).get("/internal/org-actual-total").set(headers).query({ org_id: RACE });
    expect(actual.body.total_expected_cents).toBe(ledger.body.total_expected_cents);
    expect(ledger.body.total_expected_cents).toBe("3.0000000000");

    await drainRunRollupDeltas(rawSql);
    await drainCostRollupDeltas(rawSql);
    const after = await request(app).get("/internal/org-actual-total").set(headers).query({ org_id: RACE });
    expect(after.body.total_expected_cents).toBe("3.0000000000");
    const [cn] = await rawSql`SELECT run_count::int AS r, n_actual::int AS n FROM stats_rollup_cost_name_day
      WHERE organization_id = ${RACE} AND cost_name = 'deepseek-tokens'`;
    expect(cn).toEqual({ r: 1, n: 20 });
    const [tu] = await rawSql`SELECT run_count::int AS r, n_actual::int AS n FROM stats_rollup_task_units
      WHERE organization_id = ${RACE} AND cost_name = 'deepseek-tokens'`;
    expect(tu).toEqual({ r: 1, n: 20 });
    const [td] = await rawSql`SELECT committed_run_count::int AS c FROM stats_rollup_task_day
      WHERE organization_id = ${RACE} AND task_name = 'POST /complete'`;
    expect(td).toEqual({ c: 1 });
  });
});
