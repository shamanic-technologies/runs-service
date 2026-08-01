import { eq, inArray, isNull, or } from "drizzle-orm";
import { db, sql } from "../../src/db/index.js";
import { runs, runsCosts } from "../../src/db/schema.js";

// Org-scoped cleanup so integration test files can run in parallel.
// Pass `null` in the array to also delete platform runs (organization_id IS NULL).
export async function cleanTestData(orgIds: Array<string | null>) {
  if (orgIds.length === 0) return;

  const nonNullOrgIds = orgIds.filter((id): id is string => id !== null);
  const includeNull = orgIds.some((id) => id === null);

  const conditions = [];
  if (nonNullOrgIds.length > 0) conditions.push(inArray(runs.organizationId, nonNullOrgIds));
  if (includeNull) conditions.push(isNull(runs.organizationId));

  const where = conditions.length === 1 ? conditions[0] : or(...conditions);
  await db.delete(runs).where(where);
}

export async function insertTestRun(data: {
  organizationId: string | null;
  serviceName: string;
  taskName: string;
  brandIds?: string[];
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  goal?: string;
  brandProfileId?: string;
  audienceId?: string;
  workflowContext?: string;
  userId?: string;
  parentRunId?: string;
  status?: string;
  startedAt?: Date;
  idempotencyKey?: string;
}) {
  const [run] = await db
    .insert(runs)
    .values({
      organizationId: data.organizationId,
      serviceName: data.serviceName,
      taskName: data.taskName,
      brandIds: data.brandIds || null,
      campaignId: data.campaignId || null,
      workflowSlug: data.workflowSlug || null,
      featureSlug: data.featureSlug || null,
      goal: data.goal || null,
      brandProfileId: data.brandProfileId || null,
      audienceId: data.audienceId || null,
      workflowContext: data.workflowContext || null,
      userId: data.userId || null,
      parentRunId: data.parentRunId || null,
      status: data.status || "running",
      idempotencyKey: data.idempotencyKey || null,
      ...(data.startedAt ? { startedAt: data.startedAt } : {}),
    })
    .returning();
  return run;
}

export async function insertTestRunCost(data: {
  runId: string;
  costName: string;
  costSource?: string;
  quantity: string;
  unitCostInUsdCents: string;
  totalCostInUsdCents: string;
  netCostInUsdCents?: string;
  usageDiscountPct?: string;
  status?: string;
  goal?: string;
  brandProfileId?: string;
  audienceId?: string;
  workflowContext?: string;
  // undefined → derive from the run (mirrors the migration 0029 freeze);
  // null → force NULL (simulate a pre-backfill row); string → use as-is.
  organizationId?: string | null;
  // undefined → derive from the run (mirrors the migration 0030 freeze);
  // null → force NULL (simulate a pre-backfill row); Date → use as-is.
  runStartedAt?: Date | null;
  idempotencyKey?: string;
}) {
  // Mirror the production freezes: the cost row carries its run's organization_id
  // (migration 0029) and its run's started_at (migration 0030). This helper inserts
  // silver directly (bypassing the cost.added trigger), so resolve both from the run
  // here unless the caller overrides them — else the de-joined reads (org-spend SUMs
  // on runs_costs.organization_id, the dated spend series on
  // runs_costs.run_started_at) would miss helper-inserted costs.
  let organizationId = data.organizationId ?? null;
  let runStartedAt = data.runStartedAt ?? null;
  if (data.organizationId === undefined || data.runStartedAt === undefined) {
    const [run] = await db
      .select({ organizationId: runs.organizationId, startedAt: runs.startedAt })
      .from(runs)
      .where(eq(runs.id, data.runId))
      .limit(1);
    if (data.organizationId === undefined) organizationId = run?.organizationId ?? null;
    if (data.runStartedAt === undefined) runStartedAt = run?.startedAt ?? null;
  }

  const [cost] = await db
    .insert(runsCosts)
    .values({
      ...data,
      organizationId,
      runStartedAt,
      costSource: data.costSource ?? "platform",
      status: data.status ?? "actual",
      idempotencyKey: data.idempotencyKey ?? null,
    })
    .returning();
  return cost;
}

export async function closeDb() {
  await sql.end();
}
