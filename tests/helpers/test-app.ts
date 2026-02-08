import express from "express";
import cors from "cors";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import healthRoutes from "../../src/routes/health.js";
import runsRoutes from "../../src/routes/runs.js";

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
  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: "Not found" });
  });
  return app;
}

export function getAuthHeaders() {
  return {
    "X-API-Key": "test-api-key",
    "Content-Type": "application/json",
  };
}
