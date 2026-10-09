// Read + rebuild side of the (org, service, task, campaign, UTC day) rollup kept
// by the triggers of migration 0043, for the org usage read features-service
// makes: GET /v1/stats/costs?groupBy=serviceName,taskName,campaignId.
//
// Served (when the `org_task` stamp is present): org-scoped, groupBy ⊆
// {serviceName, taskName, campaignId}, filters ⊆ {campaignId, campaignIds,
// serviceName, taskName}. No time bounds (a bounded read keeps the live query).
//
// EXACTNESS. Every filter is an exact predicate on a rollup row, every grouping
// is one of its columns, and a run sits in exactly one row. A UTC day holding a
// row whose min/max went stale (a run left it) is read LIVE from the ledger for
// the whole read; rollup days and live days are disjoint, in one statement, so
// each run counts once.
//
// BYTE-IDENTITY. Same row shape and text as the live split query
// (`splitRunSideCostsSql` in routes/stats.ts): money renders `'0'` when no cost
// row of that status matched and `round(sum, 10)::text` otherwise, which matters
// because both ORDER BY that text. Parity guard:
// tests/integration/stats-rollup-org-task.test.ts.

import { sql, type SQL } from "drizzle-orm";
import type postgres from "postgres";
import { statsDb } from "../db/index.js";
import { money, rebuildRollup } from "./stats-rollup.js";

export const ORG_TASK_ROLLUP_NAME = "org_task";

/** groupBy keys this rollup serves, mapped to its column (same name on `runs`). */
export const ORG_TASK_GROUP_BY: Record<string, string> = {
  serviceName: "service_name",
  taskName: "task_name",
  campaignId: "campaign_id",
};

export interface OrgTaskFilters {
  orgId: string;
  campaignId?: string;
  campaignIds?: string[];
  serviceName?: string;
  taskName?: string;
}

function filterParts(f: OrgTaskFilters, prefix: string): SQL[] {
  const p = (c: string) => sql.raw(`${prefix}${c}`);
  const parts: SQL[] = [sql`${p("organization_id")} = ${f.orgId}`];
  if (f.campaignId) parts.push(sql`${p("campaign_id")} = ${f.campaignId}`);
  if (f.campaignIds && f.campaignIds.length > 0) {
    parts.push(sql`${p("campaign_id")} IN (${sql.join(f.campaignIds.map((c) => sql`${c}`), sql`, `)})`);
  }
  if (f.serviceName) parts.push(sql`${p("service_name")} = ${f.serviceName}`);
  if (f.taskName) parts.push(sql`${p("task_name")} = ${f.taskName}`);
  return parts;
}

const and = (parts: SQL[]) => sql.join(parts, sql` AND `);
const UTC_DAY_START = (day: string) => sql.raw(`((${day})::timestamp AT TIME ZONE 'UTC')`);

/**
 * Rows in the live split query's shape: each groupBy column under its result
 * name (`service_name`, `task_name`, `campaign_id`), the nine money columns as
 * TEXT, `run_count`, `min_started_at`, `max_started_at`, ordered by
 * `total_cost` (text) DESC.
 */
export async function readOrgTaskGroups(opts: { groupBy: string[]; filters: OrgTaskFilters }): Promise<any[]> {
  const cols = opts.groupBy.map((k) => ORG_TASK_GROUP_BY[k]);
  const dims = sql.raw(cols.join(", "));
  const dimsOf = (alias: string) => sql.raw(cols.map((c) => `${alias}.${c}`).join(", "));
  const groupRefs = sql.raw(cols.map((_, i) => `${i + 1}`).join(", "));
  const rollupF = and(filterParts(opts.filters, "o."));
  const liveF = and(filterParts(opts.filters, "r."));

  const rows = await statsDb.execute(sql`
    WITH ld AS MATERIALIZED (
      SELECT DISTINCT o.day AS d FROM stats_rollup_org_task o
      WHERE ${rollupF} AND o.minmax_stale AND o.run_count <> 0
    ),
    lr AS MATERIALIZED (
      SELECT r.id, ${dimsOf("r")}, r.started_at
      FROM ld JOIN runs r
        ON r.started_at >= ${UTC_DAY_START("ld.d")} AND r.started_at < ${UTC_DAY_START("ld.d + 1")}
      WHERE ${liveF}
    ),
    u AS (
      SELECT ${dimsOf("o")}, o.run_count AS n,
        CASE WHEN o.run_count > 0 THEN o.min_started_at END AS mn,
        CASE WHEN o.run_count > 0 THEN o.max_started_at END AS mx,
        o.n_actual, o.n_provisioned, o.n_cancelled, o.n_refunded,
        o.gross_actual, o.gross_provisioned, o.gross_cancelled, o.gross_refunded,
        o.net_actual, o.net_provisioned, o.net_refunded
      FROM stats_rollup_org_task o
      WHERE ${rollupF} AND o.day NOT IN (SELECT d FROM ld)
      UNION ALL
      SELECT ${dims}, 1, started_at, started_at,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
      FROM lr
      UNION ALL
      SELECT ${dimsOf("lr")}, 0, NULL, NULL,
        (rc.status = 'actual')::int, (rc.status = 'provisioned')::int,
        (rc.status = 'cancelled')::int, (rc.status = 'refunded')::int,
        CASE WHEN rc.status = 'actual'      THEN rc.total_cost_in_usd_cents ELSE 0 END,
        CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents ELSE 0 END,
        CASE WHEN rc.status = 'cancelled'   THEN rc.total_cost_in_usd_cents ELSE 0 END,
        CASE WHEN rc.status = 'refunded'    THEN rc.total_cost_in_usd_cents ELSE 0 END,
        CASE WHEN rc.status = 'actual'      THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END,
        CASE WHEN rc.status = 'provisioned' THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END,
        CASE WHEN rc.status = 'refunded'    THEN COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents) ELSE 0 END
      FROM lr JOIN runs_costs rc ON rc.run_id = lr.id
    )
    SELECT ${dims},
      ${sql.raw(money("n_actual + n_provisioned", "gross_actual + gross_provisioned"))} AS total_cost,
      ${sql.raw(money("n_actual", "gross_actual"))} AS actual_cost,
      ${sql.raw(money("n_provisioned", "gross_provisioned"))} AS provisioned_cost,
      ${sql.raw(money("n_cancelled", "gross_cancelled"))} AS cancelled_cost,
      ${sql.raw(money("n_refunded", "gross_refunded"))} AS refunded_cost,
      ${sql.raw(money("n_actual + n_provisioned", "net_actual + net_provisioned"))} AS net_total_cost,
      ${sql.raw(money("n_actual", "net_actual"))} AS net_actual_cost,
      ${sql.raw(money("n_provisioned", "net_provisioned"))} AS net_provisioned_cost,
      ${sql.raw(money("n_refunded", "net_refunded"))} AS net_refunded_cost,
      SUM(n) AS run_count, MIN(mn) AS min_started_at, MAX(mx) AS max_started_at
    FROM u
    GROUP BY ${groupRefs}
    HAVING SUM(n) > 0
    ORDER BY total_cost DESC
  `);
  return rows as unknown as any[];
}

export async function rebuildOrgTaskRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: ORG_TASK_ROLLUP_NAME,
    tables: ["stats_rollup_org_task"],
    aggregate: async (b: postgres.Sql) => {
      await b`
        CREATE TEMP TABLE rebuild_org_task ON COMMIT PRESERVE ROWS AS
        WITH rr AS (
          SELECT organization_id, service_name, task_name, campaign_id,
            (started_at AT TIME ZONE 'UTC')::date AS day,
            count(*) AS run_count, MIN(started_at) AS min_started_at, MAX(started_at) AS max_started_at
          FROM runs GROUP BY 1, 2, 3, 4, 5
        ),
        cc AS (
          SELECT r.organization_id, r.service_name, r.task_name, r.campaign_id,
            (r.started_at AT TIME ZONE 'UTC')::date AS day,
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
          FROM runs_costs rc JOIN runs r ON r.id = rc.run_id
          WHERE rc.status IN ('actual', 'provisioned', 'cancelled', 'refunded')
          GROUP BY 1, 2, 3, 4, 5
        )
        SELECT rr.*,
          COALESCE(cc.n_actual, 0) AS n_actual, COALESCE(cc.n_provisioned, 0) AS n_provisioned,
          COALESCE(cc.n_cancelled, 0) AS n_cancelled, COALESCE(cc.n_refunded, 0) AS n_refunded,
          COALESCE(cc.gross_actual, 0) AS gross_actual, COALESCE(cc.gross_provisioned, 0) AS gross_provisioned,
          COALESCE(cc.gross_cancelled, 0) AS gross_cancelled, COALESCE(cc.gross_refunded, 0) AS gross_refunded,
          COALESCE(cc.net_actual, 0) AS net_actual, COALESCE(cc.net_provisioned, 0) AS net_provisioned,
          COALESCE(cc.net_refunded, 0) AS net_refunded
        FROM rr LEFT JOIN cc
          ON cc.organization_id IS NOT DISTINCT FROM rr.organization_id
         AND cc.service_name = rr.service_name
         AND cc.task_name = rr.task_name
         AND cc.campaign_id IS NOT DISTINCT FROM rr.campaign_id
         AND cc.day = rr.day
      `;
    },
    merge: async (tx: postgres.Sql) => {
      const res = await tx`
        INSERT INTO stats_rollup_org_task (
          organization_id, service_name, task_name, campaign_id, day, run_count, min_started_at, max_started_at,
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded, net_actual, net_provisioned, net_refunded
        )
        SELECT organization_id, service_name, task_name, campaign_id, day, run_count, min_started_at, max_started_at,
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded, net_actual, net_provisioned, net_refunded
        FROM rebuild_org_task
        ON CONFLICT ON CONSTRAINT stats_rollup_org_task_key DO UPDATE SET
          run_count         = stats_rollup_org_task.run_count + EXCLUDED.run_count,
          min_started_at    = LEAST(stats_rollup_org_task.min_started_at, EXCLUDED.min_started_at),
          max_started_at    = GREATEST(stats_rollup_org_task.max_started_at, EXCLUDED.max_started_at),
          n_actual          = stats_rollup_org_task.n_actual          + EXCLUDED.n_actual,
          n_provisioned     = stats_rollup_org_task.n_provisioned     + EXCLUDED.n_provisioned,
          n_cancelled       = stats_rollup_org_task.n_cancelled       + EXCLUDED.n_cancelled,
          n_refunded        = stats_rollup_org_task.n_refunded        + EXCLUDED.n_refunded,
          gross_actual      = stats_rollup_org_task.gross_actual      + EXCLUDED.gross_actual,
          gross_provisioned = stats_rollup_org_task.gross_provisioned + EXCLUDED.gross_provisioned,
          gross_cancelled   = stats_rollup_org_task.gross_cancelled   + EXCLUDED.gross_cancelled,
          gross_refunded    = stats_rollup_org_task.gross_refunded    + EXCLUDED.gross_refunded,
          net_actual        = stats_rollup_org_task.net_actual        + EXCLUDED.net_actual,
          net_provisioned   = stats_rollup_org_task.net_provisioned   + EXCLUDED.net_provisioned,
          net_refunded      = stats_rollup_org_task.net_refunded      + EXCLUDED.net_refunded
      `;
      await tx`DROP TABLE rebuild_org_task`;
      return { runGroups: res.count, costGroups: 0 };
    },
  });
}
