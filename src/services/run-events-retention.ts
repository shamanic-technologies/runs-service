import { sql as defaultSql } from "../db/index.js";

/**
 * Retention for the LEAF telemetry log (`run_events`).
 *
 * `run_events` is written by `POST /v1/runs/:id/events` as raw trace output. It
 * projects to nothing, nothing is derived from it, and it is read directly by the
 * dashboard launch-progress poll — so an expired row carries no information any
 * other table needs. It is also by far the largest relation in this database
 * (4.9 GB / 2.56M rows on production, re-accumulating ~2.6M rows a month).
 *
 * SCOPE — this purges `run_events` and nothing else. The bronze LIFECYCLE logs
 * (`run_lifecycle_events`, `cost_lifecycle_events`) are the append-only source of
 * truth that the silver row tables are projected from; deleting from those would
 * destroy the ability to rebuild `runs` / `runs_costs`, which is the entire point
 * of the bronze layer. They are never swept, at any age.
 */
export const RUN_EVENTS_RETENTION_DAYS = 30;

/** Rows deleted per statement. Small enough to keep each lock short. */
const CHUNK_SIZE = 5_000;

/**
 * Ceiling on statements per sweep, so the first sweep against a long-unpurged
 * table cannot run unbounded. Anything left over is picked up by the next sweep.
 */
const MAX_CHUNKS_PER_SWEEP = 400;

/** Interval between sweeps. Retention is 30 days, so the exact cadence is slack. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type RunEventsPurgeResult = {
  cutoff: Date;
  deleted: number;
  chunks: number;
  /** True when the sweep stopped on MAX_CHUNKS_PER_SWEEP with rows still expired. */
  hitChunkCap: boolean;
};

/**
 * Delete `run_events` rows older than the retention window, in chunks.
 *
 * Chunked rather than one statement: a single unbounded DELETE over months of
 * backlog holds one long transaction and bloats WAL. Each chunk picks its ids
 * through `idx_run_events_created_at` (migration 0032) and commits on its own.
 */
export async function purgeExpiredRunEvents(
  sql = defaultSql,
  retentionDays: number = RUN_EVENTS_RETENTION_DAYS,
): Promise<RunEventsPurgeResult> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  let deleted = 0;
  let chunks = 0;

  while (chunks < MAX_CHUNKS_PER_SWEEP) {
    const rows = await sql<{ id: string }[]>`
      DELETE FROM run_events
      WHERE id IN (
        SELECT id FROM run_events
        WHERE created_at < ${cutoff.toISOString()}::timestamptz
        ORDER BY created_at
        LIMIT ${CHUNK_SIZE}
      )
      RETURNING id
    `;
    chunks += 1;
    deleted += rows.length;
    if (rows.length < CHUNK_SIZE) {
      return { cutoff, deleted, chunks, hitChunkCap: false };
    }
  }

  return { cutoff, deleted, chunks, hitChunkCap: true };
}

/**
 * Run a sweep now and every `SWEEP_INTERVAL_MS` afterwards.
 *
 * Called AFTER `app.listen()` — a sweep touches the database and must never sit
 * in front of the port bind (CLAUDE.md "Boot-window hazards"). A failed sweep is
 * logged loudly and retried on the next tick rather than crashing the process:
 * the alternative is a boot loop over a purge that no request depends on.
 */
export function startRunEventsRetention(): NodeJS.Timeout {
  const sweep = async () => {
    try {
      const result = await purgeExpiredRunEvents();
      console.log(
        `[Runs Service] run_events retention sweep: deleted=${result.deleted} chunks=${result.chunks} ` +
          `cutoff=${result.cutoff.toISOString()} retentionDays=${RUN_EVENTS_RETENTION_DAYS}` +
          (result.hitChunkCap ? " (chunk cap reached — remainder next sweep)" : ""),
      );
    } catch (err) {
      console.error("[Runs Service] run_events retention sweep failed:", err);
    }
  };

  void sweep();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
