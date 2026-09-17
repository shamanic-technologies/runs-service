import { Router } from "express";
import { sql } from "../db/index.js";
import { probeDatabase } from "./health-probe.js";

const HEALTH_PROBE_TIMEOUT_MS = 2_000;

const router = Router();

router.get("/health", async (_req, res) => {
  const dbStatus = await probeDatabase(
    () => sql`SELECT 1`,
    HEALTH_PROBE_TIMEOUT_MS,
  );

  const status = dbStatus === "ok" ? "ok" : "degraded";
  const code = status === "ok" ? 200 : 503;
  res.status(code).json({ status, service: "runs-service", database: dbStatus });
});

export default router;
