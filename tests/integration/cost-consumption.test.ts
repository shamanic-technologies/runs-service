import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";
import { cleanTestData, closeDb, insertTestRun, insertTestRunCost } from "../helpers/test-db.js";
import { db } from "../../src/db/index.js";
import { sql } from "drizzle-orm";

// GET /internal/stats/costs/consumption — units consumed per UTC day per cost
// name, fleet-wide, platform key and org key apart. costs-service divides a vendor
// subscription's bank spend by these units. Cost names are unique to this file so
// rows written by files sharing the shard never enter the figures.

const ORG_A = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ORG_B = "8b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";
const APOLLO = "consumption-test-apollo-credit";
const SERPER = "consumption-test-serper-query";
const API_KEY = { "x-api-key": "test-api-key" };
const PATH = "/internal/stats/costs/consumption";

async function cost(runId: string, costName: string, qty: string, createdAt: string, opts: { status?: string; costSource?: string } = {}) {
  await insertTestRunCost({
    runId,
    costName,
    quantity: qty,
    unitCostInUsdCents: "1",
    totalCostInUsdCents: qty,
    status: opts.status ?? "actual",
    costSource: opts.costSource ?? "platform",
    createdAt: new Date(createdAt),
  });
}

describe("GET /internal/stats/costs/consumption", () => {
  const app = createTestApp();

  beforeAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    const a = await insertTestRun({ organizationId: ORG_A, serviceName: "svc", taskName: "t", status: "completed" });
    const b = await insertTestRun({ organizationId: ORG_B, serviceName: "svc", taskName: "t", status: "completed" });
    await cost(a.id, APOLLO, "3", "2026-01-10T10:00:00Z");
    await cost(b.id, APOLLO, "2.5", "2026-01-10T23:59:59Z"); // other org, same UTC day: summed
    await cost(a.id, APOLLO, "1", "2026-01-11T00:00:00Z", { status: "refunded" }); // consumed, not charged
    await cost(a.id, APOLLO, "7", "2026-01-11T00:00:00Z", { status: "provisioned" }); // a hold: not consumption
    await cost(a.id, APOLLO, "9", "2026-01-11T00:00:00Z", { status: "cancelled" }); // never happened
    await cost(a.id, APOLLO, "4", "2026-01-11T05:00:00Z", { costSource: "org" }); // customer's key: kept apart
    await cost(b.id, SERPER, "10", "2026-02-01T00:00:00Z", { costSource: "org" });
  });

  afterAll(async () => {
    await cleanTestData([ORG_A, ORG_B]);
    await closeDb();
  });

  it("refuses a call without the service key", async () => {
    const res = await request(app).get(PATH).query({ costNames: APOLLO });
    expect(res.status).toBe(401);
  });

  it("sums quantity per UTC day, cost name and source across orgs; actual + refunded only", async () => {
    const res = await request(app).get(PATH).query({ costNames: `${APOLLO},${SERPER}` }).set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ timezone: "UTC", since: null, statuses: ["actual", "refunded"] });
    expect(res.body.days).toEqual([
      { day: "2026-01-10", costName: APOLLO, costSource: "platform", quantity: "5.500000", refundedQuantity: "0.000000" },
      { day: "2026-01-11", costName: APOLLO, costSource: "org", quantity: "4.000000", refundedQuantity: "0.000000" },
      { day: "2026-01-11", costName: APOLLO, costSource: "platform", quantity: "1.000000", refundedQuantity: "1.000000" },
      { day: "2026-02-01", costName: SERPER, costSource: "org", quantity: "10.000000", refundedQuantity: "0.000000" },
    ]);
    expect(res.body.totals).toEqual([
      { costName: APOLLO, costSource: "org", quantity: "4.000000", refundedQuantity: "0.000000" },
      { costName: APOLLO, costSource: "platform", quantity: "6.500000", refundedQuantity: "1.000000" },
      { costName: SERPER, costSource: "org", quantity: "10.000000", refundedQuantity: "0.000000" },
    ]);
  });

  it("totals equal a direct SQL sum of the same rows", async () => {
    const res = await request(app).get(PATH).query({ costNames: APOLLO }).set(API_KEY);
    const [direct] = (await db.execute(sql`
      SELECT SUM(quantity)::text AS q FROM runs_costs
      WHERE cost_name = ${APOLLO} AND cost_source = 'platform' AND status IN ('actual','refunded')
    `)) as any[];
    const platform = res.body.totals.find((t: any) => t.costSource === "platform");
    expect(platform.quantity).toBe(direct.q);
  });

  it("since keeps rows from that UTC day on", async () => {
    const res = await request(app).get(PATH).query({ costNames: APOLLO, since: "2026-01-11" }).set(API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.since).toBe("2026-01-11");
    expect(res.body.days.map((d: any) => d.day)).toEqual(["2026-01-11", "2026-01-11"]);
  });

  it("rejects a malformed since or an empty costNames", async () => {
    expect((await request(app).get(PATH).query({ since: "2026/01/01" }).set(API_KEY)).status).toBe(400);
    expect((await request(app).get(PATH).query({ costNames: " , " }).set(API_KEY)).status).toBe(400);
  });
});
