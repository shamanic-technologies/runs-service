-- SCRIPT-VALUE-RATING-1113-RUNS. The produce / consume graph, summarised for features-service's Rating:
-- (1) how often a consumed Unit of one outcome yields a Unit of another (one-step rates), (2) which
-- outcomes each script run's chain reached, any depth. Rebuilt whole every ~15 min off the request path
-- (services/outcome-chains.ts); a row moved by a build is stamped with that build's instant (changes
-- feed), a row a build no longer produces is zeroed, never deleted.
--
-- BOOT-WINDOW SAFE: the partial index on runs is built out-of-band CONCURRENTLY on prod first (0108
-- pattern), so this IF NOT EXISTS no-ops there; the tables are new and empty.
CREATE INDEX IF NOT EXISTS idx_runs_script_slug_cover
  ON runs (script_slug) INCLUDE (id, parent_run_id, started_at, brand_ids)
  WHERE script_slug IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS outcome_chain_consumed (
  id bigserial PRIMARY KEY,
  from_outcome text NOT NULL,
  brand_ids text[] NOT NULL,
  consumed_units integer NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (from_outcome, brand_ids)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS outcome_chain_steps (
  id bigserial PRIMARY KEY,
  from_outcome text NOT NULL,
  to_outcome text NOT NULL,
  brand_ids text[] NOT NULL,
  led_units integer NOT NULL,
  led_units_by_performer jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (from_outcome, to_outcome, brand_ids)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS script_chain_reach (
  id bigserial PRIMARY KEY,
  script_slug text NOT NULL,
  day date NOT NULL,
  brand_ids text[] NOT NULL,
  produced_outcomes text[] NOT NULL,
  reached_outcomes text[] NOT NULL,
  runs integer NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (script_slug, day, brand_ids, produced_outcomes, reached_outcomes)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_outcome_chain_consumed_updated ON outcome_chain_consumed (updated_at, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_outcome_chain_steps_updated ON outcome_chain_steps (updated_at, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_script_chain_reach_updated ON script_chain_reach (updated_at, id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS outcome_chain_builds (
  built_at timestamptz PRIMARY KEY,
  duration_ms integer NOT NULL,
  changed_rows integer NOT NULL,
  consumed_rows integer NOT NULL,
  step_rows integer NOT NULL,
  reach_rows integer NOT NULL
);
--> statement-breakpoint
-- The two run attributes the build reads per Unit (brand set, workflow), kept so a build never re-reads
-- 500k runs (30-57 s on prod): new runs are added each build, the oldest-checked 50k re-read (brand transfer).
CREATE TABLE IF NOT EXISTS outcome_chain_run_attrs (
  run_id uuid PRIMARY KEY,
  brands text[] NOT NULL,
  workflow_slug text,
  checked_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_outcome_chain_run_attrs_checked ON outcome_chain_run_attrs (checked_at);
