// Which support function covers each run, kept at write time (migration 0091).
//
// A support mark covers its run's whole subtree. run_support_effective holds, per covered
// run, the kind of the NEAREST marked run among itself and its ancestors, so a read states
// it with one PK probe instead of walking up the tree (GET /internal/runs/subtree-costs).
//
// - A run inserted under a covered parent inherits at insert (0091's trigger).
// - A mark written / changed / removed queues its run. The worker below recomputes the run's
//   kind (own mark, else the parent's) and rewrites its subtree down to the first descendant
//   carrying its own mark. Each queued run is processed twice (~60 s apart): the second pass
//   catches a child inserted while the first ran (it inherited the old value).
// - The past is filled once by backfillSupportEffective() (scripts/backfill-support-effective.ts),
//   which stamps `support_effective`; until then reads keep the upward walk.

import { sql as rawSql } from "../db/index.js";

export const SUPPORT_EFFECTIVE_STAMP = "support_effective";

const BATCH = 200;
const SECOND_PASS_DELAY_S = 60;
const FIRST_TICK_DELAY_MS = 60_000;
const TICK_INTERVAL_MS = 15_000;

/**
 * Recompute one run's support kind and rewrite its subtree (down to the first descendant
 * with its own mark, which keeps its own). Fenced child fetch (LATERAL ... OFFSET 0 on
 * idx_runs_parent), the plan rule of every run-tree walk here. A run that no longer exists
 * walks nothing.
 */
async function propagate(tx: typeof rawSql, runId: string): Promise<{ walked: number }> {
  const [row] = await tx`
    WITH RECURSIVE target AS (
      SELECT r.id, COALESCE(m.kind, pe.kind) AS kind
      FROM runs r
      LEFT JOIN run_support_marks m ON m.run_id = r.id
      LEFT JOIN run_support_effective pe ON pe.run_id = r.parent_run_id
      WHERE r.id = ${runId}::uuid
    ),
    sub AS (
      SELECT id FROM target
      UNION ALL
      SELECT ch.id FROM sub CROSS JOIN LATERAL (
        SELECT c.id FROM runs c
        WHERE c.parent_run_id = sub.id
          AND NOT EXISTS (SELECT 1 FROM run_support_marks x WHERE x.run_id = c.id)
        OFFSET 0
      ) ch
    ),
    del AS (
      DELETE FROM run_support_effective e
      USING sub
      WHERE e.run_id = sub.id AND (SELECT kind FROM target) IS NULL
      RETURNING 1
    ),
    ins AS (
      INSERT INTO run_support_effective (run_id, kind)
      SELECT sub.id, t.kind FROM sub CROSS JOIN target t WHERE t.kind IS NOT NULL
      ON CONFLICT (run_id) DO UPDATE SET kind = EXCLUDED.kind
        WHERE run_support_effective.kind IS DISTINCT FROM EXCLUDED.kind
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM sub)::int AS walked, (SELECT count(*) FROM del)::int AS d, (SELECT count(*) FROM ins)::int AS i
  `;
  return { walked: row.walked as number };
}

/** One pass over the queue's due runs, BATCH at a time, until none is due. Returns runs processed. */
export async function drainSupportPropagationQueue(): Promise<number> {
  let processed = 0;
  for (;;) {
    const done = await rawSql.begin(async (txn) => {
      // postgres.js types TransactionSql without its call signature; it is callable.
      const tx = txn as unknown as typeof rawSql;
      const due = await tx`
        SELECT run_id::text AS run_id, passes_left FROM run_support_propagation_queue
        WHERE due_at <= now()
        ORDER BY due_at
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      `;
      for (const q of due) {
        await propagate(tx, q.run_id as string);
        if ((q.passes_left as number) > 1) {
          await tx`
            UPDATE run_support_propagation_queue
            SET passes_left = passes_left - 1, due_at = now() + make_interval(secs => ${SECOND_PASS_DELAY_S})
            WHERE run_id = ${q.run_id}::uuid
          `;
        } else {
          await tx`DELETE FROM run_support_propagation_queue WHERE run_id = ${q.run_id}::uuid`;
        }
      }
      return due.length;
    });
    processed += done;
    if (done < BATCH) return processed;
  }
}

let running = false;

/** In-process worker: first tick ~60 s after boot, then every 15 s; in-function mutex. */
export function startSupportPropagation(): void {
  if (process.env.SUPPORT_PROPAGATION_ENABLED === "false") return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const n = await drainSupportPropagationQueue();
      if (n > 0) console.log(`[Runs Service] support propagation: ${n} queued run(s) processed`);
    } catch (err) {
      console.error("[Runs Service] support propagation failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), FIRST_TICK_DELAY_MS).unref();
  setInterval(() => void tick(), TICK_INTERVAL_MS).unref();
}

/**
 * Fill run_support_effective from every existing mark, set-based, CHUNK marks per statement
 * (descending from each marked run, stopping at descendants with their own mark: each covered
 * run is reached once, from its nearest marked ancestor). Then stamp. Idempotent; marks
 * written meanwhile are also queued (0091), so the worker converges whatever it overlaps.
 */
export async function backfillSupportEffective(
  opts: { chunk?: number; log?: (m: string) => void } = {},
): Promise<{ marks: number; rows: number }> {
  const chunk = opts.chunk ?? 20_000;
  const log = opts.log ?? (() => {});
  let after = "00000000-0000-0000-0000-000000000000";
  let marks = 0;
  let rows = 0;
  for (;;) {
    const [res] = await rawSql`
      WITH RECURSIVE m AS MATERIALIZED (
        SELECT run_id, kind FROM run_support_marks WHERE run_id > ${after}::uuid ORDER BY run_id LIMIT ${chunk}
      ),
      eff AS (
        SELECT m.run_id AS id, m.kind FROM m
        UNION ALL
        SELECT ch.id, eff.kind FROM eff CROSS JOIN LATERAL (
          SELECT c.id FROM runs c
          WHERE c.parent_run_id = eff.id
            AND NOT EXISTS (SELECT 1 FROM run_support_marks x WHERE x.run_id = c.id)
          OFFSET 0
        ) ch
      ),
      ins AS (
        -- No join back to runs: every id is a live run (a mark cascades with its run, children
        -- come from runs), and the FK checks it. A JOIN hash-joined a full scan of runs_pkey
        -- (7.4M) per chunk: 101 s for 2,000 marks on prod (2026-11-01).
        INSERT INTO run_support_effective (run_id, kind)
        SELECT eff.id, eff.kind FROM eff
        ON CONFLICT (run_id) DO UPDATE SET kind = EXCLUDED.kind
          WHERE run_support_effective.kind IS DISTINCT FROM EXCLUDED.kind
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM m)::int AS n, (SELECT run_id::text FROM m ORDER BY run_id DESC LIMIT 1) AS last, (SELECT count(*) FROM ins)::int AS written
    `;
    const n = res.n as number;
    if (n === 0) break;
    marks += n;
    rows += res.written as number;
    after = res.last as string;
    log(`support_effective backfill: ${marks} marks, ${rows} rows written`);
    if (n < chunk) break;
  }
  await rawSql`INSERT INTO stats_rollups (name, ready_at) VALUES (${SUPPORT_EFFECTIVE_STAMP}, now()) ON CONFLICT (name) DO UPDATE SET ready_at = now()`;
  return { marks, rows };
}
