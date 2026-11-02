-- BOX-DISK-1101: archive bronze lifecycle events older than 90 days to R2.
-- Owner decision 2026-11-02: history moves to Cloudflare R2 (gzip NDJSON),
-- verified, then deleted from Postgres. src/services/lifecycle-archive.ts.
--
-- ADDITIVE: two small tables + run_origin_org() reading the archived origin first.
-- The occurred_at indexes the job needs are created CONCURRENTLY by the job itself
-- (never here: a plain CREATE INDEX on the 11 GB run_lifecycle_events would block
-- every run write for minutes inside the boot migration, before listen()).

-- One row per uploaded + verified R2 object. Its bytes column makes the archive's
-- size a SUM; deleted_at NULL = uploaded and verified but the rows not yet deleted
-- (a deploy killed the job mid-delete): the next tick finishes the delete from
-- the object's own ids.
CREATE TABLE IF NOT EXISTS "lifecycle_archive_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_table" text NOT NULL,
  "object_key" text NOT NULL,
  "day" date NOT NULL,
  "part" integer NOT NULL,
  "rows" integer NOT NULL,
  "bytes" bigint NOT NULL,
  "sha256" text NOT NULL,
  "archived_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone,
  CONSTRAINT "lifecycle_archive_objects_key" UNIQUE ("object_key"),
  CONSTRAINT "lifecycle_archive_objects_part" UNIQUE ("source_table", "day", "part")
);--> statement-breakpoint

-- run_origin_org() (migration 0056) reads the run's FIRST run.created event to find
-- the org a run was opened under. stats_rollup_no_campaign_day_on_cost calls it on
-- every UPDATE/DELETE of a platform-projected cost (a hold materialized late, a
-- refund): once that event is archived the answer would turn NULL and the -1 would
-- land in another bucket than the +1. The job copies the archived run.created
-- origin here (earliest event wins) BEFORE deleting it, so the answer never moves.
CREATE TABLE IF NOT EXISTS "lifecycle_archived_run_origins" (
  "run_id" uuid PRIMARY KEY,
  "organization_id" uuid,
  "occurred_at" timestamp with time zone NOT NULL
);--> statement-breakpoint

-- Archived origin first: every archived event is OLDER than every event still in
-- bronze, so an archived run.created is the earliest one. Else bronze, as before.
CREATE OR REPLACE FUNCTION run_origin_org(p_run_id uuid) RETURNS uuid AS $$
  SELECT x.org FROM (
    SELECT 1 AS src, o.organization_id AS org
      FROM lifecycle_archived_run_origins o
     WHERE o.run_id = p_run_id
    UNION ALL
    (SELECT 2 AS src, (payload->>'organizationId')::uuid AS org
       FROM run_lifecycle_events
      WHERE run_id = p_run_id AND event_type = 'run.created'
      ORDER BY occurred_at
      LIMIT 1)
  ) x
  ORDER BY x.src
  LIMIT 1
$$ LANGUAGE sql STABLE;
