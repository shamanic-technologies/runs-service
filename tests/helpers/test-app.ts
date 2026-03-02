import express from "express";
import cors from "cors";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import healthRoutes from "../../src/routes/health.js";
import runsRoutes from "../../src/routes/runs.js";
import statsRoutes from "../../src/routes/stats.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..", "..");

export function createTestApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/openapi.json", async (_req, res) => {
    try {
      const specPath = join(projectRoot, "openapi.json");
      const spec = await readFile(specPath, "utf-8");
      res.json(JSON.parse(spec));
    } catch {
      res.status(404).json({
        error: "OpenAPI spec not found. Run: npm run generate:openapi",
      });
    }
  });

  app.use(healthRoutes);
  app.use(runsRoutes);
  app.use(statsRoutes);
  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: "Not found" });
  });
  return app;
}

const TEST_ORG_ID = "11111111-1111-1111-1111-111111111111";
const TEST_USER_ID = "22222222-2222-2222-2222-222222222222";

export function getAuthHeaders(overrides?: { orgId?: string; userId?: string }) {
  return {
    "X-API-Key": "test-api-key",
    "Content-Type": "application/json",
    "x-org-id": overrides?.orgId || TEST_ORG_ID,
    "x-user-id": overrides?.userId || TEST_USER_ID,
  };
}

export { TEST_ORG_ID, TEST_USER_ID };
