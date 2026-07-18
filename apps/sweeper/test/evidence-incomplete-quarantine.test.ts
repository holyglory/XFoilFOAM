import {
  airfoils,
  boundaryConditions,
  categories,
  createClient,
  type DB,
  mediums,
  resultAttempts,
  results,
  simJobs,
  solverEvidenceArchives,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  solverEvidenceIncompleteQuarantines,
  solverEvidenceOrphanQuarantines,
} from "@aerodb/db";
import { count, eq } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  INCOMPLETE_DATABASE_ACK_NAME,
  INCOMPLETE_PACKAGE_MANIFEST_NAME,
  INCOMPLETE_POINTER_NAME,
  INCOMPLETE_RECEIPT_NAME,
  incompleteMemberSetSha256,
  registerIncompleteEvidenceQuarantine,
} from "../src/evidence-incomplete-quarantine";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `incomplete-evidence-${process.pid}-${Date.now().toString(36)}`;
const BUCKET = "airfoils-pro-storage-bucket";
const ROLLBACK = new Error("rollback incomplete evidence fixture");
const roots: string[] = [];
const originalBucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET;

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

interface Fixture {
  mediaRoot: string;
  receiptPath: string;
  engineJobId: string;
  engineCaseSlug: string;
  evidencePath: string;
  airfoilId: string;
  bcId: string;
  simJobId: string;
  siblingResultId: string;
}

type RecoveryShape = "mixed" | "all-missing" | "all-retained";

async function createFixture(
  testDb: DB,
  recoveryShape: RecoveryShape = "mixed",
): Promise<Fixture> {
  const token = `${PREFIX}-${randomUUID().slice(0, 8)}`;
  const [medium] = await testDb
    .insert(mediums)
    .values({
      slug: `${token}-air`,
      name: `${token} air`,
      phase: "gas",
      density: 1.225,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.789e-5,
      dynamicViscosity: 1.789e-5,
      kinematicViscosity: 1.46e-5,
      speedOfSound: 340.3,
    })
    .returning();
  const [category] = await testDb
    .insert(categories)
    .values({
      slug: `${token}-category`,
      name: `${token} category`,
      path: `${token}-category`,
      depth: 0,
    })
    .returning();
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
    .returning();
  const [bc] = await testDb
    .insert(boundaryConditions)
    .values({
      slug: `${token}-bc`,
      name: `${token} condition`,
      mediumId: medium.id,
      reynolds: 102_000,
      referenceChordM: 0.05,
      speedMps: 30,
    })
    .returning();
  const engineJobId = `${token}-engine`;
  const caseSlug = "c0p05_u30";
  const evidencePath = `cases/${caseSlug}/a19/evidence`;
  const [job] = await testDb
    .insert(simJobs)
    .values({
      airfoilId: airfoil.id,
      bcIds: [bc.id],
      referenceChordM: 0.05,
      status: "cancelled",
      engineJobId,
      totalCases: 26,
      completedCases: 19,
      finishedAt: new Date(),
    })
    .returning();
  // A sibling angle under the same outer engine case is allowed. The partial
  // package has no AoA/result ownership and is fenced by its exact path.
  const [siblingResult] = await testDb
    .insert(results)
    .values({
      airfoilId: airfoil.id,
      bcId: bc.id,
      aoaDeg: 13,
      status: "done",
      source: "solved",
      regime: "rans",
      simJobId: job.id,
      engineJobId,
      engineCaseSlug: caseSlug,
      converged: true,
      solvedAt: new Date(),
    })
    .returning();

  const localBytes = Buffer.from(`${token}:local-vtk`);
  const siblingBytes = Buffer.from(`${token}:sibling-openfoam`);
  const missingSha = sha256(`${token}:missing`);
  const excludedBytes = Buffer.from(`${token}:excluded-frame`);
  const originalManifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      bundleExcludes: ["frames"],
      files: [
        { path: "VTK/value.vtu", sha256: sha256(localBytes), byteSize: localBytes.length },
        {
          path: "openfoam/system/controlDict",
          sha256: sha256(siblingBytes),
          byteSize: siblingBytes.length,
        },
        { path: "openfoam/logs/log.a19", sha256: missingSha, byteSize: 91 },
        {
          path: "frames/excluded.png",
          sha256: sha256(excludedBytes),
          byteSize: excludedBytes.length,
        },
      ],
    }),
  );
  const expectedMembers = [
    { path: "VTK/value.vtu", sha256: sha256(localBytes), byteSize: localBytes.length },
    {
      path: "openfoam/logs/log.a19",
      sha256: missingSha,
      byteSize: 91,
    },
    {
      path: "openfoam/system/controlDict",
      sha256: sha256(siblingBytes),
      byteSize: siblingBytes.length,
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const corruptBytes = Buffer.from(`${token}:exact-truncated-gzip-bytes`);
  const quarantineMetadata = Buffer.from(
    JSON.stringify({ preservationKind: "incomplete_evidence_quarantine" }),
  );
  const retainedCandidates = expectedMembers.map((member) => ({
    ...member,
    packagePath: `retained/${member.path}`,
    sources:
      member.path === "openfoam/system/controlDict"
        ? [
            {
              kind: "sibling_archive_member" as const,
              sourceArchiveSha256: sha256(`${token}:sibling-archive`),
              memberPath: member.path,
            },
          ]
        : [{ kind: "local_raw" as const, sourcePath: member.path }],
  }));
  const retainedMembers =
    recoveryShape === "all-missing"
      ? []
      : recoveryShape === "all-retained"
        ? retainedCandidates
        : retainedCandidates.filter(
            (member) => member.path !== "openfoam/logs/log.a19",
          );
  const retainedPaths = new Set(retainedMembers.map((member) => member.path));
  const missingMembers = expectedMembers.filter(
    (member) => !retainedPaths.has(member.path),
  );
  const packageMembers = [
    {
      path: "metadata/quarantine_manifest.json",
      sha256: sha256(quarantineMetadata),
      byteSize: quarantineMetadata.length,
    },
    {
      path: "original/evidence_manifest.json",
      sha256: sha256(originalManifestBytes),
      byteSize: originalManifestBytes.length,
    },
    {
      path: "original/openfoam_evidence.tar.gz",
      sha256: sha256(corruptBytes),
      byteSize: corruptBytes.length,
    },
    ...retainedMembers.map(({ packagePath: path, sha256, byteSize }) => ({
      path,
      sha256,
      byteSize,
    })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  const packageManifestBytes = Buffer.from(
    JSON.stringify({ schemaVersion: 1, bundleExcludes: [], files: packageMembers }),
  );
  const storedSha = sha256(`${token}:partial-zstd`);
  const tarSha = sha256(`${token}:partial-tar`);
  const remote = {
    schemaVersion: 1,
    format: "tar+zstd",
    bucket: BUCKET,
    objectKey: `solver-evidence-partial/v1/sha256/${storedSha.slice(0, 2)}/${storedSha}.tar.zst`,
    generation: "18446744073709551615",
    storedSha256: storedSha,
    storedSize: 330_001,
    tarSha256: tarSha,
    tarSize: 990_001,
    crc32c: "AAAAAA==",
    zstdLevel: 10,
    createdAt: "2026-07-18T13:00:00.000Z",
  };
  const receipt = {
    schemaVersion: 1,
    state: "awaiting_database_registration",
    preservationKind: "incomplete_evidence_quarantine",
    jobId: engineJobId,
    evidencePath,
    archive: {
      path: "incomplete_evidence_quarantine.tar.zst",
      storedSha256: storedSha,
      storedByteSize: remote.storedSize,
      uncompressedTarSha256: tarSha,
      uncompressedTarByteSize: remote.tarSize,
      zstdLevel: 10,
    },
    remote,
    originalManifest: {
      path: "evidence_manifest.json",
      packagePath: "original/evidence_manifest.json",
      sha256: sha256(originalManifestBytes),
      byteSize: originalManifestBytes.length,
      memberSetSha256: incompleteMemberSetSha256(expectedMembers),
      memberCount: expectedMembers.length,
    },
    packageManifest: {
      path: INCOMPLETE_PACKAGE_MANIFEST_NAME,
      sha256: sha256(packageManifestBytes),
      byteSize: packageManifestBytes.length,
      memberSetSha256: incompleteMemberSetSha256(packageMembers),
      memberCount: packageMembers.length,
    },
    expectedMembers,
    retainedMembers,
    missingMembers,
    packageMembers,
    sourceArchives: [
      {
        role: "corrupt_original",
        jobId: engineJobId,
        evidencePath,
        path: "openfoam_evidence.tar.gz",
        compression: "gzip",
        sha256: sha256(corruptBytes),
        byteSize: corruptBytes.length,
        integrity: "truncated",
        packagePath: "original/openfoam_evidence.tar.gz",
        readableTarByteSize: 67_108_864,
        terminalError: "Compressed file ended before the end-of-stream marker",
      },
      {
        role: "recovery_sibling",
        jobId: engineJobId,
        evidencePath: `cases/${caseSlug}/a18/evidence`,
        path: "openfoam_evidence.tar.gz",
        compression: "gzip",
        sha256: sha256(`${token}:sibling-archive`),
        byteSize: 401_000,
        integrity: "verified_complete",
        uncompressedTarSha256: sha256(`${token}:sibling-tar`),
        uncompressedTarByteSize: 900_000,
      },
    ],
    verificationMode: `archive+manifest+all-members-restore:${packageMembers.length}`,
    verifiedAt: "2026-07-18T13:05:00.000Z",
  };

  const mediaRoot = await mkdtemp(join(tmpdir(), "incomplete-evidence-"));
  roots.push(mediaRoot);
  const evidenceDir = join(mediaRoot, "jobs", engineJobId, evidencePath);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "evidence_manifest.json"), originalManifestBytes);
  await writeFile(
    join(evidenceDir, INCOMPLETE_PACKAGE_MANIFEST_NAME),
    packageManifestBytes,
  );
  await writeFile(
    join(evidenceDir, INCOMPLETE_POINTER_NAME),
    JSON.stringify(remote),
  );
  const receiptPath = join(evidenceDir, INCOMPLETE_RECEIPT_NAME);
  await writeFile(receiptPath, JSON.stringify(receipt));
  return {
    mediaRoot,
    receiptPath,
    engineJobId,
    engineCaseSlug: caseSlug,
    evidencePath,
    airfoilId: airfoil.id,
    bcId: bc.id,
    simJobId: job.id,
    siblingResultId: siblingResult.id,
  };
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

async function ownershipCounts(testDb: DB) {
  const [[resultRows], [attemptRows], [artifactRows], [archiveRows]] =
    await Promise.all([
      testDb.select({ value: count() }).from(results),
      testDb.select({ value: count() }).from(resultAttempts),
      testDb.select({ value: count() }).from(solverEvidenceArtifacts),
      testDb.select({ value: count() }).from(solverEvidenceArchives),
    ]);
  return {
    results: resultRows!.value,
    attempts: attemptRows!.value,
    artifacts: artifactRows!.value,
    archives: archiveRows!.value,
  };
}

async function createEvidenceBlob(testDb: DB, label: string) {
  const storedSha = sha256(`${label}:stored`);
  const tarSha = sha256(`${label}:tar`);
  const [blob] = await testDb
    .insert(solverEvidenceBlobs)
    .values({
      backend: "gcs",
      bucket: BUCKET,
      objectKey: `solver-evidence/v1/sha256/${storedSha.slice(0, 2)}/${storedSha}.tar.zst`,
      generation: "123456789",
      compression: "zstd",
      mimeType: "application/zstd",
      sha256: storedSha,
      byteSize: 4_096,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: tarSha,
      uncompressedTarByteSize: 16_384,
      verifiedAt: new Date("2026-07-18T13:05:00.000Z"),
      metadata: {},
    })
    .returning();
  return blob!;
}

async function createUnboundBundleArtifact(
  testDb: DB,
  fixture: Fixture,
  opts: {
    storageKey: string;
    engineCaseSlug?: string;
    sha256?: string;
    byteSize?: number;
  },
) {
  const [artifact] = await testDb
    .insert(solverEvidenceArtifacts)
    .values({
      airfoilId: fixture.airfoilId,
      simJobId: fixture.simJobId,
      engineJobId: fixture.engineJobId,
      engineCaseSlug: opts.engineCaseSlug ?? fixture.engineCaseSlug,
      kind: "engine_bundle",
      storageKey: opts.storageKey,
      mimeType: "application/zstd",
      sha256: opts.sha256 ?? sha256(opts.storageKey),
      byteSize: opts.byteSize ?? 4_096,
      metadata: {},
    })
    .returning();
  return artifact!;
}

async function createArchiveOwner(testDb: DB, fixture: Fixture) {
  const [attempt] = await testDb
    .insert(resultAttempts)
    .values({
      resultId: fixture.siblingResultId,
      airfoilId: fixture.airfoilId,
      bcId: fixture.bcId,
      aoaDeg: 13,
      simJobId: fixture.simJobId,
      engineJobId: fixture.engineJobId,
      engineCaseSlug: fixture.engineCaseSlug,
      status: "done",
      source: "solved",
      regime: "rans",
      converged: true,
      solvedAt: new Date("2026-07-18T13:04:00.000Z"),
    })
    .returning();
  const [artifact] = await testDb
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: fixture.siblingResultId,
      resultAttemptId: attempt!.id,
      airfoilId: fixture.airfoilId,
      simJobId: fixture.simJobId,
      engineJobId: fixture.engineJobId,
      engineCaseSlug: fixture.engineCaseSlug,
      aoaDeg: 13,
      kind: "engine_bundle",
      storageKey: `jobs/${fixture.engineJobId}/cases/${fixture.engineCaseSlug}/a13/evidence/engine_evidence.tar.zst`,
      mimeType: "application/zstd",
      sha256: sha256(`${fixture.engineJobId}:a13:bundle`),
      byteSize: 4_096,
      metadata: {},
    })
    .returning();
  return { attempt: attempt!, artifact: artifact! };
}

async function createAllowedOrphan(testDb: DB, fixture: Fixture) {
  const engineCaseSlug = `${fixture.engineCaseSlug}_orphan`;
  const evidencePath = `cases/${engineCaseSlug}/a17/evidence`;
  const blob = await createEvidenceBlob(
    testDb,
    `${fixture.engineJobId}:allowed-orphan`,
  );
  const artifact = await createUnboundBundleArtifact(testDb, fixture, {
    engineCaseSlug,
    storageKey: `jobs/${fixture.engineJobId}/${evidencePath}/engine_evidence.tar.zst`,
    sha256: blob.sha256,
    byteSize: blob.byteSize,
  });
  const manifestMember = {
    path: "evidence_manifest.json",
    sha256: sha256(`${fixture.engineJobId}:orphan-manifest`),
    byteSize: 128,
  };
  const [orphan] = await testDb
    .insert(solverEvidenceOrphanQuarantines)
    .values({
      simJobId: fixture.simJobId,
      engineJobId: fixture.engineJobId,
      engineCaseSlug,
      evidencePath,
      quarantineReason: "terminal_engine_evidence_not_ingested",
      sourceArtifactId: artifact.id,
      blobId: blob.id,
      manifestSha256: manifestMember.sha256,
      manifestByteSize: manifestMember.byteSize,
      archiveMemberSetSha256: incompleteMemberSetSha256([manifestMember]),
      archiveMemberCount: 1,
      archiveMembers: [manifestMember],
      sourceArchives: [
        {
          path: "openfoam_evidence.tar.gz",
          compression: "gzip",
          sha256: sha256(`${fixture.engineJobId}:orphan-source`),
          byteSize: 8_192,
        },
      ],
      migrationReceiptSha256: sha256(
        `${fixture.engineJobId}:orphan-receipt`,
      ),
      migrationReceiptByteSize: 512,
      verificationMode: "archive+manifest+all-members-restore:0",
      remoteVerifiedAt: new Date("2026-07-18T13:05:00.000Z"),
    })
    .returning();
  return { orphan: orphan!, blob, artifact };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  if (originalBucket == null) {
    delete process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
  } else {
    process.env.AIRFOILFOAM_EVIDENCE_BUCKET = originalBucket;
  }
});

afterAll(async () => {
  await sql.end();
});

describe("terminal incomplete evidence quarantine", () => {
  it("registers only an immutable physical blob and preservation row", async () => {
    await withRollback(async (testDb) => {
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
      const fixture = await createFixture(testDb);
      const before = await ownershipCounts(testDb);
      const ack = await registerIncompleteEvidenceQuarantine({
        db: testDb,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });

      expect(ack).toMatchObject({
        state: "incomplete_quarantined",
        registrationKind: "incomplete_evidence_quarantine",
        quarantineReason: "terminal_uningested_incomplete_archive",
        jobId: fixture.engineJobId,
        evidencePath: fixture.evidencePath,
        expectedMemberCount: 3,
        retainedMemberCount: 2,
        missingMemberCount: 1,
      });
      expect(ack).not.toHaveProperty("resultId");
      expect(ack).not.toHaveProperty("resultAttemptId");
      expect(ack).not.toHaveProperty("sourceArtifactId");
      expect(ack).not.toHaveProperty("archiveId");
      expect(await ownershipCounts(testDb)).toEqual(before);
      expect(
        await testDb
          .select({ id: results.id })
          .from(results)
          .where(eq(results.id, fixture.siblingResultId)),
      ).toHaveLength(1);

      const [row] = await testDb
        .select()
        .from(solverEvidenceIncompleteQuarantines)
        .where(eq(solverEvidenceIncompleteQuarantines.id, ack.quarantineId));
      expect(row).toMatchObject({
        simJobId: fixture.simJobId,
        engineJobId: fixture.engineJobId,
        evidencePath: fixture.evidencePath,
        blobId: ack.blobId,
        expectedMemberCount: 3,
        retainedMemberCount: 2,
        missingMemberCount: 1,
      });
      const siblingArtifact = await createUnboundBundleArtifact(
        testDb,
        fixture,
        {
          storageKey: `jobs/${fixture.engineJobId}/cases/${fixture.engineCaseSlug}/a18/evidence/engine_evidence.tar.zst`,
        },
      );
      expect(
        await testDb
          .select({ id: solverEvidenceArtifacts.id })
          .from(solverEvidenceArtifacts)
          .where(eq(solverEvidenceArtifacts.engineJobId, fixture.engineJobId)),
      ).toEqual([{ id: siblingArtifact.id }]);
      expect(
        JSON.parse(
          await readFile(
            join(dirname(fixture.receiptPath), INCOMPLETE_DATABASE_ACK_NAME),
            "utf8",
          ),
        ),
      ).toEqual(ack);

      const replay = await registerIncompleteEvidenceQuarantine({
        db: testDb,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });
      expect(replay).toEqual(ack);
      expect(
        await testDb
          .select()
          .from(solverEvidenceIncompleteQuarantines)
          .where(
            eq(
              solverEvidenceIncompleteQuarantines.engineJobId,
              fixture.engineJobId,
            ),
          ),
      ).toHaveLength(1);

      await expect(
        testDb
          .update(solverEvidenceIncompleteQuarantines)
          .set({ missingMemberCount: 2 })
          .where(eq(solverEvidenceIncompleteQuarantines.id, row!.id)),
      ).rejects.toThrow(/immutable/);
    });
  });

  it.each([
    ["all-missing", 0, 3],
    ["all-retained", 3, 0],
  ] as const)(
    "registers the durable %s conservation boundary",
    async (recoveryShape, retainedCount, missingCount) => {
      await withRollback(async (testDb) => {
        process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
        const fixture = await createFixture(testDb, recoveryShape);
        const ack = await registerIncompleteEvidenceQuarantine({
          db: testDb,
          receiptPath: fixture.receiptPath,
          mediaRoot: fixture.mediaRoot,
        });
        expect(ack).toMatchObject({
          expectedMemberCount: 3,
          retainedMemberCount: retainedCount,
          missingMemberCount: missingCount,
        });
        const [row] = await testDb
          .select()
          .from(solverEvidenceIncompleteQuarantines)
          .where(eq(solverEvidenceIncompleteQuarantines.id, ack.quarantineId));
        expect(row!.expectedMemberCount).toBe(
          row!.retainedMemberCount + row!.missingMemberCount,
        );
        if (retainedCount === 0) {
          expect(row!.retainedMemberSetSha256).toBe(
            incompleteMemberSetSha256([]),
          );
        }
        if (missingCount === 0) {
          expect(row!.missingMemberSetSha256).toBe(
            incompleteMemberSetSha256([]),
          );
        }
      });
    },
  );

  it("rejects deletion of a registered preservation row", async () => {
    await withRollback(async (testDb) => {
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
      const fixture = await createFixture(testDb);
      const ack = await registerIncompleteEvidenceQuarantine({
        db: testDb,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });

      await expect(
        testDb
          .delete(solverEvidenceIncompleteQuarantines)
          .where(eq(solverEvidenceIncompleteQuarantines.id, ack.quarantineId)),
      ).rejects.toThrow(/immutable/);
    });
  });

  it("enforces the all-members verification contract in the database trigger", async () => {
    await withRollback(async (testDb) => {
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
      const fixture = await createFixture(testDb);
      const ack = await registerIncompleteEvidenceQuarantine({
        db: testDb,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });
      const [registered] = await testDb
        .select()
        .from(solverEvidenceIncompleteQuarantines)
        .where(eq(solverEvidenceIncompleteQuarantines.id, ack.quarantineId));
      const [registeredBlob] = await testDb
        .select()
        .from(solverEvidenceBlobs)
        .where(eq(solverEvidenceBlobs.id, ack.blobId));
      const conflictingSha = sha256("second exact forensic package");
      const [secondBlob] = await testDb
        .insert(solverEvidenceBlobs)
        .values({
          backend: "gcs",
          bucket: registeredBlob!.bucket,
          objectKey: `solver-evidence-partial/v1/sha256/${conflictingSha.slice(0, 2)}/${conflictingSha}.tar.zst`,
          generation: "987654322",
          compression: "zstd",
          mimeType: "application/zstd",
          sha256: conflictingSha,
          byteSize: registeredBlob!.byteSize,
          crc32c: registeredBlob!.crc32c,
          uncompressedTarSha256: registeredBlob!.uncompressedTarSha256,
          uncompressedTarByteSize:
            registeredBlob!.uncompressedTarByteSize,
          verifiedAt: registeredBlob!.verifiedAt,
          metadata: {},
        })
        .returning();
      const evidencePath = "cases/c0p05_u30/a19-recovery/evidence";
      const {
        id: _id,
        createdAt: _createdAt,
        blobId: _blobId,
        evidencePath: _evidencePath,
        sourceArchives,
        ...registeredValues
      } = registered!;

      await expect(
        testDb.insert(solverEvidenceIncompleteQuarantines).values({
          ...registeredValues,
          evidencePath,
          blobId: secondBlob!.id,
          sourceArchives: sourceArchives.map((source) =>
            source.role === "corrupt_original"
              ? { ...source, evidencePath }
              : source,
          ),
          verificationMode: "archive+manifest+all-members-restore:1",
        }),
      ).rejects.toThrow(/verification/);
    });
  });

  it("rejects a later artifact insert under the quarantined exact path", async () => {
    await withRollback(async (testDb) => {
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
      const fixture = await createFixture(testDb);
      await registerIncompleteEvidenceQuarantine({
        db: testDb,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });

      await expect(
        createUnboundBundleArtifact(testDb, fixture, {
          storageKey: `jobs/${fixture.engineJobId}/${fixture.evidencePath}/engine_evidence.tar.zst`,
        }),
      ).rejects.toThrow(/incomplete quarantine exact path/);
    });
  });

  it("rejects an artifact update into the quarantined exact path", async () => {
    await withRollback(async (testDb) => {
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
      const fixture = await createFixture(testDb);
      await registerIncompleteEvidenceQuarantine({
        db: testDb,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });
      const sibling = await createUnboundBundleArtifact(testDb, fixture, {
        storageKey: `jobs/${fixture.engineJobId}/cases/${fixture.engineCaseSlug}/a18/evidence/engine_evidence.tar.zst`,
      });

      await expect(
        testDb
          .update(solverEvidenceArtifacts)
          .set({
            storageKey: `jobs/${fixture.engineJobId}/${fixture.evidencePath}/engine_evidence.tar.zst`,
          })
          .where(eq(solverEvidenceArtifacts.id, sibling.id)),
      ).rejects.toThrow(/incomplete quarantine exact path/);
    });
  });

  it("rejects a later solver archive insert that claims the quarantine blob", async () => {
    await withRollback(async (testDb) => {
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
      const fixture = await createFixture(testDb);
      const ack = await registerIncompleteEvidenceQuarantine({
        db: testDb,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });
      const owner = await createArchiveOwner(testDb, fixture);

      await expect(
        testDb.insert(solverEvidenceArchives).values({
          resultId: fixture.siblingResultId,
          resultAttemptId: owner.attempt.id,
          sourceArtifactId: owner.artifact.id,
          blobId: ack.blobId,
          state: "current",
        }),
      ).rejects.toThrow(/cannot own an incomplete quarantine blob/);
    });
  });

  it("rejects a solver archive update that retargets to the quarantine blob", async () => {
    await withRollback(async (testDb) => {
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
      const fixture = await createFixture(testDb);
      const ack = await registerIncompleteEvidenceQuarantine({
        db: testDb,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });
      const owner = await createArchiveOwner(testDb, fixture);
      const allowedBlob = await createEvidenceBlob(
        testDb,
        `${fixture.engineJobId}:allowed-archive`,
      );
      const [archive] = await testDb
        .insert(solverEvidenceArchives)
        .values({
          resultId: fixture.siblingResultId,
          resultAttemptId: owner.attempt.id,
          sourceArtifactId: owner.artifact.id,
          blobId: allowedBlob.id,
          state: "current",
        })
        .returning();

      await expect(
        testDb
          .update(solverEvidenceArchives)
          .set({ blobId: ack.blobId })
          .where(eq(solverEvidenceArchives.id, archive!.id)),
      ).rejects.toThrow(/cannot own an incomplete quarantine blob/);
    });
  });

  it.each(["blob", "exact-path"] as const)(
    "rejects a later orphan quarantine insert that claims the incomplete %s",
    async (conflict) => {
      await withRollback(async (testDb) => {
        process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
        const fixture = await createFixture(testDb);
        const ack = await registerIncompleteEvidenceQuarantine({
          db: testDb,
          receiptPath: fixture.receiptPath,
          mediaRoot: fixture.mediaRoot,
        });
        const allowed = await createAllowedOrphan(testDb, fixture);
        const {
          id: _id,
          createdAt: _createdAt,
          blobId: _blobId,
          engineCaseSlug: _engineCaseSlug,
          evidencePath: _evidencePath,
          ...orphanValues
        } = allowed.orphan;

        await expect(
          testDb.insert(solverEvidenceOrphanQuarantines).values({
            ...orphanValues,
            blobId: conflict === "blob" ? ack.blobId : allowed.blob.id,
            engineCaseSlug:
              conflict === "exact-path"
                ? fixture.engineCaseSlug
                : allowed.orphan.engineCaseSlug,
            evidencePath:
              conflict === "exact-path"
                ? fixture.evidencePath
                : `cases/${allowed.orphan.engineCaseSlug}/a16/evidence`,
          }),
        ).rejects.toThrow(/incomplete quarantine blob or exact path/);
      });
    },
  );

  it.each(["blob", "exact-path"] as const)(
    "rejects an orphan quarantine update that claims the incomplete %s",
    async (conflict) => {
      await withRollback(async (testDb) => {
        process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
        const fixture = await createFixture(testDb);
        const ack = await registerIncompleteEvidenceQuarantine({
          db: testDb,
          receiptPath: fixture.receiptPath,
          mediaRoot: fixture.mediaRoot,
        });
        const allowed = await createAllowedOrphan(testDb, fixture);

        await expect(
          testDb
            .update(solverEvidenceOrphanQuarantines)
            .set(
              conflict === "blob"
                ? { blobId: ack.blobId }
                : {
                    engineCaseSlug: fixture.engineCaseSlug,
                    evidencePath: fixture.evidencePath,
                  },
            )
            .where(
              eq(solverEvidenceOrphanQuarantines.id, allowed.orphan.id),
            ),
        ).rejects.toThrow(/incomplete quarantine blob or exact path/);
      });
    },
  );

  it("replays a finalized receipt through the preserved pass-1 identity", async () => {
    await withRollback(async (testDb) => {
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
      const fixture = await createFixture(testDb);
      const pass1Bytes = await readFile(fixture.receiptPath);
      const ack = await registerIncompleteEvidenceQuarantine({
        db: testDb,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });
      const completed = JSON.parse(pass1Bytes.toString("utf8"));
      completed.state = "complete";
      completed.registrationReceipt = {
        sha256: sha256(pass1Bytes),
        byteSize: pass1Bytes.length,
      };
      completed.databaseAcknowledgement = ack;
      await writeFile(fixture.receiptPath, JSON.stringify(completed));

      expect(
        await registerIncompleteEvidenceQuarantine({
          db: testDb,
          receiptPath: fixture.receiptPath,
          mediaRoot: fixture.mediaRoot,
        }),
      ).toEqual(ack);
    });
  });

  it("fails closed on pointer drift and exact-path canonical ownership", async () => {
    await withRollback(async (testDb) => {
      process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
      const fixture = await createFixture(testDb);
      const pointerPath = join(dirname(fixture.receiptPath), INCOMPLETE_POINTER_NAME);
      const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
      await writeFile(pointerPath, JSON.stringify({ ...pointer, generation: "9" }));
      await expect(
        registerIncompleteEvidenceQuarantine({
          db: testDb,
          receiptPath: fixture.receiptPath,
          mediaRoot: fixture.mediaRoot,
        }),
      ).rejects.toThrow(/pointer does not equal/);
      await writeFile(pointerPath, JSON.stringify(pointer));

      await testDb.insert(solverEvidenceArtifacts).values({
        resultId: null,
        resultAttemptId: null,
        airfoilId: (
          await testDb
            .select({ airfoilId: simJobs.airfoilId })
            .from(simJobs)
            .where(eq(simJobs.id, fixture.simJobId))
        )[0]!.airfoilId,
        simJobId: fixture.simJobId,
        engineJobId: fixture.engineJobId,
        engineCaseSlug: "c0p05_u30",
        aoaDeg: null,
        kind: "log",
        role: "evidence",
        storageKey: `jobs/${fixture.engineJobId}/${fixture.evidencePath}/openfoam/logs/log.a19`,
        mimeType: "text/plain",
        sha256: sha256("canonical"),
        byteSize: 9,
        metadata: {},
      });
      await expect(
        registerIncompleteEvidenceQuarantine({
          db: testDb,
          receiptPath: fixture.receiptPath,
          mediaRoot: fixture.mediaRoot,
        }),
      ).rejects.toThrow(/canonical artifact ownership/);
      expect(
        await testDb
          .select()
          .from(solverEvidenceIncompleteQuarantines)
          .where(
            eq(
              solverEvidenceIncompleteQuarantines.engineJobId,
              fixture.engineJobId,
            ),
          ),
      ).toHaveLength(0);
      expect(
        await testDb
          .select()
          .from(solverEvidenceBlobs)
          .where(eq(solverEvidenceBlobs.objectKey, pointer.objectKey)),
      ).toHaveLength(0);
    });
  });
});
