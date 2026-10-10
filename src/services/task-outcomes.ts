import { sql } from "drizzle-orm";
import { statsDb } from "../db/index.js";

// GET /internal/stats/task-outcomes — fleet-wide (every org + org-less platform
// runs), per normalized task of ONE service: how its most recent runs ended, how
// long they took, and what one run cost on average (its WHOLE subtree, all cost
// sources, `actual` rows only, gross billed basis). api-registry-service reads it
// to tell an agent which endpoint to use when it builds a workflow.

/** Every UUID in a task name collapses to this literal, so per-entity task names group. */
export const TASK_ID_PLACEHOLDER = "{id}";
// Case-insensitive through the 'gi' flags below.
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const TASK_OUTCOMES_SAMPLE_DEFAULT = 200;
export const TASK_OUTCOMES_SAMPLE_MAX = 1000;

/**
 * Per-statement ceiling for this read, above the analytics pool's 30 s default.
 * Prod 2026-10-10: serviceName=api-service at sample=200 walks ~2.25M subtree
 * runs (200 `POST /v1/campaigns` roots are whole campaign trees) and answers in
 * 27-59 s on a normal box, 80-121 s while the box was saturated (load 23 on 8
 * vCPU, first calls after the v0.47.33 deploy); apollo-service 3-32 s. The
 * consumer caches and refreshes in the background, so a slow answer is fine; a
 * timeout would never answer, and it would fire exactly when the box is busiest.
 */
const STATEMENT_TIMEOUT = "290s";

/**
 * At most this many task-outcome reads hold an analytics connection at once (the
 * pool has 8, shared with every dashboard stats read). A consumer refreshing every
 * service at once queues here instead of starving the dashboards.
 */
const MAX_CONCURRENT = 2;

export interface TaskOutcome {
  taskName: string;
  totalRunCount: number;
  sampleSize: number;
  completedCount: number;
  failedCount: number;
  runningCount: number;
  successRate: number | null;
  avgDurationMs: number | null;
  sumCompletedDurationMs: number;
  avgCostInUsdCents: string;
  sumCostInUsdCents: string;
  lastRunAt: string;
}

interface Row {
  task_name: string;
  total_run_count: string | number;
  sample_size: string | number;
  completed_count: string | number;
  failed_count: string | number;
  running_count: string | number;
  sum_completed_duration_ms: string | number | null;
  sum_cost: string;
  avg_cost: string;
  last_run_at: string | Date;
}

async function queryTaskOutcomes(serviceName: string, sample: number): Promise<TaskOutcome[]> {
  // Plan notes (prod EXPLAIN ANALYZE, 2026-10-10):
  // - The sample is MATERIALIZED, so the subtree walk is anchored on it alone.
  // - The walk fetches children through a LATERAL with OFFSET 0: without the fence
  //   Postgres flattens it into a merge join that index-scans ALL of runs per
  //   recursion level (apollo 10.5 s -> 3.2 s with the fence).
  // - Cost is a plain hash join to runs_costs (one scan of the `actual` rows), not
  //   a per-run LATERAL: 2.25M index probes cost api-service ~25 s alone.
  // Statuses are enumerated, never negated.
  const rows = (await statsDb.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`));
    return tx.execute(sql`
      WITH RECURSIVE ranked AS (
        SELECT r.id, r.status, r.started_at, r.completed_at, n.task,
          row_number() OVER (PARTITION BY n.task ORDER BY r.started_at DESC, r.id DESC) AS rn,
          count(*) OVER (PARTITION BY n.task) AS total_run_count
        FROM runs r
        CROSS JOIN LATERAL (
          SELECT regexp_replace(r.task_name, ${sql.raw(`'${UUID_PATTERN}'`)}, ${sql.raw(`'${TASK_ID_PLACEHOLDER}'`)}, 'gi') AS task
        ) n
        WHERE r.service_name = ${serviceName}
      ),
      sampled AS MATERIALIZED (
        SELECT id, status, started_at, completed_at, task, total_run_count
        FROM ranked WHERE rn <= ${sample}
      ),
      descendants AS (
        SELECT id, id AS root_id FROM sampled
        UNION ALL
        SELECT ch.id, d.root_id FROM descendants d
        CROSS JOIN LATERAL (SELECT c.id FROM runs c WHERE c.parent_run_id = d.id OFFSET 0) ch
      ),
      root_cost AS (
        SELECT d.root_id, SUM(rc.total_cost_in_usd_cents) AS cost
        FROM descendants d
        JOIN runs_costs rc ON rc.run_id = d.id AND rc.status = 'actual'
        GROUP BY d.root_id
      )
      SELECT s.task AS task_name,
        MAX(s.total_run_count) AS total_run_count,
        COUNT(*) AS sample_size,
        COUNT(*) FILTER (WHERE s.status = 'completed') AS completed_count,
        COUNT(*) FILTER (WHERE s.status = 'failed') AS failed_count,
        COUNT(*) FILTER (WHERE s.status = 'running') AS running_count,
        round(SUM(EXTRACT(EPOCH FROM (s.completed_at - s.started_at)) * 1000)
          FILTER (WHERE s.status = 'completed'))::bigint AS sum_completed_duration_ms,
        round(COALESCE(SUM(rc.cost), 0), 10)::text AS sum_cost,
        round(COALESCE(SUM(rc.cost), 0) / COUNT(*), 10)::text AS avg_cost,
        MAX(s.started_at) AS last_run_at
      FROM sampled s
      LEFT JOIN root_cost rc ON rc.root_id = s.id
      GROUP BY s.task
      ORDER BY total_run_count DESC, s.task
    `);
  })) as unknown as Row[];

  return rows.map((row) => {
    const completedCount = Number(row.completed_count);
    const failedCount = Number(row.failed_count);
    const ended = completedCount + failedCount;
    // A completed run always carries completed_at (prod 2026-10-10: 0 without),
    // so the duration sum covers exactly completedCount runs.
    const sumCompletedDurationMs = row.sum_completed_duration_ms === null ? 0 : Number(row.sum_completed_duration_ms);
    return {
      taskName: row.task_name,
      totalRunCount: Number(row.total_run_count),
      sampleSize: Number(row.sample_size),
      completedCount,
      failedCount,
      runningCount: Number(row.running_count),
      successRate: ended > 0 ? completedCount / ended : null,
      avgDurationMs: completedCount > 0 ? Math.round(sumCompletedDurationMs / completedCount) : null,
      sumCompletedDurationMs,
      avgCostInUsdCents: row.avg_cost,
      sumCostInUsdCents: row.sum_cost,
      lastRunAt: new Date(row.last_run_at).toISOString(),
    };
  });
}

// Identical reads in flight share one execution (the transaction bypasses
// statsDb's own coalescing), and at most MAX_CONCURRENT run at once.
const inFlight = new Map<string, Promise<TaskOutcome[]>>();
let running = 0;
const waiters: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    // The releasing caller hands its slot over directly (running stays put).
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else {
    running += 1;
  }
  try {
    return await fn();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else running -= 1;
  }
}

export function getTaskOutcomes(serviceName: string, sample: number): Promise<TaskOutcome[]> {
  const key = JSON.stringify([serviceName, sample]);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = withSlot(() => queryTaskOutcomes(serviceName, sample)).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}
