import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertEngineHealth,
  engineUrlFromDeployment,
  progressiveEngineUrl,
} from "./progressive-preview-engine.mjs";
import {
  originFromDeployment,
  progressivePreviewDeployment,
  progressivePreviewOrigin,
} from "./progressive-preview-origin.mjs";

const snapshot = (port = 20027) => ({
  ok: true,
  data: {
    deployment_id: "existing-preview",
    state: "running",
    readiness: { ready: true, pending_apply: false },
    components: [
      { name: "api", state: "running", owned: true, port: 20026 },
      { name: "web", state: "running", owned: true, port },
    ],
  },
});

function lookupFixture(response = snapshot()) {
  const calls = [];
  return {
    calls,
    execute(executable, args, options) {
      calls.push({ executable, args, options });
      return JSON.stringify(response);
    },
  };
}

function engineSnapshot(port = 24000) {
  return {
    ok: true,
    data: {
      name: "progressive-engine",
      public: false,
      state: "running",
      components: [
        {
          name: "engine",
          owned: true,
          state: "running",
          health: "healthy",
          port,
        },
      ],
    },
  };
}

test("resolves the private engine through the v3 read-only operation", () => {
  const lookup = lookupFixture(engineSnapshot());
  assert.equal(
    progressiveEngineUrl({ execute: lookup.execute }),
    "http://127.0.0.1:24000",
  );
  assert.deepEqual(lookup.calls, [
    {
      executable: "/usr/local/bin/devcoordinator2",
      args: [
        "--client",
        "codex",
        "call",
        "deployment.status",
        "--params",
        JSON.stringify({
          path: fileURLToPath(new URL("../../", import.meta.url)),
          name: "progressive-engine",
        }),
      ],
      options: { encoding: "utf8", timeout: 30000, maxBuffer: 256 * 1024 },
    },
  ]);
  assert.equal(
    engineUrlFromDeployment(engineSnapshot(24500)),
    "http://127.0.0.1:24500",
  );
});

test("rejects the wrong, public, stopped, unhealthy or unowned engine", () => {
  for (const invalid of [null, {}, { ok: false }, { ok: true, data: {} }])
    assert.throws(() => engineUrlFromDeployment(invalid));
  for (const change of [
    { name: "progressive-preview" },
    { public: true },
    { public: undefined },
    { state: "stopped" },
    { components: [] },
  ]) {
    const response = engineSnapshot();
    Object.assign(response.data, change);
    assert.throws(() => engineUrlFromDeployment(response));
  }
  for (const change of [
    { name: "api" },
    { owned: false },
    { state: "stopped" },
    { health: "unhealthy" },
    { port: null },
    { port: "24000" },
    { port: 24000.5 },
  ]) {
    const response = engineSnapshot();
    Object.assign(response.data.components[0], change);
    assert.throws(() => engineUrlFromDeployment(response));
  }
});

test("keeps the exact OpenCFD version and validation build requirement", () => {
  const health = {
    default_engine: { distribution: "opencfd", version: "2606" },
    build_id: "progressive-local-validation",
  };
  assert.doesNotThrow(() => assertEngineHealth(health));
  for (const invalid of [
    null,
    {},
    { ...health, build_id: "other-build" },
    { ...health, default_engine: { distribution: "foundation", version: "2606" } },
    { ...health, default_engine: { distribution: "opencfd", version: "2512" } },
  ])
    assert.throws(() => assertEngineHealth(invalid));
});

test("propagates an engine lookup failure without a fallback or retry", () => {
  const failure = new Error("Coordinator unavailable");
  let calls = 0;
  assert.throws(
    () =>
      progressiveEngineUrl({
        execute() {
          calls += 1;
          throw failure;
        },
      }),
    failure,
  );
  assert.equal(calls, 1);
});

test("queries the current worktree through the v3 read-only operation", () => {
  const lookup = lookupFixture();
  const response = progressivePreviewDeployment({
    deploymentId: null,
    execute: lookup.execute,
  });
  assert.equal(originFromDeployment(response), "http://127.0.0.1:20027");
  assert.deepEqual(lookup.calls, [
    {
      executable: "/usr/local/bin/devcoordinator2",
      args: [
        "--client",
        "codex",
        "call",
        "deployment.status",
        "--params",
        JSON.stringify({
          path: fileURLToPath(new URL("../../", import.meta.url)),
          name: "progressive-preview",
        }),
      ],
      options: { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 },
    },
  ]);
});

test("targets an existing deployment without binding it to the candidate worktree", () => {
  const lookup = lookupFixture();
  assert.equal(
    progressivePreviewOrigin({
      deploymentId: "existing-preview",
      execute: lookup.execute,
    }),
    "http://127.0.0.1:20027",
  );
  assert.equal(lookup.calls.length, 1);
  assert.deepEqual(lookup.calls[0].args, [
    "--client",
    "codex",
    "call",
    "deployment.status",
    "--params",
    JSON.stringify({ deployment_id: "existing-preview" }),
  ]);
});

test("uses the deployment ID environment override unless an explicit ID is supplied", () => {
  const previous = process.env.PROGRESSIVE_PREVIEW_DEPLOYMENT_ID;
  process.env.PROGRESSIVE_PREVIEW_DEPLOYMENT_ID = "existing-preview";
  try {
    const lookup = lookupFixture();
    assert.equal(
      progressivePreviewOrigin({ execute: lookup.execute }),
      "http://127.0.0.1:20027",
    );
    assert.deepEqual(JSON.parse(lookup.calls[0].args[5]), {
      deployment_id: "existing-preview",
    });
    const response = snapshot();
    response.data.deployment_id = "explicit-preview";
    const explicitLookup = lookupFixture(response);
    progressivePreviewOrigin({
      deploymentId: "explicit-preview",
      execute: explicitLookup.execute,
    });
    assert.deepEqual(JSON.parse(explicitLookup.calls[0].args[5]), {
      deployment_id: "explicit-preview",
    });
  } finally {
    if (previous === undefined)
      delete process.env.PROGRESSIVE_PREVIEW_DEPLOYMENT_ID;
    else process.env.PROGRESSIVE_PREVIEW_DEPLOYMENT_ID = previous;
  }
});

test("rejects invalid explicit IDs before invoking the CLI", () => {
  const lookup = lookupFixture();
  for (const deploymentId of ["", " ", 0, false])
    assert.throws(
      () =>
        progressivePreviewDeployment({
          deploymentId,
          execute: lookup.execute,
        }),
      /deployment ID/,
    );
  assert.equal(lookup.calls.length, 0);
});

test("does not fall back to another deployment after a failed or mismatched lookup", () => {
  const stale = snapshot();
  stale.data.readiness.pending_apply = true;
  for (const response of [
    { ok: false, error: { code: "deployment_not_found" } },
    snapshot(),
    stale,
  ]) {
    const lookup = lookupFixture(response);
    assert.throws(() =>
      progressivePreviewOrigin({
        deploymentId: "requested-preview",
        execute: lookup.execute,
      }),
    );
    assert.equal(lookup.calls.length, 1);
  }
  const failure = new Error("Coordinator unavailable");
  assert.throws(
    () =>
      progressivePreviewOrigin({
        deploymentId: null,
        execute() {
          throw failure;
        },
      }),
    failure,
  );
});

test("uses the actual web allocation rather than a prior or API port", () => {
  assert.equal(originFromDeployment(snapshot()), "http://127.0.0.1:20027");
  assert.equal(originFromDeployment(snapshot(24500)), "http://127.0.0.1:24500");
});

test("keeps the persistent engine separate from expiring disposable validation", () => {
  const path = fileURLToPath(
    new URL("../../.devcoordinator.toml", import.meta.url),
  );
  const deployments = JSON.parse(
    execFileSync(
      "/usr/bin/python3",
      [
        "-c",
        "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))['deployment']))",
        path,
      ],
      { encoding: "utf8" },
    ),
  );
  const persistent = deployments["progressive-engine"];
  const disposable = deployments["progressive-test-engine"];
  assert.equal(persistent.ttl_seconds, undefined);
  assert.equal(persistent.component.engine.build, false);
  assert.deepEqual(persistent.component.engine.services, [
    "redis",
    "gateway",
    "worker",
  ]);
  assert.deepEqual(persistent.component.engine.finite_services, []);
  assert(
    persistent.component.engine.files.includes(
      "compose.progressive-preview-engine.yml",
    ),
  );
  assert(disposable.ttl_seconds > 0);
  assert.equal(disposable.component.engine.build, true);
  assert(disposable.component.engine.finite_services.includes("control-check"));
});

test("refuses missing, ambiguous, stopped, unowned and invalid allocations", () => {
  for (const invalid of [
    null,
    {},
    { ok: false },
    { ok: true, data: { state: "stopped" } },
  ])
    assert.throws(() => originFromDeployment(invalid));
  for (const port of [null, "20027", 0, 65536, 20027.5])
    assert.throws(() => originFromDeployment(snapshot(port)));
  for (const change of [{ state: "stopped" }, { owned: false }]) {
    const response = snapshot();
    Object.assign(response.data.components[1], change);
    assert.throws(() => originFromDeployment(response));
  }
  const response = snapshot();
  response.data.components.push({ ...response.data.components[1] });
  assert.throws(() => originFromDeployment(response));
});

test("refuses missing, stale and unfinished source readiness even at a running port", () => {
  for (const readiness of [
    undefined,
    {},
    { ready: false, pending_apply: true },
    { ready: true, pending_apply: true },
    { ready: false, pending_apply: false },
  ]) {
    const response = snapshot();
    response.data.readiness = readiness;
    assert.throws(() => originFromDeployment(response), /finished applying/);
  }
});
