// vitest config (ESM)
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Database suites share one local Postgres; run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
