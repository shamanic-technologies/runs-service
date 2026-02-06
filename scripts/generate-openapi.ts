import swaggerAutogen from "swagger-autogen";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const doc = {
  info: {
    title: "Runs Service",
    description:
      "REST API for tracking service execution runs and their associated costs. Supports hierarchical runs (parent-child), cost aggregation, and multi-tenant isolation via organizations.",
    version: "0.1.0",
  },
  host: process.env.RUNS_SERVICE_URL?.replace(/^https?:\/\//, "") || "localhost:3000",
  schemes: process.env.RUNS_SERVICE_URL?.startsWith("https") ? ["https"] : ["http"],
  securityDefinitions: {
    apiKey: {
      type: "apiKey",
      in: "header",
      name: "X-API-Key",
      description: "API key for authenticating requests",
    },
  },
  definitions: {
    Organization: {
      id: "uuid",
      externalId: "org_clerk_123",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    User: {
      id: "uuid",
      externalId: "user_clerk_456",
      organizationId: "uuid",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    Run: {
      id: "uuid",
      organizationId: "uuid",
      userId: "uuid",
      serviceName: "my-agent",
      taskName: "generate-report",
      status: "running",
      parentRunId: null,
      startedAt: "2025-01-01T00:00:00.000Z",
      completedAt: null,
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
    RunWithCosts: {
      $ref: "#/definitions/Run",
      costs: [{ $ref: "#/definitions/Cost" }],
      ownCostInUsdCents: "0.3750000000",
      childrenCostInUsdCents: "0.1200000000",
      totalCostInUsdCents: "0.4950000000",
    },
    Cost: {
      id: "uuid",
      runId: "uuid",
      costName: "gpt-4o-input-tokens",
      quantity: "1500.000000",
      unitCostInUsdCents: "0.0002500000",
      totalCostInUsdCents: "0.3750000000",
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    CostSummary: {
      breakdown: [
        {
          key: "my-agent",
          totalCostInUsdCents: "12.5000000000",
          runCount: 5,
        },
      ],
    },
    Error: {
      error: "Error message",
    },
  },
};

const outputFile = join(projectRoot, "openapi.json");
const routes = [join(projectRoot, "src", "index.ts")];

swaggerAutogen({ openapi: "3.0.0" })(outputFile, routes, doc).then(() => {
  console.log("OpenAPI spec generated at", outputFile);
});
