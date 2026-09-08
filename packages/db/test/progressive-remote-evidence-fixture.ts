import { randomUUID } from "node:crypto";
import { verifyProgressiveRemoteEvidenceReceipt } from "./progressive-remote-evidence-receipt-fixture";
import { verifyProgressivePolarImport } from "../../../apps/api/test/progressive-polar-import-fixture";
import { expect } from "vitest";
import type { JobResult } from "../../engine-client/src";
import type { DB, Sql } from "../src/client";
import {
  progressiveArchiveManifestBytes,
  progressiveArchiveManifestSha256,
} from "./progressive-archive-data";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import {
  assertProgressiveReportedManifest,
  resolveProgressiveRemoteEvidence,
} from "../src/progressive-remote-evidence";
import {
  resolveProgressiveReportedPoint,
  validateProgressiveRemoteReport,
  type ProgressiveRemoteReport,
} from "../src/progressive-remote-report";

export function progressiveRemoteEvidenceResult(
  envelope: ProgressiveRemoteExecutionEnvelope,
): JobResult {
  const runtime = {
    ...envelope.request.expected_engine!,
    build_id: "isolated-reported-evidence",
    application_source_sha256: "d".repeat(64),
  };
  return {
    job_id: envelope.scope.executionId,
    state: "running",
    engine: runtime,
    execution_pool: envelope.request.expected_execution_pool,
    polars: [
      {
        speed: envelope.request.speeds![0],
        chord: envelope.request.chord_lengths![0],
        reynolds: 2000000,
        points: [],
        attempts: [
          {
            aoa_deg: envelope.scope.units[0].alpha,
            case_slug: "isolated-reported-case",
            engine: runtime,
            cl: 0.4,
            cd: 0.03,
            converged: false,
            unsteady: false,
            first_order_fallback: false,
            images: {},
            error: "isolated unconverged source",
            failure_disposition: "hard_solver",
            solver_active_seconds: 1,
            evidence_artifacts: [
              {
                kind: "manifest",
                path: "isolated-case/evidence_manifest.json",
                mime_type: "application/json",
                sha256: progressiveArchiveManifestSha256,
                byte_size: progressiveArchiveManifestBytes.byteLength,
              },
            ],
          },
        ],
      },
    ],
  };
}

export async function verifyProgressiveRemoteEvidenceSource(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  report: ProgressiveRemoteReport,
  advisorySql: Sql,
) {
  const source = resolveProgressiveReportedPoint(report.result!, {
    alpha: envelope.scope.units[0].alpha,
    speed: envelope.request.speeds![0],
    chord: envelope.request.chord_lengths![0],
    caseSlug: "isolated-reported-case",
  });
  const input = {
    solverId: envelope.solverId,
    promiseId: envelope.promiseId,
    engineJobId: envelope.scope.executionId,
    aoaDeg: source.point.aoa_deg,
    engineCaseSlug: source.point.case_slug!,
    progressiveEvidence: {
      sequence: report.sequence,
      reportContentSignature: validateProgressiveRemoteReport(report, envelope)
        .contentSignature,
      pointContentSignature: source.contentSignature,
    },
  };
  const resolved = await resolveProgressiveRemoteEvidence(db, input);
  expect(resolved?.point).toEqual(source.point);
  expect(resolved?.report).toEqual(report);
  expect(() =>
    assertProgressiveReportedManifest(resolved!, {
      manifestSha256: progressiveArchiveManifestSha256,
      manifestByteSize: progressiveArchiveManifestBytes.byteLength,
    }),
  ).not.toThrow();
  expect(() =>
    assertProgressiveReportedManifest(resolved!, {
      manifestSha256: "b".repeat(64),
      manifestByteSize: progressiveArchiveManifestBytes.byteLength,
    }),
  ).toThrow("reported source evidence");
  expect(() =>
    assertProgressiveReportedManifest(resolved!, {
      manifestSha256: progressiveArchiveManifestSha256,
      manifestByteSize: progressiveArchiveManifestBytes.byteLength + 1,
    }),
  ).toThrow("reported source evidence");
  await expect(
    resolveProgressiveRemoteEvidence(db, {
      ...input,
      progressiveEvidence: undefined,
    }),
  ).rejects.toThrow("exact report and point signatures");
  await expect(
    resolveProgressiveRemoteEvidence(db, { ...input, solverId: randomUUID() }),
  ).rejects.toThrow("does not own");
  await expect(
    resolveProgressiveRemoteEvidence(db, {
      ...input,
      engineJobId: randomUUID(),
    }),
  ).rejects.toThrow("does not own");
  await expect(
    resolveProgressiveRemoteEvidence(db, { ...input, promiseId: randomUUID() }),
  ).rejects.toThrow("no exact stored dispatch");
  await expect(
    resolveProgressiveRemoteEvidence(db, {
      ...input,
      engineCaseSlug: "another-case",
    }),
  ).rejects.toThrow("missing");
  await expect(
    resolveProgressiveRemoteEvidence(db, {
      ...input,
      progressiveEvidence: { ...input.progressiveEvidence, sequence: 1000 },
    }),
  ).rejects.toThrow("has not reached");
  await expect(
    resolveProgressiveRemoteEvidence(db, {
      ...input,
      progressiveEvidence: {
        ...input.progressiveEvidence,
        reportContentSignature: "0".repeat(64),
      },
    }),
  ).rejects.toThrow("stored report");
  await expect(
    resolveProgressiveRemoteEvidence(db, {
      ...input,
      progressiveEvidence: {
        ...input.progressiveEvidence,
        pointContentSignature: "0".repeat(64),
      },
    }),
  ).rejects.toThrow("exact reported point");
  expect(
    await resolveProgressiveRemoteEvidence(db, {
      ...input,
      promiseId: randomUUID(),
      progressiveEvidence: undefined,
    }),
  ).toBeNull();
  await verifyProgressiveRemoteEvidenceReceipt(db, {
    ...input,
    remoteResultId: randomUUID(),
    remoteResultAttemptId: randomUUID(),
  });
  await verifyProgressivePolarImport(
    db,
    {
      ...input,
      remoteResultId: randomUUID(),
      remoteResultAttemptId: randomUUID(),
    },
    advisorySql,
  );
}
