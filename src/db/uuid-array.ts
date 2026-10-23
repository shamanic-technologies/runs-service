import { sql, type SQL } from "drizzle-orm";

/**
 * A tree-sized id list as ONE array parameter. One fragment per id (`sql.join`,
 * `inArray`) makes one bind parameter per id: drizzle merges them with
 * `push(...params)`, which overflows the call stack past ~125k ids ("Maximum call
 * stack size exceeded" on POST /v1/runs/batch, a content-generation run tree,
 * 2026-10-24), and postgres caps a statement at 65,535 parameters anyway.
 */
export const uuidArray = (ids: string[]): SQL => sql`${`{${ids.join(",")}}`}::uuid[]`;
