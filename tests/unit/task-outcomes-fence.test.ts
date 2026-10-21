import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// GET /internal/stats/task-outcomes on its rollup paths (migration 0043 org_task,
// 0054 root_cost). Prod 2026-10-22: 37-225 s live (up to the 290 s ceiling) on
// the shared Postgres; the plan shapes below are what made it seconds.
describe("task-outcomes rollup-path plan shapes", () => {
  const src = readFileSync(new URL("../../src/services/task-outcomes.ts", import.meta.url), "utf8");
  const sampledAt = src.indexOf("function sampledSql(");
  const sampled = src.slice(sampledAt, src.indexOf("function rootCostSql(", sampledAt));
  const rollupSampled = sampled.slice(sampled.indexOf("keys AS MATERIALIZED"));
  const costAt = src.indexOf("function rootCostSql(");
  const cost = src.slice(costAt, src.indexOf("async function queryTaskOutcomes(", costAt));
  const rollupCost = cost.slice(cost.indexOf("WHERE parent_run_id IS NOT NULL"));

  it("reads each candidate key newest-first with a LIMIT, one index range scan per NULL / non-NULL campaign", () => {
    expect(sampledAt).toBeGreaterThan(-1);
    // Without the per-key LIMIT every candidate DAY of the key hit the heap
    // (api-service: 46 s instead of 34 s at load 36, same rows).
    expect(rollupSampled.match(/ORDER BY r\.started_at DESC, r\.id DESC LIMIT \$\{sample\}/g)?.length).toBe(2);
    expect(rollupSampled).toContain("k.campaign_id IS NOT NULL AND r.campaign_id = k.campaign_id");
    expect(rollupSampled).toContain("k.campaign_id IS NULL AND r.campaign_id IS NULL");
    // The candidate keys and the cutoffs are computed once.
    expect(rollupSampled).toContain("cand_keys AS MATERIALIZED");
    expect(rollupSampled).toContain("cutoff AS MATERIALIZED");
    expect(rollupSampled).toContain("sampled AS MATERIALIZED");
  });

  it("walks only non-top-level samples, fenced, and reads top-level costs from the rollup", () => {
    expect(rollupCost.length).toBeGreaterThan(0);
    expect(rollupCost).toContain("CROSS JOIN LATERAL (SELECT c.id FROM runs c WHERE c.parent_run_id = d.id OFFSET 0) ch");
    expect(rollupCost).toMatch(/WHERE x\.run_id = d\.id AND x\.status = 'actual' OFFSET 0/);
    expect(rollupCost).toContain("JOIN stats_rollup_root_cost t ON t.root_run_id = s.id");
    expect(rollupCost).toContain("WHERE s.parent_run_id IS NULL");
  });
});
