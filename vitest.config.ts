import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false
    },
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "plugins/**/*.test.ts"],
    pool: "forks",
    // Remote integration runs include network round trips; local/CI keeps its original limit.
    testTimeout: process.env.NAVOCMS_NEON_TEST_RUN === "true" ? 180_000 : 10_000
  }
});
