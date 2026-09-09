import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { originFromDeployment } from "./progressive-preview-origin.mjs";

const snapshot = (port = 20027) => ({
  ok: true,
  data: {
    state: "running",
    readiness: { ready: true, pending_apply: false },
    components: [
      { name: "api", state: "running", owned: true, port: 20026 },
      { name: "web", state: "running", owned: true, port },
    ],
  },
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
