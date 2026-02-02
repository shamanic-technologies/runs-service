import express from "express";
import cors from "cors";
import healthRoutes from "../../src/routes/health.js";
import organizationRoutes from "../../src/routes/organizations.js";
import userRoutes from "../../src/routes/users.js";
import runsRoutes from "../../src/routes/runs.js";

export function createTestApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(healthRoutes);
  app.use(organizationRoutes);
  app.use(userRoutes);
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
