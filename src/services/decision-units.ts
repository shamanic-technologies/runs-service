// The outcome Units each DECISION produced, credited the way the ledger credits them
// (LLM-RATING-PER-ENGINE-1112-RUNS). A decision is the run `service-calls.ts`
// `decisionOf` names for a call: the script run, else the workflow run, else the
// top-level run.
//
// - OWN Units: every produced occurrence declared on a run of the decision's work:
//   the decision run and the descendants still working for it (same script; or
//   same workflow and no script; or, for a top-level decision, no script and no
//   workflow), so the social publish a script run's child declares is the script's.
//   A child opening ANOTHER script (a Rating fallthrough candidate names itself) is
//   its own decision and is not walked.
// - DOWNSTREAM Units (one hop): a consumption the ledger resolves to one of the
//   decision's own Units (rule 5: same key, same subject or a subject stated
//   equivalent) credits that Unit's decision with what the consuming run's anchor
//   (itself, else its nearest ancestor that produced; a support mark stops the walk)
//   produced for the SAME subject: the reply judged on the lead an email was sent to.
// - A Unit reversed by its declarer is in no list; a voided declaration is gone from
//   silver, so is in none either.

import { sql, type SQL } from "drizzle-orm";
import { statsDb } from "../db/index.js";
import { resolveConsumptions } from "./outcome-ledger.js";
import { MAX_ANCESTOR_DEPTH, decisionOfChain, readChains } from "./service-calls.js";

export const MAX_DECISIONS_PER_CALL = 200;
const CHANGES_WINDOW_MS = 6 * 3600_000;
const CURSOR_MAX_AGE_MS = 30 * 24 * 3600_000;
export const decisionChangesLagMs = () => Number(process.env.SERVICE_CALLS_LAG_MS ?? 120_000);

type Exec = { execute: (q: SQL) => Promise<unknown> };

export interface DecisionUnit {
  occurrenceId: string;
  runId: string;
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  quantity: string;
  declaredAt: string;
  credit: "own" | "downstream";
  /** Downstream only: the decision's own Unit the consumption resolved to, and the consumption. */
  via: { occurrenceId: string; outcomeKey: string; consumptionId: string; consumingRunId: string } | null;
}

export interface DecisionUnits {
  decisionRunId: string;
  found: boolean;
  units: DecisionUnit[];
}

const uuidArray = (ids: string[]) => `{${[...new Set(ids)].join(",")}}`;
const iso = (v: unknown) => new Date(v as string).toISOString();

interface OccRow {
  decision_id: string;
  id: string;
  run_id: string;
  outcome_key: string;
  subject_service: string;
  subject_id: string;
  quantity: string;
  declared_at: unknown;
}

const unitOf = (r: OccRow, credit: DecisionUnit["credit"], via: DecisionUnit["via"]): DecisionUnit => ({
  occurrenceId: r.id,
  runId: r.run_id,
  outcomeKey: r.outcome_key,
  subjectService: r.subject_service,
  subjectId: r.subject_id,
  quantity: r.quantity,
  declaredAt: iso(r.declared_at),
  credit,
  via,
});

async function ownUnits(tx: Exec, decisionIds: string[]): Promise<{ found: Set<string>; rows: OccRow[] }> {
  const rows = (await tx.execute(sql`
    WITH RECURSIVE d AS MATERIALIZED (
      SELECT r.id, r.script_slug, r.workflow_slug
      FROM unnest(${uuidArray(decisionIds)}::uuid[]) AS i(id)
      CROSS JOIN LATERAL (SELECT id, script_slug, workflow_slug FROM runs WHERE id = i.id OFFSET 0) r
    ),
    sub(decision_id, run_id, ds, dw, depth) AS (
      SELECT id, id, script_slug, workflow_slug, 0 FROM d
      UNION ALL
      SELECT sub.decision_id, c.id, sub.ds, sub.dw, sub.depth + 1
      FROM sub
      CROSS JOIN LATERAL (
        SELECT c.id FROM runs c
        WHERE c.parent_run_id = sub.run_id
          AND CASE WHEN sub.ds IS NOT NULL THEN c.script_slug IS NULL OR c.script_slug = sub.ds
                   WHEN sub.dw IS NOT NULL THEN c.script_slug IS NULL AND (c.workflow_slug IS NULL OR c.workflow_slug = sub.dw)
                   ELSE c.script_slug IS NULL AND c.workflow_slug IS NULL END
        OFFSET 0
      ) c
      WHERE sub.depth < ${MAX_ANCESTOR_DEPTH}
    )
    SELECT d.id AS decision_id, NULL::uuid AS id, NULL::uuid AS run_id, NULL AS outcome_key, NULL AS subject_service,
           NULL AS subject_id, NULL AS quantity, NULL::timestamptz AS declared_at
    FROM d
    UNION ALL
    SELECT sub.decision_id, o.id, o.run_id, o.outcome_key, o.subject_service, o.subject_id, o.quantity::text, o.declared_at
    FROM sub
    JOIN run_outcomes o ON o.run_id = sub.run_id AND o.direction = 'produced'
    WHERE NOT EXISTS (SELECT 1 FROM run_outcome_reversals rv WHERE rv.occurrence_id = o.id)
  `)) as OccRow[];
  const found = new Set<string>();
  const out: OccRow[] = [];
  for (const r of rows) {
    if (r.id === null) found.add(r.decision_id);
    else out.push(r);
  }
  out.sort((a, b) => (iso(a.declared_at) < iso(b.declared_at) ? -1 : iso(a.declared_at) > iso(b.declared_at) ? 1 : a.id < b.id ? -1 : 1));
  return { found, rows: out };
}

/** Consumptions resolving to one of `own`, with what each consuming run's anchor produced for the same subject. */
async function downstreamUnits(tx: Exec, own: OccRow[]): Promise<Array<{ via: OccRow; consumptionId: string; consumingRunId: string; unit: OccRow }>> {
  if (own.length === 0) return [];
  const ownRows = JSON.stringify(own.map((o) => ({ id: o.id, k: o.outcome_key, s: o.subject_service, i: o.subject_id })));
  const target = sql`
    WITH own AS (SELECT * FROM jsonb_to_recordset(${ownRows}::jsonb) AS x(id uuid, k text, s text, i text)),
    canon AS (
      SELECT DISTINCT o.k, COALESCE(e.target_service, o.s) AS cs, COALESCE(e.target_id, o.i) AS cid
      FROM own o LEFT JOIN subject_equivalences e ON e.subject_service = o.s AND e.subject_id = o.i
    ),
    mem AS (
      SELECT k, cs AS ms, cid AS mid FROM canon
      UNION
      SELECT c.k, e.subject_service, e.subject_id FROM canon c JOIN subject_equivalences e ON e.target_service = c.cs AND e.target_id = c.cid
    )
    SELECT c.id FROM mem m
    CROSS JOIN LATERAL (
      SELECT id FROM run_outcomes c
      WHERE c.direction = 'consumed' AND c.subject_service = m.ms AND c.subject_id = m.mid AND c.outcome_key = m.k
      OFFSET 0
    ) c`;
  const byId = new Map(own.map((o) => [o.id, o]));
  const resolved = (await resolveConsumptions(target, tx)).filter((c) => c.producerId !== null && byId.has(c.producerId));
  if (resolved.length === 0) return [];

  const cons = JSON.stringify(resolved.map((c) => ({ c: c.id, r: c.runId })));
  const rows = (await tx.execute(sql`
    WITH RECURSIVE cons AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(${cons}::jsonb) AS x(c uuid, r uuid)),
    walk(consumption_id, cur_id, parent_id, depth, produced, marked) AS (
      SELECT k.c, r.id, r.parent_run_id, 0,
             EXISTS (SELECT 1 FROM run_outcomes o WHERE o.run_id = r.id AND o.direction = 'produced'),
             EXISTS (SELECT 1 FROM run_support_marks m WHERE m.run_id = r.id)
      FROM cons k CROSS JOIN LATERAL (SELECT id, parent_run_id FROM runs WHERE id = k.r OFFSET 0) r
      UNION ALL
      SELECT w.consumption_id, p.id, p.parent_run_id, w.depth + 1,
             EXISTS (SELECT 1 FROM run_outcomes o WHERE o.run_id = p.id AND o.direction = 'produced'),
             EXISTS (SELECT 1 FROM run_support_marks m WHERE m.run_id = p.id)
      FROM walk w CROSS JOIN LATERAL (SELECT id, parent_run_id FROM runs WHERE id = w.parent_id OFFSET 0) p
      WHERE NOT w.produced AND NOT w.marked AND w.parent_id IS NOT NULL AND w.depth < ${MAX_ANCESTOR_DEPTH}
    ),
    anchor AS MATERIALIZED (SELECT consumption_id, cur_id FROM walk WHERE produced),
    csub AS MATERIALIZED (
      SELECT c.id AS consumption_id, COALESCE(e.target_service, c.subject_service) AS cs, COALESCE(e.target_id, c.subject_id) AS cid
      FROM run_outcomes c LEFT JOIN subject_equivalences e ON e.subject_service = c.subject_service AND e.subject_id = c.subject_id
      WHERE c.id IN (SELECT c FROM cons)
    ),
    cmem AS (
      SELECT consumption_id, cs AS ms, cid AS mid FROM csub
      UNION
      SELECT s.consumption_id, e.subject_service, e.subject_id FROM csub s JOIN subject_equivalences e ON e.target_service = s.cs AND e.target_id = s.cid
    )
    SELECT a.consumption_id, o.id, o.run_id, o.outcome_key, o.subject_service, o.subject_id, o.quantity::text AS quantity, o.declared_at
    FROM anchor a
    JOIN run_outcomes o ON o.run_id = a.cur_id AND o.direction = 'produced'
    JOIN cmem m ON m.consumption_id = a.consumption_id AND m.ms = o.subject_service AND m.mid = o.subject_id
    WHERE NOT EXISTS (SELECT 1 FROM run_outcome_reversals rv WHERE rv.occurrence_id = o.id)
    ORDER BY o.declared_at, o.id
  `)) as any[];
  const resolvedById = new Map(resolved.map((c) => [c.id, c]));
  return rows.map((r) => {
    const c = resolvedById.get(r.consumption_id)!;
    return { via: byId.get(c.producerId!)!, consumptionId: c.id, consumingRunId: c.runId, unit: { ...r, decision_id: "" } };
  });
}

/** The Units of each decision named (<= MAX_DECISIONS_PER_CALL). Unknown run = found false, no Units. */
export async function readDecisionUnits(decisionIds: string[]): Promise<DecisionUnits[]> {
  const ids = [...new Set(decisionIds)];
  return statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '100s'`);
    const { found, rows } = await ownUnits(tx, ids);
    const downstream = await downstreamUnits(tx, rows);
    const out = new Map<string, DecisionUnits>(ids.map((id) => [id, { decisionRunId: id, found: found.has(id), units: [] }]));
    const seen = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));
    for (const r of rows) {
      out.get(r.decision_id)!.units.push(unitOf(r, "own", null));
      seen.get(r.decision_id)!.add(r.id);
    }
    for (const d of downstream) {
      const decision = d.via.decision_id;
      // An occurrence already credited (own, or through another of the decision's Units) counts once.
      if (seen.get(decision)!.has(d.unit.id)) continue;
      seen.get(decision)!.add(d.unit.id);
      out.get(decision)!.units.push(
        unitOf(d.unit, "downstream", { occurrenceId: d.via.id, outcomeKey: d.via.outcome_key, consumptionId: d.consumptionId, consumingRunId: d.consumingRunId }),
      );
    }
    return ids.map((id) => out.get(id)!);
  });
}

// ---------------------------------------------------------------------------
// Which decisions' Units may have moved since a cursor
// ---------------------------------------------------------------------------

export class DecisionCursorError extends Error {
  constructor(message: string, readonly expired = false) {
    super(message);
  }
}

interface ChangesCursor {
  v: 1;
  /** Facts recorded after this instant are not read yet. */
  a: string;
}

const encode = (c: ChangesCursor) => Buffer.from(JSON.stringify(c)).toString("base64url");

function decode(raw: string): ChangesCursor {
  let c: ChangesCursor;
  try {
    c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new DecisionCursorError("cursor is not a cursor this read served");
  }
  if (c?.v !== 1 || typeof c.a !== "string" || Number.isNaN(Date.parse(c.a))) throw new DecisionCursorError("cursor is not a cursor this read served");
  if (Date.now() - Date.parse(c.a) > CURSOR_MAX_AGE_MS) {
    throw new DecisionCursorError("cursor is older than 30 days: its facts may be archived; restart without a cursor", true);
  }
  return c;
}

export interface DecisionChangesPage {
  decisionRunIds: string[];
  nextCursor: string;
  caughtUp: boolean;
  coveredUntil: string;
}

/**
 * Decisions whose Units may have moved in (cursor, window end]: every outcome fact
 * recorded then (a declaration, a reversal, a void, a re-date, a relabel) moves
 * (1) the decision of the run it was recorded on, and (2) for each consumption on
 * that run, the decision of the run that produced what it consumed (its downstream
 * Units). Cursor absent = start now (nothing listed): take it BEFORE reading
 * decision Units for the first time.
 */
export async function readDecisionChanges(rawCursor: string | undefined, now = new Date()): Promise<DecisionChangesPage> {
  const lagEnd = now.getTime() - decisionChangesLagMs();
  if (!rawCursor) {
    const a = new Date(lagEnd).toISOString();
    return { decisionRunIds: [], nextCursor: encode({ v: 1, a }), caughtUp: true, coveredUntil: a };
  }
  const c = decode(rawCursor);
  const end = Math.min(Date.parse(c.a) + CHANGES_WINDOW_MS, lagEnd);
  if (end <= Date.parse(c.a)) return { decisionRunIds: [], nextCursor: rawCursor, caughtUp: true, coveredUntil: c.a };
  const b = new Date(end).toISOString();

  const decisions = await statsDb.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout = '100s'`);
    const runRows = (await tx.execute(sql`
      SELECT DISTINCT run_id FROM outcome_declaration_events
      WHERE event_type NOT IN ('run.support_marked', 'run.support_unmarked')
        AND occurred_at > ${c.a}::timestamptz AND occurred_at <= ${b}::timestamptz
    `)) as Array<{ run_id: string }>;
    const runIds = runRows.map((r) => r.run_id);
    if (runIds.length === 0) return new Set<string>();
    const consumptions = await resolveConsumptions(
      sql`SELECT c.id FROM unnest(${uuidArray(runIds)}::uuid[]) AS i(id)
          CROSS JOIN LATERAL (SELECT id FROM run_outcomes c WHERE c.run_id = i.id AND c.direction = 'consumed' OFFSET 0) c`,
      tx,
    );
    const producers = consumptions.map((x) => x.producerRunId).filter((x): x is string => x !== null);
    const chains = await readChains(tx, [...runIds, ...producers]);
    const out = new Set<string>();
    for (const id of [...runIds, ...producers]) {
      const d = decisionOfChain(chains.get(id));
      if (d.id) out.add(d.id);
    }
    return out;
  });
  return {
    decisionRunIds: [...decisions].sort(),
    nextCursor: encode({ v: 1, a: b }),
    caughtUp: end >= lagEnd,
    coveredUntil: b,
  };
}
