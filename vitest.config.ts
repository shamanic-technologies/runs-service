import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // Integration files share one database, and several public/internal endpoints
    // intentionally read across orgs. Run files serially so cleanup hooks do not
    // delete rows another file is asserting against.
    fileParallelism: false,
    maxWorkers: 1,
    // Neon cold-start + parallel file contention can push individual ops past
    // vitest's 5s/10s defaults. 30s matches the precedent set by PR #100.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
