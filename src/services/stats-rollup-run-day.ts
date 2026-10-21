// Rebuild side of the two rollups behind GET /public/stats/runs (migration 0054):
// stats_rollup_run_day (UTC start day, status -> runs) and
// stats_rollup_platform_cost_day (run's UTC start day -> platform-projected
// cost rows + gross). The read lives in routes/stats.ts.

import { rebuildRollup } from "./stats-rollup.js";

export const RUN_DAY_ROLLUP_NAME = "run_day";

export async function rebuildRunDayRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: RUN_DAY_ROLLUP_NAME,
    tables: ["stats_rollup_run_day", "stats_rollup_platform_cost_day"],
    aggregate: async (b) => {
      await b`
        CREATE TEMP TABLE rebuild_run_day ON COMMIT PRESERVE ROWS AS
        SELECT (started_at AT TIME ZONE 'UTC')::date AS day, status, count(*) AS run_count
        FROM runs GROUP BY 1, 2
      `;
      await b`
        CREATE TEMP TABLE rebuild_platform_cost_day ON COMMIT PRESERVE ROWS AS
        SELECT (run_started_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n_rows,
          SUM(total_cost_in_usd_cents) AS gross
        FROM runs_costs WHERE is_platform_projected GROUP BY 1
      `;
    },
    merge: async (tx) => {
      const runGroups = await tx`
        INSERT INTO stats_rollup_run_day (day, status, run_count)
        SELECT day, status, run_count FROM rebuild_run_day
        ON CONFLICT ON CONSTRAINT stats_rollup_run_day_key
        DO UPDATE SET run_count = stats_rollup_run_day.run_count + EXCLUDED.run_count
      `;
      const costGroups = await tx`
        INSERT INTO stats_rollup_platform_cost_day (day, n_rows, gross)
        SELECT day, n_rows, gross FROM rebuild_platform_cost_day
        ON CONFLICT ON CONSTRAINT stats_rollup_platform_cost_day_key DO UPDATE SET
          n_rows = stats_rollup_platform_cost_day.n_rows + EXCLUDED.n_rows,
          gross  = stats_rollup_platform_cost_day.gross  + EXCLUDED.gross
      `;
      await tx`DROP TABLE rebuild_run_day, rebuild_platform_cost_day`;
      return { runGroups: runGroups.count, costGroups: costGroups.count };
    },
  });
}
