import { describe, it, expect } from "vitest";

// BOX-LOAD-1028-PG-CONNS: a Postgres backend keeps the memory of the biggest
// query it ever ran until it exits, so every pool recycles its connections
// (5 min lifetime, 60 s idle) instead of postgres.js's 30-60 min default.
describe("db pools recycle their connections", () => {
  it("sets max_lifetime 300 s and idle_timeout 60 s on every pool", async () => {
    const { sql, statsSql, readSql } = await import("../../src/db/index.js");
    for (const pool of [sql, statsSql, readSql]) {
      expect(pool.options.max_lifetime).toBe(300);
      expect(pool.options.idle_timeout).toBe(60);
    }
    expect(sql.options.max).toBe(20);
    expect(statsSql.options.max).toBe(8);
    expect(readSql.options.max).toBe(10);
  });
});
