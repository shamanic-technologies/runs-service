import { db, sql } from "../../src/db/index.js";
import { organizations, users, runs, runsCosts } from "../../src/db/schema.js";

export async function cleanTestData() {
  await sql`TRUNCATE runs_costs, runs, users, organizations CASCADE`;
}

export async function insertTestOrg(externalId: string) {
  const [org] = await db
    .insert(organizations)
    .values({ externalId })
    .returning();
  return org;
}

export async function insertTestUser(externalId: string, organizationId: string) {
  const [user] = await db
    .insert(users)
    .values({ externalId, organizationId })
    .returning();
  return user;
}

export async function insertTestRun(data: {
  organizationId: string;
  serviceName: string;
  taskName: string;
  userId?: string;
  parentRunId?: string;
  status?: string;
}) {
  const [run] = await db
    .insert(runs)
    .values({
      organizationId: data.organizationId,
      serviceName: data.serviceName,
      taskName: data.taskName,
      userId: data.userId || null,
      parentRunId: data.parentRunId || null,
      status: data.status || "running",
    })
    .returning();
  return run;
}

export async function insertTestRunCost(data: {
  runId: string;
  costName: string;
  quantity: string;
  unitCostInUsdCents: string;
  totalCostInUsdCents: string;
}) {
  const [cost] = await db.insert(runsCosts).values(data).returning();
  return cost;
}

export async function closeDb() {
  await sql.end();
}
