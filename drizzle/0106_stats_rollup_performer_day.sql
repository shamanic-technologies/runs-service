-- LEDGER-LOAD-1107-RUNS: GET /internal/stats/outcome-performers from a write-maintained rollup.
-- Live it joined every produced occurrence in the window (616k since inception) to its run (7M rows):
-- 24 s then a 500 (statement timeout) fleet-wide over 399 days on the loaded box, 2026-11-07.
-- One row per (UTC day of the ENTRY, outcome, the run's org / brands / campaign / feature / service /
-- task, effective performer): n = signed entries (+1 an occurrence on its declaration day, -1 its
-- reversal on the reversal day, LEDGER-REVERSAL-1107), quantity = signed quantity. ~24k rows in prod.
-- Brands stay an array (unnested at read, as the live read unnests the run's brands).
CREATE TABLE IF NOT EXISTS stats_rollup_performer_day (
  day date NOT NULL,
  outcome_key text NOT NULL,
  organization_id uuid,
  brand_ids text[],
  campaign_id text,
  feature_slug text,
  service_name text,
  task_name text,
  performer_kind text,
  performer_basis text,
  performer_workflow_slug text,
  performer_name text,
  n bigint NOT NULL DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 0,
  CONSTRAINT stats_rollup_performer_day_key UNIQUE NULLS NOT DISTINCT (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_stats_rollup_performer_day_day ON stats_rollup_performer_day (day);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_performer_day_on_outcome_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stats_rollup_performer_day AS t (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name, n, quantity)
  SELECT e.day, e.outcome_key, e.org, e.brands, e.camp, e.feat, e.svc, e.task,
         COALESCE(e.pk, CASE WHEN e.rwf IS NOT NULL THEN 'script' END),
         CASE WHEN e.pk IS NOT NULL THEN 'stated' WHEN e.rwf IS NOT NULL THEN 'run_workflow' END,
         CASE WHEN e.pk IS NOT NULL THEN e.pws ELSE e.rwf END,
         CASE WHEN e.pk IS NOT NULL THEN e.pn END,
         SUM(e.sign), SUM(e.sign * e.quantity)
  FROM (
    SELECT (o.declared_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, 1 AS sign
    FROM nt o JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
  ) e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  HAVING SUM(e.sign) <> 0 OR SUM(e.sign * e.quantity) <> 0
  ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  ON CONFLICT (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name) DO UPDATE SET n = t.n + EXCLUDED.n, quantity = t.quantity + EXCLUDED.quantity;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_performer_day_on_outcome_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stats_rollup_performer_day AS t (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name, n, quantity)
  SELECT e.day, e.outcome_key, e.org, e.brands, e.camp, e.feat, e.svc, e.task,
         COALESCE(e.pk, CASE WHEN e.rwf IS NOT NULL THEN 'script' END),
         CASE WHEN e.pk IS NOT NULL THEN 'stated' WHEN e.rwf IS NOT NULL THEN 'run_workflow' END,
         CASE WHEN e.pk IS NOT NULL THEN e.pws ELSE e.rwf END,
         CASE WHEN e.pk IS NOT NULL THEN e.pn END,
         SUM(e.sign), SUM(e.sign * e.quantity)
  FROM (
    SELECT (o.declared_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, -1 AS sign
    FROM ot o JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
    UNION ALL
    SELECT (o.declared_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, 1 AS sign
    FROM nt o JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
    UNION ALL
    SELECT (v.reversed_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, 1 AS sign
    FROM ot o JOIN run_outcome_reversals v ON v.occurrence_id = o.id JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
    UNION ALL
    SELECT (v.reversed_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, -1 AS sign
    FROM nt o JOIN run_outcome_reversals v ON v.occurrence_id = o.id JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
  ) e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  HAVING SUM(e.sign) <> 0 OR SUM(e.sign * e.quantity) <> 0
  ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  ON CONFLICT (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name) DO UPDATE SET n = t.n + EXCLUDED.n, quantity = t.quantity + EXCLUDED.quantity;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_performer_day_on_outcome_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stats_rollup_performer_day AS t (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name, n, quantity)
  SELECT e.day, e.outcome_key, e.org, e.brands, e.camp, e.feat, e.svc, e.task,
         COALESCE(e.pk, CASE WHEN e.rwf IS NOT NULL THEN 'script' END),
         CASE WHEN e.pk IS NOT NULL THEN 'stated' WHEN e.rwf IS NOT NULL THEN 'run_workflow' END,
         CASE WHEN e.pk IS NOT NULL THEN e.pws ELSE e.rwf END,
         CASE WHEN e.pk IS NOT NULL THEN e.pn END,
         SUM(e.sign), SUM(e.sign * e.quantity)
  FROM (
    SELECT (o.declared_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, -1 AS sign
    FROM ot o JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
  ) e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  HAVING SUM(e.sign) <> 0 OR SUM(e.sign * e.quantity) <> 0
  ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  ON CONFLICT (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name) DO UPDATE SET n = t.n + EXCLUDED.n, quantity = t.quantity + EXCLUDED.quantity;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_performer_day_on_outcome_delete_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.direction = 'produced' AND EXISTS (SELECT 1 FROM run_outcome_reversals WHERE occurrence_id = OLD.id) THEN
  INSERT INTO stats_rollup_performer_day AS t (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name, n, quantity)
  SELECT e.day, e.outcome_key, e.org, e.brands, e.camp, e.feat, e.svc, e.task,
         COALESCE(e.pk, CASE WHEN e.rwf IS NOT NULL THEN 'script' END),
         CASE WHEN e.pk IS NOT NULL THEN 'stated' WHEN e.rwf IS NOT NULL THEN 'run_workflow' END,
         CASE WHEN e.pk IS NOT NULL THEN e.pws ELSE e.rwf END,
         CASE WHEN e.pk IS NOT NULL THEN e.pn END,
         SUM(e.sign), SUM(e.sign * e.quantity)
  FROM (
    SELECT (v.reversed_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, 1 AS sign
    FROM (SELECT OLD.id, OLD.run_id, OLD.direction, OLD.outcome_key, OLD.quantity, OLD.performer_kind, OLD.performer_workflow_slug, OLD.performer_name) o JOIN run_outcome_reversals v ON v.occurrence_id = o.id JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
  ) e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  HAVING SUM(e.sign) <> 0 OR SUM(e.sign * e.quantity) <> 0
  ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  ON CONFLICT (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name) DO UPDATE SET n = t.n + EXCLUDED.n, quantity = t.quantity + EXCLUDED.quantity;
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_performer_day_on_reversal_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stats_rollup_performer_day AS t (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name, n, quantity)
  SELECT e.day, e.outcome_key, e.org, e.brands, e.camp, e.feat, e.svc, e.task,
         COALESCE(e.pk, CASE WHEN e.rwf IS NOT NULL THEN 'script' END),
         CASE WHEN e.pk IS NOT NULL THEN 'stated' WHEN e.rwf IS NOT NULL THEN 'run_workflow' END,
         CASE WHEN e.pk IS NOT NULL THEN e.pws ELSE e.rwf END,
         CASE WHEN e.pk IS NOT NULL THEN e.pn END,
         SUM(e.sign), SUM(e.sign * e.quantity)
  FROM (
    SELECT (v.reversed_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, -1 AS sign
    FROM nt v JOIN run_outcomes o ON o.id = v.occurrence_id JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
  ) e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  HAVING SUM(e.sign) <> 0 OR SUM(e.sign * e.quantity) <> 0
  ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  ON CONFLICT (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name) DO UPDATE SET n = t.n + EXCLUDED.n, quantity = t.quantity + EXCLUDED.quantity;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_performer_day_on_reversal_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stats_rollup_performer_day AS t (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name, n, quantity)
  SELECT e.day, e.outcome_key, e.org, e.brands, e.camp, e.feat, e.svc, e.task,
         COALESCE(e.pk, CASE WHEN e.rwf IS NOT NULL THEN 'script' END),
         CASE WHEN e.pk IS NOT NULL THEN 'stated' WHEN e.rwf IS NOT NULL THEN 'run_workflow' END,
         CASE WHEN e.pk IS NOT NULL THEN e.pws ELSE e.rwf END,
         CASE WHEN e.pk IS NOT NULL THEN e.pn END,
         SUM(e.sign), SUM(e.sign * e.quantity)
  FROM (
    SELECT (v.reversed_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, 1 AS sign
    FROM ot v JOIN run_outcomes o ON o.id = v.occurrence_id JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
  ) e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  HAVING SUM(e.sign) <> 0 OR SUM(e.sign * e.quantity) <> 0
  ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  ON CONFLICT (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name) DO UPDATE SET n = t.n + EXCLUDED.n, quantity = t.quantity + EXCLUDED.quantity;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_performer_day_on_reversal_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stats_rollup_performer_day AS t (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name, n, quantity)
  SELECT e.day, e.outcome_key, e.org, e.brands, e.camp, e.feat, e.svc, e.task,
         COALESCE(e.pk, CASE WHEN e.rwf IS NOT NULL THEN 'script' END),
         CASE WHEN e.pk IS NOT NULL THEN 'stated' WHEN e.rwf IS NOT NULL THEN 'run_workflow' END,
         CASE WHEN e.pk IS NOT NULL THEN e.pws ELSE e.rwf END,
         CASE WHEN e.pk IS NOT NULL THEN e.pn END,
         SUM(e.sign), SUM(e.sign * e.quantity)
  FROM (
    SELECT (v.reversed_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, 1 AS sign
    FROM ot v JOIN run_outcomes o ON o.id = v.occurrence_id JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
    UNION ALL
    SELECT (v.reversed_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, r.organization_id AS org, r.brand_ids AS brands, r.campaign_id AS camp,
           r.feature_slug AS feat, r.service_name AS svc, r.task_name AS task, r.workflow_slug AS rwf, -1 AS sign
    FROM nt v JOIN run_outcomes o ON o.id = v.occurrence_id JOIN runs r ON r.id = o.run_id
    WHERE o.direction = 'produced'
  ) e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  HAVING SUM(e.sign) <> 0 OR SUM(e.sign * e.quantity) <> 0
  ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  ON CONFLICT (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name) DO UPDATE SET n = t.n + EXCLUDED.n, quantity = t.quantity + EXCLUDED.quantity;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_performer_day_on_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stats_rollup_performer_day AS t (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name, n, quantity)
  SELECT e.day, e.outcome_key, e.org, e.brands, e.camp, e.feat, e.svc, e.task,
         COALESCE(e.pk, CASE WHEN e.rwf IS NOT NULL THEN 'script' END),
         CASE WHEN e.pk IS NOT NULL THEN 'stated' WHEN e.rwf IS NOT NULL THEN 'run_workflow' END,
         CASE WHEN e.pk IS NOT NULL THEN e.pws ELSE e.rwf END,
         CASE WHEN e.pk IS NOT NULL THEN e.pn END,
         SUM(e.sign), SUM(e.sign * e.quantity)
  FROM (
    SELECT (o.declared_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, ro.organization_id AS org, ro.brand_ids AS brands, ro.campaign_id AS camp,
           ro.feature_slug AS feat, ro.service_name AS svc, ro.task_name AS task, ro.workflow_slug AS rwf, -1 AS sign
    FROM run_outcomes o CROSS JOIN (SELECT OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.feature_slug, OLD.service_name, OLD.task_name, OLD.workflow_slug) ro 
    WHERE o.direction = 'produced' AND o.run_id = NEW.id
    UNION ALL
    SELECT (v.reversed_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, ro.organization_id AS org, ro.brand_ids AS brands, ro.campaign_id AS camp,
           ro.feature_slug AS feat, ro.service_name AS svc, ro.task_name AS task, ro.workflow_slug AS rwf, 1 AS sign
    FROM run_outcomes o JOIN run_outcome_reversals v ON v.occurrence_id = o.id CROSS JOIN (SELECT OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.feature_slug, OLD.service_name, OLD.task_name, OLD.workflow_slug) ro 
    WHERE o.direction = 'produced' AND o.run_id = NEW.id
    UNION ALL
    SELECT (o.declared_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, rn.organization_id AS org, rn.brand_ids AS brands, rn.campaign_id AS camp,
           rn.feature_slug AS feat, rn.service_name AS svc, rn.task_name AS task, rn.workflow_slug AS rwf, 1 AS sign
    FROM run_outcomes o CROSS JOIN (SELECT NEW.organization_id, NEW.brand_ids, NEW.campaign_id, NEW.feature_slug, NEW.service_name, NEW.task_name, NEW.workflow_slug) rn 
    WHERE o.direction = 'produced' AND o.run_id = NEW.id
    UNION ALL
    SELECT (v.reversed_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, rn.organization_id AS org, rn.brand_ids AS brands, rn.campaign_id AS camp,
           rn.feature_slug AS feat, rn.service_name AS svc, rn.task_name AS task, rn.workflow_slug AS rwf, -1 AS sign
    FROM run_outcomes o JOIN run_outcome_reversals v ON v.occurrence_id = o.id CROSS JOIN (SELECT NEW.organization_id, NEW.brand_ids, NEW.campaign_id, NEW.feature_slug, NEW.service_name, NEW.task_name, NEW.workflow_slug) rn 
    WHERE o.direction = 'produced' AND o.run_id = NEW.id
  ) e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  HAVING SUM(e.sign) <> 0 OR SUM(e.sign * e.quantity) <> 0
  ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  ON CONFLICT (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name) DO UPDATE SET n = t.n + EXCLUDED.n, quantity = t.quantity + EXCLUDED.quantity;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stats_rollup_performer_day_on_run_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stats_rollup_performer_day AS t (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name, n, quantity)
  SELECT e.day, e.outcome_key, e.org, e.brands, e.camp, e.feat, e.svc, e.task,
         COALESCE(e.pk, CASE WHEN e.rwf IS NOT NULL THEN 'script' END),
         CASE WHEN e.pk IS NOT NULL THEN 'stated' WHEN e.rwf IS NOT NULL THEN 'run_workflow' END,
         CASE WHEN e.pk IS NOT NULL THEN e.pws ELSE e.rwf END,
         CASE WHEN e.pk IS NOT NULL THEN e.pn END,
         SUM(e.sign), SUM(e.sign * e.quantity)
  FROM (
    SELECT (o.declared_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, ro.organization_id AS org, ro.brand_ids AS brands, ro.campaign_id AS camp,
           ro.feature_slug AS feat, ro.service_name AS svc, ro.task_name AS task, ro.workflow_slug AS rwf, -1 AS sign
    FROM run_outcomes o CROSS JOIN (SELECT OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.feature_slug, OLD.service_name, OLD.task_name, OLD.workflow_slug) ro 
    WHERE o.direction = 'produced' AND o.run_id = OLD.id
    UNION ALL
    SELECT (v.reversed_at AT TIME ZONE 'UTC')::date AS day, o.outcome_key, o.performer_kind AS pk, o.performer_workflow_slug AS pws,
           o.performer_name AS pn, o.quantity, ro.organization_id AS org, ro.brand_ids AS brands, ro.campaign_id AS camp,
           ro.feature_slug AS feat, ro.service_name AS svc, ro.task_name AS task, ro.workflow_slug AS rwf, 1 AS sign
    FROM run_outcomes o JOIN run_outcome_reversals v ON v.occurrence_id = o.id CROSS JOIN (SELECT OLD.organization_id, OLD.brand_ids, OLD.campaign_id, OLD.feature_slug, OLD.service_name, OLD.task_name, OLD.workflow_slug) ro 
    WHERE o.direction = 'produced' AND o.run_id = OLD.id
  ) e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  HAVING SUM(e.sign) <> 0 OR SUM(e.sign * e.quantity) <> 0
  ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
  ON CONFLICT (day, outcome_key, organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, performer_kind, performer_basis, performer_workflow_slug, performer_name) DO UPDATE SET n = t.n + EXCLUDED.n, quantity = t.quantity + EXCLUDED.quantity;
  RETURN OLD;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_performer_day_outcome_insert ON run_outcomes;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_performer_day_outcome_insert AFTER INSERT ON run_outcomes REFERENCING NEW TABLE AS nt FOR EACH STATEMENT EXECUTE FUNCTION stats_rollup_performer_day_on_outcome_insert();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_performer_day_outcome_update ON run_outcomes;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_performer_day_outcome_update AFTER UPDATE ON run_outcomes REFERENCING OLD TABLE AS ot NEW TABLE AS nt FOR EACH STATEMENT EXECUTE FUNCTION stats_rollup_performer_day_on_outcome_update();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_performer_day_outcome_delete ON run_outcomes;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_performer_day_outcome_delete AFTER DELETE ON run_outcomes REFERENCING OLD TABLE AS ot FOR EACH STATEMENT EXECUTE FUNCTION stats_rollup_performer_day_on_outcome_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_performer_day_outcome_delete_row ON run_outcomes;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_performer_day_outcome_delete_row BEFORE DELETE ON run_outcomes FOR EACH ROW EXECUTE FUNCTION stats_rollup_performer_day_on_outcome_delete_row();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_performer_day_reversal_insert ON run_outcome_reversals;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_performer_day_reversal_insert AFTER INSERT ON run_outcome_reversals REFERENCING NEW TABLE AS nt FOR EACH STATEMENT EXECUTE FUNCTION stats_rollup_performer_day_on_reversal_insert();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_performer_day_reversal_delete ON run_outcome_reversals;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_performer_day_reversal_delete AFTER DELETE ON run_outcome_reversals REFERENCING OLD TABLE AS ot FOR EACH STATEMENT EXECUTE FUNCTION stats_rollup_performer_day_on_reversal_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_performer_day_reversal_update ON run_outcome_reversals;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_performer_day_reversal_update AFTER UPDATE ON run_outcome_reversals REFERENCING OLD TABLE AS ot NEW TABLE AS nt FOR EACH STATEMENT EXECUTE FUNCTION stats_rollup_performer_day_on_reversal_update();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_performer_day_run_update ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_performer_day_run_update AFTER UPDATE OF organization_id, brand_ids, campaign_id, feature_slug, service_name, task_name, workflow_slug ON runs FOR EACH ROW WHEN (OLD.organization_id IS DISTINCT FROM NEW.organization_id OR OLD.brand_ids IS DISTINCT FROM NEW.brand_ids OR OLD.campaign_id IS DISTINCT FROM NEW.campaign_id OR OLD.feature_slug IS DISTINCT FROM NEW.feature_slug OR OLD.service_name IS DISTINCT FROM NEW.service_name OR OLD.task_name IS DISTINCT FROM NEW.task_name OR OLD.workflow_slug IS DISTINCT FROM NEW.workflow_slug) EXECUTE FUNCTION stats_rollup_performer_day_on_run_update();
--> statement-breakpoint
DROP TRIGGER IF EXISTS stats_rollup_performer_day_run_delete ON runs;
--> statement-breakpoint
CREATE TRIGGER stats_rollup_performer_day_run_delete BEFORE DELETE ON runs FOR EACH ROW EXECUTE FUNCTION stats_rollup_performer_day_on_run_delete();
--> statement-breakpoint
-- A fresh database (no occurrence yet) is exact from here on; an existing one is stamped by
-- scripts/rebuild-stats-rollup.ts performer_day after the deploy (reads stay live until then).
INSERT INTO stats_rollups (name, ready_at)
SELECT 'performer_day', now()
WHERE NOT EXISTS (SELECT 1 FROM run_outcomes)
ON CONFLICT (name) DO NOTHING;
--> statement-breakpoint
-- The ledger read of ONE campaign (features-service asks ~300 campaigns a few times a minute) filtered every stored
-- row of the range; built CONCURRENTLY out-of-band on prod first (no-op there).
CREATE INDEX IF NOT EXISTS idx_outcome_cost_days_campaign ON outcome_cost_days (allocation_version, campaign_id, day);
