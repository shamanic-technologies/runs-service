// Read + rebuild side of the (org, campaign, feature, service, task, UTC day, brand
// set) rollup kept by the triggers of migration 0096, for the spend-by-action read:
// GET /v1/stats/costs/timeseries?groupBy=serviceName,taskName (SPEND-BY-ACTION-TIMEOUT-1106).
//
// Served (when the `task_day` stamp is present): timezone UTC, any interval
// (day / week / month are unions of UTC days), groupBy ⊆ {campaignId, serviceName,
// taskName}, filters ⊆ {brandId, campaignId, campaignIds, featureSlug(s),
// serviceName, taskName}. No time bound, no workflow filter (those stay live).
//
// EXACTNESS. Every filter is an exact predicate on a rollup row (brand: `= ANY` of
// the row's brand set, the run's own), every grouping is one of its columns, and a
// run sits in exactly one row. A UTC day holding a row of the filters whose min/max
// went stale (a run left it) is read LIVE from the ledger for that day; rollup days
// and live days are disjoint, in one statement, so each run counts once. The route
// renders money with Decimal.toFixed(10), so the body is identical to the live
// query's. Parity guard: tests/integration/stats-rollup-task-day.test.ts.

import { sql, type SQL } from "drizzle-orm";
import type postgres from "postgres";
import { statsDb } from "../db/index.js";
import { rebuildRollup } from "./stats-rollup.js";

export const TASK_DAY_ROLLUP_NAME = "task_day";

export interface TaskDayFilters {
  orgId: string;
  brandId?: string;
  campaignId?: string;
  campaignIds?: string[];
  featureSlug?: string;
  featureSlugs?: string[];
  serviceName?: string;
  taskName?: string;
}

function filterParts(f: TaskDayFilters, prefix: string): SQL[] {
  const p = (c: string) => sql.raw(`${prefix}${c}`);
  const parts: SQL[] = [sql`${p("organization_id")} = ${f.orgId}`];
  if (f.brandId) parts.push(sql`${f.brandId} = ANY(${p("brand_ids")})`);
  if (f.campaignId) parts.push(sql`${p("campaign_id")} = ${f.campaignId}`);
  if (f.campaignIds && f.campaignIds.length > 0) {
    parts.push(sql`${p("campaign_id")} IN (${sql.join(f.campaignIds.map((c) => sql`${c}`), sql`, `)})`);
  }
  // Same precedence as the live filter: the list wins over the singular.
  if (f.featureSlugs && f.featureSlugs.length > 0) {
    parts.push(sql`${p("feature_slug")} IN (${sql.join(f.featureSlugs.map((s) => sql`${s}`), sql`, `)})`);
  } else if (f.featureSlug) {
    parts.push(sql`${p("feature_slug")} = ${f.featureSlug}`);
  }
  if (f.serviceName) parts.push(sql`${p("service_name")} = ${f.serviceName}`);
  if (f.taskName) parts.push(sql`${p("task_name")} = ${f.taskName}`);
  return parts;
}

const and = (parts: SQL[]) => sql.join(parts, sql` AND `);
const UTC_DAY_START = (day: string) => sql.raw(`((${day})::timestamp AT TIME ZONE 'UTC')`);

const DIM_COLS = { campaignId: "campaign_id", serviceName: "service_name", taskName: "task_name" } as const;

/**
 * Rows in the live timeseries query's shape: `period`, the asked dims
 * (`campaign_id`, `service_name`, `task_name`), `committed_run_count`, the nine money
 * columns, `run_count`, `min_started_at`, `max_started_at`, ordered by period then
 * dims. UTC only (the caller checks).
 */
export async function readTaskDayTimeseries(opts: {
  interval: string;
  byCampaign: boolean;
  byService: boolean;
  byTask: boolean;
  filters: TaskDayFilters;
}): Promise<any[]> {
  const cols = [
    ...(opts.byCampaign ? [DIM_COLS.campaignId] : []),
    ...(opts.byService ? [DIM_COLS.serviceName] : []),
    ...(opts.byTask ? [DIM_COLS.taskName] : []),
  ];
  const lead = (list: string) => sql.raw(list.length > 0 ? `${list}, ` : "");
  const dimsOf = (alias: string) => lead(cols.map((c) => `${alias}.${c}`).join(", "));
  const outDims = lead(cols.join(", "));
  const groupRefs = sql.raw(Array.from({ length: cols.length + 1 }, (_, i) => String(i + 1)).join(", "));
  const orderBy = sql.raw(["period", ...cols].join(", "));
  const rollupF = and(filterParts(opts.filters, "o."));
  const liveF = and(filterParts(opts.filters, "r."));

  const rows = await statsDb.execute(sql`
    WITH ld AS MATERIALIZED (
      SELECT DISTINCT o.day AS d FROM stats_rollup_task_day o
      WHERE ${rollupF} AND o.minmax_stale AND o.run_count <> 0
    ),
    lr AS MATERIALIZED (
      SELECT r.id, r.campaign_id, r.service_name, r.task_name, r.started_at,
        EXISTS (
          SELECT 1 FROM runs_costs c WHERE c.run_id = r.id AND c.status IN ('actual', 'provisioned')
        ) AS committed
      FROM ld JOIN runs r
        ON r.started_at >= ${UTC_DAY_START("ld.d")} AND r.started_at < ${UTC_DAY_START("ld.d + 1")}
      WHERE ${liveF}
    ),
    u AS (
      SELECT o.day, ${dimsOf("o")} o.run_count AS n, o.committed_run_count AS cm,
        CASE WHEN o.run_count > 0 THEN o.min_started_at END AS mn,
        CASE WHEN o.run_count > 0 THEN o.max_started_at END AS mx,
        o.n_actual, o.n_provisioned, o.n_cancelled, o.n_refunded,
        o.gross_actual, o.gross_provisioned, o.gross_cancelled, o.gross_refunded,
        o.net_actual, o.net_provisioned, o.net_refunded
      FROM stats_rollup_task_day o
      WHERE ${rollupF} AND o.day NOT IN (SELECT d FROM ld)
      UNION ALL
      SELECT (lr.started_at AT TIME ZONE 'UTC')::date, ${dimsOf("lr")} 1, lr.committed::int, lr.started_at, lr.started_at,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
      FROM lr
      UNION ALL
      SELECT (lr.started_at AT TIME ZONE 'UTC')::date, ${dimsOf("lr")} 0, 0, NULL, NULL,
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
    SELECT to_char(DATE_TRUNC(${opts.interval}, u.day::timestamp), 'YYYY-MM-DD') AS period, ${outDims}
      SUM(cm) AS committed_run_count,
      SUM(gross_actual + gross_provisioned)::text AS total_cost,
      SUM(gross_actual)::text AS actual_cost,
      SUM(gross_provisioned)::text AS provisioned_cost,
      SUM(gross_cancelled)::text AS cancelled_cost,
      SUM(gross_refunded)::text AS refunded_cost,
      SUM(net_actual + net_provisioned)::text AS net_total_cost,
      SUM(net_actual)::text AS net_actual_cost,
      SUM(net_provisioned)::text AS net_provisioned_cost,
      SUM(net_refunded)::text AS net_refunded_cost,
      SUM(n) AS run_count, MIN(mn) AS min_started_at, MAX(mx) AS max_started_at
    FROM u
    GROUP BY ${groupRefs}
    HAVING SUM(n) > 0
    ORDER BY ${orderBy}
  `);
  return rows as unknown as any[];
}

export async function rebuildTaskDayRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: TASK_DAY_ROLLUP_NAME,
    tables: ["stats_rollup_task_day"],
    aggregate: async (b: postgres.Sql) => {
      await b`
        CREATE TEMP TABLE rebuild_task_day ON COMMIT PRESERVE ROWS AS
        WITH rr AS (
          SELECT organization_id, campaign_id, feature_slug, service_name, task_name,
            (started_at AT TIME ZONE 'UTC')::date AS day, brand_ids,
            count(*) AS run_count, MIN(started_at) AS min_started_at, MAX(started_at) AS max_started_at
          FROM runs GROUP BY 1, 2, 3, 4, 5, 6, 7
        ),
        cc AS (
          SELECT r.organization_id, r.campaign_id, r.feature_slug, r.service_name, r.task_name,
            (r.started_at AT TIME ZONE 'UTC')::date AS day, r.brand_ids,
            count(DISTINCT r.id) FILTER (WHERE rc.status IN ('actual', 'provisioned')) AS committed_run_count,
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
          GROUP BY 1, 2, 3, 4, 5, 6, 7
        )
        SELECT rr.*,
          COALESCE(cc.committed_run_count, 0) AS committed_run_count,
          COALESCE(cc.n_actual, 0) AS n_actual, COALESCE(cc.n_provisioned, 0) AS n_provisioned,
          COALESCE(cc.n_cancelled, 0) AS n_cancelled, COALESCE(cc.n_refunded, 0) AS n_refunded,
          COALESCE(cc.gross_actual, 0) AS gross_actual, COALESCE(cc.gross_provisioned, 0) AS gross_provisioned,
          COALESCE(cc.gross_cancelled, 0) AS gross_cancelled, COALESCE(cc.gross_refunded, 0) AS gross_refunded,
          COALESCE(cc.net_actual, 0) AS net_actual, COALESCE(cc.net_provisioned, 0) AS net_provisioned,
          COALESCE(cc.net_refunded, 0) AS net_refunded
        FROM rr LEFT JOIN cc
          ON cc.organization_id IS NOT DISTINCT FROM rr.organization_id
         AND cc.campaign_id IS NOT DISTINCT FROM rr.campaign_id
         AND cc.feature_slug IS NOT DISTINCT FROM rr.feature_slug
         AND cc.service_name = rr.service_name
         AND cc.task_name = rr.task_name
         AND cc.day = rr.day
         AND cc.brand_ids IS NOT DISTINCT FROM rr.brand_ids
      `;
    },
    merge: async (tx: postgres.Sql) => {
      const res = await tx`
        INSERT INTO stats_rollup_task_day (
          organization_id, campaign_id, feature_slug, service_name, task_name, day, brand_ids,
          run_count, committed_run_count, min_started_at, max_started_at,
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded, net_actual, net_provisioned, net_refunded
        )
        SELECT organization_id, campaign_id, feature_slug, service_name, task_name, day, brand_ids,
          run_count, committed_run_count, min_started_at, max_started_at,
          n_actual, n_provisioned, n_cancelled, n_refunded,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded, net_actual, net_provisioned, net_refunded
        FROM rebuild_task_day
        ON CONFLICT ON CONSTRAINT stats_rollup_task_day_key DO UPDATE SET
          run_count           = stats_rollup_task_day.run_count           + EXCLUDED.run_count,
          committed_run_count = stats_rollup_task_day.committed_run_count + EXCLUDED.committed_run_count,
          min_started_at      = LEAST(stats_rollup_task_day.min_started_at, EXCLUDED.min_started_at),
          max_started_at      = GREATEST(stats_rollup_task_day.max_started_at, EXCLUDED.max_started_at),
          n_actual            = stats_rollup_task_day.n_actual          + EXCLUDED.n_actual,
          n_provisioned       = stats_rollup_task_day.n_provisioned     + EXCLUDED.n_provisioned,
          n_cancelled         = stats_rollup_task_day.n_cancelled       + EXCLUDED.n_cancelled,
          n_refunded          = stats_rollup_task_day.n_refunded        + EXCLUDED.n_refunded,
          gross_actual        = stats_rollup_task_day.gross_actual      + EXCLUDED.gross_actual,
          gross_provisioned   = stats_rollup_task_day.gross_provisioned + EXCLUDED.gross_provisioned,
          gross_cancelled     = stats_rollup_task_day.gross_cancelled   + EXCLUDED.gross_cancelled,
          gross_refunded      = stats_rollup_task_day.gross_refunded    + EXCLUDED.gross_refunded,
          net_actual          = stats_rollup_task_day.net_actual        + EXCLUDED.net_actual,
          net_provisioned     = stats_rollup_task_day.net_provisioned   + EXCLUDED.net_provisioned,
          net_refunded        = stats_rollup_task_day.net_refunded      + EXCLUDED.net_refunded
      `;
      await tx`DROP TABLE rebuild_task_day`;
      return { runGroups: res.count, costGroups: 0 };
    },
  });
}
