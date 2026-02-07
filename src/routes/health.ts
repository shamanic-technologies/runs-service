import { Router } from "express";
import { sql } from "../db/index.js";

const router = Router();

router.get("/health", async (_req, res) => {
  let dbStatus = "ok";
  try {
    await sql`SELECT 1`;
  } catch {
    dbStatus = "unreachable";
  }

  const status = dbStatus === "ok" ? "ok" : "degraded";
  const code = status === "ok" ? 200 : 503;
  res.status(code).json({ status, service: "runs-service", database: dbStatus });
});

export default router;
