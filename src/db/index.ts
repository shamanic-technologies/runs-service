import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

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
export const sql = postgres(connectionString, {
  max: 20,
  connect_timeout: 10,
});
export const db = drizzle(sql, { schema });
