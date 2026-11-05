import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const inputDirectory = join(root, ".codex-artifacts/fast-v2-20261105");
export const outputDirectory = join(
  root,
  "scripts/dev/.codex-artifacts/fast-v2-report-20261105-v2",
);
const campaignId = "745a31d2-ea7c-4784-84d5-c1a06613fbbf";
const queryPrefix = "hub-live-report-20261105T202817Z";
const settlementPrefix = "candidate-settlement-538e6013";
const deploymentPrefix = "release-538e6013-proof";
const retryUnitIds = [
  "3a18c662-39b3-4fe7-a4c0-232328d7eb24",
  "73732096-3da5-4291-bcd6-2c00c777d961",
  "d045a886-3dd8-4d30-b7f1-7520399fe1ec",
  "12176712-8a2c-43d2-ba1a-c7fb765b0f06",
  "3c5897ea-7f86-48c4-8de2-9dde62786114",
];
export const inputNames = [
  "first-pass-comparison.md",
  "raw-attempts-2014.json",
  "mesh-attempts-2025.json",
  ...[
    "proof.json",
    "query.sql",
    "source-queries.json",
    "stdout.jsonl",
    "stderr.txt",
    "observations.json",
    "diagnostics.json",
    "schema.json",
    "report.json",
  ].map((suffix) => `${queryPrefix}.${suffix}`),
  ...[
    "report.json",
    "benchmark-report.json",
    "summary.json",
    "settlement.json",
    "execution-proof.json",
  ].map((suffix) => `${settlementPrefix}.${suffix}`),
  ...[
    "summary.json",
    "database-query.json",
    "database.json",
    "runtime.json",
    "api-source.json",
    "sweeper-source.json",
  ].map((suffix) => `${deploymentPrefix}.${suffix}`),
];

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const parse = (files, name) =>
  JSON.parse(files.get(name).toString("utf8"));
export async function readInputs() {
  return new Map(
    await Promise.all(
      inputNames.map(async (name) => [
        name,
        await readFile(join(inputDirectory, name)),
      ]),
    ),
  );
}

function approximately(actual, expected) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
    `${actual} != ${expected}`,
  );
}

export function verifyInputs(files) {
  const query = parse(files, `${queryPrefix}.proof.json`);
  assert.equal(query.campaignId, campaignId);
  assert.equal(query.exitCode, 0);
  assert.equal(query.metadata.transactionReadOnly, "on");
  assert.equal(query.metadata.transactionIsolation, "repeatable read");
  assert.equal(query.preciseWorkCount, 0);
  for (const artifact of Object.values(query.artifacts)) {
    const bytes = files.get(basename(artifact.path));
    assert.ok(bytes, `Missing query evidence: ${artifact.path}`);
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(sha256(bytes), artifact.sha256);
  }
  const report = parse(files, `${settlementPrefix}.report.json`);
  const reportEnvelope = parse(
    files,
    `${settlementPrefix}.benchmark-report.json`,
  );
  assert.deepEqual(report, reportEnvelope.report);
  assert.equal(report.benchmarkCampaignId, campaignId);
  assert.equal(report.benchmarkOnly, true);
  assert.equal(report.preciseWorkCreated, false);
  assert.equal(report.summary.finalComparison.status, "unavailable");
  assert.equal(report.summary.finalComparison.speedup, null);
  assert.equal(report.summary.finalComparison.allAttemptCostRatio, null);
  assert.equal(report.summary.accuracy.physicalTruthCertified, false);
  assert.equal(report.summary.allAttemptCost.settled, false);
  const pairs = report.cases.flatMap((entry) => {
    assert.equal(entry.speedup, null);
    return entry.firstPassTiming.initial.pairs.map((pair) => ({
      ...pair,
      targetId: entry.targetId,
    }));
  });
  assert.equal(pairs.length, 8);
  assert.equal(
    new Set(
      pairs.map((pair) => `${pair.targetId}:${pair.alpha}:${pair.purpose}`),
    ).size,
    8,
  );
  const raw = parse(files, "raw-attempts-2014.json");
  assert.equal(raw.preciseUnits, 0);
  for (const pair of pairs) {
    assert.equal(pair.purpose, "initial");
    for (const arm of ["currentFast", "fastV2"]) {
      const evidence = pair[arm];
      const retained = raw.cases.find(
        (row) =>
          row.result_attempt_id === evidence.resultAttemptId &&
          row.token === evidence.attemptToken,
      );
      assert.ok(
        retained,
        `Missing raw first attempt: ${evidence.resultAttemptId}`,
      );
      assert.equal(retained.target_id, pair.targetId);
      assert.equal(retained.aoa_deg, pair.alpha);
      assert.equal(retained.purpose, pair.purpose);
      assert.equal(retained.unit_id, evidence.unitId);
      assert.equal(evidence.regime, "rans");
      assert.equal(retained.regime, evidence.regime);
      assert.ok(
        evidence.resultId && /^[a-f0-9]{64}$/.test(evidence.evidenceSignature),
      );
      approximately(evidence.activeSeconds, retained.attempt_seconds);
    }
  }
  const timing = report.summary.firstPassTiming.initial;
  const baseline = pairs.reduce(
    (total, pair) => total + pair.currentFast.activeSeconds,
    0,
  );
  const candidate = pairs.reduce(
    (total, pair) => total + pair.fastV2.activeSeconds,
    0,
  );
  approximately(timing.currentFastActiveSeconds, baseline);
  approximately(timing.fastV2ActiveSeconds, candidate);
  approximately(timing.costRatio, baseline / candidate);
  const accepted = pairs.filter(
    (pair) => pair.currentFast.eligible && pair.fastV2.eligible,
  );
  assert.equal(accepted.length, 1);
  assert.equal(timing.acceptedPairs.matchedPoints, 1);
  approximately(
    timing.acceptedPairs.costRatio,
    accepted[0].currentFast.activeSeconds / accepted[0].fastV2.activeSeconds,
  );
  const deltas = report.cases.flatMap((entry) =>
    entry.coefficientDeltas.map((delta) => ({
      ...delta,
      targetId: entry.targetId,
    })),
  );
  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].targetId, accepted[0].targetId);
  assert.equal(deltas[0].alpha, accepted[0].alpha);
  for (const arm of ["currentFast", "fastV2"])
    assert.equal(
      deltas[0][`${arm}Evidence`].resultAttemptId,
      accepted[0][arm].resultAttemptId,
    );
  approximately(
    deltas[0].deltaCdPercent,
    ((deltas[0].fastV2Evidence.cd - deltas[0].currentFastEvidence.cd) /
      deltas[0].currentFastEvidence.cd) *
      100,
  );
  const settlement = parse(files, `${settlementPrefix}.summary.json`);
  assert.equal(settlement.reportAsOf, reportEnvelope.asOf);
  assert.equal(settlement.anyError, false);
  assert.equal(settlement.publicPolarValuesUnchanged, true);
  assert.equal(settlement.jobs.length, 2);
  for (const job of settlement.jobs) {
    assert.equal(job.publicationCandidates, 0);
    assert.equal(job.settlementCalls, 1);
    assert.equal(job.evidenceUnchanged, true);
    assert.equal(job.outcome.counts.retry, 1);
  }
  const deployment = parse(files, `${deploymentPrefix}.summary.json`);
  assert.equal(deployment.status, "passed");
  for (const field of [
    "rawAttemptsUnchanged",
    "classificationsUnchanged",
    "selectedPointersUnchanged",
    "preciseRecipesUnchanged",
  ])
    assert.equal(deployment[field], true);
  assert.equal(deployment.engineRestarted, false);
  const allUnits = report.cases.flatMap((entry) =>
    ["currentFast", "fastV2"].flatMap((arm) =>
      entry[arm].units.map((unit) => ({
        ...unit,
        targetId: entry.targetId,
        arm,
      })),
    ),
  );
  const retryScope = retryUnitIds.map((unitId) => {
    const unit = allUnits.find((entry) => entry.unitId === unitId);
    assert.ok(unit, `Missing bounded retry unit: ${unitId}`);
    return {
      unitId,
      targetId: unit.targetId,
      arm: unit.arm,
      alpha: unit.alpha,
      purpose: unit.purpose,
      snapshotState: unit.state,
    };
  });
  return {
    reportAsOf: reportEnvelope.asOf,
    queryAsOf: query.metadata.asOf,
    deploymentAsOf: deployment.asOf,
    timing,
    deltaCdPercent: deltas[0].deltaCdPercent,
    counters: report.summary,
    retryScope,
  };
}

export function completionInventory(sourceSha256, runId) {
  assert.match(sourceSha256, /^[a-f0-9]{64}$/);
  assert.match(runId, /^t[0-9]{8}T[0-9]{6}Z-[a-f0-9]+$/);
  return {
    schema_version: 1,
    claim: "preliminary",
    source_sha256: sourceSha256,
    capabilities: [
      {
        id: "measured-first-pass-report",
        scope: "product",
        state: "real_e2e",
        expected_result:
          "Inspect real paired first-pass costs and the single eligible same-angle coefficient comparison with retained source rows and hashes; no physical-accuracy certification.",
        evidence_refs: [
          `run/${runId}/package-and-verify/measured-benchmark-report`,
          "README.md",
          "evidence/first-pass-comparison.md",
          "verification.json",
        ],
        enabled_control: false,
      },
      {
        id: "finish-five-bounded-benchmark-retries",
        scope: "product",
        state: "deferred",
        expected_result:
          "Finish the five authorized retry cases through normal admission, custody and ingestion, preserve precise work, and determine whether a final matched comparison is supportable.",
        task_id: "pdeef8c530a592ff5",
        evidence_refs: ["verification.json"],
      },
      {
        id: "retryable-worker-evidence-conflict-recovery",
        scope: "product",
        state: "deferred",
        expected_result:
          "Resolve the independently reproduced old-handler recovery failure without weakening strict retry or ownership guards.",
        task_id: "p68f4d31c56252d8e",
        evidence_refs: ["evidence/release-538e6013-proof.summary.json"],
      },
    ],
  };
}

async function main() {
  const executable =
    process.env.DEVCOORDINATOR_EXECUTOR ??
    join(
      dirname(await realpath("/usr/local/bin/devcoordinator2")),
      "devcoordinator2-executor",
    );
  const sourceDigest = () => {
    const value = JSON.parse(
      execFileSync(executable, ["source-digest", "--worktree", root], {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4096,
      }),
    );
    assert.equal(value.schema, 2);
    return value.sha256;
  };
  const sourceSha256 = sourceDigest();
  const files = await readInputs();
  const measured = verifyInputs(files);
  const manifest = {
    version: 1,
    campaignId,
    sourceSha256,
    files: inputNames.map((name) => ({
      file: `evidence/${name}`,
      bytes: files.get(name).length,
      sha256: sha256(files.get(name)),
    })),
  };
  assert.equal(process.env.DEVCOORDINATOR_CHECK_NAME, "package-and-verify");
  const completion = completionInventory(
    sourceSha256,
    process.env.DEVCOORDINATOR_RUN_ID,
  );
  const verification = {
    version: 1,
    checkedAt: new Date().toISOString(),
    scope:
      "offline retained-report verification; not a Coordinator download observation",
    ...measured,
    finalComparison: "unavailable",
    physicalTruthCertified: false,
    qualification: "pending_external_evidence",
    qualificationReason:
      "Artifact qualification requires a real HTTPS download with matching bytes. No publication or download was performed.",
    receiptRequiresParentConfirmation: true,
  };
  const retryRows = measured.retryScope
    .map(
      (unit) =>
        `| ${unit.arm} | ${unit.alpha} | ${unit.purpose} | ${unit.snapshotState} | \`${unit.unitId}\` |`,
    )
    .join("\n");
  const readme = `# Fast-v2 measured benchmark — PRELIMINARY\n\nRelease: vd0948bd01b091abc. Campaign: ${campaignId}.\n\n## Inspect the result\n\n[Measured comparison](evidence/first-pass-comparison.md), [exact report](evidence/${settlementPrefix}.report.json), [verification](verification.json), [completion inventory](completion.json), [input hashes](input-manifest.json).\n\nEight matched INITIAL first-pass RANS pairs: ${measured.timing.currentFastActiveSeconds} / ${measured.timing.fastV2ActiveSeconds} solver-active seconds = ${measured.timing.costRatio} cost ratio. This includes failed first attempts, excludes retries, and is NOT equal-accuracy speedup or campaign throughput. The only initially accepted pair has cost ratio ${measured.timing.acceptedPairs.costRatio}; candidate Cd differs by +${measured.deltaCdPercent}% against current-fast. Convergence/acceptance is not physical truth certification.\n\n## Incomplete work and observation times\n\nFinal comparison remains unavailable. Five authorized bounded retry cases remain in the handoff scope; they are NOT five snapshot-pending database rows. At ${measured.reportAsOf}, the report records ${measured.counters.unfinishedPoints} unfinished units, ${measured.counters.failedPoints} failed/gapped points, ${measured.counters.failedAttempts} failed attempts, ${measured.counters.cancelledAttempts} cancelled attempts, ${measured.counters.runningAttempts} running attempt, and ${measured.counters.missingEvidencePoints} points without eligible evidence. No new live observation is implied.\n\n| Arm | AoA | Purpose | Snapshot state | Stable unit ID |\n|---|---:|---|---|---|\n${retryRows}\n\nThe read-only query snapshot is ${measured.queryAsOf}; deployment proof is ${measured.deploymentAsOf} for 538e6013, NOT proof of the ongoing 21090849 deployment. Preserved evidence, precise recipes and engine containers are unchanged in that historical proof. The packager only reads local input files and writes this artifact; it makes no runtime or numerical changes.\n\nRetry-inclusive active cost stays separate: current-fast ${measured.counters.allAttemptCost.currentFastActiveSeconds}s; fast-v2 ${measured.counters.allAttemptCost.fastV2ActiveSeconds}s. These unfinished unequal workloads have no reported speedup or final cost ratio.\n\n## Completion and delivery limits\n\nMain outcome pdeef8c530a592ff5 remains deferred/open until the bounded cases finish and the resulting evidence is evaluated. Old-handler recovery regression p68f4d31c56252d8e remains open; no broad-suite readiness is claimed. No complete web release or scientific validation is claimed.\n\nThis is an inspectable local/Coordinator-retained artifact, not a qualified HTTPS download. The current contract requires a hash-matching HTTPS download observation before an artifact receipt can qualify. No such access was invented. Ask the parent before issuing a receipt: the supplied snapshot distinguishes three unfinished units from the five intended retry cases.\n`;
  assert.equal(sourceDigest(), sourceSha256, "Source changed while packaging");
  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory);
  await mkdir(join(outputDirectory, "evidence"));
  for (const [name, bytes] of files)
    await writeFile(join(outputDirectory, "evidence", name), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  for (const [name, value] of Object.entries({
    "completion.json": completion,
    "input-manifest.json": manifest,
    "verification.json": verification,
  }))
    await writeFile(
      join(outputDirectory, name),
      `${JSON.stringify(value, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  await writeFile(join(outputDirectory, "README.md"), readme, {
    flag: "wx",
    mode: 0o600,
  });
  for (const entry of manifest.files) {
    assert.equal(
      sha256(await readFile(join(outputDirectory, entry.file))),
      entry.sha256,
    );
    assert.equal(
      sha256(await readFile(join(inputDirectory, basename(entry.file)))),
      entry.sha256,
      "Input changed while packaging; parent confirmation required",
    );
  }
  assert.equal(sourceDigest(), sourceSha256, "Source changed while packaging");
  console.log(
    JSON.stringify({
      outputDirectory,
      sourceSha256,
      inputFiles: files.size,
      claim: completion.claim,
      finalComparison: "unavailable",
      qualified: false,
      retryScope: measured.retryScope,
      reportAsOf: measured.reportAsOf,
    }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
