import { randomUUID } from "node:crypto";
import type { DB, Sql } from "../src/client";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import {
  resolveProgressiveReportedPoint,
  type ProgressiveRemoteReport,
} from "../src/progressive-remote-report";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import { verifyProgressivePolarImport } from "../../../apps/api/test/progressive-polar-import-fixture";

export async function verifyProgressiveAcceptedArchiveReplay(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  reported: ProgressiveRemoteReport,
  advisorySql: Sql,
) {
  const rollback = new Error(
    "Rollback isolated accepted-archive replay fixture",
  );
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const report = structuredClone(reported);
      const polar = report.result!.polars[0];
      const point = polar.attempts![0];
      const nu = envelope.request.fluid!.kinematic_viscosity!;
      polar.reynolds = polar.speed * polar.chord / nu;
      delete polar.mach;
      // Match the engine's explicit output fields before this report is
      // signed. The attempt projector adds the job-level recovery version.
      point.fidelity = "rans";
      point.frame_track = null;
      point.steady_history = null;
      point.quality_warnings = [];
      report.result!.mesh_recovery_version = envelope.request.expected_mesh_recovery_version ?? undefined;
      point.converged = true;
      point.stalled = false;
      point.error = null;
      point.cm = 0;
      delete point.failure_disposition;
      const stored = await storeProgressiveRemoteReport(connection, {
        solverId: envelope.solverId,
        promiseId: envelope.promiseId,
        executionId: envelope.scope.executionId,
        report,
      });
      const source = resolveProgressiveReportedPoint(report.result!, {
        alpha: point.aoa_deg,
        caseSlug: point.case_slug!,
        speed: envelope.request.speeds![0],
        chord: envelope.request.chord_lengths![0],
      });
      await verifyProgressivePolarImport(
        connection,
        {
          solverId: envelope.solverId,
          promiseId: envelope.promiseId,
          engineJobId: envelope.scope.executionId,
          engineCaseSlug: point.case_slug!,
          aoaDeg: point.aoa_deg,
          remoteResultId: randomUUID(),
          remoteResultAttemptId: randomUUID(),
          progressiveEvidence: {
            sequence: report.sequence,
            reportContentSignature: stored.contentSignature,
            pointContentSignature: source.contentSignature,
          },
        },
        advisorySql,
      );
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
