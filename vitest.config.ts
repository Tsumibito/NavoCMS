import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false
    },
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "plugins/**/*.test.ts"],
    pool: "forks",
    testTimeout: 10_000
  }
});
