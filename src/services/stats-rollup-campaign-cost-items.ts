// Rebuild side of the (campaign, run-start UTC day, org, brand set, feature,
// workflow, cost source, status, cost name, billed unit price, cost-row UTC hour)
// rollup kept by the triggers of migrations 0050 + 0051. GET /internal/stats/costs/vendor reads it once
// `stats_rollups` holds the `campaign_cost_items` stamp; the read lives beside
// the route in routes/vendor-costs.ts (vendorGroupedRollupBaseSql).

import type postgres from "postgres";
import { rebuildRollup } from "./stats-rollup.js";

export const CAMPAIGN_COST_ITEMS_ROLLUP_NAME = "campaign_cost_items";

const KEY =
  "campaign_id, day, organization_id, brand_ids, feature_slug, workflow_slug, cost_source, status, cost_name, unit_cost_in_usd_cents, cost_hour";

export async function rebuildCampaignCostItemsRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: CAMPAIGN_COST_ITEMS_ROLLUP_NAME,
    tables: ["stats_rollup_campaign_cost_items"],
    aggregate: async (b: postgres.Sql) => {
      await b`
        CREATE TEMP TABLE rebuild_campaign_cost_items ON COMMIT PRESERVE ROWS AS
        SELECT r.campaign_id, (r.started_at AT TIME ZONE 'UTC')::date AS day, r.organization_id, r.brand_ids,
          r.feature_slug, r.workflow_slug, rc.cost_source, rc.status, rc.cost_name, rc.unit_cost_in_usd_cents,
          date_trunc('hour', rc.created_at AT TIME ZONE 'UTC') AS cost_hour,
          count(*) AS n, SUM(rc.quantity) AS quantity, SUM(rc.total_cost_in_usd_cents) AS gross,
          MIN(rc.created_at) AS min_created_at, MAX(rc.created_at) AS max_created_at
        FROM runs_costs rc
        JOIN runs r ON r.id = rc.run_id
        WHERE rc.status IN ('actual', 'provisioned', 'refunded')
        GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
      `;
    },
    merge: async (tx: postgres.Sql) => {
      const res = await tx.unsafe(`
        INSERT INTO stats_rollup_campaign_cost_items (${KEY}, n, quantity, gross, min_created_at, max_created_at)
        SELECT ${KEY}, n, quantity, gross, min_created_at, max_created_at FROM rebuild_campaign_cost_items
        ON CONFLICT ON CONSTRAINT stats_rollup_campaign_cost_items_key DO UPDATE SET
          n              = stats_rollup_campaign_cost_items.n + EXCLUDED.n,
          quantity       = stats_rollup_campaign_cost_items.quantity + EXCLUDED.quantity,
          gross          = stats_rollup_campaign_cost_items.gross + EXCLUDED.gross,
          min_created_at = LEAST(stats_rollup_campaign_cost_items.min_created_at, EXCLUDED.min_created_at),
          max_created_at = GREATEST(stats_rollup_campaign_cost_items.max_created_at, EXCLUDED.max_created_at)
      `);
      await tx`DROP TABLE rebuild_campaign_cost_items`;
      return { runGroups: 0, costGroups: res.count };
    },
  });
}
