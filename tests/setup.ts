import { beforeAll, afterAll } from "vitest";

process.env.RUNS_SERVICE_DATABASE_URL =
  process.env.RUNS_SERVICE_DATABASE_URL || "postgresql://test:test@localhost/test";
process.env.RUNS_SERVICE_API_KEY = "test-api-key";
process.env.COSTS_SERVICE_URL = "http://localhost:9999";
process.env.COSTS_SERVICE_API_KEY = "test-costs-key";
process.env.NODE_ENV = "test";

beforeAll(() => console.log("Test suite starting..."));
afterAll(() => console.log("Test suite complete."));
