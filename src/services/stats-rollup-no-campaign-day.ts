// Rebuild side of the (org, UTC day, cost name, run_has_campaign) rollup of
// platform-projected cost rows maintained by the triggers in migration 0055. The
// staff monthly no-campaign read (GET /internal/stats/costs/no-campaign/monthly,
// routes/no-campaign-spend.ts) answers from it once `stats_rollups` holds the
// `no_campaign_day` stamp.

import type postgres from "postgres";
import { rebuildRollup } from "./stats-rollup.js";

export const NO_CAMPAIGN_DAY_ROLLUP_NAME = "no_campaign_day";

export async function rebuildNoCampaignDayRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: NO_CAMPAIGN_DAY_ROLLUP_NAME,
    tables: ["stats_rollup_no_campaign_day"],
    aggregate: async (b: postgres.Sql) => {
      await b`
        CREATE TEMP TABLE rebuild_no_campaign_day ON COMMIT PRESERVE ROWS AS
        SELECT organization_id,
          (created_at AT TIME ZONE 'UTC')::date AS day,
          cost_name,
          run_has_campaign,
          count(*) AS n,
          SUM(total_cost_in_usd_cents) AS gross,
          SUM(COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents)) AS net
        FROM runs_costs
        WHERE is_platform_projected AND organization_id IS NOT NULL
        GROUP BY 1, 2, 3, 4
      `;
    },
    merge: async (tx: postgres.Sql) => {
      const costGroups = await tx`
        INSERT INTO stats_rollup_no_campaign_day AS d (organization_id, day, cost_name, run_has_campaign, n, gross, net)
        SELECT organization_id, day, cost_name, run_has_campaign, n, gross, net
        FROM rebuild_no_campaign_day
        ON CONFLICT ON CONSTRAINT stats_rollup_no_campaign_day_key DO UPDATE SET
          n     = d.n + EXCLUDED.n,
          gross = d.gross + EXCLUDED.gross,
          net   = d.net + EXCLUDED.net
      `;
      await tx`DROP TABLE rebuild_no_campaign_day`;
      return { runGroups: 0, costGroups: costGroups.count };
    },
  });
}
