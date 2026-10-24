// SUBJECT-EQUIVALENCE-1024: the owner of a subject states it is the same subject
// as another (one occurrence, two subject spaces). The consumption resolver
// (outcome-ledger.ts) matches a consumption to a production on either side; the
// ledger never infers an equivalence. One hop, immutable rows (migration 0073).

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export interface EquivalenceItem {
  subjectService: string;
  subjectId: string;
  targetService: string;
  targetId: string;
}

export type EquivalenceRefusal = {
  index: number;
  reason: "not_subject_owner" | "same_subject" | "conflicting_target" | "target_is_a_source" | "source_is_a_target" | "stated_twice";
};

export class EquivalenceRefusedError extends Error {
  constructor(public readonly refusals: EquivalenceRefusal[]) {
    super("subject equivalences refused");
  }
}

const key = (s: string, id: string) => `${s}\u0000${id}`;

/**
 * Records the items (all or nothing). `owner` must own every SOURCE subject
 * (subjectService = the caller). Idempotent: an item already recorded with the
 * same target is `already_recorded`; another target is refused (rows are immutable).
 */
export async function stateEquivalences(
  items: EquivalenceItem[],
  owner: string,
  stated: { reason: string; statedBy: string },
): Promise<Array<{ status: "recorded" | "already_recorded" }>> {
  return db.transaction(async (tx) => {
    // Serialize writers: the one-hop checks read rows another writer may be adding.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('subject_equivalences'))`);
    const refusals: EquivalenceRefusal[] = [];
    const seen = new Map<string, number>();
    items.forEach((it, i) => {
      if (it.subjectService !== owner) refusals.push({ index: i, reason: "not_subject_owner" });
      if (it.subjectService === it.targetService && it.subjectId === it.targetId) refusals.push({ index: i, reason: "same_subject" });
      const k = key(it.subjectService, it.subjectId);
      if (seen.has(k)) refusals.push({ index: i, reason: "stated_twice" });
      seen.set(k, i);
    });
    const sources = new Set(items.map((it) => key(it.subjectService, it.subjectId)));
    const targets = new Set(items.map((it) => key(it.targetService, it.targetId)));
    const json = JSON.stringify(items);
    const existing = (await tx.execute(sql`
      SELECT e.subject_service, e.subject_id, e.target_service, e.target_id
      FROM subject_equivalences e
      WHERE (e.subject_service, e.subject_id) IN (
              SELECT x->>'subjectService', x->>'subjectId' FROM jsonb_array_elements(${json}::jsonb) x
              UNION ALL SELECT x->>'targetService', x->>'targetId' FROM jsonb_array_elements(${json}::jsonb) x)
         OR (e.target_service, e.target_id) IN (SELECT x->>'subjectService', x->>'subjectId' FROM jsonb_array_elements(${json}::jsonb) x)
    `)) as any[];
    const bySource = new Map(existing.map((e) => [key(e.subject_service, e.subject_id), e]));
    const existingTargets = new Set(existing.map((e) => key(e.target_service, e.target_id)));
    const status = items.map((it, i) => {
      const prior = bySource.get(key(it.subjectService, it.subjectId));
      if (prior) {
        if (prior.target_service !== it.targetService || prior.target_id !== it.targetId) refusals.push({ index: i, reason: "conflicting_target" });
        return "already_recorded" as const;
      }
      if (bySource.has(key(it.targetService, it.targetId)) || sources.has(key(it.targetService, it.targetId))) refusals.push({ index: i, reason: "target_is_a_source" });
      if (existingTargets.has(key(it.subjectService, it.subjectId)) || targets.has(key(it.subjectService, it.subjectId))) refusals.push({ index: i, reason: "source_is_a_target" });
      return "recorded" as const;
    });
    if (refusals.length > 0) throw new EquivalenceRefusedError(refusals);
    const fresh = items.filter((_, i) => status[i] === "recorded");
    if (fresh.length > 0) {
      await tx.execute(sql`
        INSERT INTO subject_equivalences (subject_service, subject_id, target_service, target_id, stated_by, reason)
        SELECT x->>'subjectService', x->>'subjectId', x->>'targetService', x->>'targetId', ${stated.statedBy}, ${stated.reason}
        FROM jsonb_array_elements(${JSON.stringify(fresh)}::jsonb) x
      `);
    }
    return status.map((s) => ({ status: s }));
  });
}
