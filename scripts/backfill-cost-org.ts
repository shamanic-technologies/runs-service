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
// Idempotent: only fills rows where organization_id IS NULL. Re-running after
// completion updates zero rows. Chunked so no single statement locks the table
// or exceeds a statement timeout. Rows whose run is org-less (run.organization_id
// IS NULL) are intentionally left NULL — org-spend reads never count them.

import postgres from "postgres";

const url = process.env.RUNS_SERVICE_DATABASE_URL;
if (!url) {
  console.error("[backfill-cost-org] RUNS_SERVICE_DATABASE_URL is not set");
  process.exit(1);
}

const BATCH = Number(process.env.BACKFILL_BATCH ?? 20000);

const sql = postgres(url, { max: 1, idle_timeout: 30, connect_timeout: 30 });

async function main() {
  console.log(`[backfill-cost-org] starting (batch=${BATCH})`);
  let total = 0;
  for (;;) {
    // Grab a bounded batch of NULL-org cost rows whose run HAS an org, and copy
    // it over. Keyset-free (each pass shrinks the NULL set); terminates when no
    // fillable rows remain. FOR UPDATE SKIP LOCKED keeps it safe alongside live
    // writes.
    const res = await sql`
      WITH batch AS (
        SELECT rc.id, r.organization_id AS org
        FROM runs_costs_old rc
        JOIN runs_old r ON r.id = rc.run_id
        WHERE rc.organization_id IS NULL
          AND r.organization_id IS NOT NULL
        LIMIT ${BATCH}
        FOR UPDATE OF rc SKIP LOCKED
      )
      UPDATE runs_costs_old rc
        SET organization_id = batch.org
        FROM batch
        WHERE rc.id = batch.id
    `;
    if (res.count === 0) break;
    total += res.count;
    console.log(`[backfill-cost-org] filled ${res.count} (running total ${total})`);
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
