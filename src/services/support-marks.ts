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
// retired products). Never inferred from a cost name.

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
 * function stays: a mark is final).
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
  /** Or these runs (checked by the caller: exist, owned, declaring nothing). */
  runIds?: string[];
  taskNames?: string[];
  startedAfter?: string;
  startedBefore?: string;
  /** Only runs with no parent (e.g. judgments made for no caller run). */
  topLevelOnly?: boolean;
  /** Only runs that carry spend (an actual or refunded cost row). */
  withSpendOnly?: boolean;
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
  /** Runs to mark whose cost rides an ancestor's outcome today: the mark takes it off that outcome. */
  onOutcomeNowCount: number;
  tooMany: boolean;
}

/**
 * The runs a bulk mark selects. Preview and apply run the same selection, so
 * what the preview shows is what apply writes. One scan of `runs` filtered by
 * service (no service-first index: ~9 s on 6M runs), in its own transaction
 * with a statement timeout sized for it.
 */
export async function selectSupportRuns(s: SupportSelection): Promise<SupportSelectionResult> {
  const where: SQL[] = s.runIds
    ? [sql`r.id = ANY(${`{${s.runIds.join(",")}}`}::uuid[])`]
    : [sql`r.service_name = ${s.serviceName}`];
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
  const toMarkRows = rows.filter((r) => !r.produces && !r.marked);
  const tooMany = toMarkRows.length > MAX_SUPPORT_MARK_RUNS;
  const withParent = tooMany ? [] : toMarkRows.filter((r) => r.has_parent).map((r) => r.id as string);
  let onOutcomeNowCount = 0;
  for (let i = 0; i < withParent.length; i += 5000) {
    const keys = await anchorKeysOf(withParent.slice(i, i + 5000), db);
    for (const k of keys.values()) if (k.length > 0) onOutcomeNowCount += 1;
  }
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
    tooMany,
  };
}
