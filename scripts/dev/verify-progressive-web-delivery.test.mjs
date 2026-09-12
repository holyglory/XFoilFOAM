import assert from "node:assert/strict";
import test from "node:test";
import { webDeliveryProof } from "./verify-progressive-web-delivery.mjs";

function fixture() {
  const deployment = {
    ok: true,
    data: {
      deployment_id: "isolated-deployment",
      state: "running",
      current_generation: 3,
      readiness: { ready: true, pending_apply: false },
      components: [{ name: "web", state: "running", owned: true, port: 24002 }],
    },
  };
  return {
    before: structuredClone(deployment),
    after: structuredClone(deployment),
    sourceBefore: "a".repeat(64),
    sourceAfter: "a".repeat(64),
    body: Buffer.from(
      '<main data-testid="progressive-polar-viewer">isolated fixture</main>',
    ),
    status: 200,
    contentType: "text/html; charset=utf-8",
    checkedAt: 1234,
  };
}

test("binds a real detail response to its unchanged observed deployment and source", () => {
  const input = fixture();
  const proof = webDeliveryProof(input);
  assert.equal(proof.kind, "web-deployment");
  assert.equal(proof.observation, "web_route_passed");
  assert.equal(proof.access, "http://127.0.0.1:24002/airfoils/ag24");
  assert.equal(proof.deployment.generation_number, 3);
  assert.equal(proof.checked_at_ms, 1234);
  assert.match(proof.observed_sha256, /^[a-f0-9]{64}$/);
});

for (const [label, mutate] of [
  [
    "changed generation",
    (input) => {
      input.after.data.current_generation = 4;
    },
  ],
  [
    "changed deployment",
    (input) => {
      input.after.data.deployment_id = "other";
    },
  ],
  [
    "changed route",
    (input) => {
      input.after.data.components[0].port = 24003;
    },
  ],
  [
    "changed source",
    (input) => {
      input.sourceAfter = "b".repeat(64);
    },
  ],
  [
    "invalid source",
    (input) => {
      input.sourceBefore = input.sourceAfter = "invalid";
    },
  ],
  [
    "unapplied source",
    (input) => {
      input.after.data.readiness.pending_apply = true;
    },
  ],
  [
    "login page",
    (input) => {
      input.body = Buffer.from("<h1>Sign in</h1>");
    },
  ],
  [
    "unavailable response",
    (input) => {
      input.status = 503;
    },
  ],
  [
    "health response",
    (input) => {
      input.contentType = "application/json";
    },
  ],
  [
    "invalid observation time",
    (input) => {
      input.checkedAt = NaN;
    },
  ],
])
  test(`refuses ${label} instead of qualifying a different or unavailable surface`, () => {
    const input = fixture();
    mutate(input);
    assert.throws(() => webDeliveryProof(input));
  });
