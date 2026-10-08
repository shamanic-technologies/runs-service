// Read + rebuild side of the (org, brand set, campaign, UTC hour) rollup kept by
// the triggers of migration 0042, for GET /v1/stats/costs/timeseries.
//
// Served (when the `org_hour` stamp is present): filters ⊆ {brandId, campaignId,
// campaignIds, startedAfter, startedBefore}, groupBy absent or campaignId, any
// interval, any timezone whose local hours start on a UTC hour (checked on every
// rollup hour the read touches; otherwise the caller falls back to the live query).
//
// EXACTNESS. A local day / week / month is a union of whole UTC hours in such a
// timezone, so each rollup row falls in exactly one bucket. Hours read LIVE from
// the ledger instead, with the exact bounds:
//   - the hour holding startedAfter, when a run of the filters sits in
//     [that hour, startedAfter) (the bound excludes it);
//   - the hour holding startedBefore, when a run sits in (startedBefore, hour end);
//   - every hour holding a row whose min/max went stale (a run left it).
// Rollup hours and live hours are disjoint, in one statement, so each run counts
// once. Money is summed in numeric and rendered by the route exactly as the live
// query's (Decimal.toFixed(10)). Parity guard: tests/integration/stats-rollup-org-hour.test.ts.

import { sql, type SQL } from "drizzle-orm";
import type postgres from "postgres";
import { statsDb } from "../db/index.js";
import { costAggregateNetSelectSql, costAggregateSelectSql } from "./cost-aggregator.js";
import { rebuildRollup } from "./stats-rollup.js";

export const ORG_HOUR_ROLLUP_NAME = "org_hour";

export interface OrgHourFilters {
  orgId: string;
  brandId?: string;
  campaignId?: string;
  campaignIds?: string[];
}

function filterParts(f: OrgHourFilters, prefix: string): SQL[] {
  const p = (c: string) => sql.raw(`${prefix}${c}`);
  const parts: SQL[] = [sql`${p("organization_id")} = ${f.orgId}`];
  if (f.brandId) parts.push(sql`${f.brandId} = ANY(${p("brand_ids")})`);
  if (f.campaignId) parts.push(sql`${p("campaign_id")} = ${f.campaignId}`);
  if (f.campaignIds && f.campaignIds.length > 0) {
    parts.push(sql`${p("campaign_id")} IN (${sql.join(f.campaignIds.map((c) => sql`${c}`), sql`, `)})`);
  }
  return parts;
}

const and = (parts: SQL[]) => sql.join(parts, sql` AND `);
const UTC_HOUR = (ts: SQL) => sql`(date_trunc('hour', (${ts}) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/**
 * Rows in the live timeseries query's shape (`period`, `campaign_id` when
 * `byCampaign`, the nine money columns, `run_count`, `min_started_at`,
 * `max_started_at`), ordered by period then campaign — or `null` when a rollup
 * hour does not start on a local hour in `timezone` (the caller reads live).
 */
export async function readOrgHourTimeseries(opts: {
  interval: string;
  timezone: string;
  byCampaign: boolean;
  filters: OrgHourFilters;
  startedAfter?: string;
  startedBefore?: string;
}): Promise<any[] | null> {
  const { interval, timezone, byCampaign, filters, startedAfter: sa, startedBefore: sb } = opts;
  const rollupF = filterParts(filters, "");
  const liveF = filterParts(filters, "r.");
  if (sa) liveF.push(sql`r.started_at >= ${sa}::timestamptz`);
  if (sb) liveF.push(sql`r.started_at <= ${sb}::timestamptz`);
  const hourRange: SQL[] = [];
  if (sa) hourRange.push(sql`hour >= ${UTC_HOUR(sql`${sa}::timestamptz`)}`);
  if (sb) hourRange.push(sql`hour <= ${UTC_HOUR(sql`${sb}::timestamptz`)}`);
  const rollupWhere = and([...rollupF, ...hourRange]);

  const liveHourSources: SQL[] = [
    sql`SELECT DISTINCT hour AS h FROM stats_rollup_org_hour WHERE ${rollupWhere} AND minmax_stale`,
  ];
  if (sa) {
    const h = UTC_HOUR(sql`${sa}::timestamptz`);
    liveHourSources.push(sql`
      SELECT ${h} AS h WHERE EXISTS (
        SELECT 1 FROM runs r WHERE ${and(filterParts(filters, "r."))}
          AND r.started_at >= ${h} AND r.started_at < ${sa}::timestamptz
      )`);
  }
  if (sb) {
    const h = UTC_HOUR(sql`${sb}::timestamptz`);
    liveHourSources.push(sql`
      SELECT ${h} AS h WHERE EXISTS (
        SELECT 1 FROM runs r WHERE ${and(filterParts(filters, "r."))}
          AND r.started_at > ${sb}::timestamptz AND r.started_at < ${h} + interval '1 hour'
      )`);
  }

  const period = (ts: string) =>
    sql`to_char(DATE_TRUNC(${interval}, ${sql.raw(ts)} AT TIME ZONE ${timezone}), 'YYYY-MM-DD')`;
  const camp = (alias: string) => (byCampaign ? sql`, ${sql.raw(alias)}.campaign_id` : sql``);
  const groupCols = byCampaign ? sql`1, 2` : sql`1`;
  const joinOn = byCampaign
    ? sql`s.period = c.period AND s.campaign_id IS NOT DISTINCT FROM c.campaign_id`
    : sql`s.period = c.period`;

  const rows = (await statsDb.execute(sql`
    WITH lh AS MATERIALIZED (${sql.join(liveHourSources, sql` UNION `)}),
    ro AS MATERIALIZED (
      SELECT ${period("o.hour")} AS period ${camp("o")},
        o.run_count, o.min_started_at, o.max_started_at,
        o.gross_actual, o.gross_provisioned, o.gross_cancelled, o.gross_refunded,
        o.net_actual, o.net_provisioned, o.net_refunded,
        (to_char(o.hour AT TIME ZONE ${timezone}, 'MI:SS') = '00:00') AS aligned
      FROM stats_rollup_org_hour o
      WHERE ${and([...filterParts(filters, "o."), ...hourRange.map((p) => sql`o.${p}`)])}
        AND NOT EXISTS (SELECT 1 FROM lh WHERE lh.h = o.hour)
    ),
    lr AS MATERIALIZED (
      SELECT r.id, r.started_at, r.campaign_id
      FROM lh JOIN runs r ON r.started_at >= lh.h AND r.started_at < lh.h + interval '1 hour'
      WHERE ${and(liveF)}
    ),
    lc AS (
      SELECT ${period("r.started_at")} AS period ${camp("r")},
        COUNT(*) AS run_count, MIN(r.started_at) AS min_started_at, MAX(r.started_at) AS max_started_at
      FROM lr r GROUP BY ${groupCols}
    ),
    ls AS (
      SELECT ${period("r.started_at")} AS period ${camp("r")},
        ${costAggregateSelectSql("rc")}, ${costAggregateNetSelectSql("rc")}
      FROM lr r JOIN runs_costs rc ON rc.run_id = r.id GROUP BY ${groupCols}
    ),
    c AS (
      SELECT period ${byCampaign ? sql`, campaign_id` : sql``},
        SUM(run_count) AS run_count, MIN(min_started_at) AS min_started_at, MAX(max_started_at) AS max_started_at
      FROM (
        SELECT period ${byCampaign ? sql`, campaign_id` : sql``}, run_count, min_started_at, max_started_at FROM ro
        UNION ALL
        SELECT period ${byCampaign ? sql`, campaign_id` : sql``}, run_count, min_started_at, max_started_at FROM lc
      ) x
      GROUP BY ${groupCols}
      HAVING SUM(run_count) > 0
    ),
    s AS (
      SELECT period ${byCampaign ? sql`, campaign_id` : sql``},
        SUM(ga + gp) AS total_cost, SUM(ga) AS actual_cost, SUM(gp) AS provisioned_cost,
        SUM(gc) AS cancelled_cost, SUM(gr) AS refunded_cost,
        SUM(na + np) AS net_total_cost, SUM(na) AS net_actual_cost, SUM(np) AS net_provisioned_cost,
        SUM(nr) AS net_refunded_cost
      FROM (
        SELECT period ${byCampaign ? sql`, campaign_id` : sql``},
          gross_actual AS ga, gross_provisioned AS gp, gross_cancelled AS gc, gross_refunded AS gr,
          net_actual AS na, net_provisioned AS np, net_refunded AS nr
        FROM ro
        UNION ALL
        SELECT period ${byCampaign ? sql`, campaign_id` : sql``},
          actual_cost::numeric, provisioned_cost::numeric, cancelled_cost::numeric, refunded_cost::numeric,
          net_actual_cost::numeric, net_provisioned_cost::numeric, net_refunded_cost::numeric
        FROM ls
      ) y
      GROUP BY ${groupCols}
    )
    SELECT c.period ${byCampaign ? sql`, c.campaign_id` : sql``},
      COALESCE(s.total_cost, 0)::text AS total_cost,
      COALESCE(s.actual_cost, 0)::text AS actual_cost,
      COALESCE(s.provisioned_cost, 0)::text AS provisioned_cost,
      COALESCE(s.cancelled_cost, 0)::text AS cancelled_cost,
      COALESCE(s.refunded_cost, 0)::text AS refunded_cost,
      COALESCE(s.net_total_cost, 0)::text AS net_total_cost,
      COALESCE(s.net_actual_cost, 0)::text AS net_actual_cost,
      COALESCE(s.net_provisioned_cost, 0)::text AS net_provisioned_cost,
      COALESCE(s.net_refunded_cost, 0)::text AS net_refunded_cost,
      c.run_count, c.min_started_at, c.max_started_at,
      (SELECT COALESCE(bool_and(aligned), true) FROM ro) AS aligned
    FROM c LEFT JOIN s ON ${joinOn}
    ORDER BY c.period ${byCampaign ? sql`, c.campaign_id` : sql``}
  `)) as any[];

  if (rows.length > 0 && rows[0].aligned === false) return null;
  return rows;
}

export async function rebuildOrgHourRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: ORG_HOUR_ROLLUP_NAME,
    tables: ["stats_rollup_org_hour"],
    aggregate: async (b: postgres.Sql) => {
      await b`
        CREATE TEMP TABLE rebuild_org_hour ON COMMIT PRESERVE ROWS AS
        WITH rr AS (
          SELECT organization_id, brand_ids, campaign_id,
            date_trunc('hour', started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour,
            count(*) AS run_count, MIN(started_at) AS min_started_at, MAX(started_at) AS max_started_at
          FROM runs GROUP BY 1, 2, 3, 4
        ),
        cc AS (
          SELECT r.organization_id, r.brand_ids, r.campaign_id,
            date_trunc('hour', r.started_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS hour,
            COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'actual'), 0)      AS gross_actual,
            COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'provisioned'), 0) AS gross_provisioned,
            COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'cancelled'), 0)   AS gross_cancelled,
            COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'refunded'), 0)    AS gross_refunded,
            COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'actual'), 0)      AS net_actual,
            COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'provisioned'), 0) AS net_provisioned,
            COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'refunded'), 0)    AS net_refunded
          FROM runs_costs rc JOIN runs r ON r.id = rc.run_id
          WHERE rc.status IN ('actual', 'provisioned', 'cancelled', 'refunded')
          GROUP BY 1, 2, 3, 4
        )
        SELECT rr.*, COALESCE(cc.gross_actual, 0) AS gross_actual, COALESCE(cc.gross_provisioned, 0) AS gross_provisioned,
          COALESCE(cc.gross_cancelled, 0) AS gross_cancelled, COALESCE(cc.gross_refunded, 0) AS gross_refunded,
          COALESCE(cc.net_actual, 0) AS net_actual, COALESCE(cc.net_provisioned, 0) AS net_provisioned,
          COALESCE(cc.net_refunded, 0) AS net_refunded
        FROM rr LEFT JOIN cc
          ON cc.organization_id IS NOT DISTINCT FROM rr.organization_id
         AND cc.brand_ids IS NOT DISTINCT FROM rr.brand_ids
         AND cc.campaign_id IS NOT DISTINCT FROM rr.campaign_id
         AND cc.hour = rr.hour
      `;
    },
    merge: async (tx: postgres.Sql) => {
      const res = await tx`
        INSERT INTO stats_rollup_org_hour (
          organization_id, brand_ids, campaign_id, hour, run_count, min_started_at, max_started_at,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded, net_actual, net_provisioned, net_refunded
        )
        SELECT organization_id, brand_ids, campaign_id, hour, run_count, min_started_at, max_started_at,
          gross_actual, gross_provisioned, gross_cancelled, gross_refunded, net_actual, net_provisioned, net_refunded
        FROM rebuild_org_hour
        ON CONFLICT ON CONSTRAINT stats_rollup_org_hour_key DO UPDATE SET
          run_count         = stats_rollup_org_hour.run_count + EXCLUDED.run_count,
          min_started_at    = LEAST(stats_rollup_org_hour.min_started_at, EXCLUDED.min_started_at),
          max_started_at    = GREATEST(stats_rollup_org_hour.max_started_at, EXCLUDED.max_started_at),
          gross_actual      = stats_rollup_org_hour.gross_actual      + EXCLUDED.gross_actual,
          gross_provisioned = stats_rollup_org_hour.gross_provisioned + EXCLUDED.gross_provisioned,
          gross_cancelled   = stats_rollup_org_hour.gross_cancelled   + EXCLUDED.gross_cancelled,
          gross_refunded    = stats_rollup_org_hour.gross_refunded    + EXCLUDED.gross_refunded,
          net_actual        = stats_rollup_org_hour.net_actual        + EXCLUDED.net_actual,
          net_provisioned   = stats_rollup_org_hour.net_provisioned   + EXCLUDED.net_provisioned,
          net_refunded      = stats_rollup_org_hour.net_refunded      + EXCLUDED.net_refunded
      `;
      await tx`DROP TABLE rebuild_org_hour`;
      return { runGroups: res.count, costGroups: 0 };
    },
  });
}
