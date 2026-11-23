import { eq, sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import { resultAttempts } from "@aerodb/db/schema";
import {
  analysisContentHash,
  canonicalAnalysisJson,
} from "@aerodb/db/analysis-target";
import {
  assertProgressiveReportArchiveIdentity,
  type ProgressiveReportArchiveReadIdentity,
} from "@aerodb/db/progressive-report-archive";
import { MAX_ATTEMPT_EVIDENCE_BYTES } from "@aerodb/db/attempt-evidence-storage";
import { verifyProgressiveRemoteExecution } from "@aerodb/db/progressive-remote-execution";
import {
  assertProgressiveReportedManifest,
  ProgressiveRemoteEvidenceConflict,
} from "@aerodb/db/progressive-remote-evidence";
import {
  assertProgressivePointMatchesAttempt,
  storedProgressivePointReceipt,
  type ProgressiveRemoteEvidenceDelivery,
} from "@aerodb/db/progressive-remote-evidence-receipts";
import { projectSignedProgressivePoint } from "@aerodb/db/progressive-remote-point-projection";
import { readBoundProgressiveRawArchive } from "@aerodb/db/progressive-evidence-custody";
import { env } from "./env";
import { verifyRetainedReportGeneration } from "./progressive-report-archive-reader";

type Point = Parameters<typeof projectSignedProgressivePoint>[0];
type Envelope = ReturnType<typeof verifyProgressiveRemoteExecution>;
const sha = /^[a-f0-9]{64}$/;

// solverPointEvidencePayload may add the job-level mesh recovery version.
// Accept a reversal only if the entire original signed point, including its
// physical polar and all declared artifacts, reproduces the inventory hash.
function originalPoint(
  payload: unknown,
  envelope: Envelope,
  signature: string,
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const candidate = payload as Point;
  if (!candidate.engine) return null;
  const speed = envelope.request.speeds?.[0],
    chord = envelope.request.chord_lengths?.[0];
  const nu = envelope.request.fluid?.kinematic_viscosity;
  if (
    !(
      typeof speed === "number" &&
      speed > 0 &&
      typeof chord === "number" &&
      chord > 0 &&
      typeof nu === "number" &&
      nu > 0
    )
  )
    return null;
  // The solver's unrounded physical Reynolds. Restrict this proof to the
  // measured original shape with an absent/null reported Mach.
  const polar = { speed, chord, reynolds: (speed * chord) / nu, mach: null };
  const hashesToSource = (point: Point) =>
    analysisContentHash({
      kind: "progressive-reported-point-v1",
      executionId: envelope.scope.executionId,
      ...polar,
      point,
    }) === signature;
  if (hashesToSource(candidate)) return { point: candidate, polar };
  const meshVersion = envelope.request.expected_mesh_recovery_version;
  const object = payload as Record<string, unknown>;
  if (meshVersion == null || object.mesh_recovery_version !== meshVersion)
    return null;
  const { mesh_recovery_version: _projectedVersion, ...original } = object;
  return hashesToSource(original as unknown as Point)
    ? { point: original as unknown as Point, polar }
    : null;
}

async function snapshot(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery,
  instance: string,
  bucket: string,
) {
  const ref = input.progressiveEvidence;
  const [row] =
    await db.execute(sql`SELECT e.result_attempt_id,e.remote_result_id,e.remote_result_attempt_id,e.received_at,e.sequence,e.storage_only,
      a.result_id,d.envelope,d.content_signature AS assignment, cf.attempt_token,cf.evidence_signature,
      attempt_evidence_receipt_scope_for(a.id,a.regime='urans') AS scope, r.archive_bundle_id, b.bucket,b.object_key,b.generation,b.crc32c,
      b.stored_sha256,b.stored_byte_size,b.member_count,b.first_sequence,b.last_sequence,m.report_sha256,m.report_byte_size,
      i.inventory_signature,i.source_count,u.id AS upload_id
    FROM progressive_remote_evidence_receipts e JOIN result_attempts a ON a.id=e.result_attempt_id AND a.sim_job_id=e.sim_job_id
    JOIN results cell ON cell.id=a.result_id AND cell.airfoil_id=a.airfoil_id AND cell.simulation_preset_revision_id=a.simulation_preset_revision_id
      AND cell.aoa_deg=a.aoa_deg
    JOIN progressive_cfd_evidence cf ON cf.result_attempt_id=a.id
    JOIN progressive_remote_dispatches d ON d.sim_job_id=e.sim_job_id JOIN registered_remote_solvers s ON s.id=d.solver_id AND s.revoked_at IS NULL
    JOIN sync_sweep_promises p ON p.id=d.promise_id AND p.registered_solver_id=d.solver_id AND p.source_instance_id=s.instance_id
      AND p.request_payload->>'solverId'=s.id::text AND p.airfoil_id=a.airfoil_id AND p.simulation_preset_revision_id=a.simulation_preset_revision_id
    JOIN sync_sweep_promise_points pp ON pp.promise_id=p.id AND pp.aoa_deg=a.aoa_deg AND pp.status<>'fulfilled'
    JOIN progressive_cfd_execution_stops stop ON stop.sim_job_id=d.sim_job_id AND stop.engine_job_id=a.engine_job_id AND stop.epoch_id=(d.envelope#>>'{scope,epochId}')::uuid
    JOIN progressive_remote_reports r ON r.sim_job_id=e.sim_job_id AND r.sequence=e.sequence AND r.archived_at IS NOT NULL
      AND r.report @> jsonb_build_object('version',1,'archivedReport',true,'executionId',e.sim_job_id,'sequence',e.sequence,
        'assignmentSignature',d.content_signature,'solverId',s.id,'promiseId',p.id)
    JOIN progressive_remote_report_inventories i ON i.sim_job_id=r.sim_job_id AND i.sequence=r.sequence AND i.report_content_signature=r.content_signature
    JOIN public.progressive_report_archive_members m ON m.bundle_id=r.archive_bundle_id AND m.source_kind='remote' AND m.member_kind='report'
      AND m.sim_job_id=e.sim_job_id AND m.sequence=e.sequence AND m.content_signature=r.content_signature
    JOIN public.progressive_report_archive_bundles b ON b.id=m.bundle_id AND b.sim_job_id=e.sim_job_id AND b.source_kind='remote'
      AND b.verified_at IS NOT NULL AND b.mime_type='application/gzip' AND b.archive_format='jsonl' AND b.compression='gzip'
      AND r.sequence BETWEEN b.first_sequence AND b.last_sequence
    JOIN sync_brokered_evidence_uploads u ON u.canonical_result_id=a.result_id AND u.canonical_result_attempt_id=a.id AND u.state='bound'
      AND u.promise_id=d.promise_id AND u.solver_id=d.solver_id AND u.remote_result_id=e.remote_result_id AND u.remote_result_attempt_id=e.remote_result_attempt_id
      AND u.engine_job_id=a.engine_job_id AND u.engine_case_slug IS NOT DISTINCT FROM a.engine_case_slug AND u.aoa_deg=a.aoa_deg
    WHERE e.sim_job_id=${input.engineJobId}::uuid AND e.point_content_signature=${ref.pointContentSignature} AND e.sequence=${ref.sequence}
      AND r.content_signature=${ref.reportContentSignature} AND e.remote_result_id=${input.remoteResultId}::uuid
      AND e.remote_result_attempt_id=${input.remoteResultAttemptId}::uuid AND NOT e.storage_only AND a.evidence_archive_id IS NULL
      AND a.engine_job_id=e.sim_job_id::text AND a.aoa_deg=${input.aoaDeg} AND a.engine_case_slug IS NOT DISTINCT FROM ${input.engineCaseSlug}
      AND p.id=${input.promiseId}::uuid AND p.status='cancelled' AND s.id=${input.solverId}::uuid AND s.instance_id=${instance}
      AND b.bucket=${bucket} AND i.source_count BETWEEN 1 AND 500 AND octet_length(a.evidence_payload::text)<=${MAX_ATTEMPT_EVIDENCE_BYTES}
      AND NOT EXISTS(SELECT FROM sync_brokered_evidence_uploads other WHERE other.canonical_result_attempt_id=a.id
        AND other.promise_id=p.id AND other.state='bound' AND other.id<>u.id) LIMIT 1`);
  if (!row || !row.scope) return null;
  const envelope = verifyProgressiveRemoteExecution(row.envelope, {
    solverId: input.solverId,
    promiseId: input.promiseId,
    executionId: input.engineJobId,
    contentSignature: String(row.assignment),
  });
  const scope = row.scope as {
    attemptId: string;
    resultId: string;
    simJobId: string;
    engineJobId: string;
    remote: unknown;
    scientific: {
      attemptToken: string;
      unitId: string;
      applicationSha256: string;
    } | null;
  };
  const remote = {
    solverId: input.solverId,
    promiseId: input.promiseId,
    executionId: input.engineJobId,
    sequence: ref.sequence,
    assignmentSignature: envelope.contentSignature,
    reportContentSignature: ref.reportContentSignature,
    pointContentSignature: ref.pointContentSignature,
    remoteResultId: input.remoteResultId,
    remoteResultAttemptId: input.remoteResultAttemptId,
    aoaDeg: input.aoaDeg,
    caseSlug: input.engineCaseSlug,
    storageOnly: false,
  };
  if (
    scope.attemptId !== row.result_attempt_id ||
    scope.resultId !== row.result_id ||
    scope.simJobId !== input.engineJobId ||
    scope.engineJobId !== input.engineJobId ||
    !scope.scientific ||
    scope.scientific.attemptToken !== row.attempt_token ||
    scope.scientific.applicationSha256 !== row.evidence_signature ||
    !envelope.scope.units.some(
      (u) =>
        u.unitId === scope.scientific!.unitId &&
        u.token === row.attempt_token &&
        u.alpha === input.aoaDeg,
    ) ||
    canonicalAnalysisJson(scope.remote) !== canonicalAnalysisJson(remote)
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Retained report, point or scientific receipt belongs to another source",
    );
  const sources =
    await db.execute(sql`SELECT point_content_signature,aoa_deg,case_slug FROM progressive_remote_report_sources
    WHERE sim_job_id=${input.engineJobId}::uuid AND sequence=${ref.sequence} ORDER BY point_content_signature LIMIT 501`);
  const matching = sources.filter(
    (s) => s.aoa_deg === input.aoaDeg && s.case_slug === input.engineCaseSlug,
  );
  if (
    sources.length !== row.source_count ||
    matching.length !== 1 ||
    matching[0]!.point_content_signature !== ref.pointContentSignature ||
    analysisContentHash({
      kind: "progressive-remote-report-inventory-v1",
      executionId: input.engineJobId,
      sequence: ref.sequence,
      reportContentSignature: ref.reportContentSignature,
      sources: [...sources],
    }) !== row.inventory_signature
  )
    throw new ProgressiveRemoteEvidenceConflict(
      "Retained signed point inventory changed",
    );
  const [attempt] = await db
    .select()
    .from(resultAttempts)
    .where(eq(resultAttempts.id, scope.attemptId));
  if (!attempt || attempt.evidenceArchiveId !== null) return null;
  const digest = analysisContentHash(attempt.evidencePayload);
  if (digest !== row.evidence_signature)
    throw new ProgressiveRemoteEvidenceConflict(
      "Retained scientific point bytes changed",
    );
  const recovered = originalPoint(
    attempt.evidencePayload,
    envelope,
    ref.pointContentSignature,
  );
  if (!recovered) return null;
  const { point, polar } = recovered;
  if (
    point.aoa_deg !== input.aoaDeg ||
    (point.case_slug ?? null) !== input.engineCaseSlug
  )
    return null;
  const version = (attempt.evidencePayload as Record<string, unknown>)
    .mesh_recovery_version;
  if (
    version != null &&
    version !== envelope.request.expected_mesh_recovery_version
  )
    return null;
  const projected = projectSignedProgressivePoint(
    point,
    polar,
    envelope,
    point.engine,
    typeof version === "number" ? version : undefined,
  );
  assertProgressivePointMatchesAttempt(attempt, projected, digest);
  const receipt = storedProgressivePointReceipt(
    row,
    input.engineJobId,
    ref.pointContentSignature,
  );
  const raw = await readBoundProgressiveRawArchive(
    db,
    input,
    receipt,
    String(row.upload_id),
    (manifest) => assertProgressiveReportedManifest({ point }, manifest),
  );
  if (typeof row.generation !== "string")
    throw new Error("Missing exact stored report generation");
  const identity: ProgressiveReportArchiveReadIdentity = {
    sourceKind: "remote",
    memberKind: "report",
    executionId: input.engineJobId,
    sequence: ref.sequence,
    signature: ref.reportContentSignature,
    reportByteSize: Number(row.report_byte_size),
    reportSha256: String(row.report_sha256),
    bucket,
    objectKey: String(row.object_key),
    generation: String(row.generation),
    storedSha256: String(row.stored_sha256),
    storedByteSize: Number(row.stored_byte_size),
    crc32c: String(row.crc32c),
    mimeType: "application/gzip",
    compression: "gzip",
    archiveFormat: "jsonl",
    memberCount: Number(row.member_count),
    firstSequence: Number(row.first_sequence),
    lastSequence: Number(row.last_sequence),
  };
  assertProgressiveReportArchiveIdentity(identity);
  if (
    !sha.test(identity.reportSha256) ||
    !Number.isSafeInteger(identity.reportByteSize) ||
    identity.reportByteSize <= 0
  )
    throw new Error("Missing registered raw report member proof");
  return {
    receipt,
    identity,
    raw,
    scope,
    bundleId: row.archive_bundle_id,
    inventory: row.inventory_signature,
  };
}

/** Read an already-issued receipt without inflating a cumulative report
 * containing unrelated points. Every byte of the previously authenticated
 * GCS generation is rechecked outside the database snapshot. */
export async function recoverSignedPolarReceipt(
  db: DB,
  input: ProgressiveRemoteEvidenceDelivery,
  instance: string,
) {
  const bucket = env.evidenceBucket?.trim();
  if (!bucket || process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "hub") return null;
  const prepare = () =>
    db.transaction(
      (tx) => snapshot(tx as unknown as DB, input, instance, bucket),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  const proof = await prepare();
  if (!proof) return null;
  await verifyRetainedReportGeneration(proof.identity);
  const after = await prepare();
  if (!after || canonicalAnalysisJson(after) !== canonicalAnalysisJson(proof))
    throw new ProgressiveRemoteEvidenceConflict(
      "Retained source changed during report generation verification",
    );
  return after.receipt;
}
