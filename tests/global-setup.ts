import postgres from "postgres";

// Runs ONCE per test command (per CI shard) before any worker starts.
// Wipes data inherited from the Neon parent branch so cross-org/public
// endpoints see only data that this run inserts. Per-test cleanup remains
// org-scoped via cleanTestData() so files can still run in parallel.
//
// No-op when RUNS_SERVICE_DATABASE_URL is unset — unit tests run without a
// real database and would otherwise crash here before any tests collect.
export async function setup() {
  const url = process.env.RUNS_SERVICE_DATABASE_URL;
  if (!url) return;
  const sql = postgres(url, { max: 1, idle_timeout: 1, connect_timeout: 10 });
  try {
    // Post Phase 6 (view shim): `runs` and `runs_costs` are auto-updatable
    // views over `runs_old` / `runs_costs_old`. TRUNCATE only works on base
    // tables — target the *_old tables directly when they exist. Local
    // direct-push verification DBs use the current schema tables instead.
    const [tables] = await sql<[{ runs_old: string | null }]>`
      SELECT to_regclass('public.runs_old')::text AS runs_old
    `;
    if (tables.runs_old) {
      await sql`TRUNCATE run_lifecycle_events, cost_lifecycle_events, run_events, runs_costs_old, runs_old CASCADE`;
    } else {
      await sql`TRUNCATE run_lifecycle_events, cost_lifecycle_events, run_events, runs_costs, runs CASCADE`;
    }
  } finally {
    await sql.end();
  }
}
