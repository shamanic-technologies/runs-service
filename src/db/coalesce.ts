import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

interface Executor {
  execute(query: SQLWrapper | string): PromiseLike<unknown>;
}

// drizzle keeps `dialect` off its public type; it is the same compiler `execute`
// itself runs (drizzle-orm pg-core/db.js), so the key is the exact SQL it sends.
interface WithDialect {
  dialect: { sqlToQuery(sequel: SQL): { sql: string; params: unknown[] } };
}

/**
 * Make `db.execute` share ONE database execution between identical queries in
 * flight: same SQL text AND same bound params. The second caller awaits the
 * first caller's promise (same rows, same error) instead of opening its own scan.
 *
 * Why: dashboards poll the same brand/campaign aggregation from several tabs and
 * services at once — production showed the same 5-10 s query running three times
 * side by side (2026-10-03). Each copy held an analytics connection and a core.
 *
 * Freshness: a joiner gets the answer of a query that started at most one query
 * duration earlier — exactly what it would have got had it arrived a moment
 * sooner. Nothing is cached: the entry is dropped the moment the query settles,
 * so the next call always reads the database again.
 *
 * Readers must treat the rows as read-only (they are shared by reference).
 */
export function coalesceExecute<T extends Executor>(db: T): T {
  const inFlight = new Map<string, Promise<unknown>>();
  const executeOnce = db.execute.bind(db);

  db.execute = ((query: SQLWrapper | string) => {
    const sequel = typeof query === "string" ? sql.raw(query) : query.getSQL();
    const built = (db as unknown as WithDialect).dialect.sqlToQuery(sequel);
    const key = JSON.stringify([built.sql, built.params]);

    const pending = inFlight.get(key);
    if (pending) return pending;

    const run = Promise.resolve(executeOnce(sequel)).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, run);
    return run;
  }) as T["execute"];

  return db;
}
