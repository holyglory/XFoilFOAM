import { spawnSync } from "node:child_process";
import { progressivePreviewOrigin } from "./progressive-preview-origin.mjs";

const origin = progressivePreviewOrigin();
const result = spawnSync(
  "/usr/bin/corepack",
  [
    "pnpm",
    "exec",
    "playwright",
    "test",
    "point-history.spec.ts",
    "--grep",
    "Points tab lists rows and the story panel owns scroll/focus",
    "--project",
    "chromium",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PLAYWRIGHT_BASE_URL: origin,
      PLAYWRIGHT_API_URL: origin,
      PLAYWRIGHT_START_SERVER: "false",
    },
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
