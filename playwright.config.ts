import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "apps",
  testMatch: "**/tests/*.spec.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  snapshotPathTemplate: "{testDir}/{testFileDir}/__screenshots__/{arg}{ext}",
  use: {
    baseURL: "http://127.0.0.1:4321",
    browserName: "chromium",
    colorScheme: "light",
    locale: "en-US",
    reducedMotion: "reduce"
  },
  webServer: {
    command: "node scripts/serve-catalogue.mjs",
    port: 4321,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  }
});
