import { sql as defaultSql } from "../db/index.js";

/**
 * Folds `run_rollup_deltas` into the run-count rollups (SEND-RUN-LATENCY-1111, migration 0109).
 *
 * A run opened on the write pool queues its +1s there instead of upserting shared rollup rows
 * inside its own transaction (those rows stayed locked until COMMIT and every other run open of
 * the same org queued behind them: postmark run opens up to 182 s in prod). This worker applies
 * them, aggregated per rollup key, in batches: each batch deletes the deltas it applies in the
 * same transaction (`drain_run_rollup_deltas`), so a crash loses nothing and nothing counts twice.
 *
 * Cadence ~1 s, first tick right after listen() (no boot-window work), single flight in process,
 * one drain at a time across processes (advisory lock in the SQL function). Run-count reads lag
 * the open by at most a tick or two; money and every other figure are untouched.
 */
export const DRAIN_INTERVAL_MS = 1_000;
const BATCH = 2_000;
/** A tick stops after this many batches (a backlog after an outage drains over several ticks). */
const MAX_BATCHES_PER_TICK = 50;

/**
 * Applies `cost_rollup_deltas` (SEND-RUN-LATENCY-1111-COST, migration 0110): the rollup effects of
 * cost writes (and run updates) made on the write pool, queued instead of upserting shared rows.
 * Same protocol: each batch deletes what it applies in its own transaction, one drain at a time.
 * Calls are applied one by one with the original helper (min/max and stale flags behave exactly as
 * in the synchronous write), ~24 per cost row.
 */
const COST_BATCH = 2_000;

export async function drainCostRollupDeltas(sql = defaultSql, maxBatches = MAX_BATCHES_PER_TICK): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const [{ n }] = await sql<{ n: number }[]>`SELECT drain_cost_rollup_deltas(${COST_BATCH}) AS n`;
    total += Number(n);
    if (Number(n) < COST_BATCH) break;
  }
  return total;
}

export async function drainRunRollupDeltas(sql = defaultSql, maxBatches = MAX_BATCHES_PER_TICK): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const [{ n }] = await sql<{ n: number }[]>`SELECT drain_run_rollup_deltas(${BATCH}) AS n`;
    total += Number(n);
    if (Number(n) < BATCH) break;
  }
  return total;
}

let started = false;

export function startRunRollupDrain(): void {
  if (started) return;
  started = true;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    // Run then cost queue, one after the other: both write the same rollup rows (org_hour, task_day,
    // audience runs), two drains in parallel would wait on each other.
    try {
      await drainRunRollupDeltas();
    } catch (err) {
      // Nothing is lost: the deltas stay queued and the next tick retries.
      console.error("[runs-service] run rollup drain failed, retrying next tick:", err);
    }
    try {
      await drainCostRollupDeltas();
    } catch (err) {
      console.error("[runs-service] cost rollup drain failed, retrying next tick:", err);
    } finally {
      running = false;
    }
  };
  setInterval(tick, DRAIN_INTERVAL_MS).unref();
  void tick();
}
