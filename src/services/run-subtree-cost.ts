import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { costAggregateSelectSql } from "./cost-aggregator.js";

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
}

/**
 * BILLED cost of each run's whole subtree (its own rows + every descendant's),
 * keyed by root run id — the same aggregation as GET /v1/runs/:id's
 * totalCostInUsdCents (costAggregateSelectSql, status IN ('actual','provisioned')).
 * Bounded recursive CTE anchored on the given ids (idx_runs_parent), never a view.
 * A root with no cost rows anywhere in its subtree is absent from the map (= 0).
 */
export async function subtreeBilledCostByRoot(runIds: string[]): Promise<Map<string, SubtreeBilledCost>> {
  const out = new Map<string, SubtreeBilledCost>();
  if (runIds.length === 0) return out;
  const rows = (await db.execute(sql`
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
      SUM(c.provisioned_cost::numeric)::text AS provisioned_cost
    FROM descendants d
    CROSS JOIN LATERAL (
      SELECT ${costAggregateSelectSql("rc")}, count(*) AS n
      FROM runs_costs rc WHERE rc.run_id = d.id
    ) c
    WHERE c.n > 0
    GROUP BY d.root_run_id
  `)) as any[];
  for (const row of rows) out.set(row.root_run_id as string, row as SubtreeBilledCost);
  return out;
}
