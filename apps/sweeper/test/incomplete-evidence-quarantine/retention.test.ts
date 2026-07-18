// This retention contract takes the sweeper suite's existing exclusive
// database lease (selected by this basename).  Production registration uses
// table-wide ownership locks, so running it beside rollback-based DB fixtures
// would create a lock-upgrade deadlock instead of meaningful parallelism.
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
} from "@aerodb/db";
import { count, eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  INCOMPLETE_ARCHIVE_NAME,
  INCOMPLETE_DATABASE_ACK_NAME,
  INCOMPLETE_PACKAGE_MANIFEST_NAME,
  INCOMPLETE_POINTER_NAME,
  INCOMPLETE_RECEIPT_NAME,
  readIncompleteEvidenceQuarantineReceipt,
  registerIncompleteEvidenceQuarantine,
} from "../../src/evidence-incomplete-quarantine";

const { db, sql } = createClient({ max: 2 });
const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const DRIVER = join(
  REPO_ROOT,
  "tests",
  "incomplete_quarantine_contract_driver.py",
);
const PREFIX = `incomplete-cross-language-${process.pid}-${Date.now().toString(36)}`;
const BUCKET = "cross-language-incomplete-evidence-bucket";
const TARGET_EVIDENCE_PATH = "cases/c0p05_u30/a19/evidence";
const DONOR_EVIDENCE_PATH = "cases/c0p05_u30/a18/evidence";
const ROLLBACK = new Error("rollback cross-language quarantine fixture");
const roots: string[] = [];
const originalBucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET;

const sha256 = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

interface DriverFixture {
  targetEvidencePath: string;
  donorEvidencePath: string;
  corruptArchiveSha256: string;
  corruptArchiveByteSize: number;
  targetManifestSha256: string;
  targetManifestByteSize: number;
  vtkSha256: string;
  donorLogSha256: string;
  missingSha256: string;
  operatorNoteSha256: string;
  excludedFrameSha256: string;
  donorArchiveSha256: string;
}

interface DriverOutput {
  phase: "pass1" | "pass3";
  processId: number;
  fixture: DriverFixture | null;
  result: {
    status: string;
    jobId: string;
    evidencePath: string;
    expectedMembers: number;
    retainedMembers: number;
    missingMembers: number;
    packageMembers: number;
    generation: string;
    remoteBytes: number;
    bytesDeleted: number;
    verification: string;
  };
  object: {
    bucket: string;
    objectKey: string;
    generation: number;
    size: number;
    sha256: string;
    crc32c: string;
    contentType: string;
    uploadCount: number;
    downloadCount: number;
    dataPath: string;
    metadataPath: string;
    actualSize: number;
    actualSha256: string;
    metadata: Record<string, string>;
  };
}

interface DatabaseFixture {
  engineJobId: string;
  simJobId: string;
  siblingResultId: string;
}

async function pythonExecutable(): Promise<string> {
  if (process.env.AIRFOILFOAM_TEST_PYTHON) {
    return process.env.AIRFOILFOAM_TEST_PYTHON;
  }
  const virtualenvPython = join(REPO_ROOT, ".venv", "bin", "python");
  try {
    await access(virtualenvPython);
    return virtualenvPython;
  } catch {
    return "python3";
  }
}

async function runPythonPhase(opts: {
  phase: "pass1" | "pass3";
  mediaRoot: string;
  objectRoot: string;
  engineJobId: string;
}): Promise<DriverOutput> {
  const python = await pythonExecutable();
  const pythonPath = process.env.PYTHONPATH
    ? `${join(REPO_ROOT, "src")}${delimiter}${process.env.PYTHONPATH}`
    : join(REPO_ROOT, "src");
  const { stdout } = await execFileAsync(
    python,
    [
      DRIVER,
      "--phase",
      opts.phase,
      "--media-root",
      opts.mediaRoot,
      "--object-root",
      opts.objectRoot,
      "--job-id",
      opts.engineJobId,
      "--bucket",
      BUCKET,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: pythonPath },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout.trim()) as DriverOutput;
}

async function createDatabaseFixture(testDb: DB): Promise<DatabaseFixture> {
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
      categoryId: category!.id,
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
      mediumId: medium!.id,
      reynolds: 102_000,
      referenceChordM: 0.05,
      speedMps: 30,
    })
    .returning();
  const engineJobId = `${token}-engine`;
  const [job] = await testDb
    .insert(simJobs)
    .values({
      airfoilId: airfoil!.id,
      bcIds: [bc!.id],
      referenceChordM: 0.05,
      status: "cancelled",
      engineJobId,
      totalCases: 26,
      completedCases: 19,
      finishedAt: new Date(),
    })
    .returning();
  const [siblingResult] = await testDb
    .insert(results)
    .values({
      airfoilId: airfoil!.id,
      bcId: bc!.id,
      aoaDeg: 13,
      status: "done",
      source: "solved",
      regime: "rans",
      simJobId: job!.id,
      engineJobId,
      engineCaseSlug: "c0p05_u30",
      converged: true,
      solvedAt: new Date(),
    })
    .returning();
  return {
    engineJobId,
    simJobId: job!.id,
    siblingResultId: siblingResult!.id,
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

describe("incomplete evidence Python/Node/Python contract", () => {
  it(
    "preserves, registers, acknowledges, freshly restores, cleans, and replays exact bytes",
    async () => {
      await withRollback(async (testDb) => {
        process.env.AIRFOILFOAM_EVIDENCE_BUCKET = BUCKET;
        const fixture = await createDatabaseFixture(testDb);
        const mediaRoot = await mkdtemp(
          join(tmpdir(), "incomplete-cross-language-media-"),
        );
        const objectRoot = await mkdtemp(
          join(tmpdir(), "incomplete-cross-language-object-"),
        );
        roots.push(mediaRoot, objectRoot);
        const evidenceDir = join(
          mediaRoot,
          "jobs",
          fixture.engineJobId,
          TARGET_EVIDENCE_PATH,
        );
        const donorEvidenceDir = join(
          mediaRoot,
          "jobs",
          fixture.engineJobId,
          DONOR_EVIDENCE_PATH,
        );

        const pass1 = await runPythonPhase({
          phase: "pass1",
          mediaRoot,
          objectRoot,
          engineJobId: fixture.engineJobId,
        });
        expect(pass1.phase).toBe("pass1");
        expect(pass1.fixture).not.toBeNull();
        expect(pass1.result).toMatchObject({
          status: "awaiting-database-registration",
          jobId: fixture.engineJobId,
          evidencePath: TARGET_EVIDENCE_PATH,
          expectedMembers: 3,
          retainedMembers: 2,
          missingMembers: 1,
          packageMembers: 6,
          generation: "18000000000000000001",
        });
        expect(pass1.result.verification).toBe(
          "archive+manifest+all-members-restore:6",
        );

        const receiptPath = join(evidenceDir, INCOMPLETE_RECEIPT_NAME);
        const pointerPath = join(evidenceDir, INCOMPLETE_POINTER_NAME);
        const packageManifestPath = join(
          evidenceDir,
          INCOMPLETE_PACKAGE_MANIFEST_NAME,
        );
        const originalManifestPath = join(evidenceDir, "evidence_manifest.json");
        const corruptArchivePath = join(evidenceDir, "openfoam_evidence.tar.gz");
        const localArchivePath = join(evidenceDir, INCOMPLETE_ARCHIVE_NAME);
        const excludedFramePath = join(
          evidenceDir,
          "frames",
          "vorticity",
          "f0001.png",
        );
        const operatorNotePath = join(
          evidenceDir,
          "openfoam",
          "operator-note.bin",
        );
        const donorArchivePath = join(
          donorEvidenceDir,
          "openfoam_evidence.tar.gz",
        );
        const pass1ReceiptBytes = await readFile(receiptPath);
        const pointerBytes = await readFile(pointerPath);
        const packageManifestBytes = await readFile(packageManifestPath);
        const originalManifestBytes = await readFile(originalManifestPath);
        const corruptArchiveBytes = await readFile(corruptArchivePath);
        const localArchiveBytes = await readFile(localArchivePath);
        const excludedFrameBytes = await readFile(excludedFramePath);
        const operatorNoteBytes = await readFile(operatorNotePath);
        const donorArchiveBytes = await readFile(donorArchivePath);
        const actualObjectBytes = await readFile(pass1.object.dataPath);
        const receipt = JSON.parse(pass1ReceiptBytes.toString("utf8"));
        const pointer = JSON.parse(pointerBytes.toString("utf8"));
        const packageManifest = JSON.parse(
          packageManifestBytes.toString("utf8"),
        );
        const driverFixture = pass1.fixture!;

        expect(receipt.state).toBe("awaiting_database_registration");
        expect(pointer).toEqual(receipt.remote);
        expect(sha256(packageManifestBytes)).toBe(
          receipt.packageManifest.sha256,
        );
        expect(packageManifestBytes.byteLength).toBe(
          receipt.packageManifest.byteSize,
        );
        expect(packageManifest.files).toHaveLength(receipt.packageMembers.length);
        expect(
          packageManifest.files.map(
            (member: { path: string; sha256: string; byteSize: number }) => ({
              path: member.path,
              sha256: member.sha256,
              byteSize: member.byteSize,
            }),
          ),
        ).toEqual(receipt.packageMembers);
        expect(sha256(originalManifestBytes)).toBe(
          driverFixture.targetManifestSha256,
        );
        expect(originalManifestBytes.byteLength).toBe(
          driverFixture.targetManifestByteSize,
        );
        expect(sha256(corruptArchiveBytes)).toBe(
          driverFixture.corruptArchiveSha256,
        );
        expect(corruptArchiveBytes.byteLength).toBe(
          driverFixture.corruptArchiveByteSize,
        );
        expect(sha256(operatorNoteBytes)).toBe(
          driverFixture.operatorNoteSha256,
        );
        expect(sha256(excludedFrameBytes)).toBe(
          driverFixture.excludedFrameSha256,
        );
        expect(sha256(donorArchiveBytes)).toBe(
          driverFixture.donorArchiveSha256,
        );
        expect(sha256(localArchiveBytes)).toBe(pointer.storedSha256);
        expect(localArchiveBytes).toEqual(actualObjectBytes);
        expect(pass1.object).toMatchObject({
          bucket: BUCKET,
          objectKey: pointer.objectKey,
          generation: 18_000_000_000_000_000_001,
          size: pointer.storedSize,
          sha256: pointer.storedSha256,
          actualSize: pointer.storedSize,
          actualSha256: pointer.storedSha256,
          crc32c: pointer.crc32c,
          contentType: "application/zstd",
          uploadCount: 1,
        });
        expect(pass1.object.downloadCount).toBeGreaterThanOrEqual(1);
        expect(receipt.expectedMembers).toEqual([
          expect.objectContaining({
            path: "VTK/value.vtu",
            sha256: driverFixture.vtkSha256,
          }),
          expect.objectContaining({
            path: "openfoam/logs/log.a19",
            sha256: driverFixture.donorLogSha256,
          }),
          expect.objectContaining({
            path: "time_directories/33000/U",
            sha256: driverFixture.missingSha256,
          }),
        ]);
        expect(receipt.missingMembers).toEqual([
          expect.objectContaining({ path: "time_directories/33000/U" }),
        ]);
        expect(
          receipt.retainedMembers.find(
            (member: { path: string }) => member.path === "VTK/value.vtu",
          ).sources.map((source: { kind: string }) => source.kind),
        ).toEqual(["corrupt_archive_member", "local_raw"]);
        expect(
          receipt.retainedMembers.find(
            (member: { path: string }) =>
              member.path === "openfoam/logs/log.a19",
          ).sources,
        ).toEqual([
          expect.objectContaining({ kind: "sibling_archive_member" }),
        ]);

        const registrationDocument =
          await readIncompleteEvidenceQuarantineReceipt(receiptPath, mediaRoot);
        expect(registrationDocument.receipt.remote).toEqual(pointer);
        expect(registrationDocument.bytes).toEqual(pass1ReceiptBytes);
        expect(registrationDocument.sha256).toBe(sha256(pass1ReceiptBytes));
        const ownershipBefore = await ownershipCounts(testDb);
        const ack = await registerIncompleteEvidenceQuarantine({
          db: testDb,
          receiptPath,
          mediaRoot,
        });
        expect(await ownershipCounts(testDb)).toEqual(ownershipBefore);
        expect(ack).toMatchObject({
          state: "incomplete_quarantined",
          jobId: fixture.engineJobId,
          evidencePath: TARGET_EVIDENCE_PATH,
          storedSha256: pointer.storedSha256,
          generation: pointer.generation,
          expectedMemberCount: 3,
          retainedMemberCount: 2,
          missingMemberCount: 1,
          packageMemberCount: 6,
          migrationReceiptSha256: sha256(pass1ReceiptBytes),
          migrationReceiptByteSize: pass1ReceiptBytes.byteLength,
        });
        expect(ack).not.toHaveProperty("resultId");
        expect(ack).not.toHaveProperty("resultAttemptId");
        expect(ack).not.toHaveProperty("sourceArtifactId");
        expect(ack).not.toHaveProperty("archiveId");
        const ackPath = join(evidenceDir, INCOMPLETE_DATABASE_ACK_NAME);
        const ackBytes = await readFile(ackPath);
        expect(JSON.parse(ackBytes.toString("utf8"))).toEqual(ack);

        const [quarantineRow] = await testDb
          .select()
          .from(solverEvidenceIncompleteQuarantines)
          .where(eq(solverEvidenceIncompleteQuarantines.id, ack.quarantineId));
        const [blobRow] = await testDb
          .select()
          .from(solverEvidenceBlobs)
          .where(eq(solverEvidenceBlobs.id, ack.blobId));
        expect(quarantineRow).toMatchObject({
          simJobId: fixture.simJobId,
          engineJobId: fixture.engineJobId,
          engineCaseSlug: "c0p05_u30",
          evidencePath: TARGET_EVIDENCE_PATH,
          blobId: ack.blobId,
          expectedMembers: receipt.expectedMembers,
          retainedMembers: receipt.retainedMembers,
          missingMembers: receipt.missingMembers,
          packageMembers: receipt.packageMembers,
          sourceArchives: receipt.sourceArchives,
          migrationReceiptSha256: sha256(pass1ReceiptBytes),
          migrationReceiptByteSize: pass1ReceiptBytes.byteLength,
        });
        expect(blobRow).toMatchObject({
          backend: "gcs",
          bucket: BUCKET,
          objectKey: pointer.objectKey,
          generation: pointer.generation,
          compression: "zstd",
          mimeType: "application/zstd",
          sha256: pointer.storedSha256,
          byteSize: pointer.storedSize,
          crc32c: pointer.crc32c,
          uncompressedTarSha256: pointer.tarSha256,
          uncompressedTarByteSize: pointer.tarSize,
        });
        expect(
          await testDb
            .select({ id: results.id })
            .from(results)
            .where(eq(results.id, fixture.siblingResultId)),
        ).toHaveLength(1);

        const pass3 = await runPythonPhase({
          phase: "pass3",
          mediaRoot,
          objectRoot,
          engineJobId: fixture.engineJobId,
        });
        expect(pass3.processId).not.toBe(pass1.processId);
        expect(pass3.result).toMatchObject({
          status: "incomplete-quarantined",
          expectedMembers: 3,
          retainedMembers: 2,
          missingMembers: 1,
          packageMembers: 6,
        });
        expect(pass3.result.bytesDeleted).toBeGreaterThan(0);
        expect(pass3.object).toMatchObject({
          objectKey: pointer.objectKey,
          generation: 18_000_000_000_000_000_001,
          actualSize: pointer.storedSize,
          actualSha256: pointer.storedSha256,
          uploadCount: 1,
        });
        expect(pass3.object.downloadCount).toBeGreaterThan(
          pass1.object.downloadCount,
        );
        expect(await readFile(pass3.object.dataPath)).toEqual(actualObjectBytes);

        const completedReceiptBytes = await readFile(receiptPath);
        const completedReceipt = JSON.parse(
          completedReceiptBytes.toString("utf8"),
        );
        expect(completedReceipt).toMatchObject({
          state: "complete",
          registrationReceipt: {
            sha256: sha256(pass1ReceiptBytes),
            byteSize: pass1ReceiptBytes.byteLength,
          },
          databaseAcknowledgement: ack,
        });
        expect(completedReceipt.deletedPaths).toEqual(
          expect.arrayContaining([
            "VTK",
            "openfoam",
            "openfoam_evidence.tar.gz",
            INCOMPLETE_ARCHIVE_NAME,
          ]),
        );
        await expect(readFile(corruptArchivePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(localArchivePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(readFile(operatorNotePath)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await readFile(originalManifestPath)).toEqual(
          originalManifestBytes,
        );
        expect(await readFile(packageManifestPath)).toEqual(
          packageManifestBytes,
        );
        expect(await readFile(pointerPath)).toEqual(pointerBytes);
        expect(await readFile(ackPath)).toEqual(ackBytes);
        expect(await readFile(excludedFramePath)).toEqual(excludedFrameBytes);
        expect(await readFile(donorArchivePath)).toEqual(donorArchiveBytes);

        const replay = await registerIncompleteEvidenceQuarantine({
          db: testDb,
          receiptPath,
          mediaRoot,
        });
        expect(replay).toEqual(ack);
        expect(await ownershipCounts(testDb)).toEqual(ownershipBefore);
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
      });
    },
    120_000,
  );
});
