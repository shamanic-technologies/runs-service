// Support spend, named and reported apart (COST-SUPPORT-1024-RUNS, migration 0064).
//
// Doctrine (cost-accounting skill, "Not outcomes ... Support functions, reported
// apart"): some spend produces no outcome BY DESIGN. A run marked SUPPORT names
// which support function it serves; the ledger's anchor walk stops there (0062),
// so its own and its non-declaring subtree's cost stay off every outcome, and the
// stored days state that spend per function, apart from the spend nobody declared
// yet. Coverage then reads on outcome spend only: declared / (ledger - support).
//
// Who marks: the OWNING service, at run creation (`support` on POST /v1/runs,
// /v1/platform-runs) or later in bulk for its past runs (POST
// /v1/platform-runs/support-marks/{preview,apply}); staff for any service through
// /internal/runs/support-marks{,/preview} (runs of services with no owner left:
// retired products, selected by service or by FEATURE). Never inferred from a
// cost name.
//
// A mark can be UNDONE (migration 0065, owner 2026-10-24: a retired product may
// come back, its past spend then moves back onto outcomes): a bronze
// `run.support_unmarked` event, the projection deletes the silver mark, the run
// declares again, the refresher recomputes the days it moved. Bronze keeps both.

import { sql, type SQL } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { outcomeDeclarationEvents } from "../db/schema.js";
import { ALLOCATION_VERSION, anchorKeysOf } from "./outcome-ledger.js";
import { SUPPORT_FUNCTIONS } from "../schemas.js";

export { SUPPORT_FUNCTIONS };
export type SupportFunction = (typeof SUPPORT_FUNCTIONS)[number];

export const SUPPORT_FUNCTION_DESCRIPTIONS: Record<SupportFunction, string> = {
  payment_fees: "payment processor fees (Stripe)",
  brand_setup: "brand setup: reading/scraping a brand, extracting its fields",
  copilot: "the Copilot (chat, WhatsApp)",
  platform_llm: "platform LLM calls / judgments made for no caller run",
  staff_experiment: "a staff probe, test or experiment",
  product_feature: "a product feature or onboarding step (audience suggestions, split confirm...)",
  retired_product: "spend of a product no longer in the fleet",
  unattributed_production: "production work that belongs to no pipe and whose subject was never recorded (before campaigns existed): an unabsorbed period cost, its own line",
};

/** Runs one bulk mark may write; a wider selection is narrowed (422), never cut. */
export const MAX_SUPPORT_MARK_RUNS = 50_000;

export interface SupportMark {
  kind: SupportFunction;
  reason: string;
  markedBy: string;
}

/** The bronze event marking one run (projected into run_support_marks by trigger). */
export const supportMarkEvent = (runId: string, m: SupportMark) => ({
  runId,
  eventType: "run.support_marked",
  sourceService: m.markedBy,
  payload: { allocationVersion: ALLOCATION_VERSION, kind: m.kind, reason: m.reason, markedBy: m.markedBy },
});

/**
 * Marks runs SUPPORT: one bronze `run.support_marked` event per run not yet
 * marked. The caller has checked every run exists and declares no produced
 * occurrence. Idempotent: an already marked run writes nothing (its first
 * function stays until the mark is undone, see unmarkRunsSupport).
 */
export async function markRunsSupport(runIds: string[], m: SupportMark): Promise<{ marked: string[]; alreadyMarked: string[] }> {
  const already = new Set<string>();
  for (let i = 0; i < runIds.length; i += 5000) {
    const rows = (await db.execute(sql`SELECT run_id FROM run_support_marks WHERE run_id = ANY(${`{${runIds.slice(i, i + 5000).join(",")}}`}::uuid[])`)) as any[];
    for (const r of rows) already.add(r.run_id as string);
  }
  const fresh = runIds.filter((id) => !already.has(id));
  for (let i = 0; i < fresh.length; i += 500) {
    await db.insert(outcomeDeclarationEvents).values(fresh.slice(i, i + 500).map((runId) => supportMarkEvent(runId, m)));
  }
  return { marked: fresh, alreadyMarked: runIds.filter((id) => already.has(id)) };
}

export interface SupportSelection {
  /** Service whose runs are selected (the owner's own name on the owner door). */
  serviceName?: string;
  /** Runs carrying one of these feature slugs (staff door: a product, whatever service ran it). ANDs with serviceName. */
  featureSlugs?: string[];
  /** Or these runs (checked by the caller: exist, owned, declaring nothing). */
  runIds?: string[];
  taskNames?: string[];
  startedAfter?: string;
  startedBefore?: string;
  /** Only runs with no parent (e.g. judgments made for no caller run). */
  topLevelOnly?: boolean;
  /** Only runs that carry spend (an actual or refunded cost row). */
  withSpendOnly?: boolean;
  /** Leave out runs whose cost rides an ancestor's outcome today (spend already on production stays there). */
  offOutcomeOnly?: boolean;
  /** Leave out runs whose cost already stops on an ANCESTOR's support mark (marking them would relabel that owner's decision). */
  offAncestorMarkOnly?: boolean;
}

export interface SupportSelectionResult {
  /** Runs the apply marks (matched, not declaring an outcome, not yet marked). */
  toMark: string[];
  matchedRunCount: number;
  alreadyMarkedCount: number;
  /** Matched runs that declared a produced occurrence: production, never support, left as they are. */
  declaresOutcomesCount: number;
  /** Own spend (actual + refunded) of the runs to mark, gross and frozen net. */
  spend: { grossCents: string; netCents: string };
  /** Runs to mark whose cost rides an ancestor's outcome today: the mark takes it off that outcome. Null = not computed (tooMany). */
  onOutcomeNowCount: number | null;
  /** offOutcomeOnly: runs left out because their cost rides an ancestor's outcome today (0 without it). Null = not computed (tooMany). */
  leftOnOutcomeCount: number | null;
  /** Runs to mark whose cost stops on an ancestor's support mark today: the mark relabels it (0 with offAncestorMarkOnly). Null = not computed (tooMany). */
  onAncestorMarkNowCount: number | null;
  /** offAncestorMarkOnly: runs left out because their cost stops on an ancestor's support mark (0 without it). Null = not computed (tooMany). */
  leftOnAncestorMarkCount: number | null;
  tooMany: boolean;
}

/**
 * Runs (of `runIds`, each unmarked and declaring nothing) whose walk up the
 * parent chain stops on a SUPPORT MARK before any declaring run: their cost is
 * already stated support under an ancestor's function. Same walk as the ledger
 * (nearest declaring or marked ancestor wins).
 */
async function onAncestorMark(runIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < runIds.length; i += 5000) {
    const ids = runIds.slice(i, i + 5000);
    const rows = (await db.execute(sql`
      WITH RECURSIVE walk(run_id, parent_id, depth, stop) AS (
        SELECT r.id, r.parent_run_id, 0, NULL::text
        FROM unnest(${`{${ids.join(",")}}`}::uuid[]) AS i(id)
        CROSS JOIN LATERAL (SELECT id, parent_run_id FROM runs WHERE id = i.id OFFSET 0) r
        UNION ALL
        SELECT w.run_id, p.parent_run_id, w.depth + 1,
               CASE WHEN EXISTS (SELECT 1 FROM run_outcomes o WHERE o.run_id = p.id AND o.direction = 'produced') THEN 'outcome'
                    WHEN EXISTS (SELECT 1 FROM run_support_marks m WHERE m.run_id = p.id) THEN 'mark' END
        FROM walk w
        CROSS JOIN LATERAL (SELECT id, parent_run_id FROM runs WHERE id = w.parent_id OFFSET 0) p
        WHERE w.stop IS NULL AND w.parent_id IS NOT NULL AND w.depth < 1000
      )
      SELECT run_id FROM walk WHERE stop = 'mark'
    `)) as any[];
    for (const r of rows) out.add(r.run_id);
  }
  return out;
}

/**
 * The runs a bulk mark selects. Preview and apply run the same selection, so
 * what the preview shows is what apply writes. One scan of `runs` filtered by
 * service (no service-first index: ~9 s on 6M runs), in its own transaction
 * with a statement timeout sized for it.
 */
export async function selectSupportRuns(s: SupportSelection, maxRuns = MAX_SUPPORT_MARK_RUNS): Promise<SupportSelectionResult> {
  const where: SQL[] = s.runIds ? [sql`r.id = ANY(${`{${s.runIds.join(",")}}`}::uuid[])`] : [];
  if (!s.runIds && s.serviceName) where.push(sql`r.service_name = ${s.serviceName}`);
  if (!s.runIds && s.featureSlugs?.length) where.push(sql`r.feature_slug IN (SELECT jsonb_array_elements_text(${JSON.stringify(s.featureSlugs)}::jsonb))`);
  if (where.length === 0) throw new Error("support selection needs runIds, serviceName or featureSlugs");
  if (s.taskNames?.length) where.push(sql`r.task_name IN (SELECT jsonb_array_elements_text(${JSON.stringify(s.taskNames)}::jsonb))`);
  if (s.startedAfter) where.push(sql`r.started_at >= ${s.startedAfter}::timestamptz`);
  if (s.startedBefore) where.push(sql`r.started_at < ${s.startedBefore}::timestamptz`);
  if (s.topLevelOnly) where.push(sql`r.parent_run_id IS NULL`);
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
    return (await tx.execute(sql`
      SELECT x.id, x.has_parent, x.produces, x.marked, x.gross::text AS gross, x.net::text AS net
      FROM (
        SELECT r.id, r.parent_run_id IS NOT NULL AS has_parent,
               EXISTS (SELECT 1 FROM run_outcomes o WHERE o.run_id = r.id AND o.direction = 'produced') AS produces,
               EXISTS (SELECT 1 FROM run_support_marks m WHERE m.run_id = r.id) AS marked,
               sp.gross, sp.net, sp.n
        FROM runs r
        CROSS JOIN LATERAL (
          SELECT COALESCE(SUM(rc.total_cost_in_usd_cents), 0) AS gross,
                 COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)), 0) AS net,
                 COUNT(*) AS n
          FROM runs_costs rc WHERE rc.run_id = r.id AND rc.status IN ('actual','refunded') OFFSET 0
        ) sp
        WHERE ${sql.join(where, sql` AND `)}
      ) x
      ${s.withSpendOnly ? sql`WHERE x.n > 0` : sql``}
    `)) as any[];
  });
  const candidates = rows.filter((r) => !r.produces && !r.marked);
  const tooMany = candidates.length > maxRuns;
  const withParent = tooMany ? [] : candidates.filter((r) => r.has_parent).map((r) => r.id as string);
  const onOutcome = new Set<string>();
  for (let i = 0; i < withParent.length; i += 5000) {
    const keys = await anchorKeysOf(withParent.slice(i, i + 5000), db);
    for (const [id, k] of keys) if (k.length > 0) onOutcome.add(id);
  }
  const onMark = tooMany ? new Set<string>() : await onAncestorMark(withParent);
  const toMarkRows = candidates
    .filter((r) => !(s.offOutcomeOnly && onOutcome.has(r.id)))
    .filter((r) => !(s.offAncestorMarkOnly && onMark.has(r.id)));
  // Over the cap the walk is not run: the count is unknown, never a reassuring 0.
  const onOutcomeNowCount = tooMany ? null : s.offOutcomeOnly ? 0 : onOutcome.size;
  const leftOnOutcomeCount = tooMany ? null : s.offOutcomeOnly ? onOutcome.size : 0;
  const onAncestorMarkNowCount = tooMany ? null : s.offAncestorMarkOnly ? 0 : onMark.size;
  const leftOnAncestorMarkCount = tooMany ? null : s.offAncestorMarkOnly ? onMark.size : 0;
  return {
    toMark: toMarkRows.map((r) => r.id as string),
    matchedRunCount: rows.length,
    alreadyMarkedCount: rows.filter((r) => r.marked).length,
    declaresOutcomesCount: rows.filter((r) => r.produces).length,
    spend: {
      grossCents: toMarkRows.reduce((a, r) => a.plus(r.gross), new Decimal(0)).toFixed(10),
      netCents: toMarkRows.reduce((a, r) => a.plus(r.net), new Decimal(0)).toFixed(10),
    },
    onOutcomeNowCount,
    leftOnOutcomeCount,
    onAncestorMarkNowCount,
    leftOnAncestorMarkCount,
    tooMany,
  };
}

export interface SupportUnmark {
  reason: string;
  unmarkedBy: string;
}

export interface MarkedSelectionResult {
  /** Marked runs the unmark removes. */
  toUnmark: string[];
  /** Runs per support function removed. */
  byFunction: Partial<Record<SupportFunction, number>>;
  /** Own spend (actual + refunded) of those runs, gross and frozen net. */
  spend: { grossCents: string; netCents: string };
  tooMany: boolean;
}

/**
 * The MARKED runs an unmark selects (same selection fields as a mark, plus the
 * function to remove). Preview and apply share it.
 */
export async function selectMarkedRuns(
  s: Omit<SupportSelection, "withSpendOnly" | "offOutcomeOnly" | "offAncestorMarkOnly"> & { kind?: SupportFunction },
  maxRuns = MAX_SUPPORT_MARK_RUNS,
): Promise<MarkedSelectionResult> {
  const where: SQL[] = s.runIds ? [sql`r.id = ANY(${`{${s.runIds.join(",")}}`}::uuid[])`] : [];
  if (!s.runIds && s.serviceName) where.push(sql`r.service_name = ${s.serviceName}`);
  if (!s.runIds && s.featureSlugs?.length) where.push(sql`r.feature_slug IN (SELECT jsonb_array_elements_text(${JSON.stringify(s.featureSlugs)}::jsonb))`);
  if (where.length === 0) throw new Error("support selection needs runIds, serviceName or featureSlugs");
  if (s.kind) where.push(sql`m.kind = ${s.kind}`);
  if (s.taskNames?.length) where.push(sql`r.task_name IN (SELECT jsonb_array_elements_text(${JSON.stringify(s.taskNames)}::jsonb))`);
  if (s.startedAfter) where.push(sql`r.started_at >= ${s.startedAfter}::timestamptz`);
  if (s.startedBefore) where.push(sql`r.started_at < ${s.startedBefore}::timestamptz`);
  if (s.topLevelOnly) where.push(sql`r.parent_run_id IS NULL`);
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
    return (await tx.execute(sql`
      SELECT r.id, m.kind, sp.gross::text AS gross, sp.net::text AS net
      FROM run_support_marks m JOIN runs r ON r.id = m.run_id
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(rc.total_cost_in_usd_cents), 0) AS gross,
               COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)), 0) AS net
        FROM runs_costs rc WHERE rc.run_id = r.id AND rc.status IN ('actual','refunded') OFFSET 0
      ) sp
      WHERE ${sql.join(where, sql` AND `)}
    `)) as any[];
  });
  const byFunction: Partial<Record<SupportFunction, number>> = {};
  for (const r of rows) byFunction[r.kind as SupportFunction] = (byFunction[r.kind as SupportFunction] ?? 0) + 1;
  return {
    toUnmark: rows.map((r) => r.id as string),
    byFunction,
    spend: {
      grossCents: rows.reduce((a, r) => a.plus(r.gross), new Decimal(0)).toFixed(10),
      netCents: rows.reduce((a, r) => a.plus(r.net), new Decimal(0)).toFixed(10),
    },
    tooMany: rows.length > maxRuns,
  };
}

/**
 * Undoes the support marks of these runs: one bronze `run.support_unmarked`
 * event per run still marked (the function removed, reason, who, and the first
 * UTC day the mark could have moved: the run's start). The projection deletes
 * the silver mark; bronze keeps the mark AND its undo. Idempotent: a run not
 * marked writes nothing.
 */
export async function unmarkRunsSupport(runIds: string[], u: SupportUnmark): Promise<{ unmarked: string[]; notMarked: string[] }> {
  const marked = new Map<string, { kind: string; fromDay: string }>();
  for (let i = 0; i < runIds.length; i += 5000) {
    const rows = (await db.execute(sql`
      SELECT m.run_id, m.kind, to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS from_day
      FROM run_support_marks m JOIN runs r ON r.id = m.run_id
      WHERE m.run_id = ANY(${`{${runIds.slice(i, i + 5000).join(",")}}`}::uuid[])
    `)) as any[];
    for (const r of rows) marked.set(r.run_id as string, { kind: r.kind, fromDay: r.from_day });
  }
  const ids = runIds.filter((id) => marked.has(id));
  for (let i = 0; i < ids.length; i += 500) {
    await db.insert(outcomeDeclarationEvents).values(
      ids.slice(i, i + 500).map((runId) => ({
        runId,
        eventType: "run.support_unmarked",
        sourceService: u.unmarkedBy,
        payload: {
          allocationVersion: ALLOCATION_VERSION,
          kind: marked.get(runId)!.kind,
          reason: u.reason,
          unmarkedBy: u.unmarkedBy,
          affectedFromDay: marked.get(runId)!.fromDay,
        },
      })),
    );
  }
  return { unmarked: ids, notMarked: runIds.filter((id) => !marked.has(id)) };
}
