// Read + rebuild side of stats_rollup_consumption_day (migration 0090): the
// counted ('actual'/'refunded') cost rows per (cost row's org, run's brand set,
// cost row's UTC day, cost name, cost source). GET /internal/stats/costs/consumption
// reads it once `stats_rollups` holds the `consumption_day` stamp; the live
// query (routes/vendor-costs.ts) stays the fallback.

import { sql, type SQL } from "drizzle-orm";
import { statsDb } from "../db/index.js";
import { rebuildRollup } from "./stats-rollup.js";

export const CONSUMPTION_DAY_ROLLUP_NAME = "consumption_day";

export async function rebuildConsumptionDayRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: CONSUMPTION_DAY_ROLLUP_NAME,
    tables: ["stats_rollup_consumption_day"],
    aggregate: async (b) => {
      await b`
        CREATE TEMP TABLE rebuild_consumption_day ON COMMIT PRESERVE ROWS AS
        SELECT rc.organization_id, r.brand_ids, (rc.created_at AT TIME ZONE 'UTC')::date AS day, rc.cost_name, rc.cost_source,
          count(*) AS n,
          SUM(rc.quantity) AS quantity,
          COALESCE(SUM(rc.quantity) FILTER (WHERE rc.status = 'refunded'), 0) AS refunded_quantity,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'actual'), 0) AS billed,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'actual'), 0) AS net_billed,
          COALESCE(SUM(rc.total_cost_in_usd_cents) FILTER (WHERE rc.status = 'refunded'), 0) AS refunded,
          COALESCE(SUM(COALESCE(rc.net_cost_in_usd_cents, rc.total_cost_in_usd_cents)) FILTER (WHERE rc.status = 'refunded'), 0) AS net_refunded
        FROM runs_costs rc JOIN runs r ON r.id = rc.run_id
        WHERE rc.status IN ('actual', 'refunded')
        GROUP BY 1, 2, 3, 4, 5
      `;
    },
    merge: async (tx) => {
      const res = await tx`
        INSERT INTO stats_rollup_consumption_day (
          organization_id, brand_ids, day, cost_name, cost_source,
          n, quantity, refunded_quantity, billed, net_billed, refunded, net_refunded
        )
        SELECT organization_id, brand_ids, day, cost_name, cost_source,
          n, quantity, refunded_quantity, billed, net_billed, refunded, net_refunded
        FROM rebuild_consumption_day
        ON CONFLICT ON CONSTRAINT stats_rollup_consumption_day_key DO UPDATE SET
          n                 = stats_rollup_consumption_day.n                 + EXCLUDED.n,
          quantity          = stats_rollup_consumption_day.quantity          + EXCLUDED.quantity,
          refunded_quantity = stats_rollup_consumption_day.refunded_quantity + EXCLUDED.refunded_quantity,
          billed            = stats_rollup_consumption_day.billed            + EXCLUDED.billed,
          net_billed        = stats_rollup_consumption_day.net_billed        + EXCLUDED.net_billed,
          refunded          = stats_rollup_consumption_day.refunded          + EXCLUDED.refunded,
          net_refunded      = stats_rollup_consumption_day.net_refunded      + EXCLUDED.net_refunded
      `;
      await tx`DROP TABLE rebuild_consumption_day`;
      return { runGroups: 0, costGroups: res.count };
    },
  });
}

export interface ConsumptionQuery {
  names?: string[];
  since?: string;
  orgId?: string;
  brandId?: string;
  byOrg: boolean;
  byBrand: boolean;
}

/**
 * The live read's rows (same columns, same order, same sums) from the rollup, or
 * null while the rollup is not stamped. Stamp and rows are read in ONE statement,
 * so a rebuild cannot un-stamp between them.
 */
export async function readConsumptionFromRollup(q: ConsumptionQuery): Promise<any[] | null> {
  const filters: SQL[] = [sql`g.n > 0`];
  if (q.names) filters.push(sql`g.cost_name IN (SELECT jsonb_array_elements_text(${JSON.stringify(q.names)}::jsonb))`);
  if (q.since) filters.push(sql`g.day >= ${q.since}::date`);
  if (q.orgId) filters.push(sql`g.organization_id = ${q.orgId}::uuid`);
  if (q.brandId) filters.push(sql`g.brand_ids @> ARRAY[${q.brandId}]::text[]`);
  const unnestBrands = q.byBrand && !q.brandId;
  const fromSql = unnestBrands
    ? sql`stats_rollup_consumption_day g CROSS JOIN LATERAL unnest(COALESCE(NULLIF(g.brand_ids, '{}'), ARRAY[NULL]::text[])) AS b(brand_id)`
    : sql`stats_rollup_consumption_day g`;
  const orgCol = q.byOrg ? sql`g.organization_id::text` : sql`NULL::text`;
  const brandCol = unnestBrands ? sql`b.brand_id` : q.byBrand ? sql`${q.brandId}::text` : sql`NULL::text`;

  const rows = (await statsDb.execute(sql`
    WITH ready AS (SELECT EXISTS (SELECT 1 FROM stats_rollups WHERE name = ${CONSUMPTION_DAY_ROLLUP_NAME}) AS ok)
    SELECT * FROM (
      SELECT true AS is_flag, ready.ok AS ready, NULL::text AS org_id, NULL::text AS brand_id, NULL::text AS day,
        NULL::text AS cost_name, NULL::text AS cost_source, NULL::text AS quantity, NULL::text AS refunded_quantity,
        NULL::text AS billed, NULL::text AS net_billed, NULL::text AS refunded, NULL::text AS net_refunded
      FROM ready
      UNION ALL
      SELECT false, true,
        ${orgCol}, ${brandCol},
        to_char(g.day, 'YYYY-MM-DD'),
        g.cost_name, g.cost_source,
        SUM(g.quantity)::text, SUM(g.refunded_quantity)::text,
        SUM(g.billed)::text, SUM(g.net_billed)::text, SUM(g.refunded)::text, SUM(g.net_refunded)::text
      FROM ${fromSql}, ready
      WHERE ready.ok AND ${sql.join(filters, sql` AND `)}
      GROUP BY 3, 4, 5, 6, 7
    ) x
    ORDER BY x.is_flag DESC, x.day, x.org_id NULLS LAST, x.brand_id NULLS LAST, x.cost_name, x.cost_source
  `)) as any[];
  const flag = rows.find((r) => r.is_flag);
  if (!flag?.ready) return null;
  return rows.filter((r) => !r.is_flag);
}
