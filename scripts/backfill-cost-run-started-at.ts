// Backfill runs_costs.run_started_at from the owning run (migration 0030).
//
// Denormalizes each cost row's owning-run start instant so the dated cross-org
// platform-spend series can read a single indexed table instead of joining runs.
// New rows are populated at write time by the cost.added projection trigger; this
// fills the pre-existing ledger.
//
// Invoke manually AFTER the 0030 deploy, and BEFORE deploying the read swap that
// groups spend by runs_costs.run_started_at (expand -> backfill -> swap). Running
// it via Railway boot is forbidden — an O(N) full-ledger UPDATE would block
// port-bind (CLAUDE.md "Boot-window hazards").
//
//   RUNS_SERVICE_DATABASE_URL=postgres://... npx tsx scripts/backfill-cost-run-started-at.ts
//
// Walks `created_at` in fixed time windows (bounded by idx_runs_costs_created_at),
// so it is a SINGLE forward index pass — never a full-table re-scan per batch —
// with short per-window locks. Idempotent: only fills rows where run_started_at
// IS NULL, so re-running resumes / no-ops. Every cost row has an owning run
// (FK, ON DELETE CASCADE) and runs.started_at is NOT NULL, so after a complete
// pass NO fillable row remains — the script exits non-zero if any does, because
// a NULL would silently drop that row out of every dated bucket.
// Window size (default 6h) via BACKFILL_WINDOW_HOURS.
//
// BACKFILL_FROM / BACKFILL_TO (ISO timestamps) clamp the `created_at` range this
// invocation walks, so several workers can split the ledger between them. Small
// computes need it: the same pass that takes ~35 min against a 2 CU production
// compute projects to ~40 h against a 0.25 CU one, because each row rewrite also
// maintains nine indexes and the compute is simultaneously serving reads. A
// bounded worker also exits non-zero only for ITS OWN range, so run the plain
// unbounded invocation once at the end for the authoritative completeness check.

import postgres from "postgres";

const url = process.env.RUNS_SERVICE_DATABASE_URL;
if (!url) {
  console.error("[backfill-cost-run-started-at] RUNS_SERVICE_DATABASE_URL is not set");
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
      console.warn(`[backfill-cost-run-started-at] ${label}: transient ${message.trim()} — retry ${attempt + 1}`);
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

async function main() {
  console.log(`[backfill-cost-run-started-at] starting (window=${WINDOW_MS / 3600000}h)`);

  const [bounds] = await withRetry(
    "bounds",
    () => sql<{ lo: Date | null; hi: Date | null }[]>`
      SELECT min(created_at) AS lo, max(created_at) AS hi
      FROM runs_costs WHERE run_started_at IS NULL
    `
  );
  if (!bounds.lo || !bounds.hi) {
    console.log("[backfill-cost-run-started-at] no NULL rows — nothing to do");
    return;
  }

  const hi = Math.min(bounds.hi.getTime(), RANGE_TO?.getTime() ?? Infinity);
  let cursor = Math.max(bounds.lo.getTime(), RANGE_FROM?.getTime() ?? -Infinity);
  if (RANGE_FROM || RANGE_TO) {
    console.log(
      `[backfill-cost-run-started-at] range-bounded: ${new Date(cursor).toISOString()} .. ${new Date(hi).toISOString()}`
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
          SET run_started_at = (SELECT r.started_at FROM runs r WHERE r.id = rc.run_id)
          WHERE rc.created_at >= ${from}::timestamptz
            AND rc.created_at <  ${to}::timestamptz
            AND rc.run_started_at IS NULL
      `
    );
    if (res.count > 0) {
      total += res.count;
      console.log(`[backfill-cost-run-started-at] ${from} .. ${to}: filled ${res.count} (total ${total})`);
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
      WHERE run_started_at IS NULL
    `
  );
  console.log(`[backfill-cost-run-started-at] done. total filled ${total}, remaining fillable ${remaining}`);
  if (RANGE_FROM || RANGE_TO) {
    // A range-bounded worker only owns its slice, so a non-zero global remainder is
    // expected while its siblings are still running. Completeness is decided by the
    // final unbounded invocation, not by this one.
    console.log("[backfill-cost-run-started-at] range-bounded worker — re-run unbounded for the completeness gate");
    return;
  }
  if (remaining !== "0") {
    console.error("[backfill-cost-run-started-at] WARNING: fillable rows remain — do NOT deploy the read swap yet");
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error("[backfill-cost-run-started-at] failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end();
  });
