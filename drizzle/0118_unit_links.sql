-- UNIT-LINK-BRONZE-1117. The ledger STORES which Unit a Unit came from, instead of leaving every consumer to
-- re-derive it. One row per edge X -> Y of the produce / consume graph (services/outcome-chains.ts: the
-- consumption's resolved Unit X, and each Unit Y the consuming run's anchor produced for the same canonical
-- subject), with both Units' dates, runs, brand sets and the campaign(s) each one carries: its own run's
-- campaign, else the campaigns of the nearest Units it came from that have one (any depth).
--
-- Written by the outcome chains build (every ~15 min, the same statement that counts the edges): a new or
-- moved row takes the next change_id, a row the build no longer produces is stamped removed_at (never
-- deleted), so GET /internal/stats/outcome-chains/unit-links serves every change by cursor.
--
-- BOOT-WINDOW SAFE: new, empty tables only. No statement touches an existing table.
CREATE SEQUENCE IF NOT EXISTS unit_links_change_seq;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS unit_links (
  from_unit_id uuid NOT NULL,
  to_unit_id uuid NOT NULL,
  from_outcome text NOT NULL,
  to_outcome text NOT NULL,
  from_at timestamptz NOT NULL,
  to_at timestamptz NOT NULL,
  from_run_id uuid NOT NULL,
  to_run_id uuid NOT NULL,
  subject_service text NOT NULL,
  subject_id text NOT NULL,
  from_campaign_id text,
  to_campaign_id text,
  from_campaign_ids text[] NOT NULL,
  to_campaign_ids text[] NOT NULL,
  from_brand_ids text[] NOT NULL,
  to_brand_ids text[] NOT NULL,
  first_linked_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  change_id bigint NOT NULL,
  PRIMARY KEY (from_unit_id, to_unit_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_links_change ON unit_links (change_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_unit_links_to ON unit_links (to_unit_id);
--> statement-breakpoint
-- The campaign of each run holding an occurrence, read off runs ONCE (a run's campaign is set at creation),
-- so a build never re-reads 500k runs. Filled before each build, 50k runs per statement.
CREATE TABLE IF NOT EXISTS outcome_chain_run_campaigns (
  run_id uuid PRIMARY KEY,
  campaign_id text
);
