import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";

const SHA256 = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC32C = /^[A-Za-z0-9+/]{6}==$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_GCS_GENERATION = 18_446_744_073_709_551_615n;
const OPENCFD_2606 = "2f8bc764-09ae-4ff3-8fd2-260600000001";
export const OPERATIONAL_CANARY_APPROVED_INVENTORY_SHA256 =
  "1b9660eb8117bb9786abb6c4d50981781c738722e419ebc230b90fd02c0e275b";
export const OPERATIONAL_CANARY_DATABASE_ATTESTATION_RECEIPT_SHA256 =
  "f6d17988ea40e96c885df709357806a097daa19948d8b02efc6df25e035f6149";

type JsonObject = Record<string, unknown>;

export interface OperationalCanaryTarget {
  bucket: string;
  objectKey: string;
  generation: string;
  storedSha256: string;
  storedByteSize: number;
  crc32c: string;
  tarSha256: string;
  tarByteSize: number;
  zstdLevel: number;
}

export interface OperationalCanaryRuntime {
  solverImplementationId: string;
  solverRuntimeBuildId: string;
  family: "openfoam";
  distribution: "opencfd";
  version: "2606";
  buildId: string;
  sourceRevision: string | null;
  imageDigest: string | null;
  applicationSourceSha256: string | null;
  packageSha256: string | null;
  binarySha256: string | null;
  architecture: string | null;
}

export type OperationalCanaryProvenance =
  | { kind: "attested_canary"; attestationId: string }
  | {
      kind: "unattested_cutover_canary";
      sourceBuild: { buildId: string; sha256: string; byteSize: number };
      sourceJournal: { sha256: string; byteSize: number };
      operatorReceipt: { sha256: string; byteSize: number };
      failure: {
        phase:
          | "queue_probe_same_build_replay"
          | "retention_retry"
          | "transient_retention";
        exitCode: 14 | 137;
      };
    };

export interface OperationalCanaryRegistrationClaim {
  schemaVersion: 1;
  kind: "opencfd2606-operational-canary-evidence-registration";
  approvedInventorySha256: string;
  provenance: OperationalCanaryProvenance;
  runtime: OperationalCanaryRuntime;
  job: {
    id: string;
    state: "completed";
    statusSha256: string;
    statusByteSize: number;
  };
  evidence: {
    path: string;
    pointerSha256: string;
    pointerByteSize: number;
    archiveSha256: string;
    archiveByteSize: number;
    manifestSha256: string;
    manifestByteSize: number;
    archiveMemberSetSha256: string;
    archiveMemberCount: number;
  };
  target: OperationalCanaryTarget;
  operator: string;
  capturedAt: string;
}

export interface OperationalCanaryRegistrationAck {
  schemaVersion: 1;
  state: "operational_canary_owned";
  ownershipId: string;
  engineJobId: string;
  evidencePath: string;
  target: OperationalCanaryTarget;
  registrationReceiptSha256: string;
  registeredAt: string;
}

export interface OperationalCanaryRetentionReceipt {
  schemaVersion: 1;
  kind: "opencfd2606-operational-canary-local-retention-receipt";
  ownershipId: string;
  registrationReceiptSha256: string;
  target: Pick<
    OperationalCanaryTarget,
    | "bucket"
    | "objectKey"
    | "generation"
    | "storedSha256"
    | "storedByteSize"
    | "crc32c"
  >;
  outcome: "local_evidence_stripped" | "already_remote_only";
  verificationMode: string;
  verifiedMemberCount: number;
  bytesDeleted: number;
  deletedPaths: string[];
  gcsDisposition: "retained_exact_generation";
  operator: string;
  verifiedAt: string;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}

function pattern(value: unknown, label: string, regex: RegExp): string {
  const parsed = text(value, label);
  if (!regex.test(parsed)) throw new Error(`${label} has an invalid format`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function safeRelative(
  value: unknown,
  label: string,
  oneSegment = false,
): string {
  const parsed = text(value, label);
  if (
    parsed.startsWith("/") ||
    parsed.includes("\\") ||
    parsed.includes("\0") ||
    parsed.split("/").some((part) => !part || part === "." || part === "..") ||
    (oneSegment && parsed.includes("/"))
  ) {
    throw new Error(
      `${label} must be a safe ${oneSegment ? "single segment" : "relative path"}`,
    );
  }
  return parsed;
}

function utcTimestamp(value: unknown, label: string): string {
  const parsed = text(value, label);
  if (
    !parsed.includes("T") ||
    !parsed.endsWith("Z") ||
    !Number.isFinite(Date.parse(parsed))
  ) {
    throw new Error(`${label} must be an ISO UTC timestamp`);
  }
  return parsed;
}

function nullableHash(value: unknown, label: string): string | null {
  return value === null ? null : pattern(value, label, SHA256);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new Error("canonical JSON cannot encode undefined");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as JsonObject;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function operationalCanaryApprovedRowSeal(
  claim: OperationalCanaryRegistrationClaim,
): string {
  const provenance = claim.provenance;
  const unattested =
    provenance.kind === "unattested_cutover_canary" ? provenance : null;
  return sha256(
    [
      "opencfd2606-operational-canary-row-seal-v1",
      claim.approvedInventorySha256,
      provenance.kind,
      provenance.kind === "attested_canary" ? provenance.attestationId : "",
      claim.runtime.solverImplementationId,
      claim.runtime.solverRuntimeBuildId,
      claim.job.id,
      claim.evidence.path,
      claim.target.bucket,
      claim.target.objectKey,
      claim.target.generation,
      claim.target.storedSha256,
      claim.target.storedByteSize,
      claim.target.crc32c,
      claim.target.tarSha256,
      claim.target.tarByteSize,
      claim.target.zstdLevel,
      claim.evidence.pointerSha256,
      claim.evidence.pointerByteSize,
      claim.evidence.manifestSha256,
      claim.evidence.manifestByteSize,
      claim.evidence.archiveMemberSetSha256,
      claim.evidence.archiveMemberCount,
      claim.job.statusSha256,
      claim.job.statusByteSize,
      unattested?.sourceBuild.sha256 ?? "",
      unattested?.sourceBuild.byteSize ?? "",
      unattested?.sourceJournal.sha256 ?? "",
      unattested?.sourceJournal.byteSize ?? "",
      unattested?.operatorReceipt.sha256 ?? "",
      unattested?.operatorReceipt.byteSize ?? "",
      unattested?.failure.phase ?? "",
      unattested?.failure.exitCode ?? "",
    ].join("\n"),
  );
}

function parseTarget(value: unknown): OperationalCanaryTarget {
  const target = object(value, "target");
  exactKeys(
    target,
    [
      "bucket",
      "objectKey",
      "generation",
      "storedSha256",
      "storedByteSize",
      "crc32c",
      "tarSha256",
      "tarByteSize",
      "zstdLevel",
    ],
    "target",
  );
  const generation = pattern(
    target.generation,
    "target generation",
    GENERATION,
  );
  if (BigInt(generation) > MAX_GCS_GENERATION)
    throw new Error("target generation exceeds GCS uint64");
  const storedSha256 = pattern(
    target.storedSha256,
    "target stored SHA-256",
    SHA256,
  );
  const objectKey = safeRelative(target.objectKey, "target object key");
  const expectedKey = `solver-evidence/v1/sha256/${storedSha256.slice(0, 2)}/${storedSha256}.tar.zst`;
  if (objectKey !== expectedKey) {
    throw new Error(`target object key must be the canonical ${expectedKey}`);
  }
  const zstdLevel = positiveInteger(target.zstdLevel, "target zstd level");
  if (zstdLevel > 22) throw new Error("target zstd level exceeds 22");
  return {
    bucket: text(target.bucket, "target bucket"),
    objectKey,
    generation,
    storedSha256,
    storedByteSize: positiveInteger(
      target.storedByteSize,
      "target stored byte size",
    ),
    crc32c: pattern(target.crc32c, "target CRC32C", CRC32C),
    tarSha256: pattern(target.tarSha256, "target tar SHA-256", SHA256),
    tarByteSize: positiveInteger(target.tarByteSize, "target tar byte size"),
    zstdLevel,
  };
}

function parseRuntime(value: unknown): OperationalCanaryRuntime {
  const runtime = object(value, "runtime");
  exactKeys(
    runtime,
    [
      "solverImplementationId",
      "solverRuntimeBuildId",
      "family",
      "distribution",
      "version",
      "buildId",
      "sourceRevision",
      "imageDigest",
      "applicationSourceSha256",
      "packageSha256",
      "binarySha256",
      "architecture",
    ],
    "runtime",
  );
  if (
    runtime.family !== "openfoam" ||
    runtime.distribution !== "opencfd" ||
    runtime.version !== "2606"
  ) {
    throw new Error("runtime must be OpenCFD 2606");
  }
  const implementationId = pattern(
    runtime.solverImplementationId,
    "solver implementation id",
    UUID,
  );
  if (implementationId !== OPENCFD_2606)
    throw new Error("runtime uses the wrong OpenCFD 2606 implementation id");
  const imageDigest = nullableText(runtime.imageDigest, "runtime image digest");
  if (imageDigest !== null && !/^sha256:[0-9a-f]{64}$/.test(imageDigest)) {
    throw new Error("runtime image digest is malformed");
  }
  const parsed: OperationalCanaryRuntime = {
    solverImplementationId: implementationId,
    solverRuntimeBuildId: pattern(
      runtime.solverRuntimeBuildId,
      "solver runtime build id",
      UUID,
    ),
    family: "openfoam",
    distribution: "opencfd",
    version: "2606",
    buildId: text(runtime.buildId, "runtime build id"),
    sourceRevision: nullableText(
      runtime.sourceRevision,
      "runtime source revision",
    ),
    imageDigest,
    applicationSourceSha256: nullableHash(
      runtime.applicationSourceSha256,
      "runtime application source SHA-256",
    ),
    packageSha256: nullableHash(
      runtime.packageSha256,
      "runtime package SHA-256",
    ),
    binarySha256: nullableHash(runtime.binarySha256, "runtime binary SHA-256"),
    architecture: nullableText(runtime.architecture, "runtime architecture"),
  };
  if (
    !parsed.applicationSourceSha256 ||
    !parsed.packageSha256 ||
    !parsed.binarySha256
  ) {
    throw new Error(
      "operational canary runtime requires application, package, and binary SHA-256 identities",
    );
  }
  return parsed;
}

function parseProvenance(value: unknown): OperationalCanaryProvenance {
  const provenance = object(value, "provenance");
  if (provenance.kind === "attested_canary") {
    exactKeys(provenance, ["kind", "attestationId"], "attested provenance");
    return {
      kind: "attested_canary",
      attestationId: pattern(provenance.attestationId, "attestation id", UUID),
    };
  }
  if (provenance.kind !== "unattested_cutover_canary") {
    throw new Error("unsupported operational canary provenance");
  }
  exactKeys(
    provenance,
    ["kind", "sourceBuild", "sourceJournal", "operatorReceipt", "failure"],
    "unattested provenance",
  );
  const sourceBuild = object(provenance.sourceBuild, "source build");
  const sourceJournal = object(provenance.sourceJournal, "source journal");
  const operatorReceipt = object(
    provenance.operatorReceipt,
    "operator receipt",
  );
  const failure = object(provenance.failure, "cutover failure");
  exactKeys(sourceBuild, ["buildId", "sha256", "byteSize"], "source build");
  exactKeys(sourceJournal, ["sha256", "byteSize"], "source journal");
  exactKeys(operatorReceipt, ["sha256", "byteSize"], "operator receipt");
  exactKeys(failure, ["phase", "exitCode"], "cutover failure");
  const buildId = text(sourceBuild.buildId, "source build id");
  type Unattested = Extract<
    OperationalCanaryProvenance,
    { kind: "unattested_cutover_canary" }
  >;
  const allowed = new Map<
    string,
    readonly [Unattested["failure"]["phase"], 14 | 137]
  >([
    ["prod-20260717-63385777be73-r2", ["queue_probe_same_build_replay", 14]],
    ["prod-20260717-cd0967a1ba4e-r3", ["retention_retry", 14]],
    ["prod-20260717-2ab861cb4ce6-r4", ["transient_retention", 137]],
  ]);
  const pair = allowed.get(buildId);
  if (!pair || failure.phase !== pair[0] || failure.exitCode !== pair[1]) {
    throw new Error(
      "unattested cutover build/failure is outside the exact recovery allowlist",
    );
  }
  return {
    kind: "unattested_cutover_canary",
    sourceBuild: {
      buildId,
      sha256: pattern(sourceBuild.sha256, "source build SHA-256", SHA256),
      byteSize: positiveInteger(sourceBuild.byteSize, "source build byte size"),
    },
    sourceJournal: {
      sha256: pattern(sourceJournal.sha256, "source journal SHA-256", SHA256),
      byteSize: positiveInteger(
        sourceJournal.byteSize,
        "source journal byte size",
      ),
    },
    operatorReceipt: {
      sha256: pattern(
        operatorReceipt.sha256,
        "operator receipt SHA-256",
        SHA256,
      ),
      byteSize: positiveInteger(
        operatorReceipt.byteSize,
        "operator receipt byte size",
      ),
    },
    failure: { phase: pair[0], exitCode: pair[1] },
  };
}

export function parseOperationalCanaryRegistrationClaim(
  value: unknown,
): OperationalCanaryRegistrationClaim {
  const claim = object(value, "operational canary registration claim");
  exactKeys(
    claim,
    [
      "schemaVersion",
      "kind",
      "approvedInventorySha256",
      "provenance",
      "runtime",
      "job",
      "evidence",
      "target",
      "operator",
      "capturedAt",
    ],
    "operational canary registration claim",
  );
  if (
    claim.schemaVersion !== 1 ||
    claim.kind !== "opencfd2606-operational-canary-evidence-registration"
  ) {
    throw new Error("unsupported operational canary registration claim");
  }
  if (
    claim.approvedInventorySha256 !==
    OPERATIONAL_CANARY_APPROVED_INVENTORY_SHA256
  ) {
    throw new Error(
      "operational canary claim is not bound to the sealed approved inventory",
    );
  }
  const provenance = parseProvenance(claim.provenance);
  const runtime = parseRuntime(claim.runtime);
  if (
    provenance.kind === "unattested_cutover_canary" &&
    provenance.sourceBuild.buildId !== runtime.buildId
  ) {
    throw new Error("unattested source build differs from runtime build");
  }
  const job = object(claim.job, "job");
  const evidence = object(claim.evidence, "evidence");
  exactKeys(job, ["id", "state", "statusSha256", "statusByteSize"], "job");
  exactKeys(
    evidence,
    [
      "path",
      "pointerSha256",
      "pointerByteSize",
      "archiveSha256",
      "archiveByteSize",
      "manifestSha256",
      "manifestByteSize",
      "archiveMemberSetSha256",
      "archiveMemberCount",
    ],
    "evidence",
  );
  if (job.state !== "completed")
    throw new Error("operational canary job must be completed");
  const target = parseTarget(claim.target);
  const archiveSha256 = pattern(
    evidence.archiveSha256,
    "local archive SHA-256",
    SHA256,
  );
  const archiveByteSize = positiveInteger(
    evidence.archiveByteSize,
    "local archive byte size",
  );
  if (
    archiveSha256 !== target.storedSha256 ||
    archiveByteSize !== target.storedByteSize
  ) {
    throw new Error("local archive differs from the exact GCS stored identity");
  }
  const archiveMemberCount = positiveInteger(
    evidence.archiveMemberCount,
    "archive member count",
  );
  if (archiveMemberCount <= 1) {
    throw new Error(
      "archive member count must include the manifest and at least one evidence member",
    );
  }
  return {
    schemaVersion: 1,
    kind: "opencfd2606-operational-canary-evidence-registration",
    approvedInventorySha256: OPERATIONAL_CANARY_APPROVED_INVENTORY_SHA256,
    provenance,
    runtime,
    job: {
      id: safeRelative(job.id, "engine job id", true),
      state: "completed",
      statusSha256: pattern(job.statusSha256, "status SHA-256", SHA256),
      statusByteSize: positiveInteger(job.statusByteSize, "status byte size"),
    },
    evidence: {
      path: safeRelative(evidence.path, "evidence path"),
      pointerSha256: pattern(evidence.pointerSha256, "pointer SHA-256", SHA256),
      pointerByteSize: positiveInteger(
        evidence.pointerByteSize,
        "pointer byte size",
      ),
      archiveSha256,
      archiveByteSize,
      manifestSha256: pattern(
        evidence.manifestSha256,
        "manifest SHA-256",
        SHA256,
      ),
      manifestByteSize: positiveInteger(
        evidence.manifestByteSize,
        "manifest byte size",
      ),
      archiveMemberSetSha256: pattern(
        evidence.archiveMemberSetSha256,
        "archive member-set SHA-256",
        SHA256,
      ),
      archiveMemberCount,
    },
    target,
    operator: text(claim.operator, "operator"),
    capturedAt: utcTimestamp(claim.capturedAt, "capture timestamp"),
  };
}

interface OwnershipRow {
  id: string;
  engine_job_id: string;
  evidence_path: string;
  bucket: string;
  object_key: string;
  generation: string;
  stored_sha256: string;
  stored_byte_size: number | string;
  crc32c: string;
  tar_sha256: string;
  tar_byte_size: number | string;
  zstd_level: number;
  registration_receipt_sha256: string;
  created_at: Date | string;
}

function ackFromRow(row: OwnershipRow): OperationalCanaryRegistrationAck {
  return {
    schemaVersion: 1,
    state: "operational_canary_owned",
    ownershipId: row.id,
    engineJobId: row.engine_job_id,
    evidencePath: row.evidence_path,
    target: {
      bucket: row.bucket,
      objectKey: row.object_key,
      generation: row.generation,
      storedSha256: row.stored_sha256,
      storedByteSize: Number(row.stored_byte_size),
      crc32c: row.crc32c,
      tarSha256: row.tar_sha256,
      tarByteSize: Number(row.tar_byte_size),
      zstdLevel: row.zstd_level,
    },
    registrationReceiptSha256: row.registration_receipt_sha256,
    registeredAt: new Date(row.created_at).toISOString(),
  };
}

export async function planOperationalCanaryEvidenceRegistration(
  db: DB,
  value: unknown,
) {
  const claim = parseOperationalCanaryRegistrationClaim(value);
  const receiptSha256 = sha256(canonicalJson(claim));
  const approvedRowSeal = operationalCanaryApprovedRowSeal(claim);
  const attestationId =
    claim.provenance.kind === "attested_canary"
      ? claim.provenance.attestationId
      : null;
  const [row] = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM sim_jobs WHERE engine_job_id = ${claim.job.id})::int AS sim_jobs,
      (SELECT count(*) FROM results WHERE engine_job_id = ${claim.job.id})::int AS results,
      (SELECT count(*) FROM result_attempts WHERE engine_job_id = ${claim.job.id})::int AS attempts,
      (SELECT count(*) FROM solver_evidence_blobs WHERE backend = 'gcs'
        AND bucket = ${claim.target.bucket} AND object_key = ${claim.target.objectKey}
        AND generation = ${claim.target.generation})::int AS blobs,
      (SELECT count(*) FROM solver_evidence_artifacts artifact
        WHERE artifact.engine_job_id = ${claim.job.id}
          OR (
            artifact.metadata ->> 'storageBackend' = 'gcs'
            AND artifact.metadata ->> 'bucket' = ${claim.target.bucket}
            AND artifact.metadata ->> 'objectKey' = ${claim.target.objectKey}
            AND artifact.metadata ->> 'generation' = ${claim.target.generation}
          ) OR (
            artifact.metadata -> 'storage' ->> 'backend' = 'gcs'
            AND artifact.metadata -> 'storage' ->> 'bucket' = ${claim.target.bucket}
            AND artifact.metadata -> 'storage' ->> 'object_key' = ${claim.target.objectKey}
            AND artifact.metadata -> 'storage' ->> 'generation' = ${claim.target.generation}
          ))::int AS artifacts,
      (SELECT count(*) FROM sync_brokered_evidence_uploads WHERE bucket = ${claim.target.bucket}
        AND object_key = ${claim.target.objectKey} AND generation = ${claim.target.generation})::int AS brokered,
      (SELECT count(*) FROM solver_canary_object_cleanup_reservations WHERE bucket = ${claim.target.bucket}
        AND object_key = ${claim.target.objectKey} AND generation = ${claim.target.generation})::int AS cleanup,
      (SELECT count(*) FROM solver_operational_canary_evidence_objects WHERE bucket = ${claim.target.bucket}
        AND object_key = ${claim.target.objectKey} AND generation = ${claim.target.generation}
        AND registration_receipt_sha256 = ${receiptSha256})::int AS exact_existing,
      (SELECT count(*) FROM solver_operational_canary_evidence_objects
        WHERE (bucket = ${claim.target.bucket} AND object_key = ${claim.target.objectKey}
          AND generation = ${claim.target.generation})
          OR (engine_job_id = ${claim.job.id} AND evidence_path = ${claim.evidence.path}))::int AS operational_any,
      (SELECT count(*) FROM solver_operational_canary_approved_inventory approved
        WHERE approved.inventory_sha256 = ${claim.approvedInventorySha256}
          AND approved.engine_job_id = ${claim.job.id}
          AND approved.evidence_path = ${claim.evidence.path}
          AND approved.bucket = ${claim.target.bucket}
          AND approved.object_key = ${claim.target.objectKey}
          AND approved.generation = ${claim.target.generation}
          AND approved.row_seal_sha256 = ${approvedRowSeal})::int AS approved_matches,
      (SELECT count(*) FROM solver_runtime_builds runtime
        JOIN solver_implementations implementation ON implementation.id = runtime.solver_implementation_id
        WHERE runtime.id = ${claim.runtime.solverRuntimeBuildId}::uuid
          AND runtime.solver_implementation_id = ${claim.runtime.solverImplementationId}::uuid
          AND implementation.family = 'openfoam'
          AND implementation.distribution = 'opencfd'
          AND implementation.release_version = '2606'
          AND runtime.build_id = ${claim.runtime.buildId}
          AND runtime.source_revision IS NOT DISTINCT FROM ${claim.runtime.sourceRevision}
          AND runtime.image_digest IS NOT DISTINCT FROM ${claim.runtime.imageDigest}
          AND runtime.application_source_sha256 IS NOT DISTINCT FROM ${claim.runtime.applicationSourceSha256}
          AND runtime.package_sha256 IS NOT DISTINCT FROM ${claim.runtime.packageSha256}
          AND runtime.binary_sha256 IS NOT DISTINCT FROM ${claim.runtime.binarySha256}
          AND runtime.architecture IS NOT DISTINCT FROM ${claim.runtime.architecture})::int AS runtime_matches,
      (SELECT count(*) FROM solver_engine_canary_attestations attestation
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(attestation.receipt -> 'jobs') = 'array'
            THEN attestation.receipt -> 'jobs' ELSE '[]'::jsonb END
        ) job
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(job -> 'points') = 'array'
            THEN job -> 'points' ELSE '[]'::jsonb END
        ) point
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(point -> 'artifacts') = 'array'
            THEN point -> 'artifacts' ELSE '[]'::jsonb END
        ) artifact
        WHERE ${attestationId}::uuid IS NOT NULL
          AND attestation.id = ${attestationId}::uuid
          AND attestation.receipt_sha256 = ${OPERATIONAL_CANARY_DATABASE_ATTESTATION_RECEIPT_SHA256}
          AND attestation.solver_implementation_id = ${claim.runtime.solverImplementationId}::uuid
          AND attestation.solver_runtime_build_id = ${claim.runtime.solverRuntimeBuildId}::uuid
          AND job ->> 'job_id' = ${claim.job.id}
          AND artifact ->> 'kind' = 'engine_bundle'
          AND artifact ->> 'sha256' = ${claim.target.storedSha256}
          AND artifact ->> 'byte_size' = ${String(claim.target.storedByteSize)}
          AND artifact -> 'storage' ->> 'bucket' = ${claim.target.bucket}
          AND artifact -> 'storage' ->> 'object_key' = ${claim.target.objectKey}
          AND artifact -> 'storage' ->> 'generation' = ${claim.target.generation}
          AND artifact -> 'storage' ->> 'crc32c' = ${claim.target.crc32c})::int AS attestation_matches
  `)) as unknown as Array<Record<string, number>>;
  const ownership = row ?? {};
  const conflicting = [
    "sim_jobs",
    "results",
    "attempts",
    "blobs",
    "artifacts",
    "brokered",
    "cleanup",
  ].reduce((total, key) => total + Number(ownership[key] ?? 0), 0);
  const exactExisting = Number(ownership.exact_existing ?? 0) === 1;
  const operationalConflict =
    Number(ownership.operational_any ?? 0) !== (exactExisting ? 1 : 0);
  const provenanceValid =
    Number(ownership.approved_matches ?? 0) === 1 &&
    Number(ownership.runtime_matches ?? 0) === 1 &&
    (claim.provenance.kind === "attested_canary"
      ? Number(ownership.attestation_matches ?? 0) === 1
      : Number(ownership.attestation_matches ?? 0) === 0);
  const eligible =
    exactExisting ||
    (conflicting === 0 && !operationalConflict && provenanceValid);
  return {
    claim,
    registrationReceiptSha256: receiptSha256,
    ownership,
    eligible,
    state: exactExisting ? "already_owned" : eligible ? "eligible" : "conflict",
  };
}

export async function registerOperationalCanaryEvidence(
  db: DB,
  value: unknown,
): Promise<OperationalCanaryRegistrationAck> {
  const claim = parseOperationalCanaryRegistrationClaim(value);
  const canonical = canonicalJson(claim);
  const receiptSha256 = sha256(canonical);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const provenance = claim.provenance;
    const inserted = (await tx.execute(sql`
      INSERT INTO solver_operational_canary_evidence_objects (
        approved_inventory_sha256, provenance_kind, canary_attestation_id, solver_implementation_id,
        solver_runtime_build_id, engine_job_id, evidence_path, bucket, object_key,
        generation, stored_sha256, stored_byte_size, crc32c, tar_sha256,
        tar_byte_size, zstd_level, pointer_sha256, pointer_byte_size,
        manifest_sha256, manifest_byte_size, archive_member_set_sha256,
        archive_member_count, status_sha256, status_byte_size,
        source_build_sha256, source_build_byte_size,
        source_journal_sha256, source_journal_byte_size,
        operator_receipt_sha256, operator_receipt_byte_size,
        cutover_failure_phase, cutover_failure_exit_code,
        registration_receipt_sha256, registration_receipt_canonical,
        registration_receipt, registered_by
      ) VALUES (
        ${claim.approvedInventorySha256},
        ${provenance.kind},
        ${provenance.kind === "attested_canary" ? provenance.attestationId : null}::uuid,
        ${claim.runtime.solverImplementationId}::uuid,
        ${claim.runtime.solverRuntimeBuildId}::uuid,
        ${claim.job.id}, ${claim.evidence.path}, ${claim.target.bucket},
        ${claim.target.objectKey}, ${claim.target.generation},
        ${claim.target.storedSha256}, ${claim.target.storedByteSize},
        ${claim.target.crc32c}, ${claim.target.tarSha256},
        ${claim.target.tarByteSize}, ${claim.target.zstdLevel},
        ${claim.evidence.pointerSha256}, ${claim.evidence.pointerByteSize},
        ${claim.evidence.manifestSha256}, ${claim.evidence.manifestByteSize},
        ${claim.evidence.archiveMemberSetSha256}, ${claim.evidence.archiveMemberCount},
        ${claim.job.statusSha256}, ${claim.job.statusByteSize},
        ${provenance.kind === "unattested_cutover_canary" ? provenance.sourceBuild.sha256 : null},
        ${provenance.kind === "unattested_cutover_canary" ? provenance.sourceBuild.byteSize : null},
        ${provenance.kind === "unattested_cutover_canary" ? provenance.sourceJournal.sha256 : null},
        ${provenance.kind === "unattested_cutover_canary" ? provenance.sourceJournal.byteSize : null},
        ${provenance.kind === "unattested_cutover_canary" ? provenance.operatorReceipt.sha256 : null},
        ${provenance.kind === "unattested_cutover_canary" ? provenance.operatorReceipt.byteSize : null},
        ${provenance.kind === "unattested_cutover_canary" ? provenance.failure.phase : null},
        ${provenance.kind === "unattested_cutover_canary" ? provenance.failure.exitCode : null},
        ${receiptSha256}, ${canonical}, ${canonical}::jsonb, ${claim.operator}
      )
      ON CONFLICT DO NOTHING
      RETURNING id, engine_job_id, evidence_path, bucket, object_key, generation,
        stored_sha256, stored_byte_size, crc32c, tar_sha256, tar_byte_size,
        zstd_level, registration_receipt_sha256, "createdAt" AS created_at
    `)) as unknown as OwnershipRow[];
    if (inserted[0]) return ackFromRow(inserted[0]);
    const existing = (await tx.execute(sql`
      SELECT id, engine_job_id, evidence_path, bucket, object_key, generation,
        stored_sha256, stored_byte_size, crc32c, tar_sha256, tar_byte_size,
        zstd_level, registration_receipt_sha256, "createdAt" AS created_at
      FROM solver_operational_canary_evidence_objects
      WHERE (bucket = ${claim.target.bucket} AND object_key = ${claim.target.objectKey}
        AND generation = ${claim.target.generation})
        OR (engine_job_id = ${claim.job.id} AND evidence_path = ${claim.evidence.path})
    `)) as unknown as OwnershipRow[];
    if (
      existing.length !== 1 ||
      existing[0]!.registration_receipt_sha256 !== receiptSha256
    ) {
      throw new Error(
        "existing operational canary ownership conflicts with the exact registration claim",
      );
    }
    return ackFromRow(existing[0]!);
  });
}

export function parseOperationalCanaryRetentionReceipt(
  value: unknown,
): OperationalCanaryRetentionReceipt {
  const receipt = object(value, "operational canary retention receipt");
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "kind",
      "ownershipId",
      "registrationReceiptSha256",
      "target",
      "outcome",
      "verificationMode",
      "verifiedMemberCount",
      "bytesDeleted",
      "deletedPaths",
      "gcsDisposition",
      "operator",
      "verifiedAt",
    ],
    "operational canary retention receipt",
  );
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "opencfd2606-operational-canary-local-retention-receipt"
  ) {
    throw new Error("unsupported operational canary retention receipt");
  }
  if (
    receipt.outcome !== "local_evidence_stripped" &&
    receipt.outcome !== "already_remote_only"
  ) {
    throw new Error("invalid operational canary retention outcome");
  }
  if (receipt.gcsDisposition !== "retained_exact_generation") {
    throw new Error(
      "operational canary retention may not delete or retarget GCS",
    );
  }
  const target = object(receipt.target, "retention target");
  exactKeys(
    target,
    [
      "bucket",
      "objectKey",
      "generation",
      "storedSha256",
      "storedByteSize",
      "crc32c",
    ],
    "retention target",
  );
  const generation = pattern(
    target.generation,
    "retention generation",
    GENERATION,
  );
  if (BigInt(generation) > MAX_GCS_GENERATION)
    throw new Error("retention generation exceeds GCS uint64");
  const verifiedMemberCount = positiveInteger(
    receipt.verifiedMemberCount,
    "verified member count",
  );
  const verificationMode = text(receipt.verificationMode, "verification mode");
  if (
    verificationMode !==
    `archive+manifest+all-members-restore:${verifiedMemberCount}`
  ) {
    throw new Error(
      "retention verification mode differs from its member count",
    );
  }
  if (!Array.isArray(receipt.deletedPaths))
    throw new Error("deletedPaths must be an array");
  const deletedPaths = receipt.deletedPaths.map((path, index) =>
    safeRelative(path, `deletedPaths[${index}]`),
  );
  if (new Set(deletedPaths).size !== deletedPaths.length)
    throw new Error("deletedPaths contains duplicates");
  const allowedDeletedPaths = new Set([
    "openfoam",
    "time_directories",
    "VTK",
    "engine_evidence.tar.zst",
    "engine_evidence.tar.gz",
    "openfoam_evidence.tar.gz",
  ]);
  if (deletedPaths.some((path) => !allowedDeletedPaths.has(path))) {
    throw new Error(
      "deletedPaths contains a path outside the exact packaged/raw allowlist",
    );
  }
  const bytesDeleted = nonNegativeInteger(
    receipt.bytesDeleted,
    "bytes deleted",
  );
  if ((receipt.outcome === "local_evidence_stripped") !== bytesDeleted > 0) {
    throw new Error("retention outcome and deleted byte count disagree");
  }
  if (
    (receipt.outcome === "local_evidence_stripped") !==
    deletedPaths.length > 0
  ) {
    throw new Error("retention outcome and deleted path list disagree");
  }
  return {
    schemaVersion: 1,
    kind: "opencfd2606-operational-canary-local-retention-receipt",
    ownershipId: pattern(receipt.ownershipId, "ownership id", UUID),
    registrationReceiptSha256: pattern(
      receipt.registrationReceiptSha256,
      "registration receipt SHA-256",
      SHA256,
    ),
    target: {
      bucket: text(target.bucket, "retention bucket"),
      objectKey: safeRelative(target.objectKey, "retention object key"),
      generation,
      storedSha256: pattern(
        target.storedSha256,
        "retention stored SHA-256",
        SHA256,
      ),
      storedByteSize: positiveInteger(
        target.storedByteSize,
        "retention stored byte size",
      ),
      crc32c: pattern(target.crc32c, "retention CRC32C", CRC32C),
    },
    outcome: receipt.outcome,
    verificationMode,
    verifiedMemberCount,
    bytesDeleted,
    deletedPaths: [...deletedPaths].sort(),
    gcsDisposition: "retained_exact_generation",
    operator: text(receipt.operator, "retention operator"),
    verifiedAt: utcTimestamp(
      receipt.verifiedAt,
      "retention verification timestamp",
    ),
  };
}

export async function acknowledgeOperationalCanaryRetention(
  db: DB,
  value: unknown,
) {
  const receipt = parseOperationalCanaryRetentionReceipt(value);
  const canonical = canonicalJson(receipt);
  const receiptSha256 = sha256(canonical);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const inserted = (await tx.execute(sql`
      INSERT INTO solver_operational_canary_retention_receipts (
        canary_evidence_object_id, outcome, verification_mode,
        verified_member_count, bytes_deleted, receipt_sha256,
        receipt_canonical, receipt, executed_by, verified_at
      ) VALUES (
        ${receipt.ownershipId}::uuid, ${receipt.outcome}, ${receipt.verificationMode},
        ${receipt.verifiedMemberCount}, ${receipt.bytesDeleted}, ${receiptSha256},
        ${canonical}, ${canonical}::jsonb, ${receipt.operator},
        ${receipt.verifiedAt}::timestamptz
      )
      ON CONFLICT DO NOTHING
      RETURNING id, "createdAt" AS created_at
    `)) as unknown as Array<{ id: string; created_at: Date | string }>;
    if (inserted[0]) {
      return {
        schemaVersion: 1,
        state: "local_retention_acknowledged" as const,
        receiptId: inserted[0].id,
        ownershipId: receipt.ownershipId,
        receiptSha256,
        acknowledgedAt: new Date(inserted[0].created_at).toISOString(),
      };
    }
    const existing = (await tx.execute(sql`
      SELECT id, receipt_sha256, "createdAt" AS created_at
      FROM solver_operational_canary_retention_receipts
      WHERE canary_evidence_object_id = ${receipt.ownershipId}::uuid
    `)) as unknown as Array<{
      id: string;
      receipt_sha256: string;
      created_at: Date | string;
    }>;
    if (
      existing.length !== 1 ||
      existing[0]!.receipt_sha256 !== receiptSha256
    ) {
      throw new Error(
        "existing operational canary retention receipt conflicts with the exact acknowledgement",
      );
    }
    return {
      schemaVersion: 1,
      state: "local_retention_acknowledged" as const,
      receiptId: existing[0]!.id,
      ownershipId: receipt.ownershipId,
      receiptSha256,
      acknowledgedAt: new Date(existing[0]!.created_at).toISOString(),
    };
  });
}
