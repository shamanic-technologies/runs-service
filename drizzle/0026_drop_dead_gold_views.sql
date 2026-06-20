-- Drop the dead gold views v_run_cost_rollup / v_org_platform_spend /
-- v_runs_with_descendants (created 0019, recreated verbatim in 0022).
--
-- These were never a safe read path. A plain VIEW is structurally wrong for a
-- parametrised subtree rollup: v_runs_with_descendants anchors on the UNBOUNDED
-- `SELECT id FROM runs`, so any `SELECT FROM v_run_cost_rollup WHERE root_run_id
-- = $1` forced PG to materialise the FULL ~880k-row recursive closure before
-- filtering (PG can't push a predicate through a recursive CTE + GROUP BY).
-- Single-run lookups OOMed prod Neon to 20+ GB / 5+ CU. The hot read paths were
-- reverted to INLINE BOUNDED recursive CTEs (anchor `WHERE id = $1` /
-- `id IN (runIds)`) in df9230e — those only walk descendants of the requested
-- roots and are the expert-correct pattern for OLTP point-lookups on an indexed
-- adjacency list (idx_runs_parent). The shared SUM-CASE builder lives in
-- src/services/cost-aggregator.ts (atomic-literal predicate doctrine).
--
-- Since df9230e no application code reads these views; they survived only as a
-- footgun (a future dev re-wiring them per the now-corrected docs would re-OOM)
-- and as scaffolding for bsg-substrate.test.ts. This migration removes them so
-- B/S/G reflects reality: gold = bounded recursive CTE on read, not views.
--
-- Drop in dependency order: v_run_cost_rollup depends on v_runs_with_descendants;
-- v_org_platform_spend is independent. Idempotent (IF EXISTS). The retained gold
-- objects are the generated predicate columns runs_costs.is_platform_projected /
-- is_platform_committed + their partial indexes (schema-level, still the single
-- source for the platform-spend predicate).

DROP VIEW IF EXISTS "v_run_cost_rollup";--> statement-breakpoint
DROP VIEW IF EXISTS "v_org_platform_spend";--> statement-breakpoint
DROP VIEW IF EXISTS "v_runs_with_descendants";
