import assert from "node:assert/strict";
import test from "node:test";
import { originFromDeployment } from "./progressive-preview-origin.mjs";

const snapshot = (port = 20027) => ({
  ok: true,
  data: {
    state: "running",
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
