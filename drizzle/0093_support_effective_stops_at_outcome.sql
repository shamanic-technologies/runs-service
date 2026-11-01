-- Cost-accounting doctrine (2026-11-01): a run that declares an outcome (produced or consumed: a lead
-- served, an email sent) is PRODUCTION, even under a support-marked root (a Copilot-launched
-- campaign). run_support_effective (0091) stops its cover above such a run unless it carries its own
-- mark. A run is created before it declares, so it inherited its parent's cover at insert: its first
-- declaration (or the removal of its last one) queues it, and the worker recomputes its subtree.
-- Only a covered run is queued on insert (one PK probe): uncovered runs, nearly all, cost nothing.
--
-- BOOT-WINDOW SAFE. One function, one trigger. No scan.

CREATE OR REPLACE FUNCTION run_support_outcome_enqueue() RETURNS trigger AS $$
DECLARE
  v_run uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_run := OLD.run_id;
  ELSE
    v_run := NEW.run_id;
    IF NOT EXISTS (SELECT 1 FROM run_support_effective WHERE run_id = v_run) THEN
      RETURN NULL;
    END IF;
  END IF;
  INSERT INTO run_support_propagation_queue (run_id, passes_left, due_at)
  VALUES (v_run, 2, now())
  ON CONFLICT (run_id) DO UPDATE SET passes_left = 2, due_at = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS run_support_outcome_enqueue ON run_outcomes;
--> statement-breakpoint

CREATE TRIGGER run_support_outcome_enqueue
  AFTER INSERT OR DELETE ON run_outcomes
  FOR EACH ROW EXECUTE FUNCTION run_support_outcome_enqueue();
