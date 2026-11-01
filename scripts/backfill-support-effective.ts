// Fill run_support_effective (migration 0091) from every existing support mark, then stamp
// `support_effective` so GET /internal/runs/subtree-costs reads it instead of walking up.
// Run once AFTER the deploy that ships 0091 (never on boot). Idempotent, safe to re-run.
//
//   RUNS_SERVICE_DATABASE_URL=postgres://... npx tsx scripts/backfill-support-effective.ts
//   prod, inside the container against dist/:
//   node -e 'import("/app/dist/services/support-effective.js").then(m => m.backfillSupportEffective({ log: console.log })).then(r => { console.log(r); process.exit(0); })'

import { backfillSupportEffective } from "../src/services/support-effective.js";

backfillSupportEffective({ log: console.log })
  .then((r) => {
    console.log(`done: ${r.marks} marks, ${r.rows} rows written, stamped`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
