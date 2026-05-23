import { describe, it, expect, afterAll } from "vitest";
import { sql } from "../../src/db/index.js";
import { closeDb } from "../helpers/test-db.js";

describe("Database indexes", () => {
  afterAll(async () => {
    await closeDb();
  });

  it("has the covering aggregation index on runs_costs", async () => {
    const result = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'runs_costs_old' AND indexname = 'idx_runs_costs_run_agg'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexdef).toContain("run_id");
    expect(result[0].indexdef).toContain("status");
    expect(result[0].indexdef).toContain("total_cost_in_usd_cents");
    expect(result[0].indexdef).toContain("quantity");
  });

  it("has the created_at index on runs_costs for budget queries", async () => {
    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'runs_costs_old' AND indexname = 'idx_runs_costs_created_at'
    `;
    expect(result).toHaveLength(1);
  });

  it("has the composite feature_slug + org index on runs", async () => {
    const result = await sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'runs_old' AND indexname = 'idx_runs_feature_org'
    `;
    expect(result).toHaveLength(1);
    expect(result[0].indexdef).toContain("feature_slug");
    expect(result[0].indexdef).toContain("organization_id");
  });

  it("does not have the removed unused indexes", async () => {
    const result = await sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename IN ('runs_old', 'runs_costs_old')
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
