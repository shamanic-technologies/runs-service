import express from "express";
import cors from "cors";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import healthRoutes from "./routes/health.js";
import organizationRoutes from "./routes/organizations.js";
import userRoutes from "./routes/users.js";
import runsRoutes from "./routes/runs.js";
import { db } from "./db/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT;

app.use(cors());
app.use(express.json());

// Serve generated OpenAPI spec (no auth required)
app.get("/openapi.json", async (_req, res) => {
  try {
    const specPath = join(__dirname, "..", "openapi.json");
    const spec = await readFile(specPath, "utf-8");
    res.json(JSON.parse(spec));
  } catch {
    res.status(404).json({
      error: "OpenAPI spec not found. Run: npm run generate:openapi",
    });
  }
});

app.use(healthRoutes);
app.use(organizationRoutes);
app.use(userRoutes);
app.use(runsRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(() => {
      console.log("[Runs Service] Migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(`[Runs Service] Service running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("[Runs Service] Migration failed:", err);
      process.exit(1);
    });
}

export default app;
