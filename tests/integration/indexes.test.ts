import { describe, it, expect, afterAll } from "vitest";
import { sql } from "../../src/db/index.js";
import { closeDb } from "../helpers/test-db.js";

afterAll(async () => {
  await closeDb();
});

describe("Database indexes", () => {
  it("has the covering aggregation index on runs_costs", async () => {
    const result = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'runs_costs' AND indexname = 'idx_runs_costs_run_agg'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexdef).toContain("run_id");
    expect(result[0].indexdef).toContain("status");
    expect(result[0].indexdef).toContain("total_cost_in_usd_cents");
    expect(result[0].indexdef).toContain("quantity");
  });

  it("has the partial covering org-projected index on runs_costs (migration 0029)", async () => {
    const result = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'runs_costs' AND indexname = 'idx_runs_costs_org_projected'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexdef).toContain("organization_id");
    expect(result[0].indexdef).toContain("is_platform_projected");
  });

  it("has the partial covering projected-started index on runs_costs (migration 0030)", async () => {
    const result = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'runs_costs' AND indexname = 'idx_runs_costs_projected_started'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexdef).toContain("run_started_at");
    expect(result[0].indexdef).toContain("total_cost_in_usd_cents");
    expect(result[0].indexdef).toContain("is_platform_projected");
  });

  it("has the started_at + status covering index on runs (migration 0030)", async () => {
    const result = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'runs' AND indexname = 'idx_runs_started_status'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexdef).toContain("started_at");
    expect(result[0].indexdef).toContain("status");
  });

  it("has the feature_slug + brand_ids covering index on runs (migration 0030)", async () => {
    const result = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'runs' AND indexname = 'idx_runs_feature_brands'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexdef).toContain("feature_slug");
    expect(result[0].indexdef).toContain("brand_ids");
  });

  it("has the created_at index on runs_costs for budget queries", async () => {
    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'runs_costs' AND indexname = 'idx_runs_costs_created_at'
    `;
    expect(result).toHaveLength(1);
  });

  it("has the composite feature_slug + org index on runs", async () => {
    const result = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'runs' AND indexname = 'idx_runs_feature_org'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexdef).toContain("feature_slug");
    expect(result[0].indexdef).toContain("organization_id");
  });

  it("has the created_at index on run_events for the retention sweep (migration 0032)", async () => {
    const result = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'run_events' AND indexname = 'idx_run_events_created_at'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexdef).toContain("created_at");
  });

  it("does not have the removed unused indexes", async () => {
    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('runs', 'runs_costs')
        AND indexname IN (
          'idx_runs_org',
          'idx_runs_status',
          'idx_runs_started_at',
          'idx_runs_workflow_slug',
          'idx_runs_costs_cost_name',
          'idx_runs_costs_run_id'
        )
    `;
    expect(result).toHaveLength(0);
  });
});

describe("Silver table naming (migration 0031)", () => {
  it("serves runs and runs_costs as BASE TABLES, not view shims", async () => {
    const result = await sql<{ table_name: string; table_type: string }[]>`
      SELECT table_name, table_type FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('runs', 'runs_costs')
      ORDER BY table_name
    `;
    expect(result).toEqual([
      { table_name: "runs", table_type: "BASE TABLE" },
      { table_name: "runs_costs", table_type: "BASE TABLE" },
    ]);
  });

  it("has no *_old relation left in the schema", async () => {
    const result = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE '%\\_old'
    `;
    expect(result).toEqual([]);
  });

  it("keeps the generated cost predicates through the rename", async () => {
    const result = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'runs_costs'
        AND is_generated = 'ALWAYS'
      ORDER BY column_name
    `;
    expect(result.map((r) => r.column_name)).toEqual([
      "is_platform_committed",
      "is_platform_projected",
    ]);
  });

  it("keeps the foreign keys pointing at the renamed tables", async () => {
    const result = await sql<{ conname: string; tbl: string; ref: string }[]>`
      SELECT conname, conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref
      FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace
      ORDER BY conname
    `;
    expect(result).toEqual([
      { conname: "run_events_run_id_runs_id_fk", tbl: "run_events", ref: "runs" },
      { conname: "runs_costs_run_id_runs_id_fk", tbl: "runs_costs", ref: "runs" },
      { conname: "runs_parent_run_id_runs_id_fk", tbl: "runs", ref: "runs" },
    ]);
  });
});
