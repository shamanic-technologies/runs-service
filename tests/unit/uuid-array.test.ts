import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { uuidArray } from "../../src/db/uuid-array.js";

// POST /v1/runs/batch on a 150k+ run tree threw "Maximum call stack size exceeded"
// building one bind parameter per descendant id (2026-10-24).
describe("uuidArray: a tree-sized id list is one parameter", () => {
  const ids = Array.from({ length: 200_000 }, () => randomUUID());
  const dialect = new PgDialect();

  it("builds 200,000 ids as a single parameter", () => {
    const q = dialect.sqlToQuery(sql`SELECT 1 FROM runs WHERE id = ANY(${uuidArray(ids)})`);
    expect(q.params).toHaveLength(1);
    expect((q.params[0] as string).split(",")).toHaveLength(200_000);
  });

  it("the per-id form it replaces overflows the stack at that size", () => {
    expect(() => dialect.sqlToQuery(sql`SELECT 1 FROM runs WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`)).toThrow(RangeError);
  });
});
