import {
  airfoils,
  categories,
  createClient,
  type DB,
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
  solverCanaryObjectCleanupReceipts,
  solverCanaryObjectCleanupReservations,
  solverEngineCanaryAttestations,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  solverRuntimeBuilds,
} from "@aerodb/db";
import { eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  acknowledgeCanaryEvidenceCleanup,
  canaryCleanupTargets,
  canonicalJson,
  planCanaryEvidenceCleanup,
  reserveCanaryEvidenceCleanup,
  type CanaryCleanupReceipt,
  type CanaryCleanupTarget,
} from "../src/canary-evidence-cleanup";

const { db, sql } = createClient({ max: 4 });
const ROLLBACK = new Error("rollback canary cleanup fixture");
const PREFIX = `canary-cleanup-${process.pid}-${Date.now().toString(36)}`;

interface Fixture {
  attestationId: string;
  airfoilId: string;
  target: CanaryCleanupTarget;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function receipt(target: CanaryCleanupTarget) {
  const storage = {
    backend: "gcs",
    bucket: target.bucket,
    object_key: target.objectKey,
    generation: target.generation,
    stored_sha256: target.sha256,
    stored_byte_size: target.byteSize,
    crc32c: target.crc32c,
  };
  return {
    schema_version: 1,
    status: "ok",
    engine: {
      family: "openfoam",
      distribution: "opencfd",
      version: "2606",
    },
    evidence_storage: {
      backend: "gcs",
      bucket: target.bucket,
      object_prefix: "solver-evidence/v1",
      archive_format: "tar+zstd",
      compression: "zstd",
      local_disposition: "remote-only",
    },
    jobs: [
      {
        points: [
          {
            artifacts: [
              {
                kind: "engine_bundle",
                sha256: target.sha256,
                byte_size: target.byteSize,
                storage,
              },
              {
                kind: "manifest",
                sha256: "f".repeat(64),
                byte_size: 83,
                storage,
              },
            ],
          },
        ],
      },
    ],
  };
}

async function fixture(testDb: DB, options: { wrongDigest?: boolean } = {}): Promise<Fixture> {
  const token = `${PREFIX}-${randomUUID().slice(0, 8)}`;
  const digest = sha256(token);
  const target: CanaryCleanupTarget = {
    bucket: "airfoils-pro-storage-bucket",
    objectKey: `solver-evidence/v1/sha256/${digest.slice(0, 2)}/${digest}.tar.zst`,
    generation: "18446744073709551615",
    sha256: digest,
    byteSize: 456_789,
    crc32c: "AAAAAA==",
  };
  const [runtime] = await testDb
    .insert(solverRuntimeBuilds)
    .values({
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      provenanceKey: sha256(`${token}:provenance`),
      buildId: `${token}-build`,
      applicationSourceSha256: sha256(`${token}:source`),
    })
    .returning({ id: solverRuntimeBuilds.id });
  const value = receipt(target);
  const [attestation] = await testDb
    .insert(solverEngineCanaryAttestations)
    .values({
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      solverRuntimeBuildId: runtime.id,
      solverExecutionPoolId: OPENCFD_2606_EXECUTION_POOL_ID,
      receiptSha256: options.wrongDigest
        ? "0".repeat(64)
        : sha256(canonicalJson(value)),
      receipt: value,
      attestedBy: `${token}@example.test`,
    })
    .returning({ id: solverEngineCanaryAttestations.id });
  const [category] = await testDb
    .insert(categories)
    .values({
      slug: `${token}-category`,
      name: `${token} category`,
      path: `${token}-category`,
      depth: 0,
    })
    .returning({ id: categories.id });
  const [airfoil] = await testDb
    .insert(airfoils)
    .values({
      slug: `${token}-foil`,
      name: `${token} foil`,
      categoryId: category.id,
      points: [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
    })
    .returning({ id: airfoils.id });
  return { attestationId: attestation.id, airfoilId: airfoil.id, target };
}

async function withRollback(run: (testDb: DB) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (rawTx) => {
      await run(rawTx as unknown as DB);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

function cleanupReceipt(
  reservationId: string,
  attestationId: string,
  target: CanaryCleanupTarget,
): CanaryCleanupReceipt {
  return {
    schemaVersion: 1,
    kind: "opencfd2606-canary-gcs-cleanup-receipt",
    reservationId,
    attestationId,
    target,
    preDeleteObservation: { status: "present", ...target },
    postDeleteObservation: { status: "absent" },
    outcome: "deleted",
    deletedAt: "2026-07-18T18:30:00.000Z",
    operator: "operator@example.test",
  };
}

describe("attestation-backed canary GCS cleanup", () => {
  it("plans without mutation, reserves exact zero-owner objects, and stores an immutable idempotent receipt", async () => {
    await withRollback(async (testDb) => {
      const created = await fixture(testDb);
      expect(await planCanaryEvidenceCleanup(testDb, created.attestationId)).toEqual([
        expect.objectContaining({ status: "eligible", target: created.target }),
      ]);
      const [reservation] = await reserveCanaryEvidenceCleanup(
        testDb,
        created.attestationId,
        "operator@example.test",
      );
      expect(reservation.target).toEqual(created.target);
      expect(reservation.ownershipAtReservation).toEqual({
        blobCount: 0,
        artifactCount: 0,
        archiveCount: 0,
        orphanQuarantineCount: 0,
        incompleteQuarantineCount: 0,
      });
      expect(await planCanaryEvidenceCleanup(testDb, created.attestationId)).toEqual([
        expect.objectContaining({
          status: "reserved",
          reservationId: reservation.reservationId,
        }),
      ]);
      const ack = cleanupReceipt(
        reservation.reservationId,
        created.attestationId,
        created.target,
      );
      const first = await acknowledgeCanaryEvidenceCleanup(testDb, ack);
      const replay = await acknowledgeCanaryEvidenceCleanup(testDb, ack);
      expect(first.replayed).toBe(false);
      expect(replay).toEqual({ ...first, replayed: true });
      expect(await planCanaryEvidenceCleanup(testDb, created.attestationId)).toEqual([
        expect.objectContaining({ status: "complete", receiptId: first.id }),
      ]);
    });
  });

  it("blocks both physical-blob and pending-artifact ownership before reservation", async () => {
    await withRollback(async (testDb) => {
      const created = await fixture(testDb);
      await testDb.insert(solverEvidenceBlobs).values({
        backend: "gcs",
        bucket: created.target.bucket,
        objectKey: created.target.objectKey,
        generation: created.target.generation,
        compression: "zstd",
        mimeType: "application/zstd",
        sha256: created.target.sha256,
        byteSize: created.target.byteSize,
        crc32c: created.target.crc32c,
        uncompressedTarSha256: "b".repeat(64),
        uncompressedTarByteSize: 900_000,
        verifiedAt: new Date(),
      });
      const [plan] = await planCanaryEvidenceCleanup(testDb, created.attestationId);
      expect(plan.status).toBe("owned");
      expect(plan.ownership.blobCount).toBe(1);
      await expect(
        reserveCanaryEvidenceCleanup(
          testDb,
          created.attestationId,
          "operator@example.test",
        ),
      ).rejects.toThrow(/database ownership/);
    });

    await withRollback(async (testDb) => {
      const created = await fixture(testDb);
      await testDb.insert(solverEvidenceArtifacts).values({
        airfoilId: created.airfoilId,
        kind: "engine_bundle",
        storageKey: created.target.objectKey,
        mimeType: "application/zstd",
        sha256: created.target.sha256,
        byteSize: created.target.byteSize,
        metadata: {
          storageBackend: "gcs",
          bucket: created.target.bucket,
          objectKey: created.target.objectKey,
          generation: created.target.generation,
        },
      });
      const [plan] = await planCanaryEvidenceCleanup(testDb, created.attestationId);
      expect(plan.status).toBe("owned");
      expect(plan.ownership.artifactCount).toBe(1);
      await expect(
        reserveCanaryEvidenceCleanup(
          testDb,
          created.attestationId,
          "operator@example.test",
        ),
      ).rejects.toThrow(/database ownership/);
    });
  });

  it("permanently fences a reserved generation from later canonical or pending ownership", async () => {
    await expect(
      db.transaction(async (rawTx) => {
        const testDb = rawTx as unknown as DB;
        const created = await fixture(testDb);
        await reserveCanaryEvidenceCleanup(
          testDb,
          created.attestationId,
          "operator@example.test",
        );
        await testDb.insert(solverEvidenceBlobs).values({
          backend: "gcs",
          bucket: created.target.bucket,
          objectKey: created.target.objectKey,
          generation: created.target.generation,
          compression: "zstd",
          mimeType: "application/zstd",
          sha256: created.target.sha256,
          byteSize: created.target.byteSize,
          crc32c: created.target.crc32c,
          uncompressedTarSha256: "c".repeat(64),
          uncompressedTarByteSize: 900_000,
          verifiedAt: new Date(),
        });
      }),
    ).rejects.toThrow(/permanently reserved/);

    for (const metadataShape of ["top-level", "nested"] as const) {
      await expect(
        db.transaction(async (rawTx) => {
          const testDb = rawTx as unknown as DB;
          const created = await fixture(testDb);
          await reserveCanaryEvidenceCleanup(
            testDb,
            created.attestationId,
            "operator@example.test",
          );
          const metadata =
            metadataShape === "top-level"
              ? {
                  storageBackend: "gcs",
                  bucket: created.target.bucket,
                  objectKey: created.target.objectKey,
                  generation: created.target.generation,
                }
              : {
                  storage: {
                    backend: "gcs",
                    bucket: created.target.bucket,
                    object_key: created.target.objectKey,
                    generation: created.target.generation,
                  },
                };
          await testDb.insert(solverEvidenceArtifacts).values({
            airfoilId: created.airfoilId,
            kind: "engine_bundle",
            storageKey: created.target.objectKey,
            mimeType: "application/zstd",
            sha256: created.target.sha256,
            byteSize: created.target.byteSize,
            metadata,
          });
        }),
      ).rejects.toThrow(/permanently reserved/);
    }

    await expect(
      db.transaction(async (rawTx) => {
        const testDb = rawTx as unknown as DB;
        const created = await fixture(testDb);
        await reserveCanaryEvidenceCleanup(
          testDb,
          created.attestationId,
          "operator@example.test",
        );
        await testDb.insert(solverEvidenceArtifacts).values({
          airfoilId: created.airfoilId,
          kind: "engine_bundle",
          storageKey: created.target.objectKey,
          mimeType: "application/zstd",
          sha256: created.target.sha256,
          byteSize: created.target.byteSize,
          metadata: {
            storageBackend: "gcs",
            bucket: "different-bucket",
            objectKey: `different/${created.target.sha256}.tar.zst`,
            generation: "123",
            storage: {
              backend: "gcs",
              bucket: created.target.bucket,
              object_key: created.target.objectKey,
              generation: created.target.generation,
            },
          },
        });
      }),
    ).rejects.toThrow(/conflicting dual GCS storage identities/);
  });

  it("uses the shared advisory identity lock on the ownership side of a live race", async () => {
    const token = `${PREFIX}-${randomUUID()}`;
    const target = {
      bucket: "airfoils-pro-storage-bucket",
      objectKey: `solver-evidence/v1/sha256/${token.slice(0, 2)}/${sha256(token)}.tar.zst`,
      generation: "987654321",
    };
    let release!: () => void;
    let locked!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const acquired = new Promise<void>((resolve) => (locked = resolve));
    const first = sql.begin(async (tx) => {
      await tx`SELECT lock_solver_canary_cleanup_identity(
        ${target.bucket}, ${target.objectKey}, ${target.generation}
      )`;
      locked();
      await hold;
      throw ROLLBACK;
    });
    await acquired;
    let secondSettled = false;
    const second = sql
      .begin(async (tx) => {
        await tx`INSERT INTO solver_evidence_blobs (
          backend, bucket, object_key, generation, compression, mime_type,
          sha256, byte_size, crc32c, uncompressed_tar_sha256,
          uncompressed_tar_byte_size, "verifiedAt"
        ) VALUES (
          'gcs', ${target.bucket}, ${target.objectKey}, ${target.generation},
          'zstd', 'application/zstd', ${sha256(token)}, 10, 'AAAAAA==',
          ${"d".repeat(64)}, 20, now()
        )`;
        throw ROLLBACK;
      })
      .catch((error) => error)
      .finally(() => {
        secondSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondSettled).toBe(false);
    release();
    await expect(first).rejects.toBe(ROLLBACK);
    expect(await second).toBe(ROLLBACK);
  });

  it("rejects attestation digest drift, target mismatch, and wrong JSON types", async () => {
    await withRollback(async (testDb) => {
      const created = await fixture(testDb, { wrongDigest: true });
      await expect(
        planCanaryEvidenceCleanup(testDb, created.attestationId),
      ).rejects.toThrow(/digest does not match/);
    });
    const target: CanaryCleanupTarget = {
      bucket: "airfoils-pro-storage-bucket",
      objectKey: `solver-evidence/v1/sha256/${"a".repeat(2)}/${"a".repeat(64)}.tar.zst`,
      generation: "123",
      sha256: "a".repeat(64),
      byteSize: 10,
      crc32c: "AAAAAA==",
    };
    const wrongType = receipt(target) as unknown as Record<string, unknown>;
    const jobs = wrongType.jobs as Array<Record<string, unknown>>;
    const points = jobs[0]!.points as Array<Record<string, unknown>>;
    const artifacts = points[0]!.artifacts as Array<Record<string, unknown>>;
    (artifacts[0]!.storage as Record<string, unknown>).stored_byte_size = "10";
    expect(() => canaryCleanupTargets(wrongType)).toThrow(/positive safe integer/);
    const mismatch = receipt(target);
    mismatch.jobs[0]!.points[0]!.artifacts[0]!.storage.object_key =
      `solver-evidence/v1/sha256/aa/${"b".repeat(64)}.tar.zst`;
    expect(() => canaryCleanupTargets(mismatch)).toThrow(/differs/);
  });

  it("keeps reservation and completion rows immutable", async () => {
    await expect(
      db.transaction(async (rawTx) => {
        const testDb = rawTx as unknown as DB;
        const created = await fixture(testDb);
        const [reservation] = await reserveCanaryEvidenceCleanup(
          testDb,
          created.attestationId,
          "operator@example.test",
        );
        await acknowledgeCanaryEvidenceCleanup(
          testDb,
          cleanupReceipt(
            reservation.reservationId,
            created.attestationId,
            created.target,
          ),
        );
        await testDb
          .update(solverCanaryObjectCleanupReceipts)
          .set({ executedBy: "changed@example.test" })
          .where(
            eq(
              solverCanaryObjectCleanupReceipts.cleanupReservationId,
              reservation.reservationId,
            ),
          );
        await testDb
          .delete(solverCanaryObjectCleanupReservations)
          .where(
            eq(
              solverCanaryObjectCleanupReservations.id,
              reservation.reservationId,
            ),
          );
      }),
    ).rejects.toThrow(/immutable/);
  });
});
