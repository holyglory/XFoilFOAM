import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const mode = process.argv[2];
assert(["api", "solver"].includes(mode));
assert.equal(process.env.DC2_COMPONENT, mode);
assert(
  process.env.DC2_POSTGRES_DB_URL &&
    process.env.DATABASE_URL === process.env.DC2_POSTGRES_DB_URL,
);
const deployment = JSON.parse(
  execFileSync(
    "/usr/local/bin/devcoordinator2",
    ["deployment", "status", "--deployment-id", "d22e893b29a0534a6"],
    { encoding: "utf8", timeout: 30000, maxBuffer: 256 * 1024 },
  ),
);
assert(
  deployment.ok &&
    deployment.data.name === "progressive-engine" &&
    deployment.data.public === false &&
    deployment.data.state === "running",
);
const component = deployment.data.components.find(
  (item) => item.name === "engine",
);
assert(
  component?.owned &&
    component.state === "running" &&
    component.health === "healthy" &&
    Number.isInteger(component.port),
);
const engineUrl = `http://127.0.0.1:${component.port}`;
const credential = readFileSync(
  new URL("../../.codex-artifacts/progressive-engine.env", import.meta.url),
  "utf8",
);
const token = /^ENGINE_CONTROL_PLANE_TOKEN=([a-f0-9]{64})$/m.exec(
  credential,
)?.[1];
assert(
  token &&
    /^AIRFOILFOAM_CONTROL_PLANE_TOKEN=([a-f0-9]{64})$/m.exec(
      credential,
    )?.[1] === token,
);
const response = await fetch(`${engineUrl}/health`, {
  signal: AbortSignal.timeout(15000),
});
assert(response.ok);
const health = await response.json();
assert(
  health.default_engine?.distribution === "opencfd" &&
    health.default_engine?.version === "2606" &&
    health.build_id === "progressive-local-validation",
);
const env = {
  ...process.env,
  ENGINE_URL: engineUrl,
  ENGINE_DISTRIBUTION: health.default_engine.distribution,
  ENGINE_VERSION: health.default_engine.version,
  ENGINE_NUMERICS_REVISION: health.default_engine.numerics_revision,
  ENGINE_ADAPTER_CONTRACT_VERSION: String(
    health.default_engine.adapter_contract_version,
  ),
  ENGINE_CONTROL_PLANE_TOKEN: token,
  ENGINE_EXPECTED_BUILD_ID: health.build_id,
  AIRFOILFOAM_BUILD_ID: health.build_id,
  AIRFOILFOAM_EVIDENCE_BUCKET: "",
  AIRFOILFOAM_EVIDENCE_REMOTE_ONLY: "false",
};
if (mode === "solver")
  execFileSync(
    process.execPath,
    ["--import", "tsx", "packages/db/src/seed-progressive-cfd-preview.ts"],
    { cwd: root, env, stdio: "inherit", timeout: 120000 },
  );
const child = spawn(
  "/usr/bin/corepack",
  [
    "pnpm",
    "--filter",
    mode === "api" ? "@aerodb/api" : "@aerodb/sweeper",
    "start",
  ],
  {
    cwd: root,
    env,
    stdio: "inherit",
    detached: true,
  },
);
let alive = true;
const server =
  mode === "solver"
    ? createServer((request, response) => {
        response.writeHead(request.url === "/health" && alive ? 200 : 503, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ controllerProcessRunning: alive }));
      })
    : null;
server?.listen(Number(process.env.PORT), "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    if (child.pid && alive) process.kill(-child.pid, signal);
    setTimeout(() => {
      if (child.pid && alive) process.kill(-child.pid, "SIGKILL");
    }, 30000).unref();
  });
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
  server?.close();
});
child.once("exit", (code, signal) => {
  alive = false;
  server?.close();
  process.exitCode = code ?? (signal ? 1 : 0);
});
