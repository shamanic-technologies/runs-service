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
         p.id AS x_id, p.run_id AS x_run_id, p.outcome_key AS x_key
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
  SELECT DISTINCT r.x_id, r.x_key, r.x_run_id, y.id AS y_id, y.outcome_key AS y_key, y.run_id AS y_run_id, y.performer_kind AS y_pk
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
sr AS MATERIALIZED (SELECT id, parent_run_id, script_slug, started_at, brand_ids FROM runs WHERE script_slug IS NOT NULL),
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
reach AS (
  SELECT s.id, s.script_slug, to_char(s.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
         COALESCE(ARRAY(SELECT DISTINCT b FROM unnest(s.brand_ids) b WHERE b IS NOT NULL ORDER BY b), '{}') AS brands,
         COALESCE(ok.keys, '{}') AS produced, COALESCE(rc.keys, '{}') AS reached,
         COALESCE(c.gross_actual + c.gross_provisioned, 0) - COALESCE(n.gross, 0) AS cost,
         COALESCE(c.net_actual + c.net_provisioned, 0) - COALESCE(n.net, 0) AS net_cost
  FROM roots s
  LEFT JOIN own_keys ok ON ok.decision_id = s.id
  LEFT JOIN reached rc ON rc.decision_id = s.id
  LEFT JOIN run_subtree_costs c ON c.run_id = s.id
  LEFT JOIN nested_cost n ON n.decision_id = s.id
)
SELECT 'consumed' AS t, jsonb_build_object('from_outcome', x_key, 'brand_ids', to_jsonb(brands), 'consumed_units', n) AS r FROM consumed
UNION ALL
SELECT 'steps', jsonb_build_object('from_outcome', t.x_key, 'to_outcome', t.y_key, 'brand_ids', to_jsonb(t.brands), 'led_units', t.n, 'led_units_by_performer', k.by_kind)
FROM steps_total t JOIN steps_kind k ON k.x_key = t.x_key AND k.y_key = t.y_key AND k.brands = t.brands
UNION ALL
SELECT 'decision', jsonb_build_object('decision_run_id', id, 'script_slug', script_slug, 'day', day, 'brand_ids', to_jsonb(brands),
                                      'produced_outcomes', to_jsonb(produced), 'reached_outcomes', to_jsonb(reached),
                                      'cost', cost::text, 'net_cost', net_cost::text)
FROM reach
`);

export interface OutcomeChainBuild {
  builtAt: string;
  durationMs: number;
  changedRows: number;
  consumedRows: number;
  stepRows: number;
  reachRows: number;
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
        AS x(decision_run_id uuid, script_slug text, day date, brand_ids text[], produced_outcomes text[], reached_outcomes text[], cost numeric, net_cost numeric)
    ),
    up AS (
      INSERT INTO script_chain_decisions (decision_run_id, script_slug, day, brand_ids, produced_outcomes, reached_outcomes, cost_in_usd_cents, net_cost_in_usd_cents, updated_at)
      SELECT decision_run_id, script_slug, day, brand_ids, produced_outcomes, reached_outcomes, cost, net_cost, ${stamp}::timestamptz FROM n
      ON CONFLICT (decision_run_id) DO UPDATE
        SET script_slug = EXCLUDED.script_slug, day = EXCLUDED.day, brand_ids = EXCLUDED.brand_ids, produced_outcomes = EXCLUDED.produced_outcomes,
            reached_outcomes = EXCLUDED.reached_outcomes, cost_in_usd_cents = EXCLUDED.cost_in_usd_cents,
            net_cost_in_usd_cents = EXCLUDED.net_cost_in_usd_cents, updated_at = EXCLUDED.updated_at
      WHERE (script_chain_decisions.script_slug, script_chain_decisions.day, script_chain_decisions.brand_ids, script_chain_decisions.produced_outcomes,
             script_chain_decisions.reached_outcomes, script_chain_decisions.cost_in_usd_cents, script_chain_decisions.net_cost_in_usd_cents)
            IS DISTINCT FROM (EXCLUDED.script_slug, EXCLUDED.day, EXCLUDED.brand_ids, EXCLUDED.produced_outcomes, EXCLUDED.reached_outcomes,
                              EXCLUDED.cost_in_usd_cents, EXCLUDED.net_cost_in_usd_cents)
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

let building = false;

/** Rebuilds the three tables from the whole fleet. Single flight per process + an advisory lock across processes. */
export async function buildOutcomeChains(): Promise<OutcomeChainBuild | null> {
  if (building) return null;
  building = true;
  try {
    const t0 = Date.now();
    const [stamped] = (await db.execute(sql`SELECT EXISTS (SELECT 1 FROM stats_rollups WHERE name = 'subtree_cost') AS ok`)) as Array<{ ok: boolean }>;
    // A decision's cost is read off run_subtree_costs (0086): an unstamped rollup would price every decision wrong.
    if (!stamped.ok) throw new Error("run_subtree_costs is not stamped (subtree_cost): rebuild it before building outcome chains");
    await refreshRunAttrs();
    const rows = (await statsDb.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${BUILD_TIMEOUT}'`));
      return tx.execute(OUTCOME_CHAIN_BUILD_SQL);
    })) as Array<{ t: OutcomeChainTable | "decision"; r: unknown }>;
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
      };
      await tx.execute(sql`
        INSERT INTO outcome_chain_builds (built_at, duration_ms, changed_rows, consumed_rows, step_rows, reach_rows)
        VALUES (${build.builtAt}::timestamptz, ${build.durationMs}, ${build.changedRows}, ${build.consumedRows}, ${build.stepRows}, ${build.reachRows})`);
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
      if (b) console.log(`[Runs Service] outcome chains built in ${b.durationMs}ms: changed=${b.changedRows} consumed=${b.consumedRows} steps=${b.stepRows} reach=${b.reachRows}`);
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
}

/** `<outcome>/<dynasty>/v<version>` -> `<outcome>/<dynasty>`. */
export const DYNASTY_SQL = sql.raw(`regexp_replace(script_slug, '/v[0-9]+$', '')`);

/** Runs per (script or dynasty, run day, produced outcomes, reached outcomes), fleet or one brand. */
export async function readScriptReach(f: ScriptReachFilter) {
  return statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const build = await lastBuild(tx);
    const where: SQL[] = [sql`runs > 0`];
    if (f.brandId !== null) where.push(sql`brand_ids @> ARRAY[${f.brandId}]::text[]`);
    if (f.scriptSlugs) where.push(sql`script_slug = ANY(${`{${f.scriptSlugs.map((s) => JSON.stringify(s)).join(",")}}`}::text[])`);
    if (f.scriptDynasties) where.push(sql`${DYNASTY_SQL} = ANY(${`{${f.scriptDynasties.map((s) => JSON.stringify(s)).join(",")}}`}::text[])`);
    if (f.since) where.push(sql`day >= ${f.since}::date`);
    if (f.until) where.push(sql`day <= ${f.until}::date`);
    const key = f.groupBy === "dynasty" ? DYNASTY_SQL : sql.raw("script_slug");
    const rows = (await tx.execute(sql`
      SELECT ${key} AS script, to_char(day, 'YYYY-MM-DD') AS day, produced_outcomes, reached_outcomes, sum(runs)::int AS runs,
             sum(cost_in_usd_cents)::text AS cost, sum(net_cost_in_usd_cents)::text AS net_cost
      FROM script_chain_reach WHERE ${sql.join(where, sql` AND `)}
      GROUP BY 1, 2, 3, 4
      ORDER BY 1, 2, 3, 4`)) as Array<{ script: string; day: string; produced_outcomes: string[]; reached_outcomes: string[]; runs: number; cost: string; net_cost: string }>;
    return {
      builtAt: build.builtAt,
      brandId: f.brandId,
      groupBy: f.groupBy,
      groups: rows.map((r) => ({
        ...(f.groupBy === "dynasty" ? { scriptDynasty: r.script } : { scriptSlug: r.script }),
        day: r.day,
        producedOutcomes: r.produced_outcomes,
        reachedOutcomes: r.reached_outcomes,
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
        FROM pick p CROSS JOIN LATERAL (SELECT id, parent_run_id, script_slug FROM runs WHERE id = p.run_id OFFSET 0) r
        WHERE r.script_slug IS NOT NULL
        UNION ALL
        SELECT w.i, q.id, q.parent_run_id, q.script_slug, w.depth + 1
        FROM walk w CROSS JOIN LATERAL (SELECT id, parent_run_id, script_slug FROM runs WHERE id = w.parent_id OFFSET 0) q
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
