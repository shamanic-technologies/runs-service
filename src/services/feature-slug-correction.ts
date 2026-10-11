// Feature-slug correction: fill the feature slug a writer failed to state on a run
// subtree (instantly-service opened AI Instant Call parent runs without one until
// v0.83.35; runs-service copies a parent's slug to its children, so the whole
// subtree carried none and every per-campaign money read filtered by the
// campaign's feature slug read that spend as $0).
//
// The correction is recorded as one bronze `run.feature_slug_corrected` event per
// run (payload: featureSlug, reason, correctedBy) — the audit trail — and the
// projection trigger (migration 0044) fills `runs.feature_slug`. It ONLY fills a
// NULL slug: a run that states one keeps it, and the walk does not descend below a
// run labelled with ANOTHER slug (a sourcing serve under an outreach run keeps its
// own subtree). Rollups keyed on feature_slug follow by their UPDATE OF triggers.
// Cost amounts are never touched. Idempotent: a re-run finds nothing NULL.

import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { logRunLifecycle } from "./bronze.js";

export type FeatureSlugCorrectionInput = {
  rootRunIds: string[];
  featureSlug: string;
  reason: string;
  correctedBy: string;
};

export type FeatureSlugCorrectionResult =
  | { kind: "ok"; correctedRunIds: string[] }
  | { kind: "missing"; missingRunIds: string[] }
  | { kind: "conflict"; conflictingRuns: { runId: string; featureSlug: string }[] };

type RootRow = { id: string; feature_slug: string | null };
type TargetRow = {
  id: string;
  organization_id: string | null;
  user_id: string | null;
  brand_ids: string[] | null;
  campaign_id: string | null;
  workflow_slug: string | null;
};

export async function correctFeatureSlug(
  input: FeatureSlugCorrectionInput
): Promise<FeatureSlugCorrectionResult> {
  const rootIds = [...new Set(input.rootRunIds)];
  const { featureSlug, reason, correctedBy } = input;

  return db.transaction(async (tx) => {
    const idList = sql.join(rootIds.map((id) => sql`${id}::uuid`), sql`, `);
    const roots = (await tx.execute(sql`
      SELECT id, feature_slug FROM runs WHERE id IN (${idList}) FOR UPDATE
    `)) as unknown as RootRow[];

    const found = new Set(roots.map((r) => r.id));
    const missingRunIds = rootIds.filter((id) => !found.has(id));
    if (missingRunIds.length > 0) return { kind: "missing" as const, missingRunIds };

    const conflictingRuns = roots
      .filter((r) => r.feature_slug !== null && r.feature_slug !== featureSlug)
      .map((r) => ({ runId: r.id, featureSlug: r.feature_slug as string }));
    if (conflictingRuns.length > 0) return { kind: "conflict" as const, conflictingRuns };

    // Bounded recursive walk anchored on the roots (idx_runs_parent), descending
    // only through runs that carry no slug or this slug.
    const targets = (await tx.execute(sql`
      WITH RECURSIVE walk AS (
        SELECT id, feature_slug FROM runs WHERE id IN (${idList})
        UNION
        SELECT c.id, c.feature_slug
          FROM runs c
          JOIN walk w ON c.parent_run_id = w.id
         WHERE c.feature_slug IS NULL OR c.feature_slug = ${featureSlug}
      )
      SELECT r.id, r.organization_id, r.user_id, r.brand_ids, r.campaign_id, r.workflow_slug
        FROM runs r
        JOIN walk w ON w.id = r.id
       WHERE r.feature_slug IS NULL
       ORDER BY r.started_at, r.id
         FOR UPDATE OF r
    `)) as unknown as TargetRow[];

    for (const row of targets) {
      await logRunLifecycle(tx, {
        runId: row.id,
        eventType: "run.feature_slug_corrected",
        payload: { featureSlug, previousFeatureSlug: null, reason, correctedBy },
        identity: {
          orgId: row.organization_id,
          userId: row.user_id,
          brandIds: row.brand_ids,
          campaignId: row.campaign_id,
          workflowSlug: row.workflow_slug,
          featureSlug,
        },
        sourceService: correctedBy,
      });
    }

    return { kind: "ok" as const, correctedRunIds: targets.map((t) => t.id) };
  });
}
