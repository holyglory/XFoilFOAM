import assert from "node:assert/strict";
import test from "node:test";
import {
  completionInventory,
  parse,
  readInputs,
  verifyInputs,
} from "./package-fast-v2-report.mjs";

const inputs = await readInputs();

test("verifies real retained pairs, hashes and distinct unfinished retry states", () => {
  const result = verifyInputs(inputs);
  assert.equal(result.timing.matchedPoints, 8);
  assert.equal(result.timing.costRatio, 4.437856964319718);
  assert.equal(result.deltaCdPercent, 51.57206528041734);
  assert.equal(result.retryScope.length, 5);
  assert.deepEqual(result.retryScope.map((unit) => unit.snapshotState).sort(), [
    "gap",
    "gap",
    "leased",
    "pending",
    "pending",
  ]);
});

test("rejects a changed query proof input", () => {
  const changed = new Map(inputs);
  changed.set(
    "hub-live-report-20261105T202817Z.observations.json",
    Buffer.from("[]"),
  );
  assert.throws(() => verifyInputs(changed));
});

for (const [label, mutate] of [
  [
    "invented final speedup",
    (report) => {
      report.summary.finalComparison.speedup = 26;
    },
  ],
  [
    "wrong target",
    (report) => {
      report.cases[0].targetId = "another-target";
    },
  ],
  [
    "wrong angle",
    (report) => {
      report.cases[0].firstPassTiming.initial.pairs[0].alpha += 1;
    },
  ],
  [
    "missing retained attempt",
    (report) => {
      report.cases[0].firstPassTiming.initial.pairs[0].currentFast.resultAttemptId =
        "missing";
    },
  ],
  [
    "retry-inclusive paired cost",
    (report) => {
      report.summary.firstPassTiming.initial.currentFastActiveSeconds += 900;
    },
  ],
  [
    "physical certification",
    (report) => {
      report.summary.accuracy.physicalTruthCertified = true;
    },
  ],
]) {
  test(`rejects ${label}`, () => {
    const changed = new Map(inputs);
    const report = parse(inputs, "candidate-settlement-538e6013.report.json");
    const envelope = parse(
      inputs,
      "candidate-settlement-538e6013.benchmark-report.json",
    );
    mutate(report);
    envelope.report = report;
    changed.set(
      "candidate-settlement-538e6013.report.json",
      Buffer.from(JSON.stringify(report)),
    );
    changed.set(
      "candidate-settlement-538e6013.benchmark-report.json",
      Buffer.from(JSON.stringify(envelope)),
    );
    assert.throws(() => verifyInputs(changed));
  });
}

test("keeps the main benchmark and old-handler failure explicitly deferred", () => {
  const runId = "t20261105T231436Z-d40547";
  const completion = completionInventory("a".repeat(64), runId);
  assert.equal(completion.claim, "preliminary");
  assert.equal(
    completion.capabilities[0].evidence_refs[0],
    `run/${runId}/package-and-verify/measured-benchmark-report`,
  );
  assert.throws(() => completionInventory("a".repeat(64)));
  assert.deepEqual(
    completion.capabilities
      .filter((row) => row.state === "deferred")
      .map((row) => row.task_id),
    ["pdeef8c530a592ff5", "p68f4d31c56252d8e"],
  );
});
