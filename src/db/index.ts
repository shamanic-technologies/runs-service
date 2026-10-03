import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { coalesceExecute } from "./coalesce.js";

const connectionString = process.env.RUNS_SERVICE_DATABASE_URL;

if (!connectionString) {
  throw new Error("RUNS_SERVICE_DATABASE_URL is not set");
}

// The hot read on this database is a multi-second aggregation over the cost
// ledger, and `/health` runs `SELECT 1` through this same pool — so a pool that
// saturates does not merely slow queries down, it stops the service answering
// its own health route. 20 connections give the aggregations room without
// approaching the server's limit.
//
// `idle_timeout` is deliberately UNSET: postgres.js defaults it to null (idle
// connections are never closed), and setting a value buys a fresh TCP+TLS
// handshake on the next request after any quiet stretch. `connect_timeout`
// stays bounded so a database that is not accepting connections fails fast
// instead of hanging the caller.
//
// `jit` is OFF for every connection of this pool. The stats reads here are
// aggregations whose plans Postgres costs high enough to JIT-compile, and the
// compile itself dominated them: the cross-org per-workflow cost read spent
// 1.4 s of its 5 s compiling 72 functions, on every call (2026-09-24). None of
// these queries runs long enough for compiled expressions to repay that.
export const sql = postgres(connectionString, {
  max: 20,
  connect_timeout: 10,
  connection: { jit: "off" },
});
export const db = drizzle(sql, { schema });

// ANALYTICS pool — every stats / reporting read (src/routes/stats.ts,
// vendor-costs.ts, run-outcomes.ts) runs here, never on the pool above.
//
// Why a second pool: cost writes and run lifecycle calls answer every fleet
// service in seconds or that service loses its cost declaration. With one pool,
// dashboards polling multi-second brand aggregations held all 20 connections and
// a `POST /v1/platform-runs/:id/costs` queued behind them until the caller's 15 s
// timeout fired (social-service, 2026-10-03). A dedicated pool makes that queue
// impossible: stats reads can only wait for EACH OTHER.
//
// `max: 8` is also the cap on how much database CPU the reads can take at once
// (8 vCPUs on the box, shared with every other service), so writes keep CPU too.
// `statement_timeout` bounds any single read: past 30 s it fails loud (500) instead
// of holding a connection and a core for a minute while its caller has long given up.
// Identical reads in flight share one execution (see coalesce.ts).
export const statsSql = postgres(connectionString, {
  max: 8,
  connect_timeout: 10,
  connection: { jit: "off", statement_timeout: 30000 },
});
export const statsDb = coalesceExecute(drizzle(statsSql, { schema }));
