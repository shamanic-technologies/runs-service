-- Historical rename, made replayable. Migration 0005 was edited after the fact to
-- add the column under its post-rename name (`cost_source`), so on a database built
-- from zero there is no `cost_bearer` to rename and the bare ALTER aborted the whole
-- chain. Production applied this when the old column still existed; the guard makes
-- both paths work. See CLAUDE.md "CI runs against an empty Postgres container".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'runs_costs' AND column_name = 'cost_bearer'
  ) THEN
    ALTER TABLE "runs_costs" RENAME COLUMN "cost_bearer" TO "cost_source";
  END IF;
END $$;
