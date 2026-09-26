import { Router } from "express";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { requireApiKey } from "../middleware/auth.js";
import { parseCampaignIds } from "../services/campaign-ids.js";

// GET /v1/stats/run-outcomes — how the runs of a group ENDED, and how long they
// took: completed / failed / still running, the success rate, and the median
// duration of the completed ones. The dashboard's per-crew cards ("97% success,
// 38 failed", "median run 1m 52s") read it per campaign.
//
// Scope. A campaign's work is a tree: the campaign's ENTRY run (in practice
// `workflow / execute-workflow`, started by campaign-service or api-service,
// neither of which carries the campaign) fans out into child service calls that
// all carry the same campaign id. Counting every node would weigh one agent run
// as ~15 runs and report a service call's 2 s as the run's duration. So the
// default `scope=entry` counts a run only when its parent is not a run of the
// same campaign (or it has no parent): one row per run the agent actually
// started. `scope=all` counts every run the filters match, i.e. exactly what
// GET /v1/runs lists for the same filters.

const router = Router();

// Run-side dimensions only: every group is a plain GROUP BY on `runs`, so a run
// lands in exactly one group and the median is taken over that group's own runs.
const GROUP_BY_COLUMNS: Record<string, string> = {
  campaignId: "r.campaign_id",
  workflowSlug: "r.workflow_slug",
  featureSlug: "r.feature_slug",
  serviceName: "r.service_name",
  taskName: "r.task_name",
};

const SCOPES = ["entry", "all"] as const;
type Scope = (typeof SCOPES)[number];

interface OutcomeRow {
  run_count: string | number;
  completed_count: string | number;
  failed_count: string | number;
  running_count: string | number;
  median_duration_ms: string | number | null;
  min_started_at: string | Date | null;
  max_started_at: string | Date | null;
  [dim: string]: unknown;
}

router.get("/v1/stats/run-outcomes", requireApiKey, async (req, res) => {
  try {
    const {
      groupBy = "campaignId",
      scope: scopeParam = "entry",
      brandId,
      campaignId,
      campaignIds: campaignIdsParam,
      workflowSlug,
      featureSlug,
      serviceName,
      taskName,
      startedAfter,
      startedBefore,
    } = req.query as Record<string, string | undefined>;

    if (!SCOPES.includes(scopeParam as Scope)) {
      res.status(400).json({ error: `Invalid scope. Allowed: ${SCOPES.join(", ")}` });
      return;
    }
    const scope = scopeParam as Scope;

    const keys = [...new Set(groupBy.split(",").map((s) => s.trim()).filter(Boolean))];
    const invalid = keys.filter((k) => !GROUP_BY_COLUMNS[k]);
    if (keys.length === 0 || invalid.length > 0) {
      res.status(400).json({
        error: `Invalid groupBy values: ${invalid.join(", ") || "(empty)"}. Allowed: ${Object.keys(GROUP_BY_COLUMNS).join(", ")}`,
      });
      return;
    }

    const parsedCampaignIds = parseCampaignIds(campaignIdsParam);
    if (parsedCampaignIds.error) {
      res.status(400).json({ error: parsedCampaignIds.error });
      return;
    }

    for (const [name, value] of [["startedAfter", startedAfter], ["startedBefore", startedBefore]] as const) {
      if (value !== undefined && Number.isNaN(Date.parse(value))) {
        res.status(400).json({ error: `${name} must be an ISO 8601 date-time` });
        return;
      }
    }

    const parts: SQL[] = [sql`r.organization_id = ${req.orgId}`];
    if (brandId) parts.push(sql`${brandId} = ANY(r.brand_ids)`);
    if (campaignId) parts.push(sql`r.campaign_id = ${campaignId}`);
    if (parsedCampaignIds.ids) {
      parts.push(sql`r.campaign_id IN (${sql.join(parsedCampaignIds.ids.map((id) => sql`${id}`), sql`, `)})`);
    }
    if (workflowSlug) parts.push(sql`r.workflow_slug = ${workflowSlug}`);
    if (featureSlug) parts.push(sql`r.feature_slug = ${featureSlug}`);
    if (serviceName) parts.push(sql`r.service_name = ${serviceName}`);
    if (taskName) parts.push(sql`r.task_name = ${taskName}`);
    if (startedAfter) parts.push(sql`r.started_at >= ${startedAfter}::timestamptz`);
    if (startedBefore) parts.push(sql`r.started_at <= ${startedBefore}::timestamptz`);
    if (scope === "entry") {
      // PK lookup per candidate run; the parent is never window-filtered, so a
      // child whose parent started before `startedAfter` is still a child.
      parts.push(sql`NOT EXISTS (
        SELECT 1 FROM runs p
        WHERE p.id = r.parent_run_id AND p.campaign_id IS NOT DISTINCT FROM r.campaign_id
      )`);
    }
    const where = sql.join(parts, sql` AND `);

    const dimSelect = sql.raw(keys.map((k, i) => `${GROUP_BY_COLUMNS[k]} AS d${i}`).join(", "));
    const dimRefs = sql.raw(keys.map((_, i) => `${i + 1}`).join(", "));

    // Statuses are enumerated, never negated: a future status counts toward
    // runCount only, not toward completed/failed/running.
    const rows = (await db.execute(sql`
      SELECT ${dimSelect},
        COUNT(*) AS run_count,
        COUNT(*) FILTER (WHERE r.status = 'completed') AS completed_count,
        COUNT(*) FILTER (WHERE r.status = 'failed') AS failed_count,
        COUNT(*) FILTER (WHERE r.status = 'running') AS running_count,
        round(
          percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r.completed_at - r.started_at)) * 1000)
            FILTER (WHERE r.status = 'completed' AND r.completed_at IS NOT NULL)
        ) AS median_duration_ms,
        MIN(r.started_at) AS min_started_at,
        MAX(r.started_at) AS max_started_at
      FROM runs r
      WHERE ${where}
      GROUP BY ${dimRefs}
      ORDER BY run_count DESC, ${dimRefs}
    `)) as unknown as OutcomeRow[];

    const groups = rows.map((row) => {
      const dimensions: Record<string, string | null> = {};
      keys.forEach((k, i) => {
        dimensions[k] = (row[`d${i}`] as string | null) ?? null;
      });
      const completedCount = Number(row.completed_count);
      const failedCount = Number(row.failed_count);
      const ended = completedCount + failedCount;
      return {
        dimensions,
        runCount: Number(row.run_count),
        completedCount,
        failedCount,
        runningCount: Number(row.running_count),
        successRate: ended > 0 ? completedCount / ended : null,
        medianDurationMs: row.median_duration_ms === null ? null : Number(row.median_duration_ms),
        minStartedAt: row.min_started_at ? new Date(row.min_started_at).toISOString() : null,
        maxStartedAt: row.max_started_at ? new Date(row.max_started_at).toISOString() : null,
      };
    });

    res.json({ scope, groups });
  } catch (err) {
    console.error("[Runs Service] Error in GET /v1/stats/run-outcomes:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
