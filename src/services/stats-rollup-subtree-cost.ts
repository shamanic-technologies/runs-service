// Rebuild side of run_subtree_costs (migration 0086): per run, the actual and
// provisioned cost rows of its whole subtree (itself included), gross + frozen net.
// GET /v1/runs?include=subtreeCost reads it (services/run-subtree-cost.ts).

import { rebuildRollup } from "./stats-rollup.js";

export const SUBTREE_COST_ROLLUP_NAME = "subtree_cost";

/**
 * Aggregate on the exported snapshot, bottom-up, the 0054 root_cost way: start
 * from each run's own rows, record that level's sums as a contribution to the
 * run, then hand them to the parent, GROUPED, until no parent is left. A run's
 * contributions (its own rows, its children's subtrees, ...) are summed at merge.
 * Grouping per level keeps each level at most one row per run (the dead
 * 13,741-deep scheduler-resume chain is 13,741 one-row levels, not a carry of
 * every row to every ancestor at once).
 */
export async function rebuildSubtreeCostRollup(url: string): Promise<{ runGroups: number; costGroups: number; lockedMs: number }> {
  return rebuildRollup(url, {
    name: SUBTREE_COST_ROLLUP_NAME,
    tables: ["run_subtree_costs"],
    aggregate: async (b) => {
      await b`
        CREATE TEMP TABLE rebuild_subtree_out (
          id uuid NOT NULL, n bigint NOT NULL, ga numeric NOT NULL, gp numeric NOT NULL, na numeric NOT NULL, np numeric NOT NULL
        ) ON COMMIT PRESERVE ROWS
      `;
      await b`
        CREATE TEMP TABLE rebuild_subtree_lvl ON COMMIT PRESERVE ROWS AS
        SELECT run_id AS id,
          count(*) AS n,
          SUM(CASE WHEN status = 'actual'      THEN total_cost_in_usd_cents ELSE 0 END) AS ga,
          SUM(CASE WHEN status = 'provisioned' THEN total_cost_in_usd_cents ELSE 0 END) AS gp,
          SUM(CASE WHEN status = 'actual'      THEN COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents) ELSE 0 END) AS na,
          SUM(CASE WHEN status = 'provisioned' THEN COALESCE(net_cost_in_usd_cents, total_cost_in_usd_cents) ELSE 0 END) AS np
        FROM runs_costs WHERE status IN ('actual', 'provisioned') GROUP BY run_id
      `;
      await b`
        CREATE TEMP TABLE rebuild_subtree_next (
          parent uuid NOT NULL, n bigint NOT NULL, ga numeric NOT NULL, gp numeric NOT NULL, na numeric NOT NULL, np numeric NOT NULL
        ) ON COMMIT PRESERVE ROWS
      `;
      await b.unsafe(`
        DO $$
        BEGIN
          LOOP
            EXIT WHEN NOT EXISTS (SELECT 1 FROM rebuild_subtree_lvl);
            EXECUTE 'ANALYZE rebuild_subtree_lvl';
            EXECUTE 'INSERT INTO rebuild_subtree_out SELECT id, n, ga, gp, na, np FROM rebuild_subtree_lvl';
            EXECUTE 'INSERT INTO rebuild_subtree_next (parent, n, ga, gp, na, np)
                     SELECT r.parent_run_id, l.n, l.ga, l.gp, l.na, l.np
                     FROM rebuild_subtree_lvl l JOIN runs r ON r.id = l.id WHERE r.parent_run_id IS NOT NULL';
            EXECUTE 'TRUNCATE rebuild_subtree_lvl';
            EXECUTE 'INSERT INTO rebuild_subtree_lvl (id, n, ga, gp, na, np)
                     SELECT parent, SUM(n), SUM(ga), SUM(gp), SUM(na), SUM(np) FROM rebuild_subtree_next GROUP BY parent';
            EXECUTE 'TRUNCATE rebuild_subtree_next';
          END LOOP;
        END $$;
      `);
    },
    merge: async (tx) => {
      const res = await tx`
        INSERT INTO run_subtree_costs (run_id, n_rows, gross_actual, gross_provisioned, net_actual, net_provisioned)
        SELECT id, SUM(n), SUM(ga), SUM(gp), SUM(na), SUM(np) FROM rebuild_subtree_out GROUP BY id
        ON CONFLICT (run_id) DO UPDATE SET
          n_rows            = run_subtree_costs.n_rows            + EXCLUDED.n_rows,
          gross_actual      = run_subtree_costs.gross_actual      + EXCLUDED.gross_actual,
          gross_provisioned = run_subtree_costs.gross_provisioned + EXCLUDED.gross_provisioned,
          net_actual        = run_subtree_costs.net_actual        + EXCLUDED.net_actual,
          net_provisioned   = run_subtree_costs.net_provisioned   + EXCLUDED.net_provisioned
      `;
      await tx`DROP TABLE rebuild_subtree_out, rebuild_subtree_lvl, rebuild_subtree_next`;
      return { runGroups: res.count, costGroups: res.count };
    },
  });
}
