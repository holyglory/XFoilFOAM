import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3004";
const apiURL = process.env.PLAYWRIGHT_API_URL ?? "http://127.0.0.1:4000";
const startServers = process.env.PLAYWRIGHT_START_SERVER === "true";

export default defineConfig({
  testDir: "./apps/web/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: startServers
    ? [
        {
          command: `API_HOST=127.0.0.1 API_PORT=4000 pnpm --filter @aerodb/api dev`,
          url: `${apiURL}/health`,
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: `API_URL=${apiURL} NEXT_PUBLIC_API_URL=${apiURL} NEXT_TELEMETRY_DISABLED=1 pnpm --filter @aerodb/web exec next dev -H 127.0.0.1 -p 3004`,
          url: baseURL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ]
    : undefined,
});
