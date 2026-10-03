import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { coalesceExecute } from "../../src/db/coalesce.js";

function fakeDb() {
  const calls: string[] = [];
  const releases: Array<(rows: unknown) => void> = [];
  const db = {
    dialect: new PgDialect(),
    execute(query: any) {
      calls.push(JSON.stringify(this.dialect.sqlToQuery(query.getSQL())));
      return new Promise((resolve) => releases.push(resolve));
    },
  };
  return { db: coalesceExecute(db), calls, releases };
}

describe("coalesceExecute", () => {
  it("runs identical in-flight queries once and gives every caller the same rows", async () => {
    const { db, calls, releases } = fakeDb();
    const a = db.execute(sql`SELECT ${"org-1"} AS o`);
    const b = db.execute(sql`SELECT ${"org-1"} AS o`);
    expect(calls).toHaveLength(1);
    releases[0]([{ o: "org-1" }]);
    expect(await a).toEqual([{ o: "org-1" }]);
    expect(await b).toBe(await a);
  });

  it("never shares across different params", () => {
    const { db, calls } = fakeDb();
    db.execute(sql`SELECT ${"org-1"} AS o`);
    db.execute(sql`SELECT ${"org-2"} AS o`);
    expect(calls).toHaveLength(2);
  });

  it("reads the database again once the first query settled (no cache)", async () => {
    const { db, calls, releases } = fakeDb();
    const a = db.execute(sql`SELECT 1`);
    releases[0]([]);
    await a;
    db.execute(sql`SELECT 1`);
    expect(calls).toHaveLength(2);
  });

  it("propagates a failure to every joined caller, then forgets it", async () => {
    const calls: number[] = [];
    let reject!: (e: Error) => void;
    const db = coalesceExecute({
      dialect: new PgDialect(),
      execute() {
        calls.push(1);
        return new Promise((_, rej) => (reject = rej));
      },
    });
    const a = db.execute(sql`SELECT 1`);
    const b = db.execute(sql`SELECT 1`);
    reject(new Error("canceling statement due to statement timeout"));
    await expect(a).rejects.toThrow("statement timeout");
    await expect(b).rejects.toThrow("statement timeout");
    db.execute(sql`SELECT 1`).then(undefined, () => {});
    expect(calls).toHaveLength(2);
  });
});
