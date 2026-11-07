import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createTestApp, getInternalAuthHeaders } from "../helpers/test-app.js";
import { closeDb } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { ALLOCATION_VERSION } from "../../src/services/outcome-ledger.js";
import { clearLedgerDayCache, ledgerDayCacheStats } from "../../src/services/ledger-day-cache.js";

// LEDGER-LOAD-1107-RUNS: the outcome ledger read keeps per-day partials keyed on each
// stored day's version (computed_at + flags). Same stored rows => the SAME body,
// byte for byte, as the live read; a day re-stored (new computed_at) is re-read, the
// other days are not.

const app = createTestApp();
const DAYS = ["2025-10-20", "2025-10-21", "2025-10-22"];
const RANGE = `since=${DAYS[0]}&until=${DAYS[2]}`;
const ORG_A = "0c05acc0-1107-4c0a-8b1e-0000000000a1";
const ORG_B = "0c05acc0-1107-4c0a-8b1e-0000000000a2";
const BRAND = "brand-ldc-1107";

// Dimension values chosen to trip a byte-order sort: hyphen vs none, case, NULL.
const CAMPAIGNS = ["cmp-a", "cmpa", "Cmp-B", null];
const KEYS = ["lead_found", "lead-found", "email_sent", "meeting_booked"];
const KINDS = ["produced_count", "produced_cost", "consumed", "none", "abnormal", "parallel_cost", "parallel_none", "produced_elsewhere"];

let seq = 0;
const money = () => {
  seq++;
  // up to 10 decimals, distinct per row so a dropped or doubled row changes a sum
  return { gross: `${seq}.${String(seq * 7919).padStart(10, "0").slice(0, 10)}`, net: `${seq * 0.5}`, vendor: `0.000000000${seq % 10}`, unpriced: seq % 3 === 0 ? "0" : `${seq}.1` };
};

async function insertRow(day: string, kind: string, i: number) {
  const m = money();
  const camp = CAMPAIGNS[i % CAMPAIGNS.length];
  const key = KEYS[i % KEYS.length];
  await db.execute(sql`
    INSERT INTO outcome_cost_days (day, allocation_version, kind, outcome_key, consumed_outcome_key, organization_id, cost_organization_id, brand_ids,
      campaign_id, workflow_slug, feature_slug, n, quantity, reuses, unknown_provenance, gross, net, vendor, unpriced_gross,
      reuse_gross, reuse_net, reuse_vendor, reuse_unpriced_gross, support_function, run_start_day, source_day, source_run_start_day,
      abnormal_reason, pipe_target, factory, source_brand_ids, source_campaign_id)
    VALUES (${day}::date, ${ALLOCATION_VERSION}, ${kind}, ${key}, ${kind === "consumed" ? KEYS[(i + 1) % KEYS.length] : null},
      ${i % 2 === 0 ? ORG_A : ORG_B}::uuid, ${i % 3 === 0 ? null : ORG_A}::uuid,
      ${i % 4 === 0 ? `{${BRAND},other-brand}` : i % 4 === 1 ? `{${BRAND}}` : i % 4 === 2 ? "{}" : null}::text[],
      ${camp}, ${i % 2 ? "wf-1" : "wf-2"}, ${i % 3 ? "feat-x" : "feat-y"}, ${i + 1}, ${(i + 1) * 1.5}, ${i % 2}, ${i % 3},
      ${m.gross}, ${m.net}, ${m.vendor}, ${m.unpriced}, ${m.net}, ${m.vendor}, ${m.gross}, ${m.unpriced},
      ${kind === "none" ? (i % 2 ? "copilot" : "payment_fees") : null}, ${day}::date, ${day}::date, ${day}::date,
      ${kind === "abnormal" ? "target_already_reached" : null}, ${kind === "none" && i % 2 ? KEYS[0] : null},
      ${kind === "produced_elsewhere" ? (i % 2 ? "another_factory" : "no_proof") : null},
      ${kind === "consumed" ? `{${BRAND}}` : null}::text[], ${kind === "consumed" ? camp : null})
  `);
}

async function storeDay(day: string, computedAt: string) {
  await db.execute(sql`
    INSERT INTO cost_ledger_computed_days (day, allocation_version, computed_at, outcome_costs, consumed_sources, support_split, start_days, loss_occurrences,
      owner_service, state_ladder, loss_lines, anchor_spend, state_inputs, pipe_units, our_factory, other_factories, stale)
    VALUES (${day}::date, ${ALLOCATION_VERSION}, ${computedAt}::timestamptz, true, true, true, true, true, true, true, true, true, true, true, true, true, false)
    ON CONFLICT (day, allocation_version) DO UPDATE SET computed_at = EXCLUDED.computed_at
  `);
}

async function cleanup() {
  await db.execute(sql`DELETE FROM outcome_cost_days WHERE day = ANY(${`{${DAYS.join(",")}}`}::date[])`);
  await db.execute(sql`DELETE FROM pipe_unit_days WHERE day = ANY(${`{${DAYS.join(",")}}`}::date[])`);
  await db.execute(sql`DELETE FROM cost_ledger_computed_days WHERE day = ANY(${`{${DAYS.join(",")}}`}::date[])`);
}

async function read(query: string, cache: boolean) {
  if (cache) delete process.env.LEDGER_READ_CACHE;
  else process.env.LEDGER_READ_CACHE = "off";
  try {
    const res = await request(app).get(`/internal/stats/outcome-costs?${query}`).set(getInternalAuthHeaders());
    expect(res.status).toBe(200);
    return res.text;
  } finally {
    delete process.env.LEDGER_READ_CACHE;
  }
}

const QUERIES = [
  `groupBy=outcomeKey,day&brandId=${BRAND}`,
  `groupBy=outcomeKey,campaignId,orgId&brandId=${BRAND}`,
  "groupBy=outcomeKey,campaignId,orgId",
  "groupBy=outcomeKey,day",
  "groupBy=outcomeKey,day&campaignId=cmp-a",
  "groupBy=outcomeKey,day&outcomeKey=lead_found",
  "groupBy=brandId,campaignId",
  "groupBy=sourceBrandId,sourceCampaignId,outcomeKey",
  "groupBy=runStartDay,costOrgId&runStartUntil=2025-10-21",
  "groupBy=",
  `groupBy=&brandId=${BRAND}`,
  "groupBy=workflowSlug,featureSlug&orgId=" + ORG_B,
];

describe("ledger day cache: same stored rows, same body (LEDGER-LOAD-1107-RUNS)", () => {
  beforeAll(async () => {
    await cleanup();
    clearLedgerDayCache();
    let i = 0;
    for (const day of DAYS) {
      for (const kind of KINDS) for (let k = 0; k < 9; k++) await insertRow(day, kind, i++);
      for (let u = 0; u < 4; u++) {
        await db.execute(sql`
          INSERT INTO pipe_unit_days (day, allocation_version, feature_slug, target, unit_id, organization_id)
          VALUES (${day}::date, ${ALLOCATION_VERSION}, ${u % 2 ? "feat-x" : "feat-y"}, ${KEYS[u % 2]},
            ${`00000000-0000-4000-8000-00000000000${u}`}::uuid, ${ORG_A}::uuid)
          ON CONFLICT DO NOTHING
        `);
      }
    }
    // The first two days are stored; the third is not (never cached, read every time).
    await storeDay(DAYS[0], "2026-01-01T00:00:00Z");
    await storeDay(DAYS[1], "2026-01-01T00:00:00Z");
  });

  afterAll(async () => {
    await cleanup();
    await closeDb();
  });

  it("every grouping: cached body == live body, cold and warm", async () => {
    for (const q of QUERIES) {
      const live = await read(`${q}&${RANGE}`, false);
      const cold = await read(`${q}&${RANGE}`, true);
      const warm = await read(`${q}&${RANGE}`, true);
      expect(cold, q).toBe(live);
      expect(warm, q).toBe(live);
    }
    const body = JSON.parse(await read(`groupBy=outcomeKey,campaignId,orgId&${RANGE}`, true));
    expect(body.produced.length).toBeGreaterThan(3);
    expect(body.pipes.length).toBeGreaterThan(0);
  });

  it("a warm read re-reads only the unstored day; a re-stored day is re-read and matches live", async () => {
    const q = `groupBy=outcomeKey,day&brandId=${BRAND}&${RANGE}`;
    await read(q, true);
    const before = ledgerDayCacheStats.daysRead;
    await read(q, true);
    // outcome-costs (3 days, 1 unstored) + pipes (same days, own key): one unstored day each
    expect(ledgerDayCacheStats.daysRead - before).toBe(2);

    // The refresher rewrites day 0 (new rows, new computed_at): the cached read follows.
    await db.execute(sql`DELETE FROM outcome_cost_days WHERE day = ${DAYS[0]}::date AND kind = 'consumed'`);
    await insertRow(DAYS[0], "produced_count", 3);
    await storeDay(DAYS[0], "2026-01-02T00:00:00Z");
    for (const qq of QUERIES) expect(await read(`${qq}&${RANGE}`, true), qq).toBe(await read(`${qq}&${RANGE}`, false));
  });

  it("a row changed WITHOUT a new day version is not re-read (the version is the contract storeLedgerDay keeps)", async () => {
    const q = `groupBy=outcomeKey&${RANGE}`;
    const cached = await read(q, true);
    await db.execute(sql`UPDATE outcome_cost_days SET gross = gross + 1 WHERE day = ${DAYS[1]}::date AND kind = 'produced_cost'`);
    expect(await read(q, true)).toBe(cached);
    expect(await read(q, false)).not.toBe(cached);
    await storeDay(DAYS[1], "2026-01-03T00:00:00Z");
    expect(await read(q, true)).toBe(await read(q, false));
  });
});
