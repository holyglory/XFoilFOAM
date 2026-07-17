import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertOpenCfd2606EvidenceStorageContract,
  liveOpenCfd2606Runtime,
  serializeCanaryPointCleanup,
  validateOpenCfd2606CanaryReceiptShape,
  validateOpenCfd2606LiveJobResult,
} from "../src/openfoam-2606-attestation";

const OFFICIAL_PACKAGE =
  "aa20712a33e41ad7cbe5ee895355aedd7fcbdaf456ae1d4f33db3135827bc07d";
const runtime = {
  family: "openfoam",
  distribution: "opencfd",
  version: "2606",
  numerics_revision: "1",
  adapter_contract_version: 1,
  build_id: "openfoam-2606-attestation-test",
  source_revision: "481094fdf34f11ed6d0d603ee59a858a0124236d",
  image_digest: null,
  application_source_sha256: "a".repeat(64),
  package_sha256: OFFICIAL_PACKAGE,
  binary_sha256: "b".repeat(64),
  architecture: "x86_64",
} as const;

const engine = {
  family: "openfoam",
  distribution: "opencfd",
  version: "2606",
  numerics_revision: "1",
  adapter_contract_version: 1,
} as const;

function artifacts(suffix: string) {
  const byteSizes = [701, 3, 509, 41, 997, 11, 307, 71];
  const result = [
    ["manifest", "evidence", "manifest.json"],
    ["engine_bundle", "evidence", "engine_evidence.tar.zst"],
    ["mesh", "mesh", "constant/polyMesh/points"],
    ["force_coefficients", "force_coefficients", "coefficient.dat"],
    ["vtk_window", "vtk_window", "case.vtu"],
    ["dictionary", "dictionary", "controlDict"],
    ["log", "log", "log.pimpleFoam"],
    ["field_data", "y_plus", "yPlus.dat"],
  ].map(([kind, role, path], index) => ({
    kind,
    path: `${suffix}/${path}`,
    role,
    field: null,
    sha256: createHash("sha256")
      .update(`${suffix}:${kind}:${path}`)
      .digest("hex"),
    byte_size: byteSizes[index]!,
  }));
  const bundle = result.find((artifact) => artifact.kind === "engine_bundle")!;
  const storage = {
    backend: "gcs" as const,
    bucket: "airfoils-pro-storage-bucket",
    object_key:
      `solver-evidence/v1/sha256/${bundle.sha256.slice(0, 2)}/` +
      `${bundle.sha256}.tar.zst`,
    generation: String(
      1_752_612_345_678_901n +
        BigInt(
          `0x${createHash("sha256").update(suffix).digest("hex").slice(0, 10)}`,
        ),
    ),
    stored_sha256: bundle.sha256,
    stored_byte_size: bundle.byte_size,
    crc32c: "AAAAAA==",
    archive_format: "tar+zstd" as const,
    compression: "zstd" as const,
    uncompressed_tar_sha256: "e".repeat(64),
    uncompressed_tar_byte_size: 4096,
    zstd_level: 10,
    verified_at: "2026-07-17T00:00:00+00:00",
    pointer_path: "engine_evidence.remote.json" as const,
    local_disposition:
      "remote-copy-plus-local-archive-pending-database-ack" as const,
    raw_local_disposition: "removed" as const,
    local_archive_retained_until_database_ack: true as const,
    restore_verification: "archive+manifest+all-members-restore:7" as const,
  };
  return result
    .map((artifact) => ({ ...artifact, storage }))
    .sort((left, right) => {
      const leftIdentity = [
        left.kind,
        left.path,
        left.role ?? "",
        left.field ?? "",
      ];
      const rightIdentity = [
        right.kind,
        right.path,
        right.role ?? "",
        right.field ?? "",
      ];
      for (let index = 0; index < leftIdentity.length; index += 1) {
        if (leftIdentity[index]! < rightIdentity[index]!) return -1;
        if (leftIdentity[index]! > rightIdentity[index]!) return 1;
      }
      return 0;
    });
}

function liveArtifact(artifact: ReturnType<typeof artifacts>[number]) {
  return {
    ...artifact,
    mime_type:
      artifact.kind === "engine_bundle"
        ? "application/zstd"
        : "application/octet-stream",
    url: `/jobs/canary/files/${artifact.path}`,
    metadata:
      artifact.kind === "engine_bundle"
        ? {
            storageBackend: artifact.storage.backend,
            bucket: artifact.storage.bucket,
            objectKey: artifact.storage.object_key,
            generation: artifact.storage.generation,
            crc32c: artifact.storage.crc32c,
            archiveFormat: artifact.storage.archive_format,
            compression: artifact.storage.compression,
            uncompressedTarSha256: artifact.storage.uncompressed_tar_sha256,
            uncompressedTarByteSize:
              artifact.storage.uncompressed_tar_byte_size,
            zstdLevel: artifact.storage.zstd_level,
            verifiedAt: artifact.storage.verified_at,
            pointerPath: artifact.storage.pointer_path,
            localEvidenceDisposition: artifact.storage.local_disposition,
            rawLocalEvidenceDisposition: artifact.storage.raw_local_disposition,
            localArchiveRetainedUntilDatabaseAck:
              artifact.storage.local_archive_retained_until_database_ack,
            remoteRestoreVerification: artifact.storage.restore_verification,
            evidenceBase: "evidence",
            bundledFileCount: 7,
          }
        : {},
  };
}

function job(
  scenario: "serial-rans" | "mpi-2-rans" | "forced-urans-precalc-no-shedding",
  aoas: number[],
) {
  const forced = scenario === "forced-urans-precalc-no-shedding";
  const mpi = scenario === "mpi-2-rans";
  const jobId = `canary-${scenario}`;
  const registrationId = "10000000-0000-4000-8000-000000000001";
  const preliminaryReceiptSha256 = "f".repeat(64);
  const points = aoas.map((aoa, pointIndex) => {
    const pointArtifacts = artifacts(`${scenario}-${aoa}`);
    const point = {
      aoa_deg: aoa,
      cl: forced ? 0.0002 : 0.45,
      cd: 0.0101,
      cm: 0,
      n_cells: 7_600,
      case_slug: `canary-${scenario}-${aoa}`,
      evidence_base: "evidence",
      bundled_member_count: 7,
      manifest_member_association_count: 8,
      manifest_member_set_sha256: createHash("sha256")
        .update(`manifest:${scenario}:${aoa}`)
        .digest("hex"),
      artifacts: pointArtifacts,
      remote_render_proof: {
        strip_bytes_freed: 4_096,
        field: "velocity_magnitude" as const,
        finite_count: 128,
        vmin: 0.01,
        vmax: 52.5,
        custom_sha256: createHash("sha256")
          .update(`custom:${scenario}:${aoa}`)
          .digest("hex"),
        default_sha256: createHash("sha256")
          .update(`default:${scenario}:${aoa}`)
          .digest("hex"),
      },
    };
    const memberAssociationsSha256 = createHash("sha256")
      .update(
        canonicalJson({
          registrationId,
          preliminaryReceiptSha256,
          jobId,
          scenario,
          aoaDeg: point.aoa_deg,
          caseSlug: point.case_slug,
          evidenceBase: point.evidence_base,
          bundledMemberCount: point.bundled_member_count,
          manifestMemberAssociationCount:
            point.manifest_member_association_count,
          manifestMemberSetSha256: point.manifest_member_set_sha256,
          artifacts: point.artifacts,
        }),
      )
      .digest("hex");
    return {
      ...point,
      cleanup: {
        proof_id: `20000000-0000-4000-8000-${String(
          (scenario === "serial-rans" ? 0 : scenario === "mpi-2-rans" ? 2 : 3) +
            pointIndex +
            1,
        ).padStart(12, "0")}`,
        registration_id: registrationId,
        preliminary_receipt_sha256: preliminaryReceiptSha256,
        job_id: jobId,
        scenario,
        aoa_deg: aoa,
        case_slug: point.case_slug,
        evidence_base: point.evidence_base,
        member_association_count: point.manifest_member_association_count,
        member_associations_sha256: memberAssociationsSha256,
        manifest_member_set_sha256: point.manifest_member_set_sha256,
        verification: "archive+manifest+all-members-restore:7",
        local_archive_disposition: "removed-after-database-ack" as const,
      },
    };
  });
  return {
    scenario,
    job_id: jobId,
    runtime: { ...runtime },
    method_key: forced ? "openfoam.urans" : "openfoam.rans",
    fidelity: forced ? "urans_precalc" : "rans",
    scheduling: {
      solver_processes: mpi ? 2 : 1,
      resolved_case_concurrency: 1,
      mesh_build_count: 1,
      aoa_case_count: aoas.length,
      mesh_reuse_mode: "symlink",
    },
    points,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function receipt() {
  return {
    schema_version: 1,
    status: "ok",
    engine,
    engine_handshake_key: "openfoam:opencfd:2606:numerics-1:adapter-1",
    execution_pool: "openfoam-opencfd-2606",
    runtime: { ...runtime },
    evidence_storage: {
      backend: "gcs",
      bucket: "airfoils-pro-storage-bucket",
      object_prefix: "solver-evidence/v1",
      archive_format: "tar+zstd",
      compression: "zstd",
      zstd_level: 10,
      local_disposition: "remote-only",
    },
    evidence_registration: {
      id: "10000000-0000-4000-8000-000000000001",
      preliminary_receipt_sha256: "f".repeat(64),
    },
    jobs: [
      job("serial-rans", [2, 5]),
      job("mpi-2-rans", [5]),
      job("forced-urans-precalc-no-shedding", [0]),
    ],
  };
}

function capability() {
  return {
    engine,
    routing_key: "openfoam-opencfd-2606",
    analysis_methods: ["rans", "urans"],
    steady: true,
    transient: true,
    volume_fields: true,
    mesh_evidence: true,
    stored_media: true,
    custom_field_rendering: true,
    multi_element_geometry: false,
    supported_turbulence_models: ["kOmegaSST"],
    supported_image_fields: ["velocity_magnitude"],
  };
}

function healthEvidenceStorage() {
  return {
    backend: "gcs" as const,
    bucket: "airfoils-pro-storage-bucket",
    object_prefix: "solver-evidence/v1",
    archive_format: "tar+zstd",
    compression: "zstd",
    zstd_level: 10,
    remote_only: true,
  };
}

function liveResultFor(
  receiptJob: ReturnType<typeof job>,
  forceHistory: unknown,
) {
  return {
    job_id: receiptJob.job_id,
    state: "completed",
    requested_engine: engine,
    requested_execution_pool: "openfoam-opencfd-2606",
    execution_pool: "openfoam-opencfd-2606",
    engine: runtime,
    method_keys: [receiptJob.method_key],
    scheduling: {
      requested_policy: "exclusive",
      resolved_policy: "exclusive",
      worker_cpu_budget: 8,
      resolved_cpu_budget: receiptJob.scheduling.solver_processes,
      resolved_case_concurrency: 1,
      solver_processes: receiptJob.scheduling.solver_processes,
      mesh_build_count: 1,
      aoa_case_count: receiptJob.points.length,
      mesh_reuse_mode: "symlink",
    },
    polars: [
      {
        speed: 50,
        chord: 0.1,
        reynolds: 333_333,
        attempts: [],
        points: receiptJob.points.map((point) => ({
          case_slug: point.case_slug,
          aoa_deg: point.aoa_deg,
          cl: point.cl,
          cd: point.cd,
          cm: point.cm,
          cl_cd: point.cl / point.cd,
          converged: true,
          n_cells: point.n_cells,
          unsteady: false,
          frame_track: null,
          force_history: forceHistory,
          images: {
            velocity_magnitude: "/jobs/canary/images/velocity.png",
          },
          method_key: receiptJob.method_key,
          fidelity: receiptJob.fidelity,
          engine: runtime,
          evidence_artifacts: point.artifacts.map(liveArtifact),
        })),
      },
    ],
  };
}

describe("OpenCFD 2606 canary attestation", () => {
  it("serializes point cleanup inside one engine job", async () => {
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    const result = await serializeCanaryPointCleanup([2, 5], async (aoa) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active > 1) throw new Error("same-job cleanup overlapped");
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(aoa);
      active -= 1;
      return aoa;
    });

    expect(result).toEqual([2, 5]);
    expect(order).toEqual([2, 5]);
    expect(maxActive).toBe(1);
  });

  it("accepts the exact live gateway evidence-storage contract", () => {
    const parsed = validateOpenCfd2606CanaryReceiptShape(receipt());
    expect(() =>
      assertOpenCfd2606EvidenceStorageContract(parsed.evidence_storage, {
        evidence_storage: healthEvidenceStorage(),
      }),
    ).not.toThrow();
  });

  it.each([
    ["bucket", "another-valid-storage-bucket"],
    ["object_prefix", "solver-evidence/v2"],
    ["zstd_level", 19],
  ] as const)(
    "rejects valid-looking live evidence-storage drift in %s",
    (field, value) => {
      const parsed = validateOpenCfd2606CanaryReceiptShape(receipt());
      expect(() =>
        assertOpenCfd2606EvidenceStorageContract(parsed.evidence_storage, {
          evidence_storage: {
            ...healthEvidenceStorage(),
            [field]: value,
          },
        }),
      ).toThrow(/differs from the certified canary receipt/);
    },
  );

  it("rejects a live gateway that omits its evidence-storage contract", () => {
    const parsed = validateOpenCfd2606CanaryReceiptShape(receipt());
    expect(() =>
      assertOpenCfd2606EvidenceStorageContract(parsed.evidence_storage, {}),
    ).toThrow(/lacks the certified GCS evidence-storage contract/);
  });

  it("rejects a live gateway that retained local evidence", () => {
    const parsed = validateOpenCfd2606CanaryReceiptShape(receipt());
    expect(() =>
      assertOpenCfd2606EvidenceStorageContract(parsed.evidence_storage, {
        evidence_storage: {
          ...healthEvidenceStorage(),
          remote_only: false,
        },
      }),
    ).toThrow(/lacks the certified GCS evidence-storage contract/);
  });

  it("accepts and preserves the Python canary remote-render proof", () => {
    const parsed = validateOpenCfd2606CanaryReceiptShape(receipt());
    expect(parsed.jobs).toHaveLength(3);
    const proofs = parsed.jobs.flatMap((candidate) =>
      candidate.points.map((point) => point.remote_render_proof),
    );
    expect(proofs).toHaveLength(4);
    expect(proofs.every((proof) => proof.strip_bytes_freed === 4_096)).toBe(
      true,
    );
  });

  it("rejects a receipt whose artifact generation is not bound to its bundle", () => {
    const forged = receipt();
    forged.jobs[0].points[0].artifacts[0].storage = {
      ...forged.jobs[0].points[0].artifacts[0].storage,
      generation: "1752612345678902",
    };
    expect(() => validateOpenCfd2606CanaryReceiptShape(forged)).toThrow(
      /do not share one exact archive generation/,
    );
  });

  it("rejects a receipt whose content-addressed key is outside its configured prefix", () => {
    const forged = receipt();
    forged.evidence_storage.object_prefix = "solver-evidence/v2";
    expect(() => validateOpenCfd2606CanaryReceiptShape(forged)).toThrow(
      /archive binding differs from its storage contract/,
    );
  });

  it("rejects a forged receipt with non-official executable provenance", () => {
    const forged = receipt();
    forged.runtime = {
      ...runtime,
      source_revision: "0".repeat(40),
    } as typeof runtime;
    expect(() => validateOpenCfd2606CanaryReceiptShape(forged)).toThrow();
  });

  it.each([
    "application_source_sha256",
    "package_sha256",
    "binary_sha256",
  ] as const)("rejects a receipt missing %s", (field) => {
    const forged = receipt() as unknown as Record<string, unknown>;
    delete (forged.runtime as Record<string, unknown>)[field];
    expect(() => validateOpenCfd2606CanaryReceiptShape(forged)).toThrow();
  });

  it("rejects a mixed good/wrong worker set on the production queue", async () => {
    const client = {
      capabilities: async () => ({ engines: [capability()] }),
      getQueue: async () => ({
        queue_enabled: { "openfoam-opencfd-2606": true },
        inspection_errors: {},
        worker_queues_error: null,
        worker_runtime_error: null,
        worker_queues: [
          {
            worker: "good@worker",
            queues: ["openfoam-opencfd-2606"],
            execution_pool: "openfoam-opencfd-2606",
            engine: runtime,
          },
          {
            worker: "wrong@worker",
            queues: ["openfoam-opencfd-2606"],
            execution_pool: "openfoam-opencfd-2606",
            engine: { ...runtime, version: "2406" },
          },
        ],
      }),
      getResult: async () => {
        throw new Error("unused");
      },
    };
    await expect(liveOpenCfd2606Runtime(client as never)).rejects.toThrow(
      /2406 worker|wrong or malformed runtime/,
    );
  });

  it("rejects the old too-short forced-URANS no-shedding shape", () => {
    const parsed = validateOpenCfd2606CanaryReceiptShape(receipt());
    const forced = parsed.jobs.find(
      (candidate) => candidate.scenario === "forced-urans-precalc-no-shedding",
    )!;
    const pointReceipt = forced.points[0];
    const liveArtifacts = pointReceipt.artifacts.map(liveArtifact);
    const result = {
      job_id: forced.job_id,
      state: "completed",
      requested_engine: engine,
      requested_execution_pool: "openfoam-opencfd-2606",
      execution_pool: "openfoam-opencfd-2606",
      engine: runtime,
      method_keys: ["openfoam.urans"],
      scheduling: {
        requested_policy: "exclusive",
        resolved_policy: "exclusive",
        worker_cpu_budget: 8,
        resolved_cpu_budget: 1,
        resolved_case_concurrency: 1,
        solver_processes: 1,
        mesh_build_count: 1,
        aoa_case_count: 1,
        mesh_reuse_mode: "symlink",
      },
      polars: [
        {
          speed: 166,
          chord: 0.05,
          reynolds: 553_333,
          attempts: [],
          points: [
            {
              case_slug: pointReceipt.case_slug,
              aoa_deg: 0,
              cl: pointReceipt.cl,
              cd: pointReceipt.cd,
              cm: pointReceipt.cm,
              cl_cd: pointReceipt.cl / pointReceipt.cd,
              converged: true,
              n_cells: pointReceipt.n_cells,
              unsteady: false,
              frame_track: null,
              force_history: {
                t: [0, 0.00722634],
                cl: [0.0001, 0.0002],
                cd: [0.01, 0.0101],
                cm: [0, 0],
              },
              images: {
                velocity_magnitude: "/jobs/canary/images/velocity.png",
              },
              method_key: "openfoam.urans",
              fidelity: "urans_precalc",
              engine: runtime,
              evidence_artifacts: liveArtifacts,
            },
          ],
        },
      ],
    };
    expect(() =>
      validateOpenCfd2606LiveJobResult(result as never, forced, runtime),
    ).toThrow(/physical no-shedding observation window/);
  });

  it("rejects periodic metadata on a forced no-shedding result", () => {
    const parsed = validateOpenCfd2606CanaryReceiptShape(receipt());
    const forced = parsed.jobs.find(
      (candidate) => candidate.scenario === "forced-urans-precalc-no-shedding",
    )!;
    const baseHistory = {
      t: [0, 0.02],
      cl: [0.0001, 0.0002],
      cd: [0.01, 0.0101],
      cm: [0, 0],
      shedding_freq_hz: 0,
      period_s: null,
      retained_cycles: null,
    };
    const periodicWindow = liveResultFor(forced as ReturnType<typeof job>, {
      ...baseHistory,
      shedding_freq_hz: 100,
      period_s: 0.01,
      retained_cycles: 3,
    });
    expect(() =>
      validateOpenCfd2606LiveJobResult(
        periodicWindow as never,
        forced,
        runtime,
      ),
    ).toThrow(/physical no-shedding observation window/);

    const periodicPoint = liveResultFor(
      forced as ReturnType<typeof job>,
      baseHistory,
    );
    (
      periodicPoint.polars[0]
        .points[0] as (typeof periodicPoint.polars)[0]["points"][number] & {
        strouhal?: number;
      }
    ).strouhal = 0.2;
    expect(() =>
      validateOpenCfd2606LiveJobResult(periodicPoint as never, forced, runtime),
    ).toThrow(/physical no-shedding observation window/);
  });

  it("rejects a RANS result that invents transient force history", () => {
    const parsed = validateOpenCfd2606CanaryReceiptShape(receipt());
    const rans = parsed.jobs.find(
      (candidate) => candidate.scenario === "serial-rans",
    )!;
    const result = liveResultFor(rans as ReturnType<typeof job>, {
      t: [0, 1],
      cl: [0.1, 0.2],
      cd: [0.01, 0.02],
      cm: [0, 0],
    });
    expect(() =>
      validateOpenCfd2606LiveJobResult(result as never, rans, runtime),
    ).toThrow(/invented a transient force history/);
  });

  it("matches shuffled live artifacts by the Python canary identity order, not byte size", () => {
    const parsed = validateOpenCfd2606CanaryReceiptShape(receipt());
    const rans = parsed.jobs.find(
      (candidate) => candidate.scenario === "serial-rans",
    )!;
    const result = liveResultFor(rans as ReturnType<typeof job>, null);
    for (const point of result.polars[0].points) {
      point.evidence_artifacts.reverse();
    }
    expect(() =>
      validateOpenCfd2606LiveJobResult(result as never, rans, runtime),
    ).not.toThrow();
  });

  it("rejects live evidence that moved to another GCS generation", () => {
    const parsed = validateOpenCfd2606CanaryReceiptShape(receipt());
    const rans = parsed.jobs.find(
      (candidate) => candidate.scenario === "serial-rans",
    )!;
    const result = liveResultFor(rans as ReturnType<typeof job>, null);
    const bundle = result.polars[0].points[0].evidence_artifacts.find(
      (artifact) => artifact.kind === "engine_bundle",
    )!;
    bundle.metadata.generation = "1752612345678902";
    expect(() =>
      validateOpenCfd2606LiveJobResult(result as never, rans, runtime),
    ).toThrow(/live artifact checksums differ from the canary receipt/);
  });
});
