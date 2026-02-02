import express from "express";
import cors from "cors";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import healthRoutes from "./routes/health.js";
import organizationRoutes from "./routes/organizations.js";
import userRoutes from "./routes/users.js";
import runsRoutes from "./routes/runs.js";
import { db } from "./db/index.js";

const app = express();
const PORT = process.env.PORT;

app.use(cors());
app.use(express.json());

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
      console.log("Migrations complete");
      app.listen(Number(PORT), "::", () => {
        console.log(`Service running on port ${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}

export default app;
