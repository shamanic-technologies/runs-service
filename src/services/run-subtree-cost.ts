import { sql } from "drizzle-orm";
import { readDb } from "../db/index.js";
import { costAggregateNetSelectSql, costAggregateSelectSql } from "./cost-aggregator.js";
import { SUBTREE_COST_ROLLUP_NAME } from "./stats-rollup-subtree-cost.js";

/** Tokens GET /v1/runs accepts in `include`. */
export const RUN_LIST_INCLUDES = ["subtreeCost"] as const;
export type RunListInclude = (typeof RUN_LIST_INCLUDES)[number];

/**
 * The largest page `include=subtreeCost` walks. The walk is bounded by the page
 * (the page's runs and their descendants), so the page must be bounded too:
 * without a limit a campaign-trigger list is tens of thousands of whole trees.
 */
export const SUBTREE_COST_MAX_LIMIT = 500;

/** Parse `include` (comma-separated). Unknown token = error, never ignored. */
export function parseRunListInclude(
  raw: unknown,
): { error: string } | { includes: Set<RunListInclude> } {
  if (raw === undefined || raw === null || raw === "") return { includes: new Set() };
  if (typeof raw !== "string") return { error: "include must be a comma-separated string" };
  const includes = new Set<RunListInclude>();
  for (const token of raw.split(",").map((t) => t.trim()).filter(Boolean)) {
    if (!(RUN_LIST_INCLUDES as readonly string[]).includes(token)) {
      return { error: `include: unknown value '${token}' (allowed: ${RUN_LIST_INCLUDES.join(", ")})` };
    }
    includes.add(token as RunListInclude);
  }
  return { includes };
}

export interface SubtreeBilledCost {
  total_cost: string;
  actual_cost: string;
  provisioned_cost: string;
  net_total_cost: string;
  net_actual_cost: string;
  net_provisioned_cost: string;
}

/**
 * BILLED cost of each run's whole subtree (its own rows + every descendant's),
 * keyed by root run id — the same aggregation as GET /v1/runs/:id's
 * totalCostInUsdCents (costAggregateSelectSql, status IN ('actual','provisioned')),
 * plus the same split on the frozen NET basis (costAggregateNetSelectSql:
 * COALESCE(net, gross), so a row written before the discount freeze reads net == gross).
 * Bounded recursive CTE anchored on the given ids (idx_runs_parent), never a view.
 * A root with no cost rows anywhere in its subtree is absent from the map (= 0).
 */
export async function subtreeBilledCostByRoot(runIds: string[]): Promise<Map<string, SubtreeBilledCost>> {
  const out = new Map<string, SubtreeBilledCost>();
  if (runIds.length === 0) return out;
  const stored = await storedSubtreeCosts(runIds);
  const rows = stored ?? (await liveSubtreeCosts(runIds));
  for (const row of rows) out.set(row.root_run_id as string, row as SubtreeBilledCost);
  return out;
}

/**
 * From run_subtree_costs (migration 0086, maintained at cost-write time): one PK probe per run,
 * or null while the rollup is not stamped (a rebuild is clearing it, or it never ran). Stamp and
 * rows are read in ONE statement, so a rebuild cannot un-stamp between them.
 * Live walk: ~1 s per 200-run page on the loaded box, 89k calls a day (2026-10-27).
 */
async function storedSubtreeCosts(runIds: string[]): Promise<any[] | null> {
  const rows = (await readDb.execute(sql`
    WITH ready AS (SELECT EXISTS (SELECT 1 FROM stats_rollups WHERE name = ${SUBTREE_COST_ROLLUP_NAME}) AS ok)
    SELECT NULL::uuid AS root_run_id, NULL AS total_cost, NULL AS actual_cost, NULL AS provisioned_cost,
      NULL AS net_total_cost, NULL AS net_actual_cost, NULL AS net_provisioned_cost, ready.ok AS ready
    FROM ready
    UNION ALL
    SELECT s.run_id,
      (s.gross_actual + s.gross_provisioned)::text, s.gross_actual::text, s.gross_provisioned::text,
      (s.net_actual + s.net_provisioned)::text, s.net_actual::text, s.net_provisioned::text, true
    FROM run_subtree_costs s, ready
    WHERE ready.ok AND s.n_rows > 0
      AND s.run_id = ANY(string_to_array(${runIds.join(",")}, ',')::uuid[])
  `)) as any[];
  const flag = rows.find((r) => r.root_run_id === null);
  if (!flag?.ready) return null;
  return rows.filter((r) => r.root_run_id !== null);
}

async function liveSubtreeCosts(runIds: string[]): Promise<any[]> {
  return (await readDb.execute(sql`
    WITH RECURSIVE descendants AS (
      SELECT id, id AS root_run_id FROM runs
      WHERE id = ANY(string_to_array(${runIds.join(",")}, ',')::uuid[])
      UNION ALL
      SELECT r.id, d.root_run_id FROM runs r INNER JOIN descendants d ON r.parent_run_id = d.id
    )
    -- Per-run LATERAL aggregate, then summed per root. A plain JOIN to runs_costs
    -- makes the planner trust the recursive CTE's estimate (~270k rows for 50
    -- roots in prod) and hash-join a seq scan of the whole ledger: 1.2 s for a
    -- 50-run page. The LATERAL walks idx_runs_costs_run_agg per run: ~15 ms.
    SELECT
      d.root_run_id,
      SUM(c.total_cost::numeric)::text AS total_cost,
      SUM(c.actual_cost::numeric)::text AS actual_cost,
      SUM(c.provisioned_cost::numeric)::text AS provisioned_cost,
      SUM(c.net_total_cost::numeric)::text AS net_total_cost,
      SUM(c.net_actual_cost::numeric)::text AS net_actual_cost,
      SUM(c.net_provisioned_cost::numeric)::text AS net_provisioned_cost
    FROM descendants d
    CROSS JOIN LATERAL (
      SELECT ${costAggregateSelectSql("rc")}, ${costAggregateNetSelectSql("rc")}, count(*) AS n
      FROM runs_costs rc WHERE rc.run_id = d.id
    ) c
    WHERE c.n > 0
    GROUP BY d.root_run_id
  `)) as any[];
}
