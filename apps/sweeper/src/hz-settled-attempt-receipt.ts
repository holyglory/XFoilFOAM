import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import { getAttemptEvidenceArchive } from "@aerodb/db/attempt-evidence-catalog";
import { readProgressiveReport } from "@aerodb/db/progressive-report-reader";
import { verifyProgressiveRemoteExecution } from "@aerodb/db/progressive-remote-execution";
import { isFinalProgressiveRemoteReport, resolveProgressiveReportedPoint, validateProgressiveRemoteReport } from "@aerodb/db/progressive-remote-report";
import { progressiveRemotePointProjection } from "@aerodb/db/progressive-remote-point-projection";
import { reportTextIdentity } from "@aerodb/db/progressive-report-archive";

export interface HzSettledReceiptScope {
  contract: "settled-receipt-v3";
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
  hubResult: string;
  hubAttempt: string;
  storageOnly: boolean;
  selectionSha256: string;
}

export async function settledWorkerScope(db: DB, attemptId: string, archiveId?: string) {
  const [row] = await db.execute(sql`SELECT attempt_evidence_hz_settled_scope(${attemptId}::uuid,${archiveId ?? null}::uuid) AS scope`);
  return (row?.scope ?? null) as HzSettledReceiptScope | null;
}

/** The observed point can precede the final report. Authenticate each sequence
 * under the same assignment before using the producer's original projection. */
export async function readSettledWorkerPoint(db: DB, scope: HzSettledReceiptScope, signal?: AbortSignal) {
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
    const [bounded] = await db.execute(sql`SELECT 1 FROM progressive_worker_reports w
      LEFT JOIN progressive_report_archive_bundles b ON b.id=w.archive_bundle_id
      LEFT JOIN progressive_report_archive_members m ON m.bundle_id=b.id AND m.sim_job_id=w.sim_job_id
        AND m.sequence=w.sequence AND m.content_signature=w.content_signature AND m.member_kind='report' AND m.source_kind='worker'
      LEFT JOIN progressive_report_result_payloads shared ON shared.content_hash=w.result_payload_hash
      WHERE w.sim_job_id=${scope.job}::uuid AND w.sequence=${sequence} AND w.content_signature=${signature}
        AND w.acknowledged_at IS NOT NULL AND
        CASE WHEN w.archived_at IS NOT NULL THEN m.report_byte_size BETWEEN 1 AND 33554432 AND b.stored_byte_size BETWEEN 1 AND 33554432
        ELSE w.archive_bundle_id IS NULL AND (w.result_payload_hash IS NULL OR shared.content_hash IS NOT NULL)
          AND coalesce(shared.byte_size,0)+octet_length(w.report::text)<=33554432 END`);
    if (!bounded) throw new Error("Worker report lacks a bounded exact source");
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
