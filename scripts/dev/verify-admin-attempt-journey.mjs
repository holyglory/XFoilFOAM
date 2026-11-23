import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "@playwright/test";
import {
  progressivePreviewDeployment,
  originFromDeployment,
} from "./progressive-preview-origin.mjs";

const deployment = progressivePreviewDeployment({ name: "catalog-paging" });
const origin = originFromDeployment(deployment);
assert.equal(new URL(origin).hostname, "127.0.0.1");
const api = await request.newContext({ baseURL: origin });
const scratch = await mkdtemp(join(tmpdir(), "catalog-admin-e2e-"));
try {
  const password = await readFile(
    ".codex-artifacts/catalog-page-auth/" +
      deployment.data.current_generation +
      "/password",
    "utf8",
  );
  const response = await api.post("/api/admin/login", {
    data: { email: "catalog-qa@example.invalid", password },
  });
  assert.equal(response.status(), 200);
  assert.equal((await (await api.get("/api/admin/me")).json()).authed, true);
  const storageState = join(scratch, "session.json");
  await api.storageState({ path: storageState });
  const result = spawnSync(
    "corepack",
    [
      "pnpm",
      "exec",
      "playwright",
      "test",
      "apps/web/e2e/campaign-management.spec.ts",
      "--grep",
      "campaign cell modal locks the page",
      "--workers=1",
      "--retries=0",
      "--timeout=180000",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PLAYWRIGHT_BASE_URL: origin,
        PLAYWRIGHT_API_URL: origin,
        PLAYWRIGHT_START_SERVER: "false",
        PLAYWRIGHT_STORAGE_STATE: storageState,
      },
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await api.dispose();
  await rm(scratch, { recursive: true, force: true });
}
