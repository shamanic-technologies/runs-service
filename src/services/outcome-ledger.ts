// The production-cost ledger (COST-ACCOUNTING-1023, owner 2026-10-23).
//
// A run is a PRODUCTION ORDER: it may state the outcome occurrences it PRODUCED
// and the ones it CONSUMED. An occurrence = one catalogue outcome (features-service
// `/public/catalogue/steps` key: `email_found`, `message_sent`, `conversation` = Positive reply…)
// reached by one subject, named by the service that owns it (lead-service lead id,
// social-service post id…). Nothing else carries a cost.
//
// ALLOCATION RULE v1 (versioned: a stored day names the version it was computed
// under, and a past day recomputes byte for byte from the same rows):
//   1. Every `actual` or `refunded` cost row (spend that happened, whoever pays:
//      production cost is never imputation) goes to its ANCHOR: the nearest run,
//      itself or an ancestor, that declared >= 1 PRODUCED occurrence. No anchor =
//      "produced none" (support spend, or a caller that does not declare yet).
//   2. Per (anchor, UTC day of the cost row, org of the cost row) the summed cost
//      is split over the anchor's produced occurrences in proportion to their
//      `quantity` (default 1 = equal shares), by CUMULATIVE ROUNDING at 10
//      decimals in occurrence-id order:
//        share_i = round(T x Qcum_i / Q, 10) - round(T x Qcum_(i-1) / Q, 10)
//      which telescopes to exactly T: no cent appears or vanishes.
//   3. The same split on every basis: billed gross, frozen net, vendor actual
//      (+ the billed gross the vendor catalogue cannot price, stated apart).
//   4. A rejected item is simply not declared: the kept ones carry its cost
//      (normal loss). A by-product is not declared either ($0).
//   5. STANDARD COST ON REUSE (owner 2026-10-23): an occurrence keeps the price
//      paid to produce it, and every consumption of it is charged that price.
//      A consumption resolves to ONE producing occurrence of the same (outcome,
//      subject): the latest one declared at or before it, else the earliest one
//      declared later, both only among those declared before the end of the
//      consumption's UTC day (so a stored day never moves for a later
//      declaration). The FIRST consumption of an occurrence (declared_at, id
//      order) is the one its spend paid for; each later one is a REUSE: charged
//      the same standard cost with no new spend, the "reuse gain" line, booked on
//      the consuming run's org and the consumption's UTC day. No producer =
//      unknown provenance (counted, never $0, never charged).
//   Check, per (UTC day, org), exact on every basis:
//      standard (spread + reuse charges) - reuse gain + produced none = ledger.

import { sql, type SQL } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import { db, statsDb } from "../db/index.js";
import { outcomeDeclarationEvents } from "../db/schema.js";
import { fetchVendorCostCatalog, type VendorCostVersion } from "./vendor-costs.js";
import { versionWindowsSql } from "../routes/vendor-costs.js";

export const ALLOCATION_VERSION = 1;
export const ALLOCATION_RULE =
  "v1: every actual or refunded cost row goes to its nearest run (itself or an ancestor) that declared a produced occurrence; per (that run, UTC day of the cost row, org of the cost row) it is split over the run's produced occurrences in proportion to quantity (default 1 = equal shares) by cumulative rounding at 10 decimals in occurrence-id order, so the shares sum exactly to the cost; same split on billed gross, frozen net and vendor actual; no such run = produced none. Standard cost on reuse: a consumption resolves to the latest producing occurrence of the same (outcome, subject) declared at or before it (else the earliest declared later), among those declared before the end of the consumption's UTC day; the first consumption of an occurrence is paid by its spend, every later one is charged the same production cost as a reuse gain, on the consuming run's org and UTC day.";

/** Legacy keys accepted on input and stored under their successor (never emitted). */
export const LEGACY_OUTCOME_KEYS: Readonly<Record<string, string>> = { email_sent: "message_sent" };

export const MAX_OCCURRENCES_PER_CALL = 1000;
/** A walk deeper than this stops (and is counted as unplaced, never silently dropped). */
const MAX_WALK_DEPTH = 1000;

export type Direction = "produced" | "consumed";

export interface OccurrenceInput {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  quantity?: string | number;
}

export function normalizeOutcomeKey(key: string): string {
  return LEGACY_OUTCOME_KEYS[key] ?? key;
}

// ---------------------------------------------------------------------------
// Declaration (write)
// ---------------------------------------------------------------------------

export interface DeclaredOccurrence {
  id: string;
  direction: Direction;
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  quantity: string;
  declaredAt: string;
  status: "recorded" | "already_recorded";
}

export class OutcomeDeclarationConflictError extends Error {
  constructor(public readonly conflicts: Array<{ direction: Direction; outcomeKey: string; subjectService: string; subjectId: string; storedQuantity: string; statedQuantity: string }>) {
    super("outcome occurrence already recorded with another quantity");
  }
}

export class DuplicateOccurrenceInBodyError extends Error {
  constructor(public readonly key: string) {
    super(`occurrence stated twice in the body: ${key}`);
  }
}

const occurrenceKeyOf = (d: Direction, o: { outcomeKey: string; subjectService: string; subjectId: string }) =>
  `${d}|${o.outcomeKey}|${o.subjectService}|${o.subjectId}`;

/**
 * Records the occurrences a run states. Idempotent per (run, direction, outcome,
 * subject): a replayed item is `already_recorded` (no bronze written for it), a
 * replay with ANOTHER quantity is a conflict (409), never a silent rewrite.
 */
export async function declareRunOutcomes(
  runId: string,
  body: { produced?: OccurrenceInput[]; consumed?: OccurrenceInput[] },
  sourceService: string | null,
): Promise<DeclaredOccurrence[]> {
  const stated: Array<{ direction: Direction; outcomeKey: string; subjectService: string; subjectId: string; quantity: string }> = [];
  const seen = new Set<string>();
  for (const direction of ["produced", "consumed"] as const) {
    for (const item of body[direction] ?? []) {
      const o = {
        direction,
        outcomeKey: normalizeOutcomeKey(item.outcomeKey),
        subjectService: item.subjectService,
        subjectId: item.subjectId,
        quantity: new Decimal(item.quantity ?? 1).toFixed(6),
      };
      const k = occurrenceKeyOf(direction, o);
      if (seen.has(k)) throw new DuplicateOccurrenceInBodyError(k);
      seen.add(k);
      stated.push(o);
    }
  }

  const readExisting = async () => {
    const rows = (await db.execute(sql`
      SELECT id, direction, outcome_key, subject_service, subject_id, quantity::text AS quantity, declared_at
      FROM run_outcomes WHERE run_id = ${runId}::uuid
    `)) as any[];
    return new Map(rows.map((r) => [occurrenceKeyOf(r.direction, { outcomeKey: r.outcome_key, subjectService: r.subject_service, subjectId: r.subject_id }), r]));
  };

  const assertNoConflict = (existing: Map<string, any>) => {
    const conflicts = stated
      .map((o) => ({ o, row: existing.get(occurrenceKeyOf(o.direction, o)) }))
      .filter(({ o, row }) => row && !new Decimal(row.quantity).eq(o.quantity))
      .map(({ o, row }) => ({
        direction: o.direction,
        outcomeKey: o.outcomeKey,
        subjectService: o.subjectService,
        subjectId: o.subjectId,
        storedQuantity: new Decimal(row.quantity).toFixed(6),
        statedQuantity: o.quantity,
      }));
    if (conflicts.length > 0) throw new OutcomeDeclarationConflictError(conflicts);
  };

  let existing = await readExisting();
  assertNoConflict(existing);
  const fresh = stated.filter((o) => !existing.has(occurrenceKeyOf(o.direction, o)));
  const freshKeys = new Set(fresh.map((o) => occurrenceKeyOf(o.direction, o)));

  if (fresh.length > 0) {
    await db.insert(outcomeDeclarationEvents).values({
      runId,
      eventType: "outcomes.declared",
      sourceService,
      payload: {
        allocationVersion: ALLOCATION_VERSION,
        items: fresh.map((o) => ({
          id: randomUUID(),
          direction: o.direction,
          outcome_key: o.outcomeKey,
          subject_service: o.subjectService,
          subject_id: o.subjectId,
          quantity: o.quantity,
        })),
      },
    });
    existing = await readExisting();
    // A concurrent call may have recorded the same occurrence with another quantity.
    assertNoConflict(existing);
  }

  return stated.map((o) => {
    const row = existing.get(occurrenceKeyOf(o.direction, o));
    return {
      id: row.id,
      direction: o.direction,
      outcomeKey: o.outcomeKey,
      subjectService: o.subjectService,
      subjectId: o.subjectId,
      quantity: new Decimal(row.quantity).toFixed(6),
      declaredAt: new Date(row.declared_at).toISOString(),
      status: freshKeys.has(occurrenceKeyOf(o.direction, o)) ? "recorded" : "already_recorded",
    };
  });
}

// ---------------------------------------------------------------------------
// Shared SQL: vendor pricing of cost rows + the v1 share
// ---------------------------------------------------------------------------

/** The row's vendor cost (rounded to scale 10 per row) and its unpriced billed gross. */
function vendorJoinSql(alias: string): { vendor: SQL; unpriced: SQL; join: SQL } {
  const a = sql.raw(alias);
  return {
    vendor: sql`CASE WHEN v.vendor IS NOT NULL THEN round(${a}.quantity * v.vendor, 10) ELSE 0 END`,
    unpriced: sql`CASE WHEN v.vendor IS NULL THEN ${a}.gross ELSE 0 END`,
    join: sql`LEFT JOIN v
      ON v.cost_name = ${a}.cost_name
     AND v.billed = ${a}.unit_cost_in_usd_cents
     AND ${a}.created_at >= v.valid_from
     AND (v.valid_to IS NULL OR ${a}.created_at < v.valid_to)`,
  };
}

/** v1 share of group column `col` for occurrence `o` (cumulative rounding, telescopes to the group total). */
function shareSql(col: string): SQL {
  const c = sql.raw(`g.${col}`);
  return sql`(round(${c} * o.cum_q / o.q_total, 10) - round(${c} * (o.cum_q - o.quantity) / o.q_total, 10))`;
}

/** Produced occurrences of the anchors in `anchorsCte`, with their cumulative quantity (v1 order: id). */
function occurrencesOfAnchorsSql(anchorsCte: string): SQL {
  return sql`
    SELECT o.id, o.run_id AS anchor_id, o.quantity,
           SUM(o.quantity) OVER (PARTITION BY o.run_id ORDER BY o.id) AS cum_q,
           SUM(o.quantity) OVER (PARTITION BY o.run_id) AS q_total
    FROM run_outcomes o
    WHERE o.direction = 'produced' AND o.run_id IN (SELECT anchor_id FROM ${sql.raw(anchorsCte)})`;
}

const hasProducedSql = (runIdCol: SQL) =>
  sql`EXISTS (SELECT 1 FROM run_outcomes o WHERE o.run_id = ${runIdCol} AND o.direction = 'produced')`;

// ---------------------------------------------------------------------------
// One UTC day: ledger vs spread vs produced none, and coverage
// ---------------------------------------------------------------------------

export interface Money {
  gross: string;
  net: string;
  vendor: string;
  unpricedGross: string;
}

export interface LedgerDayOrgRow {
  organizationId: string | null;
  ledger: Money;
  allocated: Money;
  producedNone: Money;
  /** Standard charges of the day's reuses = the reuse gain (no spend behind them). */
  reuse: Money;
  reuseCount: number;
  unknownProvenance: number;
  costRows: number;
  occurrences: number;
}

export interface CoverageDayRow {
  serviceName: string;
  taskName: string;
  spendGross: string;
  coveredGross: string;
  spendNet: string;
  coveredNet: string;
}

export interface LedgerDay {
  day: string;
  orgs: LedgerDayOrgRow[];
  coverage: CoverageDayRow[];
  unplacedRuns: number;
}

const fx = (v: unknown) => new Decimal((v as string | null) ?? "0").toFixed(10);
const money = (r: any, p: string): Money => ({
  gross: fx(r[`${p}_gross`]),
  net: fx(r[`${p}_net`]),
  vendor: fx(r[`${p}_vendor`]),
  unpricedGross: fx(r[`${p}_unpriced`]),
});

/** The statement computing one UTC day (exported for the prod parity probe). */
export function ledgerDaySql(day: string, versions: VendorCostVersion[]): SQL {
  const dayStart = sql`(${day}::date)::timestamp AT TIME ZONE 'UTC'`;
  const dayEnd = sql`(${day}::date + 1)::timestamp AT TIME ZONE 'UTC'`;
  const vj = vendorJoinSql("b");
  const sums = (alias: string, prefix: string) => {
    const a = sql.raw(alias);
    return sql`COALESCE(SUM(${a}.gross), 0) AS ${sql.raw(`${prefix}_gross`)},
      COALESCE(SUM(${a}.net), 0) AS ${sql.raw(`${prefix}_net`)},
      COALESCE(SUM(${a}.vendor), 0) AS ${sql.raw(`${prefix}_vendor`)},
      COALESCE(SUM(${a}.unpriced), 0) AS ${sql.raw(`${prefix}_unpriced`)}`;
  };
  return sql`
    WITH RECURSIVE
    v AS MATERIALIZED (${versionWindowsSql(versions)}),
    -- The day's spend: every actual or refunded row (provisioned holds are not
    -- spend yet, cancelled ones never were). OFFSET 0 keeps the scan on
    -- idx_runs_costs_created_at, and the run lookups as PK probes.
    b AS MATERIALIZED (
      SELECT rc.run_id, rc.organization_id AS rc_org, rc.cost_name, rc.unit_cost_in_usd_cents,
             rc.created_at, rc.quantity, rc.total_cost_in_usd_cents AS gross,
             COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) AS net
      FROM runs_costs rc
      WHERE rc.created_at >= ${dayStart} AND rc.created_at < ${dayEnd}
        AND rc.status IN ('actual','refunded')
      OFFSET 0
    ),
    -- ONE run lookup per distinct run (org/service/task for the rows, parent for
    -- the walk): the PK probes are the cost of this statement on a cold cache.
    day_runs AS MATERIALIZED (
      SELECT d.run_id, r.organization_id, r.service_name, r.task_name, r.parent_run_id
      FROM (SELECT DISTINCT run_id FROM b) d
      CROSS JOIN LATERAL (
        SELECT organization_id, service_name, task_name, parent_run_id FROM runs WHERE id = d.run_id OFFSET 0
      ) r
    ),
    costed AS MATERIALIZED (
      SELECT b.run_id, COALESCE(b.rc_org, dr.organization_id) AS org_id,
             COALESCE(b.rc_org, dr.organization_id)::text AS org_key,
             dr.service_name, dr.task_name, b.gross, b.net,
             ${vj.vendor} AS vendor, ${vj.unpriced} AS unpriced
      FROM b
      JOIN day_runs dr ON dr.run_id = b.run_id
      ${vj.join}
    ),
    -- Nearest run, itself or an ancestor, that declared a produced occurrence.
    walk(run_id, cur_id, parent_id, depth, found) AS (
      SELECT d.run_id, d.run_id, d.parent_run_id, 0, ${hasProducedSql(sql`d.run_id`)}
      FROM day_runs d
      UNION ALL
      SELECT w.run_id, p.id, p.parent_run_id, w.depth + 1, ${hasProducedSql(sql`p.id`)}
      FROM walk w
      CROSS JOIN LATERAL (SELECT id, parent_run_id FROM runs WHERE id = w.parent_id OFFSET 0) p
      WHERE NOT w.found AND w.parent_id IS NOT NULL AND w.depth < ${MAX_WALK_DEPTH}
    ),
    walked AS MATERIALIZED (SELECT * FROM walk),
    anchor_of AS MATERIALIZED (SELECT run_id, cur_id AS anchor_id FROM walked WHERE found),
    g AS MATERIALIZED (
      SELECT a.anchor_id, c.org_key,
             SUM(c.gross) AS gross, SUM(c.net) AS net, SUM(c.vendor) AS vendor, SUM(c.unpriced) AS unpriced
      FROM costed c JOIN anchor_of a ON a.run_id = c.run_id
      GROUP BY a.anchor_id, c.org_key
    ),
    anchors AS MATERIALIZED (SELECT DISTINCT anchor_id FROM g),
    o AS MATERIALIZED (${occurrencesOfAnchorsSql("anchors")}),
    shares AS (
      SELECT g.org_key, o.id AS occurrence_id,
             ${shareSql("gross")} AS gross, ${shareSql("net")} AS net,
             ${shareSql("vendor")} AS vendor, ${shareSql("unpriced")} AS unpriced
      FROM g JOIN o ON o.anchor_id = g.anchor_id
    ),
    ledger AS (
      SELECT org_key, MIN(org_id::text) AS org_id, COUNT(*) AS cost_rows, ${sums("costed", "ledger")}
      FROM costed GROUP BY org_key
    ),
    unanchored AS (
      SELECT c.org_key, ${sums("c", "none")}
      FROM costed c
      WHERE NOT EXISTS (SELECT 1 FROM anchor_of a WHERE a.run_id = c.run_id)
      GROUP BY c.org_key
    ),
    alloc AS (
      SELECT s.org_key, COUNT(DISTINCT s.occurrence_id) AS occurrences, ${sums("s", "allocated")}
      FROM shares s GROUP BY s.org_key
    ),
    cov AS (
      SELECT c.service_name, c.task_name,
             SUM(c.gross)::text AS spend_gross,
             COALESCE(SUM(c.gross) FILTER (WHERE a.run_id IS NOT NULL), 0)::text AS covered_gross,
             SUM(c.net)::text AS spend_net,
             COALESCE(SUM(c.net) FILTER (WHERE a.run_id IS NOT NULL), 0)::text AS covered_net
      FROM costed c LEFT JOIN anchor_of a ON a.run_id = c.run_id
      GROUP BY c.service_name, c.task_name
    )
    SELECT
      COALESCE((
        SELECT json_agg(json_build_object(
          'org_id', l.org_id, 'cost_rows', l.cost_rows, 'occurrences', COALESCE(al.occurrences, 0),
          'ledger_gross', l.ledger_gross::text, 'ledger_net', l.ledger_net::text,
          'ledger_vendor', l.ledger_vendor::text, 'ledger_unpriced', l.ledger_unpriced::text,
          'allocated_gross', COALESCE(al.allocated_gross, 0)::text, 'allocated_net', COALESCE(al.allocated_net, 0)::text,
          'allocated_vendor', COALESCE(al.allocated_vendor, 0)::text, 'allocated_unpriced', COALESCE(al.allocated_unpriced, 0)::text,
          'none_gross', COALESCE(n.none_gross, 0)::text, 'none_net', COALESCE(n.none_net, 0)::text,
          'none_vendor', COALESCE(n.none_vendor, 0)::text, 'none_unpriced', COALESCE(n.none_unpriced, 0)::text
        ) ORDER BY l.org_key NULLS FIRST)
        FROM ledger l
        LEFT JOIN alloc al ON al.org_key IS NOT DISTINCT FROM l.org_key
        LEFT JOIN unanchored n ON n.org_key IS NOT DISTINCT FROM l.org_key
      ), '[]'::json) AS orgs,
      COALESCE((SELECT json_agg(row_to_json(cov) ORDER BY cov.service_name, cov.task_name) FROM cov), '[]'::json) AS coverage,
      (SELECT COUNT(*) FROM walked WHERE NOT found AND parent_id IS NOT NULL AND depth >= ${MAX_WALK_DEPTH}) AS unplaced_runs
  `;
}

/**
 * Consumptions of `targetSql` (a SELECT of run_outcomes ids, direction consumed),
 * each resolved to its producing occurrence (rule 5) and flagged reuse when an
 * earlier consumption resolved to the same producer. The history read is every
 * consumption of the targets' subjects: a row's rank depends only on rows
 * declared before it, so later rows never move it.
 */
function resolvedConsumptionsSql(targetSql: SQL): SQL {
  return sql`
    WITH t AS MATERIALIZED (${targetSql}),
    subj AS MATERIALIZED (
      SELECT DISTINCT c.outcome_key, c.subject_service, c.subject_id
      FROM run_outcomes c WHERE c.id IN (SELECT id FROM t)
    ),
    cons AS MATERIALIZED (
      SELECT c.id, c.run_id, c.declared_at, c.outcome_key, c.subject_service, c.subject_id
      FROM subj s
      CROSS JOIN LATERAL (
        SELECT * FROM run_outcomes c
        WHERE c.direction = 'consumed' AND c.subject_service = s.subject_service
          AND c.subject_id = s.subject_id AND c.outcome_key = s.outcome_key
        OFFSET 0
      ) c
    ),
    res AS MATERIALIZED (
      SELECT c.*, p.id AS producer_id, p.run_id AS producer_run_id
      FROM cons c
      LEFT JOIN LATERAL (
        SELECT p.id, p.run_id FROM run_outcomes p
        WHERE p.direction = 'produced' AND p.subject_service = c.subject_service
          AND p.subject_id = c.subject_id AND p.outcome_key = c.outcome_key
          AND p.declared_at < (date_trunc('day', c.declared_at AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
        ORDER BY (p.declared_at <= c.declared_at) DESC,
                 CASE WHEN p.declared_at <= c.declared_at THEN -extract(epoch FROM p.declared_at) ELSE extract(epoch FROM p.declared_at) END,
                 p.id
        LIMIT 1
      ) p ON TRUE
    ),
    ranked AS MATERIALIZED (
      SELECT res.*, ROW_NUMBER() OVER (PARTITION BY res.producer_id ORDER BY res.declared_at, res.id) AS rn
      FROM res
    )
    SELECT r.id, r.producer_id, r.producer_run_id, (r.producer_id IS NOT NULL AND r.rn > 1) AS reuse,
           cr.organization_id AS org_id
    FROM ranked r
    CROSS JOIN LATERAL (SELECT organization_id FROM runs WHERE id = r.run_id OFFSET 0) cr
    WHERE r.id IN (SELECT id FROM t)`;
}

interface ResolvedConsumption {
  id: string;
  producerId: string | null;
  producerRunId: string | null;
  reuse: boolean;
  orgId: string | null;
}

async function resolveConsumptions(targetSql: SQL): Promise<ResolvedConsumption[]> {
  const rows = (await statsDb.execute(resolvedConsumptionsSql(targetSql))) as any[];
  return rows.map((r) => ({
    id: r.id,
    producerId: r.producer_id ?? null,
    producerRunId: r.producer_run_id ?? null,
    reuse: r.reuse === true,
    orgId: r.org_id ?? null,
  }));
}

/** Standard (production) cost of each producing occurrence named, live (rule 1-3). */
async function standardCostsOf(consumptions: ResolvedConsumption[], versions: VendorCostVersion[]): Promise<Map<string, Money>> {
  const anchors = [...new Set(consumptions.filter((c) => c.producerRunId).map((c) => c.producerRunId!))];
  return occurrenceCosts(anchors, versions);
}

const ZERO = (): Money => ({ gross: fx(0), net: fx(0), vendor: fx(0), unpricedGross: fx(0) });
const plus = (a: Money, b: Money): Money => ({
  gross: new Decimal(a.gross).plus(b.gross).toFixed(10),
  net: new Decimal(a.net).plus(b.net).toFixed(10),
  vendor: new Decimal(a.vendor).plus(b.vendor).toFixed(10),
  unpricedGross: new Decimal(a.unpricedGross).plus(b.unpricedGross).toFixed(10),
});

export async function computeLedgerDay(day: string, versions: VendorCostVersion[]): Promise<LedgerDay> {
  // Background work, one statement per day: a read-only transaction on the stats
  // pool with its own timeout (the pool's 30 s is for request reads; on a cold,
  // loaded box a day's ~25k run lookups took minutes, 2026-10-23).
  const [row] = (await statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '900s'`);
    return tx.execute(ledgerDaySql(day, versions));
  })) as any[];
  const orgs = new Map<string, LedgerDayOrgRow>();
  for (const r of row.orgs as any[]) {
    orgs.set(r.org_id ?? "", {
      organizationId: r.org_id ?? null,
      ledger: money(r, "ledger"),
      allocated: money(r, "allocated"),
      producedNone: money(r, "none"),
      reuse: ZERO(),
      reuseCount: 0,
      unknownProvenance: 0,
      costRows: Number(r.cost_rows),
      occurrences: Number(r.occurrences),
    });
  }
  // Reuse charges of the day's consumptions (rule 5), on the consuming run's org.
  const consumptions = await resolveConsumptions(sql`
    SELECT id FROM run_outcomes
    WHERE direction = 'consumed'
      AND declared_at >= (${day}::date)::timestamp AT TIME ZONE 'UTC'
      AND declared_at < (${day}::date + 1)::timestamp AT TIME ZONE 'UTC'`);
  const reused = consumptions.filter((c) => c.reuse);
  const standard = reused.length > 0 ? await standardCostsOf(reused, versions) : new Map<string, Money>();
  for (const c of consumptions) {
    if (c.producerId && !c.reuse) continue;
    const key = c.orgId ?? "";
    if (!orgs.has(key)) {
      orgs.set(key, {
        organizationId: c.orgId, ledger: ZERO(), allocated: ZERO(), producedNone: ZERO(), reuse: ZERO(),
        reuseCount: 0, unknownProvenance: 0, costRows: 0, occurrences: 0,
      });
    }
    const o = orgs.get(key)!;
    if (!c.producerId) {
      o.unknownProvenance += 1;
      continue;
    }
    o.reuse = plus(o.reuse, standard.get(c.producerId) ?? ZERO());
    o.reuseCount += 1;
  }
  return {
    day,
    orgs: [...orgs.values()].sort((a, b) => (a.organizationId ?? "").localeCompare(b.organizationId ?? "")),
    coverage: (row.coverage as any[]).map((r) => ({
      serviceName: r.service_name,
      taskName: r.task_name,
      spendGross: fx(r.spend_gross),
      coveredGross: fx(r.covered_gross),
      spendNet: fx(r.spend_net),
      coveredNet: fx(r.covered_net),
    })),
    unplacedRuns: Number(row.unplaced_runs),
  };
}

/** Replaces one stored day (under an advisory lock: two processes never interleave a day). */
export async function storeLedgerDay(d: LedgerDay): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('cost_ledger_day'), hashtext(${d.day}))`);
    await tx.execute(sql`DELETE FROM cost_ledger_days WHERE day = ${d.day}::date AND allocation_version = ${ALLOCATION_VERSION}`);
    await tx.execute(sql`DELETE FROM outcome_coverage_days WHERE day = ${d.day}::date AND allocation_version = ${ALLOCATION_VERSION}`);
    if (d.orgs.length > 0) {
      await tx.execute(sql`
        INSERT INTO cost_ledger_days (
          day, allocation_version, organization_id,
          ledger_gross, ledger_net, ledger_vendor, ledger_unpriced_gross,
          allocated_gross, allocated_net, allocated_vendor, allocated_unpriced_gross,
          none_gross, none_net, none_vendor, none_unpriced_gross,
          reuse_gross, reuse_net, reuse_vendor, reuse_unpriced_gross, reuse_count, unknown_provenance_count,
          cost_rows, occurrences
        )
        SELECT ${d.day}::date, ${ALLOCATION_VERSION}, x.org,
               x.lg, x.ln, x.lv, x.lu, x.ag, x.an, x.av, x.au, x.ng, x.nn, x.nv, x.nu,
               x.rg, x.rn, x.rv, x.ru, x.rc, x.up, x.rows, x.occ
        FROM jsonb_to_recordset(${JSON.stringify(
          d.orgs.map((o) => ({
            org: o.organizationId,
            lg: o.ledger.gross, ln: o.ledger.net, lv: o.ledger.vendor, lu: o.ledger.unpricedGross,
            ag: o.allocated.gross, an: o.allocated.net, av: o.allocated.vendor, au: o.allocated.unpricedGross,
            ng: o.producedNone.gross, nn: o.producedNone.net, nv: o.producedNone.vendor, nu: o.producedNone.unpricedGross,
            rg: o.reuse.gross, rn: o.reuse.net, rv: o.reuse.vendor, ru: o.reuse.unpricedGross,
            rc: o.reuseCount, up: o.unknownProvenance,
            rows: o.costRows, occ: o.occurrences,
          })),
        )}::jsonb) AS x(org uuid, lg numeric, ln numeric, lv numeric, lu numeric, ag numeric, an numeric, av numeric, au numeric,
                        ng numeric, nn numeric, nv numeric, nu numeric, rg numeric, rn numeric, rv numeric, ru numeric,
                        rc bigint, up bigint, rows bigint, occ bigint)
      `);
    }
    if (d.coverage.length > 0) {
      await tx.execute(sql`
        INSERT INTO outcome_coverage_days (day, allocation_version, service_name, task_name, spend_gross, covered_gross, spend_net, covered_net)
        SELECT ${d.day}::date, ${ALLOCATION_VERSION}, x.s, x.t, x.sg, x.cg, x.sn, x.cn
        FROM jsonb_to_recordset(${JSON.stringify(
          d.coverage.map((c) => ({ s: c.serviceName, t: c.taskName, sg: c.spendGross, cg: c.coveredGross, sn: c.spendNet, cn: c.coveredNet })),
        )}::jsonb) AS x(s text, t text, sg numeric, cg numeric, sn numeric, cn numeric)
      `);
    }
    await tx.execute(sql`
      INSERT INTO cost_ledger_computed_days (day, allocation_version, computed_at)
      VALUES (${d.day}::date, ${ALLOCATION_VERSION}, now())
      ON CONFLICT (day, allocation_version) DO UPDATE SET computed_at = EXCLUDED.computed_at
    `);
  });
}

// ---------------------------------------------------------------------------
// The to-the-cent check (pure)
// ---------------------------------------------------------------------------

export interface LedgerCheckInput {
  ledger: Money;
  /** Σ standard cost charged on occurrences: production spread + reuse charges. */
  standard: Money;
  reuseGain: Money;
  producedNone: Money;
}

export interface LedgerCheckResult {
  balanced: boolean;
  /** standard - reuseGain + producedNone - ledger, per basis, 10-decimal strings ("0.0000000000" when balanced). */
  differences: Money;
}

const BASES: Array<keyof Money> = ["gross", "net", "vendor", "unpricedGross"];

/** standard - reuseGain + producedNone == ledger, EXACTLY, on every basis. No tolerance. */
export function checkLedgerRow(row: LedgerCheckInput): LedgerCheckResult {
  const differences = {} as Money;
  let balanced = true;
  for (const k of BASES) {
    const diff = new Decimal(row.standard[k]).minus(row.reuseGain[k]).plus(row.producedNone[k]).minus(row.ledger[k]);
    if (!diff.isZero()) balanced = false;
    differences[k] = diff.toFixed(10);
  }
  return { balanced, differences };
}

/** The check input of a stored (day, org) row: standard = spread + reuse charges, gain = reuse charges. */
export function ledgerCheckInputOf(r: Pick<LedgerDayOrgRow, "ledger" | "allocated" | "producedNone" | "reuse">): LedgerCheckInput {
  return { ledger: r.ledger, standard: plus(r.allocated, r.reuse), reuseGain: r.reuse, producedNone: r.producedNone };
}

// ---------------------------------------------------------------------------
// Refresher: the stored daily series
// ---------------------------------------------------------------------------

export const LEDGER_BACKFILL_DAYS = 60;
/** Recent days are always recomputed: costs keep landing (holds turn actual, late writes). */
const RECOMPUTE_RECENT_DAYS = 3;
const REFRESH_INTERVAL_MS = 15 * 60_000;
const FIRST_TICK_MS = 60_000;

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

/** Days the next tick must (re)compute, oldest first. */
export async function daysToCompute(now = new Date()): Promise<string[]> {
  const today = utcDay(now);
  const first = addDays(today, -(LEDGER_BACKFILL_DAYS - 1));
  const rows = (await db.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, computed_at FROM cost_ledger_computed_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND day >= ${first}::date
  `)) as any[];
  const computed = new Map(rows.map((r) => [r.day as string, new Date(r.computed_at)]));
  const out = new Set<string>();
  for (let i = 0; i < LEDGER_BACKFILL_DAYS; i++) {
    const day = addDays(first, i);
    if (!computed.has(day)) out.add(day);
  }
  for (let i = 0; i < RECOMPUTE_RECENT_DAYS; i++) out.add(addDays(today, -i));
  // A declaration recorded after a day was computed can move that day: the
  // anchor's (and its descendants') cost rows land on or after its start.
  if (computed.size > 0) {
    const oldest = new Date(Math.min(...[...computed.values()].map((d) => d.getTime())));
    const [late] = (await db.execute(sql`
      SELECT to_char(MIN(r.started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
      FROM run_outcomes o JOIN runs r ON r.id = o.run_id
      WHERE o.direction = 'produced' AND o.declared_at > ${oldest.toISOString()}::timestamptz
    `)) as any[];
    if (late?.day) {
      for (const [day, at] of computed) {
        if (day < late.day) continue;
        const [stale] = (await db.execute(sql`
          SELECT 1 AS x FROM run_outcomes o JOIN runs r ON r.id = o.run_id
          WHERE o.direction = 'produced' AND o.declared_at > ${at.toISOString()}::timestamptz
            AND r.started_at < (${day}::date + 1)::timestamp AT TIME ZONE 'UTC'
          LIMIT 1
        `)) as any[];
        if (stale) out.add(day);
      }
    }
  }
  // Recent days first (they feed today's monitor), then missing days newest first.
  const recent = new Set(Array.from({ length: RECOMPUTE_RECENT_DAYS }, (_, i) => addDays(today, -i)));
  return [...out].sort((a, b) => (recent.has(a) === recent.has(b) ? (a < b ? 1 : -1) : recent.has(a) ? -1 : 1));
}

/** Days per tick: the backfill spreads over ticks instead of loading the box at once. */
export const MAX_DAYS_PER_TICK = 8;

export async function refreshLedgerDays(now = new Date(), maxDays = MAX_DAYS_PER_TICK): Promise<{ computed: string[]; failed: string[] }> {
  const versions = await fetchVendorCostCatalog();
  const days = (await daysToCompute(now)).slice(0, maxDays);
  const computed: string[] = [];
  const failed: string[] = [];
  for (const day of days) {
    const t0 = Date.now();
    try {
      const d = await computeLedgerDay(day, versions);
      await storeLedgerDay(d);
      computed.push(day);
      const unbalanced = d.orgs.filter((o) => !checkLedgerRow(ledgerCheckInputOf(o)).balanced).length;
      const line = `[Runs Service] cost ledger day ${day}: orgs=${d.orgs.length} unbalanced=${unbalanced} unplacedRuns=${d.unplacedRuns} in ${Date.now() - t0}ms`;
      if (unbalanced > 0 || d.unplacedRuns > 0) console.error(`${line} — LEDGER CHECK FAILED`);
      else console.log(line);
    } catch (err) {
      // One day failing (timeout on a loaded box) never blocks the others; retried next tick.
      failed.push(day);
      console.error(`[Runs Service] cost ledger day ${day} failed after ${Date.now() - t0}ms (retried next tick):`, err);
    }
  }
  return { computed, failed };
}

let refreshing = false;

/** Started after app.listen(): first tick ~60 s after boot, then every 15 min, one at a time. */
export function startCostLedgerRefresh(): NodeJS.Timeout {
  const tick = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      await refreshLedgerDays();
    } catch (err) {
      console.error("[Runs Service] cost ledger refresh failed (retried next tick):", err);
    } finally {
      refreshing = false;
    }
  };
  setTimeout(() => void tick(), FIRST_TICK_MS).unref();
  const timer = setInterval(() => void tick(), REFRESH_INTERVAL_MS);
  timer.unref();
  return timer;
}

// ---------------------------------------------------------------------------
// Cost per occurrence (read)
// ---------------------------------------------------------------------------

export interface OccurrenceFilters {
  runIds?: string[];
  subjectService?: string;
  subjectIds?: string[];
  outcomeKey?: string;
  orgId?: string;
  direction?: Direction;
  declaredAfter?: string;
  declaredBefore?: string;
  cursor?: string;
  limit: number;
}

export interface OccurrenceWithCost {
  id: string;
  runId: string;
  organizationId: string | null;
  serviceName: string;
  taskName: string;
  direction: Direction;
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  quantity: string;
  declaredAt: string;
  /** The declaring run's tags (production tags for a produced occurrence): any customer scope is an exact sum. */
  tags: {
    brandIds: string[];
    campaignId: string | null;
    workflowSlug: string | null;
    featureSlug: string | null;
    audienceId: string | null;
  };
  /** PRODUCED: its production (= standard) cost. CONSUMED: null. */
  cost: Money | null;
  /** CONSUMED: the producing occurrence it resolved to and the standard cost charged. PRODUCED: null. */
  consumption: {
    sourceOccurrenceId: string | null;
    sourceRunId: string | null;
    reuse: boolean;
    provenance: "known" | "unknown";
    standardCost: Money | null;
  } | null;
}

/**
 * Per produced occurrence of `anchorIds`: its v1 share of its run's subtree cost
 * (descendants that declare their own produced occurrences are THEIR anchors and
 * excluded with their subtrees), summed over its (UTC day, org) groups — the same
 * groups the stored days split, so Σ occurrences of a day = that day's allocated.
 */
export async function occurrenceCosts(anchorIds: string[], versions: VendorCostVersion[]): Promise<Map<string, Money>> {
  if (anchorIds.length === 0) return new Map();
  const vj = vendorJoinSql("b");
  const rows = (await statsDb.execute(sql`
    WITH RECURSIVE
    v AS MATERIALIZED (${versionWindowsSql(versions)}),
    anchors AS MATERIALIZED (SELECT DISTINCT unnest(${`{${anchorIds.join(",")}}`}::uuid[]) AS anchor_id),
    sub(anchor_id, run_id, depth) AS (
      SELECT anchor_id, anchor_id, 0 FROM anchors
      UNION ALL
      SELECT s.anchor_id, c.id, s.depth + 1
      FROM sub s
      CROSS JOIN LATERAL (SELECT id FROM runs WHERE parent_run_id = s.run_id OFFSET 0) c
      WHERE s.depth < ${MAX_WALK_DEPTH} AND NOT ${hasProducedSql(sql`c.id`)}
    ),
    b AS MATERIALIZED (
      SELECT s.anchor_id, rc.cost_name, rc.unit_cost_in_usd_cents, rc.created_at, rc.quantity,
             rc.total_cost_in_usd_cents AS gross,
             COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) AS net,
             COALESCE(rc.organization_id, r.organization_id)::text AS org_key
      FROM sub s
      CROSS JOIN LATERAL (
        SELECT * FROM runs_costs rc WHERE rc.run_id = s.run_id AND rc.status IN ('actual','refunded') OFFSET 0
      ) rc
      CROSS JOIN LATERAL (SELECT organization_id FROM runs WHERE id = s.run_id OFFSET 0) r
    ),
    g AS MATERIALIZED (
      SELECT b.anchor_id, (b.created_at AT TIME ZONE 'UTC')::date AS day, b.org_key,
             SUM(b.gross) AS gross, SUM(b.net) AS net, SUM(${vj.vendor}) AS vendor, SUM(${vj.unpriced}) AS unpriced
      FROM b ${vj.join}
      GROUP BY 1, 2, 3
    ),
    o AS MATERIALIZED (${occurrencesOfAnchorsSql("anchors")})
    SELECT o.id,
      COALESCE(SUM(${shareSql("gross")}), 0)::text AS gross,
      COALESCE(SUM(${shareSql("net")}), 0)::text AS net,
      COALESCE(SUM(${shareSql("vendor")}), 0)::text AS vendor,
      COALESCE(SUM(${shareSql("unpriced")}), 0)::text AS unpriced
    FROM o LEFT JOIN g ON g.anchor_id = o.anchor_id
    GROUP BY o.id
  `)) as any[];
  return new Map(rows.map((r) => [r.id as string, { gross: fx(r.gross), net: fx(r.net), vendor: fx(r.vendor), unpricedGross: fx(r.unpriced) }]));
}

function consumptionOf(c: ResolvedConsumption | undefined, costs: Map<string, Money>): OccurrenceWithCost["consumption"] {
  if (!c || !c.producerId) {
    return { sourceOccurrenceId: null, sourceRunId: null, reuse: false, provenance: "unknown", standardCost: null };
  }
  return {
    sourceOccurrenceId: c.producerId,
    sourceRunId: c.producerRunId,
    reuse: c.reuse,
    provenance: "known",
    standardCost: costs.get(c.producerId) ?? null,
  };
}

export async function listOccurrences(f: OccurrenceFilters): Promise<{ occurrences: OccurrenceWithCost[]; nextCursor: string | null }> {
  const where: SQL[] = [];
  if (f.runIds?.length) where.push(sql`o.run_id = ANY(${`{${f.runIds.join(",")}}`}::uuid[])`);
  if (f.subjectService) where.push(sql`o.subject_service = ${f.subjectService}`);
  if (f.subjectIds?.length) where.push(sql`o.subject_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(f.subjectIds)}::jsonb))`);
  if (f.outcomeKey) where.push(sql`o.outcome_key = ${normalizeOutcomeKey(f.outcomeKey)}`);
  if (f.direction) where.push(sql`o.direction = ${f.direction}`);
  if (f.declaredAfter) where.push(sql`o.declared_at >= ${f.declaredAfter}::timestamptz`);
  if (f.declaredBefore) where.push(sql`o.declared_at < ${f.declaredBefore}::timestamptz`);
  if (f.orgId) where.push(sql`r.organization_id = ${f.orgId}::uuid`);
  if (f.cursor) where.push(sql`o.id > ${f.cursor}::uuid`);
  const whereSql = where.length ? sql`WHERE ${sql.join(where, sql` AND `)}` : sql``;
  const rows = (await statsDb.execute(sql`
    SELECT o.id, o.run_id, r.organization_id, r.service_name, r.task_name, o.direction, o.outcome_key,
           o.subject_service, o.subject_id, o.quantity::text AS quantity, o.declared_at,
           r.brand_ids, r.campaign_id, r.workflow_slug, r.feature_slug, r.audience_id
    FROM run_outcomes o JOIN runs r ON r.id = o.run_id
    ${whereSql}
    ORDER BY o.id
    LIMIT ${f.limit + 1}
  `)) as any[];
  const page = rows.slice(0, f.limit);
  const consumedIds = page.filter((r) => r.direction === "consumed").map((r) => r.id as string);
  const resolved = consumedIds.length > 0
    ? await resolveConsumptions(sql`SELECT id FROM run_outcomes WHERE id = ANY(${`{${consumedIds.join(",")}}`}::uuid[])`)
    : [];
  const resolvedById = new Map(resolved.map((c) => [c.id, c]));
  const anchors = [
    ...new Set([
      ...page.filter((r) => r.direction === "produced").map((r) => r.run_id as string),
      ...resolved.filter((c) => c.producerRunId).map((c) => c.producerRunId!),
    ]),
  ];
  const costs = anchors.length > 0 ? await occurrenceCosts(anchors, await fetchVendorCostCatalog()) : new Map<string, Money>();
  return {
    occurrences: page.map((r) => ({
      id: r.id,
      runId: r.run_id,
      organizationId: r.organization_id ?? null,
      serviceName: r.service_name,
      taskName: r.task_name,
      direction: r.direction,
      outcomeKey: r.outcome_key,
      subjectService: r.subject_service,
      subjectId: r.subject_id,
      quantity: new Decimal(r.quantity).toFixed(6),
      declaredAt: new Date(r.declared_at).toISOString(),
      tags: {
        brandIds: r.brand_ids ?? [],
        campaignId: r.campaign_id ?? null,
        workflowSlug: r.workflow_slug ?? null,
        featureSlug: r.feature_slug ?? null,
        audienceId: r.audience_id ?? null,
      },
      cost: r.direction === "produced" ? costs.get(r.id) ?? null : null,
      consumption: r.direction === "consumed" ? consumptionOf(resolvedById.get(r.id), costs) : null,
    })),
    nextCursor: rows.length > f.limit ? page[page.length - 1].id : null,
  };
}
