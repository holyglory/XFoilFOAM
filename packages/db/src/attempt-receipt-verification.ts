import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import { readProgressiveReport } from "./progressive-report-reader";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import {
  resolveProgressiveReportedPoint,
  validateProgressiveRemoteReport,
} from "./progressive-remote-report";
import { progressiveRemotePointProjection } from "./progressive-remote-point-projection";

export const RECEIPT_SOURCE_VERIFIER =
  "server-consumers/receipt-bearing-rans-v1";

interface ReceiptScope {
  attemptId: string;
  resultId: string;
  simJobId: string;
  engineJobId: string;
  scientific: {
    attemptToken: string;
    applicationSha256: string;
    unitId: string;
  } | null;
  remote: {
    solverId: string;
    promiseId: string;
    executionId: string;
    sequence: number;
    assignmentSignature: string;
    reportContentSignature: string;
    pointContentSignature: string;
    remoteResultId: string;
    remoteResultAttemptId: string;
    storageOnly: boolean;
    aoaDeg: number;
    caseSlug: string | null;
  } | null;
}

/** Archive custody is checked by the settlement service. This proof binds the
 * original application value to its independent CFD receipt and/or retained
 * signed report. Existing administrative sender status does not grant or
 * revoke the hub's custody of a previously accepted immutable source. */
export async function verifyProgressiveAttemptReceipt(
  db: DB,
  attemptId: string,
  originalText: string,
) {
  const [row] = await db.execute(
    sql`SELECT attempt_evidence_receipt_scope(${attemptId}::uuid) AS scope`,
  );
  const scope = row?.scope as ReceiptScope | null;
  if (
    !scope ||
    (!scope.scientific && !scope.remote) ||
    scope.attemptId !== attemptId
  )
    throw new Error(
      "Scientific storage requires the exact settled progressive receipt",
    );
  const app = analysisContentHash(JSON.parse(originalText));
  if (scope.scientific && scope.scientific.applicationSha256 !== app)
    throw new Error(
      "Full original differs from the immutable CFD evidence signature",
    );
  let reportedApplicationSha256: string | undefined;
  if (scope.remote) {
    const r = scope.remote;
    const [dispatch] =
      await db.execute(sql`SELECT envelope FROM progressive_remote_dispatches WHERE sim_job_id=${scope.simJobId}::uuid
      AND solver_id=${r.solverId}::uuid AND promise_id=${r.promiseId}::uuid AND content_signature=${r.assignmentSignature}`);
    if (!dispatch)
      throw new Error("Original progressive report dispatch changed");
    const envelope = verifyProgressiveRemoteExecution(dispatch.envelope, {
      executionId: r.executionId,
      solverId: r.solverId,
      promiseId: r.promiseId,
      contentSignature: r.assignmentSignature,
    });
    const body = await readProgressiveReport(db, {
      sourceKind: "remote",
      executionId: r.executionId,
      sequence: r.sequence,
      contentSignature: r.reportContentSignature,
    });
    const { report, contentSignature } = validateProgressiveRemoteReport(
      body,
      envelope,
    );
    if (!report.result || contentSignature !== r.reportContentSignature)
      throw new Error("Exact progressive report receipt no longer verifies");
    const point = resolveProgressiveReportedPoint(report.result, {
      alpha: r.aoaDeg,
      caseSlug: r.caseSlug,
      speed: envelope.request.speeds![0],
      chord: envelope.request.chord_lengths![0],
    });
    if (point.contentSignature !== r.pointContentSignature)
      throw new Error("Reported point differs from its immutable receipt");
    reportedApplicationSha256 = analysisContentHash(
      progressiveRemotePointProjection({ ...point, envelope, report })
        .evidencePayload,
    );
    if (reportedApplicationSha256 !== app)
      throw new Error(
        "Reported point differs from its archived scientific original",
      );
  }
  return {
    progressiveScope: scope as unknown as Record<string, unknown>,
    applicationSha256: app,
    ...(reportedApplicationSha256 ? { reportedApplicationSha256 } : {}),
  };
}
