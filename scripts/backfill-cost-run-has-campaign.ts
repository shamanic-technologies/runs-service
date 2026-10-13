// Backfill runs_costs.run_has_campaign from the owning run (migration 0045).
//
// New rows are frozen at insert by the trg_freeze_cost_run_has_campaign trigger;
// this fills the pre-existing ledger. Invoke manually AFTER the 0045 deploy (never
// at boot: an O(N) full-ledger UPDATE would block port-bind).
//
//   RUNS_SERVICE_DATABASE_URL=postgres://... npx tsx scripts/backfill-cost-run-has-campaign.ts
//   (prod: the same windowed UPDATE was run as a psql loop on the box, 2026-10-13)
//
// Walks `created_at` in fixed windows (idx_runs_costs_created_at): one forward
// pass, short per-window locks, idempotent (fills only NULL rows). Every cost row
// has an owning run (FK), so after a complete pass no NULL remains; exits non-zero
// otherwise. Window size (default 6h) via BACKFILL_WINDOW_HOURS.

import postgres from "postgres";

const url = process.env.RUNS_SERVICE_DATABASE_URL;
if (!url) {
  console.error("[backfill-cost-run-has-campaign] RUNS_SERVICE_DATABASE_URL is not set");
  process.exit(1);
}

const WINDOW_MS = Number(process.env.BACKFILL_WINDOW_HOURS ?? 6) * 3600 * 1000;
const RANGE_FROM = process.env.BACKFILL_FROM ? new Date(process.env.BACKFILL_FROM) : null;
const RANGE_TO = process.env.BACKFILL_TO ? new Date(process.env.BACKFILL_TO) : null;

const sql = postgres(url, { max: 1, idle_timeout: 30, connect_timeout: 30 });

const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|CONNECTION_CLOSED|CONNECTION_ENDED|timeout/i;

/**
 * Retry one window on a transient connection failure. A long backfill against a
 * Neon compute reliably outlives at least one reset (observed mid-pass on prod:
 * `ECONNRESET` after ~213k rows), and the UPDATE is idempotent — it only ever
 * fills rows still NULL — so replaying a window is always safe.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [250, 500, 1000, 2000, 4000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const message = `${(err as Error)?.message ?? ""} ${(err as { code?: string })?.code ?? ""}`;
      if (attempt >= delays.length || !TRANSIENT.test(message)) throw err;
      console.warn(`[backfill-cost-run-has-campaign] ${label}: transient ${message.trim()} — retry ${attempt + 1}`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function main() {
  console.log(`[backfill-cost-run-has-campaign] starting (window=${WINDOW_MS / 3600000}h)`);

  const [bounds] = await withRetry(
    "bounds",
    () => sql<{ lo: Date | null; hi: Date | null }[]>`
      SELECT min(created_at) AS lo, max(created_at) AS hi
      FROM runs_costs WHERE run_has_campaign IS NULL
    `
  );
  if (!bounds.lo || !bounds.hi) {
    console.log("[backfill-cost-run-has-campaign] no NULL rows — nothing to do");
    return;
  }

  const hi = Math.min(bounds.hi.getTime(), RANGE_TO?.getTime() ?? Infinity);
  let cursor = Math.max(bounds.lo.getTime(), RANGE_FROM?.getTime() ?? -Infinity);
  if (RANGE_FROM || RANGE_TO) {
    console.log(
      `[backfill-cost-run-has-campaign] range-bounded: ${new Date(cursor).toISOString()} .. ${new Date(hi).toISOString()}`
    );
  }
  let total = 0;
  while (cursor <= hi) {
    const from = new Date(cursor).toISOString();
    const to = new Date(cursor + WINDOW_MS).toISOString();
    // Correlated scalar subquery, NOT `UPDATE ... FROM runs r WHERE r.id = rc.run_id`.
    // The FROM-join form lets the planner pick a hash join and seq-scan the whole
    // 2.9M-row `runs` table ONCE PER WINDOW (measured >30s per 6h window on prod);
    // the correlated form is a bitmap index scan on idx_runs_costs_created_at plus
    // one runs_pkey lookup per row, which is what makes the pass linear.
    const res = await withRetry(
      from,
      () => sql`
        UPDATE runs_costs rc
          SET run_has_campaign = (SELECT r.campaign_id IS NOT NULL FROM runs r WHERE r.id = rc.run_id)
          WHERE rc.created_at >= ${from}::timestamptz
            AND rc.created_at <  ${to}::timestamptz
            AND rc.run_has_campaign IS NULL
      `
    );
    if (res.count > 0) {
      total += res.count;
      console.log(`[backfill-cost-run-has-campaign] ${from} .. ${to}: filled ${res.count} (total ${total})`);
    }
    cursor += WINDOW_MS;
  }

  // Read the authoritative remaining count back from the DB rather than trusting
  // the loop's own counters — a re-run of an already-complete backfill legitimately
  // reports `filled 0`, which is indistinguishable from "did nothing" in the log.
  // Every cost row has an owning run (FK, ON DELETE CASCADE) and runs.started_at is
  // NOT NULL, so every remaining NULL is fillable — no join needed to qualify them.
  const [{ remaining }] = await withRetry(
    "remaining",
    () => sql<{ remaining: string }[]>`
      SELECT count(*)::text AS remaining
      FROM runs_costs
      WHERE run_has_campaign IS NULL
    `
  );
  console.log(`[backfill-cost-run-has-campaign] done. total filled ${total}, remaining fillable ${remaining}`);
  if (RANGE_FROM || RANGE_TO) {
    // A range-bounded worker only owns its slice, so a non-zero global remainder is
    // expected while its siblings are still running. Completeness is decided by the
    // final unbounded invocation, not by this one.
    console.log("[backfill-cost-run-has-campaign] range-bounded worker — re-run unbounded for the completeness gate");
    return;
  }
  if (remaining !== "0") {
    console.error("[backfill-cost-run-has-campaign] WARNING: fillable rows remain — the no-campaign balance read will 500 on them");
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("[backfill-cost-run-has-campaign] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end();
  });
