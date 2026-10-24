import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { Decimal } from "decimal.js";
import { createTestApp, getAuthHeaders, getInternalAuthHeaders } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";
import { ALLOCATION_VERSION, addDays, computeLedgerDay, storeLedgerDay, utcDay } from "../../src/services/outcome-ledger.js";
import { MAX_OUTCOME_COST_GROUPS } from "../../src/services/outcome-cost-totals.js";

// COST-ACCOUNTING-1023-P2: the outcome ledger read as totals. Every figure must be
// the exact sum of /internal/outcome-occurrences rows, and grouped by cost org x
// day, produced cost + produced none = the ledger check's ledger.

const ORG = "0c05acc0-1023-4c0a-8b1e-0000000000a1";
const ORG_B = "0c05acc0-1023-4c0a-8b1e-0000000000a2";
const B1 = "brand-p2-1";
const B2 = "brand-p2-2";

const catalog = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/vendor-costs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/vendor-costs.js")>();
  return { ...actual, fetchVendorCostCatalog: catalog.fn };
});
const stepCatalogue = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../../src/services/outcome-catalogue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/outcome-catalogue.js")>();
  return { ...actual, unknownOutcomeKeys: stepCatalogue.fn };
});

const VERSIONS = [
  { costName: "tok", provider: "acme", servedFrom: "2024-01-01T00:00:00Z", billedUnitCostInUsdCents: "5", vendorUnitCostInUsdCents: "1" },
];

const app = createTestApp();
const TODAY = utcDay(new Date());
const YESTERDAY = addDays(TODAY, -1);
const platformRunIds: string[] = [];

async function cost(runId: string, qty: string, unit: string, day: string, opts: { discountPct?: string; costName?: string } = {}) {
  const gross = new Decimal(qty).times(unit);
  await insertTestRunCost({
    runId,
    costName: opts.costName ?? "tok",
    quantity: qty,
    unitCostInUsdCents: unit,
    totalCostInUsdCents: gross.toFixed(10),
    ...(opts.discountPct && {
      netCostInUsdCents: gross.times(new Decimal(1).minus(opts.discountPct)).toFixed(10),
      usageDiscountPct: opts.discountPct,
    }),
    status: "actual",
    createdAt: new Date(`${day}T00:00:01Z`),
  });
}

const run = (extra: Partial<Parameters<typeof insertTestRun>[0]> = {}) =>
  insertTestRun({
    organizationId: ORG,
    serviceName: "svc",
    taskName: "task",
    status: "completed",
    startedAt: new Date(`${YESTERDAY}T00:00:00Z`),
    ...extra,
  });

const occ = (outcomeKey: string, subjectId: string, quantity?: number) => ({
  outcomeKey,
  subjectService: "lead-service",
  subjectId,
  ...(quantity !== undefined && { quantity }),
});

async function declare(runId: string, body: unknown, orgId = ORG) {
  const res = await request(app).post(`/v1/runs/${runId}/outcomes`).set(getAuthHeaders({ orgId })).send(body);
  expect([200, 201]).toContain(res.status);
}

async function totals(query: string) {
  const res = await request(app).get(`/internal/stats/outcome-costs?${query}`).set(getInternalAuthHeaders());
  return res;
}

async function allOccurrences(orgId: string) {
  const out: any[] = [];
  let cursor: string | null = null;
  do {
    const res: any = await request(app)
      .get(`/internal/outcome-occurrences?orgId=${orgId}&limit=1000${cursor ? `&cursor=${cursor}` : ""}`)
      .set(getInternalAuthHeaders());
    expect(res.status).toBe(200);
    out.push(...res.body.occurrences);
    cursor = res.body.nextCursor;
  } while (cursor);
  return out;
}

const BASES = ["grossCents", "netCents", "vendorCents", "unpricedGrossCents"] as const;
const addM = (a: any, b: any) => Object.fromEntries(BASES.map((k) => [k, new Decimal(a?.[k] ?? 0).plus(b[k]).toFixed(10)]));
const zeroM = () => Object.fromEntries(BASES.map((k) => [k, "0.0000000000"]));

const ALL_DIMS = ["outcomeKey", "day", "orgId", "costOrgId", "brandId", "campaignId", "workflowSlug", "featureSlug"];
const brandsOf = (o: any) => (o.tags.brandIds.length > 0 ? o.tags.brandIds : [null]);

describe("GET /internal/stats/outcome-costs: the outcome ledger as totals", () => {
  beforeAll(async () => {
    await cleanTestData([ORG, ORG_B]);
    catalog.fn.mockResolvedValue(VERSIONS);
    stepCatalogue.fn.mockResolvedValue([]);

    // A finds 3 emails: 10 yesterday, 5 today (net -10%), + 4 unpriced spent by a platform child (org-less).
    const a = await run({ brandIds: [B1], campaignId: "cmp-1", workflowSlug: "wf-1", featureSlug: "feat-1", serviceName: "apollo-service" });
    await cost(a.id, "2", "5", YESTERDAY);
    await cost(a.id, "1", "5", TODAY, { discountPct: "0.1" });
    const p = await run({ organizationId: null, parentRunId: a.id, serviceName: "chat-service" });
    platformRunIds.push(p.id);
    await cost(p.id, "1", "4", TODAY, { costName: "mystery" });
    await declare(a.id, { produced: [occ("email_found", "s1"), occ("email_found", "s2"), occ("email_found", "s3")] });

    // B (co-branded) checks s1, s2: 6 own + 3 by an undeclaring child.
    const b = await run({ brandIds: [B1, B2], campaignId: "cmp-2", workflowSlug: "wf-2", featureSlug: "feat-1" });
    await cost(b.id, "1.2", "5", TODAY);
    const e = await run({ parentRunId: b.id, brandIds: [B1, B2], campaignId: "cmp-2", workflowSlug: "wf-2", featureSlug: "feat-1" });
    await cost(e.id, "0.6", "5", TODAY);
    await declare(b.id, { produced: [occ("email_checked", "s1"), occ("email_checked", "s2")], consumed: [occ("email_found", "s1"), occ("email_found", "s2")] });

    // C makes two outcomes (quantities 1 and 2), reuses s1, and consumes an email nobody produced.
    const c = await run({ campaignId: "cmp-1", workflowSlug: "wf-1" });
    await cost(c.id, "1.8", "5", TODAY);
    await declare(c.id, {
      produced: [occ("email_checked", "s3", 1), occ("message_written", "m3", 2)],
      consumed: [occ("email_found", "s1"), occ("email_found", "ghost")],
    });

    // H produces nothing and reuses s2; D (ORG_B) spends and states nothing.
    const h = await run({ campaignId: "cmp-1" });
    await cost(h.id, "0.4", "5", TODAY);
    await declare(h.id, { consumed: [occ("email_found", "s2")] });
    const d = await run({ organizationId: ORG_B });
    await cost(d.id, "1.4", "5", TODAY);

    for (const day of [YESTERDAY, TODAY]) await storeLedgerDay(await computeLedgerDay(day, VERSIONS as any));
  });

  afterAll(async () => {
    for (const id of platformRunIds) await db.execute(sql`DELETE FROM runs WHERE id = ${id}::uuid`);
    await cleanTestData([ORG, ORG_B]);
    await closeDb();
  });

  it("AC: on the finest grouping, every group equals the sum of the occurrence rows, on every basis", async () => {
    const rows = await allOccurrences(ORG);
    const expProduced = new Map<string, any>();
    const expConsumed = new Map<string, any>();
    const get = (m: Map<string, any>, k: string, init: () => any) => m.get(k) ?? m.set(k, init()).get(k);
    for (const o of rows) {
      for (const brand of brandsOf(o)) {
        const tags = [brand, o.tags.campaignId, o.tags.workflowSlug, o.tags.featureSlug];
        if (o.direction === "produced") {
          const declared = o.declaredAt.slice(0, 10);
          const g = get(expProduced, JSON.stringify([o.outcomeKey, declared, o.organizationId, o.organizationId, ...tags]), () => ({ n: 0, q: new Decimal(0), cost: zeroM() }));
          g.n += 1;
          g.q = g.q.plus(o.quantity);
          for (const s of o.costSlices) {
            const m = get(expProduced, JSON.stringify([o.outcomeKey, s.day, o.organizationId, s.costOrganizationId, ...tags]), () => ({ n: 0, q: new Decimal(0), cost: zeroM() }));
            m.cost = addM(m.cost, s.cost);
          }
        } else {
          for (const part of o.consumption.consumingOutcomes) {
            const k = JSON.stringify([part.outcomeKey, o.outcomeKey, o.declaredAt.slice(0, 10), o.organizationId, o.organizationId, ...tags]);
            const g = get(expConsumed, k, () => ({ n: new Decimal(0), reuses: new Decimal(0), unknown: new Decimal(0), std: zeroM(), gain: zeroM() }));
            g.n = g.n.plus(part.weight);
            if (o.consumption.reuse) g.reuses = g.reuses.plus(part.weight);
            if (o.consumption.provenance === "unknown") g.unknown = g.unknown.plus(part.weight);
            if (part.standardCost) {
              g.std = addM(g.std, part.standardCost);
              if (o.consumption.reuse) g.gain = addM(g.gain, part.standardCost);
            }
          }
        }
      }
    }

    const res = await totals(`groupBy=${ALL_DIMS.join(",")}&orgId=${ORG}&since=${YESTERDAY}&until=${TODAY}`);
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(true);
    const dimsKey = (d: any, names: string[]) => JSON.stringify(names.map((n) => d[n]));
    const got = new Map(res.body.produced.map((g: any) => [dimsKey(g.dimensions, ALL_DIMS), g]));
    expect(got.size).toBe(expProduced.size);
    for (const [k, e] of expProduced) {
      const g: any = got.get(k);
      expect(g, k).toBeDefined();
      expect(g.occurrences).toBe(e.n);
      expect(g.quantity).toBe(e.q.toFixed(6));
      expect(g.cost).toEqual(e.cost);
    }
    const cDims = ["consumingOutcomeKey", "consumedOutcomeKey", ...ALL_DIMS.filter((d) => d !== "outcomeKey")];
    const gotC = new Map(res.body.consumed.map((g: any) => [dimsKey(g.dimensions, cDims), g]));
    expect(gotC.size).toBe(expConsumed.size);
    for (const [k, e] of expConsumed) {
      const g: any = gotC.get(k);
      expect(g, k).toBeDefined();
      expect(g.consumptions).toBe(e.n.toFixed(10));
      expect(g.reuses).toBe(e.reuses.toFixed(10));
      expect(g.unknownProvenance).toBe(e.unknown.toFixed(10));
      expect(g.standardCost).toEqual(e.std);
      expect(g.reuseGain).toEqual(e.gain);
    }
  });

  it("per outcome: the unit-cost inputs (own cost, occurrences, inputs per pair), exact", async () => {
    const res = await totals(`groupBy=outcomeKey&orgId=${ORG}&since=${YESTERDAY}&until=${TODAY}`);
    const p = Object.fromEntries(res.body.produced.map((g: any) => [g.dimensions.outcomeKey, g]));
    // A: 10 + 5 + 4 (platform child, unpriced) over 3 emails.
    expect(p.email_found.occurrences).toBe(3);
    expect(p.email_found.cost).toEqual({ grossCents: "19.0000000000", netCents: "18.5000000000", vendorCents: "3.0000000000", unpricedGrossCents: "4.0000000000" });
    // B 9 + C's 9 x 1/3 = 12 over 3 checks; C's 9 x 2/3 = 6 on one written message (quantity 2).
    expect(p.email_checked).toMatchObject({ occurrences: 3, quantity: "3.000000" });
    expect(p.email_checked.cost.grossCents).toBe("12.0000000000");
    expect(p.message_written).toMatchObject({ occurrences: 1, quantity: "2.000000" });
    expect(p.message_written.cost.grossCents).toBe("6.0000000000");

    const c = Object.fromEntries(res.body.consumed.map((g: any) => [`${g.dimensions.consumingOutcomeKey}<-${g.dimensions.consumedOutcomeKey}`, g]));
    // 19 / 3 per email found: two read 6.3333333333 and one 6.3333333334 (cumulative rounding, id order).
    const found = (await allOccurrences(ORG)).filter((o) => o.outcomeKey === "email_found" && o.direction === "produced");
    const costOf = (subject: string) => found.find((o) => o.subjectId === subject).cost.grossCents;
    expect(found.reduce((x: Decimal, o: any) => x.plus(o.cost.grossCents), new Decimal(0)).toFixed(10)).toBe("19.0000000000");
    expect(c["email_checked<-email_found"]).toMatchObject({ reuses: "0.3333333333", unknownProvenance: "0.3333333333" });
    expect(c["email_checked<-email_found"].consumptions).toBe("2.6666666666");
    expect(c["message_written<-email_found"].consumptions).toBe("1.3333333334");
    expect(c["null<-email_found"]).toMatchObject({ consumptions: "1.0000000000", reuses: "1.0000000000" });
    expect(c["null<-email_found"].standardCost.grossCents).toBe(costOf("s2"));
    const std = res.body.consumed.reduce((s: Decimal, g: any) => s.plus(g.standardCost.grossCents), new Decimal(0));
    // s1, s2, s1 again, s2 again; ghost has none.
    expect(std.toFixed(10)).toBe(new Decimal(costOf("s1")).plus(costOf("s2")).times(2).toFixed(10));
  });

  it("AC: grouped by cost org and day, produced cost + produced none = the ledger check's ledger", async () => {
    const res = await totals(`groupBy=costOrgId,day&since=${YESTERDAY}&until=${TODAY}`);
    expect(res.status).toBe(200);
    const chk = await request(app).get(`/internal/outcome-costs/ledger-check?since=${YESTERDAY}&until=${TODAY}`).set(getInternalAuthHeaders());
    expect(chk.status).toBe(200);
    const scope = new Map(res.body.scope.map((g: any) => [`${g.dimensions.day}|${g.dimensions.costOrgId}`, g]));
    expect(scope.size).toBe(chk.body.rows.filter((r: any) => r.costRows > 0).length);
    for (const r of chk.body.rows.filter((x: any) => x.costRows > 0)) {
      const g: any = scope.get(`${r.day}|${r.organizationId}`);
      expect(g, `${r.day}|${r.organizationId}`).toBeDefined();
      expect(addM(g.producedCost, g.producedNone)).toEqual(r.ledger);
      expect(g.spend).toEqual(r.ledger);
      expect(g.producedCost).toEqual(r.allocated);
    }
    const mine = res.body.scope.find((g: any) => g.dimensions.day === TODAY && g.dimensions.costOrgId === ORG_B);
    expect(mine.coverageShare.gross).toBe("0.0000000000");
  });

  it("scope by campaign: coverage share of the money the figures stand on", async () => {
    const res = await totals(`groupBy=campaignId&orgId=${ORG}&since=${YESTERDAY}&until=${TODAY}`);
    const s = Object.fromEntries(res.body.scope.map((g: any) => [g.dimensions.campaignId, g]));
    // cmp-1: A 15 + C 9 (+ platform child 4 under A's tags) produced; H's 2 produced nothing.
    expect(s["cmp-1"].producedCost.grossCents).toBe("28.0000000000");
    expect(s["cmp-1"].producedNone.grossCents).toBe("2.0000000000");
    expect(s["cmp-1"].coverageShare.gross).toBe("0.9333333333");
    expect(s["cmp-2"].coverageShare.gross).toBe("1.0000000000");
  });

  it("brand: a co-branded run counts under each brand; a brand filter keeps one row", async () => {
    const res = await totals(`groupBy=brandId,outcomeKey&orgId=${ORG}&since=${YESTERDAY}&until=${TODAY}`);
    const checks = res.body.produced.filter((g: any) => g.dimensions.outcomeKey === "email_checked");
    expect(Object.fromEntries(checks.map((g: any) => [g.dimensions.brandId, g.occurrences]))).toEqual({ null: 1, [B1]: 2, [B2]: 2 });
    const one = await totals(`groupBy=outcomeKey&brandId=${B1}&since=${YESTERDAY}&until=${TODAY}`);
    expect(Object.fromEntries(one.body.produced.map((g: any) => [g.dimensions.outcomeKey, g.occurrences]))).toEqual({ email_found: 3, email_checked: 2 });
  });

  it("AC (P4): consumptions grouped by the PRODUCING run's tags sum exactly to the ungrouped read; unknown provenance stays counted", async () => {
    const q = `orgId=${ORG}&since=${YESTERDAY}&until=${TODAY}`;
    const flat = await totals(`groupBy=&${q}`);
    expect(flat.status).toBe(200);
    const sum = (rows: any[], f: string) => rows.reduce((x: Decimal, g: any) => x.plus(g[f]), new Decimal(0)).toFixed(10);
    const sumM = (rows: any[], f: string) => rows.reduce((x: any, g: any) => addM(x, g[f]), zeroM());

    for (const dim of ["sourceWorkflowSlug", "sourceCampaignId", "sourceBrandId", "sourceOrgId", "sourceFeatureSlug"]) {
      const res = await totals(`groupBy=${dim}&${q}`);
      expect(res.status, dim).toBe(200);
      expect(res.body.complete).toBe(true);
      // Produced and scope ignore source dimensions: byte for byte the ungrouped read.
      expect(res.body.produced).toEqual(flat.body.produced);
      expect(res.body.scope).toEqual(flat.body.scope);
      for (const f of ["consumptions", "reuses", "unknownProvenance"]) expect(sum(res.body.consumed, f), `${dim} ${f}`).toBe(sum(flat.body.consumed, f));
      for (const f of ["standardCost", "reuseGain"]) expect(sumM(res.body.consumed, f), `${dim} ${f}`).toEqual(sumM(flat.body.consumed, f));
    }

    // Every email found was produced by A (wf-1, cmp-1, B1); the ghost has no producer.
    const byWf = await totals(`groupBy=sourceWorkflowSlug,sourceCampaignId,sourceBrandId&${q}`);
    const agg = new Map<string, { n: Decimal; unknown: Decimal }>();
    for (const g of byWf.body.consumed) {
      const k = `${g.dimensions.sourceWorkflowSlug}|${g.dimensions.sourceCampaignId}|${g.dimensions.sourceBrandId}`;
      const e = agg.get(k) ?? { n: new Decimal(0), unknown: new Decimal(0) };
      agg.set(k, { n: e.n.plus(g.consumptions), unknown: e.unknown.plus(g.unknownProvenance) });
    }
    expect(Object.fromEntries([...agg].map(([k, v]) => [k, [v.n.toFixed(10), v.unknown.toFixed(10)]]))).toEqual({
      [`wf-1|cmp-1|${B1}`]: ["4.0000000000", "0.0000000000"],
      "null|null|null": ["1.0000000000", "1.0000000000"],
    });
    // The consuming run's tags still group beside the source's (B consumed under wf-2).
    const both = await totals(`groupBy=workflowSlug,sourceWorkflowSlug&${q}`);
    const pairs = both.body.consumed.filter((g: any) => g.dimensions.workflowSlug === "wf-2");
    expect(pairs.map((g: any) => [g.dimensions.sourceWorkflowSlug, g.consumptions])).toEqual([["wf-1", "2.0000000000"]]);
    expect(both.body.consumed[0].dimensions).toHaveProperty("sourceWorkflowSlug");
    expect(both.body.produced[0].dimensions).not.toHaveProperty("sourceWorkflowSlug");
  });

  it("P4: a day stored before consumed rows carried their source is missing for a source read only", async () => {
    await db.execute(sql`UPDATE cost_ledger_computed_days SET consumed_sources = false WHERE day = ${YESTERDAY}::date`);
    try {
      const src = await totals(`groupBy=sourceWorkflowSlug&orgId=${ORG}&since=${YESTERDAY}&until=${TODAY}`);
      expect(src.body.daysMissing).toEqual([YESTERDAY]);
      const today = await totals(`groupBy=day&orgId=${ORG}&since=${TODAY}&until=${TODAY}`);
      const srcAll = await totals(`groupBy=day,sourceWorkflowSlug&orgId=${ORG}&since=${YESTERDAY}&until=${TODAY}`);
      expect(srcAll.body.produced.map((g: any) => g.dimensions.day)).not.toContain(YESTERDAY);
      expect(srcAll.body.produced.map((g: any) => g.dimensions.day)).toEqual(today.body.produced.map((g: any) => g.dimensions.day));
      const plain = await totals(`groupBy=day&orgId=${ORG}&since=${YESTERDAY}&until=${TODAY}`);
      expect(plain.body.daysMissing).toEqual([]);
      expect(plain.body.produced.map((g: any) => g.dimensions.day)).toContain(YESTERDAY);
      // The refresher recomputes such a day.
      const { daysToCompute } = await import("../../src/services/outcome-ledger.js");
      expect(await daysToCompute(new Date(), YESTERDAY)).toContain(YESTERDAY);
    } finally {
      await db.execute(sql`UPDATE cost_ledger_computed_days SET consumed_sources = true WHERE day = ${YESTERDAY}::date`);
    }
  });

  it("default since = the first day of SPEND, never the first day stored under this version: unstored days read missing", async () => {
    const { firstOutcomeCostDay } = await import("../../src/services/outcome-cost-totals.js");
    const { firstLedgerDay } = await import("../../src/services/outcome-ledger.js");
    // A spend day nobody has stored yet (as after a version bump: only the newest days recomputed).
    const old = addDays(TODAY, -120);
    const run = await insertTestRun({ organizationId: ORG, serviceName: "x-service", taskName: "t", status: "completed", startedAt: new Date(`${old}T10:00:00Z`) });
    await insertTestRunCost({ runId: run.id, costName: "tok", quantity: "1", unitCostInUsdCents: "1", totalCostInUsdCents: "1.0000000000", status: "actual", createdAt: new Date(`${old}T10:01:00Z`) });
    try {
      const first = await firstLedgerDay(TODAY);
      expect(first <= old).toBe(true);
      const res = await totals(`groupBy=`);
      expect(res.status).toBe(200);
      expect(res.body.since).toBe(await firstOutcomeCostDay());
      expect(res.body.since <= old).toBe(true);
      expect(res.body.complete).toBe(false);
      expect(res.body.daysMissing).toContain(old);
    } finally {
      await db.execute(sql`DELETE FROM runs WHERE id = ${run.id}::uuid`);
    }
  });

  it("contract: bad groupBy 400, missing days stated, too many groups 422 (never truncated)", async () => {
    expect((await totals("groupBy=subjectId")).status).toBe(400);
    expect((await totals("groupBy=day,day")).status).toBe(400);
    expect((await totals("orgId=nope")).status).toBe(400);
    const before = addDays(YESTERDAY, -1);
    const gap = await totals(`since=${before}&until=${TODAY}&orgId=${ORG}`);
    expect(gap.status).toBe(200);
    expect(gap.body.daysMissing).toContain(before);
    expect(gap.body.complete).toBe(false);

    const far = "2001-01-01";
    await db.execute(sql`
      INSERT INTO outcome_cost_days (day, allocation_version, kind, outcome_key, organization_id, campaign_id, n)
      SELECT ${far}::date, ${ALLOCATION_VERSION}, 'produced_count', 'email_found', ${ORG}::uuid, 'cap-' || i, 1
      FROM generate_series(1, ${MAX_OUTCOME_COST_GROUPS + 1}) i
    `);
    try {
      const capped = await totals(`groupBy=campaignId&since=${far}&until=${far}`);
      expect(capped.status).toBe(422);
      expect(capped.body.details).toEqual({ section: "produced", maxGroups: MAX_OUTCOME_COST_GROUPS });
    } finally {
      await db.execute(sql`DELETE FROM outcome_cost_days WHERE day = ${far}::date`);
    }
  });
});
