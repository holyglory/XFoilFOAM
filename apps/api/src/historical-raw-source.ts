import {
  analysisContentHash,
  prepareProgressiveRemoteEvidence,
  validateProgressiveExecutionStopProof,
  type DB,
} from "@aerodb/db";
import type { EngineExecutionStopProof } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";

export interface HistoricalRawReference {
  executionId: string;
  sequence: number;
  reportSignature: string;
  pointSignature: string;
  storedSha256: string;
  manifestSha256: string;
}
export interface HistoricalRawOwner {
  id: string;
  instanceId: string;
  authTokenHash: string | null;
}

export async function checkHistoricalRawOwner(
  db: DB,
  solver: HistoricalRawOwner,
  ref: HistoricalRawReference,
  lock = false,
) {
  const [row] = await db.execute(sql`
    SELECT d.promise_id, d.content_signature, st.proof, st.proof_signature, s.aoa_deg, s.case_slug
    FROM progressive_remote_dispatches d
    JOIN registered_remote_solvers owner ON owner.id=d.solver_id AND owner.revoked_at IS NULL
      AND owner.auth_token_hash=${solver.authTokenHash} AND owner.instance_id=${solver.instanceId}
    JOIN sync_sweep_promises p ON p.id=d.promise_id AND p.source_instance_id=owner.instance_id
      AND p.request_payload->>'solverId'=owner.id::text AND p.status IN ('expired','cancelled')
    JOIN sim_jobs j ON j.id=d.sim_job_id AND j.engine_job_id=j.id::text
      AND j.status='cancelled' AND j."ingestedAt" IS NULL
      AND j.engine_state IN ('completed','failed','cancelled')
      AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=now())
    JOIN progressive_cfd_execution_stops st ON st.sim_job_id=j.id AND st.engine_job_id=j.engine_job_id
    JOIN progressive_remote_reports r ON r.sim_job_id=j.id AND r.sequence=${ref.sequence}
      AND r.content_signature=${ref.reportSignature}
    JOIN progressive_remote_progress_receipts g ON (g.sim_job_id,g.sequence,g.content_signature)
      =(r.sim_job_id,r.sequence,r.content_signature)
    JOIN progressive_remote_report_inventories i ON (i.sim_job_id,i.sequence,i.report_content_signature)
      =(r.sim_job_id,r.sequence,r.content_signature)
    JOIN progressive_remote_report_sources s ON (s.sim_job_id,s.sequence)=(r.sim_job_id,r.sequence)
      AND s.point_content_signature=${ref.pointSignature}
    WHERE d.sim_job_id=${ref.executionId}::uuid AND d.solver_id=${solver.id}::uuid
      AND NOT EXISTS (SELECT FROM progressive_cfd_attempts a WHERE a.sim_job_id=j.id AND a.outcome='running')
      AND NOT EXISTS (SELECT FROM progressive_remote_evidence_receipts e
        WHERE e.sim_job_id=j.id AND e.point_content_signature=s.point_content_signature)
      AND NOT EXISTS (SELECT FROM progressive_remote_diagnostic_receipts e
        WHERE e.sim_job_id=j.id AND e.point_content_signature=s.point_content_signature)
    ${lock ? sql`FOR SHARE OF d,owner,p,j,r,st,i,g,s` : sql``}`);
  if (
    !row ||
    !row.case_slug ||
    row.proof_signature !== analysisContentHash(row.proof)
  )
    throw new Error(
      "Historical raw source does not have exact closed ownership",
    );
  const proof = row.proof as EngineExecutionStopProof;
  validateProgressiveExecutionStopProof(proof);
  if (proof.job_id !== ref.executionId) throw new Error("Wrong execution stop");
  return {
    promiseId: String(row.promise_id),
    assignmentSignature: String(row.content_signature),
    stopSignature: String(row.proof_signature),
    aoaDeg: Number(row.aoa_deg),
    slug: String(row.case_slug),
  };
}

const sha256 = /^[0-9a-f]{64}$/;
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export async function readHistoricalRawSource(
  db: DB,
  solver: HistoricalRawOwner,
  ref: HistoricalRawReference,
) {
  const owner = await checkHistoricalRawOwner(db, solver, ref);
  const source = await prepareProgressiveRemoteEvidence(db, {
    engineJobId: ref.executionId,
    solverId: solver.id,
    promiseId: owner.promiseId,
    aoaDeg: owner.aoaDeg,
    engineCaseSlug: owner.slug,
    progressiveEvidence: {
      sequence: ref.sequence,
      reportContentSignature: ref.reportSignature,
      pointContentSignature: ref.pointSignature,
    },
  });
  const files = source?.point.evidence_artifacts ?? [];
  const bundles = files.filter((a) => a.kind === "engine_bundle");
  const manifests = files.filter((a) => a.kind === "manifest");
  const bundle = bundles[0],
    manifest = manifests[0],
    metadata = bundle?.metadata;
  const base = metadata?.evidenceBase;
  if (
    source?.envelope.contentSignature !== owner.assignmentSignature ||
    bundles.length !== 1 ||
    manifests.length !== 1 ||
    !bundle ||
    !manifest ||
    !metadata ||
    typeof base !== "string" ||
    !base ||
    base
      .split("/")
      .some((p) => !p || p === "." || p === ".." || p.includes("\\")) ||
    manifest.metadata?.evidenceBase !== base ||
    bundle.path !== base + "/engine_evidence.tar.zst" ||
    manifest.path !== base + "/evidence_manifest.json" ||
    bundle.mime_type !== "application/zstd" ||
    manifest.mime_type !== "application/json" ||
    bundle.sha256 !== ref.storedSha256 ||
    manifest.sha256 !== ref.manifestSha256 ||
    !positive(bundle.byte_size) ||
    !positive(manifest.byte_size) ||
    metadata.archiveFormat !== "tar+zstd" ||
    metadata.compression !== "zstd" ||
    metadata.storageBackend !== "volume" ||
    metadata.localEvidenceDisposition !== "volume" ||
    typeof metadata.uncompressedTarSha256 !== "string" ||
    !sha256.test(metadata.uncompressedTarSha256) ||
    !positive(metadata.uncompressedTarByteSize) ||
    !positive(metadata.zstdLevel) ||
    metadata.zstdLevel > 22 ||
    !positive(metadata.bundledFileCount) ||
    manifest.metadata.bundledFileCount !== metadata.bundledFileCount
  )
    throw new Error(
      "The signed point lacks this exact local archive and manifest",
    );
  return {
    owner,
    archivePath: bundle.path,
    manifestPath: manifest.path,
    storedBytes: bundle.byte_size,
    manifestBytes: manifest.byte_size,
    tarSha256: metadata.uncompressedTarSha256,
    tarBytes: metadata.uncompressedTarByteSize,
    zstdLevel: metadata.zstdLevel,
    bundledFileCount: metadata.bundledFileCount,
  };
}

export type HistoricalRawSource = Awaited<
  ReturnType<typeof readHistoricalRawSource>
>;

function historicalRawIdentity(
  solver: HistoricalRawOwner,
  ref: HistoricalRawReference,
  source: HistoricalRawSource,
) {
  return {
    sim_job_id: ref.executionId,
    sequence: ref.sequence,
    point_content_signature: ref.pointSignature,
    report_signature: ref.reportSignature,
    solver_id: solver.id,
    source_instance_id: solver.instanceId,
    promise_id: source.owner.promiseId,
    assignment_signature: source.owner.assignmentSignature,
    stop_signature: source.owner.stopSignature,
    stored_sha256: ref.storedSha256,
    stored_bytes: source.storedBytes,
    tar_sha256: source.tarSha256,
    tar_bytes: source.tarBytes,
    manifest_sha256: ref.manifestSha256,
    manifest_bytes: source.manifestBytes,
    bundled_file_count: source.bundledFileCount,
    zstd_level: source.zstdLevel,
  };
}

export async function readHistoricalRawRegistration(
  db: DB,
  solver: HistoricalRawOwner,
  ref: HistoricalRawReference,
  source: HistoricalRawSource,
) {
  const identity = historicalRawIdentity(solver, ref, source);
  const [row] = await db.execute<{
    matches: boolean;
    bucket: string;
    object_key: string;
    generation: string;
    crc32c: string;
  }>(sql`
    SELECT to_jsonb(c) @> ${JSON.stringify(identity)}::jsonb AS matches, bucket, object_key, generation, crc32c
    FROM progressive_historical_raw_archives c WHERE sim_job_id=${ref.executionId}::uuid AND point_content_signature=${ref.pointSignature}`);
  if (row && !row.matches)
    throw new Error(
      "This historical point has different immutable source custody",
    );
  return row;
}

export async function acknowledgeHistoricalRaw(
  db: DB,
  solver: HistoricalRawOwner,
  ref: HistoricalRawReference,
  source: HistoricalRawSource,
  object: {
    bucket: string;
    objectKey: string;
    generation: string;
    crc32c: string;
  },
  memberSetSha: string,
) {
  const receipt = {
    ...historicalRawIdentity(solver, ref, source),
    manifest_set_sha256: memberSetSha,
    bucket: object.bucket,
    object_key: object.objectKey,
    generation: object.generation,
    crc32c: object.crc32c,
  };
  return db.transaction(async (tx) => {
    const current = await checkHistoricalRawOwner(
      tx as unknown as DB,
      solver,
      ref,
      true,
    );
    if (analysisContentHash(current) !== analysisContentHash(source.owner))
      throw new Error("Historical raw owner changed");
    const expected = JSON.stringify(receipt);
    // The signed report identity and its inventory are immutable. Only the custody row is written.
    await tx.execute(sql`INSERT INTO progressive_historical_raw_archives
      SELECT c.* FROM jsonb_populate_record(NULL::progressive_historical_raw_archives,
        ${expected}::jsonb || jsonb_build_object('verified_at',clock_timestamp())) c
      ON CONFLICT (sim_job_id,point_content_signature) DO NOTHING`);
    const [saved] =
      await tx.execute(sql`SELECT verified_at FROM progressive_historical_raw_archives c
      WHERE sim_job_id=${ref.executionId}::uuid AND point_content_signature=${ref.pointSignature}
        AND to_jsonb(c)-'verified_at'=${expected}::jsonb`);
    if (!saved)
      throw new Error(
        "This historical point already has different immutable custody",
      );
    return {
      state: "registered" as const,
      ...receipt,
      verifiedAt: new Date(String(saved.verified_at)).toISOString(),
    };
  });
}
