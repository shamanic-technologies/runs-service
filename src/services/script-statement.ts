// Script statements (MON-SCRIPT-PRICES-2-1111): name, on RECORDED history, the stored script a run subtree worked
// for (`<outcome>/<dynasty>/v<version>`), when its writer opened it before runs carried one (migration 0111).
// workflow-service holds which script each of its Engine runs executed (its run row's `result.script`); it states it
// here, and the ledger then measures each script apart instead of one pool per pipe. A root that already names ANOTHER
// script (an outer script's statement reached it, or its writer stated one) keeps it and is reported (`alreadyNamed`):
// the OUTERMOST script wins, as at write; within one call a run reached from several roots takes the outermost one's.
//
// Same doctrine as feature-slug corrections: one bronze `run.script_stated` event per run (payload: scriptSlug,
// reason, statedBy: the audit trail), projected by `project_run_lifecycle_to_silver`, which fills a NULL
// `runs.script_slug` only. The walk descends from each root through runs carrying no script or the root's own (a
// subtree already stating another script keeps it: the OUTERMOST script wins at write, and a recorded one is never
// overwritten). Cost amounts never move.
//
// DECISION script (SERVED-MODEL-1116-NESTED-RUNS, 0116): in the same call every root (named or not) also states its
// script as the DECISION script of itself and of the descendants that shared its decision (same COALESCE(decision,
// script) as the root before the call; the walk stops at another root of the call and at a run already deciding for
// another script). The nearest root wins, so a script asked by another one (its run opened under the asker's, recorded
// under the asker's slug before 0116) becomes its own decision whatever order the roots are stated in. Bronze
// `run.decision_script_stated` per moved run; feeds the decision reads only, never the ledger (no day re-staled). The stored ledger days the named runs touched are recomputed: every day
// from the earliest corrected run's start is flagged `script_slugs = false` (a consumed row on a later day reads the
// producing run's script), so a script read lists them missing until the refresher stores them again. Idempotent.

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { runLifecycleEvents } from "../db/schema.js";

export type ScriptStatementInput = {
  items: Array<{ rootRunId: string; scriptSlug: string }>;
  reason: string;
  statedBy: string;
};

export type ScriptStatementResult =
  | { kind: "ok"; statedRuns: number; daysToRecompute: number; alreadyNamed: { runId: string; scriptSlug: string }[]; decisionStatedRuns: number }
  | { kind: "missing"; missingRunIds: string[] }
  | { kind: "ambiguous"; rootRunIds: string[] };

type TargetRow = { id: string; script: string; organization_id: string | null; started_day: string };

/** Bronze rows per INSERT statement. */
const CHUNK = 1000;

export async function stateScripts(input: ScriptStatementInput): Promise<ScriptStatementResult> {
  const bySlug = new Map<string, string>();
  const ambiguous: string[] = [];
  for (const it of input.items) {
    const had = bySlug.get(it.rootRunId);
    if (had !== undefined && had !== it.scriptSlug) ambiguous.push(it.rootRunId);
    bySlug.set(it.rootRunId, it.scriptSlug);
  }
  if (ambiguous.length > 0) return { kind: "ambiguous", rootRunIds: [...new Set(ambiguous)] };
  const rootIds = [...bySlug.keys()];
  const pairs = JSON.stringify(rootIds.map((id) => ({ id, s: bySlug.get(id) })));

  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '300s'`);
    const roots = (await tx.execute(sql`
      SELECT r.id, r.script_slug FROM runs r
      WHERE r.id IN (SELECT (x.id)::uuid FROM jsonb_to_recordset(${pairs}::jsonb) AS x(id text, s text))
    `)) as unknown as Array<{ id: string; script_slug: string | null }>;
    const found = new Set(roots.map((r) => r.id));
    const missingRunIds = rootIds.filter((id) => !found.has(id));
    if (missingRunIds.length > 0) return { kind: "missing" as const, missingRunIds };
    const alreadyNamed = roots
      .filter((r) => r.script_slug !== null && r.script_slug !== bySlug.get(r.id))
      .map((r) => ({ runId: r.id, scriptSlug: r.script_slug as string }));
    const named = new Set(alreadyNamed.map((r) => r.runId));
    const open = JSON.stringify(rootIds.filter((id) => !named.has(id)).map((id) => ({ id, s: bySlug.get(id) })));

    // Bounded recursive walk from the roots (idx_runs_parent), through runs with no script or the root's own. A run
    // reached from two roots (a nested script's run under an outer one, both named) takes the OUTER one's: the deepest walk.
    const targets = (await tx.execute(sql`
      WITH RECURSIVE walk AS (
        SELECT (x.id)::uuid AS id, x.s AS script, 0 AS depth FROM jsonb_to_recordset(${open}::jsonb) AS x(id text, s text)
        UNION ALL
        SELECT c.id, w.script, w.depth + 1
          FROM walk w
          JOIN runs c ON c.parent_run_id = w.id
         WHERE (c.script_slug IS NULL OR c.script_slug = w.script) AND w.depth < 64
      )
      SELECT DISTINCT ON (r.id) r.id, w.script, r.organization_id, to_char((r.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS started_day
        FROM walk w
        JOIN runs r ON r.id = w.id
       WHERE r.script_slug IS NULL
       ORDER BY r.id, w.depth DESC
    `)) as unknown as TargetRow[];

    for (let i = 0; i < targets.length; i += CHUNK) {
      await tx.insert(runLifecycleEvents).values(
        targets.slice(i, i + CHUNK).map((t) => ({
          runId: t.id,
          eventType: "run.script_stated",
          payload: { scriptSlug: t.script, reason: input.reason, statedBy: input.statedBy },
          identity: { orgId: t.organization_id },
          sourceService: input.statedBy,
        })),
      );
    }

    // The decision script, read AFTER the outer statement above projected (same transaction).
    const decisionTargets = (await tx.execute(sql`
      WITH RECURSIVE roots AS MATERIALIZED (
        SELECT r.id, x.s, COALESCE(r.decision_script_slug, r.script_slug) AS old
          FROM jsonb_to_recordset(${pairs}::jsonb) AS x(id text, s text)
          JOIN runs r ON r.id = (x.id)::uuid
      ),
      walk AS (
        SELECT id, s, old, 0 AS depth FROM roots
        UNION ALL
        SELECT c.id, w.s, w.old, w.depth + 1
          FROM walk w
          JOIN runs c ON c.parent_run_id = w.id
         WHERE c.id NOT IN (SELECT id FROM roots)
           AND COALESCE(c.decision_script_slug, c.script_slug) IS NOT DISTINCT FROM w.old
           AND w.depth < 64
      ),
      nearest AS (
        SELECT DISTINCT ON (w.id) w.id, w.s FROM walk w ORDER BY w.id, w.depth
      )
      SELECT r.id, n.s AS script, r.organization_id
        FROM nearest n JOIN runs r ON r.id = n.id
       WHERE r.script_slug IS NOT NULL
         AND COALESCE(r.decision_script_slug, r.script_slug) IS DISTINCT FROM n.s
    `)) as unknown as Array<{ id: string; script: string; organization_id: string | null }>;
    for (let i = 0; i < decisionTargets.length; i += CHUNK) {
      await tx.insert(runLifecycleEvents).values(
        decisionTargets.slice(i, i + CHUNK).map((t) => ({
          runId: t.id,
          eventType: "run.decision_script_stated",
          payload: { decisionScriptSlug: t.script, reason: input.reason, statedBy: input.statedBy },
          identity: { orgId: t.organization_id },
          sourceService: input.statedBy,
        })),
      );
    }

    let daysToRecompute = 0;
    if (targets.length > 0) {
      const first = targets.reduce((m, t) => (t.started_day < m ? t.started_day : m), targets[0]!.started_day);
      const flagged = (await tx.execute(sql`
        UPDATE cost_ledger_computed_days SET script_slugs = false WHERE day >= ${first}::date AND script_slugs RETURNING day
      `)) as unknown as unknown[];
      daysToRecompute = flagged.length;
    }
    return { kind: "ok" as const, statedRuns: targets.length, daysToRecompute, alreadyNamed, decisionStatedRuns: decisionTargets.length };
  });
}
