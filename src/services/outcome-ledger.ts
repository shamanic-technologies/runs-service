// The production-cost ledger (COST-ACCOUNTING-1023, owner 2026-10-23).
//
// A run is a PRODUCTION ORDER: it may state the outcome occurrences it PRODUCED
// and the ones it CONSUMED. An occurrence = one catalogue outcome (features-service
// `/public/catalogue/steps` key: `email_found`, `message_sent`, `conversation` = Positive reply…)
// reached by one subject, named by the service that owns it (lead-service lead id,
// social-service post id…). Nothing else carries a cost.
//
// ALLOCATION RULE (versioned: a stored day names the version it was computed
// under, and a past day recomputes byte for byte from the same rows; v2 = v1 +
// rule 4b, cross-run normal loss; v3/v4 pool keys; v5 = lead states, rule 6 below
// and stateRoutingSql, LEAD-STATES-1024, 2026-10-24):
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
//   4b. CROSS-RUN NORMAL LOSS (doctrine rule 2: normal loss rides the good units
//      of the same pipe, in the orgs where the outcome happened): a cost row
//      with no anchor, no support mark on its walk, and a workflow slug W on its
//      run is LOSS of pipe W (a follow-up that judged "later", a run the funnel
//      cap stopped). Per (UTC day of the cost row, org of the cost row, W) the
//      loss is split, as rule 2, over the occurrences PRODUCED that day by runs
//      of W in that org (declared_at in the day, the run's org), in occurrence-id
//      order. W produced nothing there that day = the loss stays produced none.
//      Stored per day (cost_loss_pool_days) so the per-occurrence read adds the
//      same shares.
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
//   "Declared" everywhere = run_outcomes.declared_at, the EFFECTIVE declaration
//   time: the recording instant, or the past instant a BACKFILL stated
//   (`occurredAt`, migration 0060). A backfill adds facts, not a rule: v1 holds.
//   6. LEAD STATES (v5, doctrine rules 2 and 3): a run acting on a lead pays the
//      NEXT state that lead had not reached at the run's start, in each family;
//      a pipe acting on a lead past its target, or a run re-buying the same lead,
//      is ABNORMAL loss, in no unit cost (see stateRoutingSql).
//   Check, per (UTC day, org), exact on every basis:
//      standard (spread + reuse charges) - reuse gain + produced none + abnormal = ledger.

import { sql, type SQL } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";
import { db, statsDb } from "../db/index.js";
import { outcomeDeclarationEvents } from "../db/schema.js";
import { fetchVendorCostCatalog, type VendorCostVersion } from "./vendor-costs.js";
import { versionWindowsSql } from "../routes/vendor-costs.js";
import type { SupportFunction } from "./support-marks.js";
import { fetchAllocationInputs, syncLeadStates, type AllocationInputs } from "./lead-states.js";

export const ALLOCATION_VERSION = 5;
export const ALLOCATION_RULE =
  "v5: every actual or refunded cost row goes to its nearest run (itself or an ancestor) that declared a produced occurrence; per (that run, UTC day of the cost row, org of the cost row) it is split over the run's produced occurrences in proportion to quantity (default 1 = equal shares) by cumulative rounding at 10 decimals in occurrence-id order, so the shares sum exactly to the cost; same split on billed gross, frozen net and vendor actual; no such run = produced none. Standard cost on reuse: a consumption resolves to the latest producing occurrence of the same (outcome, subject) declared at or before it (else the earliest declared later), among those declared before the end of the consumption's UTC day; the first consumption of an occurrence is paid by its spend, every later one is charged the same production cost as a reuse gain, on the consuming run's org and UTC day. 'Declared' = the occurrence's effective declaration time: when it was recorded, or the past instant a backfill stated (occurredAt, within its run's start and the recording). Cross-run normal loss (v2; keyed on the campaign since v3; on the task when there is no workflow since v4): a cost row with no such run and no support mark on its walk is loss of its run's POOL KEY P (its workflow slug, else its own task = service + task name) in its run's campaign C (null = no campaign); per (UTC day of the cost row, org of the cost row, P, C) it is split the same way over the occurrences produced that day by runs of the same P and C in that org (occurrence-id order); none = it stays produced none, under its own run's tags. Lead states (v5, LEAD-STATES-1024): a share of an occurrence whose subject is a lead (lead-service) and whose outcome reaches no lead state, when its run's pipe (channel x the leg its workflow is assigned to, features-service) targets a lead state, leaves that occurrence (a by-product at $0) and goes, in each family (interest: lead_interested < meeting_booked < meeting_attended < paid_client; visit: lead_visited), to the next state the lead had not reached at that run's start (lead-service first reaches, at any of the run's brands): in the pipe's own family, the target already reached = ABNORMAL loss (target_already_reached, in no unit cost), else the lead's later reach of that state (the unit), else loss of (cost org, pool key, campaign, state) split equally over that day's units of the same key in unit-id order (none = produced none); in the other family the same is stated apart (parallel), never summed. A share of an occurrence a run of the same service, task and campaign already produced for the same subject is ABNORMAL loss (repeat_production). Check: allocated + produced none + abnormal = ledger.";

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
  /** EFFECTIVE declaration time: what every rule and day series keys on (= recordedAt for an on-time declaration). */
  declaredAt: string;
  /** When runs-service recorded it. */
  recordedAt: string;
  /** recorded = written now; redated = was recorded later than the stated time, moved earlier to it; already_recorded = nothing written. */
  status: "recorded" | "redated" | "already_recorded";
}

export class OutcomeDeclarationConflictError extends Error {
  constructor(public readonly conflicts: Array<{ runId: string; direction: Direction; outcomeKey: string; subjectService: string; subjectId: string; storedQuantity: string; statedQuantity: string }>) {
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

/** `occurredAt` value meaning "the run's own start". */
export const OCCURRED_AT_RUN_START = "run_started_at";

/**
 * BACKFILL (COST-BACKFILL-1023-RUNS): the effective declaration time of a
 * declaration stating `occurredAt`. Absent = on time (null: the recording
 * instant). `run_started_at` = the run's start. An ISO instant must sit between
 * the run's start and now: an outcome never precedes its production order, and
 * a declaration never lands in the future. Returns the instant, or the reason it
 * is refused.
 *
 * MEETING-DATED-OCCURRENCES-1024-RUNS: a SPEND-FREE run (`spend_free`: no cost
 * row, no child run; a production order that only states a FACT, e.g.
 * lead-service's `outcome-recording`) may date an occurrence at ANY past instant,
 * before its own start (`beforeStart: true`; the caller checks it owns the run).
 * Spend is never back-dated: a run with spend keeps the [start, now] bound, and
 * migration 0068's guards refuse spend or a child on a run holding such a fact.
 */
export function effectiveDeclaredAt(
  occurredAt: string | undefined,
  run: { started_at: Date | string; spend_free?: boolean },
  now = new Date(),
): { at: Date | null; beforeStart?: true } | { error: string } {
  if (occurredAt === undefined) return { at: null };
  const started = new Date(run.started_at);
  if (occurredAt === OCCURRED_AT_RUN_START) return { at: started };
  const at = new Date(occurredAt);
  if (Number.isNaN(at.getTime())) return { error: "occurredAt must be an ISO instant or run_started_at" };
  if (at > now) return { error: `occurredAt ${at.toISOString()} is in the future` };
  if (at < started) {
    if (run.spend_free === true) return { at, beforeStart: true };
    return { error: `occurredAt ${at.toISOString()} is before the run started (${started.toISOString()}); only a run with no cost and no child run may state a fact before its start` };
  }
  return { at };
}

/** Migration 0068's refusal of a cost / child run on a run holding a fact dated before its start (drizzle wraps it on `cause`). */
export function isRunHoldsDatedFacts(err: unknown): boolean {
  return `${(err as any)?.message ?? ""} ${(err as any)?.cause?.message ?? ""}`.includes("run_holds_dated_facts");
}

export const RUN_HOLDS_DATED_FACTS_BODY = {
  error: "run_holds_dated_facts",
  details: "this run holds an outcome dated before its start (a recorded past fact): it takes no cost and no child run",
};

/** SQL selecting `spend_free` for runs aliased `r`: no cost row, no child run (indexed probes). */
export const SPEND_FREE_SQL = sql.raw(
  `(NOT EXISTS (SELECT 1 FROM runs_costs c WHERE c.run_id = r.id) AND NOT EXISTS (SELECT 1 FROM runs ch WHERE ch.parent_run_id = r.id)) AS spend_free`,
);

export interface DeclarationEntry {
  runId: string;
  body: { produced?: OccurrenceInput[]; consumed?: OccurrenceInput[] };
  sourceService: string | null;
  /** Effective declaration time (backfill); null = on time. */
  declaredAt: Date | null;
  /**
   * RE-DATE: an occurrence of this run already recorded with a LATER effective
   * time (declared through today's door before occurredAt existed) moves EARLIER
   * to `declaredAt`. Never later. The caller checks it owns the run.
   */
  redate?: boolean;
}

/**
 * Records the occurrences each run states, in one bronze write (one event per
 * run with something new). Idempotent per (run, direction, outcome, subject): a
 * replayed item is `already_recorded` (no bronze written for it, whatever time it
 * states: the stored effective time stays), a replay with ANOTHER quantity is a
 * conflict (409), never a silent rewrite.
 */
export async function declareOutcomesBatch(entries: DeclarationEntry[]): Promise<DeclaredOccurrence[][]> {
  const statedPerEntry = entries.map((e) => {
    const stated: Array<{ direction: Direction; outcomeKey: string; subjectService: string; subjectId: string; quantity: string }> = [];
    const seen = new Set<string>();
    for (const direction of ["produced", "consumed"] as const) {
      for (const item of e.body[direction] ?? []) {
        const o = {
          direction,
          outcomeKey: normalizeOutcomeKey(item.outcomeKey),
          subjectService: item.subjectService,
          subjectId: item.subjectId,
          quantity: new Decimal(item.quantity ?? 1).toFixed(6),
        };
        const k = occurrenceKeyOf(direction, o);
        if (seen.has(k)) throw new DuplicateOccurrenceInBodyError(`${e.runId}|${k}`);
        seen.add(k);
        stated.push(o);
      }
    }
    return stated;
  });
  const runIds = entries.map((e) => e.runId);
  if (new Set(runIds).size !== runIds.length) throw new DuplicateOccurrenceInBodyError("a run stated twice in the batch");

  const readExisting = async () => {
    const rows = (await db.execute(sql`
      SELECT id, run_id, direction, outcome_key, subject_service, subject_id, quantity::text AS quantity,
             declared_at, COALESCE(recorded_at, declared_at) AS recorded_at
      FROM run_outcomes WHERE run_id = ANY(${`{${runIds.join(",")}}`}::uuid[])
    `)) as any[];
    return new Map(rows.map((r) => [`${r.run_id}|${occurrenceKeyOf(r.direction, { outcomeKey: r.outcome_key, subjectService: r.subject_service, subjectId: r.subject_id })}`, r]));
  };

  const assertNoConflict = (existing: Map<string, any>) => {
    const conflicts = entries.flatMap((e, i) =>
      statedPerEntry[i]
        .map((o) => ({ o, row: existing.get(`${e.runId}|${occurrenceKeyOf(o.direction, o)}`) }))
        .filter(({ o, row }) => row && !new Decimal(row.quantity).eq(o.quantity))
        .map(({ o, row }) => ({
          runId: e.runId,
          direction: o.direction,
          outcomeKey: o.outcomeKey,
          subjectService: o.subjectService,
          subjectId: o.subjectId,
          storedQuantity: new Decimal(row.quantity).toFixed(6),
          statedQuantity: o.quantity,
        })),
    );
    if (conflicts.length > 0) throw new OutcomeDeclarationConflictError(conflicts);
  };

  let existing = await readExisting();
  assertNoConflict(existing);
  const freshKeys = new Set<string>();
  const redatedKeys = new Set<string>();
  const redates = entries.flatMap((e, i) => {
    if (!e.redate || !e.declaredAt) return [];
    const at = e.declaredAt;
    const moved = statedPerEntry[i]
      .map((o) => ({ key: `${e.runId}|${occurrenceKeyOf(o.direction, o)}`, row: existing.get(`${e.runId}|${occurrenceKeyOf(o.direction, o)}`) }))
      .filter(({ row }) => row && new Date(row.declared_at) > at);
    if (moved.length === 0) return [];
    for (const m of moved) redatedKeys.add(m.key);
    return [{
      runId: e.runId,
      eventType: "outcomes.redated",
      sourceService: e.sourceService,
      payload: {
        allocationVersion: ALLOCATION_VERSION,
        items: moved.map(({ row }) => ({ id: row.id, declared_at: at.toISOString(), previous_declared_at: new Date(row.declared_at).toISOString() })),
      },
    }];
  });
  const events = entries.flatMap((e, i) => {
    const fresh = statedPerEntry[i].filter((o) => !existing.has(`${e.runId}|${occurrenceKeyOf(o.direction, o)}`));
    if (fresh.length === 0) return [];
    for (const o of fresh) freshKeys.add(`${e.runId}|${occurrenceKeyOf(o.direction, o)}`);
    return [{
      runId: e.runId,
      eventType: "outcomes.declared",
      sourceService: e.sourceService,
      payload: {
        allocationVersion: ALLOCATION_VERSION,
        ...(e.declaredAt && { backfill: true }),
        items: fresh.map((o) => ({
          id: randomUUID(),
          direction: o.direction,
          outcome_key: o.outcomeKey,
          subject_service: o.subjectService,
          subject_id: o.subjectId,
          quantity: o.quantity,
          ...(e.declaredAt && { declared_at: e.declaredAt.toISOString() }),
        })),
      },
    }];
  });

  if (events.length + redates.length > 0) {
    await db.insert(outcomeDeclarationEvents).values([...events, ...redates]);
    existing = await readExisting();
    // A concurrent call may have recorded the same occurrence with another quantity.
    assertNoConflict(existing);
  }

  return entries.map((e, i) =>
    statedPerEntry[i].map((o) => {
      const key = `${e.runId}|${occurrenceKeyOf(o.direction, o)}`;
      const row = existing.get(key);
      return {
        id: row.id,
        direction: o.direction,
        outcomeKey: o.outcomeKey,
        subjectService: o.subjectService,
        subjectId: o.subjectId,
        quantity: new Decimal(row.quantity).toFixed(6),
        declaredAt: new Date(row.declared_at).toISOString(),
        recordedAt: new Date(row.recorded_at).toISOString(),
        status: freshKeys.has(key) ? "recorded" : redatedKeys.has(key) ? "redated" : "already_recorded",
      };
    }),
  );
}

/** One run's declaration (see declareOutcomesBatch). */
export async function declareRunOutcomes(
  runId: string,
  body: { produced?: OccurrenceInput[]; consumed?: OccurrenceInput[] },
  sourceService: string | null,
  declaredAt: Date | null = null,
): Promise<DeclaredOccurrence[]> {
  const [out] = await declareOutcomesBatch([{ runId, body, sourceService, declaredAt }]);
  return out;
}

// ---------------------------------------------------------------------------
// Taking a declaration back (RUNS-VOID-1023)
// ---------------------------------------------------------------------------

/** True once the run's declaration was taken back: it accepts no new occurrence. */
export async function isRunOutcomesVoided(runId: string): Promise<boolean> {
  const [row] = (await db.execute(sql`
    SELECT 1 AS x FROM outcome_declaration_events
    WHERE run_id = ${runId}::uuid AND event_type = 'outcomes.voided' LIMIT 1
  `)) as any[];
  return Boolean(row);
}

export class RunOutcomesVoidedError extends Error {
  constructor(runId: string) {
    super(`run_outcomes_voided: run ${runId} had its declaration taken back, it accepts no new one`);
  }
}

export interface VoidedRunOutcomes {
  status: "voided" | "already_voided" | "nothing_to_void";
  voidedCount: number;
  voidedAt: string;
}

/**
 * Takes back EVERY occurrence the run declared (both directions): one bronze
 * `outcomes.voided` event carrying the reason, who, the removed rows and the
 * first UTC day they could have moved (the run's start or the earliest
 * declaration, whichever is first); the projection removes them from silver, so
 * they count in no figure, and the refresher recomputes every stored day from
 * that one. Idempotent: a second call writes nothing.
 */
export async function voidRunOutcomes(
  runId: string,
  body: { reason: string; voidedBy: string; scope?: { direction: Direction; outcomeKey: string } },
  sourceService: string,
): Promise<VoidedRunOutcomes> {
  const [prior] = (await db.execute(sql`
    SELECT occurred_at FROM outcome_declaration_events
    WHERE run_id = ${runId}::uuid AND event_type = 'outcomes.voided'
    ORDER BY occurred_at LIMIT 1
  `)) as any[];
  if (prior) return { status: "already_voided", voidedCount: 0, voidedAt: new Date(prior.occurred_at).toISOString() };

  // SCOPED-VOID-1024: one direction x outcome key; the run stays open.
  const scope = body.scope ? { direction: body.scope.direction, outcomeKey: normalizeOutcomeKey(body.scope.outcomeKey) } : null;
  const rows = (await db.execute(sql`
    SELECT id, direction, outcome_key, subject_service, subject_id, quantity::text AS quantity, declared_at
    FROM run_outcomes WHERE run_id = ${runId}::uuid
      ${scope ? sql`AND direction = ${scope.direction} AND outcome_key = ${scope.outcomeKey}` : sql``}
    ORDER BY id
  `)) as any[];
  if (scope && rows.length === 0) return { status: "nothing_to_void", voidedCount: 0, voidedAt: new Date().toISOString() };
  const [run] = (await db.execute(sql`SELECT started_at FROM runs WHERE id = ${runId}::uuid`)) as any[];
  const firstDay = [new Date(run.started_at), ...rows.map((r) => new Date(r.declared_at))]
    .map(utcDay)
    .sort()[0];
  const [event] = await db
    .insert(outcomeDeclarationEvents)
    .values({
      runId,
      eventType: scope ? "outcomes.voided_scoped" : "outcomes.voided",
      sourceService,
      payload: {
        allocationVersion: ALLOCATION_VERSION,
        reason: body.reason,
        voidedBy: body.voidedBy,
        ...(scope && { scope }),
        affectedFromDay: firstDay,
        items: rows.map((r) => ({
          id: r.id,
          direction: r.direction,
          outcome_key: r.outcome_key,
          subject_service: r.subject_service,
          subject_id: r.subject_id,
          quantity: r.quantity,
          declared_at: new Date(r.declared_at).toISOString(),
        })),
      },
    })
    .returning({ occurredAt: outcomeDeclarationEvents.occurredAt });
  return { status: "voided", voidedCount: rows.length, voidedAt: event.occurredAt.toISOString() };
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

/**
 * Rule 4b units: the occurrences PRODUCED on `day` (declared_at, UTC) by runs of
 * pool key P (workflow, else task) and campaign C in org K, for each (org_key K,
 * pool_key P, campaign_id C) of `poolsCte` (C null = runs without a campaign), with
 * their cumulative quantity per pool (occurrence-id order). The day statement
 * and the per-occurrence read use this one definition, so their shares agree.
 */
function pipeUnitsSql(day: string | SQL, poolsCte: string): SQL {
  const d = typeof day === "string" ? sql`${day}::date` : day;
  return sql`
    SELECT x.id, x.anchor_id, x.outcome_key, x.quantity, x.org_key, x.pool_key, x.campaign_id,
           SUM(x.quantity) OVER (PARTITION BY x.org_key, x.pool_key, x.campaign_id ORDER BY x.id) AS cum_q,
           SUM(x.quantity) OVER (PARTITION BY x.org_key, x.pool_key, x.campaign_id) AS q_total
    FROM (
      SELECT o.id, o.run_id AS anchor_id, o.outcome_key, o.quantity, r.org_key, r.pool_key, r.campaign_id
      FROM run_outcomes o
      CROSS JOIN LATERAL (SELECT organization_id::text AS org_key, ${poolKeySql("")} AS pool_key, campaign_id FROM runs WHERE id = o.run_id OFFSET 0) r
      WHERE o.direction = 'produced'
        AND o.declared_at >= (${d})::timestamp AT TIME ZONE 'UTC'
        AND o.declared_at < (${d} + 1)::timestamp AT TIME ZONE 'UTC'
        AND EXISTS (SELECT 1 FROM ${sql.raw(poolsCte)} p WHERE p.pool_key = r.pool_key AND p.org_key IS NOT DISTINCT FROM r.org_key
                    AND p.campaign_id IS NOT DISTINCT FROM r.campaign_id)
        -- One-time gate: no loss that day = no scan of the day's occurrences.
        AND EXISTS (SELECT 1 FROM ${sql.raw(poolsCte)})
    ) x`;
}

/**
 * The loss POOL KEY of a run (v4): its workflow slug, else its own task (service +
 * task name). Columns read from alias `a` (e.g. "r.").
 */
const poolKeySql = (a: string) => sql.raw(`COALESCE('workflow:' || ${a}workflow_slug, 'task:' || ${a}service_name || '/' || ${a}task_name)`);

/** Produced occurrences of the anchors in `anchorsCte`, with their cumulative quantity (v1 order: id). */
function occurrencesOfAnchorsSql(anchorsCte: string): SQL {
  return sql`
    SELECT o.id, o.run_id AS anchor_id, o.outcome_key, o.quantity,
           SUM(o.quantity) OVER (PARTITION BY o.run_id ORDER BY o.id) AS cum_q,
           SUM(o.quantity) OVER (PARTITION BY o.run_id) AS q_total
    FROM run_outcomes o
    WHERE o.direction = 'produced' AND o.run_id IN (SELECT anchor_id FROM ${sql.raw(anchorsCte)})`;
}

const hasProducedSql = (runIdCol: SQL) =>
  sql`EXISTS (SELECT 1 FROM run_outcomes o WHERE o.run_id = ${runIdCol} AND o.direction = 'produced')`;

/**
 * Where the anchor walk STOPS: a run that declared a produced occurrence (it is
 * the anchor), or a run marked SUPPORT (migration 0062: a staff experiment, a
 * probe): its own and its subtree's cost stays "produced none", never climbs.
 */
const stopsWalkSql = (runIdCol: SQL) =>
  sql`(${hasProducedSql(runIdCol)} OR EXISTS (SELECT 1 FROM run_support_marks m WHERE m.run_id = ${runIdCol}))`;

// ---------------------------------------------------------------------------
// v5: the lead's next state (LEAD-STATES-1024-RUNS)
// ---------------------------------------------------------------------------

/** The catalogue inputs as two CTEs: `st` (step -> state) and `pt` (workflow x channel -> target state). */
function allocationInputsCtes(inputs: AllocationInputs): SQL {
  return sql`
    st AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(inputs.stepStates.map((s) => ({ step_key: s.stepKey, state: s.state, family: s.family, rank: s.rank })))}::jsonb)
        AS x(step_key text, state text, family text, rank integer)
    ),
    pt AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(inputs.pipeTargets.map((p) => ({ workflow_slug: p.workflowSlug, feature_slug: p.featureSlug, state: p.state, family: p.family, rank: p.rank })))}::jsonb)
        AS x(workflow_slug text, feature_slug text, state text, family text, rank integer)
    ),
    st_states AS MATERIALIZED (SELECT DISTINCT state, family, rank FROM st WHERE step_key = state),
    fam AS MATERIALIZED (SELECT DISTINCT family FROM st_states)`;
}

/**
 * Re-routes the v4 shares (`base_shares`) by the lead's state (rules 2 and 3,
 * owner 2026-10-24). Defines `shares` (the final primary allocation) plus
 * `abnormal_rows`, `state_unpooled`, `parallel_shares`, `atags` and `routed`.
 *
 *  - A share of an occurrence whose subject is a LEAD (lead-service) and whose
 *    outcome reaches no state (message_sent, lead_found...) is PRODUCTION toward a
 *    state when its anchor run's pipe targets one (`pt`). It leaves that occurrence
 *    (a by-product, $0) and goes, in EACH family, to the next state that lead had
 *    not reached at the anchor run's START (reaches dated <= start count, at any of
 *    the run's brands):
 *      - the pipe's own family (PRIMARY: the ledger check): its target already
 *        reached = ABNORMAL loss `target_already_reached` (a cold email after the
 *        yes), in no unit; else the lead's reach of that next state, if it ever
 *        came (the unit), else STATE LOSS of (cost org, pool key, campaign, next
 *        state), split equally over that day's units of the same key (rule 2),
 *        none = produced none (unpooled, under the paying run's tags);
 *      - the other family (PARALLEL, never summed with the primary): the same, in
 *        `parallel_shares` / unpooled; a lead that reached it all adds nothing.
 *  - A share of an occurrence a run of the same (service, task, campaign) already
 *    produced for the same subject is ABNORMAL `repeat_production` (re-buying the
 *    same lead), whatever the pipe.
 *  - Every other share is unchanged (v4).
 */
function stateRoutingSql(inputs: AllocationInputs): SQL {
  return sql`
    ${allocationInputsCtes(inputs)},
    bs_info AS MATERIALIZED (
      SELECT s.*, o.subject_service, o.subject_id, o.declared_at AS occ_declared_at,
             ar.organization_id AS a_org, ar.service_name AS a_service, ar.task_name AS a_task, ar.campaign_id AS a_campaign,
             ar.workflow_slug AS a_workflow, ar.feature_slug AS a_feature, ar.brand_ids AS a_brands, ar.audience_id AS a_audience,
             ar.started_at AS a_started, to_char((ar.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS a_start_day, ar.pool_key AS a_pool,
             EXISTS (SELECT 1 FROM st WHERE st.step_key = s.outcome_key) AS reaches_state
      FROM base_shares s
      CROSS JOIN LATERAL (SELECT subject_service, subject_id, declared_at FROM run_outcomes WHERE id = s.occurrence_id OFFSET 0) o
      CROSS JOIN LATERAL (
        SELECT organization_id, service_name, task_name, campaign_id, workflow_slug, feature_slug, brand_ids, audience_id, started_at,
               ${poolKeySql("")} AS pool_key
        FROM runs WHERE id = s.anchor_id OFFSET 0
      ) ar
    ),
    atags AS MATERIALIZED (SELECT DISTINCT ON (anchor_id) * FROM bs_info ORDER BY anchor_id),
    repeated AS MATERIALIZED (
      SELECT DISTINCT b.occurrence_id
      FROM (SELECT DISTINCT occurrence_id, outcome_key, subject_service, subject_id, occ_declared_at, a_service, a_task, a_campaign
            FROM bs_info WHERE subject_service = 'lead-service' AND NOT reaches_state) b
      WHERE ${repeatedSql}
    ),
    routable AS MATERIALIZED (
      SELECT b.*, pt.family AS t_family, pt.rank AS t_rank
      FROM bs_info b
      JOIN pt ON pt.workflow_slug = b.a_workflow AND pt.feature_slug = b.a_feature
      WHERE b.subject_service = 'lead-service' AND NOT b.reaches_state
        AND NOT EXISTS (SELECT 1 FROM repeated r WHERE r.occurrence_id = b.occurrence_id)
    ),
    routed AS MATERIALIZED (
      SELECT r.*, f.family, (f.family = r.t_family) AS is_primary, rr.reached_rank, ns.state AS next_state,
             (f.family = r.t_family AND r.t_rank <= rr.reached_rank) AS abnormal, u.unit_id
      FROM routable r
      CROSS JOIN fam f
      CROSS JOIN LATERAL (
        SELECT COALESCE(MAX(l.rank), 0) AS reached_rank FROM lead_state_reaches l
        WHERE l.lead_id = r.subject_id AND l.brand_id = ANY(r.a_brands) AND l.family = f.family
          AND l.removed_at IS NULL AND l.reached_at <= r.a_started
      ) rr
      LEFT JOIN st_states ns ON ns.family = f.family AND ns.rank = rr.reached_rank + 1
      LEFT JOIN LATERAL (
        SELECT l.id AS unit_id FROM lead_state_reaches l
        WHERE l.lead_id = r.subject_id AND l.brand_id = ANY(r.a_brands) AND l.state = ns.state
          AND l.removed_at IS NULL AND l.reached_at > r.a_started
        ORDER BY l.reached_at, l.brand_id, l.id LIMIT 1
      ) u ON TRUE
    ),
    abnormal_rows AS MATERIALIZED (
      SELECT b.org_key, b.anchor_id, b.outcome_key, 'repeat_production'::text AS reason, b.gross, b.net, b.vendor, b.unpriced
      FROM bs_info b WHERE EXISTS (SELECT 1 FROM repeated r WHERE r.occurrence_id = b.occurrence_id)
      UNION ALL
      SELECT r.org_key, r.anchor_id, r.outcome_key, 'target_already_reached', r.gross, r.net, r.vendor, r.unpriced
      FROM routed r WHERE r.abnormal
    ),
    -- Toward a state the lead reached later: that reach is the unit.
    unit_rows AS MATERIALIZED (
      SELECT r.org_key, r.unit_id AS occurrence_id, r.anchor_id, r.next_state AS outcome_key, r.is_loss, r.is_primary,
             r.a_pool, r.a_campaign, r.gross, r.net, r.vendor, r.unpriced
      FROM routed r WHERE NOT r.abnormal AND r.next_state IS NOT NULL AND r.unit_id IS NOT NULL
    ),
    -- Toward a state the lead never reached: loss of the pipe's units of that state that day (rule 2).
    state_lost_rows AS MATERIALIZED (
      SELECT r.org_key, r.anchor_id, r.next_state, r.is_primary, r.a_pool, r.a_campaign, r.gross, r.net, r.vendor, r.unpriced
      FROM routed r WHERE NOT r.abnormal AND r.next_state IS NOT NULL AND r.unit_id IS NULL
    ),
    state_units AS MATERIALIZED (
      SELECT u.*, 1::numeric AS quantity,
             ROW_NUMBER() OVER (PARTITION BY u.org_key, u.a_pool, u.a_campaign, u.outcome_key, u.is_primary ORDER BY u.occurrence_id)::numeric AS cum_q,
             COUNT(*) OVER (PARTITION BY u.org_key, u.a_pool, u.a_campaign, u.outcome_key, u.is_primary)::numeric AS q_total
      FROM (SELECT DISTINCT org_key, a_pool, a_campaign, outcome_key, is_primary, occurrence_id FROM unit_rows) u
    ),
    state_lost AS MATERIALIZED (
      SELECT l.org_key, l.a_pool, l.a_campaign, l.next_state, l.is_primary,
             (MIN(l.anchor_id::text))::uuid AS anchor_id,
             SUM(l.gross) AS gross, SUM(l.net) AS net, SUM(l.vendor) AS vendor, SUM(l.unpriced) AS unpriced
      FROM state_lost_rows l GROUP BY 1, 2, 3, 4, 5
    ),
    state_loss_shares AS MATERIALIZED (
      SELECT g.org_key, o.occurrence_id, g.anchor_id, o.outcome_key, true AS is_loss, g.is_primary,
             ${shareSql("gross")} AS gross, ${shareSql("net")} AS net,
             ${shareSql("vendor")} AS vendor, ${shareSql("unpriced")} AS unpriced
      FROM state_lost g JOIN state_units o
        ON o.org_key IS NOT DISTINCT FROM g.org_key AND o.a_pool = g.a_pool AND o.a_campaign IS NOT DISTINCT FROM g.a_campaign
       AND o.outcome_key = g.next_state AND o.is_primary = g.is_primary
    ),
    -- Unpooled: kept per paying run so its tags survive (produced none / parallel_none).
    state_unpooled AS MATERIALIZED (
      SELECT l.* FROM state_lost_rows l
      WHERE NOT EXISTS (SELECT 1 FROM state_units o WHERE o.org_key IS NOT DISTINCT FROM l.org_key AND o.a_pool = l.a_pool
                        AND o.a_campaign IS NOT DISTINCT FROM l.a_campaign AND o.outcome_key = l.next_state AND o.is_primary = l.is_primary)
    ),
    shares AS MATERIALIZED (
      SELECT b.org_key, b.occurrence_id, b.anchor_id, b.outcome_key, b.is_loss, b.gross, b.net, b.vendor, b.unpriced
      FROM base_shares b
      WHERE NOT EXISTS (SELECT 1 FROM repeated r WHERE r.occurrence_id = b.occurrence_id)
        AND NOT EXISTS (SELECT 1 FROM routable r WHERE r.share_id = b.share_id)
      UNION ALL
      SELECT org_key, occurrence_id, anchor_id, outcome_key, is_loss, gross, net, vendor, unpriced FROM unit_rows WHERE is_primary
      UNION ALL
      SELECT org_key, occurrence_id, anchor_id, outcome_key, is_loss, gross, net, vendor, unpriced FROM state_loss_shares WHERE is_primary
    ),
    parallel_shares AS MATERIALIZED (
      SELECT org_key, occurrence_id, anchor_id, outcome_key, gross, net, vendor, unpriced FROM unit_rows WHERE NOT is_primary
      UNION ALL
      SELECT org_key, occurrence_id, anchor_id, outcome_key, gross, net, vendor, unpriced FROM state_loss_shares WHERE NOT is_primary
    )`;
}

/** The repeat predicate (abnormal `repeat_production`) on alias `b` (outcome_key, subject_service, subject_id, occ_declared_at, occurrence_id, a_service, a_task, a_campaign). */
const repeatedSql = sql`EXISTS (
        SELECT 1 FROM run_outcomes p
        CROSS JOIN LATERAL (SELECT service_name, task_name, campaign_id FROM runs WHERE id = p.run_id OFFSET 0) pr
        WHERE p.subject_service = b.subject_service AND p.subject_id = b.subject_id AND p.outcome_key = b.outcome_key
          AND p.direction = 'produced'
          AND (p.declared_at < b.occ_declared_at OR (p.declared_at = b.occ_declared_at AND p.id < b.occurrence_id))
          AND pr.service_name = b.a_service AND pr.task_name = b.a_task AND pr.campaign_id IS NOT DISTINCT FROM b.a_campaign
      )`;

/**
 * Where each produced occurrence of CTE `occCte` (columns occurrence_id, anchor_id =
 * its run) sends its cost under v5, on the PRIMARY family (the ledger check's):
 * `dest_key` = its own key (not re-routed), the next lead state (re-routed), or
 * NULL (abnormal); `rerouted` = it leaves the occurrence. The day statement's
 * stateRoutingSql decides the same, share by share. Needs allocationInputsCtes.
 */
function occurrenceRoutesSql(occCte: string): SQL {
  return sql`
    oinfo AS MATERIALIZED (
      SELECT x.occurrence_id, x.anchor_id, o.outcome_key, o.subject_service, o.subject_id, o.declared_at AS occ_declared_at,
             ar.service_name AS a_service, ar.task_name AS a_task, ar.campaign_id AS a_campaign, ar.workflow_slug AS a_workflow,
             ar.feature_slug AS a_feature, ar.brand_ids AS a_brands, ar.started_at AS a_started,
             EXISTS (SELECT 1 FROM st WHERE st.step_key = o.outcome_key) AS reaches_state
      FROM (SELECT DISTINCT occurrence_id, anchor_id FROM ${sql.raw(occCte)}) x
      CROSS JOIN LATERAL (SELECT outcome_key, subject_service, subject_id, declared_at FROM run_outcomes WHERE id = x.occurrence_id OFFSET 0) o
      CROSS JOIN LATERAL (
        SELECT service_name, task_name, campaign_id, workflow_slug, feature_slug, brand_ids, started_at FROM runs WHERE id = x.anchor_id OFFSET 0
      ) ar
    ),
    oroute AS MATERIALIZED (
      SELECT b.occurrence_id, b.outcome_key,
             CASE WHEN rep.yes THEN NULL
                  WHEN pt.state IS NULL THEN b.outcome_key
                  WHEN pt.rank <= rr.reached_rank THEN NULL
                  ELSE ns.state END AS dest_key,
             (rep.yes OR pt.state IS NOT NULL) AS rerouted
      FROM oinfo b
      CROSS JOIN LATERAL (SELECT (b.subject_service = 'lead-service' AND NOT b.reaches_state AND ${repeatedSql}) AS yes) rep
      LEFT JOIN pt ON pt.workflow_slug = b.a_workflow AND pt.feature_slug = b.a_feature
                  AND b.subject_service = 'lead-service' AND NOT b.reaches_state
      LEFT JOIN LATERAL (
        SELECT COALESCE(MAX(l.rank), 0) AS reached_rank FROM lead_state_reaches l
        WHERE l.lead_id = b.subject_id AND l.brand_id = ANY(b.a_brands) AND l.family = pt.family
          AND l.removed_at IS NULL AND l.reached_at <= b.a_started
      ) rr ON pt.state IS NOT NULL
      LEFT JOIN st_states ns ON ns.family = pt.family AND ns.rank = rr.reached_rank + 1
    )`;
}

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
  /**
   * The part of producedNone that is SUPPORT, per support function (migration
   * 0064): spend of runs marked support and their non-declaring subtrees.
   * producedNone - Σ support = undeclared spend.
   */
  supportByFunction: SupportByFunction;
  /** Part of `allocated` that is normal loss (rule 4b pools, v5 state pools): spend carried by units of the same pipe. */
  normalLoss: Money;
  /**
   * ABNORMAL loss (v5, IAS 2 section 16): spend in NO unit cost, a line apart beside
   * support (a send after the lead already reached the pipe's target state, a run
   * re-buying the same lead). ledger = allocated + producedNone + abnormal.
   */
  abnormal: Money;
  abnormalByReason: AbnormalByReason;
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
  /** Part of the spend that is support, per function (never covered: a support run anchors nothing). */
  supportByFunction: Partial<Record<SupportFunction, { gross: string; net: string }>>;
}

/** Support money per support function (absent function = 0). */
export type SupportByFunction = Partial<Record<SupportFunction, Money>>;

/** Why spend is abnormal loss (v5): a pipe acting on a lead past its target state, or a run re-buying the same lead. */
export const ABNORMAL_REASONS = ["target_already_reached", "repeat_production"] as const;
export type AbnormalReason = (typeof ABNORMAL_REASONS)[number];
export type AbnormalByReason = Partial<Record<AbnormalReason, Money>>;

/** Σ of a support split. */
export function supportTotal(s: SupportByFunction): Money {
  return Object.values(s).reduce<Money>((a, m) => plus(a, m!), ZERO());
}

export interface LedgerDay {
  day: string;
  /**
   * Start of the day's read transaction (its now()), stored as computed_at: a
   * declaration recorded later (recorded_at = its own transaction's now()) reads
   * as newer than the day, so the refresher recomputes the day it moves.
   */
  computedAt: Date;
  orgs: LedgerDayOrgRow[];
  outcomeCosts: OutcomeCostRow[];
  coverage: CoverageDayRow[];
  /** Rule 4b pools of the day: loss of pipe W in a cost org, carried by `units` occurrences W produced there that day. */
  lossPools: LossPool[];
  unplacedRuns: number;
}

export interface LossPool {
  /** Org of the lost cost rows (= of the units' runs). */
  organizationId: string | null;
  /** Pool key (v4): `workflow:<slug>`, else `task:<service>/<task>`. */
  poolKey: string;
  /** The workflow of a workflow pool (null on a task pool). */
  workflowSlug: string | null;
  /** Campaign of the lost runs (= of the units' runs); null = runs without a campaign (v3). */
  campaignId: string | null;
  units: number;
  loss: Money;
}

const fx = (v: unknown) => new Decimal((v as string | null) ?? "0").toFixed(10);
const money = (r: any, p: string): Money => ({
  gross: fx(r[`${p}_gross`]),
  net: fx(r[`${p}_net`]),
  vendor: fx(r[`${p}_vendor`]),
  unpricedGross: fx(r[`${p}_unpriced`]),
});

/** The statement computing one UTC day (exported for the prod parity probe). */
export function ledgerDaySql(day: string, versions: VendorCostVersion[], inputs: AllocationInputs): SQL {
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
      SELECT d.run_id, r.organization_id, r.service_name, r.task_name, r.parent_run_id,
             r.brand_ids, r.campaign_id, r.workflow_slug, r.feature_slug, r.audience_id, r.started_at
      FROM (SELECT DISTINCT run_id FROM b) d
      CROSS JOIN LATERAL (
        SELECT organization_id, service_name, task_name, parent_run_id, brand_ids, campaign_id, workflow_slug, feature_slug, audience_id, started_at
        FROM runs WHERE id = d.run_id OFFSET 0
      ) r
    ),
    costed AS MATERIALIZED (
      SELECT b.run_id, COALESCE(b.rc_org, dr.organization_id) AS org_id,
             COALESCE(b.rc_org, dr.organization_id)::text AS org_key,
             dr.service_name, dr.task_name, b.gross, b.net,
             dr.organization_id AS run_org, dr.brand_ids, dr.campaign_id, dr.workflow_slug, dr.feature_slug, dr.audience_id,
             ${poolKeySql("dr.")} AS pool_key,
             to_char((dr.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS run_start_day,
             ${vj.vendor} AS vendor, ${vj.unpriced} AS unpriced
      FROM b
      JOIN day_runs dr ON dr.run_id = b.run_id
      ${vj.join}
    ),
    -- Nearest run, itself or an ancestor, that declared a produced occurrence.
    walk(run_id, cur_id, parent_id, depth, found) AS (
      SELECT d.run_id, d.run_id, d.parent_run_id, 0, ${stopsWalkSql(sql`d.run_id`)}
      FROM day_runs d
      UNION ALL
      SELECT w.run_id, p.id, p.parent_run_id, w.depth + 1, ${stopsWalkSql(sql`p.id`)}
      FROM walk w
      CROSS JOIN LATERAL (SELECT id, parent_run_id FROM runs WHERE id = w.parent_id OFFSET 0) p
      WHERE NOT w.found AND w.parent_id IS NOT NULL AND w.depth < ${MAX_WALK_DEPTH}
    ),
    walked AS MATERIALIZED (SELECT * FROM walk),
    -- A walk that stopped on a support mark has no anchor: produced none.
    anchor_of AS MATERIALIZED (SELECT run_id, cur_id AS anchor_id FROM walked WHERE found AND ${hasProducedSql(sql`cur_id`)}),
    -- The walk stopped on a support mark: produced none BY DESIGN, named by its
    -- support function (migration 0064). A marked run never declares a produced
    -- occurrence, so a costed row is anchored, support or undeclared, never two.
    support_of AS MATERIALIZED (
      SELECT w.run_id, m.kind
      FROM walked w JOIN run_support_marks m ON m.run_id = w.cur_id
      WHERE w.found
    ),
    g AS MATERIALIZED (
      SELECT a.anchor_id, c.org_key,
             SUM(c.gross) AS gross, SUM(c.net) AS net, SUM(c.vendor) AS vendor, SUM(c.unpriced) AS unpriced
      FROM costed c JOIN anchor_of a ON a.run_id = c.run_id
      GROUP BY a.anchor_id, c.org_key
    ),
    own_anchors AS MATERIALIZED (SELECT DISTINCT anchor_id FROM g),
    o AS MATERIALIZED (${occurrencesOfAnchorsSql("own_anchors")}),
    own_shares AS MATERIALIZED (
      SELECT g.org_key, o.id AS occurrence_id, o.anchor_id, o.outcome_key, false AS is_loss,
             ${shareSql("gross")} AS gross, ${shareSql("net")} AS net,
             ${shareSql("vendor")} AS vendor, ${shareSql("unpriced")} AS unpriced
      FROM g JOIN o ON o.anchor_id = g.anchor_id
    ),
    -- Rule 4b: loss of pool P (workflow, else task) in campaign C (no anchor, no
    -- support) per (cost org, P, C), split over the units P produced in C that day in that org.
    lost AS MATERIALIZED (
      SELECT c.org_key, c.pool_key, MIN(c.workflow_slug) AS workflow_slug, c.campaign_id,
             SUM(c.gross) AS gross, SUM(c.net) AS net, SUM(c.vendor) AS vendor, SUM(c.unpriced) AS unpriced
      FROM costed c
      WHERE NOT EXISTS (SELECT 1 FROM anchor_of a WHERE a.run_id = c.run_id)
        AND NOT EXISTS (SELECT 1 FROM support_of sp WHERE sp.run_id = c.run_id)
      GROUP BY c.org_key, c.pool_key, c.campaign_id
    ),
    pipe_units AS MATERIALIZED (${pipeUnitsSql(day, "lost")}),
    pooled AS MATERIALIZED (SELECT DISTINCT org_key, pool_key, campaign_id FROM pipe_units),
    loss_shares AS MATERIALIZED (
      SELECT g.org_key, o.id AS occurrence_id, o.anchor_id, o.outcome_key, true AS is_loss,
             ${shareSql("gross")} AS gross, ${shareSql("net")} AS net,
             ${shareSql("vendor")} AS vendor, ${shareSql("unpriced")} AS unpriced
      FROM lost g JOIN pipe_units o ON o.org_key IS NOT DISTINCT FROM g.org_key AND o.pool_key = g.pool_key
                                    AND o.campaign_id IS NOT DISTINCT FROM g.campaign_id
    ),
    -- The v4 shares (rules 1-4b), each one row: what v5 re-routes.
    base_shares AS MATERIALIZED (
      SELECT ROW_NUMBER() OVER () AS share_id, x.* FROM (SELECT * FROM own_shares UNION ALL SELECT * FROM loss_shares) x
    ),
    ${stateRoutingSql(inputs)},
    anchors AS MATERIALIZED (SELECT DISTINCT anchor_id FROM shares),
    -- A costed row is CARRIED when anchored, or loss of a pipe that produced that day.
    carried AS MATERIALIZED (
      SELECT DISTINCT c.run_id, c.org_key FROM costed c
      WHERE EXISTS (SELECT 1 FROM anchor_of a WHERE a.run_id = c.run_id)
         OR (NOT EXISTS (SELECT 1 FROM support_of sp WHERE sp.run_id = c.run_id)
             AND EXISTS (SELECT 1 FROM pooled p WHERE p.org_key IS NOT DISTINCT FROM c.org_key AND p.pool_key = c.pool_key
                         AND p.campaign_id IS NOT DISTINCT FROM c.campaign_id))
    ),
    ledger AS (
      SELECT org_key, MIN(org_id::text) AS org_id, COUNT(*) AS cost_rows, ${sums("costed", "ledger")}
      FROM costed GROUP BY org_key
    ),
    -- Produced none: cost rows nothing carries (v4), plus the spend of leads whose
    -- next state no lead of the pipe reached that day (v5 unpooled state loss).
    unanchored AS (
      SELECT x.org_key, ${sums("x", "none")}
      FROM (
        SELECT c.org_key, c.gross, c.net, c.vendor, c.unpriced
        FROM costed c
        WHERE NOT EXISTS (SELECT 1 FROM carried k WHERE k.run_id = c.run_id AND k.org_key IS NOT DISTINCT FROM c.org_key)
        UNION ALL
        SELECT u.org_key, u.gross, u.net, u.vendor, u.unpriced FROM state_unpooled u WHERE u.is_primary
      ) x
      GROUP BY x.org_key
    ),
    -- Normal loss = the part of allocated carried as loss (rule 4b pools, v5 state pools).
    loss_by_org AS (
      SELECT s.org_key, ${sums("s", "loss")}
      FROM shares s WHERE s.is_loss
      GROUP BY s.org_key
    ),
    abnormal_by_org AS (
      SELECT a.org_key, ${sums("a", "abn")}
      FROM abnormal_rows a GROUP BY a.org_key
    ),
    abnormal_split AS (
      SELECT a.org_key, a.reason, ${sums("a", "s")}
      FROM abnormal_rows a GROUP BY 1, 2
    ),
    alloc AS (
      SELECT s.org_key, COUNT(DISTINCT s.occurrence_id) AS occurrences, ${sums("s", "allocated")}
      FROM shares s GROUP BY s.org_key
    ),
    -- Totals per outcome and production tags (the declaring run's), for
    -- GET /internal/stats/outcome-costs: the shares, and the spend that produced
    -- none under the tags of the run that spent.
    anchor_runs AS MATERIALIZED (
      SELECT a.anchor_id, r.organization_id, r.brand_ids, r.campaign_id, r.workflow_slug, r.feature_slug,
             r.audience_id, r.service_name, to_char((r.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS run_start_day
      FROM anchors a
      CROSS JOIN LATERAL (
        SELECT organization_id, brand_ids, campaign_id, workflow_slug, feature_slug, audience_id, service_name, started_at
        FROM runs WHERE id = a.anchor_id OFFSET 0
      ) r
    ),
    produced_cost AS (
      SELECT s.outcome_key, ar.organization_id::text AS org, s.org_key AS cost_org, ar.brand_ids, ar.campaign_id,
             ar.workflow_slug, ar.feature_slug, ar.run_start_day, ar.audience_id, ar.service_name, ${sums("s", "m")}
      FROM shares s JOIN anchor_runs ar ON ar.anchor_id = s.anchor_id
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    ),
    none_cost AS (
      SELECT x.org, x.cost_org, x.brand_ids, x.campaign_id, x.workflow_slug, x.feature_slug, x.support_function,
             x.run_start_day, x.audience_id, x.service_name, COUNT(DISTINCT x.run_id) AS runs, ${sums("x", "m")}
      FROM (
        SELECT c.run_org::text AS org, c.org_key AS cost_org, c.brand_ids, c.campaign_id, c.workflow_slug, c.feature_slug,
               sp.kind AS support_function, c.run_start_day, c.audience_id, c.service_name, c.run_id,
               c.gross, c.net, c.vendor, c.unpriced
        FROM costed c
        LEFT JOIN support_of sp ON sp.run_id = c.run_id
        WHERE NOT EXISTS (SELECT 1 FROM carried k WHERE k.run_id = c.run_id AND k.org_key IS NOT DISTINCT FROM c.org_key)
        UNION ALL
        -- v5 unpooled state loss: under the paying (anchor) run's tags; it carries a workflow, so it reads as unpooled loss.
        SELECT t.a_org::text, u.org_key, t.a_brands, t.a_campaign, t.a_workflow, t.a_feature, NULL::text, t.a_start_day,
               t.a_audience, t.a_service, u.anchor_id, u.gross, u.net, u.vendor, u.unpriced
        FROM state_unpooled u JOIN atags t ON t.anchor_id = u.anchor_id
        WHERE u.is_primary
      ) x
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    ),
    -- v5: abnormal loss (in no unit cost) and the other family's view of the routed spend, under the paying run's tags.
    abnormal_cost AS (
      SELECT a.reason, a.outcome_key, t.a_org::text AS org, a.org_key AS cost_org, t.a_brands AS brand_ids, t.a_campaign AS campaign_id,
             t.a_workflow AS workflow_slug, t.a_feature AS feature_slug, t.a_start_day AS run_start_day, t.a_audience AS audience_id,
             t.a_service AS service_name, COUNT(DISTINCT a.anchor_id) AS runs, ${sums("a", "m")}
      FROM abnormal_rows a JOIN atags t ON t.anchor_id = a.anchor_id
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
    ),
    parallel_cost AS (
      SELECT p.kind, p.outcome_key, t.a_org::text AS org, p.org_key AS cost_org, t.a_brands AS brand_ids, t.a_campaign AS campaign_id,
             t.a_workflow AS workflow_slug, t.a_feature AS feature_slug, t.a_start_day AS run_start_day, t.a_audience AS audience_id,
             t.a_service AS service_name, COUNT(DISTINCT p.anchor_id) AS runs, ${sums("p", "m")}
      FROM (
        SELECT 'parallel_cost' AS kind, s.outcome_key, s.org_key, s.anchor_id, s.gross, s.net, s.vendor, s.unpriced FROM parallel_shares s
        UNION ALL
        SELECT 'parallel_none', u.next_state, u.org_key, u.anchor_id, u.gross, u.net, u.vendor, u.unpriced FROM state_unpooled u WHERE NOT u.is_primary
      ) p JOIN atags t ON t.anchor_id = p.anchor_id
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
    ),
    support_split AS (
      SELECT c.org_key, sp.kind, ${sums("c", "s")}
      FROM costed c JOIN support_of sp ON sp.run_id = c.run_id
      GROUP BY 1, 2
    ),
    cov_support AS (
      SELECT c.service_name, c.task_name, sp.kind,
             SUM(c.gross)::text AS gross, SUM(c.net)::text AS net
      FROM costed c JOIN support_of sp ON sp.run_id = c.run_id
      GROUP BY 1, 2, 3
    ),
    cov AS (
      SELECT c.service_name, c.task_name,
             SUM(c.gross)::text AS spend_gross,
             COALESCE(SUM(c.gross) FILTER (WHERE k.run_id IS NOT NULL), 0)::text AS covered_gross,
             SUM(c.net)::text AS spend_net,
             COALESCE(SUM(c.net) FILTER (WHERE k.run_id IS NOT NULL), 0)::text AS covered_net
      FROM costed c LEFT JOIN carried k ON k.run_id = c.run_id AND k.org_key IS NOT DISTINCT FROM c.org_key
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
          'none_vendor', COALESCE(n.none_vendor, 0)::text, 'none_unpriced', COALESCE(n.none_unpriced, 0)::text,
          'loss_gross', COALESCE(lo.loss_gross, 0)::text, 'loss_net', COALESCE(lo.loss_net, 0)::text,
          'loss_vendor', COALESCE(lo.loss_vendor, 0)::text, 'loss_unpriced', COALESCE(lo.loss_unpriced, 0)::text,
          'abn_gross', COALESCE(ab.abn_gross, 0)::text, 'abn_net', COALESCE(ab.abn_net, 0)::text,
          'abn_vendor', COALESCE(ab.abn_vendor, 0)::text, 'abn_unpriced', COALESCE(ab.abn_unpriced, 0)::text
        ) ORDER BY l.org_key NULLS FIRST)
        FROM ledger l
        LEFT JOIN alloc al ON al.org_key IS NOT DISTINCT FROM l.org_key
        LEFT JOIN unanchored n ON n.org_key IS NOT DISTINCT FROM l.org_key
        LEFT JOIN loss_by_org lo ON lo.org_key IS NOT DISTINCT FROM l.org_key
        LEFT JOIN abnormal_by_org ab ON ab.org_key IS NOT DISTINCT FROM l.org_key
      ), '[]'::json) AS orgs,
      COALESCE((SELECT json_agg(json_build_object(
        'org_id', x.org_key, 'reason', x.reason,
        's_gross', x.s_gross::text, 's_net', x.s_net::text, 's_vendor', x.s_vendor::text, 's_unpriced', x.s_unpriced::text)) FROM abnormal_split x), '[]'::json) AS abnormal,
      COALESCE((SELECT json_agg(json_build_object(
        'kind', 'abnormal', 'abnormal_reason', a.reason, 'outcome_key', a.outcome_key, 'org', a.org, 'cost_org', a.cost_org, 'brand_ids', a.brand_ids,
        'campaign_id', a.campaign_id, 'workflow_slug', a.workflow_slug, 'feature_slug', a.feature_slug, 'run_start_day', a.run_start_day,
        'audience_id', a.audience_id, 'service_name', a.service_name, 'runs', a.runs,
        'gross', a.m_gross::text, 'net', a.m_net::text, 'vendor', a.m_vendor::text, 'unpriced', a.m_unpriced::text)) FROM abnormal_cost a), '[]'::json) AS abnormal_cost,
      COALESCE((SELECT json_agg(json_build_object(
        'kind', p.kind, 'outcome_key', p.outcome_key, 'org', p.org, 'cost_org', p.cost_org, 'brand_ids', p.brand_ids,
        'campaign_id', p.campaign_id, 'workflow_slug', p.workflow_slug, 'feature_slug', p.feature_slug, 'run_start_day', p.run_start_day,
        'audience_id', p.audience_id, 'service_name', p.service_name, 'runs', p.runs,
        'gross', p.m_gross::text, 'net', p.m_net::text, 'vendor', p.m_vendor::text, 'unpriced', p.m_unpriced::text)) FROM parallel_cost p), '[]'::json) AS parallel_cost,
      (SELECT COUNT(*) FROM routed WHERE is_primary) AS routed_shares,
      COALESCE((SELECT json_agg(row_to_json(cov) ORDER BY cov.service_name, cov.task_name) FROM cov), '[]'::json) AS coverage,
      COALESCE((SELECT json_agg(json_build_object(
        'org_id', x.org_key, 'kind', x.kind,
        's_gross', x.s_gross::text, 's_net', x.s_net::text, 's_vendor', x.s_vendor::text, 's_unpriced', x.s_unpriced::text)) FROM support_split x), '[]'::json) AS support,
      COALESCE((SELECT json_agg(row_to_json(cs)) FROM cov_support cs), '[]'::json) AS coverage_support,
      COALESCE((SELECT json_agg(json_build_object(
        'outcome_key', p.outcome_key, 'org', p.org, 'cost_org', p.cost_org, 'brand_ids', p.brand_ids, 'campaign_id', p.campaign_id,
        'workflow_slug', p.workflow_slug, 'feature_slug', p.feature_slug, 'run_start_day', p.run_start_day,
        'audience_id', p.audience_id, 'service_name', p.service_name,
        'gross', p.m_gross::text, 'net', p.m_net::text, 'vendor', p.m_vendor::text, 'unpriced', p.m_unpriced::text)) FROM produced_cost p), '[]'::json) AS produced_cost,
      COALESCE((SELECT json_agg(json_build_object(
        'org', n.org, 'cost_org', n.cost_org, 'brand_ids', n.brand_ids, 'campaign_id', n.campaign_id,
        'workflow_slug', n.workflow_slug, 'feature_slug', n.feature_slug, 'support_function', n.support_function, 'run_start_day', n.run_start_day,
        'audience_id', n.audience_id, 'service_name', n.service_name, 'runs', n.runs,
        'gross', n.m_gross::text, 'net', n.m_net::text, 'vendor', n.m_vendor::text, 'unpriced', n.m_unpriced::text)) FROM none_cost n), '[]'::json) AS none_cost,
      COALESCE((SELECT json_agg(json_build_object(
        'org_id', l.org_key, 'pool_key', l.pool_key, 'workflow_slug', l.workflow_slug, 'campaign_id', l.campaign_id,
        'units', (SELECT COUNT(*) FROM pipe_units u WHERE u.org_key IS NOT DISTINCT FROM l.org_key AND u.pool_key = l.pool_key
                  AND u.campaign_id IS NOT DISTINCT FROM l.campaign_id),
        'gross', l.gross::text, 'net', l.net::text, 'vendor', l.vendor::text, 'unpriced', l.unpriced::text))
        FROM lost l WHERE EXISTS (SELECT 1 FROM pooled p WHERE p.org_key IS NOT DISTINCT FROM l.org_key AND p.pool_key = l.pool_key
                                  AND p.campaign_id IS NOT DISTINCT FROM l.campaign_id)), '[]'::json) AS loss_pools,
      (SELECT COUNT(*) FROM walked WHERE NOT found AND parent_id IS NOT NULL AND depth >= ${MAX_WALK_DEPTH}) AS unplaced_runs
  `;
}

/**
 * Consumptions of `targetSql` (a SELECT of run_outcomes ids, direction consumed),
 * each resolved to its producing occurrence (rule 5) and flagged reuse when an
 * earlier consumption resolved to the same producer. The history read is every
 * consumption of the targets' subjects (each subject with every subject its
 * owner stated equivalent, migration 0073): a row's rank depends only on rows
 * declared before it, so later rows never move it.
 */
function resolvedConsumptionsSql(targetSql: SQL): SQL {
  return sql`
    WITH t AS MATERIALIZED (${targetSql}),
    -- One subject = its CANONICAL subject (an owner-stated equivalence's target,
    -- else itself, migration 0073) and every subject stated equivalent to it.
    subj AS MATERIALIZED (
      SELECT DISTINCT c.outcome_key, COALESCE(e.target_service, c.subject_service) AS cs, COALESCE(e.target_id, c.subject_id) AS cid
      FROM run_outcomes c
      LEFT JOIN subject_equivalences e ON e.subject_service = c.subject_service AND e.subject_id = c.subject_id
      WHERE c.id IN (SELECT id FROM t)
    ),
    members AS MATERIALIZED (
      SELECT s.outcome_key, s.cs, s.cid, s.cs AS ms, s.cid AS mid FROM subj s
      UNION
      SELECT s.outcome_key, s.cs, s.cid, e.subject_service, e.subject_id
      FROM subj s JOIN subject_equivalences e ON e.target_service = s.cs AND e.target_id = s.cid
    ),
    cons AS MATERIALIZED (
      SELECT c.id, c.run_id, c.declared_at, c.outcome_key, m.cs, m.cid
      FROM members m
      CROSS JOIN LATERAL (
        SELECT * FROM run_outcomes c
        WHERE c.direction = 'consumed' AND c.subject_service = m.ms
          AND c.subject_id = m.mid AND c.outcome_key = m.outcome_key
        OFFSET 0
      ) c
    ),
    res AS MATERIALIZED (
      SELECT c.*, p.id AS producer_id, p.run_id AS producer_run_id, p.declared_at AS producer_declared_at
      FROM cons c
      LEFT JOIN LATERAL (
        SELECT p.id, p.run_id, p.declared_at
        FROM members m
        CROSS JOIN LATERAL (
          SELECT * FROM run_outcomes p
          WHERE p.direction = 'produced' AND p.subject_service = m.ms AND p.subject_id = m.mid AND p.outcome_key = m.outcome_key
          OFFSET 0
        ) p
        WHERE m.outcome_key = c.outcome_key AND m.cs = c.cs AND m.cid = c.cid
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
    SELECT r.id, r.run_id, r.outcome_key, r.producer_id, r.producer_run_id, (r.producer_id IS NOT NULL AND r.rn > 1) AS reuse,
           cr.organization_id AS org_id, cr.brand_ids, cr.campaign_id, cr.workflow_slug, cr.feature_slug, cr.audience_id, cr.service_name,
           pr.organization_id AS src_org_id, pr.brand_ids AS src_brand_ids, pr.campaign_id AS src_campaign_id,
           pr.workflow_slug AS src_workflow_slug, pr.feature_slug AS src_feature_slug, pr.audience_id AS src_audience_id,
           to_char((cr.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS run_start_day,
           to_char((r.producer_declared_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS src_day,
           to_char((pr.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS src_run_start_day
    FROM ranked r
    CROSS JOIN LATERAL (
      SELECT organization_id, brand_ids, campaign_id, workflow_slug, feature_slug, audience_id, service_name, started_at FROM runs WHERE id = r.run_id OFFSET 0
    ) cr
    LEFT JOIN LATERAL (
      SELECT organization_id, brand_ids, campaign_id, workflow_slug, feature_slug, audience_id, started_at FROM runs WHERE id = r.producer_run_id OFFSET 0
    ) pr ON TRUE
    WHERE r.id IN (SELECT id FROM t)`;
}

interface ResolvedConsumption {
  id: string;
  runId: string;
  outcomeKey: string;
  producerId: string | null;
  producerRunId: string | null;
  reuse: boolean;
  orgId: string | null;
  tags: RunTags;
  /** The consuming run's service. */
  serviceName: string | null;
  /** The PRODUCING run's org and tags (null when no run declared producing the occurrence). */
  sourceOrgId: string | null;
  sourceTags: RunTags | null;
  /** UTC day the consuming run started. */
  runStartDay: string | null;
  /** UTC day the consumed (source) occurrence was declared, and the day its producing run started (null on unknown provenance). */
  sourceDay: string | null;
  sourceRunStartDay: string | null;
}

/** The tags a production order carries (org apart). */
export interface RunTags {
  brandIds: string[] | null;
  campaignId: string | null;
  workflowSlug: string | null;
  featureSlug: string | null;
  /** The run's audience (the one its lead was served under). */
  audienceId: string | null;
}

const tagsOf = (r: any): RunTags => ({
  brandIds: r.brand_ids ?? null,
  campaignId: r.campaign_id ?? null,
  workflowSlug: r.workflow_slug ?? null,
  featureSlug: r.feature_slug ?? null,
  audienceId: r.audience_id ?? null,
});

/** What runs a read: the stats pool for a request, the day's long-timeout transaction for the refresher. */
type Exec = { execute: (query: SQL) => Promise<unknown> };

async function resolveConsumptions(targetSql: SQL, exec: Exec = statsDb): Promise<ResolvedConsumption[]> {
  const rows = (await exec.execute(resolvedConsumptionsSql(targetSql))) as any[];
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    outcomeKey: r.outcome_key,
    producerId: r.producer_id ?? null,
    producerRunId: r.producer_run_id ?? null,
    reuse: r.reuse === true,
    orgId: r.org_id ?? null,
    tags: tagsOf(r),
    serviceName: r.service_name ?? null,
    sourceOrgId: r.src_org_id ?? null,
    sourceTags: r.producer_run_id
      ? {
          brandIds: r.src_brand_ids ?? null, campaignId: r.src_campaign_id ?? null, workflowSlug: r.src_workflow_slug ?? null,
          featureSlug: r.src_feature_slug ?? null, audienceId: r.src_audience_id ?? null,
        }
      : null,
    runStartDay: r.run_start_day ?? null,
    sourceDay: r.src_day ?? null,
    sourceRunStartDay: r.src_run_start_day ?? null,
  }));
}

/** Standard (production) cost of each producing occurrence named, live (rule 1-3). */
async function standardCostsOf(consumptions: ResolvedConsumption[], versions: VendorCostVersion[], inputs: AllocationInputs, exec: Exec = statsDb): Promise<Map<string, Money>> {
  const anchors = [...new Set(consumptions.filter((c) => c.producerRunId).map((c) => c.producerRunId!))];
  return occurrenceCosts(anchors, versions, inputs, exec);
}

const ZERO = (): Money => ({ gross: fx(0), net: fx(0), vendor: fx(0), unpricedGross: fx(0) });
const plus = (a: Money, b: Money): Money => ({
  gross: new Decimal(a.gross).plus(b.gross).toFixed(10),
  net: new Decimal(a.net).plus(b.net).toFixed(10),
  vendor: new Decimal(a.vendor).plus(b.vendor).toFixed(10),
  unpricedGross: new Decimal(a.unpricedGross).plus(b.unpricedGross).toFixed(10),
});

/** Wide precision for the split (the default 20 significant digits could drop decimals of a large total). */
const D = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });
const round10 = (x: Decimal.Value) => new D(x).toDecimalPlaces(10, Decimal.ROUND_HALF_UP);

/**
 * The produced outcome keys of each run's ANCHOR (itself or its nearest ancestor
 * declaring a produced occurrence, rule 1), with the Σ quantity per key. A run
 * without an anchor maps to []. Keys ordered by key (null last). v5: an occurrence
 * whose cost is re-routed to a lead state counts under that state (its inputs ride
 * the state), or under null when that cost is abnormal (its inputs ride no unit).
 * `inputs` null = the declared keys as stated (a caller asking only WHETHER a run rides an outcome).
 */
export async function anchorKeysOf(runIds: string[], inputs: AllocationInputs | null, exec: Exec = statsDb): Promise<Map<string, Array<{ outcomeKey: string | null; quantity: string }>>> {
  const out = new Map<string, Array<{ outcomeKey: string | null; quantity: string }>>();
  if (runIds.length === 0) return out;
  const ids = [...new Set(runIds)];
  for (const id of ids) out.set(id, []);
  const rows = (await exec.execute(sql`
    WITH RECURSIVE
    walk(run_id, cur_id, parent_id, depth, found) AS (
      SELECT r.id, r.id, r.parent_run_id, 0, ${stopsWalkSql(sql`r.id`)}
      FROM unnest(${`{${ids.join(",")}}`}::uuid[]) AS i(id)
      CROSS JOIN LATERAL (SELECT id, parent_run_id FROM runs WHERE id = i.id OFFSET 0) r
      UNION ALL
      SELECT w.run_id, p.id, p.parent_run_id, w.depth + 1, ${stopsWalkSql(sql`p.id`)}
      FROM walk w
      CROSS JOIN LATERAL (SELECT id, parent_run_id FROM runs WHERE id = w.parent_id OFFSET 0) p
      WHERE NOT w.found AND w.parent_id IS NOT NULL AND w.depth < ${MAX_WALK_DEPTH}
    ),
    ${allocationInputsCtes(inputs ?? { stepStates: [], pipeTargets: [] })},
    anchored AS MATERIALIZED (
      SELECT w.run_id, o.id AS occurrence_id, o.run_id AS anchor_id, o.quantity, o.outcome_key
      FROM walk w JOIN run_outcomes o ON o.run_id = w.cur_id AND o.direction = 'produced'
      WHERE w.found
    ),
    ${inputs ? occurrenceRoutesSql("anchored") : sql`oroute AS (SELECT occurrence_id, outcome_key AS dest_key FROM anchored)`}
    SELECT a.run_id, r.dest_key AS outcome_key, SUM(a.quantity)::text AS quantity
    FROM anchored a JOIN oroute r ON r.occurrence_id = a.occurrence_id
    GROUP BY a.run_id, r.dest_key
    ORDER BY a.run_id, r.dest_key NULLS LAST
  `)) as any[];
  for (const r of rows) out.get(r.run_id)!.push({ outcomeKey: r.outcome_key, quantity: r.quantity });
  return out;
}

export interface ConsumptionPart {
  /** The outcome the consuming production order makes (its anchor's produced key; v5: the lead state its cost rides). Null = its run produced nothing, or its cost is abnormal loss. */
  outcomeKey: string | null;
  /** Share of this consumption going to that outcome: 1 for a single-outcome order, quantity-weighted otherwise. */
  weight: string;
  standardCost: Money | null;
}

/**
 * Splits one consumption over the outcomes its production order makes, in
 * proportion to the quantities, by the v1 cumulative rounding at 10 decimals:
 * the weights sum to exactly 1 and the standard costs to exactly the consumption's.
 */
export function splitConsumption(keys: Array<{ outcomeKey: string | null; quantity: string }>, standard: Money | null): ConsumptionPart[] {
  if (keys.length === 0) return [{ outcomeKey: null, weight: "1.0000000000", standardCost: standard }];
  const total = keys.reduce((s, k) => s.plus(k.quantity), new D(0));
  let cum = new D(0);
  return keys.map((k) => {
    const prev = cum;
    cum = cum.plus(k.quantity);
    const share = (x: string) => round10(new D(x).times(cum).div(total)).minus(round10(new D(x).times(prev).div(total))).toFixed(10);
    return {
      outcomeKey: k.outcomeKey,
      weight: share("1"),
      standardCost: standard
        ? { gross: share(standard.gross), net: share(standard.net), vendor: share(standard.vendor), unpricedGross: share(standard.unpricedGross) }
        : null,
    };
  });
}

/**
 * One stored row of the outcome totals (outcome_cost_days). Grain per kind:
 *  - produced_count: occurrences DECLARED that UTC day, per outcome x declaring run's tags (cost org = its org).
 *  - produced_cost: the v1 shares of the day's spend (UTC day of the cost row, org of the cost row),
 *    per outcome x the declaring run's tags.
 *  - consumed: consumptions DECLARED that UTC day, per (consuming outcome, consumed outcome) x the
 *    consuming run's tags (cost org = its org) x the PRODUCING run's org and tags (source*, null when
 *    the provenance is unknown): weights, reuses, unknown provenance, standard cost, reuse gain.
 *  - none: the day's spend no declaring run carries, per the spending run's tags x cost org.
 */
export interface OutcomeCostRow {
  /**
   * v5 kinds: abnormal (spend in no unit cost, per reason, the paying run's tags);
   * parallel_cost / parallel_none (the routed spend priced in the OTHER state family:
   * a lead state's price is produced_cost + parallel_cost of its key, never summed across keys).
   */
  kind: "produced_count" | "produced_cost" | "consumed" | "none" | "abnormal" | "parallel_cost" | "parallel_none";
  outcomeKey: string | null;
  consumedOutcomeKey: string | null;
  organizationId: string | null;
  costOrganizationId: string | null;
  /** kind 'none' only: the support function of that spend (null = undeclared spend). Null on every other kind. */
  supportFunction: SupportFunction | null;
  /** kind 'abnormal' only: why. */
  abnormalReason: AbnormalReason | null;
  tags: RunTags;
  /** Service of the run whose tags the row carries (declaring / consuming / spending run). */
  serviceName: string | null;
  /** consumed only: the run that produced the consumed occurrence (null otherwise, and on unknown provenance). */
  sourceOrganizationId: string | null;
  sourceTags: RunTags | null;
  /** UTC day the run whose tags the row carries started (declaring run / consuming run / spending run). */
  runStartDay: string | null;
  /** consumed only: UTC day the consumed occurrence was declared, and the day its producing run started. */
  sourceDay: string | null;
  sourceRunStartDay: string | null;
  n: string;
  quantity: string;
  reuses: string;
  unknown: string;
  money: Money;
  reuseMoney: Money;
}

export async function computeLedgerDay(day: string, versions: VendorCostVersion[], inputs?: AllocationInputs): Promise<LedgerDay> {
  const allocationInputs = inputs ?? (await fetchAllocationInputs());
  // Background work: EVERY read of the day runs in one read-only transaction on
  // the stats pool with its own timeout (the pool's 30 s is for request reads; on
  // a cold, loaded box a day's ~25k run lookups took minutes, and the consumption
  // resolution of a backfilled day timed out at 30 s, 2026-10-23).
  return statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '900s'`);
    const [t] = (await tx.execute(sql`SELECT now() AS at`)) as any[];
    return computeLedgerDayIn(tx, day, versions, allocationInputs, new Date(t.at));
  });
}

async function computeLedgerDayIn(tx: Exec, day: string, versions: VendorCostVersion[], inputs: AllocationInputs, computedAt: Date): Promise<LedgerDay> {
  const [row] = (await tx.execute(ledgerDaySql(day, versions, inputs))) as any[];
  const orgs = new Map<string, LedgerDayOrgRow>();
  for (const r of row.orgs as any[]) {
    orgs.set(r.org_id ?? "", {
      organizationId: r.org_id ?? null,
      ledger: money(r, "ledger"),
      allocated: money(r, "allocated"),
      producedNone: money(r, "none"),
      supportByFunction: {},
      normalLoss: money(r, "loss"),
      abnormal: money(r, "abn"),
      abnormalByReason: {},
      reuse: ZERO(),
      reuseCount: 0,
      unknownProvenance: 0,
      costRows: Number(r.cost_rows),
      occurrences: Number(r.occurrences),
    });
  }
  for (const r of row.support as any[]) {
    // Every support row's org has ledger spend that day: its row exists.
    orgs.get(r.org_id ?? "")!.supportByFunction[r.kind as SupportFunction] = money(r, "s");
  }
  for (const r of row.abnormal as any[]) {
    orgs.get(r.org_id ?? "")!.abnormalByReason[r.reason as AbnormalReason] = money(r, "s");
  }
  // Reuse charges of the day's consumptions (rule 5), on the consuming run's org.
  const consumptions = await resolveConsumptions(sql`
    SELECT id FROM run_outcomes
    WHERE direction = 'consumed'
      AND declared_at >= (${day}::date)::timestamp AT TIME ZONE 'UTC'
      AND declared_at < (${day}::date + 1)::timestamp AT TIME ZONE 'UTC'`, tx);
  const standard = consumptions.some((c) => c.producerId) ? await standardCostsOf(consumptions, versions, inputs, tx) : new Map<string, Money>();
  for (const c of consumptions) {
    if (c.producerId && !c.reuse) continue;
    const key = c.orgId ?? "";
    if (!orgs.has(key)) {
      orgs.set(key, {
        organizationId: c.orgId, ledger: ZERO(), allocated: ZERO(), producedNone: ZERO(), supportByFunction: {}, normalLoss: ZERO(),
        abnormal: ZERO(), abnormalByReason: {}, reuse: ZERO(),
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
  const outcomeCosts: OutcomeCostRow[] = [];
  const blank = (kind: OutcomeCostRow["kind"], r: any): OutcomeCostRow => ({
    kind,
    outcomeKey: r.outcome_key ?? null,
    consumedOutcomeKey: null,
    organizationId: r.org ?? null,
    costOrganizationId: r.cost_org ?? null,
    supportFunction: r.support_function ?? null,
    abnormalReason: r.abnormal_reason ?? null,
    tags: tagsOf(r),
    serviceName: r.service_name ?? null,
    sourceOrganizationId: null,
    sourceTags: null,
    runStartDay: r.run_start_day ?? null,
    sourceDay: null,
    sourceRunStartDay: null,
    n: fx(0),
    quantity: fx(0),
    reuses: fx(0),
    unknown: fx(0),
    money: { gross: fx(r.gross), net: fx(r.net), vendor: fx(r.vendor), unpricedGross: fx(r.unpriced) },
    reuseMoney: ZERO(),
  });
  for (const r of row.produced_cost as any[]) outcomeCosts.push(blank("produced_cost", r));
  // 'none' rows: n = distinct spending runs (the reconciliation's undeclared run count).
  for (const r of row.none_cost as any[]) outcomeCosts.push({ ...blank("none", r), n: fx(r.runs) });
  // v5: abnormal loss per reason and the parallel family, under the paying run's tags (n = distinct paying runs).
  for (const r of [...(row.abnormal_cost as any[]), ...(row.parallel_cost as any[])]) outcomeCosts.push({ ...blank(r.kind, r), n: fx(r.runs) });
  // v5: lead states first reached that day (lead-service's real instant), one unit per lead x brand x state.
  const reached = (await tx.execute(sql`
    SELECT state AS outcome_key, organization_id::text AS org, ARRAY[brand_id]::text[] AS brand_ids, COUNT(*)::text AS n
    FROM lead_state_reaches
    WHERE removed_at IS NULL
      AND reached_at >= (${day}::date)::timestamp AT TIME ZONE 'UTC'
      AND reached_at < (${day}::date + 1)::timestamp AT TIME ZONE 'UTC'
    GROUP BY 1, 2, 3
  `)) as any[];
  for (const r of reached) {
    outcomeCosts.push({ ...blank("produced_count", { ...r, cost_org: r.org }), n: fx(r.n), quantity: fx(r.n), money: ZERO() });
  }
  const declared = (await tx.execute(sql`
    SELECT o.outcome_key, r.organization_id::text AS org, r.brand_ids, r.campaign_id, r.workflow_slug, r.feature_slug,
           r.audience_id, r.service_name, to_char((r.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS run_start_day,
           COUNT(*)::text AS n, SUM(o.quantity)::text AS quantity
    FROM run_outcomes o
    CROSS JOIN LATERAL (
      SELECT organization_id, brand_ids, campaign_id, workflow_slug, feature_slug, audience_id, service_name, started_at
      FROM runs WHERE id = o.run_id OFFSET 0
    ) r
    WHERE o.direction = 'produced'
      AND o.declared_at >= (${day}::date)::timestamp AT TIME ZONE 'UTC'
      AND o.declared_at < (${day}::date + 1)::timestamp AT TIME ZONE 'UTC'
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
  `)) as any[];
  for (const r of declared) {
    outcomeCosts.push({ ...blank("produced_count", { ...r, cost_org: r.org }), n: fx(r.n), quantity: fx(r.quantity), money: ZERO() });
  }
  const consumingKeys = await anchorKeysOf(consumptions.map((c) => c.runId), inputs, tx);
  const consumed = new Map<string, OutcomeCostRow>();
  for (const c of consumptions) {
    const std = c.producerId ? standard.get(c.producerId) ?? ZERO() : null;
    for (const part of splitConsumption(consumingKeys.get(c.runId) ?? [], std)) {
      const k = JSON.stringify([
        part.outcomeKey, c.outcomeKey, c.orgId, c.tags.brandIds, c.tags.campaignId, c.tags.workflowSlug, c.tags.featureSlug,
        c.tags.audienceId, c.serviceName, c.sourceOrgId, c.sourceTags, c.runStartDay, c.sourceDay, c.sourceRunStartDay,
      ]);
      if (!consumed.has(k)) {
        consumed.set(k, {
          ...blank("consumed", { outcome_key: part.outcomeKey, org: c.orgId, cost_org: c.orgId, ...{ brand_ids: c.tags.brandIds, campaign_id: c.tags.campaignId, workflow_slug: c.tags.workflowSlug, feature_slug: c.tags.featureSlug, audience_id: c.tags.audienceId, service_name: c.serviceName, run_start_day: c.runStartDay } }),
          consumedOutcomeKey: c.outcomeKey,
          sourceOrganizationId: c.sourceOrgId,
          sourceTags: c.sourceTags,
          sourceDay: c.sourceDay,
          sourceRunStartDay: c.sourceRunStartDay,
          money: ZERO(),
        });
      }
      const g = consumed.get(k)!;
      g.n = new Decimal(g.n).plus(part.weight).toFixed(10);
      if (c.reuse) g.reuses = new Decimal(g.reuses).plus(part.weight).toFixed(10);
      if (!c.producerId) g.unknown = new Decimal(g.unknown).plus(part.weight).toFixed(10);
      if (part.standardCost) {
        g.money = plus(g.money, part.standardCost);
        if (c.reuse) g.reuseMoney = plus(g.reuseMoney, part.standardCost);
      }
    }
  }
  outcomeCosts.push(...consumed.values());
  return {
    day,
    computedAt,
    outcomeCosts,
    orgs: [...orgs.values()].sort((a, b) => (a.organizationId ?? "").localeCompare(b.organizationId ?? "")),
    coverage: (row.coverage as any[]).map((r) => ({
      serviceName: r.service_name,
      taskName: r.task_name,
      spendGross: fx(r.spend_gross),
      coveredGross: fx(r.covered_gross),
      spendNet: fx(r.spend_net),
      coveredNet: fx(r.covered_net),
      supportByFunction: Object.fromEntries(
        (row.coverage_support as any[])
          .filter((x) => x.service_name === r.service_name && x.task_name === r.task_name)
          .map((x) => [x.kind, { gross: fx(x.gross), net: fx(x.net) }]),
      ),
    })),
    lossPools: (row.loss_pools as any[]).map((r) => ({
      organizationId: r.org_id ?? null,
      poolKey: r.pool_key,
      workflowSlug: r.workflow_slug ?? null,
      campaignId: r.campaign_id ?? null,
      units: Number(r.units),
      loss: { gross: fx(r.gross), net: fx(r.net), vendor: fx(r.vendor), unpricedGross: fx(r.unpriced) },
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
    await tx.execute(sql`DELETE FROM outcome_cost_days WHERE day = ${d.day}::date AND allocation_version = ${ALLOCATION_VERSION}`);
    await tx.execute(sql`DELETE FROM cost_loss_pool_days WHERE day = ${d.day}::date AND allocation_version = ${ALLOCATION_VERSION}`);
    if (d.lossPools.length > 0) {
      await tx.execute(sql`
        INSERT INTO cost_loss_pool_days (day, allocation_version, organization_id, pool_key, workflow_slug, campaign_id, units, gross, net, vendor, unpriced_gross)
        SELECT ${d.day}::date, ${ALLOCATION_VERSION}, x.org, x.pk, x.wf, x.cmp, x.units, x.g, x.n, x.v, x.u
        FROM jsonb_to_recordset(${JSON.stringify(
          d.lossPools.map((p) => ({
            org: p.organizationId, pk: p.poolKey, wf: p.workflowSlug, cmp: p.campaignId, units: p.units,
            g: p.loss.gross, n: p.loss.net, v: p.loss.vendor, u: p.loss.unpricedGross,
          })),
        )}::jsonb) AS x(org uuid, pk text, wf text, cmp text, units bigint, g numeric, n numeric, v numeric, u numeric)
      `);
    }
    if (d.outcomeCosts.length > 0) {
      await tx.execute(sql`
        INSERT INTO outcome_cost_days (
          day, allocation_version, kind, outcome_key, consumed_outcome_key, organization_id, cost_organization_id,
          brand_ids, campaign_id, workflow_slug, feature_slug, n, quantity, reuses, unknown_provenance,
          gross, net, vendor, unpriced_gross, reuse_gross, reuse_net, reuse_vendor, reuse_unpriced_gross,
          source_organization_id, source_brand_ids, source_campaign_id, source_workflow_slug, source_feature_slug, support_function,
          run_start_day, source_day, source_run_start_day, audience_id, source_audience_id, service_name, abnormal_reason
        )
        SELECT ${d.day}::date, ${ALLOCATION_VERSION}, x.kind, x.ok, x.ck, x.org, x.corg, x.brands, x.cmp, x.wf, x.ft,
               x.n, x.q, x.ru, x.up, x.g, x.ne, x.v, x.u, x.rg, x.rn, x.rv, x.rup,
               x.sorg, x.sbrands, x.scmp, x.swf, x.sft, x.sf, x.rsd, x.sd, x.srsd, x.aud, x.saud, x.svc, x.ar
        FROM jsonb_to_recordset(${JSON.stringify(
          d.outcomeCosts.map((o) => ({
            kind: o.kind, ok: o.outcomeKey, ck: o.consumedOutcomeKey, org: o.organizationId, corg: o.costOrganizationId,
            brands: o.tags.brandIds, cmp: o.tags.campaignId, wf: o.tags.workflowSlug, ft: o.tags.featureSlug,
            n: o.n, q: o.quantity, ru: o.reuses, up: o.unknown,
            g: o.money.gross, ne: o.money.net, v: o.money.vendor, u: o.money.unpricedGross,
            rg: o.reuseMoney.gross, rn: o.reuseMoney.net, rv: o.reuseMoney.vendor, rup: o.reuseMoney.unpricedGross,
            sorg: o.sourceOrganizationId, sbrands: o.sourceTags?.brandIds ?? null, scmp: o.sourceTags?.campaignId ?? null,
            swf: o.sourceTags?.workflowSlug ?? null, sft: o.sourceTags?.featureSlug ?? null,
            sf: o.supportFunction,
            rsd: o.runStartDay, sd: o.sourceDay, srsd: o.sourceRunStartDay,
            aud: o.tags.audienceId, saud: o.sourceTags?.audienceId ?? null, svc: o.serviceName, ar: o.abnormalReason,
          })),
        )}::jsonb) AS x(kind text, ok text, ck text, org uuid, corg uuid, brands text[], cmp text, wf text, ft text,
                        n numeric, q numeric, ru numeric, up numeric, g numeric, ne numeric, v numeric, u numeric,
                        rg numeric, rn numeric, rv numeric, rup numeric,
                        sorg uuid, sbrands text[], scmp text, swf text, sft text, sf text, rsd date, sd date, srsd date,
                        aud text, saud text, svc text, ar text)
      `);
    }
    if (d.orgs.length > 0) {
      await tx.execute(sql`
        INSERT INTO cost_ledger_days (
          day, allocation_version, organization_id,
          ledger_gross, ledger_net, ledger_vendor, ledger_unpriced_gross,
          allocated_gross, allocated_net, allocated_vendor, allocated_unpriced_gross,
          none_gross, none_net, none_vendor, none_unpriced_gross,
          reuse_gross, reuse_net, reuse_vendor, reuse_unpriced_gross, reuse_count, unknown_provenance_count,
          cost_rows, occurrences, support_by_function, loss_gross, loss_net, loss_vendor, loss_unpriced_gross,
          abnormal_gross, abnormal_net, abnormal_vendor, abnormal_unpriced_gross, abnormal_by_reason
        )
        SELECT ${d.day}::date, ${ALLOCATION_VERSION}, x.org,
               x.lg, x.ln, x.lv, x.lu, x.ag, x.an, x.av, x.au, x.ng, x.nn, x.nv, x.nu,
               x.rg, x.rn, x.rv, x.ru, x.rc, x.up, x.rows, x.occ, x.sbf, x.wg, x.wn, x.wv, x.wu,
               x.xg, x.xn, x.xv, x.xu, x.abr
        FROM jsonb_to_recordset(${JSON.stringify(
          d.orgs.map((o) => ({
            org: o.organizationId,
            lg: o.ledger.gross, ln: o.ledger.net, lv: o.ledger.vendor, lu: o.ledger.unpricedGross,
            ag: o.allocated.gross, an: o.allocated.net, av: o.allocated.vendor, au: o.allocated.unpricedGross,
            ng: o.producedNone.gross, nn: o.producedNone.net, nv: o.producedNone.vendor, nu: o.producedNone.unpricedGross,
            rg: o.reuse.gross, rn: o.reuse.net, rv: o.reuse.vendor, ru: o.reuse.unpricedGross,
            rc: o.reuseCount, up: o.unknownProvenance,
            rows: o.costRows, occ: o.occurrences, sbf: o.supportByFunction,
            wg: o.normalLoss.gross, wn: o.normalLoss.net, wv: o.normalLoss.vendor, wu: o.normalLoss.unpricedGross,
            xg: o.abnormal.gross, xn: o.abnormal.net, xv: o.abnormal.vendor, xu: o.abnormal.unpricedGross, abr: o.abnormalByReason,
          })),
        )}::jsonb) AS x(org uuid, lg numeric, ln numeric, lv numeric, lu numeric, ag numeric, an numeric, av numeric, au numeric,
                        ng numeric, nn numeric, nv numeric, nu numeric, rg numeric, rn numeric, rv numeric, ru numeric,
                        rc bigint, up bigint, rows bigint, occ bigint, sbf jsonb, wg numeric, wn numeric, wv numeric, wu numeric,
                        xg numeric, xn numeric, xv numeric, xu numeric, abr jsonb)
      `);
    }
    if (d.coverage.length > 0) {
      await tx.execute(sql`
        INSERT INTO outcome_coverage_days (day, allocation_version, service_name, task_name, spend_gross, covered_gross, spend_net, covered_net, support_by_function)
        SELECT ${d.day}::date, ${ALLOCATION_VERSION}, x.s, x.t, x.sg, x.cg, x.sn, x.cn, x.sbf
        FROM jsonb_to_recordset(${JSON.stringify(
          d.coverage.map((c) => ({ s: c.serviceName, t: c.taskName, sg: c.spendGross, cg: c.coveredGross, sn: c.spendNet, cn: c.coveredNet, sbf: c.supportByFunction })),
        )}::jsonb) AS x(s text, t text, sg numeric, cg numeric, sn numeric, cn numeric, sbf jsonb)
      `);
    }
    await tx.execute(sql`
      INSERT INTO cost_ledger_computed_days (day, allocation_version, computed_at, outcome_costs, consumed_sources, support_split, start_days, stale)
      VALUES (${d.day}::date, ${ALLOCATION_VERSION}, ${d.computedAt.toISOString()}::timestamptz, true, true, true, true, false)
      ON CONFLICT (day, allocation_version) DO UPDATE SET computed_at = EXCLUDED.computed_at, outcome_costs = true, consumed_sources = true, support_split = true, start_days = true, stale = false
    `);
  });
}

// ---------------------------------------------------------------------------
// The to-the-cent check (pure)
// ---------------------------------------------------------------------------

export interface LedgerCheckInput {
  ledger: Money;
  /** v5: spend in no unit cost (a line apart). */
  abnormal: Money;
  /** Σ standard cost charged on occurrences: production spread + reuse charges. */
  standard: Money;
  reuseGain: Money;
  producedNone: Money;
}

export interface LedgerCheckResult {
  balanced: boolean;
  /** standard - reuseGain + producedNone + abnormal - ledger, per basis, 10-decimal strings ("0.0000000000" when balanced). */
  differences: Money;
}

const BASES: Array<keyof Money> = ["gross", "net", "vendor", "unpricedGross"];

/** standard - reuseGain + producedNone + abnormal == ledger, EXACTLY, on every basis. No tolerance. */
export function checkLedgerRow(row: LedgerCheckInput): LedgerCheckResult {
  const differences = {} as Money;
  let balanced = true;
  for (const k of BASES) {
    const diff = new Decimal(row.standard[k]).minus(row.reuseGain[k]).plus(row.producedNone[k]).plus(row.abnormal[k]).minus(row.ledger[k]);
    if (!diff.isZero()) balanced = false;
    differences[k] = diff.toFixed(10);
  }
  return { balanced, differences };
}

/** The check input of a stored (day, org) row: standard = spread + reuse charges, gain = reuse charges. */
export function ledgerCheckInputOf(r: Pick<LedgerDayOrgRow, "ledger" | "allocated" | "producedNone" | "reuse" | "abnormal">): LedgerCheckInput {
  return { ledger: r.ledger, standard: plus(r.allocated, r.reuse), reuseGain: r.reuse, producedNone: r.producedNone, abnormal: r.abnormal };
}

// ---------------------------------------------------------------------------
// Refresher: the stored daily series
// ---------------------------------------------------------------------------

/** Days always kept stored back from today, even on a database with no older spend. */
export const LEDGER_BACKFILL_DAYS = 60;
/** Recent days are always recomputed: costs keep landing (holds turn actual, late writes). */
const RECOMPUTE_RECENT_DAYS = 3;
const REFRESH_INTERVAL_MS = 15 * 60_000;
const FIRST_TICK_MS = 60_000;

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

/**
 * First UTC day the refresher keeps stored: the first day of spend in the ledger
 * (2026-02-02 in prod), so a backfill on any past run lands in a stored day and
 * the check covers 100 % of spend, or LEDGER_BACKFILL_DAYS back, whichever is first.
 */
export async function firstLedgerDay(today: string): Promise<string> {
  const [row] = (await db.execute(sql`
    SELECT to_char(MIN(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM runs_costs
  `)) as any[];
  const floor = addDays(today, -(LEDGER_BACKFILL_DAYS - 1));
  return row?.day && row.day < floor ? row.day : floor;
}

/** The columns a day must be stored with under the current version (else it is recomputed). */
const CURRENT_DAY_SQL = sql`outcome_costs AND consumed_sources AND support_split AND start_days`;

/**
 * Stored days whose figures predate a fact recorded after them, so they read
 * STALE until the refresher recomputes them:
 *  - a declaration RECORDED after the day was computed (on time or a backfill),
 *    when the day is on or after its run's start or its effective declaration day:
 *    a produced one re-anchors the run's (and its descendants') cost rows, which
 *    land from the run's start; a consumption counts on its effective day and ranks
 *    the later reuses of its producer;
 *  - a support mark (moves every day from its run's start);
 *  - a declaration taken back or a support mark undone (from the first day its
 *    rows could have touched, stated on the event);
 *  - SPEND landing on a past day after it was computed: a late incurred cost
 *    (0048, dated in the past) or a hold materialized days after it was taken
 *    (3,255 in the week to 2026-10-24): the day's ledger itself moved.
 * One grouped read per kind: per earliest affected day, the newest recording instant.
 */
export async function staleComputedDays(computed: Map<string, Date>, after?: Date): Promise<Set<string>> {
  const out = new Set<string>();
  if (computed.size === 0) return out;
  // Facts recorded after `after` only (a read: since the refresher's last sweep).
  const oldestMs = Math.min(...[...computed.values()].map((d) => d.getTime()));
  const oldest = new Date(after ? Math.max(oldestMs, after.getTime()) : oldestMs).toISOString();
  // Per RUN first (earliest declaration, newest recording), then one PK probe per
  // run: the plain join hash-joined all 6.3M runs, 375 s in prod while producers
  // backfilled 788k occurrences in a day (2026-10-24). Pairing a run's earliest
  // declaration with its newest recording can only flag MORE days (recomputed
  // byte for byte), never fewer.
  const late = (await db.execute(sql`
    WITH o AS MATERIALIZED (
      SELECT run_id, MIN(declared_at) AS first_declared, MAX(COALESCE(recorded_at, declared_at)) AS last_recorded
      FROM run_outcomes
      WHERE COALESCE(recorded_at, declared_at) > ${oldest}::timestamptz
      GROUP BY run_id
    )
    SELECT to_char(LEAST(o.first_declared, r.started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
           MAX(o.last_recorded) AS last_recorded
    FROM o CROSS JOIN LATERAL (SELECT started_at FROM runs WHERE id = o.run_id OFFSET 0) r
    GROUP BY 1
  `)) as any[];
  const marks = (await db.execute(sql`
    WITH m AS MATERIALIZED (SELECT run_id, marked_at FROM run_support_marks WHERE marked_at > ${oldest}::timestamptz)
    SELECT to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, MAX(m.marked_at) AS last_recorded
    FROM m CROSS JOIN LATERAL (SELECT started_at FROM runs WHERE id = m.run_id OFFSET 0) r
    GROUP BY 1
  `)) as any[];
  for (const [day, at] of computed) {
    if ([...late, ...marks].some((l) => l.day <= day && new Date(l.last_recorded) > at)) out.add(day);
  }
  const voids = (await db.execute(sql`
    SELECT payload->>'affectedFromDay' AS from_day, MAX(occurred_at) AS occurred_at FROM outcome_declaration_events
    WHERE event_type IN ('outcomes.voided', 'outcomes.voided_scoped', 'run.support_unmarked') AND occurred_at > ${oldest}::timestamptz
    GROUP BY 1
  `)) as any[];
  for (const v of voids) {
    const at = new Date(v.occurred_at);
    for (const [day, computedAt] of computed) if (day >= v.from_day && computedAt < at) out.add(day);
  }
  // An equivalence stated after a day was computed re-resolves every consumption
  // of its two subjects: from the first day either subject was declared.
  const equated = (await db.execute(sql`
    WITH e AS MATERIALIZED (SELECT * FROM subject_equivalences WHERE stated_at > ${oldest}::timestamptz)
    SELECT to_char(MIN(o.declared_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, MAX(e.stated_at) AS last_recorded
    FROM e
    CROSS JOIN LATERAL (
      SELECT o.declared_at FROM run_outcomes o WHERE o.subject_service = e.subject_service AND o.subject_id = e.subject_id
      UNION ALL
      SELECT o.declared_at FROM run_outcomes o WHERE o.subject_service = e.target_service AND o.subject_id = e.target_id
    ) o
    GROUP BY e.subject_service, e.subject_id
  `)) as any[];
  for (const [day, at] of computed) {
    if (equated.some((l) => l.day && l.day <= day && new Date(l.last_recorded) > at)) out.add(day);
  }
  // v5: a lead state reached, re-dated or removed after a day was computed moves the
  // routing of every run that acted on that lead: from the first day anything was
  // declared on the lead (its earliest occurrence or its anchor run's start).
  const reaches = (await db.execute(sql`
    WITH l AS MATERIALIZED (
      SELECT lead_id, MAX(changed_at) AS changed_at FROM lead_state_reaches
      WHERE changed_at > ${oldest}::timestamptz GROUP BY lead_id
    )
    SELECT to_char(MIN(LEAST(o.declared_at, r.started_at)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, MAX(l.changed_at) AS last_recorded
    FROM l
    CROSS JOIN LATERAL (
      SELECT o.declared_at, o.run_id FROM run_outcomes o
      WHERE o.subject_service = 'lead-service' AND o.subject_id = l.lead_id AND o.direction = 'produced'
      OFFSET 0
    ) o
    CROSS JOIN LATERAL (SELECT started_at FROM runs WHERE id = o.run_id OFFSET 0) r
    GROUP BY l.lead_id
  `)) as any[];
  for (const [day, at] of computed) {
    if (reaches.some((l) => l.day && l.day <= day && new Date(l.last_recorded) > at)) out.add(day);
  }
  // Spend that landed on an EARLIER day than the one it was recorded on: only those
  // rows can move a stored day (a cost row written on time lands on today).
  const spend = (await db.execute(sql`
    WITH e AS MATERIALIZED (
      SELECT cost_id, occurred_at FROM cost_lifecycle_events
      WHERE event_type = 'cost.materialized' AND occurred_at > ${oldest}::timestamptz
      UNION ALL
      SELECT cost_id, occurred_at FROM cost_lifecycle_events
      WHERE event_type = 'cost.added' AND occurred_at > ${oldest}::timestamptz AND payload ? 'incurredAt'
    )
    SELECT to_char(rc.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, MAX(e.occurred_at) AS occurred_at
    FROM e CROSS JOIN LATERAL (SELECT created_at FROM runs_costs WHERE id = e.cost_id OFFSET 0) rc
    WHERE (rc.created_at AT TIME ZONE 'UTC')::date < (e.occurred_at AT TIME ZONE 'UTC')::date
    GROUP BY 1
  `)) as any[];
  for (const c of spend) {
    const at = new Date(c.occurred_at);
    const computedAt = computed.get(c.day);
    if (computedAt && computedAt < at) out.add(c.day);
  }
  return out;
}

/**
 * Stored days of [since, until] that are STALE (a fact recorded after them, see
 * staleComputedDays): every read lists them in daysMissing (and apart in
 * daysStale), so nothing reads a past day as complete while a backfill still
 * moves it.
 */
export async function staleDaysIn(since: string, until: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, computed_at, stale FROM cost_ledger_computed_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND day BETWEEN ${since}::date AND ${until}::date AND ${CURRENT_DAY_SQL}
  `)) as any[];
  return [...(await currentStale(rows))].sort();
}

/**
 * Stale days among stored `rows` (day, computed_at, stale): flagged by a sweep
 * (a fact recorded before it; storeLedgerDay clears the flag on recompute), plus
 * facts recorded after the last sweep. Exact and incremental: a fact before the
 * last sweep was judged by it against the computed_at of that time, and a day
 * recomputed since then is newer than that fact.
 */
async function currentStale(rows: Array<{ day: string; computed_at: unknown; stale: boolean }>): Promise<Set<string>> {
  const [sweep] = (await db.execute(sql`
    SELECT swept_at FROM cost_ledger_stale_sweeps WHERE allocation_version = ${ALLOCATION_VERSION}
  `)) as any[];
  const stale = await staleComputedDays(
    new Map(rows.filter((r) => !r.stale).map((r) => [r.day, new Date(r.computed_at as string)])),
    sweep ? new Date(sweep.swept_at) : undefined,
  );
  for (const r of rows) if (r.stale) stale.add(r.day);
  return stale;
}

/**
 * The sweep: flags the stored days found stale and records the instant it read
 * from, taken BEFORE its reads, so a fact recorded during the sweep is seen by
 * the next window. Each sweep reads only the facts since the previous one.
 */
async function persistStaleDays(stale: Set<string>, sweptAt: Date): Promise<void> {
  const staleDays = [...stale];
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE cost_ledger_computed_days SET stale = true
      WHERE allocation_version = ${ALLOCATION_VERSION} AND NOT stale
        AND day = ANY(${`{${staleDays.join(",")}}`}::date[])
        -- a day recomputed after the sweep read its facts is current: never flag it
        AND computed_at < ${sweptAt.toISOString()}::timestamptz
    `);
    await tx.execute(sql`
      INSERT INTO cost_ledger_stale_sweeps (allocation_version, swept_at) VALUES (${ALLOCATION_VERSION}, ${sweptAt.toISOString()}::timestamptz)
      ON CONFLICT (allocation_version) DO UPDATE SET swept_at = GREATEST(cost_ledger_stale_sweeps.swept_at, EXCLUDED.swept_at)
    `);
  });
}

/** Days the next tick must (re)compute: recent days, then missing or stale days newest first. */
export async function daysToCompute(now = new Date(), firstDay?: string, persistStale = false): Promise<string[]> {
  const today = utcDay(now);
  const first = firstDay ?? (await firstLedgerDay(today));
  const [t] = (await db.execute(sql`SELECT now() AS at`)) as any[];
  const sweptAt = new Date(t.at);
  const rows = (await db.execute(sql`
    SELECT to_char(day, 'YYYY-MM-DD') AS day, computed_at, stale FROM cost_ledger_computed_days
    WHERE allocation_version = ${ALLOCATION_VERSION} AND day >= ${first}::date
      -- a day stored before the outcome totals (0058), the consumed sources (0063),
      -- the support split (0064) or the run-start / source days (0067) is recomputed
      AND ${CURRENT_DAY_SQL}
  `)) as any[];
  const computed = new Map(rows.map((r) => [r.day as string, new Date(r.computed_at)]));
  const out = new Set<string>();
  for (let day = first; day <= today; day = addDays(day, 1)) if (!computed.has(day)) out.add(day);
  for (let i = 0; i < RECOMPUTE_RECENT_DAYS; i++) out.add(addDays(today, -i));
  const stale = await currentStale(rows);
  if (persistStale) await persistStaleDays(stale, sweptAt);
  for (const day of stale) out.add(day);
  // Recent days first (they feed today's monitor), then days never computed,
  // then stale days, each newest first. Missing before stale: while producers
  // backfill, the newest days stay stale on every tick, and ranked by date alone
  // they took every slot and the older missing days were never reached (2026-10-23:
  // 8 days stored out of 265).
  const recent = new Set(Array.from({ length: RECOMPUTE_RECENT_DAYS }, (_, i) => addDays(today, -i)));
  const rank = (d: string) => (recent.has(d) ? 0 : computed.has(d) ? 2 : 1);
  return [...out].sort((a, b) => rank(a) - rank(b) || (a < b ? 1 : -1));
}

/**
 * Time budget of one tick: days are computed one at a time until it is spent
 * (a day takes ~1-50 s on the box), so a backlog of months clears in a few ticks
 * while the 15-min cadence keeps a third of the time free.
 */
export const TICK_BUDGET_MS = 10 * 60_000;

export async function refreshLedgerDays(
  now = new Date(),
  maxDays = Infinity,
  firstDay?: string,
  budgetMs = TICK_BUDGET_MS,
): Promise<{ computed: string[]; failed: string[] }> {
  const started = Date.now();
  const versions = await fetchVendorCostCatalog();
  // v5 inputs: the catalogue's lead states and pipe targets, then lead-service's
  // first reaches synced BEFORE the stale sweep (a changed reach stales its days).
  const inputs = await fetchAllocationInputs();
  const sync = await syncLeadStates(inputs.stepStates);
  if (sync.changed + sync.removed > 0) {
    console.log(`[Runs Service] lead states synced: ${sync.upserted} reaches, ${sync.changed} new or changed, ${sync.removed} removed`);
  }
  const days = (await daysToCompute(now, firstDay, true)).slice(0, maxDays);
  const computed: string[] = [];
  const failed: string[] = [];
  for (const day of days) {
    if (Date.now() - started >= budgetMs) break;
    const t0 = Date.now();
    try {
      const d = await computeLedgerDay(day, versions, inputs);
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
  /** Effective declaration time (what every rule keys on); a backfill states it in the past. */
  declaredAt: string;
  /** When runs-service recorded it (= declaredAt for an on-time declaration). */
  recordedAt: string;
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
  /** PRODUCED: `cost` per (UTC day, org) of the spend it carries (sums exactly to cost). CONSUMED: null. */
  costSlices: CostSlice[] | null;
  /** CONSUMED: the producing occurrence it resolved to and the standard cost charged. PRODUCED: null. */
  consumption: {
    sourceOccurrenceId: string | null;
    sourceRunId: string | null;
    reuse: boolean;
    provenance: "known" | "unknown";
    standardCost: Money | null;
    /** The outcome(s) the consuming production order makes, and this consumption's share of each (weights sum to 1). */
    consumingOutcomes: ConsumptionPart[];
  } | null;
}

/**
 * Per produced occurrence of `anchorIds`: its v1 share of its run's subtree cost
 * (descendants that declare their own produced occurrences are THEIR anchors and
 * excluded with their subtrees), summed over its (UTC day, org) groups — the same
 * groups the stored days split, so Σ occurrences of a day = that day's allocated.
 */
export async function occurrenceCosts(anchorIds: string[], versions: VendorCostVersion[], inputs: AllocationInputs, exec: Exec = statsDb): Promise<Map<string, Money>> {
  const slices = await occurrenceCostSlices(anchorIds, versions, inputs, exec);
  return new Map([...slices].map(([id, c]) => [id, c.total]));
}

export interface CostSlice {
  /** UTC day of the cost rows. */
  day: string;
  /** Org of the cost rows (the ledger check's org: null for platform-billed spend). */
  costOrganizationId: string | null;
  cost: Money;
}

/** Per produced occurrence: its cost and the (UTC day, cost org) slices it sums, day then org order. */
export async function occurrenceCostSlices(anchorIds: string[], versions: VendorCostVersion[], inputs: AllocationInputs, exec: Exec = statsDb): Promise<Map<string, { total: Money; slices: CostSlice[] }>> {
  if (anchorIds.length === 0) return new Map();
  const vj = vendorJoinSql("b");
  const rows = (await exec.execute(sql`
    WITH RECURSIVE
    v AS MATERIALIZED (${versionWindowsSql(versions)}),
    anchors AS MATERIALIZED (SELECT DISTINCT unnest(${`{${anchorIds.join(",")}}`}::uuid[]) AS anchor_id),
    sub(anchor_id, run_id, depth) AS (
      SELECT anchor_id, anchor_id, 0 FROM anchors
      UNION ALL
      SELECT s.anchor_id, c.id, s.depth + 1
      FROM sub s
      CROSS JOIN LATERAL (SELECT id FROM runs WHERE parent_run_id = s.run_id OFFSET 0) c
      WHERE s.depth < ${MAX_WALK_DEPTH} AND NOT ${stopsWalkSql(sql`c.id`)}
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
    SELECT o.id, to_char(g.day, 'YYYY-MM-DD') AS day, g.org_key,
      ${shareSql("gross")}::text AS gross, ${shareSql("net")}::text AS net,
      ${shareSql("vendor")}::text AS vendor, ${shareSql("unpriced")}::text AS unpriced
    FROM o LEFT JOIN g ON g.anchor_id = o.anchor_id
    ORDER BY o.id, g.day, g.org_key NULLS FIRST
  `)) as any[];
  // Rule 4b: each occurrence's share of the loss pool of (its declaration's UTC
  // day, its run's org, its run's pool key and campaign), as the day stored it. Units = the
  // pipeUnitsSql definition (same predicate, same order).
  const loss = (await exec.execute(sql`
    WITH lo AS MATERIALIZED (
      SELECT o.id, (o.declared_at AT TIME ZONE 'UTC')::date AS day, r.org_key, r.pool_key, r.campaign_id
      FROM run_outcomes o
      CROSS JOIN LATERAL (SELECT organization_id::text AS org_key, ${poolKeySql("")} AS pool_key, campaign_id FROM runs WHERE id = o.run_id OFFSET 0) r
      WHERE o.direction = 'produced' AND o.run_id = ANY(${`{${anchorIds.join(",")}}`}::uuid[])
    ),
    g AS MATERIALIZED (
      SELECT p.day, p.organization_id::text AS org_key, p.pool_key, p.campaign_id,
             p.gross, p.net, p.vendor, p.unpriced_gross AS unpriced
      FROM cost_loss_pool_days p
      WHERE p.allocation_version = ${ALLOCATION_VERSION}
        AND EXISTS (SELECT 1 FROM lo WHERE lo.day = p.day AND lo.pool_key = p.pool_key AND lo.org_key IS NOT DISTINCT FROM p.organization_id::text
                    AND lo.campaign_id IS NOT DISTINCT FROM p.campaign_id)
    )
    SELECT o.id, to_char(g.day, 'YYYY-MM-DD') AS day, g.org_key,
      ${shareSql("gross")}::text AS gross, ${shareSql("net")}::text AS net,
      ${shareSql("vendor")}::text AS vendor, ${shareSql("unpriced")}::text AS unpriced
    FROM g
    CROSS JOIN LATERAL (
      SELECT x.id, x.quantity,
             SUM(x.quantity) OVER (ORDER BY x.id) AS cum_q,
             SUM(x.quantity) OVER () AS q_total
      FROM (
        SELECT u.id, u.quantity
        FROM run_outcomes u
        CROSS JOIN LATERAL (SELECT organization_id::text AS org_key, ${poolKeySql("")} AS pool_key, campaign_id FROM runs WHERE id = u.run_id OFFSET 0) r
        WHERE u.direction = 'produced'
          AND u.declared_at >= (g.day)::timestamp AT TIME ZONE 'UTC'
          AND u.declared_at < (g.day + 1)::timestamp AT TIME ZONE 'UTC'
          AND r.pool_key = g.pool_key AND r.org_key IS NOT DISTINCT FROM g.org_key
          AND r.campaign_id IS NOT DISTINCT FROM g.campaign_id
        OFFSET 0
      ) x
    ) o
    WHERE o.id IN (SELECT id FROM lo)
  `)) as any[];
  const out = new Map<string, { total: Money; slices: CostSlice[] }>();
  for (const r of rows) {
    if (!out.has(r.id)) out.set(r.id, { total: ZERO(), slices: [] });
    if (r.day === null) continue; // no spend under this occurrence's run
    const c = out.get(r.id)!;
    const cost = { gross: fx(r.gross), net: fx(r.net), vendor: fx(r.vendor), unpricedGross: fx(r.unpriced) };
    c.slices.push({ day: r.day, costOrganizationId: r.org_key ?? null, cost });
    c.total = plus(c.total, cost);
  }
  for (const r of loss) {
    const c = out.get(r.id);
    if (!c) continue;
    const cost = { gross: fx(r.gross), net: fx(r.net), vendor: fx(r.vendor), unpricedGross: fx(r.unpriced) };
    const same = c.slices.find((x) => x.day === r.day && x.costOrganizationId === (r.org_key ?? null));
    if (same) same.cost = plus(same.cost, cost);
    else c.slices.push({ day: r.day, costOrganizationId: r.org_key ?? null, cost });
    c.total = plus(c.total, cost);
  }
  for (const c of out.values()) {
    c.slices.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.costOrganizationId ?? "").localeCompare(b.costOrganizationId ?? "")));
  }
  // v5: an occurrence whose cost is re-routed (to a lead state, or abnormal) is a
  // by-product: it carries $0 here, its share is on the state (stored days).
  if (out.size > 0) {
    const rerouted = (await exec.execute(sql`
      WITH ${allocationInputsCtes(inputs)},
      occ AS MATERIALIZED (
        SELECT id AS occurrence_id, run_id AS anchor_id FROM run_outcomes
        WHERE id = ANY(${`{${[...out.keys()].join(",")}}`}::uuid[])
      ),
      ${occurrenceRoutesSql("occ")}
      SELECT occurrence_id FROM oroute WHERE rerouted
    `)) as any[];
    for (const r of rerouted) out.set(r.occurrence_id, { total: ZERO(), slices: [] });
  }
  return out;
}

function consumptionOf(
  c: ResolvedConsumption | undefined,
  costs: Map<string, Money>,
  keys: Array<{ outcomeKey: string | null; quantity: string }>,
): OccurrenceWithCost["consumption"] {
  if (!c || !c.producerId) {
    return { sourceOccurrenceId: null, sourceRunId: null, reuse: false, provenance: "unknown", standardCost: null, consumingOutcomes: splitConsumption(keys, null) };
  }
  const standardCost = costs.get(c.producerId) ?? null;
  return {
    sourceOccurrenceId: c.producerId,
    sourceRunId: c.producerRunId,
    reuse: c.reuse,
    provenance: "known",
    standardCost,
    consumingOutcomes: splitConsumption(keys, standardCost),
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
           COALESCE(o.recorded_at, o.declared_at) AS recorded_at, r.brand_ids, r.campaign_id, r.workflow_slug, r.feature_slug, r.audience_id
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
  const inputs = await fetchAllocationInputs();
  const sliced = anchors.length > 0 ? await occurrenceCostSlices(anchors, await fetchVendorCostCatalog(), inputs) : new Map<string, { total: Money; slices: CostSlice[] }>();
  const costs = new Map([...sliced].map(([id, c]) => [id, c.total]));
  const consumingKeys = await anchorKeysOf(page.filter((r) => r.direction === "consumed").map((r) => r.run_id as string), inputs);
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
      recordedAt: new Date(r.recorded_at).toISOString(),
      tags: {
        brandIds: r.brand_ids ?? [],
        campaignId: r.campaign_id ?? null,
        workflowSlug: r.workflow_slug ?? null,
        featureSlug: r.feature_slug ?? null,
        audienceId: r.audience_id ?? null,
      },
      cost: r.direction === "produced" ? costs.get(r.id) ?? null : null,
      costSlices: r.direction === "produced" ? sliced.get(r.id)?.slices ?? null : null,
      consumption: r.direction === "consumed" ? consumptionOf(resolvedById.get(r.id), costs, consumingKeys.get(r.run_id) ?? []) : null,
    })),
    nextCursor: rows.length > f.limit ? page[page.length - 1].id : null,
  };
}
