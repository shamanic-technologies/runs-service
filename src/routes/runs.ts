import { Router } from "express";
import { eq, and, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import { db } from "../db/index.js";
import { runs, runsCosts } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import {
  resolveMultipleUnitCosts,
  CostNotFoundError,
  UpstreamError,
} from "../services/cost-resolver.js";
import { notifyUsage } from "../services/billing.js";
import {
  logRunLifecycle,
  logCostLifecycle,
  newRunId,
  newCostId,
  type Identity,
} from "../services/bronze.js";
import {
  CreateRunRequestSchema,
  UpdateRunRequestSchema,
  AddCostsRequestSchema,
  UpdateCostRequestSchema,
  BatchCostsRequestSchema,
  BatchRunsRequestSchema,
} from "../schemas.js";

const router = Router();

// ---------------------------------------------------------------------------
// Phase 4 — Org-level platform spend reads from v_org_platform_spend gold view.
// All math in Postgres. Single source of truth for the platform-projected
// predicate (uses runs_costs.is_platform_projected generated column).
// ---------------------------------------------------------------------------
async function fetchOrgPlatformSpent(orgId: string): Promise<string> {
  // Inline JOIN with is_platform_projected generated col + partial index.
  // Gold view v_org_platform_spend removed (filter pushdown unreliable through GROUP BY).
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(rc.total_cost_in_usd_cents), 0)::text AS spent_cents
      FROM runs r
      JOIN runs_costs rc ON rc.run_id = r.id
     WHERE r.organization_id = ${orgId}
       AND rc.is_platform_projected
  `);
  const rows = result as any[];
  return new Decimal(rows[0]?.spent_cents ?? 0).toFixed(10);
}

// ---------------------------------------------------------------------------
// Phase 2+5 — POST /v1/runs.
// App writes ONLY to bronze (run_lifecycle_events). Trigger
// project_run_lifecycle_to_silver projects to runs in same txn.
// Idempotent replay (200 path) does NOT write bronze — bronze captures state
// changes, not HTTP traffic.
// ---------------------------------------------------------------------------
router.post("/v1/runs", requireApiKey, async (req, res) => {
  try {
    const parsed = CreateRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { brandIds, campaignId, workflowSlug, featureSlug, serviceName, taskName, idempotencyKey } = parsed.data;
    const parentRunId = req.runId || null;

    // Idempotency pre-check
    if (idempotencyKey) {
      const [existing] = await db
        .select()
        .from(runs)
        .where(eq(runs.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existing) {
        if (existing.serviceName !== serviceName || existing.taskName !== taskName) {
          res.status(409).json({
            error: "idempotencyKey collision with different (serviceName, taskName)",
            existing: { id: existing.id, serviceName: existing.serviceName, taskName: existing.taskName },
          });
          return;
        }
        res.status(200).json(existing);
        return;
      }
    }

    let resolvedBrandIds = req.headerBrandIds || brandIds || null;
    let resolvedCampaignId = req.headerCampaignId || campaignId || null;
    let resolvedWorkflowSlug = req.headerWorkflowSlug || workflowSlug || null;
    let resolvedFeatureSlug = req.headerFeatureSlug || featureSlug || null;
    let resolvedOrgId = req.orgId;
    let resolvedUserId = req.userId || null;

    if (parentRunId) {
      const [parentRun] = await db
        .select({
          brandIds: runs.brandIds,
          campaignId: runs.campaignId,
          workflowSlug: runs.workflowSlug,
          featureSlug: runs.featureSlug,
          organizationId: runs.organizationId,
          userId: runs.userId,
        })
        .from(runs)
        .where(eq(runs.id, parentRunId))
        .limit(1);

      if (!parentRun) {
        res.status(400).json({ error: `parentRunId ${parentRunId} does not exist` });
        return;
      }

      const conflicts: string[] = [];
      if (resolvedBrandIds && parentRun.brandIds) {
        const sortedResolved = [...resolvedBrandIds].sort().join(",");
        const sortedParent = [...parentRun.brandIds].sort().join(",");
        if (sortedResolved !== sortedParent) {
          conflicts.push(`brandIds: request="${resolvedBrandIds.join(",")}" vs parent="${parentRun.brandIds.join(",")}"`);
        }
      }
      if (resolvedCampaignId && parentRun.campaignId && resolvedCampaignId !== parentRun.campaignId) {
        conflicts.push(`campaignId: request="${resolvedCampaignId}" vs parent="${parentRun.campaignId}"`);
      }
      if (resolvedWorkflowSlug && parentRun.workflowSlug && resolvedWorkflowSlug !== parentRun.workflowSlug) {
        conflicts.push(`workflowSlug: request="${resolvedWorkflowSlug}" vs parent="${parentRun.workflowSlug}"`);
      }
      if (resolvedFeatureSlug && parentRun.featureSlug && resolvedFeatureSlug !== parentRun.featureSlug) {
        conflicts.push(`featureSlug: request="${resolvedFeatureSlug}" vs parent="${parentRun.featureSlug}"`);
      }
      if (parentRun.organizationId && resolvedOrgId !== parentRun.organizationId) {
        conflicts.push(`orgId: request="${resolvedOrgId}" vs parent="${parentRun.organizationId}"`);
      }
      if (resolvedUserId && parentRun.userId && resolvedUserId !== parentRun.userId) {
        conflicts.push(`userId: request="${resolvedUserId}" vs parent="${parentRun.userId}"`);
      }

      if (conflicts.length > 0) {
        console.error(`[runs-service] Parent-child conflict on run ${parentRunId}: ${conflicts.join(", ")}`);
        res.status(409).json({ error: "Parent-child field conflict", conflicts });
        return;
      }

      if (!resolvedBrandIds) resolvedBrandIds = parentRun.brandIds;
      if (!resolvedCampaignId) resolvedCampaignId = parentRun.campaignId;
      if (!resolvedWorkflowSlug) resolvedWorkflowSlug = parentRun.workflowSlug;
      if (!resolvedFeatureSlug) resolvedFeatureSlug = parentRun.featureSlug;
      if (!resolvedUserId) resolvedUserId = parentRun.userId;
    }

    const identity: Identity = {
      orgId: resolvedOrgId,
      userId: resolvedUserId,
      brandIds: resolvedBrandIds,
      campaignId: resolvedCampaignId,
      workflowSlug: resolvedWorkflowSlug,
      featureSlug: resolvedFeatureSlug,
    };

    const id = newRunId();
    const payload = {
      runId: id,
      parentRunId,
      organizationId: resolvedOrgId,
      userId: resolvedUserId,
      brandIds: resolvedBrandIds,
      campaignId: resolvedCampaignId,
      workflowSlug: resolvedWorkflowSlug,
      featureSlug: resolvedFeatureSlug,
      serviceName,
      taskName,
      idempotencyKey: idempotencyKey ?? null,
    };

    try {
      const created = await db.transaction(async (tx) => {
        await logRunLifecycle(tx, {
          runId: id,
          eventType: "run.created",
          payload,
          identity,
          idempotencyKey: idempotencyKey ?? null,
        });
        // Trigger project_run_lifecycle_to_silver fires AFTER the bronze insert
        // and creates the silver row synchronously. Read it back for the response.
        const [silver] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1);
        return silver;
      });
      res.status(201).json(created);
    } catch (err: any) {
      // Race-condition handling on idempotency_key — concurrent retry inserted
      // the silver row between pre-check and the trigger's insert. Re-fetch.
      if (err?.code === "23505" && idempotencyKey) {
        const [raceWinner] = await db.select().from(runs).where(eq(runs.idempotencyKey, idempotencyKey)).limit(1);
        if (raceWinner) {
          if (raceWinner.serviceName !== serviceName || raceWinner.taskName !== taskName) {
            res.status(409).json({
              error: "idempotencyKey collision with different (serviceName, taskName)",
              existing: { id: raceWinner.id, serviceName: raceWinner.serviceName, taskName: raceWinner.taskName },
            });
            return;
          }
          res.status(200).json(raceWinner);
          return;
        }
      }
      throw err;
    }
  } catch (err) {
    console.error("[runs-service] Error creating run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/runs/costs/batch — inline bounded recursive CTE.
// Gold view v_run_cost_rollup removed (PR — unbounded walk caused 20+ GB OOM
// on production Neon; PG planner couldn't push filter through GROUP BY).
// ---------------------------------------------------------------------------
router.post("/v1/runs/costs/batch", requireApiKey, async (req, res) => {
  try {
    const parsed = BatchCostsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { runIds } = parsed.data;

    const result = await db.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT id, id AS root_run_id
        FROM runs
        WHERE id IN (${sql.join(runIds.map((id) => sql`${id}`), sql`, `)})
          AND organization_id = ${req.orgId}
        UNION ALL
        SELECT r.id, d.root_run_id
        FROM runs r INNER JOIN descendants d ON r.parent_run_id = d.id
      )
      SELECT
        d.root_run_id,
        COALESCE(SUM(CASE WHEN rc.status <> 'cancelled' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS actual_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS provisioned_cost,
        COALESCE(SUM(CASE WHEN d.id = d.root_run_id AND rc.status = 'actual' AND rc.is_platform_projected THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_actual_platform_cost,
        COALESCE(SUM(CASE WHEN d.id = d.root_run_id AND rc.status = 'provisioned' AND rc.is_platform_projected THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_provisioned_platform_cost
      FROM descendants d
      LEFT JOIN runs_costs rc ON rc.run_id = d.id
      GROUP BY d.root_run_id
    `);

    const rows = result as any[];
    const costs = rows.map((row) => ({
      runId: row.root_run_id,
      totalCostInUsdCents: new Decimal(row.total_cost).toFixed(10),
      actualCostInUsdCents: new Decimal(row.actual_cost).toFixed(10),
      provisionedCostInUsdCents: new Decimal(row.provisioned_cost).toFixed(10),
      ownActualPlatformCostInUsdCents: new Decimal(row.own_actual_platform_cost).toFixed(10),
      ownProvisionedPlatformCostInUsdCents: new Decimal(row.own_provisioned_platform_cost).toFixed(10),
    }));

    res.json({ costs });
  } catch (err) {
    console.error("[runs-service] Error in POST /v1/runs/costs/batch:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/runs/batch — fetch N runs with full RunWithCosts shape in one call.
// Replaces the N × GET /v1/runs/:id fanout in api-service runs-client.
// Reads from v_run_cost_rollup (rolled-up aggregates) + runs (row data) +
// runs_costs (own + descendant cost arrays) + v_runs_with_descendants
// (descendant tree). Constant 4 SQL round-trips regardless of N (up to 10000).
// ---------------------------------------------------------------------------
router.post("/v1/runs/batch", requireApiKey, async (req, res) => {
  try {
    const parsed = BatchRunsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { runIds } = parsed.data;

    // Query 1 — base run rows scoped to org.
    const runRows = await db
      .select()
      .from(runs)
      .where(and(eq(runs.organizationId, req.orgId), inArray(runs.id, runIds)));

    if (runRows.length === 0) {
      res.json({ runs: [] });
      return;
    }

    const foundIds = runRows.map((r) => r.id);
    const foundIdsList = sql.join(foundIds.map((id) => sql`${id}`), sql`, `);

    // Query 2 — rolled-up aggregates via INLINE bounded recursive CTE.
    // Gold view removed (unbounded walk caused 20+ GB OOM on prod).
    const rollupResult = await db.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT id, id AS root_run_id FROM runs WHERE id IN (${foundIdsList})
        UNION ALL
        SELECT r.id, d.root_run_id FROM runs r INNER JOIN descendants d ON r.parent_run_id = d.id
      )
      SELECT
        d.root_run_id,
        COALESCE(SUM(CASE WHEN rc.status <> 'cancelled' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS actual_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS provisioned_cost
      FROM descendants d
      LEFT JOIN runs_costs rc ON rc.run_id = d.id
      GROUP BY d.root_run_id
    `);
    const rollupByRoot = new Map<string, any>(
      (rollupResult as any[]).map((r) => [r.root_run_id, r])
    );

    // Query 3 — descendant run rows via INLINE bounded recursive CTE.
    const descendantResult = await db.execute(sql`
      WITH RECURSIVE walk AS (
        SELECT id, id AS root_run_id, 0 AS depth
        FROM runs WHERE id IN (${foundIdsList})
        UNION ALL
        SELECT r.id, w.root_run_id, w.depth + 1
        FROM runs r INNER JOIN walk w ON r.parent_run_id = w.id
      )
      SELECT
        w.root_run_id,
        r.id,
        r.parent_run_id,
        r.service_name,
        r.task_name,
        r.status,
        r.started_at,
        r.completed_at
      FROM walk w
      INNER JOIN runs r ON r.id = w.id
      WHERE w.depth > 0
    `);
    const descendantRows = descendantResult as any[];
    const descendantIds = descendantRows.map((r) => r.id);
    const descendantsByRoot = new Map<string, any[]>();
    for (const row of descendantRows) {
      const list = descendantsByRoot.get(row.root_run_id) || [];
      list.push(row);
      descendantsByRoot.set(row.root_run_id, list);
    }

    // Query 4 — all cost rows for roots + descendants in one fetch.
    const allCostRunIds = [...foundIds, ...descendantIds];
    const allCosts = allCostRunIds.length === 0
      ? []
      : await db.select().from(runsCosts).where(inArray(runsCosts.runId, allCostRunIds));
    const costsByRunId = new Map<string, any[]>();
    for (const cost of allCosts) {
      const list = costsByRunId.get(cost.runId) || [];
      list.push(cost);
      costsByRunId.set(cost.runId, list);
    }

    // Per-descendant own-cost aggregates (depth>0). Done in one SQL aggregation.
    const descendantOwnResult = descendantIds.length === 0 ? [] : await db.execute(sql`
      SELECT
        run_id,
        COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_total,
        COALESCE(SUM(CASE WHEN status = 'actual' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_actual,
        COALESCE(SUM(CASE WHEN status = 'provisioned' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_provisioned
      FROM runs_costs
      WHERE run_id IN (${sql.join(descendantIds.map((id) => sql`${id}`), sql`, `)})
      GROUP BY run_id
    `);
    const ownAggByRunId = new Map<string, any>(
      (descendantOwnResult as any[]).map((r) => [r.run_id, r])
    );

    // Per-root own-cost aggregates (depth=0).
    const rootOwnResult = await db.execute(sql`
      SELECT
        run_id,
        COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_total,
        COALESCE(SUM(CASE WHEN status = 'actual' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_actual,
        COALESCE(SUM(CASE WHEN status = 'provisioned' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_provisioned
      FROM runs_costs
      WHERE run_id IN (${sql.join(foundIds.map((id) => sql`${id}`), sql`, `)})
      GROUP BY run_id
    `);
    const rootOwnByRunId = new Map<string, any>(
      (rootOwnResult as any[]).map((r) => [r.run_id, r])
    );

    // Assemble RunWithCosts per requested root in JS (no math, just dispatch).
    const result = runRows.map((run) => {
      const rollup = rollupByRoot.get(run.id) ?? {
        total_cost: "0",
        actual_cost: "0",
        provisioned_cost: "0",
      };
      const ownAgg = rootOwnByRunId.get(run.id) ?? {
        own_total: "0",
        own_actual: "0",
        own_provisioned: "0",
      };
      const childrenTotal = new Decimal(rollup.total_cost).minus(ownAgg.own_total);
      const childrenActual = new Decimal(rollup.actual_cost).minus(ownAgg.own_actual);
      const childrenProvisioned = new Decimal(rollup.provisioned_cost).minus(ownAgg.own_provisioned);

      const descendantRuns = (descendantsByRoot.get(run.id) ?? []).map((d) => {
        const dCosts = costsByRunId.get(d.id) ?? [];
        const dOwn = ownAggByRunId.get(d.id) ?? {
          own_total: "0",
          own_actual: "0",
          own_provisioned: "0",
        };
        return {
          id: d.id,
          parentRunId: d.parent_run_id,
          serviceName: d.service_name,
          taskName: d.task_name,
          status: d.status,
          startedAt: d.started_at,
          completedAt: d.completed_at,
          costs: dCosts,
          ownCostInUsdCents: new Decimal(dOwn.own_total).toFixed(10),
          ownActualCostInUsdCents: new Decimal(dOwn.own_actual).toFixed(10),
          ownProvisionedCostInUsdCents: new Decimal(dOwn.own_provisioned).toFixed(10),
        };
      });

      return {
        ...run,
        costs: costsByRunId.get(run.id) ?? [],
        totalCostInUsdCents: new Decimal(rollup.total_cost).toFixed(10),
        actualCostInUsdCents: new Decimal(rollup.actual_cost).toFixed(10),
        provisionedCostInUsdCents: new Decimal(rollup.provisioned_cost).toFixed(10),
        ownCostInUsdCents: new Decimal(ownAgg.own_total).toFixed(10),
        ownActualCostInUsdCents: new Decimal(ownAgg.own_actual).toFixed(10),
        ownProvisionedCostInUsdCents: new Decimal(ownAgg.own_provisioned).toFixed(10),
        childrenCostInUsdCents: childrenTotal.toFixed(10),
        childrenActualCostInUsdCents: childrenActual.toFixed(10),
        childrenProvisionedCostInUsdCents: childrenProvisioned.toFixed(10),
        descendantRuns,
      };
    });

    res.json({ runs: result });
  } catch (err) {
    console.error("[runs-service] Error in POST /v1/runs/batch:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Phase 4 — GET /v1/runs/:id reads aggregates from v_run_cost_rollup.
// computeCostBreakdown JS helper removed; all math in Postgres per
// CLAUDE.md "Cost & billing precision" rule.
// ---------------------------------------------------------------------------
router.get("/v1/runs/:id", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const costs = await db.select().from(runsCosts).where(eq(runsCosts.runId, id));

    // Rolled-up cost aggregates via INLINE bounded recursive CTE.
    // Gold view v_run_cost_rollup removed (unbounded walk caused 20+ GB OOM on prod).
    const rollupResult = await db.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT id FROM runs WHERE id = ${id}
        UNION ALL
        SELECT r.id FROM runs r INNER JOIN descendants d ON r.parent_run_id = d.id
      )
      SELECT
        COALESCE(SUM(CASE WHEN rc.status <> 'cancelled' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS total_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'actual' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS actual_cost,
        COALESCE(SUM(CASE WHEN rc.status = 'provisioned' THEN rc.total_cost_in_usd_cents ELSE 0 END), 0)::text AS provisioned_cost
      FROM descendants d
      LEFT JOIN runs_costs rc ON rc.run_id = d.id
    `);
    const rollup = (rollupResult as any[])[0] ?? { total_cost: "0", actual_cost: "0", provisioned_cost: "0" };

    // Own-row aggregates (depth=0 only) — separate SQL to keep view single-purpose.
    const ownResult = await db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_total,
        COALESCE(SUM(CASE WHEN status = 'actual' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_actual,
        COALESCE(SUM(CASE WHEN status = 'provisioned' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_provisioned
      FROM runs_costs
      WHERE run_id = ${id}
    `);
    const own = (ownResult as any[])[0];

    // Descendant rows for the response shape (parent's view of children).
    const descendantResult = await db.execute(
      sql`WITH RECURSIVE descendants AS (
        SELECT id, parent_run_id, service_name, task_name, status, started_at, completed_at
        FROM runs WHERE parent_run_id = ${id}
        UNION ALL
        SELECT r.id, r.parent_run_id, r.service_name, r.task_name, r.status, r.started_at, r.completed_at
        FROM runs r INNER JOIN descendants d ON r.parent_run_id = d.id
      )
      SELECT * FROM descendants`
    );
    const descendantRows = descendantResult as any[];
    const descendantIds = descendantRows.map((r: any) => r.id);

    let allDescendantCosts: any[] = [];
    if (descendantIds.length > 0) {
      allDescendantCosts = await db.select().from(runsCosts).where(inArray(runsCosts.runId, descendantIds));
    }

    // Per-descendant own-cost via SQL aggregation.
    const descendantOwnResult = descendantIds.length === 0 ? [] : await db.execute(sql`
      SELECT
        run_id,
        COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_total,
        COALESCE(SUM(CASE WHEN status = 'actual' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_actual,
        COALESCE(SUM(CASE WHEN status = 'provisioned' THEN total_cost_in_usd_cents ELSE 0 END), 0)::text AS own_provisioned
      FROM runs_costs
      WHERE run_id IN (${sql.join(descendantIds.map((id) => sql`${id}`), sql`, `)})
      GROUP BY run_id
    `);
    const ownByRunId = new Map<string, any>(
      (descendantOwnResult as any[]).map((r) => [r.run_id, r])
    );

    const costsByRunId = new Map<string, any[]>();
    for (const cost of allDescendantCosts) {
      const list = costsByRunId.get(cost.runId) || [];
      list.push(cost);
      costsByRunId.set(cost.runId, list);
    }

    const descendantRuns = descendantRows.map((r: any) => {
      const runCosts = costsByRunId.get(r.id) || [];
      const ownAgg = ownByRunId.get(r.id) ?? { own_total: "0", own_actual: "0", own_provisioned: "0" };
      return {
        id: r.id,
        parentRunId: r.parent_run_id,
        serviceName: r.service_name,
        taskName: r.task_name,
        status: r.status,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        costs: runCosts,
        ownCostInUsdCents: new Decimal(ownAgg.own_total).toFixed(10),
        ownActualCostInUsdCents: new Decimal(ownAgg.own_actual).toFixed(10),
        ownProvisionedCostInUsdCents: new Decimal(ownAgg.own_provisioned).toFixed(10),
      };
    });

    // children = total - own (numeric subtraction in Decimal, no JS float drift)
    const childrenTotal = new Decimal(rollup.total_cost).minus(own.own_total);
    const childrenActual = new Decimal(rollup.actual_cost).minus(own.own_actual);
    const childrenProvisioned = new Decimal(rollup.provisioned_cost).minus(own.own_provisioned);

    res.json({
      ...run,
      costs,
      totalCostInUsdCents: new Decimal(rollup.total_cost).toFixed(10),
      actualCostInUsdCents: new Decimal(rollup.actual_cost).toFixed(10),
      provisionedCostInUsdCents: new Decimal(rollup.provisioned_cost).toFixed(10),
      ownCostInUsdCents: new Decimal(own.own_total).toFixed(10),
      ownActualCostInUsdCents: new Decimal(own.own_actual).toFixed(10),
      ownProvisionedCostInUsdCents: new Decimal(own.own_provisioned).toFixed(10),
      childrenCostInUsdCents: childrenTotal.toFixed(10),
      childrenActualCostInUsdCents: childrenActual.toFixed(10),
      childrenProvisionedCostInUsdCents: childrenProvisioned.toFixed(10),
      descendantRuns,
    });
  } catch (err) {
    console.error("[runs-service] Error getting run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Phase 2+5 — POST /v1/runs/:id/costs.
// App writes only cost.added events to bronze. Trigger creates runs_costs
// rows. Per-item idempotencyKey replay returns existing row from silver.
// ---------------------------------------------------------------------------
router.post("/v1/runs/:id/costs", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const parsed = AddCostsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { items } = parsed.data;

    const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const names = items.map((i) => i.costName);
    let costMap: Map<string, string>;
    try {
      costMap = await resolveMultipleUnitCosts(names, {
        orgId: req.orgId,
        userId: req.userId || (run.userId ?? undefined),
        runId: req.runId || id,
        brandIds: req.headerBrandIds,
        campaignId: req.headerCampaignId,
        workflowSlug: req.headerWorkflowSlug,
        featureSlug: req.headerFeatureSlug,
      });
    } catch (err) {
      if (err instanceof CostNotFoundError) {
        res.status(422).json({ error: `Unknown cost: ${err.costName}` });
        return;
      }
      throw err;
    }

    const identity: Identity = {
      orgId: req.orgId,
      userId: req.userId || run.userId,
      brandIds: req.headerBrandIds ?? null,
      campaignId: req.headerCampaignId ?? null,
      workflowSlug: req.headerWorkflowSlug ?? null,
      featureSlug: req.headerFeatureSlug ?? null,
    };

    // Idempotency dedupe for per-item keys — re-fetch existing silver rows
    // for keys that already exist; never emit duplicate bronze events for those.
    const keyed = items.filter((i) => i.idempotencyKey);
    const existingByKey = new Map<string, any>();
    if (keyed.length > 0) {
      const existing = await db
        .select()
        .from(runsCosts)
        .where(and(eq(runsCosts.runId, id), inArray(runsCosts.idempotencyKey, keyed.map((i) => i.idempotencyKey!))));
      for (const row of existing) existingByKey.set(row.idempotencyKey!, row);
    }

    const itemsToCreate: Array<{ item: typeof items[number]; costId: string; total: string }> = [];
    for (const item of items) {
      if (item.idempotencyKey && existingByKey.has(item.idempotencyKey)) continue;
      const unitCost = costMap.get(item.costName)!;
      const total = new Decimal(item.quantity).times(unitCost).toFixed(10);
      itemsToCreate.push({ item, costId: newCostId(), total });
    }

    const newRows = await db.transaction(async (tx) => {
      for (const { item, costId, total } of itemsToCreate) {
        const unitCost = costMap.get(item.costName)!;
        await logCostLifecycle(tx, {
          runId: id,
          costId,
          eventType: "cost.added",
          payload: {
            costId,
            costName: item.costName,
            costSource: item.costSource,
            quantity: String(item.quantity),
            unitCostInUsdCents: unitCost,
            totalCostInUsdCents: total,
            status: item.status ?? "actual",
            idempotencyKey: item.idempotencyKey ?? null,
          },
          identity,
          idempotencyKey: item.idempotencyKey ?? null,
        });
      }
      if (itemsToCreate.length === 0) return [] as any[];
      return await tx
        .select()
        .from(runsCosts)
        .where(inArray(runsCosts.id, itemsToCreate.map((c) => c.costId)));
    });

    // Restore 1-to-1 mapping for response: items that idempotency-collided return the existing row.
    const inserted: any[] = [];
    let createdIdx = 0;
    for (const item of items) {
      if (item.idempotencyKey && existingByKey.has(item.idempotencyKey)) {
        inserted.push(existingByKey.get(item.idempotencyKey));
      } else {
        inserted.push(newRows[createdIdx]);
        createdIdx++;
      }
    }

    // Fire-and-forget cache-invalidation hint to billing-service.
    const billingUserId = req.userId || run.userId;
    if (billingUserId && itemsToCreate.length > 0) {
      const spentTotalCents = await fetchOrgPlatformSpent(req.orgId);
      await notifyUsage(
        {
          orgId: req.orgId,
          userId: billingUserId,
          runId: id,
          brandIds: req.headerBrandIds,
          campaignId: req.headerCampaignId,
          workflowSlug: req.headerWorkflowSlug,
          featureSlug: req.headerFeatureSlug,
        },
        { spentTotalCents },
      );
    }

    res.status(201).json({ costs: inserted });
  } catch (err) {
    if (err instanceof UpstreamError) {
      console.error(`[runs-service] costs-service unavailable (${err.statusCode}):`, err.message);
      res.status(502).json({ error: `costs-service unavailable: ${err.message}` });
      return;
    }
    console.error("[runs-service] Error adding run costs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Phase 2+5 — PATCH /v1/runs/:id/costs/:costId.
// App writes cost.materialized / cost.cancelled events to bronze.
// Trigger flips runs_costs.status.
// ---------------------------------------------------------------------------
router.patch("/v1/runs/:id/costs/:costId", requireApiKey, async (req, res) => {
  try {
    const { id, costId } = req.params;

    const parsed = UpdateCostRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const [run] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    const [existing] = await db
      .select()
      .from(runsCosts)
      .where(and(eq(runsCosts.id, costId), eq(runsCosts.runId, id)))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Cost not found" });
      return;
    }

    const newStatus = parsed.data.status;
    const eventType = newStatus === "actual" ? "cost.materialized" : "cost.cancelled";

    const updated = await db.transaction(async (tx) => {
      await logCostLifecycle(tx, {
        runId: id,
        costId,
        eventType,
        payload: { from: existing.status, to: newStatus },
        identity: {
          orgId: req.orgId,
          userId: req.userId || run.userId,
          brandIds: req.headerBrandIds ?? null,
          campaignId: req.headerCampaignId ?? null,
          workflowSlug: req.headerWorkflowSlug ?? null,
          featureSlug: req.headerFeatureSlug ?? null,
        },
      });
      const [row] = await tx
        .select()
        .from(runsCosts)
        .where(and(eq(runsCosts.id, costId), eq(runsCosts.runId, id)))
        .limit(1);
      return row;
    });

    const billingUserId = req.userId || run.userId;
    if (billingUserId) {
      const spentTotalCents = await fetchOrgPlatformSpent(req.orgId);
      await notifyUsage(
        {
          orgId: req.orgId,
          userId: billingUserId,
          runId: id,
          brandIds: req.headerBrandIds,
          campaignId: req.headerCampaignId,
          workflowSlug: req.headerWorkflowSlug,
          featureSlug: req.headerFeatureSlug,
        },
        { spentTotalCents },
      );
    }

    res.json(updated);
  } catch (err) {
    console.error("[runs-service] Error updating cost:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Phase 2+5 — PATCH /v1/runs/:id.
// App writes run.completed / run.failed events to bronze. Trigger flips
// runs.status + completed_at.
// ---------------------------------------------------------------------------
router.patch("/v1/runs/:id", requireApiKey, async (req, res) => {
  try {
    const { id } = req.params;

    const parsed = UpdateRunRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { status } = parsed.data;
    const eventType = status === "completed" ? "run.completed" : "run.failed";

    const updated = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1);
      if (!existing) return null;
      await logRunLifecycle(tx, {
        runId: id,
        eventType,
        payload: { from: existing.status, to: status },
        identity: {
          orgId: req.orgId,
          userId: req.userId || existing.userId,
        },
      });
      const [row] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1);
      return row;
    });

    if (!updated) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error("[runs-service] Error updating run:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/runs — unchanged from prior PR; read path that already uses SUM/GROUP BY.
// ---------------------------------------------------------------------------
router.get("/v1/runs", requireApiKey, async (req, res) => {
  try {
    const {
      userId, brandId, campaignId, workflowSlug, featureSlug, serviceName, taskName,
      status, parentRunId, startedAfter, startedBefore, limit: limitStr, offset: offsetStr,
    } = req.query;

    const conditions = [eq(runs.organizationId, req.orgId)];
    if (userId) conditions.push(eq(runs.userId, userId as string));
    if (brandId) conditions.push(sql`${brandId} = ANY(${runs.brandIds})`);
    if (campaignId) conditions.push(eq(runs.campaignId, campaignId as string));
    if (workflowSlug) conditions.push(eq(runs.workflowSlug, workflowSlug as string));
    if (featureSlug) conditions.push(eq(runs.featureSlug, featureSlug as string));
    if (serviceName) conditions.push(eq(runs.serviceName, serviceName as string));
    if (taskName) conditions.push(eq(runs.taskName, taskName as string));
    if (status) conditions.push(eq(runs.status, status as string));
    if (parentRunId) conditions.push(eq(runs.parentRunId, parentRunId as string));
    if (startedAfter) conditions.push(gte(runs.startedAt, new Date(startedAfter as string)));
    if (startedBefore) conditions.push(lte(runs.startedAt, new Date(startedBefore as string)));

    const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
    const limit = limitStr ? Number(limitStr) : undefined;
    const offset = offsetStr ? Number(offsetStr) : 0;

    const query = db
      .select({
        id: runs.id,
        parentRunId: runs.parentRunId,
        organizationId: runs.organizationId,
        userId: runs.userId,
        brandIds: runs.brandIds,
        campaignId: runs.campaignId,
        workflowSlug: runs.workflowSlug,
        featureSlug: runs.featureSlug,
        serviceName: runs.serviceName,
        taskName: runs.taskName,
        status: runs.status,
        startedAt: runs.startedAt,
        completedAt: runs.completedAt,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        ownCostInUsdCents: sql<string>`COALESCE(SUM(CASE WHEN ${runsCosts.status} != 'cancelled' THEN ${runsCosts.totalCostInUsdCents} ELSE 0 END), 0)`.as("own_cost_in_usd_cents"),
        ownActualCostInUsdCents: sql<string>`COALESCE(SUM(CASE WHEN ${runsCosts.status} = 'actual' THEN ${runsCosts.totalCostInUsdCents} ELSE 0 END), 0)`.as("own_actual_cost_in_usd_cents"),
        ownProvisionedCostInUsdCents: sql<string>`COALESCE(SUM(CASE WHEN ${runsCosts.status} = 'provisioned' THEN ${runsCosts.totalCostInUsdCents} ELSE 0 END), 0)`.as("own_provisioned_cost_in_usd_cents"),
      })
      .from(runs)
      .leftJoin(runsCosts, eq(runsCosts.runId, runs.id))
      .where(whereClause)
      .groupBy(
        runs.id, runs.parentRunId, runs.organizationId, runs.userId, runs.brandIds,
        runs.campaignId, runs.workflowSlug, runs.featureSlug, runs.serviceName, runs.taskName,
        runs.status, runs.startedAt, runs.completedAt, runs.createdAt, runs.updatedAt,
      )
      .orderBy(desc(runs.startedAt));

    if (limit !== undefined) query.limit(limit);
    if (offset) query.offset(offset);

    const result = await query;
    const formattedRuns = result.map((r) => ({
      ...r,
      ownCostInUsdCents: new Decimal(r.ownCostInUsdCents).toFixed(10),
      ownActualCostInUsdCents: new Decimal(r.ownActualCostInUsdCents).toFixed(10),
      ownProvisionedCostInUsdCents: new Decimal(r.ownProvisionedCostInUsdCents).toFixed(10),
    }));

    res.json({ runs: formattedRuns, ...(limit !== undefined && { limit }), offset });
  } catch (err) {
    console.error("[runs-service] Error listing runs:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
