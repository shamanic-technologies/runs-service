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
    await sql`TRUNCATE run_events, runs_costs, runs CASCADE`;
  } finally {
    await sql.end();
  }
}
