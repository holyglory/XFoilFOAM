import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  acknowledgeOperationalCanaryRetention,
  canonicalJson,
  OPERATIONAL_CANARY_APPROVED_INVENTORY_SHA256,
  OPERATIONAL_CANARY_DATABASE_ATTESTATION_RECEIPT_SHA256,
  registerOperationalCanaryEvidence,
  type OperationalCanaryRegistrationClaim,
} from "../../../apps/sweeper/src/canary-evidence-ownership";
import type { DB } from "../src/client";
import { databaseUrl } from "../src/env";
import * as schema from "../src/schema";

interface ApprovedRuntime {
  id: string;
  buildId: string;
  sourceRevision: string | null;
  imageDigest: string | null;
  applicationSourceSha256: string | null;
  packageSha256: string | null;
  binarySha256: string | null;
  architecture: string | null;
  sourceJournal?: { sha256: string; byteSize: number };
  failure?: { phase: string; exitCode: number };
}

interface ApprovedObject {
  engineJobId: string;
  evidencePath: string;
  buildId: string;
  provenance:
    | { kind: "attested_canary"; attestationId: string }
    | { kind: "unattested_cutover_canary" };
  status: { sha256: string; byteSize: number };
  pointer: { sha256: string; byteSize: number };
  manifest: {
    sha256: string;
    byteSize: number;
    memberSetSha256: string;
    memberCount: number;
  };
  target: {
    bucket: string;
    objectKey: string;
    generation: string;
    storedSha256: string;
    storedByteSize: number;
    crc32c: string;
    tarSha256: string;
    tarByteSize: number;
    zstdLevel: number;
  };
}

interface ApprovedInventory {
  operator: string;
  inputs: {
    gcsInventory: { sha256: string; byteSize: number };
    attestationReceipt: {
      attestationId: string;
      databaseReceiptSha256: string;
      retainedReceiptSha256: string;
      retainedReceiptByteSize: number;
    };
  };
  runtimeBuilds: ApprovedRuntime[];
  objects: ApprovedObject[];
}

type GcsOwnerKind = "blob" | "artifact" | "cleanup" | "broker";
type EngineJobOwnerKind = "sim_job" | "result" | "attempt" | "artifact_job";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const approvedInventory = JSON.parse(
  readFileSync(
    resolve(here, "../../../config/operational-canary-approved-inventory.json"),
    "utf8",
  ),
) as ApprovedInventory;
const dbName = `aerodb_operational_canary_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

const ids = {
  category: "81000000-0000-4000-8000-000000000002",
  airfoil: "81000000-0000-4000-8000-000000000003",
  remoteSolver: "81000000-0000-4000-8000-000000000004",
  promise: "81000000-0000-4000-8000-000000000005",
  promisePoint: "81000000-0000-4000-8000-000000000006",
  revision: "81000000-0000-4000-8000-000000000007",
  medium: "81000000-0000-4000-8000-000000000008",
  bc: "81000000-0000-4000-8000-000000000009",
};
const implementation = "2f8bc764-09ae-4ff3-8fd2-260600000001";
const executionPool = "3f8bc764-09ae-4ff3-8fd2-260600000001";

let admin: ReturnType<typeof postgres> | null = null;
let setup: ReturnType<typeof postgres> | null = null;
let database: DB | null = null;

function stableUuid(value: number): string {
  return `82000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function approvedClaim(index: number): OperationalCanaryRegistrationClaim {
  const row = approvedInventory.objects[index];
  if (!row) throw new Error(`approved inventory row ${index} is absent`);
  const runtime = approvedInventory.runtimeBuilds.find(
    (candidate) => candidate.buildId === row.buildId,
  );
  if (!runtime) throw new Error(`runtime ${row.buildId} is absent`);
  const provenance =
    row.provenance.kind === "attested_canary"
      ? row.provenance
      : {
          kind: "unattested_cutover_canary" as const,
          sourceBuild: {
            buildId: runtime.buildId,
            sha256: row.status.sha256,
            byteSize: row.status.byteSize,
          },
          sourceJournal: {
            sha256: runtime.sourceJournal!.sha256,
            byteSize: runtime.sourceJournal!.byteSize,
          },
          operatorReceipt: approvedInventory.inputs.gcsInventory,
          failure: runtime.failure!,
        };
  return {
    schemaVersion: 1,
    kind: "opencfd2606-operational-canary-evidence-registration",
    approvedInventorySha256: OPERATIONAL_CANARY_APPROVED_INVENTORY_SHA256,
    provenance,
    runtime: {
      solverImplementationId: implementation,
      solverRuntimeBuildId: runtime.id,
      family: "openfoam",
      distribution: "opencfd",
      version: "2606",
      buildId: runtime.buildId,
      sourceRevision: runtime.sourceRevision,
      imageDigest: runtime.imageDigest,
      applicationSourceSha256: runtime.applicationSourceSha256,
      packageSha256: runtime.packageSha256,
      binarySha256: runtime.binarySha256,
      architecture: runtime.architecture,
    },
    job: {
      id: row.engineJobId,
      state: "completed",
      statusSha256: row.status.sha256,
      statusByteSize: row.status.byteSize,
    },
    evidence: {
      path: row.evidencePath,
      pointerSha256: row.pointer.sha256,
      pointerByteSize: row.pointer.byteSize,
      archiveSha256: row.target.storedSha256,
      archiveByteSize: row.target.storedByteSize,
      manifestSha256: row.manifest.sha256,
      manifestByteSize: row.manifest.byteSize,
      archiveMemberSetSha256: row.manifest.memberSetSha256,
      archiveMemberCount: row.manifest.memberCount,
    },
    target: row.target,
    operator: approvedInventory.operator,
    capturedAt: "2026-07-18T18:00:00.000Z",
  };
}

const unattestedIndices = approvedInventory.objects.flatMap((row, index) =>
  row.provenance.kind === "unattested_cutover_canary" ? [index] : [],
);

function unattestedClaim(ordinal = 0): OperationalCanaryRegistrationClaim {
  const index = unattestedIndices[ordinal % unattestedIndices.length];
  if (index === undefined)
    throw new Error("approved unattested inventory is empty");
  return approvedClaim(index);
}

function attestationReceipt(): Record<string, unknown> {
  const rows = approvedInventory.objects.filter(
    (row) => row.provenance.kind === "attested_canary",
  );
  return {
    schema_version: 1,
    status: "ok",
    engine: { family: "openfoam", distribution: "opencfd", version: "2606" },
    evidence_storage: {
      backend: "gcs",
      bucket: "airfoils-pro-storage-bucket",
      archive_format: "tar+zstd",
      compression: "zstd",
      local_disposition: "remote-only",
    },
    jobs: rows.map((row) => ({
      job_id: row.engineJobId,
      points: [
        {
          artifacts: [
            {
              kind: "engine_bundle",
              sha256: row.target.storedSha256,
              byte_size: row.target.storedByteSize,
              storage: {
                bucket: row.target.bucket,
                object_key: row.target.objectKey,
                generation: row.target.generation,
                stored_sha256: row.target.storedSha256,
                stored_byte_size: row.target.storedByteSize,
                crc32c: row.target.crc32c,
              },
            },
          ],
        },
      ],
    })),
  };
}

function targetAttestationReceipt(
  claim: OperationalCanaryRegistrationClaim,
): Record<string, unknown> {
  const target = claim.target;
  return {
    schema_version: 1,
    status: "ok",
    engine: { family: "openfoam", distribution: "opencfd", version: "2606" },
    evidence_storage: {
      backend: "gcs",
      bucket: target.bucket,
      archive_format: "tar+zstd",
      compression: "zstd",
      local_disposition: "remote-only",
    },
    jobs: [
      {
        job_id: claim.job.id,
        points: [
          {
            artifacts: [
              {
                kind: "engine_bundle",
                sha256: target.storedSha256,
                byte_size: target.storedByteSize,
                storage: {
                  bucket: target.bucket,
                  object_key: target.objectKey,
                  generation: target.generation,
                  stored_sha256: target.storedSha256,
                  stored_byte_size: target.storedByteSize,
                  crc32c: target.crc32c,
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

async function insertHonestTestAttestation(
  sqlClient: postgres.Sql,
  claim: OperationalCanaryRegistrationClaim,
  tag: number,
  attestationId = stableUuid(700_000 + tag),
): Promise<string> {
  const r5 = approvedInventory.runtimeBuilds.find((row) =>
    row.buildId.endsWith("-r5"),
  );
  if (!r5) throw new Error("approved r5 runtime is absent");
  const receipt = targetAttestationReceipt(claim);
  const canonical = canonicalJson(receipt);
  await sqlClient`
    INSERT INTO solver_engine_canary_attestations
      (id, solver_implementation_id, solver_runtime_build_id,
       solver_execution_pool_id, receipt_sha256, receipt, attested_by)
    VALUES (${attestationId}::uuid, ${implementation}::uuid,
            ${r5.id}::uuid, ${executionPool}::uuid, ${sha256(canonical)},
            ${canonical}::jsonb, '0081-test')
  `;
  return attestationId;
}

async function insertGcsOwner(
  sqlClient: postgres.Sql,
  kind: GcsOwnerKind,
  claim: OperationalCanaryRegistrationClaim,
  tag: number,
  cleanupAttestationId?: string,
): Promise<void> {
  const target = claim.target;
  if (kind === "blob") {
    await sqlClient`
      INSERT INTO solver_evidence_blobs
        (backend, bucket, object_key, generation, compression, mime_type,
         sha256, byte_size, crc32c, uncompressed_tar_sha256,
         uncompressed_tar_byte_size, "verifiedAt")
      VALUES ('gcs', ${target.bucket}, ${target.objectKey}, ${target.generation},
              'zstd', 'application/zstd', ${target.storedSha256},
              ${target.storedByteSize}, ${target.crc32c}, ${target.tarSha256},
              ${target.tarByteSize}, now())
    `;
    return;
  }
  if (kind === "artifact") {
    const metadata = {
      storageBackend: "gcs",
      bucket: target.bucket,
      objectKey: target.objectKey,
      generation: target.generation,
    };
    await sqlClient`
      INSERT INTO solver_evidence_artifacts
        (airfoil_id, kind, storage_key, mime_type, sha256, byte_size, metadata)
      VALUES (${ids.airfoil}::uuid, 'engine_bundle', ${`race/${tag}`},
              'application/zstd', ${target.storedSha256},
              ${target.storedByteSize},
              ${JSON.stringify(metadata)}::text::jsonb)
    `;
    return;
  }
  if (kind === "cleanup") {
    const attestationId =
      cleanupAttestationId ??
      (await insertHonestTestAttestation(sqlClient, claim, tag));
    await sqlClient`
      INSERT INTO solver_canary_object_cleanup_reservations
        (canary_attestation_id, bucket, object_key, generation, sha256,
         byte_size, crc32c, reserved_by)
      VALUES (${attestationId}::uuid, ${target.bucket},
              ${target.objectKey}, ${target.generation},
              ${target.storedSha256}, ${target.storedByteSize},
              ${target.crc32c}, '0081-test')
    `;
    return;
  }
  await sqlClient`
    INSERT INTO sync_brokered_evidence_uploads
      (id, idempotency_key, promise_id, promise_point_id, solver_id,
       source_instance_id, remote_result_id, remote_result_attempt_id, aoa_deg,
       engine_job_id, engine_case_slug, bucket, object_key, stored_sha256,
       stored_byte_size, tar_sha256, tar_byte_size, manifest_sha256,
       manifest_byte_size, zstd_level, bundled_file_count, state,
       generation, crc32c, verified_at)
    VALUES (${stableUuid(tag)}::uuid, ${stableUuid(tag + 100)}::uuid,
            ${ids.promise}::uuid, ${ids.promisePoint}::uuid,
            ${ids.remoteSolver}::uuid, 'operational-canary-fence',
            ${stableUuid(tag + 200)}::uuid, ${stableUuid(tag + 300)}::uuid,
            3, ${`broker-${tag}`}, ${`case-${tag}`}, ${target.bucket},
            ${target.objectKey}, ${target.storedSha256},
            ${target.storedByteSize}, ${target.tarSha256},
            ${target.tarByteSize}, ${claim.evidence.manifestSha256},
            ${claim.evidence.manifestByteSize}, ${target.zstdLevel},
            ${claim.evidence.archiveMemberCount}, 'verified',
            ${target.generation}, ${target.crc32c}, now())
  `;
}

async function insertEngineJobOwner(
  sqlClient: postgres.Sql,
  kind: EngineJobOwnerKind,
  claim: OperationalCanaryRegistrationClaim,
  tag: number,
): Promise<void> {
  const id = stableUuid(tag);
  if (kind === "sim_job") {
    await sqlClient`
      INSERT INTO sim_jobs
        (id, engine_job_id, airfoil_id, bc_ids, job_kind,
         reference_chord_m, wave, status, total_cases, completed_cases,
         request_payload)
      VALUES (${id}::uuid, ${claim.job.id}, ${ids.airfoil}::uuid, '[]'::jsonb,
              'targeted', 1, 1, 'done', 0, 0, '{"aoas":[]}'::jsonb)
    `;
    return;
  }
  if (kind === "result") {
    await sqlClient`
      INSERT INTO results
        (id, airfoil_id, bc_id, aoa_deg, status, source, engine_job_id)
      VALUES (${id}::uuid, ${ids.airfoil}::uuid, ${ids.bc}::uuid, ${tag},
              'done', 'solved', ${claim.job.id})
    `;
    return;
  }
  if (kind === "attempt") {
    await sqlClient`
      INSERT INTO result_attempts
        (id, airfoil_id, bc_id, aoa_deg, status, source, engine_job_id)
      VALUES (${id}::uuid, ${ids.airfoil}::uuid, ${ids.bc}::uuid, ${tag},
              'done', 'solved', ${claim.job.id})
    `;
    return;
  }
  await sqlClient`
    INSERT INTO solver_evidence_artifacts
      (id, airfoil_id, engine_job_id, kind, storage_key, mime_type,
       sha256, byte_size, metadata)
    VALUES (${id}::uuid, ${ids.airfoil}::uuid, ${claim.job.id},
            'engine_bundle', ${`engine-job/${tag}`}, 'application/zstd',
            ${claim.target.storedSha256}, ${claim.target.storedByteSize},
            '{}'::jsonb)
  `;
}

function retentionReceipt(
  claim: OperationalCanaryRegistrationClaim,
  ack: { ownershipId: string; registrationReceiptSha256: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const verifiedMemberCount = claim.evidence.archiveMemberCount - 1;
  return {
    schemaVersion: 1,
    kind: "opencfd2606-operational-canary-local-retention-receipt",
    ownershipId: ack.ownershipId,
    registrationReceiptSha256: ack.registrationReceiptSha256,
    target: {
      bucket: claim.target.bucket,
      objectKey: claim.target.objectKey,
      generation: claim.target.generation,
      storedSha256: claim.target.storedSha256,
      storedByteSize: claim.target.storedByteSize,
      crc32c: claim.target.crc32c,
    },
    outcome: "local_evidence_stripped",
    verificationMode: `archive+manifest+all-members-restore:${verifiedMemberCount}`,
    verifiedMemberCount,
    bytesDeleted: claim.target.storedByteSize,
    deletedPaths: ["engine_evidence.tar.zst"],
    gcsDisposition: "retained_exact_generation",
    operator: claim.operator,
    verifiedAt: "2026-07-18T19:00:00.000Z",
    ...overrides,
  };
}

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  setup = postgres(targetUrl.toString(), { max: 1 });
  await migrate(drizzle(setup), { migrationsFolder: migrations });
  database = drizzle(setup, { schema }) as unknown as DB;
  await setup.unsafe(`
    INSERT INTO categories (id, slug, name, path)
    VALUES ('${ids.category}', 'operational-canary-test',
            'Operational canary test', 'operational-canary-test');
    INSERT INTO airfoils (id, slug, name, category_id, source, points)
    VALUES ('${ids.airfoil}', 'operational-canary-test',
            'Operational canary test', '${ids.category}', 'test',
            '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb);
    INSERT INTO mediums
      (id, slug, name, phase, density, viscosity_model,
       constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity)
    VALUES ('${ids.medium}', 'operational-canary-test',
            'Operational canary test', 'gas', 1.225, 'constant', 1.789e-5,
            1.789e-5, 1.46e-5);
    INSERT INTO boundary_conditions (id, slug, name, medium_id, reynolds)
    VALUES ('${ids.bc}', 'operational-canary-test',
            'Operational canary test', '${ids.medium}', 100000);
  `);
  await setup.unsafe("SET session_replication_role = replica");
  await setup.unsafe(`
    INSERT INTO registered_remote_solvers
      (id, instance_id, instance_name, auth_token_hash, credential_version)
    VALUES ('${ids.remoteSolver}', 'operational-canary-fence',
            'Operational canary fence', '${"b".repeat(64)}', 1);
    INSERT INTO sync_sweep_promises
      (id, source_instance_id, airfoil_id, simulation_preset_revision_id,
       aoa_count, "expiresAt", request_payload)
    VALUES ('${ids.promise}', 'operational-canary-fence', '${ids.airfoil}',
            '${ids.revision}', 1, now() + interval '1 day',
            '{"solverId":"${ids.remoteSolver}"}'::jsonb);
    INSERT INTO sync_sweep_promise_points
      (id, promise_id, airfoil_id, simulation_preset_revision_id, aoa_deg)
    VALUES ('${ids.promisePoint}', '${ids.promise}', '${ids.airfoil}',
            '${ids.revision}', 3);
  `);
  await setup.unsafe("SET session_replication_role = origin");
}, 120_000);

afterEach(async () => {
  await setup!.begin(async (tx) => {
    await tx.unsafe("SET LOCAL session_replication_role = replica");
    await tx.unsafe("DELETE FROM solver_operational_canary_retention_receipts");
    await tx.unsafe("DELETE FROM solver_operational_canary_evidence_objects");
    await tx.unsafe("DELETE FROM solver_canary_object_cleanup_receipts");
    await tx.unsafe("DELETE FROM solver_canary_object_cleanup_reservations");
    await tx.unsafe("DELETE FROM sync_brokered_evidence_uploads");
    await tx.unsafe("DELETE FROM solver_evidence_artifacts");
    await tx.unsafe("DELETE FROM solver_evidence_blobs");
    await tx.unsafe("DELETE FROM result_attempts");
    await tx.unsafe("DELETE FROM results");
    await tx.unsafe("DELETE FROM sim_jobs");
    await tx.unsafe(
      "DELETE FROM solver_engine_canary_attestations WHERE attested_by = '0081-test'",
    );
  });
});

afterAll(async () => {
  await setup?.end({ timeout: 1 });
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end({ timeout: 1 });
  }
}, 120_000);

describe("0081 sealed operational cutover-canary evidence ownership", () => {
  it("migrates exactly the protected 16/11/byte inventory and makes it immutable", async () => {
    const [counts] = await setup!`
      SELECT count(*)::int AS objects,
             count(DISTINCT engine_job_id)::int AS jobs
      FROM solver_operational_canary_approved_inventory
      WHERE inventory_sha256 =
        ${OPERATIONAL_CANARY_APPROVED_INVENTORY_SHA256}
    `;
    expect(counts).toMatchObject({ objects: 16, jobs: 11 });
    expect(
      approvedInventory.objects.reduce(
        (total, row) => total + row.target.storedByteSize,
        0,
      ),
    ).toBe(216_240_757);
    await expect(
      setup!`
        UPDATE solver_operational_canary_approved_inventory
        SET row_seal_sha256 = row_seal_sha256
      `,
    ).rejects.toThrow(/audit rows are immutable/);
  });

  it("registers one exact row idempotently without aerodynamic ownership", async () => {
    const input = unattestedClaim();
    const first = await registerOperationalCanaryEvidence(database!, input);
    const second = await registerOperationalCanaryEvidence(database!, input);
    expect(second).toEqual(first);
    const [counts] = await setup!`
      SELECT
        (SELECT count(*)::int FROM solver_operational_canary_evidence_objects
         WHERE engine_job_id = ${input.job.id}
           AND evidence_path = ${input.evidence.path}) AS operational,
        (SELECT count(*)::int FROM sim_jobs
         WHERE engine_job_id = ${input.job.id}) AS sim_jobs,
        (SELECT count(*)::int FROM results
         WHERE engine_job_id = ${input.job.id}) AS results,
        (SELECT count(*)::int FROM result_attempts
         WHERE engine_job_id = ${input.job.id}) AS attempts
    `;
    expect(counts).toMatchObject({
      operational: 1,
      sim_jobs: 0,
      results: 0,
      attempts: 0,
    });
  });

  it("rejects a self-consistent row that widens the sealed membership", async () => {
    const input = unattestedClaim(1);
    const widened = {
      ...input,
      job: { ...input.job, id: "invented-cutover-canary" },
    };
    await expect(
      registerOperationalCanaryEvidence(database!, widened),
    ).rejects.toThrow(/outside or changes the sealed exact-16 inventory/);
  });

  it("does not let a tiny synthetic attestation masquerade under the production receipt hash", async () => {
    const input = approvedClaim(0);
    const production = approvedInventory.inputs.attestationReceipt;
    const synthetic = canonicalJson(attestationReceipt());
    const syntheticSha = sha256(synthetic);
    expect(Buffer.byteLength(synthetic)).not.toBe(
      production.retainedReceiptByteSize,
    );
    expect(syntheticSha).not.toBe(production.databaseReceiptSha256);
    expect(syntheticSha).not.toBe(production.retainedReceiptSha256);
    const r5 = approvedInventory.runtimeBuilds.find((row) =>
      row.buildId.endsWith("-r5"),
    );
    if (!r5) throw new Error("approved r5 runtime is absent");
    await setup!`
      INSERT INTO solver_engine_canary_attestations
        (id, solver_implementation_id, solver_runtime_build_id,
         solver_execution_pool_id, receipt_sha256, receipt, attested_by)
      VALUES (${production.attestationId}::uuid, ${implementation}::uuid,
              ${r5.id}::uuid, ${executionPool}::uuid, ${syntheticSha},
              ${synthetic}::jsonb, '0081-test')
    `;
    await expect(
      registerOperationalCanaryEvidence(database!, input),
    ).rejects.toThrow(/absent or ambiguous in its durable attestation/);
  });

  it("seals distinct production database and retained receipt identities", () => {
    const production = approvedInventory.inputs.attestationReceipt;
    expect(Object.keys(production).sort()).toEqual([
      "attestationId",
      "databaseReceiptSha256",
      "retainedReceiptByteSize",
      "retainedReceiptSha256",
    ]);
    expect(production).toEqual({
      attestationId: "112f52cd-eb8b-4908-bc79-6353daea6e12",
      databaseReceiptSha256:
        "f6d17988ea40e96c885df709357806a097daa19948d8b02efc6df25e035f6149",
      retainedReceiptSha256:
        "505819f2c745425071cc7900967abaead0911f30ab6af1636a8af92baf7276e8",
      retainedReceiptByteSize: 2_313_736,
    });
    expect(production.databaseReceiptSha256).toBe(
      OPERATIONAL_CANARY_DATABASE_ATTESTATION_RECEIPT_SHA256,
    );
    expect(production.databaseReceiptSha256).not.toBe(
      production.retainedReceiptSha256,
    );
  });

  it("rejects a valid row with the wrong canonical receipt digest", async () => {
    const input = unattestedClaim(2);
    const ack = await registerOperationalCanaryEvidence(database!, input);
    expect(canonicalJson(input)).toContain(input.job.id);
    await expect(
      setup!.unsafe(`
        INSERT INTO solver_operational_canary_evidence_objects (
          approved_inventory_sha256, provenance_kind, canary_attestation_id,
          solver_implementation_id, solver_runtime_build_id, engine_job_id,
          evidence_path, bucket, object_key, generation, stored_sha256,
          stored_byte_size, crc32c, tar_sha256, tar_byte_size, zstd_level,
          pointer_sha256, pointer_byte_size, manifest_sha256,
          manifest_byte_size, archive_member_set_sha256,
          archive_member_count, status_sha256, status_byte_size,
          source_build_sha256, source_build_byte_size,
          source_journal_sha256, source_journal_byte_size,
          operator_receipt_sha256, operator_receipt_byte_size,
          cutover_failure_phase, cutover_failure_exit_code,
          registration_receipt_sha256, registration_receipt_canonical,
          registration_receipt, registered_by
        ) SELECT
          approved_inventory_sha256, provenance_kind, canary_attestation_id,
          solver_implementation_id, solver_runtime_build_id, engine_job_id,
          evidence_path, bucket, object_key, generation, stored_sha256,
          stored_byte_size, crc32c, tar_sha256, tar_byte_size, zstd_level,
          pointer_sha256, pointer_byte_size, manifest_sha256,
          manifest_byte_size, archive_member_set_sha256,
          archive_member_count, status_sha256, status_byte_size,
          source_build_sha256, source_build_byte_size,
          source_journal_sha256, source_journal_byte_size,
          operator_receipt_sha256, operator_receipt_byte_size,
          cutover_failure_phase, cutover_failure_exit_code,
          '${"f".repeat(64)}', registration_receipt_canonical,
          registration_receipt, registered_by
        FROM solver_operational_canary_evidence_objects
        WHERE id = '${ack.ownershipId}'
      `),
    ).rejects.toThrow(/registration receipt does not match its exact row/);
  });

  it("reciprocally rejects every GCS owner after exact operational ownership", async () => {
    const input = unattestedClaim(3);
    await registerOperationalCanaryEvidence(database!, input);
    for (const [offset, kind] of (
      ["blob", "artifact", "cleanup", "broker"] as GcsOwnerKind[]
    ).entries()) {
      await expect(
        insertGcsOwner(setup!, kind, input, 1_000 + offset),
      ).rejects.toThrow(/immutable operational canary evidence/);
    }
  });

  it.each([
    ["blob", 15, 1_100],
    ["artifact", 10, 1_200],
    ["cleanup", 14, 1_300],
    ["broker", 7, 1_400],
  ] satisfies Array<[GcsOwnerKind, number, number]>)(
    "rejects operational registration when an exact %s owner already exists",
    async (kind, index, tag) => {
      const input = unattestedClaim(index);
      await insertGcsOwner(setup!, kind, input, tag);
      await expect(
        registerOperationalCanaryEvidence(database!, input),
      ).rejects.toThrow(/conflicts with existing ownership/);
    },
  );

  it.each([
    ["blob", 1, 2_100],
    ["artifact", 3, 2_200],
    ["cleanup", 6, 2_300],
    ["broker", 5, 2_400],
  ] satisfies Array<[GcsOwnerKind, number, number]>)(
    "serializes operational registration first and rejects delayed %s ownership",
    async (kind, index, tag) => {
      const input = unattestedClaim(index);
      const ownerSql = postgres(targetUrl.toString(), { max: 1 });
      const gcsSql = postgres(targetUrl.toString(), { max: 1 });
      const ownerDb = drizzle(ownerSql, { schema }) as unknown as DB;
      let releaseOwner!: () => void;
      const ownerHold = new Promise<void>(
        (resolve) => (releaseOwner = resolve),
      );
      let ownerInserted!: () => void;
      const ownerReady = new Promise<void>(
        (resolve) => (ownerInserted = resolve),
      );
      try {
        const ownerTx = ownerDb.transaction(async (rawTx) => {
          await registerOperationalCanaryEvidence(
            rawTx as unknown as DB,
            input,
          );
          ownerInserted();
          await ownerHold;
        });
        await ownerReady;
        let gcsSettled = false;
        const gcsAttempt = insertGcsOwner(gcsSql, kind, input, tag).finally(
          () => {
            gcsSettled = true;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (gcsSettled) {
          releaseOwner();
          await ownerTx;
          const [outcome] = await Promise.allSettled([gcsAttempt]);
          throw new Error(
            `GCS owner settled before lock release: ${String(
              outcome.status === "rejected" ? outcome.reason : outcome.value,
            )}`,
          );
        }
        releaseOwner();
        await ownerTx;
        await expect(gcsAttempt).rejects.toThrow(
          /immutable operational canary evidence/,
        );
      } finally {
        await ownerSql.end({ timeout: 1 });
        await gcsSql.end({ timeout: 1 });
      }
    },
  );

  it.each([
    ["blob", 2, 3_100],
    ["artifact", 4, 3_200],
    ["cleanup", 13, 3_300],
    ["broker", 11, 3_400],
  ] satisfies Array<[GcsOwnerKind, number, number]>)(
    "serializes %s ownership first and registers only after its rollback",
    async (kind, index, tag) => {
      const input = unattestedClaim(index);
      const gcsSql = postgres(targetUrl.toString(), { max: 1 });
      const ownerSql = postgres(targetUrl.toString(), { max: 1 });
      const ownerDb = drizzle(ownerSql, { schema }) as unknown as DB;
      const cleanupAttestationId =
        kind === "cleanup"
          ? await insertHonestTestAttestation(setup!, input, tag)
          : undefined;
      let releaseGcs!: () => void;
      const gcsHold = new Promise<void>((resolve) => (releaseGcs = resolve));
      let gcsInserted!: () => void;
      const gcsReady = new Promise<void>((resolve) => (gcsInserted = resolve));
      try {
        const gcsTx = gcsSql.begin(async (tx) => {
          await insertGcsOwner(tx, kind, input, tag, cleanupAttestationId);
          gcsInserted();
          await gcsHold;
          throw new Error("rollback exact GCS-owner race fixture");
        });
        await gcsReady;
        let registrationSettled = false;
        const registration = registerOperationalCanaryEvidence(
          ownerDb,
          input,
        ).finally(() => {
          registrationSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (registrationSettled) {
          releaseGcs();
          await expect(gcsTx).rejects.toThrow(
            /rollback exact GCS-owner race fixture/,
          );
          const [outcome] = await Promise.allSettled([registration]);
          throw new Error(
            `registration settled before lock release: ${String(
              outcome.status === "rejected" ? outcome.reason : outcome.value,
            )}`,
          );
        }
        releaseGcs();
        await expect(gcsTx).rejects.toThrow(
          /rollback exact GCS-owner race fixture/,
        );
        await expect(registration).resolves.toMatchObject({
          engineJobId: input.job.id,
          evidencePath: input.evidence.path,
          state: "operational_canary_owned",
        });
      } finally {
        await gcsSql.end({ timeout: 1 });
        await ownerSql.end({ timeout: 1 });
      }
    },
  );

  it("reciprocally rejects every engine-job owner after operational ownership", async () => {
    const input = unattestedClaim();
    await registerOperationalCanaryEvidence(database!, input);
    for (const [offset, kind] of (
      ["sim_job", "result", "attempt", "artifact_job"] as EngineJobOwnerKind[]
    ).entries()) {
      await expect(
        insertEngineJobOwner(setup!, kind, input, 20_000 + offset),
      ).rejects.toThrow(/immutable operational canary evidence/);
    }
  });

  it.each([
    "sim_job",
    "result",
    "attempt",
    "artifact_job",
  ] satisfies EngineJobOwnerKind[])(
    "rejects operational registration when an exact %s engine-job owner already exists",
    async (kind) => {
      const input = unattestedClaim();
      await insertEngineJobOwner(setup!, kind, input, 21_000);
      await expect(
        registerOperationalCanaryEvidence(database!, input),
      ).rejects.toThrow(/conflicts with existing ownership/);
    },
  );

  it.each([
    "sim_job",
    "result",
    "attempt",
    "artifact_job",
  ] satisfies EngineJobOwnerKind[])(
    "serializes operational registration first and rejects delayed %s engine-job ownership",
    async (kind) => {
      const input = unattestedClaim();
      const operationalSql = postgres(targetUrl.toString(), { max: 1 });
      const engineSql = postgres(targetUrl.toString(), { max: 1 });
      const operationalDb = drizzle(operationalSql, {
        schema,
      }) as unknown as DB;
      let releaseOperational!: () => void;
      const operationalHold = new Promise<void>(
        (resolve) => (releaseOperational = resolve),
      );
      let operationalInserted!: () => void;
      const operationalReady = new Promise<void>(
        (resolve) => (operationalInserted = resolve),
      );
      try {
        const operationalTx = operationalDb.transaction(async (rawTx) => {
          await registerOperationalCanaryEvidence(
            rawTx as unknown as DB,
            input,
          );
          operationalInserted();
          await operationalHold;
        });
        await operationalReady;
        let engineSettled = false;
        const engineAttempt = insertEngineJobOwner(
          engineSql,
          kind,
          input,
          22_000,
        ).finally(() => {
          engineSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (engineSettled) {
          releaseOperational();
          await operationalTx;
          const [outcome] = await Promise.allSettled([engineAttempt]);
          throw new Error(
            `engine-job owner settled before lock release: ${String(
              outcome.status === "rejected" ? outcome.reason : outcome.value,
            )}`,
          );
        }
        releaseOperational();
        await operationalTx;
        await expect(engineAttempt).rejects.toThrow(
          /immutable operational canary evidence/,
        );
      } finally {
        await operationalSql.end({ timeout: 1 });
        await engineSql.end({ timeout: 1 });
      }
    },
  );

  it.each([
    "sim_job",
    "result",
    "attempt",
    "artifact_job",
  ] satisfies EngineJobOwnerKind[])(
    "serializes %s engine-job ownership first and registers only after rollback",
    async (kind) => {
      const input = unattestedClaim();
      const engineSql = postgres(targetUrl.toString(), { max: 1 });
      const operationalSql = postgres(targetUrl.toString(), { max: 1 });
      const operationalDb = drizzle(operationalSql, {
        schema,
      }) as unknown as DB;
      let releaseEngine!: () => void;
      const engineHold = new Promise<void>(
        (resolve) => (releaseEngine = resolve),
      );
      let engineInserted!: () => void;
      const engineReady = new Promise<void>(
        (resolve) => (engineInserted = resolve),
      );
      try {
        const engineTx = engineSql.begin(async (tx) => {
          await insertEngineJobOwner(tx, kind, input, 23_000);
          engineInserted();
          await engineHold;
          throw new Error("rollback exact engine-job owner race fixture");
        });
        await engineReady;
        let registrationSettled = false;
        const registration = registerOperationalCanaryEvidence(
          operationalDb,
          input,
        ).finally(() => {
          registrationSettled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (registrationSettled) {
          releaseEngine();
          await expect(engineTx).rejects.toThrow(
            /rollback exact engine-job owner race fixture/,
          );
          const [outcome] = await Promise.allSettled([registration]);
          throw new Error(
            `registration settled before engine-job lock release: ${String(
              outcome.status === "rejected" ? outcome.reason : outcome.value,
            )}`,
          );
        }
        releaseEngine();
        await expect(engineTx).rejects.toThrow(
          /rollback exact engine-job owner race fixture/,
        );
        await expect(registration).resolves.toMatchObject({
          engineJobId: input.job.id,
          evidencePath: input.evidence.path,
          state: "operational_canary_owned",
        });
      } finally {
        await engineSql.end({ timeout: 1 });
        await operationalSql.end({ timeout: 1 });
      }
    },
  );

  it("validates and idempotently acknowledges one exact retention receipt", async () => {
    const input = unattestedClaim();
    const ownership = await registerOperationalCanaryEvidence(database!, input);
    const exact = retentionReceipt(input, ownership);
    const wrongRegistration = {
      ...exact,
      registrationReceiptSha256: "f".repeat(64),
    };
    await expect(
      acknowledgeOperationalCanaryRetention(database!, wrongRegistration),
    ).rejects.toThrow(/does not match its exact immutable ownership/);
    const wrongCount = input.evidence.archiveMemberCount;
    const wrongMembers = {
      ...exact,
      verifiedMemberCount: wrongCount,
      verificationMode: `archive+manifest+all-members-restore:${wrongCount}`,
    };
    await expect(
      acknowledgeOperationalCanaryRetention(database!, wrongMembers),
    ).rejects.toThrow(/does not match its exact immutable ownership/);

    const first = await acknowledgeOperationalCanaryRetention(database!, exact);
    const replay = await acknowledgeOperationalCanaryRetention(
      database!,
      exact,
    );
    expect(replay).toEqual(first);
    await expect(
      acknowledgeOperationalCanaryRetention(database!, {
        ...exact,
        verifiedAt: "2026-07-18T19:01:00.000Z",
      }),
    ).rejects.toThrow(/conflicts with the exact acknowledgement/);
  });

  it("makes an acknowledged retention receipt immutable", async () => {
    const input = unattestedClaim();
    const ownership = await registerOperationalCanaryEvidence(database!, input);
    await acknowledgeOperationalCanaryRetention(
      database!,
      retentionReceipt(input, ownership),
    );
    await expect(
      setup!`UPDATE solver_operational_canary_retention_receipts
             SET bytes_deleted = bytes_deleted`,
    ).rejects.toThrow(/audit rows are immutable/);
    await expect(
      setup!`DELETE FROM solver_operational_canary_retention_receipts`,
    ).rejects.toThrow(/audit rows are immutable/);
  });
});
