import { sql } from "drizzle-orm";
import { requireBoundedSettledReport } from "./hz-settled-report-bounds";
import type { DB } from "@aerodb/db/client";
import { getAttemptEvidenceArchive } from "@aerodb/db/attempt-evidence-catalog";
import { readProgressiveReport } from "@aerodb/db/progressive-report-reader";
import { verifyProgressiveRemoteExecution } from "@aerodb/db/progressive-remote-execution";
import { isFinalProgressiveRemoteReport, resolveProgressiveReportedPoint, validateProgressiveRemoteReport } from "@aerodb/db/progressive-remote-report";
import { progressiveRemotePointProjection } from "@aerodb/db/progressive-remote-point-projection";
import { reportTextIdentity } from "@aerodb/db/progressive-report-archive";

interface SignedWorkerPoint {
  attempt: string;
  result: string;
  job: string;
  archive: string;
  instance: string;
  solver: string;
  promise: string;
  assignment: string;
  report: string;
  sequence: number;
  point: string;
  stopReport: string;
  stopSequence: number;
  selectionSha256: string;
}

export interface HzSettledReceiptScope extends SignedWorkerPoint {
  contract: "settled-receipt-v3";
  hubResult: string;
  hubAttempt: string;
  storageOnly: boolean;
}

export interface HzClosedFailureScope extends SignedWorkerPoint {
  contract: "closed-undelivered-v1";
  failureHttp: number;
  failureSha256: string;
}
export type HzSignedPointScope = HzSettledReceiptScope | HzClosedFailureScope;

export async function settledWorkerScope(db: DB, attemptId: string, archiveId?: string) {
  const [row] = await db.execute(sql`SELECT attempt_evidence_hz_settled_scope(${attemptId}::uuid,${archiveId ?? null}::uuid) AS scope,
    EXISTS(SELECT FROM pg_proc p JOIN pg_class a ON a.oid=to_regclass('result_attempts') AND a.relnamespace=p.pronamespace
      WHERE p.oid=to_regprocedure('attempt_evidence_hz_closed_failure_scope(uuid,uuid)')) AS has_failure_reader`);
  if (row?.scope || row?.has_failure_reader !== true) return (row?.scope ?? null) as HzSettledReceiptScope | null;
  const [failure] = await db.execute(sql`SELECT CASE WHEN attempt_evidence_tiny_selected(${attemptId}::uuid,${archiveId ?? null}::uuid)
    THEN attempt_evidence_hz_closed_failure_scope(${attemptId}::uuid,${archiveId ?? null}::uuid) END AS scope`);
  return (failure?.scope ?? null) as HzClosedFailureScope | null;
}

/** The observed point can precede the final report. Authenticate each sequence
 * under the same assignment before using the producer's original projection. */
export async function readSettledWorkerPoint(db: DB, scope: HzSignedPointScope, signal?: AbortSignal) {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver")
    throw new Error("Settled worker points require the registered worker");
  signal?.throwIfAborted();
  const [row] = await db.execute(sql`SELECT j.request_payload->'remoteProgressiveExecution' AS envelope,
    a.aoa_deg,a.engine_case_slug,a.regime,a.status,a.source,a.cl,a.cd,a.cm,a.converged,a.unsteady
    FROM result_attempts a JOIN sim_jobs j ON j.id=a.sim_job_id
    WHERE a.id=${scope.attempt}::uuid AND a.result_id=${scope.result}::uuid AND j.id=${scope.job}::uuid`);
  if (!row) throw new Error("Worker point owner changed");
  const archive = await getAttemptEvidenceArchive(db, scope.archive);
  if (archive.attemptId !== scope.attempt || archive.resultId !== scope.result ||
      archive.simJobId !== scope.job || archive.sourceInstance !== scope.instance)
    throw new Error("Worker original belongs to a different source");
  const owner = { solverId: scope.solver, promiseId: scope.promise, assignmentSignature: scope.assignment };
  const envelope = verifyProgressiveRemoteExecution(row.envelope, {
    solverId: scope.solver, promiseId: scope.promise, executionId: scope.job, contentSignature: scope.assignment,
  });
  async function reportAt(sequence: number, signature: string) {
    signal?.throwIfAborted();
    await requireBoundedSettledReport(db, scope.job, sequence, signature);
    const body = await readProgressiveReport(db, { sourceKind: "worker", executionId: scope.job, sequence, contentSignature: signature }, owner);
    signal?.throwIfAborted();
    const validated = validateProgressiveRemoteReport(body, envelope);
    if (validated.contentSignature !== signature || validated.report.sequence !== sequence)
      throw new Error("Worker report signature or sequence changed");
    return validated.report;
  }
  const pointReport = await reportAt(scope.sequence, scope.report);
  const stop = scope.sequence === scope.stopSequence && scope.report === scope.stopReport
    ? pointReport : await reportAt(scope.stopSequence, scope.stopReport);
  if (scope.stopSequence < scope.sequence || !isFinalProgressiveRemoteReport(stop) ||
      stop.stopProof?.execution_stopped !== true || !pointReport.result)
    throw new Error("Signed execution stop or acknowledged point is missing");
  const reported = resolveProgressiveReportedPoint(pointReport.result, {
    alpha: Number(row.aoa_deg), caseSlug: row.engine_case_slug as string | null,
    speed: envelope.request.speeds![0], chord: envelope.request.chord_lengths![0],
  });
  const point = progressiveRemotePointProjection({ ...reported, report: pointReport, envelope });
  if (reported.contentSignature !== scope.point || point.regime !== row.regime || point.status !== row.status ||
      point.source !== row.source || point.cl !== row.cl || point.cd !== row.cd || point.cm !== row.cm ||
      point.converged !== row.converged || point.unsteady !== row.unsteady)
    throw new Error("Signed point differs from its stored scientific evidence");
  const [original] = await db.execute(sql`SELECT (${JSON.stringify(point.evidencePayload)}::text::jsonb)::text AS payload`);
  if (typeof original?.payload !== "string") throw new Error("Signed point projection is missing");
  const identity = reportTextIdentity(original.payload);
  if (identity.sha256 !== archive.sourceSha256 || identity.byteSize !== archive.sourceByteSize)
    throw new Error("Signed point differs from the native PostgreSQL original");
  return { archive, payloadText: original.payload, finalPointReport: isFinalProgressiveRemoteReport(pointReport) };
}
