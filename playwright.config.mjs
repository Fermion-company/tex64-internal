import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.js",
  timeout: 30000,
  expect: {
    timeout: 10000,
  },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
});
