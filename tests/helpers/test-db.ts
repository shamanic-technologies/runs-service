import { db, sql } from "../../src/db/index.js";
import { runs, runsCosts, runEvents } from "../../src/db/schema.js";

export async function cleanTestData() {
  await sql`TRUNCATE run_events, runs_costs, runs CASCADE`;
}

export async function insertTestRun(data: {
  organizationId: string;
  serviceName: string;
  taskName: string;
  brandIds?: string[];
  campaignId?: string;
  workflowSlug?: string;
  featureSlug?: string;
  userId?: string;
  parentRunId?: string;
  status?: string;
  startedAt?: Date;
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
      userId: data.userId || null,
      parentRunId: data.parentRunId || null,
      status: data.status || "running",
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
  status?: string;
  billingProvisionId?: string;
}) {
  const [cost] = await db
    .insert(runsCosts)
    .values({
      ...data,
      costSource: data.costSource ?? "platform",
      status: data.status ?? "actual",
      billingProvisionId: data.billingProvisionId ?? null,
    })
    .returning();
  return cost;
}

export async function closeDb() {
  await sql.end();
}
