// Read + rebuild side of the (feature_slug, workflow_slug[, cost_source]) rollup
// maintained by the triggers in migration 0034.
//
// It serves ONE shape of GET /v1/stats/public/costs — the cross-org fleet
// benchmark features-service asks for per viewed cell:
//   filters  ⊆ { featureSlug | featureSlugs, workflowSlugs (incl. a resolved
//               workflowDynastySlug), costSource }
//   groupBy  ∈ { workflowSlug, workflowDynastySlug, featureSlug }
// Anything else (an org / brand / campaign / task filter, another grouping) keeps
// the live query, because the rollup does not carry that dimension.
//
// The output is byte-identical to the live query, text included: each money
// column renders `'0'` when no row of its status matched (the live
// `SUM(CASE … ELSE 0 END)` then has scale 0) and `round(sum, 10)::text` when at
// least one did (scale 10, the column's scale). The response is ORDERed by that
// TEXT, so the rendering matters, not just the value.

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db/index.js";

export const STATS_ROLLUP_NAME = "feature_workflow";

/** groupBy keys this rollup can serve, mapped to its column. */
export const ROLLUP_GROUP_BY_COLUMNS: Record<string, string> = {
  workflowSlug: "workflow_slug",
  featureSlug: "feature_slug",
};

// Checked on EVERY request (a primary-key probe of a one-row table): a rebuild
// un-stamps readiness while it re-derives the rollup, and a per-process cache
// of "ready" would keep serving the half-built tables through that window.
export async function isStatsRollupReady(): Promise<boolean> {
  const rows = (await db.execute(
    sql`SELECT 1 AS ok FROM stats_rollups WHERE name = ${STATS_ROLLUP_NAME}`
  )) as unknown as Array<{ ok: number }>;
  return rows.length > 0;
}

/** `'0'` when no row of the status matched, else the sum at scale 10. */
function money(countExpr: string, sumExpr: string) {
  return `CASE WHEN SUM(${countExpr}) > 0 THEN round(SUM(${sumExpr}), 10)::text ELSE '0' END`;
}

/**
 * Same row shape the live public query returns: the dimension under
 * `resultCol`, the nine money columns as TEXT, and `run_count`, ordered by
 * `total_cost` (text) DESC.
 */
export async function readPublicCostsFromRollup(opts: {
  groupBy: string;
  resultCol: string;
  featureSlugs?: string[];
  workflowSlugs?: string[];
  costSource?: string;
}): Promise<any[]> {
  const col = sql.raw(ROLLUP_GROUP_BY_COLUMNS[opts.groupBy]);
  const parts: ReturnType<typeof sql>[] = [];
  if (opts.featureSlugs && opts.featureSlugs.length > 0) {
    parts.push(sql`feature_slug IN (${sql.join(opts.featureSlugs.map((s) => sql`${s}`), sql`, `)})`);
  }
  if (opts.workflowSlugs && opts.workflowSlugs.length > 0) {
    parts.push(sql`workflow_slug IN (${sql.join(opts.workflowSlugs.map((s) => sql`${s}`), sql`, `)})`);
  }
  const where = parts.length > 0 ? sql`WHERE ${sql.join(parts, sql` AND `)}` : sql``;
  const costParts = [...parts];
  if (opts.costSource) costParts.push(sql`cost_source = ${opts.costSource}`);
  const costWhere = costParts.length > 0 ? sql`WHERE ${sql.join(costParts, sql` AND `)}` : sql``;

  const result = await db.execute(sql`
    WITH counts AS (
      SELECT ${col} AS dim, SUM(run_count)::int AS run_count
      FROM stats_rollup_runs
      ${where}
      GROUP BY 1
      HAVING SUM(run_count) > 0
    ),
    sums AS (
      SELECT ${col} AS dim,
        ${sql.raw(money("n_actual + n_provisioned", "gross_actual + gross_provisioned"))} AS total_cost,
        ${sql.raw(money("n_actual", "gross_actual"))} AS actual_cost,
        ${sql.raw(money("n_provisioned", "gross_provisioned"))} AS provisioned_cost,
        ${sql.raw(money("n_cancelled", "gross_cancelled"))} AS cancelled_cost,
        ${sql.raw(money("n_refunded", "gross_refunded"))} AS refunded_cost,
        ${sql.raw(money("n_actual + n_provisioned", "net_actual + net_provisioned"))} AS net_total_cost,
        ${sql.raw(money("n_actual", "net_actual"))} AS net_actual_cost,
        ${sql.raw(money("n_provisioned", "net_provisioned"))} AS net_provisioned_cost,
        ${sql.raw(money("n_refunded", "net_refunded"))} AS net_refunded_cost
      FROM stats_rollup_costs
      ${costWhere}
      GROUP BY 1
      HAVING SUM(n_actual + n_provisioned + n_cancelled + n_refunded) > 0
    )
    SELECT c.dim AS ${sql.raw(opts.resultCol)},
      COALESCE(s.total_cost, '0')            AS total_cost,
      COALESCE(s.actual_cost, '0')           AS actual_cost,
      COALESCE(s.provisioned_cost, '0')      AS provisioned_cost,
      COALESCE(s.cancelled_cost, '0')        AS cancelled_cost,
      COALESCE(s.refunded_cost, '0')         AS refunded_cost,
      COALESCE(s.net_total_cost, '0')        AS net_total_cost,
      COALESCE(s.net_actual_cost, '0')       AS net_actual_cost,
      COALESCE(s.net_provisioned_cost, '0')  AS net_provisioned_cost,
      COALESCE(s.net_refunded_cost, '0')     AS net_refunded_cost,
      c.run_count
    FROM counts c
    LEFT JOIN sums s ON s.dim IS NOT DISTINCT FROM c.dim
    ORDER BY total_cost DESC
  `);
  return result as unknown as any[];
}

/**
 * Rebuild both rollup tables from the ledger and stamp them ready — exactly,
 * without holding writers for the length of the aggregate (~20 s on production).
 *
 * Three steps on two dedicated connections:
 *
 *  A (READ COMMITTED, write-locked for well under a second): take SHARE ROW
 *    EXCLUSIVE on runs + runs_costs — reads keep flowing, writes QUEUE — then
 *    clear the rollup (every delta in it belongs to a row committed so far),
 *    un-stamp readiness (so reads fall back to the live query meanwhile), and
 *    export a snapshot taken under the lock. That snapshot holds EXACTLY the rows
 *    whose deltas were just cleared.
 *  B (REPEATABLE READ on A's snapshot): import it, then A commits and writers
 *    resume — their triggers now add deltas for rows NOT in the snapshot. B
 *    aggregates the snapshot into session temp tables, with no lock held.
 *  C (READ COMMITTED): add B's aggregate on top of the deltas already landed,
 *    and stamp the rollup ready.
 *
 * Every row is therefore counted once: in the aggregate if it was committed
 * before the lock, in a trigger delta if after. `lock_timeout` bounds the wait
 * for the lock so a slow writer cannot queue every other writer behind it.
 */
export async function rebuildStatsRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  const a = postgres(url, { max: 1, connect_timeout: 10, connection: { jit: "off" } });
  const b = postgres(url, { max: 1, connect_timeout: 10, connection: { jit: "off" } });
  try {
    await a`BEGIN ISOLATION LEVEL READ COMMITTED`;
    const lockedAt = Date.now();
    let lockedMs = 0;
    try {
      await a`SET LOCAL lock_timeout = '10s'`;
      await a`LOCK TABLE runs, runs_costs IN SHARE ROW EXCLUSIVE MODE`;
      await a`DELETE FROM stats_rollups WHERE name = ${STATS_ROLLUP_NAME}`;
      await a`DELETE FROM stats_rollup_runs`;
      await a`DELETE FROM stats_rollup_costs`;
      const [{ snapshot }] = await a`SELECT pg_export_snapshot() AS snapshot`;
      await b`BEGIN ISOLATION LEVEL REPEATABLE READ`;
      await b.unsafe(`SET TRANSACTION SNAPSHOT '${String(snapshot).replace(/'/g, "")}'`);
      await a`COMMIT`;
      lockedMs = Date.now() - lockedAt;
    } catch (err) {
      await a`ROLLBACK`.catch(() => undefined);
      await b`ROLLBACK`.catch(() => undefined);
      throw err;
    }

    try {
      await b`
        CREATE TEMP TABLE rebuild_runs ON COMMIT PRESERVE ROWS AS
        SELECT feature_slug, workflow_slug, count(*) AS run_count FROM runs GROUP BY 1, 2
      `;
      await b`
        CREATE TEMP TABLE rebuild_costs ON COMMIT PRESERVE ROWS AS
        SELECT r.feature_slug, r.workflow_slug, rc.cost_source,
          count(*) FILTER (WHERE rc.status = 'actual')      AS n_actual,
          count(*) FILTER (WHERE rc.status = 'provisioned') AS n_provisioned,
          count(*) FILTER (WHERE rc.status = 'cancelled')   AS n_cancelled,
          count(*) FILTER (WHERE rc.status = 'refunded')    AS n_refunded,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'actual'), 0)      AS gross_actual,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'provisioned'), 0) AS gross_provisioned,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'cancelled'), 0)   AS gross_cancelled,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'refunded'), 0)    AS gross_refunded,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'actual'), 0)      AS net_actual,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'provisioned'), 0) AS net_provisioned,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'refunded'), 0)    AS net_refunded
        FROM runs_costs rc
        JOIN runs r ON r.id = rc.run_id
        WHERE rc.status IN ('actual', 'provisioned', 'cancelled', 'refunded')
        GROUP BY 1, 2, 3
      `;
      await b`COMMIT`;
    } catch (err) {
      await b`ROLLBACK`.catch(() => undefined);
      throw err;
    }

    // C — same session as B (the temp tables live there).
    return await b.begin(async (txn) => {
      // postgres.js's TransactionSql type drops the tagged-template call signature
      // (a known typing gap); at runtime it is the same callable client.
      const tx = txn as unknown as postgres.Sql;
      const runGroups = await tx`
        INSERT INTO stats_rollup_runs (feature_slug, workflow_slug, run_count)
        SELECT feature_slug, workflow_slug, run_count FROM rebuild_runs
        ON CONFLICT ON CONSTRAINT stats_rollup_runs_key
        DO UPDATE SET run_count = stats_rollup_runs.run_count + EXCLUDED.run_count
      `;
      const costGroups = await tx`
        INSERT INTO stats_rollup_costs (
          feature_slug, workflow_slug, cost_source,
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
          net_actual, net_provisioned, net_refunded
        )
        SELECT feature_slug, workflow_slug, cost_source,
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded,
          net_actual, net_provisioned, net_refunded
        FROM rebuild_costs
        ON CONFLICT ON CONSTRAINT stats_rollup_costs_key DO UPDATE SET
          n_actual          = stats_rollup_costs.n_actual          + EXCLUDED.n_actual,
          n_provisioned     = stats_rollup_costs.n_provisioned     + EXCLUDED.n_provisioned,
          n_cancelled       = stats_rollup_costs.n_cancelled       + EXCLUDED.n_cancelled,
          n_refunded        = stats_rollup_costs.n_refunded        + EXCLUDED.n_refunded,
          gross_actual      = stats_rollup_costs.gross_actual      + EXCLUDED.gross_actual,
          gross_provisioned = stats_rollup_costs.gross_provisioned + EXCLUDED.gross_provisioned,
          gross_cancelled   = stats_rollup_costs.gross_cancelled   + EXCLUDED.gross_cancelled,
          gross_refunded    = stats_rollup_costs.gross_refunded    + EXCLUDED.gross_refunded,
          net_actual        = stats_rollup_costs.net_actual        + EXCLUDED.net_actual,
          net_provisioned   = stats_rollup_costs.net_provisioned   + EXCLUDED.net_provisioned,
          net_refunded      = stats_rollup_costs.net_refunded      + EXCLUDED.net_refunded
      `;
      await tx`
        INSERT INTO stats_rollups (name, ready_at) VALUES (${STATS_ROLLUP_NAME}, now())
        ON CONFLICT (name) DO UPDATE SET ready_at = EXCLUDED.ready_at
      `;
      await tx`DROP TABLE rebuild_runs, rebuild_costs`;
      return { runGroups: runGroups.count, costGroups: costGroups.count, lockedMs };
    });
  } finally {
    await a.end();
    await b.end();
  }
}
