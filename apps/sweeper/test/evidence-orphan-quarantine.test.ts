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
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  solverEvidenceOrphanQuarantines,
} from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { eq, like } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  evidenceMigrationExecutionLog,
  registerEvidenceMigrationReceipt,
} from "../src/evidence-storage-backfill";

const { db, sql } = createClient({ max: 2 });
const PREFIX = `orphan-evidence-${process.pid}-${Date.now().toString(36)}`;
const ENGINE = { baseUrl: "http://engine.test" } as EngineClient;
const GENERATION = "18446744073709551615";
const roots: string[] = [];
const ROLLBACK = new Error("rollback immutable quarantine fixture");
let mediumId = "";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

interface Fixture {
  simJobId: string;
  engineJobId: string;
  caseSlug: string;
  mediaRoot: string;
  receiptPath: string;
  evidencePath: string;
}

async function createFixture(
  testDb: DB,
  opts: {
    exactResult?: boolean;
    unrelatedSameAoaResult?: boolean;
    duplicateSimJob?: boolean;
    verificationMode?: string;
    jobStatus?: "failed" | "running";
  } = {},
): Promise<Fixture> {
  const token = `${PREFIX}-${randomUUID().slice(0, 8)}`;
  const [category] = await testDb
    .insert(categories)
    .values({
      slug: `${token}-cat`,
      name: `${token} category`,
      path: `${token}-cat`,
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
        { x: 0.5, y: 0.08 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.08 },
        { x: 1, y: 0 },
      ],
    })
    .returning({ id: airfoils.id });
  const [bc] = await testDb
    .insert(boundaryConditions)
    .values({
      slug: `${token}-bc`,
      name: `${token} condition`,
      mediumId,
      reynolds: 171_000,
      referenceChordM: 0.1,
      speedMps: 25,
    })
    .returning({ id: boundaryConditions.id });
  const engineJobId = `${token}-engine`;
  const caseSlug = `${token}-case`;
  const [job] = await testDb
    .insert(simJobs)
    .values({
      airfoilId: airfoil.id,
      bcIds: [bc.id],
      referenceChordM: 0.1,
      status: opts.jobStatus ?? "failed",
      engineJobId,
      totalCases: 1,
      completedCases: 1,
      finishedAt: new Date(),
    })
    .returning({ id: simJobs.id });

  if (opts.duplicateSimJob) {
    await testDb.insert(simJobs).values({
      airfoilId: airfoil.id,
      bcIds: [bc.id],
      referenceChordM: 0.1,
      status: "failed",
      engineJobId,
      totalCases: 1,
      completedCases: 1,
      finishedAt: new Date(),
    });
  }
  if (opts.exactResult || opts.unrelatedSameAoaResult) {
    await testDb.insert(results).values({
      airfoilId: airfoil.id,
      bcId: bc.id,
      aoaDeg: 14,
      status: "done",
      source: "solved",
      regime: "rans",
      simJobId: job.id,
      engineJobId: opts.exactResult ? engineJobId : `${engineJobId}-unrelated`,
      engineCaseSlug: opts.exactResult ? caseSlug : `${caseSlug}-unrelated`,
      converged: false,
      solvedAt: new Date(),
    });
  }

  const manifestBytes = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      bundleExcludes: ["frames"],
      files: [
        {
          path: "VTK/value.vtu",
          sha256: sha256(`${token}:vtk`),
          byteSize: 17,
        },
        {
          path: "openfoam/logs/log.simpleFoam",
          sha256: sha256(`${token}:log`),
          byteSize: 23,
        },
      ],
    }),
  );
  const evidencePath = `cases/${caseSlug}/a14/evidence`;
  const mediaRoot = await mkdtemp(join(tmpdir(), "orphan-evidence-"));
  roots.push(mediaRoot);
  const receiptDir = join(mediaRoot, "jobs", engineJobId, evidencePath);
  await mkdir(receiptDir, { recursive: true });
  await writeFile(join(receiptDir, "evidence_manifest.json"), manifestBytes);

  const storedSha = sha256(`${token}:zstd`);
  const tarSha = sha256(`${token}:tar`);
  const receipt = {
    schemaVersion: 1,
    state: "awaiting_database_registration",
    jobId: engineJobId,
    evidencePath,
    archive: {
      storedSha256: storedSha,
      storedByteSize: 162_000,
      uncompressedTarSha256: tarSha,
      uncompressedTarByteSize: 240_000,
      zstdLevel: 10,
    },
    remote: {
      schemaVersion: 1,
      format: "tar+zstd",
      bucket: "airfoils-pro-storage-bucket",
      objectKey: `${PREFIX}/sha256/${storedSha.slice(0, 2)}/${storedSha}.tar.zst`,
      generation: GENERATION,
      storedSha256: storedSha,
      storedSize: 162_000,
      tarSha256: tarSha,
      tarSize: 240_000,
      crc32c: "AAAAAA==",
      zstdLevel: 10,
      createdAt: "2026-07-17T08:00:00.000Z",
    },
    sourceArchives: [
      {
        path: "openfoam_evidence.tar.gz",
        compression: "gzip",
        sha256: sha256(`${token}:gzip`),
        byteSize: 220_000,
      },
    ],
    verificationMode:
      opts.verificationMode ?? "archive+manifest+all-members-restore:2",
    verifiedAt: "2026-07-17T08:01:00.000Z",
  };
  const receiptPath = join(receiptDir, "storage_migration.json");
  await writeFile(receiptPath, JSON.stringify(receipt));
  return {
    simJobId: job.id,
    engineJobId,
    caseSlug,
    mediaRoot,
    receiptPath,
    evidencePath,
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

beforeAll(async () => {
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: `${PREFIX}-air`,
      name: `${PREFIX} air`,
      phase: "gas",
      density: 1.225,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.789e-5,
      dynamicViscosity: 1.789e-5,
      kinematicViscosity: 1.46e-5,
      speedOfSound: 340.3,
    })
    .returning({ id: mediums.id });
  mediumId = medium.id;
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

afterAll(async () => {
  if (mediumId) await db.delete(mediums).where(eq(mediums.id, mediumId));
  await sql.end();
});

describe("exact un-ingested solver evidence quarantine", () => {
  it("preserves the sole exact job/path without inventing a result or AoA", async () => {
    await withRollback(async (db) => {
      const fixture = await createFixture(db, {
        unrelatedSameAoaResult: true,
      });
      const beforeResults = await db
        .select({ id: results.id })
        .from(results)
        .where(eq(results.simJobId, fixture.simJobId));
      const ack = await registerEvidenceMigrationReceipt({
        db,
        engine: ENGINE,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });

      expect(ack).toMatchObject({
        state: "quarantined",
        registrationKind: "orphan_evidence_quarantine",
        quarantineReason: "terminal_engine_evidence_not_ingested",
        jobId: fixture.engineJobId,
        evidencePath: fixture.evidencePath,
        generation: GENERATION,
      });
      expect(ack).not.toHaveProperty("resultId");
      expect(ack).not.toHaveProperty("resultAttemptId");
      expect(ack).not.toHaveProperty("archiveId");
      if (ack.state !== "quarantined") throw new Error("expected quarantine");
      expect(evidenceMigrationExecutionLog(ack)).toMatchObject({
        status: "quarantined",
        state: "quarantined",
        quarantineId: ack.quarantineId,
      });

      const [quarantine] = await db
        .select()
        .from(solverEvidenceOrphanQuarantines)
        .where(eq(solverEvidenceOrphanQuarantines.id, ack.quarantineId));
      expect(quarantine).toMatchObject({
        simJobId: fixture.simJobId,
        engineJobId: fixture.engineJobId,
        engineCaseSlug: fixture.caseSlug,
        evidencePath: fixture.evidencePath,
        quarantineReason: "terminal_engine_evidence_not_ingested",
        verificationMode: "archive+manifest+all-members-restore:2",
        archiveMemberCount: 3,
      });
      const [artifact] = await db
        .select()
        .from(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.id, quarantine.sourceArtifactId));
      expect(artifact).toMatchObject({
        resultId: null,
        resultAttemptId: null,
        aoaDeg: null,
        simJobId: fixture.simJobId,
        engineJobId: fixture.engineJobId,
        engineCaseSlug: fixture.caseSlug,
        kind: "engine_bundle",
        mimeType: "application/zstd",
      });
      expect(
        await db
          .select({ id: results.id })
          .from(results)
          .where(eq(results.simJobId, fixture.simJobId)),
      ).toHaveLength(beforeResults.length);
      expect(
        await db
          .select({ id: resultAttempts.id })
          .from(resultAttempts)
          .where(eq(resultAttempts.simJobId, fixture.simJobId)),
      ).toHaveLength(0);
      expect(
        JSON.parse(
          await readFile(
            join(
              dirname(fixture.receiptPath),
              "storage_migration.database.json",
            ),
            "utf8",
          ),
        ),
      ).toMatchObject(ack);

      const replay = await registerEvidenceMigrationReceipt({
        db,
        engine: ENGINE,
        receiptPath: fixture.receiptPath,
        mediaRoot: fixture.mediaRoot,
      });
      expect(replay).toEqual(ack);
      expect(
        await db
          .select()
          .from(solverEvidenceOrphanQuarantines)
          .where(
            eq(
              solverEvidenceOrphanQuarantines.engineJobId,
              fixture.engineJobId,
            ),
          ),
      ).toHaveLength(1);
      await expect(
        db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as DB;
          await tx
            .update(solverEvidenceOrphanQuarantines)
            .set({ evidencePath: `${fixture.evidencePath}-changed` })
            .where(eq(solverEvidenceOrphanQuarantines.id, quarantine.id));
        }),
      ).rejects.toThrow(/immutable/);
      await expect(
        db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as DB;
          await tx
            .delete(solverEvidenceOrphanQuarantines)
            .where(eq(solverEvidenceOrphanQuarantines.id, quarantine.id));
        }),
      ).rejects.toThrow(/immutable/);
      await expect(
        db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as DB;
          await tx
            .update(solverEvidenceArtifacts)
            .set({ role: "log" })
            .where(eq(solverEvidenceArtifacts.id, artifact.id));
        }),
      ).rejects.toThrow(/immutable/);
    });
  });

  it("rejects an exact ingested result instead of relabeling it", async () => {
    await withRollback(async (db) => {
      const fixture = await createFixture(db, { exactResult: true });
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath: fixture.receiptPath,
          mediaRoot: fixture.mediaRoot,
        }),
      ).rejects.toThrow(/exact result ownership exists/);
      expect(
        await db
          .select()
          .from(solverEvidenceOrphanQuarantines)
          .where(
            eq(
              solverEvidenceOrphanQuarantines.engineJobId,
              fixture.engineJobId,
            ),
          ),
      ).toHaveLength(0);
    });
  });

  it("rejects ambiguous sim-job ownership before registering a blob", async () => {
    await withRollback(async (db) => {
      const fixture = await createFixture(db, { duplicateSimJob: true });
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath: fixture.receiptPath,
          mediaRoot: fixture.mediaRoot,
        }),
      ).rejects.toThrow(/one exact sim job; found 2/);
      expect(
        await db
          .select()
          .from(solverEvidenceBlobs)
          .where(like(solverEvidenceBlobs.objectKey, `${PREFIX}/%`)),
      ).toHaveLength(0);
    });
  });

  it("rejects a receipt that did not verify every manifest member", async () => {
    await withRollback(async (db) => {
      const fixture = await createFixture(db, {
        verificationMode: "archive+manifest+all-members-restore:1",
      });
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath: fixture.receiptPath,
          mediaRoot: fixture.mediaRoot,
        }),
      ).rejects.toThrow(/all-members-restore:2/);
      expect(
        await db
          .select()
          .from(solverEvidenceOrphanQuarantines)
          .where(
            eq(
              solverEvidenceOrphanQuarantines.engineJobId,
              fixture.engineJobId,
            ),
          ),
      ).toHaveLength(0);
    });
  });

  it("never quarantines evidence while its exact sim job is active", async () => {
    await withRollback(async (db) => {
      const fixture = await createFixture(db, { jobStatus: "running" });
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath: fixture.receiptPath,
          mediaRoot: fixture.mediaRoot,
        }),
      ).rejects.toThrow(/not terminal/);
      expect(
        await db
          .select()
          .from(solverEvidenceOrphanQuarantines)
          .where(
            eq(
              solverEvidenceOrphanQuarantines.engineJobId,
              fixture.engineJobId,
            ),
          ),
      ).toHaveLength(0);
    });
  });
});
