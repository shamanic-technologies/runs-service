// Rebuild side of stats_rollup_root_cost (migration 0054): per TOP-LEVEL run, the
// actual cost rows of its whole subtree. GET /internal/stats/task-outcomes reads
// it for sampled runs with no parent (services/task-outcomes.ts).

import { rebuildRollup } from "./stats-rollup.js";

import { ROOT_COST_ROLLUP_NAME } from "./task-outcomes.js";

export { ROOT_COST_ROLLUP_NAME };

/**
 * Aggregate on the exported snapshot, bottom-up: start from each run's own
 * actual rows (count + gross), then repeatedly hand every level's sums to the
 * parent, GROUPED, until only top-level runs remain. Grouping per level keeps
 * the working set at most one row per run (a top-down walk carrying every
 * cost-bearing run to its root would hold ~76M rows for the dead 13,741-deep
 * scheduler-resume chain). Each step is dynamic SQL so it is planned on its
 * real size: one hash join on the first level, PK probes on the thin tail.
 */
export async function rebuildRootCostRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: ROOT_COST_ROLLUP_NAME,
    tables: ["stats_rollup_root_cost"],
    aggregate: async (b) => {
      await b`CREATE TEMP TABLE rebuild_root_cost (root_run_id uuid NOT NULL, n bigint NOT NULL, g numeric NOT NULL) ON COMMIT PRESERVE ROWS`;
      await b`
        CREATE TEMP TABLE rebuild_root_lvl ON COMMIT PRESERVE ROWS AS
        SELECT run_id AS id, count(*) AS n, SUM(total_cost_in_usd_cents) AS g
        FROM runs_costs WHERE status = 'actual' GROUP BY run_id
      `;
      await b`CREATE TEMP TABLE rebuild_root_next (id uuid NOT NULL, parent uuid, n bigint NOT NULL, g numeric NOT NULL) ON COMMIT PRESERVE ROWS`;
      await b.unsafe(`
        DO $$
        BEGIN
          LOOP
            EXIT WHEN NOT EXISTS (SELECT 1 FROM rebuild_root_lvl);
            EXECUTE 'ANALYZE rebuild_root_lvl';
            EXECUTE 'INSERT INTO rebuild_root_next (id, parent, n, g)
                     SELECT l.id, r.parent_run_id, l.n, l.g FROM rebuild_root_lvl l JOIN runs r ON r.id = l.id';
            EXECUTE 'INSERT INTO rebuild_root_cost (root_run_id, n, g)
                     SELECT id, n, g FROM rebuild_root_next WHERE parent IS NULL';
            EXECUTE 'TRUNCATE rebuild_root_lvl';
            EXECUTE 'INSERT INTO rebuild_root_lvl (id, n, g)
                     SELECT parent, SUM(n), SUM(g) FROM rebuild_root_next WHERE parent IS NOT NULL GROUP BY parent';
            EXECUTE 'TRUNCATE rebuild_root_next';
          END LOOP;
        END $$;
      `);
    },
    merge: async (tx) => {
      const res = await tx`
        INSERT INTO stats_rollup_root_cost (root_run_id, n_actual, gross_actual)
        SELECT root_run_id, SUM(n), SUM(g) FROM rebuild_root_cost GROUP BY root_run_id
        ON CONFLICT (root_run_id) DO UPDATE SET
          n_actual     = stats_rollup_root_cost.n_actual     + EXCLUDED.n_actual,
          gross_actual = stats_rollup_root_cost.gross_actual + EXCLUDED.gross_actual
      `;
      await tx`DROP TABLE rebuild_root_cost, rebuild_root_lvl, rebuild_root_next`;
      return { runGroups: res.count, costGroups: res.count };
    },
  });
}
