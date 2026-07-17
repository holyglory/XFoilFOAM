import { createHash } from "node:crypto";

import {
  CampaignError,
  getOpenCfd2606CanaryAttestation,
  persistOpenCfd2606CanaryEvidenceCleanupProof,
  persistOpenCfd2606CanaryEvidenceRegistration,
  persistOpenCfd2606CanaryAttestation,
  requireCompleteOpenCfd2606CanaryCleanupProofSet,
  type DB,
} from "@aerodb/db";
import {
  engineCapabilityForExpected,
  isEngineRuntimeIdentity,
  OPENCFD_2606_ENGINE,
  sameEngineIdentity,
  type EngineClient,
  type EngineEvidenceArtifact,
  type EngineHealth,
  type EngineRuntimeIdentity,
  type JobResult,
  type PolarPoint,
} from "@aerodb/engine-client";
import { z } from "zod";

import { resolveEngineRuntimeBuild } from "./engine-provenance";

export const OPENCFD_2606_EXECUTION_POOL = "openfoam-opencfd-2606";
const OPENCFD_2606_SOURCE_REVISION = "481094fdf34f11ed6d0d603ee59a858a0124236d";

const OFFICIAL_PACKAGE_SHA256_BY_ARCH: Readonly<Record<string, string>> = {
  amd64: "aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d",
  x86_64: "aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d",
  arm64: "8d395ac52c284bc74c0aed774f692004d47ad7088596fabde5efc1f71991548a",
  aarch64: "8d395ac52c284bc74c0aed774f692004d47ad7088596fabde5efc1f71991548a",
};

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const positiveDecimal = z.string().regex(/^[1-9][0-9]*$/);
const crc32cBase64 = z.string().regex(/^[A-Za-z0-9+/]{6}==$/);
const runtimeSchema = z
  .object({
    family: z.literal("openfoam"),
    distribution: z.literal("opencfd"),
    version: z.literal("2606"),
    numerics_revision: z.literal("1"),
    adapter_contract_version: z.literal(1),
    build_id: z.string().trim().min(1),
    source_revision: z.literal(OPENCFD_2606_SOURCE_REVISION),
    image_digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    application_source_sha256: sha256,
    package_sha256: sha256,
    binary_sha256: sha256,
    architecture: z.string().trim().min(1),
  })
  .passthrough();

const storageBindingSchema = z
  .object({
    backend: z.literal("gcs"),
    bucket: z.string().trim().min(3),
    object_key: z.string().trim().min(1),
    generation: positiveDecimal,
    stored_sha256: sha256,
    stored_byte_size: z.number().int().positive(),
    crc32c: crc32cBase64,
    archive_format: z.literal("tar+zstd"),
    compression: z.literal("zstd"),
    uncompressed_tar_sha256: sha256,
    uncompressed_tar_byte_size: z.number().int().positive(),
    zstd_level: z.number().int().min(1).max(22),
    pointer_path: z.literal("engine_evidence.remote.json"),
    verified_at: z.string().datetime({ offset: true }),
    local_disposition: z.literal(
      "remote-copy-plus-local-archive-pending-database-ack",
    ),
    raw_local_disposition: z.literal("removed"),
    local_archive_retained_until_database_ack: z.literal(true),
    restore_verification: z
      .string()
      .regex(/^archive\+manifest\+all-members-restore:[1-9][0-9]*$/),
  })
  .strict();

const evidenceStorageSchema = z
  .object({
    backend: z.literal("gcs"),
    bucket: z.string().trim().min(3),
    object_prefix: z.string().trim().min(1),
    archive_format: z.literal("tar+zstd"),
    compression: z.literal("zstd"),
    zstd_level: z.number().int().min(1).max(22),
    local_disposition: z.literal("remote-only"),
  })
  .strict();

const liveEvidenceStorageSchema = z.object({
  backend: z.literal("gcs"),
  bucket: z.string().trim().min(3),
  object_prefix: z.string().trim().min(1),
  archive_format: z.literal("tar+zstd"),
  compression: z.literal("zstd"),
  zstd_level: z.number().int().min(1).max(22),
  remote_only: z.literal(true),
});

const artifactSchema = z
  .object({
    kind: z.string().min(1),
    path: z.string().min(1),
    role: z.string().nullable(),
    field: z.string().nullable(),
    sha256,
    byte_size: z.number().int().positive(),
    storage: storageBindingSchema,
  })
  .strict();

const preliminaryReceiptPointBaseSchema = z
  .object({
    aoa_deg: z.number().finite(),
    cl: z.number().finite(),
    cd: z.number().finite().positive(),
    cm: z.number().finite(),
    n_cells: z.number().int().positive(),
    case_slug: z.string().trim().min(1),
    evidence_base: z.string().trim().min(1),
    bundled_member_count: z.number().int().positive(),
    manifest_member_association_count: z.number().int().positive(),
    manifest_member_set_sha256: sha256,
    artifacts: z.array(artifactSchema).min(1),
  })
  .strict();

const canaryCleanupProofSchema = z
  .object({
    proof_id: z.string().uuid(),
    registration_id: z.string().uuid(),
    preliminary_receipt_sha256: sha256,
    job_id: z.string().regex(/^[0-9A-Za-z-]{8,64}$/),
    scenario: z.enum([
      "serial-rans",
      "mpi-2-rans",
      "forced-urans-precalc-no-shedding",
    ]),
    aoa_deg: z.number().finite(),
    case_slug: z.string().trim().min(1),
    evidence_base: z.string().trim().min(1),
    member_association_count: z.number().int().positive(),
    member_associations_sha256: sha256,
    manifest_member_set_sha256: sha256,
    verification: z
      .string()
      .regex(/^archive\+manifest\+all-members-restore:[1-9][0-9]*$/),
    local_archive_disposition: z.literal("removed-after-database-ack"),
  })
  .strict();

const schedulingSchema = z
  .object({
    solver_processes: z.number().int().positive(),
    resolved_case_concurrency: z.literal(1),
    mesh_build_count: z.number().int().min(0).max(1),
    aoa_case_count: z.number().int().positive(),
    mesh_reuse_mode: z.enum(["symlink", "copy"]),
  })
  .strict();

const remoteRenderProofSchema = z
  .object({
    strip_bytes_freed: z.number().int().positive(),
    field: z.literal("velocity_magnitude"),
    finite_count: z.number().int().positive(),
    vmin: z.number().finite(),
    vmax: z.number().finite(),
    custom_sha256: sha256,
    default_sha256: sha256,
  })
  .strict()
  .refine((proof) => proof.vmax > proof.vmin, {
    message: "remote render proof vmax must be greater than vmin",
  });

const preliminaryReceiptPointSchema = preliminaryReceiptPointBaseSchema.extend({
  remote_render_proof: remoteRenderProofSchema,
});

const finalReceiptPointSchema = preliminaryReceiptPointSchema.extend({
  cleanup: canaryCleanupProofSchema,
});

const preliminaryReceiptJobSchema = z
  .object({
    scenario: z.enum([
      "serial-rans",
      "mpi-2-rans",
      "forced-urans-precalc-no-shedding",
    ]),
    job_id: z.string().regex(/^[0-9A-Za-z-]{8,64}$/),
    runtime: runtimeSchema,
    method_key: z.enum(["openfoam.rans", "openfoam.urans"]),
    fidelity: z.enum(["rans", "urans_precalc"]),
    scheduling: schedulingSchema,
    points: z.array(preliminaryReceiptPointSchema).min(1),
  })
  .strict();

const receiptJobSchema = preliminaryReceiptJobSchema.extend({
  points: z.array(finalReceiptPointSchema).min(1),
});

const receiptTopLevelSchema = z
  .object({
    schema_version: z.literal(1),
    status: z.literal("ok"),
    engine: z.object({
      family: z.literal("openfoam"),
      distribution: z.literal("opencfd"),
      version: z.literal("2606"),
      numerics_revision: z.literal("1"),
      adapter_contract_version: z.literal(1),
    }),
    engine_handshake_key: z.literal(
      "openfoam:opencfd:2606:numerics-1:adapter-1",
    ),
    execution_pool: z.literal(OPENCFD_2606_EXECUTION_POOL),
    runtime: runtimeSchema,
    evidence_storage: evidenceStorageSchema,
  })
  .strict();

const preliminaryOpenCfd2606CanaryReceiptSchema = receiptTopLevelSchema.extend({
  jobs: z.array(preliminaryReceiptJobSchema).length(3),
});

export const openCfd2606CanaryReceiptSchema = receiptTopLevelSchema.extend({
  evidence_registration: z
    .object({
      id: z.string().uuid(),
      preliminary_receipt_sha256: sha256,
    })
    .strict(),
  jobs: z.array(receiptJobSchema).length(3),
});

export type OpenCfd2606CanaryReceipt = z.infer<
  typeof openCfd2606CanaryReceiptSchema
>;
type PreliminaryOpenCfd2606CanaryReceipt = z.infer<
  typeof preliminaryOpenCfd2606CanaryReceiptSchema
>;

const scenarioContract = {
  "serial-rans": {
    methodKey: "openfoam.rans",
    fidelity: "rans",
    solverProcesses: 1,
    aoas: [2, 5],
  },
  "mpi-2-rans": {
    methodKey: "openfoam.rans",
    fidelity: "rans",
    solverProcesses: 2,
    aoas: [5],
  },
  "forced-urans-precalc-no-shedding": {
    methodKey: "openfoam.urans",
    fidelity: "urans_precalc",
    solverProcesses: 1,
    aoas: [0],
  },
} as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function exactRuntimeKey(runtime: EngineRuntimeIdentity): string {
  return canonicalJson({
    family: runtime.family,
    distribution: runtime.distribution,
    version: runtime.version,
    numerics_revision: runtime.numerics_revision,
    adapter_contract_version: runtime.adapter_contract_version,
    build_id: runtime.build_id,
    source_revision: runtime.source_revision ?? null,
    image_digest: runtime.image_digest ?? null,
    application_source_sha256: runtime.application_source_sha256 ?? null,
    package_sha256: runtime.package_sha256 ?? null,
    binary_sha256: runtime.binary_sha256 ?? null,
    architecture: runtime.architecture ?? null,
  });
}

function assertOfficialRuntime(
  value: unknown,
  label: string,
): EngineRuntimeIdentity {
  const runtime = runtimeSchema.parse(value) as EngineRuntimeIdentity;
  if (!isEngineRuntimeIdentity(runtime)) {
    throw new CampaignError(
      "validation",
      `${label} is not immutable engine runtime provenance`,
    );
  }
  const architecture = runtime.architecture?.trim().toLowerCase() ?? "";
  const expectedPackage = OFFICIAL_PACKAGE_SHA256_BY_ARCH[architecture];
  if (!expectedPackage || runtime.package_sha256 !== expectedPackage) {
    throw new CampaignError(
      "conflict",
      `${label} does not identify the official OpenCFD 2606 package for ${architecture || "an unknown architecture"}`,
    );
  }
  return runtime;
}

function assertSameRuntime(
  actual: EngineRuntimeIdentity,
  expected: EngineRuntimeIdentity,
  label: string,
): void {
  if (exactRuntimeKey(actual) !== exactRuntimeKey(expected)) {
    throw new CampaignError(
      "conflict",
      `${label} differs from the exact live OpenCFD 2606 worker runtime`,
    );
  }
}

function normalizedArtifacts(
  artifacts: EngineEvidenceArtifact[] | undefined,
): z.infer<typeof artifactSchema>[] {
  const source = artifacts ?? [];
  const bundles = source.filter(
    (artifact) => artifact.kind === "engine_bundle",
  );
  if (bundles.length !== 1) {
    throw new CampaignError(
      "conflict",
      "live canary point must expose exactly one generation-bound engine bundle",
    );
  }
  const bundle = bundles[0];
  const metadata = bundle.metadata ?? {};
  let storage: z.infer<typeof storageBindingSchema>;
  try {
    storage = storageBindingSchema.parse({
      backend: metadata.storageBackend,
      bucket: metadata.bucket,
      object_key: metadata.objectKey,
      generation: metadata.generation,
      stored_sha256: bundle.sha256,
      stored_byte_size: bundle.byte_size,
      crc32c: metadata.crc32c,
      archive_format: metadata.archiveFormat,
      compression: metadata.compression,
      uncompressed_tar_sha256: metadata.uncompressedTarSha256,
      uncompressed_tar_byte_size: metadata.uncompressedTarByteSize,
      zstd_level: metadata.zstdLevel,
      verified_at: metadata.verifiedAt,
      pointer_path: metadata.pointerPath,
      local_disposition: metadata.localEvidenceDisposition,
      raw_local_disposition: metadata.rawLocalEvidenceDisposition,
      local_archive_retained_until_database_ack:
        metadata.localArchiveRetainedUntilDatabaseAck,
      restore_verification: metadata.remoteRestoreVerification,
    });
  } catch (error) {
    throw new CampaignError(
      "conflict",
      `live canary engine bundle lacks an exact GCS generation binding: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const normalized = source.map((artifact) => ({
    kind: artifact.kind,
    path: artifact.path,
    role: artifact.role ?? null,
    field: artifact.field ?? null,
    sha256: artifact.sha256,
    byte_size: artifact.byte_size,
    storage,
  }));
  const artifactIdentity = (artifact: (typeof normalized)[number]) => [
    artifact.kind,
    artifact.path,
    artifact.role ?? "",
    artifact.field ?? "",
  ];
  const identities = normalized.map((artifact) =>
    canonicalJson(artifactIdentity(artifact)),
  );
  if (new Set(identities).size !== identities.length) {
    throw new CampaignError(
      "conflict",
      "live canary evidence repeats a stable artifact identity",
    );
  }
  return normalized.sort((left, right) => {
    const leftIdentity = artifactIdentity(left);
    const rightIdentity = artifactIdentity(right);
    for (let index = 0; index < leftIdentity.length; index += 1) {
      if (leftIdentity[index]! < rightIdentity[index]!) return -1;
      if (leftIdentity[index]! > rightIdentity[index]!) return 1;
    }
    return 0;
  });
}

function assertRequiredArtifacts(
  artifacts: z.infer<typeof artifactSchema>[],
  label: string,
): void {
  const kinds = new Set(artifacts.map((artifact) => artifact.kind));
  for (const kind of [
    "manifest",
    "engine_bundle",
    "mesh",
    "force_coefficients",
    "vtk_window",
    "dictionary",
    "log",
  ]) {
    if (!kinds.has(kind)) {
      throw new CampaignError(
        "conflict",
        `${label} is missing ${kind} evidence`,
      );
    }
  }
  if (!artifacts.some((artifact) => artifact.role === "y_plus")) {
    throw new CampaignError("conflict", `${label} is missing y+ evidence`);
  }
}

type LiveClient = Pick<
  EngineClient,
  | "capabilities"
  | "finalizeRemoteEvidence"
  | "getQueue"
  | "getResult"
  | "healthDetails"
>;

export function assertOpenCfd2606EvidenceStorageContract(
  receiptStorage: OpenCfd2606CanaryReceipt["evidence_storage"],
  health: Pick<EngineHealth, "evidence_storage">,
): void {
  let liveStorage: z.infer<typeof liveEvidenceStorageSchema>;
  try {
    liveStorage = liveEvidenceStorageSchema.parse(health.evidence_storage);
  } catch (error) {
    throw new CampaignError(
      "conflict",
      `live OpenCFD 2606 gateway lacks the certified GCS evidence-storage contract: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expected = {
    backend: receiptStorage.backend,
    bucket: receiptStorage.bucket,
    object_prefix: receiptStorage.object_prefix,
    archive_format: receiptStorage.archive_format,
    compression: receiptStorage.compression,
    zstd_level: receiptStorage.zstd_level,
    remote_only: receiptStorage.local_disposition === "remote-only",
  };
  if (canonicalJson(liveStorage) !== canonicalJson(expected)) {
    throw new CampaignError(
      "conflict",
      "live OpenCFD 2606 gateway evidence-storage contract differs from the certified canary receipt",
    );
  }
}

/** Exact runtime used by every currently live worker consuming the production
 * 2606 route. Capability inventories alone are never accepted as runtime
 * evidence. */
export async function liveOpenCfd2606Runtime(
  client: LiveClient,
): Promise<EngineRuntimeIdentity> {
  const [capabilities, queue] = await Promise.all([
    client.capabilities({ expectedEngine: OPENCFD_2606_ENGINE }),
    client.getQueue({ expectedEngine: OPENCFD_2606_ENGINE }),
  ]);
  const descriptor = engineCapabilityForExpected(
    capabilities,
    OPENCFD_2606_ENGINE,
  );
  if (
    !descriptor ||
    descriptor.routing_key !== OPENCFD_2606_EXECUTION_POOL ||
    !descriptor.analysis_methods.includes("rans") ||
    !descriptor.analysis_methods.includes("urans")
  ) {
    throw new CampaignError(
      "invalid_state",
      "the live gateway does not advertise the exact OpenCFD 2606 production route",
    );
  }
  if (
    queue.worker_queues_error != null ||
    queue.worker_runtime_error != null ||
    Object.keys(queue.inspection_errors ?? {}).length > 0 ||
    queue.queue_enabled?.[OPENCFD_2606_EXECUTION_POOL] !== true
  ) {
    throw new CampaignError(
      "invalid_state",
      "live OpenCFD 2606 worker inspection is incomplete",
    );
  }
  const bindings = queue.worker_queues ?? [];
  if (
    bindings.some(
      (binding) =>
        binding.engine?.family === "openfoam" &&
        binding.engine.distribution === "opencfd" &&
        binding.engine.version === "2406",
    )
  ) {
    throw new CampaignError(
      "invalid_state",
      "a retired OpenCFD 2406 worker is still visible to the live gateway",
    );
  }
  const workers = bindings.filter((binding) =>
    binding.queues.includes(OPENCFD_2606_EXECUTION_POOL),
  );
  if (workers.length === 0) {
    throw new CampaignError(
      "invalid_state",
      "no live worker consumes the OpenCFD 2606 production pool",
    );
  }
  for (const worker of workers) {
    if (
      worker.execution_pool !== OPENCFD_2606_EXECUTION_POOL ||
      !isEngineRuntimeIdentity(worker.engine) ||
      !sameEngineIdentity(worker.engine, OPENCFD_2606_ENGINE)
    ) {
      throw new CampaignError(
        "invalid_state",
        `worker ${worker.worker || "<unknown>"} consumes the 2606 queue with a wrong or malformed runtime binding`,
      );
    }
  }
  const runtime = assertOfficialRuntime(
    workers[0].engine,
    `worker ${workers[0].worker} runtime`,
  );
  for (const worker of workers.slice(1)) {
    assertSameRuntime(
      assertOfficialRuntime(worker.engine, `worker ${worker.worker} runtime`),
      runtime,
      `worker ${worker.worker} runtime`,
    );
  }
  return runtime;
}

function validateCanaryReceiptContracts(
  receipt: PreliminaryOpenCfd2606CanaryReceipt | OpenCfd2606CanaryReceipt,
): void {
  if (
    receipt.evidence_storage.object_prefix.startsWith("/") ||
    receipt.evidence_storage.object_prefix
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new CampaignError(
      "validation",
      "canary receipt evidence object prefix is unsafe",
    );
  }
  const scenarioNames = new Set(receipt.jobs.map((job) => job.scenario));
  const jobIds = new Set(receipt.jobs.map((job) => job.job_id));
  if (scenarioNames.size !== 3 || jobIds.size !== 3) {
    throw new CampaignError(
      "validation",
      "canary receipt must contain three distinct scenarios and job ids",
    );
  }
  for (const job of receipt.jobs) {
    const expected = scenarioContract[job.scenario];
    if (
      job.method_key !== expected.methodKey ||
      job.fidelity !== expected.fidelity ||
      job.scheduling.solver_processes !== expected.solverProcesses ||
      job.scheduling.aoa_case_count !== expected.aoas.length ||
      canonicalJson(job.points.map((point) => point.aoa_deg)) !==
        canonicalJson(expected.aoas)
    ) {
      throw new CampaignError(
        "validation",
        `canary receipt scenario ${job.scenario} does not match its production workload`,
      );
    }
    for (const point of job.points) {
      if (
        point.manifest_member_association_count !==
        point.bundled_member_count + 1
      ) {
        throw new CampaignError(
          "validation",
          `${job.scenario} manifest association count must include the manifest in addition to every bundled member`,
        );
      }
      for (const [label, value] of [
        ["case slug", point.case_slug],
        ["evidence base", point.evidence_base],
      ] as const) {
        if (
          value.startsWith("/") ||
          value.includes("\\") ||
          value
            .split("/")
            .some((part) => !part || part === "." || part === "..")
        ) {
          throw new CampaignError(
            "validation",
            `${job.scenario} ${label} is unsafe`,
          );
        }
      }
      assertRequiredArtifacts(point.artifacts, `${job.scenario} receipt point`);
      const bundles = point.artifacts.filter(
        (artifact) => artifact.kind === "engine_bundle",
      );
      if (bundles.length !== 1) {
        throw new CampaignError(
          "validation",
          `${job.scenario} receipt point must contain exactly one engine bundle`,
        );
      }
      const bundle = bundles[0];
      const storageKey = canonicalJson(bundle.storage);
      if (
        point.artifacts.some(
          (artifact) => canonicalJson(artifact.storage) !== storageKey,
        )
      ) {
        throw new CampaignError(
          "validation",
          `${job.scenario} receipt artifacts do not share one exact archive generation`,
        );
      }
      const expectedObjectKey =
        `${receipt.evidence_storage.object_prefix}/sha256/` +
        `${bundle.sha256.slice(0, 2)}/${bundle.sha256}.tar.zst`;
      if (
        bundle.storage.bucket !== receipt.evidence_storage.bucket ||
        bundle.storage.object_key !== expectedObjectKey ||
        bundle.storage.stored_sha256 !== bundle.sha256 ||
        bundle.storage.stored_byte_size !== bundle.byte_size ||
        bundle.storage.archive_format !==
          receipt.evidence_storage.archive_format ||
        bundle.storage.compression !== receipt.evidence_storage.compression ||
        bundle.storage.zstd_level !== receipt.evidence_storage.zstd_level ||
        bundle.storage.restore_verification !==
          `archive+manifest+all-members-restore:${point.bundled_member_count}`
      ) {
        throw new CampaignError(
          "validation",
          `${job.scenario} receipt archive binding differs from its storage contract`,
        );
      }
    }
  }
}

function validatePreliminaryOpenCfd2606CanaryReceiptShape(
  value: unknown,
): PreliminaryOpenCfd2606CanaryReceipt {
  const receipt = preliminaryOpenCfd2606CanaryReceiptSchema.parse(value);
  validateCanaryReceiptContracts(receipt);
  return receipt;
}

export function validateOpenCfd2606CanaryReceiptShape(
  value: unknown,
): OpenCfd2606CanaryReceipt {
  const receipt = openCfd2606CanaryReceiptSchema.parse(value);
  validateCanaryReceiptContracts(receipt);
  for (const job of receipt.jobs) {
    for (const point of job.points) {
      if (
        point.cleanup.registration_id !== receipt.evidence_registration.id ||
        point.cleanup.preliminary_receipt_sha256 !==
          receipt.evidence_registration.preliminary_receipt_sha256 ||
        point.cleanup.job_id !== job.job_id ||
        point.cleanup.scenario !== job.scenario ||
        point.cleanup.aoa_deg !== point.aoa_deg ||
        point.cleanup.case_slug !== point.case_slug ||
        point.cleanup.evidence_base !== point.evidence_base ||
        point.cleanup.member_association_count !==
          point.manifest_member_association_count ||
        point.cleanup.manifest_member_set_sha256 !==
          point.manifest_member_set_sha256 ||
        point.cleanup.member_associations_sha256 !==
          canaryPointRegistrationDigest(
            receipt.evidence_registration.id,
            receipt.evidence_registration.preliminary_receipt_sha256,
            job,
            point,
          ) ||
        point.cleanup.verification !==
          `archive+manifest+all-members-restore:${point.bundled_member_count}`
      ) {
        throw new CampaignError(
          "validation",
          `${job.scenario} cleanup proof differs from its durable evidence registration`,
        );
      }
    }
  }
  const cleanupProofIds = receipt.jobs.flatMap((job) =>
    job.points.map((point) => point.cleanup.proof_id),
  );
  if (cleanupProofIds.length !== 4 || new Set(cleanupProofIds).size !== 4) {
    throw new CampaignError(
      "validation",
      "successful canary receipt requires four distinct per-point cleanup proofs",
    );
  }
  return receipt;
}

export function validateOpenCfd2606LiveJobResult(
  result: JobResult,
  job: PreliminaryReceiptJob,
  liveRuntime: EngineRuntimeIdentity,
): void {
  if (
    result.job_id !== job.job_id ||
    result.state !== "completed" ||
    result.execution_pool !== OPENCFD_2606_EXECUTION_POOL ||
    canonicalJson(result.method_keys ?? []) !== canonicalJson([job.method_key])
  ) {
    throw new CampaignError(
      "conflict",
      `live result ${job.job_id} no longer matches the canary receipt`,
    );
  }
  assertSameRuntime(
    assertOfficialRuntime(result.engine, `${job.scenario} result runtime`),
    liveRuntime,
    `${job.scenario} result runtime`,
  );
  const scheduling = result.scheduling;
  if (
    !scheduling ||
    scheduling.solver_processes !== job.scheduling.solver_processes ||
    scheduling.resolved_case_concurrency !== 1 ||
    scheduling.aoa_case_count !== job.scheduling.aoa_case_count ||
    scheduling.mesh_build_count !== job.scheduling.mesh_build_count ||
    scheduling.mesh_build_count > 1 ||
    scheduling.mesh_reuse_mode !== job.scheduling.mesh_reuse_mode
  ) {
    throw new CampaignError(
      "conflict",
      `${job.scenario} live scheduling metadata differs from the receipt`,
    );
  }
  const attempts = result.polars.flatMap((polar) => polar.attempts ?? []);
  const points = result.polars.flatMap((polar) => polar.points);
  if (attempts.length > 0 || points.length !== job.points.length) {
    throw new CampaignError(
      "conflict",
      `${job.scenario} live result has missing or rejected points`,
    );
  }
  for (const receiptPoint of job.points) {
    const point = points.find(
      (candidate) => candidate.aoa_deg === receiptPoint.aoa_deg,
    ) as PolarPoint | undefined;
    if (
      !point ||
      point.case_slug !== receiptPoint.case_slug ||
      point.method_key !== job.method_key ||
      point.fidelity !== job.fidelity ||
      point.converged !== true ||
      point.cl !== receiptPoint.cl ||
      point.cd !== receiptPoint.cd ||
      point.cm !== receiptPoint.cm ||
      point.n_cells !== receiptPoint.n_cells ||
      point.unsteady !== false
    ) {
      throw new CampaignError(
        "conflict",
        `${job.scenario} live point ${receiptPoint.aoa_deg}° differs from the receipt`,
      );
    }
    if (
      typeof point.images?.velocity_magnitude !== "string" ||
      point.images.velocity_magnitude.length === 0
    ) {
      throw new CampaignError(
        "conflict",
        `${job.scenario} live point lacks requested stored velocity media`,
      );
    }
    if (job.method_key === "openfoam.rans" && point.force_history != null) {
      throw new CampaignError(
        "conflict",
        `${job.scenario} RANS point invented a transient force history`,
      );
    }
    if (job.scenario === "forced-urans-precalc-no-shedding") {
      const history = point.force_history;
      const arrays = history
        ? [history.t, history.cl, history.cd, history.cm]
        : [];
      const isZeroOrMissing = (value: number | null | undefined) =>
        value == null || (Number.isFinite(value) && value === 0);
      if (
        point.frame_track != null ||
        arrays.length !== 4 ||
        arrays.some(
          (values) =>
            !Array.isArray(values) ||
            values.length < 2 ||
            values.some((value) => !Number.isFinite(value)),
        ) ||
        new Set(arrays.map((values) => values.length)).size !== 1 ||
        !history!.t.every(
          (value, index) => index === 0 || value > history!.t[index - 1],
        ) ||
        history!.t.at(-1)! - history!.t[0] + 1e-9 <
          (2.1 * 0.05) / (0.05 * 166) ||
        history!.period_s != null ||
        history!.retained_cycles != null ||
        !isZeroOrMissing(history!.shedding_freq_hz) ||
        !isZeroOrMissing(point.strouhal)
      ) {
        throw new CampaignError(
          "conflict",
          "forced URANS live result does not satisfy the physical no-shedding observation window",
        );
      }
    }
    assertSameRuntime(
      assertOfficialRuntime(
        point.engine,
        `${job.scenario} ${receiptPoint.aoa_deg}° runtime`,
      ),
      liveRuntime,
      `${job.scenario} ${receiptPoint.aoa_deg}° runtime`,
    );
    const artifacts = normalizedArtifacts(point.evidence_artifacts);
    const liveBundle = point.evidence_artifacts?.find(
      (artifact) => artifact.kind === "engine_bundle",
    );
    if (liveBundle?.metadata?.evidenceBase !== receiptPoint.evidence_base) {
      throw new CampaignError(
        "conflict",
        `${job.scenario} live evidence base differs from the canary receipt`,
      );
    }
    assertRequiredArtifacts(artifacts, `${job.scenario} live point`);
    if (canonicalJson(artifacts) !== canonicalJson(receiptPoint.artifacts)) {
      throw new CampaignError(
        "conflict",
        `${job.scenario} live artifact checksums differ from the canary receipt`,
      );
    }
  }
}

type PreliminaryReceiptJob = z.infer<typeof preliminaryReceiptJobSchema>;
type PreliminaryReceiptPoint = z.infer<typeof preliminaryReceiptPointSchema>;

/** The engine protects cleanup with one non-blocking lock per job. Keep point
 * cleanup sequential inside that job while allowing independent jobs to run
 * in parallel. */
export async function serializeCanaryPointCleanup<T, R>(
  points: readonly T[],
  cleanup: (point: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (const point of points) results.push(await cleanup(point));
  return results;
}

function cleanupProofDatabaseIdentity(
  cleanup: z.infer<typeof canaryCleanupProofSchema>,
) {
  return {
    id: cleanup.proof_id,
    registrationId: cleanup.registration_id,
    jobId: cleanup.job_id,
    scenario: cleanup.scenario,
    aoaDeg: cleanup.aoa_deg,
    caseSlug: cleanup.case_slug,
    evidenceBase: cleanup.evidence_base,
    memberAssociationCount: cleanup.member_association_count,
    memberAssociationsSha256: cleanup.member_associations_sha256,
    manifestMemberSetSha256: cleanup.manifest_member_set_sha256,
    verification: cleanup.verification,
  };
}

function canaryPointRegistrationDigest(
  registrationId: string,
  preliminaryReceiptSha256: string,
  job: Pick<PreliminaryReceiptJob, "job_id" | "scenario">,
  point: PreliminaryReceiptPoint,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        registrationId,
        preliminaryReceiptSha256,
        jobId: job.job_id,
        scenario: job.scenario,
        aoaDeg: point.aoa_deg,
        caseSlug: point.case_slug,
        evidenceBase: point.evidence_base,
        bundledMemberCount: point.bundled_member_count,
        manifestMemberAssociationCount: point.manifest_member_association_count,
        manifestMemberSetSha256: point.manifest_member_set_sha256,
        artifacts: point.artifacts,
      }),
    )
    .digest("hex");
}

async function verifyCanaryPointDatabaseAckCleanup(
  db: DB,
  client: LiveClient,
  registrationId: string,
  preliminaryReceiptSha256: string,
  job: Pick<PreliminaryReceiptJob, "job_id" | "scenario">,
  point: PreliminaryReceiptPoint,
): Promise<z.infer<typeof canaryCleanupProofSchema>> {
  const bundles = point.artifacts.filter(
    (artifact) => artifact.kind === "engine_bundle",
  );
  if (bundles.length !== 1) {
    throw new CampaignError(
      "conflict",
      `${job.scenario} cleanup requires one exact engine bundle`,
    );
  }
  const storage = bundles[0]!.storage;
  const memberAssociationsSha256 = canaryPointRegistrationDigest(
    registrationId,
    preliminaryReceiptSha256,
    job,
    point,
  );
  const response = await client.finalizeRemoteEvidence(job.job_id, {
    case_slug: point.case_slug,
    evidence_base: point.evidence_base,
    remote: {
      schemaVersion: 1,
      format: "tar+zstd",
      bucket: storage.bucket,
      objectKey: storage.object_key,
      generation: storage.generation,
      storedSha256: storage.stored_sha256,
      storedSize: storage.stored_byte_size,
      tarSha256: storage.uncompressed_tar_sha256,
      tarSize: storage.uncompressed_tar_byte_size,
      crc32c: storage.crc32c,
      zstdLevel: storage.zstd_level,
      createdAt: storage.verified_at,
    },
    canary_evidence_registrations: [
      {
        registration_id: registrationId,
        receipt_sha256: preliminaryReceiptSha256,
        scenario: job.scenario,
        aoa_deg: point.aoa_deg,
        member_association_count: point.manifest_member_association_count,
        member_associations_sha256: memberAssociationsSha256,
        manifest_member_set_sha256: point.manifest_member_set_sha256,
      },
    ],
  });
  const expectedVerification = `archive+manifest+all-members-restore:${point.bundled_member_count}`;
  if (
    !["complete", "no_local_bytes"].includes(response.state) ||
    response.evidence_base !== point.evidence_base ||
    response.association_count !== 1 ||
    response.verification !== expectedVerification
  ) {
    throw new CampaignError(
      "conflict",
      `${job.scenario} engine did not acknowledge exact database-backed archive cleanup`,
    );
  }
  const proof = await persistOpenCfd2606CanaryEvidenceCleanupProof(db, {
    registrationId,
    jobId: job.job_id,
    scenario: job.scenario,
    aoaDeg: point.aoa_deg,
    caseSlug: point.case_slug,
    evidenceBase: point.evidence_base,
    memberAssociationCount: point.manifest_member_association_count,
    memberAssociationsSha256,
    manifestMemberSetSha256: point.manifest_member_set_sha256,
    verification: expectedVerification,
  });
  return {
    proof_id: proof.id,
    registration_id: registrationId,
    preliminary_receipt_sha256: preliminaryReceiptSha256,
    job_id: job.job_id,
    scenario: job.scenario,
    aoa_deg: point.aoa_deg,
    case_slug: point.case_slug,
    evidence_base: point.evidence_base,
    member_association_count: point.manifest_member_association_count,
    member_associations_sha256: memberAssociationsSha256,
    manifest_member_set_sha256: point.manifest_member_set_sha256,
    verification: expectedVerification,
    local_archive_disposition: "removed-after-database-ack",
  };
}

export async function attestOpenCfd2606CanaryReceipt(
  db: DB,
  client: LiveClient,
  receiptValue: unknown,
  actor?: string | null,
) {
  const preliminaryReceipt =
    validatePreliminaryOpenCfd2606CanaryReceiptShape(receiptValue);
  const [liveRuntime, health] = await Promise.all([
    liveOpenCfd2606Runtime(client),
    client.healthDetails({ expectedEngine: OPENCFD_2606_ENGINE }),
  ]);
  assertOpenCfd2606EvidenceStorageContract(
    preliminaryReceipt.evidence_storage,
    health,
  );
  assertSameRuntime(
    assertOfficialRuntime(preliminaryReceipt.runtime, "canary receipt runtime"),
    liveRuntime,
    "canary receipt runtime",
  );
  for (const job of preliminaryReceipt.jobs) {
    assertSameRuntime(
      assertOfficialRuntime(job.runtime, `${job.scenario} receipt runtime`),
      liveRuntime,
      `${job.scenario} receipt runtime`,
    );
    const result = await client.getResult(job.job_id, {
      expectedEngine: OPENCFD_2606_ENGINE,
      expectedExecutionPool: OPENCFD_2606_EXECUTION_POOL,
    });
    validateOpenCfd2606LiveJobResult(result, job, liveRuntime);
  }
  const resolved = await resolveEngineRuntimeBuild(
    db,
    liveRuntime,
    "canary_attestation",
  );
  if (!resolved) {
    throw new CampaignError(
      "invalid_state",
      "live OpenCFD 2606 runtime provenance could not be persisted",
    );
  }
  const preliminaryReceiptSha256 = createHash("sha256")
    .update(canonicalJson(preliminaryReceipt))
    .digest("hex");
  const registration = await persistOpenCfd2606CanaryEvidenceRegistration(db, {
    solverRuntimeBuildId: resolved.solverRuntimeBuildId,
    receiptSha256: preliminaryReceiptSha256,
    receipt: preliminaryReceipt as unknown as Record<string, unknown>,
    actor,
  });
  const finalReceipt = validateOpenCfd2606CanaryReceiptShape({
    ...preliminaryReceipt,
    evidence_registration: {
      id: registration.id,
      preliminary_receipt_sha256: preliminaryReceiptSha256,
    },
    jobs: await Promise.all(
      preliminaryReceipt.jobs.map(async (job) => ({
        ...job,
        points: await serializeCanaryPointCleanup(
          job.points,
          async (point) => ({
            ...point,
            cleanup: await verifyCanaryPointDatabaseAckCleanup(
              db,
              client,
              registration.id,
              preliminaryReceiptSha256,
              job,
              point,
            ),
          }),
        ),
      })),
    ),
  });
  const cleanupProofs = finalReceipt.jobs.flatMap((job) =>
    job.points.map((point) => cleanupProofDatabaseIdentity(point.cleanup)),
  );
  await requireCompleteOpenCfd2606CanaryCleanupProofSet(
    db,
    registration.id,
    cleanupProofs,
  );
  const receiptSha256 = createHash("sha256")
    .update(canonicalJson(finalReceipt))
    .digest("hex");
  return persistOpenCfd2606CanaryAttestation(db, {
    solverRuntimeBuildId: resolved.solverRuntimeBuildId,
    evidenceRegistrationId: registration.id,
    cleanupProofs,
    receiptSha256,
    receipt: finalReceipt as unknown as Record<string, unknown>,
    actor,
  });
}

/** Finalize/complete re-check: a previously valid receipt cannot authorize a
 * different worker image after a pool rollover. */
export async function assertLiveOpenCfd2606Attestation(
  db: DB,
  client: LiveClient,
  canaryAttestationId: string,
): Promise<void> {
  const [attestation, liveRuntime, health] = await Promise.all([
    getOpenCfd2606CanaryAttestation(db, canaryAttestationId, {
      requireEnabledPool: true,
    }),
    liveOpenCfd2606Runtime(client),
    client.healthDetails({ expectedEngine: OPENCFD_2606_ENGINE }),
  ]);
  const storedReceipt = validateOpenCfd2606CanaryReceiptShape(
    attestation.receipt,
  );
  const storedReceiptSha256 = createHash("sha256")
    .update(canonicalJson(storedReceipt))
    .digest("hex");
  if (storedReceiptSha256 !== attestation.receiptSha256) {
    throw new CampaignError(
      "conflict",
      "stored canary attestation digest differs from its exact canonical receipt",
    );
  }
  assertOpenCfd2606EvidenceStorageContract(
    storedReceipt.evidence_storage,
    health,
  );
  const storedRuntime = assertOfficialRuntime(
    {
      ...OPENCFD_2606_ENGINE,
      build_id: attestation.runtime.buildId,
      source_revision: attestation.runtime.sourceRevision,
      image_digest: attestation.runtime.imageDigest,
      application_source_sha256: attestation.runtime.applicationSourceSha256,
      package_sha256: attestation.runtime.packageSha256,
      binary_sha256: attestation.runtime.binarySha256,
      architecture: attestation.runtime.architecture,
    },
    "stored canary attestation runtime",
  );
  assertSameRuntime(storedRuntime, liveRuntime, "stored canary attestation");
  const replayedProofs: ReturnType<typeof cleanupProofDatabaseIdentity>[] = [];
  for (const job of storedReceipt.jobs) {
    const result = await client.getResult(job.job_id, {
      expectedEngine: OPENCFD_2606_ENGINE,
      expectedExecutionPool: OPENCFD_2606_EXECUTION_POOL,
    });
    validateOpenCfd2606LiveJobResult(result, job, liveRuntime);
    for (const point of job.points) {
      const replayed = await verifyCanaryPointDatabaseAckCleanup(
        db,
        client,
        storedReceipt.evidence_registration.id,
        storedReceipt.evidence_registration.preliminary_receipt_sha256,
        job,
        point,
      );
      if (canonicalJson(replayed) !== canonicalJson(point.cleanup)) {
        throw new CampaignError(
          "conflict",
          `${job.scenario} live cleanup proof differs from the immutable attestation`,
        );
      }
      replayedProofs.push(cleanupProofDatabaseIdentity(replayed));
    }
  }
  await requireCompleteOpenCfd2606CanaryCleanupProofSet(
    db,
    storedReceipt.evidence_registration.id,
    replayedProofs,
  );
}
