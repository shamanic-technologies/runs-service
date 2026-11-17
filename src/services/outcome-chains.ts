// The produce / consume graph summarised for features-service's script Rating
// (SCRIPT-VALUE-RATING-1113-RUNS, owner 2026-11-13: a script run is credited with the
// strongest outcome its chain reached; the value of each outcome flows down step by
// step through the measured one-step rate between two outcomes). runs-service serves
// COUNTS only: no value, no ranking, no outcome named in code.
//
// THE GRAPH. An EDGE X -> Y links two standing (never reversed) Units:
//   - a consumption c of key k on subject s resolves to the Unit X the ledger says it
//     consumed (resolveConsumptions' rule: same key, same canonical subject incl.
//     stated equivalences; latest declared at or before c, else the earliest later
//     one, among those declared before the end of c's UTC day; id breaks ties);
//   - Y = every Unit the consuming run's ANCHOR (itself, else its nearest ancestor
//     that produced; a support mark stops the walk) produced for the SAME canonical
//     subject, Y != X. A per-org-day reply judge consuming 1,000 sends and producing
//     2 positive replies links each reply to its own lead's send only.
//
// ONE-STEP RATES (outcome_chain_consumed + outcome_chain_steps): per X key and the
// X run's brand set, the distinct X Units consumed at all; per (X key, Y key, brand
// set) the distinct X Units with an edge to a Y Unit, split by Y's effective performer
// kind (stated, else `script` when its run carries a workflow, else `none`: another
// factory's Units told apart the way the performer read does). A brand set = the X
// run's brand_ids, sorted and deduped ('{}' = none): every Unit sits in exactly one
// row, so fleet = sum of every row and brand B = sum of rows whose set holds B.
//
// CHAIN REACH (script_chain_reach): a script DECISION = a run naming a script whose
// parent does not name the same one (the run that opened it; children inherit). Its
// own Units = standing Units produced on it and on descendants working for the same
// script. Reached = every Unit the edges lead to from those, to any depth (the walk
// dedups per decision, so a cycle ends). Per (script, decision's UTC start day, its
// brand set, sorted produced keys, sorted reached keys not among its own Units): runs.
//
// BUILD: one read-only statement over the whole fleet (prod 2026-11-13: ~1.3M
// occurrences, 640k consumptions, 540k edges, 186k decisions), then a diff write:
// a row whose figures moved (or a new one) is stamped with the build instant, a row
// the build no longer produces is zeroed and stamped; nothing is deleted, so a
// consumer copying rows stamped after its cursor sees every change.

import { sql, type SQL } from "drizzle-orm";
import { db, statsDb } from "../db/index.js";

export const OUTCOME_CHAIN_TABLES = ["consumed", "steps", "reach"] as const;
export type OutcomeChainTable = (typeof OUTCOME_CHAIN_TABLES)[number];

const FIRST_TICK_MS = 90_000;
const TICK_GAP_MS = 15 * 60_000;
const BUILD_TIMEOUT = "900s";

/** The whole-fleet build: one row per result row, tagged by table. */
export const OUTCOME_CHAIN_BUILD_SQL: SQL = sql.raw(`
WITH RECURSIVE
occ AS MATERIALIZED (
  SELECT o.id, o.run_id, o.direction, o.outcome_key, o.declared_at, o.performer_kind,
         hashtextextended(COALESCE(e.target_service, o.subject_service) || chr(1) || COALESCE(e.target_id, o.subject_id), 0) AS sh,
         COALESCE(e.target_service, o.subject_service) AS cs, COALESCE(e.target_id, o.subject_id) AS cid
  FROM run_outcomes o
  LEFT JOIN subject_equivalences e ON e.subject_service = o.subject_service AND e.subject_id = o.subject_id
),
rev AS MATERIALIZED (SELECT occurrence_id AS id FROM run_outcome_reversals),
res AS MATERIALIZED (
  SELECT DISTINCT ON (c.id) c.id AS consumption_id, c.run_id AS consuming_run_id, c.sh, c.cs, c.cid,
         p.id AS x_id, p.run_id AS x_run_id, p.outcome_key AS x_key, p.declared_at AS x_at
  FROM occ c
  JOIN occ p ON p.direction = 'produced' AND p.sh = c.sh AND p.outcome_key = c.outcome_key AND p.cs = c.cs AND p.cid = c.cid
   AND p.declared_at < (date_trunc('day', c.declared_at AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC'
  WHERE c.direction = 'consumed'
  ORDER BY c.id, (p.declared_at <= c.declared_at) DESC,
           CASE WHEN p.declared_at <= c.declared_at THEN -extract(epoch FROM p.declared_at) ELSE extract(epoch FROM p.declared_at) END,
           p.id
),
prun AS MATERIALIZED (SELECT DISTINCT run_id FROM occ WHERE direction = 'produced'),
crun AS MATERIALIZED (SELECT DISTINCT consuming_run_id AS id FROM res),
selfa AS MATERIALIZED (SELECT c.id FROM crun c JOIN prun p ON p.run_id = c.id),
walk(start_id, cur_id, parent_id, depth, stop) AS (
  SELECT r.id, r.id, r.parent_run_id, 0, EXISTS (SELECT 1 FROM run_support_marks m WHERE m.run_id = r.id)
  FROM (SELECT id FROM crun EXCEPT SELECT id FROM selfa) s
  CROSS JOIN LATERAL (SELECT id, parent_run_id FROM runs WHERE id = s.id OFFSET 0) r
  UNION ALL
  SELECT w.start_id, p.id, p.parent_run_id, w.depth + 1,
         (EXISTS (SELECT 1 FROM run_outcomes o WHERE o.run_id = p.id AND o.direction = 'produced')
          OR EXISTS (SELECT 1 FROM run_support_marks m WHERE m.run_id = p.id))
  FROM walk w
  CROSS JOIN LATERAL (SELECT id, parent_run_id FROM runs WHERE id = w.parent_id OFFSET 0) p
  WHERE NOT w.stop AND w.parent_id IS NOT NULL AND w.depth < 50
),
anchor AS MATERIALIZED (
  SELECT id AS start_id, id AS cur_id FROM selfa
  UNION ALL
  SELECT start_id, cur_id FROM walk
  WHERE depth > 0 AND stop AND EXISTS (SELECT 1 FROM run_outcomes o WHERE o.run_id = walk.cur_id AND o.direction = 'produced')
),
edges AS MATERIALIZED (
  SELECT DISTINCT r.x_id, r.x_key, r.x_run_id, y.id AS y_id, y.outcome_key AS y_key, y.run_id AS y_run_id, y.performer_kind AS y_pk,
         r.x_at, y.declared_at AS y_at, r.cs, r.cid
  FROM res r
  JOIN anchor a ON a.start_id = r.consuming_run_id
  JOIN occ y ON y.run_id = a.cur_id AND y.direction = 'produced' AND y.sh = r.sh AND y.cs = r.cs AND y.cid = r.cid
  LEFT JOIN rev rx ON rx.id = r.x_id
  LEFT JOIN rev ry ON ry.id = y.id
  WHERE y.id <> r.x_id AND rx.id IS NULL AND ry.id IS NULL
),
xids AS MATERIALIZED (SELECT x_run_id AS id FROM res UNION SELECT y_run_id FROM edges),
xruns AS MATERIALIZED (
  -- Kept attributes (refreshRunAttrs), else the run itself for a run declared since.
  SELECT i.id, COALESCE(a.brands, p.brands) AS brands, CASE WHEN a.run_id IS NOT NULL THEN a.workflow_slug ELSE p.workflow_slug END AS workflow_slug
  FROM xids i
  LEFT JOIN outcome_chain_run_attrs a ON a.run_id = i.id
  LEFT JOIN LATERAL (
    SELECT COALESCE(ARRAY(SELECT DISTINCT b FROM unnest(r.brand_ids) b WHERE b IS NOT NULL ORDER BY b), '{}') AS brands, r.workflow_slug
    FROM runs r WHERE r.id = i.id AND a.run_id IS NULL OFFSET 0
  ) p ON TRUE
),
consumed AS (
  SELECT r.x_key, xr.brands, count(DISTINCT r.x_id)::int AS n
  FROM res r JOIN xruns xr ON xr.id = r.x_run_id LEFT JOIN rev rx ON rx.id = r.x_id
  WHERE rx.id IS NULL
  GROUP BY 1, 2
),
edge_kind AS MATERIALIZED (
  SELECT e.x_id, e.x_key, e.y_key, xr.brands,
         COALESCE(e.y_pk, CASE WHEN yr.workflow_slug IS NOT NULL THEN 'script' END, 'none') AS kind
  FROM edges e JOIN xruns xr ON xr.id = e.x_run_id JOIN xruns yr ON yr.id = e.y_run_id
),
steps_total AS MATERIALIZED (SELECT x_key, y_key, brands, count(DISTINCT x_id)::int AS n FROM edge_kind GROUP BY 1, 2, 3),
steps_kind AS MATERIALIZED (
  SELECT x_key, y_key, brands, jsonb_object_agg(kind, n ORDER BY kind) AS by_kind
  FROM (SELECT x_key, y_key, brands, kind, count(DISTINCT x_id)::int AS n FROM edge_kind GROUP BY 1, 2, 3, 4) k
  GROUP BY 1, 2, 3
),
-- A decision's script = the innermost one stated (SERVED-MODEL-1116-NESTED-RUNS, 0116): a script asked by another one is
-- its own decision. decision_script_slug is set only where script_slug is (idx_runs_decision_script_cover).
sr AS MATERIALIZED (SELECT id, parent_run_id, COALESCE(decision_script_slug, script_slug) AS script_slug, started_at, brand_ids FROM runs WHERE script_slug IS NOT NULL),
link AS MATERIALIZED (SELECT c.id, p.id AS pid FROM sr c JOIN sr p ON p.id = c.parent_run_id AND p.script_slug = c.script_slug),
roots AS MATERIALIZED (SELECT s.* FROM sr s LEFT JOIN link l ON l.id = s.id WHERE l.id IS NULL),
dec(run_id, decision_id, depth) AS (
  SELECT id, id, 0 FROM roots
  UNION ALL
  SELECT l.id, d.decision_id, d.depth + 1 FROM dec d JOIN link l ON l.pid = d.run_id WHERE d.depth < 50
),
own AS MATERIALIZED (
  SELECT d.decision_id, o.id AS occ_id, o.outcome_key
  FROM dec d JOIN occ o ON o.run_id = d.run_id AND o.direction = 'produced'
  LEFT JOIN rev rv ON rv.id = o.id
  WHERE rv.id IS NULL
),
ereach(decision_id, occ_id) AS (
  SELECT decision_id, occ_id FROM own
  UNION
  SELECT r.decision_id, e.y_id FROM ereach r JOIN edges e ON e.x_id = r.occ_id
),
own_keys AS (SELECT decision_id, array_agg(DISTINCT outcome_key ORDER BY outcome_key) AS keys FROM own GROUP BY 1),
reached AS (
  SELECT r.decision_id, array_agg(DISTINCT o.outcome_key ORDER BY o.outcome_key) AS keys
  FROM ereach r
  JOIN occ o ON o.id = r.occ_id
  LEFT JOIN own w ON w.decision_id = r.decision_id AND w.occ_id = r.occ_id
  WHERE w.occ_id IS NULL
  GROUP BY 1
),
-- What a decision cost: its run's subtree (run_subtree_costs, 0086), minus the subtrees of the script decisions
-- opened under its own runs (a nested script is its own decision and pays its own way). Incurred = actual + provisioned.
nested_cost AS (
  SELECT d.decision_id, sum(c.gross_actual + c.gross_provisioned) AS gross, sum(c.net_actual + c.net_provisioned) AS net
  FROM roots r JOIN dec d ON d.run_id = r.parent_run_id JOIN run_subtree_costs c ON c.run_id = r.id
  GROUP BY 1
),
-- SERVED-MODEL-1116: the priced items (cost names) a decision billed on its own work = the ACTUAL rows of its run's
-- subtree (run_subtree_cost_items, 0092) minus the subtrees of the script decisions opened under its own runs, a
-- name kept while its row count stays > 0. Fenced per-run probes on the items' primary key.
nested_roots AS MATERIALIZED (SELECT d.decision_id, r.id FROM roots r JOIN dec d ON d.run_id = r.parent_run_id),
name_n AS (
  SELECT s.id AS decision_id, i.cost_name, i.n
  FROM roots s CROSS JOIN LATERAL (SELECT cost_name, sum(n) AS n FROM run_subtree_cost_items WHERE run_id = s.id GROUP BY 1 OFFSET 0) i
  UNION ALL
  SELECT nr.decision_id, i.cost_name, -i.n
  FROM nested_roots nr CROSS JOIN LATERAL (SELECT cost_name, sum(n) AS n FROM run_subtree_cost_items WHERE run_id = nr.id GROUP BY 1 OFFSET 0) i
),
own_names AS MATERIALIZED (
  SELECT decision_id, array_agg(cost_name ORDER BY cost_name) AS names
  FROM (SELECT decision_id, cost_name FROM name_n GROUP BY 1, 2 HAVING sum(n) > 0) z
  GROUP BY 1
),
-- The OTHER script decisions whose standing Units this decision's runs consumed (one hop: the writing behind a send),
-- and the names they billed on their own work.
src_dec AS MATERIALIZED (
  SELECT DISTINCT d2.decision_id, w.decision_id AS src_id
  FROM res r JOIN dec d2 ON d2.run_id = r.consuming_run_id JOIN own w ON w.occ_id = r.x_id
  WHERE w.decision_id <> d2.decision_id
),
src_names AS MATERIALIZED (
  SELECT s.decision_id, array_agg(DISTINCT n ORDER BY n) AS names
  FROM src_dec s JOIN own_names o ON o.decision_id = s.src_id CROSS JOIN LATERAL unnest(o.names) n
  GROUP BY 1
),
reach AS (
  SELECT s.id, s.script_slug, COALESCE(onm.names, '{}') AS cost_names, COALESCE(snm.names, '{}') AS source_cost_names, to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
         COALESCE(ARRAY(SELECT DISTINCT b FROM unnest(s.brand_ids) b WHERE b IS NOT NULL ORDER BY b), '{}') AS brands,
         COALESCE(ok.keys, '{}') AS produced, COALESCE(rc.keys, '{}') AS reached,
         COALESCE(c.gross_actual + c.gross_provisioned, 0) - COALESCE(n.gross, 0) AS cost,
         COALESCE(c.net_actual + c.net_provisioned, 0) - COALESCE(n.net, 0) AS net_cost,
         CASE WHEN k.decision_run_id IS NOT NULL THEN k.campaign_id ELSE p.campaign_id END AS campaign_id,
         pa.script_slug AS asked_by
  FROM roots s
  LEFT JOIN own_keys ok ON ok.decision_id = s.id
  LEFT JOIN reached rc ON rc.decision_id = s.id
  LEFT JOIN run_subtree_costs c ON c.run_id = s.id
  LEFT JOIN nested_cost n ON n.decision_id = s.id
  LEFT JOIN own_names onm ON onm.decision_id = s.id
  LEFT JOIN src_names snm ON snm.decision_id = s.id
  -- ONE-WRITER-N-MODELS-1116: the script that ASKED this decision = the script of the decision holding its root's parent
  -- run (a writer asked by a sender, a model asked by a writer). NULL = no script's run opened it (a campaign's own).
  LEFT JOIN dec pd ON pd.run_id = s.parent_run_id
  LEFT JOIN sr pa ON pa.id = pd.decision_id
  -- A run's campaign is set once at creation: read off runs once per decision (PK probe), then kept.
  LEFT JOIN script_chain_decisions k ON k.decision_run_id = s.id AND k.campaign_read
  LEFT JOIN LATERAL (SELECT r.campaign_id FROM runs r WHERE r.id = s.id AND k.decision_run_id IS NULL OFFSET 0) p ON TRUE
),
-- UNIT-LINK-BRONZE-1117: every edge is handed to the caller's transaction (temp table unit_link_edges, created by
-- buildOutcomeChains before this statement), which stores it as a link (storeUnitLinks). Kept out of this statement
-- on purpose: the planner estimates the edges at 1 row (prod: ~540k), and joins planned on that never end.
ul_ins AS (
  INSERT INTO unit_link_edges (x_id, y_id, x_key, y_key, x_at, y_at, x_run_id, y_run_id, cs, cid)
  SELECT x_id, y_id, x_key, y_key, x_at, y_at, x_run_id, y_run_id, cs, cid FROM edges
)
SELECT 'consumed' AS t, jsonb_build_object('from_outcome', x_key, 'brand_ids', to_jsonb(brands), 'consumed_units', n) AS r FROM consumed
UNION ALL
SELECT 'steps', jsonb_build_object('from_outcome', t.x_key, 'to_outcome', t.y_key, 'brand_ids', to_jsonb(t.brands), 'led_units', t.n, 'led_units_by_performer', k.by_kind)
FROM steps_total t JOIN steps_kind k ON k.x_key = t.x_key AND k.y_key = t.y_key AND k.brands = t.brands
UNION ALL
SELECT 'decision', jsonb_build_object('decision_run_id', id, 'script_slug', script_slug, 'day', day, 'brand_ids', to_jsonb(brands),
                                      'produced_outcomes', to_jsonb(produced), 'reached_outcomes', to_jsonb(reached),
                                      'cost', cost::text, 'net_cost', net_cost::text, 'campaign_id', campaign_id,
                                      'cost_names', to_jsonb(cost_names), 'source_cost_names', to_jsonb(source_cost_names),
                                      'asked_by_script_slug', asked_by)
FROM reach
`);

export interface OutcomeChainBuild {
  builtAt: string;
  durationMs: number;
  changedRows: number;
  consumedRows: number;
  stepRows: number;
  reachRows: number;
  /** UNIT-LINK-BRONZE-1117, set by a build only (not stored): links standing, written (new or moved) and removed by it. */
  unitLinks?: number;
  unitLinksWritten?: number;
  unitLinksRemoved?: number;
}

/** Upsert the build's rows (stamp only what moved), zero the rows it no longer produces. */
async function writeTable(tx: any, table: OutcomeChainTable, rows: unknown[], stamp: string): Promise<number> {
  const json = JSON.stringify(rows);
  const q =
    table === "consumed"
      ? sql`
    WITH n AS (SELECT * FROM jsonb_to_recordset(${json}::jsonb) AS x(from_outcome text, brand_ids text[], consumed_units int)),
    up AS (
      INSERT INTO outcome_chain_consumed (from_outcome, brand_ids, consumed_units, updated_at)
      SELECT from_outcome, brand_ids, consumed_units, ${stamp}::timestamptz FROM n
      ON CONFLICT (from_outcome, brand_ids) DO UPDATE SET consumed_units = EXCLUDED.consumed_units, updated_at = EXCLUDED.updated_at
      WHERE outcome_chain_consumed.consumed_units IS DISTINCT FROM EXCLUDED.consumed_units
      RETURNING 1
    ),
    gone AS (
      UPDATE outcome_chain_consumed t SET consumed_units = 0, updated_at = ${stamp}::timestamptz
      WHERE t.consumed_units <> 0 AND NOT EXISTS (SELECT 1 FROM n WHERE n.from_outcome = t.from_outcome AND n.brand_ids = t.brand_ids)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM up) + (SELECT count(*) FROM gone) AS changed`
      : table === "steps"
        ? sql`
    WITH n AS (SELECT * FROM jsonb_to_recordset(${json}::jsonb) AS x(from_outcome text, to_outcome text, brand_ids text[], led_units int, led_units_by_performer jsonb)),
    up AS (
      INSERT INTO outcome_chain_steps (from_outcome, to_outcome, brand_ids, led_units, led_units_by_performer, updated_at)
      SELECT from_outcome, to_outcome, brand_ids, led_units, led_units_by_performer, ${stamp}::timestamptz FROM n
      ON CONFLICT (from_outcome, to_outcome, brand_ids) DO UPDATE
        SET led_units = EXCLUDED.led_units, led_units_by_performer = EXCLUDED.led_units_by_performer, updated_at = EXCLUDED.updated_at
      WHERE (outcome_chain_steps.led_units, outcome_chain_steps.led_units_by_performer) IS DISTINCT FROM (EXCLUDED.led_units, EXCLUDED.led_units_by_performer)
      RETURNING 1
    ),
    gone AS (
      UPDATE outcome_chain_steps t SET led_units = 0, led_units_by_performer = '{}'::jsonb, updated_at = ${stamp}::timestamptz
      WHERE t.led_units <> 0
        AND NOT EXISTS (SELECT 1 FROM n WHERE n.from_outcome = t.from_outcome AND n.to_outcome = t.to_outcome AND n.brand_ids = t.brand_ids)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM up) + (SELECT count(*) FROM gone) AS changed`
        : sql`
    -- Grouped from the decisions this build just wrote (writeDecisions), never from the payload.
    WITH n AS MATERIALIZED (
      SELECT script_slug, day, brand_ids, produced_outcomes, reached_outcomes, count(*)::int AS runs,
             sum(cost_in_usd_cents) AS cost, sum(net_cost_in_usd_cents) AS net_cost
      FROM script_chain_decisions GROUP BY 1, 2, 3, 4, 5
    ),
    up AS (
      INSERT INTO script_chain_reach (script_slug, day, brand_ids, produced_outcomes, reached_outcomes, runs, cost_in_usd_cents, net_cost_in_usd_cents, updated_at)
      SELECT script_slug, day, brand_ids, produced_outcomes, reached_outcomes, runs, cost, net_cost, ${stamp}::timestamptz FROM n
      ON CONFLICT (script_slug, day, brand_ids, produced_outcomes, reached_outcomes) DO UPDATE
        SET runs = EXCLUDED.runs, cost_in_usd_cents = EXCLUDED.cost_in_usd_cents, net_cost_in_usd_cents = EXCLUDED.net_cost_in_usd_cents,
            updated_at = EXCLUDED.updated_at
      WHERE (script_chain_reach.runs, script_chain_reach.cost_in_usd_cents, script_chain_reach.net_cost_in_usd_cents)
            IS DISTINCT FROM (EXCLUDED.runs, EXCLUDED.cost_in_usd_cents, EXCLUDED.net_cost_in_usd_cents)
      RETURNING 1
    ),
    gone AS (
      UPDATE script_chain_reach t SET runs = 0, cost_in_usd_cents = 0, net_cost_in_usd_cents = 0, updated_at = ${stamp}::timestamptz
      WHERE (t.runs <> 0 OR t.cost_in_usd_cents <> 0 OR t.net_cost_in_usd_cents <> 0)
        AND NOT EXISTS (SELECT 1 FROM n WHERE n.script_slug = t.script_slug AND n.day = t.day AND n.brand_ids = t.brand_ids
                                          AND n.produced_outcomes = t.produced_outcomes AND n.reached_outcomes = t.reached_outcomes)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM up) + (SELECT count(*) FROM gone) AS changed`;
  const [r] = (await tx.execute(q)) as Array<{ changed: string | number }>;
  return Number(r.changed);
}

/** Every decision's row key + cost (script_chain_decisions): upsert what moved, delete what no build produces. */
async function writeDecisions(tx: any, rows: unknown[], stamp: string): Promise<void> {
  await tx.execute(sql`
    WITH n AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS x(decision_run_id uuid, script_slug text, day date, brand_ids text[], produced_outcomes text[], reached_outcomes text[], cost numeric, net_cost numeric,
             campaign_id text, cost_names text[], source_cost_names text[], asked_by_script_slug text)
    ),
    up AS (
      INSERT INTO script_chain_decisions (decision_run_id, script_slug, day, brand_ids, produced_outcomes, reached_outcomes, cost_in_usd_cents, net_cost_in_usd_cents,
                                          campaign_id, campaign_read, cost_names, source_cost_names, asked_by_script_slug, updated_at)
      SELECT decision_run_id, script_slug, day, brand_ids, produced_outcomes, reached_outcomes, cost, net_cost, campaign_id, true, cost_names, source_cost_names,
             asked_by_script_slug, ${stamp}::timestamptz FROM n
      ON CONFLICT (decision_run_id) DO UPDATE
        SET script_slug = EXCLUDED.script_slug, day = EXCLUDED.day, brand_ids = EXCLUDED.brand_ids, produced_outcomes = EXCLUDED.produced_outcomes,
            reached_outcomes = EXCLUDED.reached_outcomes, cost_in_usd_cents = EXCLUDED.cost_in_usd_cents,
            net_cost_in_usd_cents = EXCLUDED.net_cost_in_usd_cents, campaign_id = EXCLUDED.campaign_id, campaign_read = true,
            cost_names = EXCLUDED.cost_names, source_cost_names = EXCLUDED.source_cost_names, asked_by_script_slug = EXCLUDED.asked_by_script_slug,
            updated_at = EXCLUDED.updated_at
      WHERE (script_chain_decisions.script_slug, script_chain_decisions.day, script_chain_decisions.brand_ids, script_chain_decisions.produced_outcomes,
             script_chain_decisions.reached_outcomes, script_chain_decisions.cost_in_usd_cents, script_chain_decisions.net_cost_in_usd_cents,
             script_chain_decisions.campaign_id, script_chain_decisions.campaign_read, script_chain_decisions.cost_names, script_chain_decisions.source_cost_names,
             script_chain_decisions.asked_by_script_slug)
            IS DISTINCT FROM (EXCLUDED.script_slug, EXCLUDED.day, EXCLUDED.brand_ids, EXCLUDED.produced_outcomes, EXCLUDED.reached_outcomes,
                              EXCLUDED.cost_in_usd_cents, EXCLUDED.net_cost_in_usd_cents, EXCLUDED.campaign_id, true, EXCLUDED.cost_names, EXCLUDED.source_cost_names,
                              EXCLUDED.asked_by_script_slug)
      RETURNING 1
    ),
    gone AS (DELETE FROM script_chain_decisions t WHERE NOT EXISTS (SELECT 1 FROM n WHERE n.decision_run_id = t.decision_run_id) RETURNING 1)
    SELECT (SELECT count(*) FROM up) + (SELECT count(*) FROM gone) AS changed`);
}

const RUN_ATTRS_RECHECK = 50_000;

/**
 * Keeps outcome_chain_run_attrs complete for every run holding an occurrence (new
 * ones read once), and re-reads the oldest-checked RUN_ATTRS_RECHECK (a brand
 * transfer rewrites brand_ids: every row is re-read every ~11 builds). A row whose
 * run is gone is dropped.
 */
async function refreshRunAttrs(): Promise<void> {
  await db.execute(sql`
    WITH due AS MATERIALIZED (SELECT run_id FROM outcome_chain_run_attrs ORDER BY checked_at LIMIT ${RUN_ATTRS_RECHECK}),
    gone AS (DELETE FROM outcome_chain_run_attrs a USING due d WHERE a.run_id = d.run_id AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.id = d.run_id))
    SELECT 1`);
  await db.execute(sql`
    WITH need AS MATERIALIZED (
      SELECT DISTINCT o.run_id FROM run_outcomes o
      WHERE NOT EXISTS (SELECT 1 FROM outcome_chain_run_attrs a WHERE a.run_id = o.run_id)
      UNION
      (SELECT run_id FROM outcome_chain_run_attrs ORDER BY checked_at LIMIT ${RUN_ATTRS_RECHECK})
    )
    INSERT INTO outcome_chain_run_attrs (run_id, brands, workflow_slug, checked_at)
    SELECT r.id, COALESCE(ARRAY(SELECT DISTINCT b FROM unnest(r.brand_ids) b WHERE b IS NOT NULL ORDER BY b), '{}'), r.workflow_slug, now()
    FROM need n CROSS JOIN LATERAL (SELECT id, brand_ids, workflow_slug FROM runs WHERE id = n.run_id OFFSET 0) r
    ON CONFLICT (run_id) DO UPDATE SET brands = EXCLUDED.brands, workflow_slug = EXCLUDED.workflow_slug, checked_at = EXCLUDED.checked_at`);
}

const RUN_CAMPAIGNS_BATCH = 50_000;
const RUN_CAMPAIGNS_MAX_BATCHES = 40;

/**
 * UNIT-LINK-BRONZE-1117: keeps the campaign of every run holding an occurrence (outcome_chain_run_campaigns),
 * read off `runs` once per run (set at creation, never moved), RUN_CAMPAIGNS_BATCH primary-key probes per
 * statement so the first fill (prod: ~550k runs) never holds one long statement. A run the fill has not
 * reached is read by the build itself.
 */
async function refreshRunCampaigns(): Promise<void> {
  for (let i = 0; i < RUN_CAMPAIGNS_MAX_BATCHES; i++) {
    const added = (await db.execute(sql`
      INSERT INTO outcome_chain_run_campaigns (run_id, campaign_id)
      SELECT r.id, r.campaign_id::text
      FROM (
        SELECT a.run_id FROM outcome_chain_run_attrs a
        WHERE NOT EXISTS (SELECT 1 FROM outcome_chain_run_campaigns c WHERE c.run_id = a.run_id)
        LIMIT ${RUN_CAMPAIGNS_BATCH}
      ) n
      CROSS JOIN LATERAL (SELECT id, campaign_id FROM runs WHERE id = n.run_id OFFSET 0) r
      ON CONFLICT (run_id) DO NOTHING
      RETURNING 1`)) as unknown[];
    if (added.length < RUN_CAMPAIGNS_BATCH) return;
  }
}

/** Stamp (stats_rollups) set by the first build that stored the links: the unit-links reads answer 503 before it. */
export const UNIT_LINKS_STAMP = "unit_links";
const UNIT_LINKS_LOCK = "unit_links_write";

/** The edges of one build, handed by the build statement to storeUnitLinks inside the same transaction. */
const UNIT_LINK_EDGES_DDL = `
  CREATE TEMP TABLE unit_link_edges (
    x_id uuid NOT NULL, y_id uuid NOT NULL, x_key text NOT NULL, y_key text NOT NULL, x_at timestamptz NOT NULL, y_at timestamptz NOT NULL,
    x_run_id uuid NOT NULL, y_run_id uuid NOT NULL, cs text NOT NULL, cid text NOT NULL
  ) ON COMMIT DROP`;

/**
 * UNIT-LINK-BRONZE-1117: stores the build's edges as links (unit_links, 0118), in the build's own transaction and
 * snapshot. Each step is its own statement over an ANALYZEd temp table, so every join is planned on real row counts.
 *   1. each run's brand set + campaign (kept attributes, else the run itself);
 *   2. each Unit's own campaign; a Unit whose run names none carries the campaigns of the nearest Units it came
 *      from that name one, through any number of campaign-less Units (UNION: a cycle ends);
 *   3. diff write: a new or moved link takes the next change_id, a link the build no longer produces is stamped
 *      removed (never deleted), a removed link that stands again is written anew.
 */
async function storeUnitLinks(tx: any): Promise<{ standing: number; written: number; removed: number }> {
  await tx.execute(sql`ANALYZE unit_link_edges`);
  await tx.execute(sql`
    CREATE TEMP TABLE unit_link_runs ON COMMIT DROP AS
    SELECT i.id,
           COALESCE(a.brands, p.brands, '{}') AS brands,
           CASE WHEN k.run_id IS NOT NULL THEN k.campaign_id ELSE p.campaign_id END AS campaign_id
    FROM (SELECT x_run_id AS id FROM unit_link_edges UNION SELECT y_run_id FROM unit_link_edges) i
    LEFT JOIN outcome_chain_run_attrs a ON a.run_id = i.id
    LEFT JOIN outcome_chain_run_campaigns k ON k.run_id = i.id
    LEFT JOIN LATERAL (
      SELECT COALESCE(ARRAY(SELECT DISTINCT b FROM unnest(r.brand_ids) b WHERE b IS NOT NULL ORDER BY b), '{}') AS brands, r.campaign_id::text AS campaign_id
      FROM runs r WHERE r.id = i.id AND (a.run_id IS NULL OR k.run_id IS NULL) OFFSET 0
    ) p ON TRUE`);
  await tx.execute(sql`ANALYZE unit_link_runs`);
  await tx.execute(sql`
    CREATE TEMP TABLE unit_link_units ON COMMIT DROP AS
    SELECT e.x_id AS id, r.campaign_id FROM unit_link_edges e JOIN unit_link_runs r ON r.id = e.x_run_id
    UNION
    SELECT e.y_id, r.campaign_id FROM unit_link_edges e JOIN unit_link_runs r ON r.id = e.y_run_id`);
  await tx.execute(sql`ANALYZE unit_link_units`);
  await tx.execute(sql`
    CREATE TEMP TABLE unit_link_bare ON COMMIT DROP AS
    SELECT e.x_id, e.y_id FROM unit_link_edges e JOIN unit_link_units c ON c.id = e.y_id WHERE c.campaign_id IS NULL`);
  await tx.execute(sql`ANALYZE unit_link_bare`);
  await tx.execute(sql`
    CREATE TEMP TABLE unit_link_carried ON COMMIT DROP AS
    WITH RECURSIVE carry(unit_id, campaign_id) AS (
      SELECT n.y_id, c.campaign_id FROM unit_link_bare n JOIN unit_link_units c ON c.id = n.x_id WHERE c.campaign_id IS NOT NULL
      UNION
      SELECT n.y_id, k.campaign_id FROM carry k JOIN unit_link_bare n ON n.x_id = k.unit_id
    )
    SELECT unit_id, array_agg(campaign_id ORDER BY campaign_id) AS ids FROM carry GROUP BY 1`);
  await tx.execute(sql`ANALYZE unit_link_carried`);
  await tx.execute(sql`
    CREATE TEMP TABLE unit_link_rows ON COMMIT DROP AS
    SELECT e.x_id, e.y_id, e.x_key, e.y_key, e.x_at, e.y_at, e.x_run_id, e.y_run_id, e.cs, e.cid,
           ux.campaign_id AS x_camp, uy.campaign_id AS y_camp,
           CASE WHEN ux.campaign_id IS NOT NULL THEN ARRAY[ux.campaign_id] ELSE COALESCE(kx.ids, '{}') END AS x_camps,
           CASE WHEN uy.campaign_id IS NOT NULL THEN ARRAY[uy.campaign_id] ELSE COALESCE(ky.ids, '{}') END AS y_camps,
           rx.brands AS x_brands, ry.brands AS y_brands
    FROM unit_link_edges e
    JOIN unit_link_runs rx ON rx.id = e.x_run_id JOIN unit_link_runs ry ON ry.id = e.y_run_id
    JOIN unit_link_units ux ON ux.id = e.x_id JOIN unit_link_units uy ON uy.id = e.y_id
    LEFT JOIN unit_link_carried kx ON kx.unit_id = e.x_id LEFT JOIN unit_link_carried ky ON ky.unit_id = e.y_id`);
  await tx.execute(sql`ANALYZE unit_link_rows`);
  const [r] = (await tx.execute(sql`
    WITH moved AS MATERIALIZED (
      SELECT l.* FROM unit_link_rows l LEFT JOIN unit_links t ON t.from_unit_id = l.x_id AND t.to_unit_id = l.y_id
      WHERE t.from_unit_id IS NULL OR t.removed_at IS NOT NULL
         OR (t.from_outcome, t.to_outcome, t.from_at, t.to_at, t.from_run_id, t.to_run_id, t.subject_service, t.subject_id,
             t.from_campaign_id, t.to_campaign_id, t.from_campaign_ids, t.to_campaign_ids, t.from_brand_ids, t.to_brand_ids)
            IS DISTINCT FROM
            (l.x_key, l.y_key, l.x_at, l.y_at, l.x_run_id, l.y_run_id, l.cs, l.cid, l.x_camp, l.y_camp, l.x_camps, l.y_camps, l.x_brands, l.y_brands)
    ),
    up AS (
      INSERT INTO unit_links (from_unit_id, to_unit_id, from_outcome, to_outcome, from_at, to_at, from_run_id, to_run_id, subject_service, subject_id,
                              from_campaign_id, to_campaign_id, from_campaign_ids, to_campaign_ids, from_brand_ids, to_brand_ids, change_id)
      SELECT x_id, y_id, x_key, y_key, x_at, y_at, x_run_id, y_run_id, cs, cid, x_camp, y_camp, x_camps, y_camps, x_brands, y_brands,
             nextval('unit_links_change_seq')
      FROM moved
      ON CONFLICT (from_unit_id, to_unit_id) DO UPDATE
        SET from_outcome = EXCLUDED.from_outcome, to_outcome = EXCLUDED.to_outcome, from_at = EXCLUDED.from_at, to_at = EXCLUDED.to_at,
            from_run_id = EXCLUDED.from_run_id, to_run_id = EXCLUDED.to_run_id, subject_service = EXCLUDED.subject_service, subject_id = EXCLUDED.subject_id,
            from_campaign_id = EXCLUDED.from_campaign_id, to_campaign_id = EXCLUDED.to_campaign_id,
            from_campaign_ids = EXCLUDED.from_campaign_ids, to_campaign_ids = EXCLUDED.to_campaign_ids,
            from_brand_ids = EXCLUDED.from_brand_ids, to_brand_ids = EXCLUDED.to_brand_ids, removed_at = NULL, change_id = EXCLUDED.change_id
      RETURNING 1
    ),
    gone AS (
      UPDATE unit_links t SET removed_at = clock_timestamp(), change_id = nextval('unit_links_change_seq')
      WHERE t.removed_at IS NULL AND NOT EXISTS (SELECT 1 FROM unit_link_rows l WHERE l.x_id = t.from_unit_id AND l.y_id = t.to_unit_id)
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM unit_link_rows)::int AS standing, (SELECT count(*) FROM up)::int AS written, (SELECT count(*) FROM gone)::int AS removed`)) as Array<{
    standing: number; written: number; removed: number;
  }>;
  return { standing: Number(r.standing), written: Number(r.written), removed: Number(r.removed) };
}

let building = false;

/** Rebuilds the three tables from the whole fleet. Single flight per process + an advisory lock across processes. */
export async function buildOutcomeChains(): Promise<OutcomeChainBuild | null> {
  if (building) return null;
  building = true;
  try {
    const t0 = Date.now();
    const [stamped] = (await db.execute(sql`
      SELECT EXISTS (SELECT 1 FROM stats_rollups WHERE name = 'subtree_cost') AS ok,
             EXISTS (SELECT 1 FROM stats_rollups WHERE name = 'subtree_cost_items') AS items`)) as Array<{ ok: boolean; items: boolean }>;
    // A decision's cost is read off run_subtree_costs (0086): an unstamped rollup would price every decision wrong.
    if (!stamped.ok) throw new Error("run_subtree_costs is not stamped (subtree_cost): rebuild it before building outcome chains");
    // Its cost names off run_subtree_cost_items (0092): unstamped, every decision would name nothing.
    if (!stamped.items) throw new Error("run_subtree_cost_items is not stamped (subtree_cost_items): rebuild it before building outcome chains");
    await refreshRunAttrs();
    await refreshRunCampaigns();
    // One snapshot for the whole graph. The same transaction also WRITES the links it found (unit_links, 0118), so it
    // is not read-only; one writer at a time (the change_id order is the changes feed's order).
    const out = await statsDb.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const [lock] = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${UNIT_LINKS_LOCK})) AS ok`)) as Array<{ ok: boolean }>;
      if (!lock.ok) return null;
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${BUILD_TIMEOUT}'`));
      await tx.execute(sql.raw(UNIT_LINK_EDGES_DDL));
      const built = (await tx.execute(OUTCOME_CHAIN_BUILD_SQL)) as unknown as Array<{ t: OutcomeChainTable | "decision"; r: unknown }>;
      return { rows: [...built], links: await storeUnitLinks(tx) };
    });
    if (out === null) return null;
    const { rows, links } = out;
    const by: Record<OutcomeChainTable | "decision", unknown[]> = { consumed: [], steps: [], reach: [], decision: [] };
    for (const row of rows) by[row.t].push(row.r);

    return await db.transaction(async (tx) => {
      const [lock] = (await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext('outcome_chains_build')) AS ok`)) as Array<{ ok: boolean }>;
      if (!lock.ok) return null;
      // The stamp must sort after every earlier build's even if clocks disagree.
      const [s] = (await tx.execute(sql`
        SELECT to_char(GREATEST(clock_timestamp(), (SELECT max(built_at) + interval '1 millisecond' FROM outcome_chain_builds)) AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS stamp`)) as Array<{ stamp: string }>;
      let changed = 0;
      await writeDecisions(tx, by.decision, s.stamp);
      for (const t of OUTCOME_CHAIN_TABLES) changed += await writeTable(tx, t, by[t], s.stamp);
      const [rc] = (await tx.execute(sql`SELECT count(*)::int AS n FROM script_chain_reach WHERE runs > 0`)) as Array<{ n: number }>;
      const build: OutcomeChainBuild = {
        builtAt: s.stamp,
        durationMs: Date.now() - t0,
        changedRows: changed,
        consumedRows: by.consumed.length,
        stepRows: by.steps.length,
        reachRows: rc.n,
        unitLinks: Number(links.standing),
        unitLinksWritten: Number(links.written),
        unitLinksRemoved: Number(links.removed),
      };
      await tx.execute(sql`INSERT INTO stats_rollups (name, ready_at) VALUES (${UNIT_LINKS_STAMP}, now()) ON CONFLICT (name) DO NOTHING`);
      await tx.execute(sql`
        INSERT INTO outcome_chain_builds (built_at, duration_ms, changed_rows, consumed_rows, step_rows, reach_rows, cost_names, asked_by)
        VALUES (${build.builtAt}::timestamptz, ${build.durationMs}, ${build.changedRows}, ${build.consumedRows}, ${build.stepRows}, ${build.reachRows}, true, true)`);
      await tx.execute(sql`DELETE FROM outcome_chain_builds WHERE built_at < now() - interval '7 days'`);
      return build;
    });
  } finally {
    building = false;
  }
}

/** After app.listen(): first build ~90 s after boot, then 15 min after the previous one ENDS. Kill switch OUTCOME_CHAINS_BUILD=off. */
export function startOutcomeChainBuilds(): void {
  if (process.env.OUTCOME_CHAINS_BUILD === "off") {
    console.log("[Runs Service] outcome chains: build disabled (OUTCOME_CHAINS_BUILD=off)");
    return;
  }
  const tick = async () => {
    try {
      const b = await buildOutcomeChains();
      if (b) console.log(`[Runs Service] outcome chains built in ${b.durationMs}ms: changed=${b.changedRows} consumed=${b.consumedRows} steps=${b.stepRows} reach=${b.reachRows} links=${b.unitLinks} linksWritten=${b.unitLinksWritten} linksRemoved=${b.unitLinksRemoved}`);
    } catch (err) {
      console.error("[Runs Service] outcome chains build failed (retried next tick):", err);
    } finally {
      setTimeout(() => void tick(), TICK_GAP_MS).unref();
    }
  };
  setTimeout(() => void tick(), FIRST_TICK_MS).unref();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export class OutcomeChainsNotBuiltError extends Error {
  constructor() {
    super("outcome chains are not built yet: the first build runs ~90 s after boot");
  }
}

async function lastBuild(tx: any): Promise<OutcomeChainBuild> {
  const rows = (await tx.execute(sql`
    SELECT to_char(built_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS built_at, duration_ms, changed_rows, consumed_rows, step_rows, reach_rows
    FROM outcome_chain_builds ORDER BY built_at DESC LIMIT 1`)) as any[];
  if (rows.length === 0) throw new OutcomeChainsNotBuiltError();
  const r = rows[0];
  return {
    builtAt: r.built_at,
    durationMs: r.duration_ms,
    changedRows: r.changed_rows,
    consumedRows: r.consumed_rows,
    stepRows: r.step_rows,
    reachRows: r.reach_rows,
  };
}

const share = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1e6) / 1e6 : null);

export interface StepRate {
  fromOutcome: string;
  toOutcome: string;
  consumedUnits: number;
  ledUnits: number;
  share: number | null;
  ledUnitsByPerformer: Record<string, number>;
}

/** One-step rates, fleet or for one brand (rows whose brand set holds it). */
export async function readStepRates(brandId: string | null) {
  return statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const build = await lastBuild(tx);
    const brand = brandId === null ? sql`TRUE` : sql`brand_ids @> ARRAY[${brandId}]::text[]`;
    const consumed = (await tx.execute(sql`
      SELECT from_outcome, sum(consumed_units)::int AS n FROM outcome_chain_consumed
      WHERE consumed_units > 0 AND ${brand} GROUP BY 1 ORDER BY 1`)) as Array<{ from_outcome: string; n: number }>;
    const steps = (await tx.execute(sql`
      WITH s AS (SELECT * FROM outcome_chain_steps WHERE led_units > 0 AND ${brand})
      SELECT t.from_outcome, t.to_outcome, t.n, COALESCE(k.by_kind, '{}'::jsonb) AS by_kind
      FROM (SELECT from_outcome, to_outcome, sum(led_units)::int AS n FROM s GROUP BY 1, 2) t
      LEFT JOIN (
        SELECT from_outcome, to_outcome, jsonb_object_agg(kind, n ORDER BY kind) AS by_kind
        FROM (SELECT s.from_outcome, s.to_outcome, kv.key AS kind, sum(kv.value::int)::int AS n
              FROM s CROSS JOIN LATERAL jsonb_each_text(s.led_units_by_performer) kv GROUP BY 1, 2, 3) z
        GROUP BY 1, 2
      ) k ON k.from_outcome = t.from_outcome AND k.to_outcome = t.to_outcome
      ORDER BY 1, 2`)) as Array<{ from_outcome: string; to_outcome: string; n: number; by_kind: Record<string, number> }>;
    const den = new Map(consumed.map((c) => [c.from_outcome, c.n]));
    return {
      builtAt: build.builtAt,
      brandId,
      consumed: consumed.map((c) => ({ outcome: c.from_outcome, consumedUnits: c.n })),
      steps: steps.map<StepRate>((s) => {
        const d = den.get(s.from_outcome) ?? 0;
        return { fromOutcome: s.from_outcome, toOutcome: s.to_outcome, consumedUnits: d, ledUnits: s.n, share: share(s.n, d), ledUnitsByPerformer: s.by_kind };
      }),
    };
  });
}

export interface ScriptReachFilter {
  scriptSlugs: string[] | null;
  scriptDynasties: string[] | null;
  brandId: string | null;
  since: string | null;
  until: string | null;
  groupBy: "version" | "dynasty";
  /** CAMPAIGN-SCRIPTS-1113: only the decisions run FOR these campaigns (the decision run's campaign_id). null = every decision. */
  campaignIds?: string[] | null;
  /**
   * SERVED-MODEL-1116: also split each group by the cost names its decisions billed (`costNames`) and the cost names
   * of the other script decisions whose Units they consumed (`sourceCostNames`). Absent = the groups as before.
   */
  includeCostNames?: boolean;
}

export class OutcomeChainCostNamesNotBuiltError extends OutcomeChainsNotBuiltError {
  constructor() {
    super();
    this.message = "cost names are not built yet: the next outcome chains build (<= 15 min) writes them";
  }
}

/** `<outcome>/<dynasty>/v<version>` -> `<outcome>/<dynasty>`. */
export const DYNASTY_SQL = sql.raw(`regexp_replace(script_slug, '/v[0-9]+$', '')`);

/** Runs per (script or dynasty, run day, produced outcomes, reached outcomes), fleet or one brand. */
export async function readScriptReach(f: ScriptReachFilter) {
  return statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const build = await lastBuild(tx);
    const withNames = f.includeCostNames === true;
    // ONE-WRITER-N-MODELS-1116: the include=costNames read also names (and splits by) the script that ASKED each
    // decision, once a build wrote it; before that build (<= 15 min after the deploy) the field is absent, never null.
    let withAsker = false;
    if (withNames) {
      const [b] = (await tx.execute(sql`SELECT cost_names, asked_by FROM outcome_chain_builds ORDER BY built_at DESC LIMIT 1`)) as Array<{
        cost_names: boolean;
        asked_by: boolean;
      }>;
      if (!b.cost_names) throw new OutcomeChainCostNamesNotBuiltError();
      withAsker = b.asked_by;
    }
    const where: SQL[] = [sql`runs > 0`];
    if (f.brandId !== null) where.push(sql`brand_ids @> ARRAY[${f.brandId}]::text[]`);
    if (f.scriptSlugs) where.push(sql`script_slug = ANY(${`{${f.scriptSlugs.map((s) => JSON.stringify(s)).join(",")}}`}::text[])`);
    if (f.scriptDynasties) where.push(sql`${DYNASTY_SQL} = ANY(${`{${f.scriptDynasties.map((s) => JSON.stringify(s)).join(",")}}`}::text[])`);
    if (f.since) where.push(sql`day >= ${f.since}::date`);
    if (f.until) where.push(sql`day <= ${f.until}::date`);
    const key = f.groupBy === "dynasty" ? DYNASTY_SQL : sql.raw("script_slug");
    const campaignIds = f.campaignIds ?? null;
    // Narrowed to campaigns: grouped from the stored decisions themselves (script_chain_reach carries no campaign);
    // the same decisions the reach rows are grouped from, so a campaign's figures add up to the unfiltered ones.
    // Cost names live on the stored decisions only (script_chain_reach is not split by them).
    const from =
      campaignIds || withNames
        ? sql`(SELECT script_slug, day, brand_ids, produced_outcomes, reached_outcomes, 1 AS runs, cost_in_usd_cents, net_cost_in_usd_cents,
                      cost_names, source_cost_names, asked_by_script_slug
               FROM script_chain_decisions
               WHERE ${campaignIds ? sql`campaign_id = ANY(${`{${campaignIds.map((c) => JSON.stringify(c)).join(",")}}`}::text[])` : sql`TRUE`}) d`
        : sql.raw("script_chain_reach");
    const askerKey = f.groupBy === "dynasty" ? sql.raw(`regexp_replace(asked_by_script_slug, '/v[0-9]+$', '')`) : sql.raw("asked_by_script_slug");
    const names = withNames ? (withAsker ? sql`, cost_names, source_cost_names, ${askerKey} AS asked_by` : sql`, cost_names, source_cost_names`) : sql``;
    const groupCols = withAsker ? sql`1, 2, 3, 4, 5, 6, 7` : withNames ? sql`1, 2, 3, 4, 5, 6` : sql`1, 2, 3, 4`;
    const rows = (await tx.execute(sql`
      SELECT ${key} AS script, to_char(day, 'YYYY-MM-DD') AS day, produced_outcomes, reached_outcomes${names}, sum(runs)::int AS runs,
             sum(cost_in_usd_cents)::text AS cost, sum(net_cost_in_usd_cents)::text AS net_cost
      FROM ${from} WHERE ${sql.join(where, sql` AND `)}
      GROUP BY ${groupCols}
      ORDER BY ${groupCols}`)) as Array<{
      script: string; day: string; produced_outcomes: string[]; reached_outcomes: string[]; cost_names?: string[]; source_cost_names?: string[];
      asked_by?: string | null; runs: number; cost: string; net_cost: string;
    }>;
    return {
      builtAt: build.builtAt,
      brandId: f.brandId,
      ...(campaignIds ? { campaignIds } : {}),
      groupBy: f.groupBy,
      ...(withNames ? { include: ["costNames"] } : {}),
      groups: rows.map((r) => ({
        ...(f.groupBy === "dynasty" ? { scriptDynasty: r.script } : { scriptSlug: r.script }),
        day: r.day,
        producedOutcomes: r.produced_outcomes,
        reachedOutcomes: r.reached_outcomes,
        ...(withNames ? { costNames: r.cost_names, sourceCostNames: r.source_cost_names } : {}),
        ...(withAsker ? (f.groupBy === "dynasty" ? { askedByScriptDynasty: r.asked_by ?? null } : { askedByScriptSlug: r.asked_by ?? null }) : {}),
        runs: r.runs,
        costInUsdCents: r.cost,
        netCostInUsdCents: r.net_cost,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Changes feed: every row a build stamped after the cursor, raw (zeroed rows included)
// ---------------------------------------------------------------------------

export class OutcomeChainCursorError extends Error {}

interface ChainCursor {
  v: 1;
  /** Rows stamped after this instant are not served yet ('' = from the start). */
  a: string;
  /** The build being paged (rows stamped <= b); absent between pages = caught up to a. */
  b?: string;
  t?: number;
  id?: string;
}

const encode = (c: ChainCursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decode(raw: string): ChainCursor {
  let c: ChainCursor;
  try {
    c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new OutcomeChainCursorError("cursor is not a cursor this read served");
  }
  const okTime = (s: unknown) => typeof s === "string" && (s === "" || !Number.isNaN(Date.parse(s)));
  if (c?.v !== 1 || !okTime(c.a) || (c.b !== undefined && !okTime(c.b))) throw new OutcomeChainCursorError("cursor is not a cursor this read served");
  return c;
}

const TABLE_SQL: Record<OutcomeChainTable, { name: string; cols: string }> = {
  consumed: { name: "outcome_chain_consumed", cols: "from_outcome AS \"fromOutcome\", brand_ids AS \"brandIds\", consumed_units AS \"consumedUnits\"" },
  steps: {
    name: "outcome_chain_steps",
    cols: "from_outcome AS \"fromOutcome\", to_outcome AS \"toOutcome\", brand_ids AS \"brandIds\", led_units AS \"ledUnits\", led_units_by_performer AS \"ledUnitsByPerformer\"",
  },
  reach: {
    name: "script_chain_reach",
    cols: "script_slug AS \"scriptSlug\", to_char(day, 'YYYY-MM-DD') AS day, brand_ids AS \"brandIds\", produced_outcomes AS \"producedOutcomes\", reached_outcomes AS \"reachedOutcomes\", runs, cost_in_usd_cents::text AS \"costInUsdCents\", net_cost_in_usd_cents::text AS \"netCostInUsdCents\"",
  },
};

export const CHANGES_DEFAULT_LIMIT = 5000;
export const CHANGES_MAX_LIMIT = 20000;

/**
 * Rows stamped after the cursor, table by table (consumed, steps, reach), by id.
 * No cursor = every row ever written (zeroed ones included): a full copy. Follow
 * nextCursor until caughtUp; then keep the cursor and come back after the next build.
 */
export async function readOutcomeChainChanges(rawCursor: string | undefined, limit: number) {
  const c: ChainCursor = rawCursor ? decode(rawCursor) : { v: 1, a: "" };
  return statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const build = await lastBuild(tx);
    const b = c.b ?? build.builtAt;
    const out: Record<OutcomeChainTable, any[]> = { consumed: [], steps: [], reach: [] };
    let left = limit;
    let t = c.t ?? 0;
    let lastId = c.id ?? "0";
    while (t < OUTCOME_CHAIN_TABLES.length) {
      if (left === 0) {
        return { builtAt: build.builtAt, ...out, nextCursor: encode({ v: 1, a: c.a, b, t, id: lastId }), caughtUp: false };
      }
      const table = OUTCOME_CHAIN_TABLES[t];
      const spec = TABLE_SQL[table];
      const after = c.a === "" ? sql`TRUE` : sql`updated_at > ${c.a}::timestamptz`;
      const rows = (await tx.execute(sql`
        SELECT id::text AS id, ${sql.raw(spec.cols)}, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt"
        FROM ${sql.raw(spec.name)}
        WHERE ${after} AND updated_at <= ${b}::timestamptz AND id > ${lastId}::bigint
        ORDER BY id LIMIT ${left + 1}`)) as any[];
      const page = rows.slice(0, left);
      for (const r of page) {
        const { id: _id, ...rest } = r;
        out[table].push(rest);
      }
      if (rows.length > left) {
        const next = encode({ v: 1, a: c.a, b, t, id: page[page.length - 1].id });
        return { builtAt: build.builtAt, ...out, nextCursor: next, caughtUp: false };
      }
      left -= page.length;
      t += 1;
      lastId = "0";
    }
    return { builtAt: build.builtAt, ...out, nextCursor: encode({ v: 1, a: b }), caughtUp: true };
  });
}

// ---------------------------------------------------------------------------
// A reported Unit -> the script decision that made it, in script-reach terms
// ---------------------------------------------------------------------------

export const MAX_UNITS_PER_RESOLVE = 500;

export interface UnitToResolve {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  /** The report time: the Unit standing then is the one resolved. */
  at: string;
}

/**
 * For each Unit named the ledger's way, the produced occurrence standing at `at`
 * (same key, same canonical subject incl. stated equivalences, latest declared at or
 * before it, not reversed by then; id breaks ties), then its decision: the run that
 * declared it must name a script (as in the build: own Units are Units of script
 * runs), and the decision is that run's topmost ancestor naming the same script.
 * The decision's row key + cost come from the last build (script_chain_decisions).
 */
export async function resolveUnitDecisions(units: UnitToResolve[]) {
  return statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
    const build = await lastBuild(tx);
    const input = JSON.stringify(units.map((u, i) => ({ i, k: u.outcomeKey, s: u.subjectService, sid: u.subjectId, at: u.at })));
    const rows = (await tx.execute(sql`
      WITH RECURSIVE
      u AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(${input}::jsonb) AS x(i int, k text, s text, sid text, at timestamptz)),
      canon AS MATERIALIZED (
        SELECT u.i, u.k, u.at, COALESCE(e.target_service, u.s) AS cs, COALESCE(e.target_id, u.sid) AS cid
        FROM u LEFT JOIN subject_equivalences e ON e.subject_service = u.s AND e.subject_id = u.sid
      ),
      mem AS (
        SELECT i, k, at, cs AS ms, cid AS mid FROM canon
        UNION
        SELECT c.i, c.k, c.at, e.subject_service, e.subject_id FROM canon c JOIN subject_equivalences e ON e.target_service = c.cs AND e.target_id = c.cid
      ),
      pick AS MATERIALIZED (
        SELECT DISTINCT ON (m.i) m.i, o.id, o.run_id
        FROM mem m
        CROSS JOIN LATERAL (
          SELECT o.id, o.run_id, o.declared_at FROM run_outcomes o
          WHERE o.direction = 'produced' AND o.outcome_key = m.k AND o.subject_service = m.ms AND o.subject_id = m.mid AND o.declared_at <= m.at
            AND NOT EXISTS (SELECT 1 FROM run_outcome_reversals rv WHERE rv.occurrence_id = o.id AND rv.reversed_at <= m.at)
          OFFSET 0
        ) o
        ORDER BY m.i, o.declared_at DESC, o.id DESC
      ),
      walk(i, cur_id, parent_id, slug, depth) AS (
        SELECT p.i, r.id, r.parent_run_id, r.script_slug, 0
        FROM pick p CROSS JOIN LATERAL (SELECT id, parent_run_id, COALESCE(decision_script_slug, script_slug) AS script_slug FROM runs WHERE id = p.run_id OFFSET 0) r
        WHERE r.script_slug IS NOT NULL
        UNION ALL
        SELECT w.i, q.id, q.parent_run_id, q.script_slug, w.depth + 1
        FROM walk w CROSS JOIN LATERAL (SELECT id, parent_run_id, COALESCE(decision_script_slug, script_slug) AS script_slug FROM runs WHERE id = w.parent_id OFFSET 0) q
        WHERE q.script_slug = w.slug AND w.depth < 50
      ),
      dec AS (SELECT DISTINCT ON (i) i, cur_id FROM walk ORDER BY i, depth DESC)
      SELECT u.i, p.id AS occurrence_id, p.run_id, d.cur_id AS decision_run_id,
             c.script_slug, to_char(c.day, 'YYYY-MM-DD') AS day, c.brand_ids, c.produced_outcomes, c.reached_outcomes,
             c.cost_in_usd_cents::text AS cost, c.net_cost_in_usd_cents::text AS net_cost
      FROM u
      LEFT JOIN pick p ON p.i = u.i
      LEFT JOIN dec d ON d.i = u.i
      LEFT JOIN script_chain_decisions c ON c.decision_run_id = d.cur_id
      ORDER BY u.i
    `)) as any[];
    return {
      builtAt: build.builtAt,
      units: rows.map((r) => {
        const u = units[r.i];
        const status = !r.occurrence_id ? "no_unit" : !r.decision_run_id ? "no_script" : !r.script_slug ? "not_in_build" : "script_decision";
        return {
          ...u,
          status,
          occurrenceId: r.occurrence_id ?? null,
          runId: r.run_id ?? null,
          decisionRunId: r.decision_run_id ?? null,
          decision:
            status === "script_decision"
              ? {
                  scriptSlug: r.script_slug,
                  day: r.day,
                  brandIds: r.brand_ids,
                  producedOutcomes: r.produced_outcomes,
                  reachedOutcomes: r.reached_outcomes,
                  costInUsdCents: r.cost,
                  netCostInUsdCents: r.net_cost,
                }
              : null,
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// UNIT-LINK-BRONZE-1117: the stored links between two Units, and the campaign(s) a Unit carries
// ---------------------------------------------------------------------------

export class UnitLinksNotBuiltError extends OutcomeChainsNotBuiltError {
  constructor() {
    super();
    this.message = "unit links are not stored yet: the next outcome chains build (<= 15 min) writes them";
  }
}

async function unitLinksBuild(tx: any): Promise<{ builtAt: string; startedAt: string }> {
  const [st] = (await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM stats_rollups WHERE name = ${UNIT_LINKS_STAMP}) AS ok`)) as Array<{ ok: boolean }>;
  if (!st.ok) throw new UnitLinksNotBuiltError();
  const rows = (await tx.execute(sql`
    SELECT to_char(built_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS built_at,
           to_char((built_at - duration_ms * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at
    FROM outcome_chain_builds ORDER BY built_at DESC LIMIT 1`)) as any[];
  if (rows.length === 0) throw new UnitLinksNotBuiltError();
  return { builtAt: rows[0].built_at, startedAt: rows[0].started_at };
}

export const UNIT_LINKS_DEFAULT_LIMIT = 5000;
export const UNIT_LINKS_MAX_LIMIT = 20000;

const encodeLinkCursor = (c: string) => Buffer.from(JSON.stringify({ v: 1, c })).toString("base64url");
function decodeLinkCursor(raw: string): string {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (c?.v === 1 && typeof c.c === "string" && /^\d{1,18}$/.test(c.c)) return c.c;
  } catch {
    // falls through
  }
  throw new OutcomeChainCursorError("cursor is not a cursor this read served");
}

const ISO = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export interface UnitLinksFilter {
  cursor?: string;
  limit: number;
  fromOutcome?: string | null;
  toOutcome?: string | null;
}

/**
 * Every stored link written after the cursor, in write order (removed ones included, once, with `removedAt`).
 * No cursor = every link ever stored: a full copy. A link is keyed (fromUnit.id, toUnit.id): replace, never add.
 */
export async function readUnitLinks(f: UnitLinksFilter) {
  const after = f.cursor ? decodeLinkCursor(f.cursor) : "0";
  return statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const build = await unitLinksBuild(tx);
    const where: SQL[] = [sql`change_id > ${after}::bigint`];
    if (f.fromOutcome) where.push(sql`from_outcome = ${f.fromOutcome}`);
    if (f.toOutcome) where.push(sql`to_outcome = ${f.toOutcome}`);
    const rows = (await tx.execute(sql`
      SELECT change_id::text AS change_id, from_unit_id, to_unit_id, from_outcome, to_outcome,
             ${sql.raw(ISO("from_at"))} AS from_at, ${sql.raw(ISO("to_at"))} AS to_at,
             round(extract(epoch FROM (to_at - from_at))::numeric, 3)::float8 AS delay_seconds,
             from_run_id, to_run_id, subject_service, subject_id, from_campaign_id, to_campaign_id,
             from_campaign_ids, to_campaign_ids, from_brand_ids, to_brand_ids,
             ${sql.raw(ISO("first_linked_at"))} AS linked_at, ${sql.raw(ISO("removed_at"))} AS removed_at
      FROM unit_links
      WHERE ${sql.join(where, sql` AND `)}
      ORDER BY change_id LIMIT ${f.limit + 1}`)) as any[];
    const page = rows.slice(0, f.limit);
    const last = page.length > 0 ? page[page.length - 1].change_id : after;
    return {
      builtAt: build.builtAt,
      links: page.map((r) => ({
        fromUnit: { id: r.from_unit_id, outcomeKey: r.from_outcome, at: r.from_at, runId: r.from_run_id, brandIds: r.from_brand_ids, campaignId: r.from_campaign_id ?? null, campaignIds: r.from_campaign_ids },
        toUnit: { id: r.to_unit_id, outcomeKey: r.to_outcome, at: r.to_at, runId: r.to_run_id, brandIds: r.to_brand_ids, campaignId: r.to_campaign_id ?? null, campaignIds: r.to_campaign_ids },
        subjectService: r.subject_service,
        subjectId: r.subject_id,
        delaySeconds: Number(r.delay_seconds),
        linkedAt: r.linked_at,
        removedAt: r.removed_at ?? null,
      })),
      nextCursor: encodeLinkCursor(last),
      caughtUp: rows.length <= f.limit,
    };
  });
}

export const UNIT_CAMPAIGNS_DEFAULT_LIMIT = 1000;
export const UNIT_CAMPAIGNS_MAX_LIMIT = 5000;

export type UnitCampaignReason = "no_source_unit" | "source_units_name_no_campaign" | "not_in_build";

/**
 * The standing Units of ONE outcome, each with the campaign(s) it carries: its own run's campaign, else the
 * campaigns of the Units it came from (the stored links, any depth), else a named reason. Paged by Unit id.
 */
export async function readUnitCampaigns(outcomeKey: string, cursor: string | undefined, limit: number) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (cursor !== undefined && !UUID.test(cursor)) throw new OutcomeChainCursorError("cursor is not a cursor this read served");
  return statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const build = await unitLinksBuild(tx);
    const rows = (await tx.execute(sql`
      WITH u AS MATERIALIZED (
        SELECT o.id, o.run_id, o.subject_service, o.subject_id, o.declared_at, COALESCE(o.recorded_at, o.declared_at) AS recorded_at, o.performer_kind
        FROM run_outcomes o
        WHERE o.outcome_key = ${outcomeKey} AND o.direction = 'produced' AND ${cursor ? sql`o.id > ${cursor}::uuid` : sql`TRUE`}
          AND NOT EXISTS (SELECT 1 FROM run_outcome_reversals rv WHERE rv.occurrence_id = o.id)
        ORDER BY o.id LIMIT ${limit + 1}
      )
      SELECT u.id, u.run_id, u.subject_service, u.subject_id, ${sql.raw(ISO("u.declared_at"))} AS at,
             (u.recorded_at > ${build.startedAt}::timestamptz) AS after_build, u.performer_kind,
             r.campaign_id, COALESCE(l.n, 0) AS n, l.ids
      FROM u
      LEFT JOIN LATERAL (SELECT campaign_id::text AS campaign_id FROM runs WHERE id = u.run_id OFFSET 0) r ON TRUE
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS n, (SELECT k.to_campaign_ids FROM unit_links k WHERE k.to_unit_id = u.id AND k.removed_at IS NULL LIMIT 1) AS ids
        FROM unit_links k WHERE k.to_unit_id = u.id AND k.removed_at IS NULL
      ) l ON TRUE
      ORDER BY u.id`)) as any[];
    const page = rows.slice(0, limit);
    return {
      builtAt: build.builtAt,
      outcomeKey,
      units: page.map((r) => {
        const own: string | null = r.campaign_id ?? null;
        const n = Number(r.n);
        const campaignIds: string[] = own !== null ? [own] : n > 0 ? (r.ids ?? []) : [];
        const reason: UnitCampaignReason | null =
          campaignIds.length > 0 ? null : n > 0 ? "source_units_name_no_campaign" : r.after_build ? "not_in_build" : "no_source_unit";
        return {
          unitId: r.id,
          subjectService: r.subject_service,
          subjectId: r.subject_id,
          at: r.at,
          runId: r.run_id,
          performerKind: r.performer_kind ?? null,
          campaignId: own,
          campaignIds,
          campaignSource: campaignIds.length === 0 ? null : own !== null ? ("own_run" as const) : ("source_units" as const),
          reason,
          sourceUnits: n,
        };
      }),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  });
}
