import { addAbortSignal, type Readable } from "node:stream";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import {
  verifyProgressiveRemoteExecution,
  type ProgressiveRemoteExecutionEnvelope,
} from "@aerodb/db/progressive-remote-execution";
import {
  progressiveReportedPointSources,
  validateProgressiveRemoteReport,
} from "@aerodb/db/progressive-remote-report";
import { progressiveRemotePointProjection } from "@aerodb/db/progressive-remote-point-projection";
import {
  reportTextIdentity,
  visitProgressiveReportArchive,
  type ProgressiveReportArchiveReadIdentity,
} from "@aerodb/db/progressive-report-archive";
import { readWorkerReportVolume } from "./worker-report-volume";

interface AttemptReportPoint {
  solver: string;
  promise: string;
  job: string;
  assignment: string;
  point: string;
  alpha: number;
  slug: string;
  report: ProgressiveReportArchiveReadIdentity;
}
interface WorkerReportRow {
  attempt: string;
  result: string;
  job: string;
  alpha: number;
  slug: string;
  source_sha256: string;
  source_bytes: number;
  pgbytes: number;
  series: { path: string[]; byteSize: number }[];
  instance: string;
  solver: string;
  promise: string;
  envelope: ProgressiveRemoteExecutionEnvelope;
  hub_attempt: string;
  hub_result: string;
  point: string;
  sequence: number;
  signature: string;
  bucket: string;
  object_key: string;
  generation: string;
  mime_type: string;
  compression: string;
  archive_format: string;
  stored_sha256: string;
  stored_byte_size: number;
  crc32c: string;
  member_count: number;
  first_sequence: number;
  last_sequence: number;
  report_sha256: string;
  report_byte_size: number;
}
function requireHzSource(
  condition: unknown,
  reason: string,
): asserts condition {
  if (!condition) throw new Error(reason);
}

/** Packed, decoded and reconstructed delta members each have independent bounds. */
export async function readHzAttemptReportMember(
  stream: Readable,
  identity: ProgressiveReportArchiveReadIdentity,
): Promise<string> {
  let found: string | undefined;
  await visitProgressiveReportArchive(
    stream,
    identity,
    (entry) => {
      if (
        entry.sourceKind !== "worker" ||
        entry.kind !== "report" ||
        entry.executionId !== identity.executionId ||
        entry.sequence !== identity.sequence ||
        entry.contentSignature !== identity.signature
      )
        return;
      const proof = reportTextIdentity(entry.reportText);
      requireHzSource(
        found === undefined &&
          proof.sha256 === identity.reportSha256 &&
          proof.byteSize === identity.reportByteSize,
        "archive",
      );
      found = entry.reportText;
    },
    {
      maxMembers: 128,
      maxDecodedBytes: 32 * 1024 ** 2,
      maxReportBytes: 4 * 1024 ** 2,
    },
  );
  requireHzSource(found !== undefined, "archive");
  return found;
}

/** Reproduce the normal delivery projection of the immutable point. Its PG text
 * must match an independently retained original before the caller may use it. */
export async function projectHzReportAttempt(
  db: DB,
  body: unknown,
  assignment: unknown,
  owner: AttemptReportPoint,
) {
  const envelope = verifyProgressiveRemoteExecution(assignment, {
    solverId: owner.solver,
    promiseId: owner.promise,
    executionId: owner.job,
    contentSignature: owner.assignment,
  });
  const { report, contentSignature } = validateProgressiveRemoteReport(
    body,
    envelope,
  );
  requireHzSource(
    contentSignature === owner.report.signature &&
      report.sequence === owner.report.sequence &&
      report.stopProof?.execution_stopped === true &&
      report.result,
    "replay",
  );
  const source = progressiveReportedPointSources(report.result).find(
    (p) => p.contentSignature === owner.point,
  );
  requireHzSource(
    source &&
      source.point.aoa_deg === owner.alpha &&
      source.point.case_slug === owner.slug,
    "replay",
  );
  const projected = progressiveRemotePointProjection({
    ...source,
    report,
    envelope,
  });
  requireHzSource(
    projected.regime === "rans" &&
      projected.source === "solved" &&
      projected.status === "done",
    "replay",
  );
  const [row] = await db.execute(
    sql`SELECT (${JSON.stringify(projected.evidencePayload)}::text::jsonb)::text AS original`,
  );
  requireHzSource(typeof row?.original === "string", "replay");
  return row.original;
}

/** Follow a stable HZ attempt through its delivery receipt to the actual packed
 * worker report. Local disk is the only body source. The inline row supplies
 * its expected digest and length, never returned as an archive read. */
export async function readHzAttemptFromWorkerReport(
  db: DB,
  attemptId: string,
  signal?: AbortSignal,
) {
  requireHzSource(
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver" &&
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(attemptId),
    "scope",
  );
  signal?.throwIfAborted();
  const rows =
    (await db.execute(sql`SELECT a.id::text AS attempt, a.result_id::text AS result, a.sim_job_id::text AS job,
        a.aoa_deg AS alpha, a.engine_case_slug AS slug, CASE WHEN a.evidence_archive_id IS NULL THEN encode(sha256(convert_to(a.evidence_payload::text,'UTF8')),'hex') ELSE ar.source_sha256 END AS source_sha256,
        coalesce(ar.source_byte_size,octet_length(a.evidence_payload::text))::int AS source_bytes,
        pg_column_size(a.evidence_payload)::int AS pgbytes, coalesce(ar.history_series,attempt_evidence_series_inventory(a.evidence_payload)) AS series,
        s.instance_id::text AS instance, s.remote_solver_registered_id::text AS solver, p.id::text AS promise,
        j.request_payload->'remoteProgressiveExecution' AS envelope,
        h.receipt->>'resultAttemptId' AS hub_attempt, h.receipt->>'resultId' AS hub_result,
        h.point_content_signature AS point, h.sequence::int AS sequence, e.content_signature AS signature,
        b.bucket,b.object_key,b.generation,b.mime_type,b.compression,b.archive_format,
        b.stored_sha256,b.stored_byte_size::int,b.crc32c,b.member_count,b.first_sequence::int,b.last_sequence::int,
        m.report_sha256,m.report_byte_size::int
      FROM result_attempts a JOIN results r ON r.id=a.result_id AND r.airfoil_id=a.airfoil_id AND r.aoa_deg=a.aoa_deg
        AND r.simulation_preset_revision_id=a.simulation_preset_revision_id
      JOIN sim_jobs j ON j.id=a.sim_job_id AND a.engine_job_id=j.id::text AND j.engine_job_id=j.id::text
      JOIN sync_api_settings s ON s.id=1 AND j.request_payload->>'upstreamBaseUrl'=s.upstream_base_url
      JOIN sync_sweep_promises p ON p.id::text=j.request_payload->>'syncPromiseId'
        AND p.registered_solver_id=s.remote_solver_registered_id AND p.source_base_url=s.upstream_base_url
      JOIN progressive_worker_hub_receipts h ON h.result_attempt_id=a.id AND h.sim_job_id=j.id
        AND h.receipt->>'remoteResultAttemptId'=a.id::text AND h.receipt->>'remoteResultId'=r.id::text
        AND h.receipt->>'pointContentSignature'=h.point_content_signature AND h.receipt->>'executionId'=j.id::text
        AND h.receipt->>'kind'='retained-progressive-attempt' AND h.receipt->>'version'='1'
        AND h.receipt->'storageOnly'='true'::jsonb AND h.receipt->>'sequence'=h.sequence::text
      JOIN progressive_worker_evidence_attempts w ON w.result_attempt_id=a.id AND w.sim_job_id=j.id
        AND w.sequence=h.sequence AND w.point_content_signature=h.point_content_signature
      JOIN progressive_worker_evidence_receipts e ON e.sim_job_id=w.sim_job_id AND e.sequence=w.sequence
      JOIN progressive_worker_reports wr ON wr.sim_job_id=w.sim_job_id AND wr.sequence=w.sequence
        AND wr.content_signature=e.content_signature AND wr.acknowledged_at IS NOT NULL AND wr.archived_at IS NOT NULL
      JOIN progressive_report_archive_members m ON m.bundle_id=wr.archive_bundle_id AND m.sim_job_id=w.sim_job_id
        AND m.sequence=w.sequence AND m.content_signature=e.content_signature AND m.source_kind='worker' AND m.member_kind='report'
      JOIN progressive_report_archive_bundles b ON b.id=m.bundle_id AND b.sim_job_id=j.id AND b.source_kind=m.source_kind
      LEFT JOIN attempt_evidence_archives ar ON ar.id=a.evidence_archive_id AND ar.result_attempt_id=a.id
        AND ar.result_id=a.result_id AND ar.sim_job_id=a.sim_job_id AND ar.source_instance=s.instance_id::text
      WHERE a.id=${attemptId}::uuid AND (a.evidence_archive_id IS NULL OR ar.id IS NOT NULL) AND a.status='done' AND a.source='solved' AND a.regime='rans'
        AND NOT a.unsteady AND r.current_result_attempt_id IS DISTINCT FROM a.id AND j.status='cancelled' AND j."ingestedAt" IS NOT NULL
        AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=statement_timestamp())
        AND j.request_payload->>'remoteSolver'='true' AND p.status IN ('cancelled','expired','fulfilled')
        AND pg_column_size(a.evidence_payload)<=262144 AND octet_length(a.evidence_payload::text)<=262144
        AND wr.stopped_engine_job_id=j.id::text AND NOT EXISTS (SELECT FROM progressive_worker_reports later WHERE later.sim_job_id=j.id AND later.sequence>wr.sequence)
        AND b.verified_at IS NOT NULL AND w.sequence BETWEEN b.first_sequence AND b.last_sequence
        AND b.object_key='progressive-reports/v1/worker/'||j.id::text||'/'||b.stored_sha256||'.jsonl.gz'
        AND b.member_count BETWEEN 1 AND 128 AND b.archive_format='jsonl' AND b.compression='gzip' AND b.mime_type='application/gzip'
        AND b.stored_byte_size BETWEEN 1 AND 16777216 AND m.report_byte_size BETWEEN 1 AND 4194304
        AND NOT EXISTS (SELECT FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=w.sim_job_id AND c.sequence=w.sequence)
      LIMIT 2`)) as unknown as WorkerReportRow[];
  requireHzSource(rows.length === 1, "scope");
  const x = rows[0]!;
  requireHzSource(
    x.series.length === 4 &&
      x.series.every((entry) => entry.path[0] === "steady_history"),
    "scope",
  );
  requireHzSource(
    [x.hub_result, x.hub_attempt].every(
      (id) =>
        typeof id === "string" &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id),
    ),
    "scope",
  );
  const report: ProgressiveReportArchiveReadIdentity = {
    sourceKind: "worker",
    memberKind: "report",
    executionId: x.job,
    sequence: x.sequence,
    signature: x.signature,
    reportSha256: x.report_sha256,
    reportByteSize: x.report_byte_size,
    bucket: x.bucket,
    objectKey: x.object_key,
    generation: x.generation,
    mimeType: x.mime_type,
    compression: x.compression,
    archiveFormat: x.archive_format,
    storedSha256: x.stored_sha256,
    storedByteSize: x.stored_byte_size,
    crc32c: x.crc32c,
    memberCount: x.member_count,
    firstSequence: x.first_sequence,
    lastSequence: x.last_sequence,
  };
  const owner = {
    attempt: x.attempt,
    result: x.result,
    job: x.job,
    alpha: x.alpha,
    slug: x.slug,
    solver: x.solver,
    instance: x.instance,
    promise: x.promise,
    hubAttempt: x.hub_attempt,
    hubResult: x.hub_result,
    point: x.point,
    report,
    assignment: x.envelope.contentSignature,
  };

  const stream = await readWorkerReportVolume(report);
  requireHzSource(stream, "archive");
  const text = await readHzAttemptReportMember(
    signal ? addAbortSignal(signal, stream) : stream,
    report,
  );
  signal?.throwIfAborted();
  const payloadText = await projectHzReportAttempt(
    db,
    JSON.parse(text),
    x.envelope,
    owner,
  );
  const identity = reportTextIdentity(payloadText);
  requireHzSource(
    identity.sha256 === x.source_sha256 && identity.byteSize === x.source_bytes,
    "replay",
  );
  signal?.throwIfAborted();
  return {
    payloadText,
    witness: {
      ...owner,
      ...identity,
      pgBytes: x.pgbytes,
      historyBytes: x.series.reduce((sum, entry) => sum + entry.byteSize, 0),
    },
  };
}
