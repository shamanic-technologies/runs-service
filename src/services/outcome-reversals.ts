// Reversing a produced occurrence (LEDGER-REVERSAL-1107, owner 2026-11-07: every figure the
// dashboard reads comes from this ledger, so a Unit whose fact was taken back must stop counting).
//
// Industrial accounting: a REVERSING ENTRY, never a delete. The occurrence stays in run_outcomes
// with its declaration day; a reversal dated when the fact stopped standing (`reversedAt`) is a
// counter-entry of -1 Unit on THAT UTC day, so:
//   - a count over a range ending before the reversal reads the Unit (the past recomputes as it was);
//   - a count over a range covering the reversal does not (it nets to zero);
//   - per day: +1 on the declaration day, -1 on the reversal day.
//
// Money: the reversal moves NO cost. The spend that made the Unit was spent: its v6 share stays on
// the days it was allocated, and the Units that stand carry it in their unit cost over any range that
// covers the reversal (cost of a failed Unit absorbed by the good ones, process costing's normal
// spoilage). Consumptions are untouched too (what was consumed was consumed; a consumption that
// resolved to the reversed occurrence keeps its provenance and standard cost). The allocation rule is
// unchanged (v6): no stored day moves but the reversal's own.
//
// Who: the service that DECLARED the occurrence (the `outcomes.declared` event that projected it
// names its source service; a row with no named source = the run's own service). Nobody else.
// Idempotent: a reversed occurrence answers `already_reversed` with the stored reversal, nothing
// written. Final: there is no un-reverse; a fact that comes back is declared again as a new Unit.

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { outcomeDeclarationEvents } from "../db/schema.js";
import { ALLOCATION_VERSION, normalizeOutcomeKey, utcDay } from "./outcome-ledger.js";

export const MAX_REVERSALS_PER_CALL = 1000;

export interface ReversalInput {
  runId: string;
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  /** ISO instant the fact stopped standing; absent = now. */
  reversedAt?: string;
  reason: string;
}

export interface ReversalResult {
  occurrenceId: string;
  runId: string;
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  declaredAt: string;
  reversedAt: string;
  recordedAt: string;
  reason: string;
  reversedBy: string;
  status: "reversed" | "already_reversed";
}

export interface ReversalRefusal {
  runId: string;
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  reason: "occurrence_not_found" | "run_org_mismatch" | "invalid_reversed_at" | "not_occurrence_declarer";
  message?: string;
}

export class ReversalRefusedError extends Error {
  constructor(public readonly refusals: ReversalRefusal[], public readonly notDeclarer: boolean) {
    super(notDeclarer ? "not_occurrence_declarer" : "invalid_reversals");
  }
}

const iso = (d: unknown) => new Date(d as string).toISOString();

/**
 * Reverses the stated produced occurrences, all or nothing: every item is checked first (the
 * occurrence exists on that run under that key and subject, the caller declared it, the run is
 * the caller's org when one is stated, reversedAt within [its declaration, now]); any refusal =
 * nothing written. One bronze `outcomes.reversed` event per run, in one transaction holding the
 * occurrences' row locks, so two racing calls write the reversal once.
 */
export async function reverseOccurrences(
  items: ReversalInput[],
  reversedBy: string,
  callerService: string,
  callerOrgId: string | undefined,
): Promise<ReversalResult[]> {
  const keyed = items.map((i) => ({
    run_id: i.runId.toLowerCase(),
    outcome_key: normalizeOutcomeKey(i.outcomeKey),
    subject_service: i.subjectService,
    subject_id: i.subjectId,
  }));
  return db.transaction(async (tx) => {
    const found = (await tx.execute(sql`
      SELECT k.ord::int AS ord, o.id, o.run_id, o.outcome_key, o.subject_service, o.subject_id, o.declared_at,
             r.organization_id::text AS org_id,
             COALESCE((
               SELECT e.source_service FROM outcome_declaration_events e
               CROSS JOIN LATERAL jsonb_to_recordset(e.payload->'items') AS it(id uuid)
               WHERE e.run_id = o.run_id AND e.event_type = 'outcomes.declared' AND it.id = o.id AND e.source_service IS NOT NULL
               LIMIT 1
             ), r.service_name) AS declarer,
             r.service_name AS run_service,
             EXISTS (
               SELECT 1 FROM outcome_declaration_events e
               CROSS JOIN LATERAL jsonb_to_recordset(e.payload->'items') AS it(id uuid)
               WHERE e.run_id = o.run_id AND e.event_type = 'outcomes.declared' AND it.id = o.id
                 AND e.payload->>'runOwnerHolds' = 'true'
             ) AS run_owner_holds
      FROM jsonb_to_recordset(${JSON.stringify(keyed.map((k, ord) => ({ ...k, ord })))}::jsonb)
        AS k(ord int, run_id uuid, outcome_key text, subject_service text, subject_id text)
      JOIN run_outcomes o
        ON o.run_id = k.run_id AND o.direction = 'produced' AND o.outcome_key = k.outcome_key
       AND o.subject_service = k.subject_service AND o.subject_id = k.subject_id
      JOIN runs r ON r.id = o.run_id
      ORDER BY o.id
      FOR UPDATE OF o
    `)) as any[];
    const byOrd = new Map(found.map((f) => [Number(f.ord), f]));
    // Read after the locks: a racing call's reversal is visible to this statement.
    const ids = found.map((f) => f.id as string);
    const prior = ids.length
      ? ((await tx.execute(sql`
          SELECT occurrence_id, reversed_at, recorded_at, reason, reversed_by FROM run_outcome_reversals
          WHERE occurrence_id = ANY(${`{${ids.join(",")}}`}::uuid[])
        `)) as any[])
      : [];
    const priorById = new Map(prior.map((p) => [p.occurrence_id as string, p]));
    const now = new Date();
    const refusals: ReversalRefusal[] = [];
    const plan = items.map((item, ord) => {
      const k = keyed[ord];
      const ref = { runId: k.run_id, outcomeKey: k.outcome_key, subjectService: k.subject_service, subjectId: k.subject_id };
      const f = byOrd.get(ord);
      if (!f) return refusals.push({ ...ref, reason: "occurrence_not_found", message: "no produced occurrence of this key and subject on this run" }), null;
      // RUN-DOOR-DECLARER-1110: a row declared over a run door is held by its declarer AND the run's owner.
      if (f.declarer !== callerService && !(f.run_owner_holds && f.run_service === callerService)) {
        return refusals.push({ ...ref, reason: "not_occurrence_declarer", message: `declared by ${f.declarer}: only the declaring service reverses it` }), null;
      }
      if (callerOrgId && f.org_id !== callerOrgId) return refusals.push({ ...ref, reason: "run_org_mismatch" }), null;
      const at = item.reversedAt ? new Date(item.reversedAt) : now;
      const declaredAt = new Date(f.declared_at);
      if (at.getTime() < declaredAt.getTime() || at.getTime() > now.getTime() + 60_000) {
        return refusals.push({ ...ref, reason: "invalid_reversed_at", message: `reversedAt must be between the occurrence's declaration (${declaredAt.toISOString()}) and now` }), null;
      }
      return { ord, f, at, reason: item.reason };
    });
    if (refusals.length > 0) {
      throw new ReversalRefusedError(refusals, refusals.some((r) => r.reason === "not_occurrence_declarer"));
    }
    const fresh = plan.filter((p) => p !== null && !priorById.has(p.f.id)) as Array<NonNullable<(typeof plan)[number]>>;
    const byRun = new Map<string, typeof fresh>();
    for (const p of fresh) byRun.set(p.f.run_id, [...(byRun.get(p.f.run_id) ?? []), p]);
    for (const [runId, rows] of byRun) {
      await tx.insert(outcomeDeclarationEvents).values({
        runId,
        eventType: "outcomes.reversed",
        sourceService: callerService,
        payload: {
          allocationVersion: ALLOCATION_VERSION,
          reversedBy,
          // The UTC days the counter-entries land on (the only stored days they move).
          affectedDays: [...new Set(rows.map((p) => utcDay(p.at)))].sort(),
          items: rows.map((p) => ({
            id: p.f.id,
            outcome_key: p.f.outcome_key,
            subject_service: p.f.subject_service,
            subject_id: p.f.subject_id,
            declared_at: iso(p.f.declared_at),
            reversed_at: p.at.toISOString(),
            reason: p.reason,
            reversed_by: reversedBy,
          })),
        },
      });
    }
    const stored = ids.length
      ? ((await tx.execute(sql`
          SELECT occurrence_id, reversed_at, recorded_at, reason, reversed_by FROM run_outcome_reversals
          WHERE occurrence_id = ANY(${`{${ids.join(",")}}`}::uuid[])
        `)) as any[])
      : [];
    const storedById = new Map(stored.map((s) => [s.occurrence_id as string, s]));
    return plan.map((p) => {
      const { f } = p!;
      const s = storedById.get(f.id)!;
      return {
        occurrenceId: f.id,
        runId: f.run_id,
        outcomeKey: f.outcome_key,
        subjectService: f.subject_service,
        subjectId: f.subject_id,
        declaredAt: iso(f.declared_at),
        reversedAt: iso(s.reversed_at),
        recordedAt: iso(s.recorded_at),
        reason: s.reason,
        reversedBy: s.reversed_by,
        status: priorById.has(f.id) ? "already_reversed" : "reversed",
      };
    });
  });
}
