// Backfill runs_costs.organization_id from the owning run (migration 0029).
//
// Denormalizes each cost row's org so org-level platform-spend SUMs can read a
// single indexed table instead of joining runs. New rows are populated at write
// time by the cost.added projection trigger; this fills the pre-existing ledger.
//
// Invoke manually AFTER the 0029 deploy, and BEFORE deploying the read swap that
// reads runs_costs.organization_id (expand -> backfill -> swap). Running it via
// Railway boot is forbidden — an O(N) full-ledger UPDATE would block port-bind
// (CLAUDE.md "Boot-window hazards").
//
//   RUNS_SERVICE_DATABASE_URL=postgres://... npx tsx scripts/backfill-cost-org.ts
//
// Walks `created_at` in fixed time windows (bounded by idx_runs_costs_created_at),
// so it is a SINGLE forward index pass — never a full-table re-scan per batch —
// with short per-window locks. Idempotent: only fills rows where organization_id
// IS NULL, so re-running resumes / no-ops. Rows whose run is org-less
// (run.organization_id IS NULL) are intentionally left NULL — org-spend reads
// never count them. Window size (default 6h) via BACKFILL_WINDOW_HOURS.

import postgres from "postgres";

const url = process.env.RUNS_SERVICE_DATABASE_URL;
if (!url) {
  console.error("[backfill-cost-org] RUNS_SERVICE_DATABASE_URL is not set");
  process.exit(1);
}

const WINDOW_MS = Number(process.env.BACKFILL_WINDOW_HOURS ?? 6) * 3600 * 1000;

const sql = postgres(url, { max: 1, idle_timeout: 30, connect_timeout: 30 });

async function main() {
  console.log(`[backfill-cost-org] starting (window=${WINDOW_MS / 3600000}h)`);

  const [bounds] = await sql<{ lo: Date | null; hi: Date | null }[]>`
    SELECT min(created_at) AS lo, max(created_at) AS hi
    FROM runs_costs_old WHERE organization_id IS NULL
  `;
  if (!bounds.lo || !bounds.hi) {
    console.log("[backfill-cost-org] no NULL-org rows — nothing to do");
    return;
  }

  const hi = bounds.hi.getTime();
  let cursor = bounds.lo.getTime();
  let total = 0;
  while (cursor <= hi) {
    const from = new Date(cursor).toISOString();
    const to = new Date(cursor + WINDOW_MS).toISOString();
    const res = await sql`
      UPDATE runs_costs_old rc
        SET organization_id = r.organization_id
        FROM runs_old r
        WHERE r.id = rc.run_id
          AND rc.created_at >= ${from}::timestamptz
          AND rc.created_at <  ${to}::timestamptz
          AND rc.organization_id IS NULL
          AND r.organization_id IS NOT NULL
    `;
    if (res.count > 0) {
      total += res.count;
      console.log(`[backfill-cost-org] ${from} .. ${to}: filled ${res.count} (total ${total})`);
    }
    cursor += WINDOW_MS;
  }

  const [{ remaining }] = await sql<{ remaining: string }[]>`
    SELECT count(*)::text AS remaining
    FROM runs_costs_old rc
    JOIN runs_old r ON r.id = rc.run_id
    WHERE rc.organization_id IS NULL AND r.organization_id IS NOT NULL
  `;
  console.log(`[backfill-cost-org] done. total filled ${total}, remaining fillable ${remaining}`);
  if (remaining !== "0") {
    console.error("[backfill-cost-org] WARNING: fillable rows remain — do NOT deploy the read swap yet");
    process.exit(1);
  }
}

main()
  .then(() => sql.end())
  .catch((err) => {
    console.error("[backfill-cost-org] failed:", err);
    process.exit(1);
  });
