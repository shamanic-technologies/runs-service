// Rebuild side of the (org, cost name, billed unit price, status, UTC day) rollup
// of PLATFORM charged/refunded cost rows maintained by the triggers in migration
// 0040. The margin reads (GET /internal/stats/costs/margin and its /timeseries)
// price from it once `stats_rollups` holds the `cost_day` stamp; the read itself
// lives beside them in routes/vendor-costs.ts (marginBaseSql).

import type postgres from "postgres";
import { rebuildRollup } from "./stats-rollup.js";

export const COST_DAY_ROLLUP_NAME = "cost_day";

export async function rebuildCostDayRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: COST_DAY_ROLLUP_NAME,
    tables: ["stats_rollup_cost_day"],
    aggregate: async (b: postgres.Sql) => {
      await b`
        CREATE TEMP TABLE rebuild_cost_day ON COMMIT PRESERVE ROWS AS
        SELECT organization_id, cost_name, unit_cost_in_usd_cents, status,
          (created_at AT TIME ZONE 'UTC')::date AS day,
          count(*) AS n,
          SUM(quantity) AS quantity,
          SUM(total_cost_in_usd_cents) AS gross,
          SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net,
          MIN(created_at) AS min_created_at,
          MAX(created_at) AS max_created_at
        FROM runs_costs
        WHERE cost_source = 'platform' AND status IN ('actual', 'refunded')
        GROUP BY 1, 2, 3, 4, 5
      `;
    },
    merge: async (tx: postgres.Sql) => {
      const costGroups = await tx`
        INSERT INTO stats_rollup_cost_day (
          organization_id, cost_name, unit_cost_in_usd_cents, status, day,
          n, quantity, gross, net, min_created_at, max_created_at
        )
        SELECT organization_id, cost_name, unit_cost_in_usd_cents, status, day,
          n, quantity, gross, net, min_created_at, max_created_at
        FROM rebuild_cost_day
        ON CONFLICT ON CONSTRAINT stats_rollup_cost_day_key DO UPDATE SET
          n              = stats_rollup_cost_day.n + EXCLUDED.n,
          quantity       = stats_rollup_cost_day.quantity + EXCLUDED.quantity,
          gross          = stats_rollup_cost_day.gross + EXCLUDED.gross,
          net            = stats_rollup_cost_day.net + EXCLUDED.net,
          min_created_at = LEAST(stats_rollup_cost_day.min_created_at, EXCLUDED.min_created_at),
          max_created_at = GREATEST(stats_rollup_cost_day.max_created_at, EXCLUDED.max_created_at)
      `;
      await tx`DROP TABLE rebuild_cost_day`;
      return { runGroups: 0, costGroups: costGroups.count };
    },
  });
}
