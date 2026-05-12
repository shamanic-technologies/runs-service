import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    fileParallelism: true,
    maxWorkers: 4,
    // Neon cold-start + parallel file contention can push individual ops past
    // vitest's 5s/10s defaults. 30s matches the precedent set by PR #100.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
