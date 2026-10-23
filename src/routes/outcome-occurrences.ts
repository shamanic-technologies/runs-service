// Outcome occurrences: the production-cost ledger (COST-ACCOUNTING-1023).
// Declaration (POST /v1/runs/:id/outcomes, POST /v1/platform-runs/:id/outcomes),
// cost per occurrence (GET /internal/outcome-occurrences), the to-the-cent check
// (GET /internal/outcome-costs/ledger-check) and the coverage series
// (GET /internal/stats/outcome-coverage). Rules: services/outcome-ledger.ts.

import { Router, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db, statsDb } from "../db/index.js";
import { requireApiKey, requireInternalAuth, requirePlatformAuth } from "../middleware/auth.js";
import { DeclareOutcomesBatchRequestSchema, DeclareRunOutcomesRequestSchema, OUTCOME_UUID_RE, VoidRunOutcomesRequestSchema } from "../schemas.js";
import {
  ALLOCATION_RULE,
  ALLOCATION_VERSION,
  DuplicateOccurrenceInBodyError,
  OutcomeDeclarationConflictError,
  RunOutcomesVoidedError,
  isRunOutcomesVoided,
  voidRunOutcomes,
  addDays,
  normalizeOutcomeKey,
  checkLedgerRow,
  ledgerCheckInputOf,
  declareRunOutcomes,
  declareOutcomesBatch,
  effectiveDeclaredAt,
  listOccurrences,
  utcDay,
  type Direction,
  type Money,
} from "../services/outcome-ledger.js";
import { VendorCostCatalogError } from "../services/vendor-costs.js";
import { OutcomeCatalogueError, unknownOutcomeKeys } from "../services/outcome-catalogue.js";
import {
  MAX_OUTCOME_COST_GROUPS,
  OUTCOME_COST_DIMENSIONS,
  TooManyGroupsError,
  firstOutcomeCostDay,
  readOutcomeCostTotals,
  type OutcomeCostDimension,
} from "../services/outcome-cost-totals.js";

const router = Router();

const wireMoney = (m: Money) => ({
  grossCents: m.gross,
  netCents: m.net,
  vendorCents: m.vendor,
  unpricedGrossCents: m.unpricedGross,
});

async function handleDeclare(req: Request, res: Response, orgRequired: boolean) {
  try {
    const { id } = req.params;
    if (!OUTCOME_UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid run id", details: null });
      return;
    }
    const parsed = DeclareRunOutcomesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    // Every key must be a catalogue step (legacy aliases normalized first).
    const stated = [...(parsed.data.produced ?? []), ...(parsed.data.consumed ?? [])].map((o) => normalizeOutcomeKey(o.outcomeKey));
    const unknown = await unknownOutcomeKeys(stated);
    if (unknown.length > 0) {
      res.status(400).json({
        error: "unknown_outcome_key",
        details: { unknownKeys: unknown, catalogue: "features-service GET /public/catalogue/steps (rows[].key)" },
      });
      return;
    }
    const [run] = (await db.execute(sql`
      SELECT id, organization_id, service_name, started_at FROM runs WHERE id = ${id}::uuid
    `)) as any[];
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const headerOrg = req.orgId as string | undefined;
    if ((orgRequired || headerOrg) && run.organization_id !== (headerOrg ?? null)) {
      res.status(409).json({ error: "run_org_mismatch", conflicts: [] });
      return;
    }
    const effective = effectiveDeclaredAt(parsed.data.occurredAt, run);
    if ("error" in effective) {
      res.status(400).json({ error: "invalid_occurred_at", details: effective.error });
      return;
    }
    if (await isRunOutcomesVoided(id)) throw new RunOutcomesVoidedError(id);
    const occurrences = await declareRunOutcomes(id, parsed.data, req.platformServiceName ?? run.service_name, effective.at);
    const recordedCount = occurrences.filter((o) => o.status === "recorded").length;
    res.status(recordedCount > 0 ? 201 : 200).json({
      runId: id,
      allocationVersion: ALLOCATION_VERSION,
      recordedCount,
      alreadyRecordedCount: occurrences.length - recordedCount,
      occurrences,
    });
  } catch (err) {
    declarationError(res, err);
  }
}

/** The declaration errors both doors share (one run, a batch). */
function declarationError(res: Response, err: unknown) {
  if (err instanceof DuplicateOccurrenceInBodyError) {
    res.status(400).json({ error: "Invalid request", details: err.message });
    return;
  }
  if (err instanceof OutcomeCatalogueError) {
    console.error("[Runs Service] outcome catalogue unreadable, declaration refused:", err.message);
    res.status(502).json({ error: `outcome_catalogue_unavailable: ${err.message}` });
    return;
  }
  if (err instanceof OutcomeDeclarationConflictError) {
    res.status(409).json({ error: err.message, conflicts: err.conflicts });
    return;
  }
  // The handler's check, or the projection's when a void lands between the check and the write.
  // drizzle wraps the database error: the projection's message is on `cause`.
  const dbMessage = `${(err as any)?.message ?? ""} ${(err as any)?.cause?.message ?? ""}`;
  if (err instanceof RunOutcomesVoidedError || dbMessage.includes("run_outcomes_voided")) {
    res.status(409).json({ error: "run_outcomes_voided", conflicts: [] });
    return;
  }
  console.error("[Runs Service] declare outcomes failed:", err);
  res.status(500).json({ error: "Internal server error" });
}

/**
 * Many runs in one call (COST-BACKFILL-1023-RUNS): the backfill door. All or
 * nothing: every run is checked first (exists, org, not voided, occurredAt within
 * bounds); any refusal = 422 with the per-run list and nothing written.
 */
async function handleDeclareBatch(req: Request, res: Response) {
  try {
    const parsed = DeclareOutcomesBatchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const entries = parsed.data.runs.map((r) => ({ ...r, runId: r.runId.toLowerCase() }));
    const stated = entries.flatMap((r) => [...(r.produced ?? []), ...(r.consumed ?? [])].map((o) => normalizeOutcomeKey(o.outcomeKey)));
    const unknown = await unknownOutcomeKeys([...new Set(stated)]);
    if (unknown.length > 0) {
      res.status(400).json({
        error: "unknown_outcome_key",
        details: { unknownKeys: unknown, catalogue: "features-service GET /public/catalogue/steps (rows[].key)" },
      });
      return;
    }
    const ids = `{${entries.map((r) => r.runId).join(",")}}`;
    const runs = (await db.execute(sql`
      SELECT r.id, r.organization_id, r.service_name, r.started_at,
             EXISTS (SELECT 1 FROM outcome_declaration_events e WHERE e.run_id = r.id AND e.event_type = 'outcomes.voided') AS voided
      FROM runs r WHERE r.id = ANY(${ids}::uuid[])
    `)) as any[];
    const byId = new Map(runs.map((r) => [r.id as string, r]));
    const headerOrg = req.orgId as string | undefined;
    const invalid: Array<{ runId: string; reason: string; message?: string }> = [];
    const declarations = entries.map((e) => {
      const run = byId.get(e.runId);
      if (!run) return invalid.push({ runId: e.runId, reason: "run_not_found" }), null;
      if (headerOrg && run.organization_id !== headerOrg) return invalid.push({ runId: e.runId, reason: "run_org_mismatch" }), null;
      if (run.voided) return invalid.push({ runId: e.runId, reason: "run_outcomes_voided" }), null;
      const effective = effectiveDeclaredAt(e.occurredAt, run);
      if ("error" in effective) return invalid.push({ runId: e.runId, reason: "invalid_occurred_at", message: effective.error }), null;
      return { runId: e.runId, body: e, sourceService: req.platformServiceName ?? run.service_name, declaredAt: effective.at };
    });
    if (invalid.length > 0) {
      res.status(422).json({ error: "invalid_runs", details: { invalid } });
      return;
    }
    const results = await declareOutcomesBatch(declarations.filter((d) => d !== null));
    const out = entries.map((e, i) => {
      const recordedCount = results[i].filter((o) => o.status === "recorded").length;
      return { runId: e.runId, recordedCount, alreadyRecordedCount: results[i].length - recordedCount, occurrences: results[i] };
    });
    const recordedCount = out.reduce((n, r) => n + r.recordedCount, 0);
    res.status(recordedCount > 0 ? 201 : 200).json({
      allocationVersion: ALLOCATION_VERSION,
      recordedCount,
      alreadyRecordedCount: out.reduce((n, r) => n + r.alreadyRecordedCount, 0),
      runs: out,
    });
  } catch (err) {
    declarationError(res, err);
  }
}

/**
 * Takes back what a run declared (RUNS-VOID-1023). Only the service that owns the
 * run (runs.service_name = x-service-name) may: a service never voids another's.
 */
async function handleVoid(req: Request, res: Response, orgRequired: boolean) {
  try {
    const { id } = req.params;
    if (!OUTCOME_UUID_RE.test(id)) {
      res.status(400).json({ error: "Invalid run id", details: null });
      return;
    }
    const caller = req.platformServiceName ?? (req.headers["x-service-name"] as string | undefined)?.trim();
    if (!caller) {
      res.status(400).json({ error: "x-service-name header is required (the service that owns the run)" });
      return;
    }
    const parsed = VoidRunOutcomesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }
    const [run] = (await db.execute(sql`
      SELECT id, organization_id, service_name FROM runs WHERE id = ${id}::uuid
    `)) as any[];
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const headerOrg = req.orgId as string | undefined;
    if ((orgRequired || headerOrg) && run.organization_id !== (headerOrg ?? null)) {
      res.status(409).json({ error: "run_org_mismatch" });
      return;
    }
    if (run.service_name !== caller) {
      res.status(403).json({ error: "not_run_owner", details: { runServiceName: run.service_name, callerServiceName: caller } });
      return;
    }
    const v = await voidRunOutcomes(id, parsed.data, caller);
    res.status(v.status === "voided" ? 201 : 200).json({ runId: id, allocationVersion: ALLOCATION_VERSION, ...v });
  } catch (err) {
    console.error("[Runs Service] void outcomes failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

router.post("/v1/runs/:id/outcomes", requireApiKey, (req, res) => handleDeclare(req, res, true));
router.post("/v1/platform-runs/outcomes/batch", requirePlatformAuth, handleDeclareBatch);
router.post("/v1/platform-runs/:id/outcomes", requirePlatformAuth, (req, res) => handleDeclare(req, res, false));
router.post("/v1/runs/:id/outcomes/void", requireApiKey, (req, res) => handleVoid(req, res, true));
router.post("/v1/platform-runs/:id/outcomes/void", requirePlatformAuth, (req, res) => handleVoid(req, res, false));

const csv = (v: unknown) =>
  typeof v === "string" && v.length > 0 ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

router.get("/internal/outcome-occurrences", requireInternalAuth, async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const runIds = csv(q.runIds);
    const subjectIds = csv(q.subjectIds);
    if (runIds && (runIds.length > 500 || runIds.some((r) => !OUTCOME_UUID_RE.test(r)))) {
      res.status(400).json({ error: "runIds must be <= 500 uuids" });
      return;
    }
    if (subjectIds && (subjectIds.length > 500 || !q.subjectService)) {
      res.status(400).json({ error: "subjectIds needs subjectService and at most 500 ids" });
      return;
    }
    if (!runIds && !subjectIds && !q.outcomeKey && !q.orgId) {
      res.status(400).json({ error: "state at least one of runIds, subjectIds (+subjectService), outcomeKey, orgId" });
      return;
    }
    for (const k of ["orgId", "cursor"] as const) {
      if (q[k] && !OUTCOME_UUID_RE.test(q[k]!)) {
        res.status(400).json({ error: `${k} must be a uuid` });
        return;
      }
    }
    for (const k of ["declaredAfter", "declaredBefore"] as const) {
      if (q[k] && Number.isNaN(Date.parse(q[k]!))) {
        res.status(400).json({ error: `${k} must be an ISO timestamp` });
        return;
      }
    }
    if (q.direction && q.direction !== "produced" && q.direction !== "consumed") {
      res.status(400).json({ error: "direction must be produced or consumed" });
      return;
    }
    const limit = q.limit === undefined ? 500 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      res.status(400).json({ error: "limit must be an integer 1..1000" });
      return;
    }
    const page = await listOccurrences({
      runIds,
      subjectService: q.subjectService,
      subjectIds,
      outcomeKey: q.outcomeKey,
      orgId: q.orgId,
      direction: q.direction as Direction | undefined,
      declaredAfter: q.declaredAfter,
      declaredBefore: q.declaredBefore,
      cursor: q.cursor,
      limit,
    });
    res.json({
      allocationVersion: ALLOCATION_VERSION,
      allocationRule: ALLOCATION_RULE,
      occurrences: page.occurrences.map((o) => ({
        ...o,
        cost: o.cost ? wireMoney(o.cost) : null,
        costSlices: o.costSlices ? o.costSlices.map((c) => ({ ...c, cost: wireMoney(c.cost) })) : null,
        consumption: o.consumption
          ? {
              ...o.consumption,
              standardCost: o.consumption.standardCost ? wireMoney(o.consumption.standardCost) : null,
              consumingOutcomes: o.consumption.consumingOutcomes.map((p) => ({
                ...p,
                standardCost: p.standardCost ? wireMoney(p.standardCost) : null,
              })),
            }
          : null,
      })),
      nextCursor: page.nextCursor,
    });
  } catch (err) {
    if (err instanceof VendorCostCatalogError) {
      res.status(502).json({ error: err.message });
      return;
    }
    console.error("[Runs Service] outcome occurrences read failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 400;

/** since/until as UTC days (inclusive), or an error message. */
function parseRange(q: Record<string, string | undefined>, defaultUntil: string, defaultSpan: number): { since: string; until: string } | string {
  const until = q.until ?? defaultUntil;
  const since = q.since ?? addDays(until, -(defaultSpan - 1));
  for (const d of [since, until]) {
    if (!DAY_RE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || utcDay(new Date(`${d}T00:00:00Z`)) !== d) {
      return "since/until must be YYYY-MM-DD";
    }
  }
  if (since > until) return "since must be <= until";
  if ((Date.parse(until) - Date.parse(since)) / 86_400_000 + 1 > MAX_RANGE_DAYS) return `range must be <= ${MAX_RANGE_DAYS} days`;
  return { since, until };
}

async function missingDays(since: string, until: string): Promise<string[]> {
  const rows = (await statsDb.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day FROM cost_ledger_computed_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND day BETWEEN ${since}::date AND ${until}::date
  `)) as any[];
  const have = new Set(rows.map((r) => r.day as string));
  const out: string[] = [];
  for (let d = since; d <= until; d = addDays(d, 1)) if (!have.has(d)) out.push(d);
  return out;
}

const zeroMoney = (): Money => ({ gross: "0", net: "0", vendor: "0", unpricedGross: "0" });
const addMoney = (a: Money, b: Money): Money => ({
  gross: new Decimal(a.gross).plus(b.gross).toFixed(10),
  net: new Decimal(a.net).plus(b.net).toFixed(10),
  vendor: new Decimal(a.vendor).plus(b.vendor).toFixed(10),
  unpricedGross: new Decimal(a.unpricedGross).plus(b.unpricedGross).toFixed(10),
});

router.get("/internal/outcome-costs/ledger-check", requireInternalAuth, async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const range = parseRange(q, addDays(utcDay(new Date()), -1), 60);
    if (typeof range === "string") {
      res.status(400).json({ error: range });
      return;
    }
    if (q.rows !== undefined && q.rows !== "true" && q.rows !== "false") {
      res.status(400).json({ error: "rows must be true or false" });
      return;
    }
    const stored = (await statsDb.execute(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, organization_id,
             ledger_gross::text, ledger_net::text, ledger_vendor::text, ledger_unpriced_gross::text,
             allocated_gross::text, allocated_net::text, allocated_vendor::text, allocated_unpriced_gross::text,
             none_gross::text, none_net::text, none_vendor::text, none_unpriced_gross::text,
             reuse_gross::text, reuse_net::text, reuse_vendor::text, reuse_unpriced_gross::text,
             reuse_count, unknown_provenance_count, cost_rows, occurrences
      FROM cost_ledger_days
      WHERE allocation_version = ${ALLOCATION_VERSION} AND day BETWEEN ${range.since}::date AND ${range.until}::date
      ORDER BY day, organization_id NULLS FIRST
    `)) as any[];
    const m = (r: any, p: string, u: string): Money => ({
      gross: new Decimal(r[`${p}_gross`]).toFixed(10),
      net: new Decimal(r[`${p}_net`]).toFixed(10),
      vendor: new Decimal(r[`${p}_vendor`]).toFixed(10),
      unpricedGross: new Decimal(r[u]).toFixed(10),
    });
    const totals = { ledger: zeroMoney(), standard: zeroMoney(), reuseGain: zeroMoney(), allocated: zeroMoney(), producedNone: zeroMoney() };
    const rows = stored.map((r) => {
      const row = {
        ledger: m(r, "ledger", "ledger_unpriced_gross"),
        allocated: m(r, "allocated", "allocated_unpriced_gross"),
        producedNone: m(r, "none", "none_unpriced_gross"),
        reuse: m(r, "reuse", "reuse_unpriced_gross"),
      };
      const input = ledgerCheckInputOf(row);
      totals.ledger = addMoney(totals.ledger, input.ledger);
      totals.standard = addMoney(totals.standard, input.standard);
      totals.reuseGain = addMoney(totals.reuseGain, input.reuseGain);
      totals.allocated = addMoney(totals.allocated, row.allocated);
      totals.producedNone = addMoney(totals.producedNone, row.producedNone);
      const check = checkLedgerRow(input);
      return {
        day: r.day as string,
        organizationId: (r.organization_id as string | null) ?? null,
        ledger: wireMoney(input.ledger),
        standard: wireMoney(input.standard),
        reuseGain: wireMoney(input.reuseGain),
        allocated: wireMoney(row.allocated),
        producedNone: wireMoney(row.producedNone),
        differences: wireMoney(check.differences),
        balanced: check.balanced,
        costRows: Number(r.cost_rows),
        occurrences: Number(r.occurrences),
        reuseCount: Number(r.reuse_count),
        unknownProvenanceCount: Number(r.unknown_provenance_count),
      };
    });
    const daysMissing = await missingDays(range.since, range.until);
    const mismatches = rows.filter((r) => !r.balanced);
    res.json({
      allocationVersion: ALLOCATION_VERSION,
      allocationRule: ALLOCATION_RULE,
      since: range.since,
      until: range.until,
      balanced: mismatches.length === 0,
      complete: daysMissing.length === 0,
      daysMissing,
      totals: {
        ledger: wireMoney(totals.ledger),
        standard: wireMoney(totals.standard),
        reuseGain: wireMoney(totals.reuseGain),
        allocated: wireMoney(totals.allocated),
        producedNone: wireMoney(totals.producedNone),
      },
      mismatches,
      rows: q.rows === "false" ? [] : rows,
    });
  } catch (err) {
    console.error("[Runs Service] ledger check read failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const pct = (covered: string, spend: string) => {
  const s = new Decimal(spend);
  return s.isZero() ? null : new Decimal(covered).div(s).times(100).toFixed(2);
};

router.get("/internal/stats/outcome-coverage", requireInternalAuth, async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const today = utcDay(new Date());
    const range = parseRange(q, today, 60);
    if (typeof range === "string") {
      res.status(400).json({ error: range });
      return;
    }
    const filters = [
      sql`allocation_version = ${ALLOCATION_VERSION}`,
      sql`day BETWEEN ${range.since}::date AND ${range.until}::date`,
      ...(q.serviceName ? [sql`service_name = ${q.serviceName}`] : []),
      ...(q.taskName ? [sql`task_name = ${q.taskName}`] : []),
    ];
    const rows = (await statsDb.execute(sql`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, service_name, task_name,
             spend_gross::text, covered_gross::text, spend_net::text, covered_net::text
      FROM outcome_coverage_days
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY day, service_name, task_name
    `)) as any[];
    const daysMissing = await missingDays(range.since, range.until);
    type Acc = { spendGross: Decimal; coveredGross: Decimal; spendNet: Decimal; coveredNet: Decimal };
    const point = (day: string, a: Acc) => ({
      day,
      complete: day < today,
      spendGrossCents: a.spendGross.toFixed(10),
      coveredGrossCents: a.coveredGross.toFixed(10),
      spendNetCents: a.spendNet.toFixed(10),
      coveredNetCents: a.coveredNet.toFixed(10),
      coveragePct: pct(a.coveredGross.toFixed(10), a.spendGross.toFixed(10)),
    });
    const empty = (): Acc => ({ spendGross: new Decimal(0), coveredGross: new Decimal(0), spendNet: new Decimal(0), coveredNet: new Decimal(0) });
    const add = (a: Acc, r: any) => {
      a.spendGross = a.spendGross.plus(r.spend_gross);
      a.coveredGross = a.coveredGross.plus(r.covered_gross);
      a.spendNet = a.spendNet.plus(r.spend_net);
      a.coveredNet = a.coveredNet.plus(r.covered_net);
    };
    const fleet = new Map<string, Acc>();
    const services = new Map<string, { day: string; serviceName: string; acc: Acc }>();
    // A computed day with no spend still reads as a point (spend 0, coverage null).
    for (let d = range.since; d <= range.until; d = addDays(d, 1)) if (!daysMissing.includes(d)) fleet.set(d, empty());
    const tasks = rows.map((r) => {
      add(fleet.get(r.day) ?? fleet.set(r.day, empty()).get(r.day)!, r);
      const sk = `${r.day}|${r.service_name}`;
      if (!services.has(sk)) services.set(sk, { day: r.day, serviceName: r.service_name, acc: empty() });
      add(services.get(sk)!.acc, r);
      const a = empty();
      add(a, r);
      return { ...point(r.day, a), serviceName: r.service_name as string, taskName: r.task_name as string };
    });
    res.json({
      allocationVersion: ALLOCATION_VERSION,
      since: range.since,
      until: range.until,
      daysMissing,
      fleet: [...fleet.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, a]) => point(day, a)),
      services: [...services.values()].map((s) => ({ ...point(s.day, s.acc), serviceName: s.serviceName })),
      tasks,
    });
  } catch (err) {
    console.error("[Runs Service] outcome coverage read failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/internal/stats/outcome-costs", requireInternalAuth, async (req, res) => {
  try {
    const q = req.query as Record<string, string | undefined>;
    const groupBy = (csv(q.groupBy) ?? []) as OutcomeCostDimension[];
    const bad = groupBy.filter((d) => !(OUTCOME_COST_DIMENSIONS as readonly string[]).includes(d));
    if (bad.length > 0 || new Set(groupBy).size !== groupBy.length) {
      res.status(400).json({ error: `groupBy must be distinct values of ${OUTCOME_COST_DIMENSIONS.join(", ")}` });
      return;
    }
    for (const k of ["orgId", "costOrgId"] as const) {
      if (q[k] && !OUTCOME_UUID_RE.test(q[k]!)) {
        res.status(400).json({ error: `${k} must be a uuid` });
        return;
      }
    }
    const today = utcDay(new Date());
    const until = q.until ?? today;
    const first = q.since ? null : await firstOutcomeCostDay();
    const range = parseRange({ since: q.since ?? (first && first <= until ? first : until), until }, today, 1);
    if (typeof range === "string") {
      res.status(400).json({ error: range });
      return;
    }
    const totals = await readOutcomeCostTotals(
      groupBy,
      {
        orgId: q.orgId,
        costOrgId: q.costOrgId,
        brandId: q.brandId,
        campaignId: q.campaignId,
        workflowSlug: q.workflowSlug,
        featureSlug: q.featureSlug,
        outcomeKey: q.outcomeKey ? normalizeOutcomeKey(q.outcomeKey) : undefined,
      },
      range.since,
      range.until,
    );
    res.json({
      allocationVersion: ALLOCATION_VERSION,
      allocationRule: ALLOCATION_RULE,
      since: totals.since,
      until: totals.until,
      groupBy,
      maxGroups: MAX_OUTCOME_COST_GROUPS,
      complete: totals.daysMissing.length === 0,
      daysMissing: totals.daysMissing,
      produced: totals.produced.map((g) => ({ ...g, cost: wireMoney(g.cost) })),
      consumed: totals.consumed.map((g) => ({ ...g, standardCost: wireMoney(g.standardCost), reuseGain: wireMoney(g.reuseGain) })),
      scope: totals.scope.map((g) => ({
        ...g,
        spend: wireMoney(g.spend),
        producedCost: wireMoney(g.producedCost),
        producedNone: wireMoney(g.producedNone),
      })),
    });
  } catch (err) {
    if (err instanceof TooManyGroupsError) {
      res.status(422).json({ error: err.message, details: { section: err.section, maxGroups: err.cap } });
      return;
    }
    console.error("[Runs Service] outcome cost totals read failed:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
