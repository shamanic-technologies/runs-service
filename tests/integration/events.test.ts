import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createTestApp, getAuthHeaders, TEST_USER_ID, TEST_BRAND_A } from "../helpers/test-app.js";
import { cleanTestData, insertTestRun, closeDb } from "../helpers/test-db.js";

// File-local org id keeps this file isolated from other integration files running in parallel.
const ORG_ID = "dddddddd-4444-4444-addd-444444444444";

describe("Run Events", () => {
  const app = createTestApp();
  const authHeaders = getAuthHeaders({ orgId: ORG_ID });

  beforeEach(async () => {
    await cleanTestData([ORG_ID]);
  });

  afterAll(async () => {
    await cleanTestData([ORG_ID]);
    await closeDb();
  });

  describe("POST /v1/runs/:id/events", () => {
    it("creates an event for an existing run", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "brand-service",
        taskName: "scrape",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({
          service: "brand-service",
          event: "scrape",
          detail: "Scraping https://example.com",
          level: "info",
          data: { url: "https://example.com" },
        });

      expect(res.status).toBe(201);
      expect(res.body.runId).toBe(run.id);
      expect(res.body.service).toBe("brand-service");
      expect(res.body.event).toBe("scrape");
      expect(res.body.detail).toBe("Scraping https://example.com");
      expect(res.body.level).toBe("info");
      expect(res.body.data).toEqual({ url: "https://example.com" });
      expect(res.body.id).toBeDefined();
      expect(res.body.createdAt).toBeDefined();
    });

    it("stores identity headers in the event row", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "workflow-service",
        taskName: "execute",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set({
          ...authHeaders,
          "x-brand-id": TEST_BRAND_A,
          "x-campaign-id": "dddddddd-dddd-4ddd-bddd-dddddddddddd",
          "x-workflow-slug": "cold-email-v1",
          "x-feature-slug": "outreach",
        })
        .send({
          service: "workflow-service",
          event: "node-start",
        });

      expect(res.status).toBe(201);
      expect(res.body.orgId).toBe(ORG_ID);
      expect(res.body.userId).toBe(TEST_USER_ID);
      expect(res.body.brandIds).toBe(TEST_BRAND_A);
      expect(res.body.campaignId).toBe("dddddddd-dddd-4ddd-bddd-dddddddddddd");
      expect(res.body.workflowSlug).toBe("cold-email-v1");
      expect(res.body.featureSlug).toBe("outreach");
    });

    it("returns 404 if run does not exist", async () => {
      const res = await request(app)
        .post("/v1/runs/00000000-0000-0000-0000-000000000000/events")
        .set(authHeaders)
        .send({
          service: "brand-service",
          event: "scrape",
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Run not found");
    });

    it("returns 400 for invalid body", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "brand-service",
        taskName: "scrape",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({});

      expect(res.status).toBe(400);
    });

    it("defaults level to info when not provided", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "brand-service",
        taskName: "scrape",
      });

      const res = await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({
          service: "brand-service",
          event: "scrape",
        });

      expect(res.status).toBe(201);
      expect(res.body.level).toBe("info");
    });
  });

  describe("GET /v1/runs/:id/events", () => {
    it("returns events ordered by created_at ASC", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "brand-service",
        taskName: "scrape",
      });

      // Create events in order
      await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({ service: "brand-service", event: "start" });

      await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({ service: "brand-service", event: "scrape" });

      await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({ service: "brand-service", event: "done" });

      const res = await request(app)
        .get(`/v1/runs/${run.id}/events`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(3);
      expect(res.body.events[0].event).toBe("start");
      expect(res.body.events[1].event).toBe("scrape");
      expect(res.body.events[2].event).toBe("done");
    });

    it("filters by level", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "brand-service",
        taskName: "scrape",
      });

      await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({ service: "brand-service", event: "start", level: "info" });

      await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({ service: "brand-service", event: "warning", level: "warn" });

      await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({ service: "brand-service", event: "crash", level: "error" });

      const res = await request(app)
        .get(`/v1/runs/${run.id}/events?level=error`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0].event).toBe("crash");
    });

    it("returns 404 if run does not exist", async () => {
      const res = await request(app)
        .get("/v1/runs/00000000-0000-0000-0000-000000000000/events")
        .set(authHeaders);

      expect(res.status).toBe(404);
    });
  });

  describe("GET /v1/events", () => {
    it("returns events across runs filtered by service", async () => {
      const run1 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "brand-service",
        taskName: "scrape",
      });
      const run2 = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "workflow-service",
        taskName: "execute",
      });

      await request(app)
        .post(`/v1/runs/${run1.id}/events`)
        .set(authHeaders)
        .send({ service: "brand-service", event: "scrape" });

      await request(app)
        .post(`/v1/runs/${run2.id}/events`)
        .set(authHeaders)
        .send({ service: "workflow-service", event: "execute" });

      const res = await request(app)
        .get("/v1/events?service=brand-service")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(1);
      expect(res.body.events[0].service).toBe("brand-service");
    });

    // 7 sequential DB ops on a cold Neon CI branch can exceed the 5s default.
    it("supports pagination with limit and offset", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "brand-service",
        taskName: "scrape",
      });

      for (let i = 0; i < 5; i++) {
        await request(app)
          .post(`/v1/runs/${run.id}/events`)
          .set(authHeaders)
          .send({ service: "brand-service", event: `event-${i}` });
      }

      const res = await request(app)
        .get("/v1/events?limit=2&offset=1")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(2);
    }, 30_000);

    it("orders by created_at DESC", async () => {
      const run = await insertTestRun({
        organizationId: ORG_ID,
        serviceName: "brand-service",
        taskName: "scrape",
      });

      await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({ service: "brand-service", event: "first" });

      await request(app)
        .post(`/v1/runs/${run.id}/events`)
        .set(authHeaders)
        .send({ service: "brand-service", event: "second" });

      const res = await request(app)
        .get("/v1/events")
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.events[0].event).toBe("second");
      expect(res.body.events[1].event).toBe("first");
    });
  });
});
