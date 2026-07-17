import {
  airfoils,
  categories,
  type DB,
  simJobs,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  solverEvidenceOrphanQuarantines,
} from "@aerodb/db";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerEvidenceQuarantineRoutes } from "../src/admin-routes";
import { db } from "../src/db";

const PREFIX = `api-orphan-${process.pid}-${Date.now().toString(36)}`;
const ORIGINAL_ENV = { ...process.env };
const ROLLBACK = new Error("rollback immutable quarantine API fixture");
const archiveBytes = Buffer.from("genuine zstandard archive bytes");
const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

interface Fixture {
  quarantineId: string;
  artifactId: string;
  artifactStorageKey: string;
  blobId: string;
  simJobId: string;
  engineJobId: string;
  caseSlug: string;
  evidencePath: string;
  bucket: string;
  objectKey: string;
  generation: string;
  storedSha256: string;
  migrationReceiptSha256: string;
  migrationReceiptByteSize: number;
}

function memberSetSha256(
  rows: Array<{ path: string; sha256: string; byteSize: number }>,
): string {
  const hash = createHash("sha256");
  for (const row of [...rows].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  )) {
    hash.update(row.path);
    hash.update("\0");
    hash.update(row.sha256);
    hash.update("\0");
    hash.update(String(row.byteSize));
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function withRollbackFixture(
  run: (testDb: DB, fixture: Fixture) => Promise<void>,
): Promise<void> {
  try {
    await db.transaction(async (rawTx) => {
      const testDb = rawTx as unknown as DB;
      const fixture = await createFixture(testDb, {
        createdAt: new Date("2100-01-01T00:00:00.000Z"),
      });
      await run(testDb, fixture);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

async function createFixture(
  testDb: DB,
  options: { createdAt?: Date } = {},
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
  const engineJobId = `${token}-engine`;
  const caseSlug = `${token}-case`;
  const evidencePath = `cases/${caseSlug}/a14/evidence`;
  const [job] = await testDb
    .insert(simJobs)
    .values({
      airfoilId: airfoil.id,
      bcIds: [],
      referenceChordM: 0.1,
      status: "failed",
      engineJobId,
      totalCases: 1,
      completedCases: 1,
      finishedAt: new Date(),
    })
    .returning();

  const storedSha256 = sha256(archiveBytes);
  const bucket = "airfoils-pro-storage-bucket";
  const objectKey = `${token}/sha256/${storedSha256.slice(0, 2)}/${storedSha256}.tar.zst`;
  const generation = "18446744073709551615";
  const [blob] = await testDb
    .insert(solverEvidenceBlobs)
    .values({
      backend: "gcs",
      bucket,
      objectKey,
      generation,
      compression: "zstd",
      mimeType: "application/zstd",
      sha256: storedSha256,
      byteSize: archiveBytes.byteLength,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: sha256("tar stream"),
      uncompressedTarByteSize: 128,
      verifiedAt: new Date("2026-07-17T08:01:00.000Z"),
      metadata: {},
    })
    .returning();
  const storageKey = `jobs/${engineJobId}/${evidencePath}/engine_evidence.tar.zst`;
  const [artifact] = await testDb
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: null,
      resultAttemptId: null,
      airfoilId: airfoil.id,
      simJobId: job.id,
      engineJobId,
      engineCaseSlug: caseSlug,
      aoaDeg: null,
      kind: "engine_bundle",
      role: "evidence",
      storageKey,
      mimeType: "application/zstd",
      sha256: storedSha256,
      byteSize: archiveBytes.byteLength,
      metadata: {},
    })
    .returning();

  const manifest = Buffer.from('{"schemaVersion":2,"files":[]}');
  const members = [
    {
      path: "evidence_manifest.json",
      sha256: sha256(manifest),
      byteSize: manifest.byteLength,
    },
  ];
  const receipt = Buffer.from('{"state":"awaiting_database_registration"}');
  const migrationReceiptSha256 = sha256(receipt);
  const [quarantine] = await testDb
    .insert(solverEvidenceOrphanQuarantines)
    .values({
      simJobId: job.id,
      engineJobId,
      engineCaseSlug: caseSlug,
      evidencePath,
      quarantineReason: "terminal_engine_evidence_not_ingested",
      sourceArtifactId: artifact.id,
      blobId: blob.id,
      manifestSha256: sha256(manifest),
      manifestByteSize: manifest.byteLength,
      archiveMemberSetSha256: memberSetSha256(members),
      archiveMemberCount: members.length,
      archiveMembers: members,
      sourceArchives: [
        {
          path: "openfoam_evidence.tar.gz",
          compression: "gzip",
          sha256: sha256("source gzip"),
          byteSize: 256,
        },
      ],
      migrationReceiptSha256,
      migrationReceiptByteSize: receipt.byteLength,
      verificationMode: "archive+manifest+all-members-restore:0",
      remoteVerifiedAt: new Date("2026-07-17T08:01:00.000Z"),
      ...(options.createdAt == null ? {} : { createdAt: options.createdAt }),
    })
    .returning();
  return {
    quarantineId: quarantine.id,
    artifactId: artifact.id,
    artifactStorageKey: storageKey,
    blobId: blob.id,
    simJobId: job.id,
    engineJobId,
    caseSlug,
    evidencePath,
    bucket,
    objectKey,
    generation,
    storedSha256,
    migrationReceiptSha256,
    migrationReceiptByteSize: receipt.byteLength,
  };
}

async function withApp(
  testDb: DB,
  run: (app: ReturnType<typeof Fastify>) => Promise<void>,
): Promise<void> {
  const app = Fastify({ logger: false });
  app.setErrorHandler(
    (error: Error & { statusCode?: number }, _request, reply) => {
      reply.code(error.statusCode ?? 500).send({ error: error.message });
    },
  );
  await registerEvidenceQuarantineRoutes(app, testDb);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("admin orphan-evidence quarantine", () => {
  it("is protected by the admin pre-handler", async () => {
    await withRollbackFixture(async (testDb) => {
      process.env.ADMIN_AUTH_DISABLED = "false";
      process.env.ADMIN_AUTH_REQUIRED = "true";
      await withApp(testDb, async (app) => {
        const response = await app.inject({
          method: "GET",
          url: "/api/admin/evidence-quarantine",
        });
        expect(response.statusCode).toBe(401);
      });
    });
  });

  it("lists exact provenance without presenting a result owner", async () => {
    await withRollbackFixture(async (testDb, fixture) => {
      process.env.ADMIN_AUTH_DISABLED = "true";
      process.env.ADMIN_AUTH_REQUIRED = "false";
      await withApp(testDb, async (app) => {
        const list = await app.inject({
          method: "GET",
          url: "/api/admin/evidence-quarantine",
        });
        expect(list.statusCode).toBe(200);
        expect(list.headers["cache-control"]).toBe("private, no-store");
        const item = list
          .json()
          .items.find(
            (value: { id: string }) => value.id === fixture.quarantineId,
          );
        expect(item).toMatchObject({
          id: fixture.quarantineId,
          preservationKind: "orphan_evidence_quarantine",
          quarantineReason: "terminal_engine_evidence_not_ingested",
          resultOwner: null,
          engineJobId: fixture.engineJobId,
          engineCaseSlug: fixture.caseSlug,
          evidencePath: fixture.evidencePath,
          simJobId: fixture.simJobId,
          sourceArtifactId: fixture.artifactId,
          generation: fixture.generation,
          downloadUrl: `/api/admin/evidence-quarantine/${fixture.quarantineId}/download`,
        });

        const details = await app.inject({
          method: "GET",
          url: `/api/admin/evidence-quarantine/${fixture.quarantineId}`,
        });
        expect(details.statusCode).toBe(200);
        expect(details.headers["cache-control"]).toBe("private, no-store");
        expect(details.json()).toMatchObject({
          id: fixture.quarantineId,
          quarantineReason: "terminal_engine_evidence_not_ingested",
          resultOwner: null,
          simJobId: fixture.simJobId,
          archiveMemberCount: 1,
          verificationMode: "archive+manifest+all-members-restore:0",
          migrationReceipt: {
            sha256: fixture.migrationReceiptSha256,
            byteSize: fixture.migrationReceiptByteSize,
          },
          sourceArtifact: {
            id: fixture.artifactId,
            resultId: null,
            resultAttemptId: null,
            simJobId: fixture.simJobId,
            engineJobId: fixture.engineJobId,
            engineCaseSlug: fixture.caseSlug,
            methodKey: null,
            solverImplementationId: null,
            solverRuntimeBuildId: null,
            aoaDeg: null,
            kind: "engine_bundle",
            field: null,
            role: "evidence",
            storageKey: fixture.artifactStorageKey,
            mimeType: "application/zstd",
            sha256: fixture.storedSha256,
            byteSize: archiveBytes.byteLength,
          },
          blob: {
            id: fixture.blobId,
            backend: "gcs",
            bucket: fixture.bucket,
            objectKey: fixture.objectKey,
            generation: fixture.generation,
            compression: "zstd",
            mimeType: "application/zstd",
            sha256: fixture.storedSha256,
            byteSize: archiveBytes.byteLength,
            crc32c: "AAAAAA==",
            uncompressedTarSha256: sha256("tar stream"),
            uncompressedTarByteSize: 128,
          },
        });
      });
    });
  });

  it("keyset-pages past the first 100 immutable quarantines without overlap", async () => {
    await withRollbackFixture(async (testDb) => {
      process.env.ADMIN_AUTH_DISABLED = "true";
      process.env.ADMIN_AUTH_REQUIRED = "false";
      const fixtureIds = new Set<string>();
      const sharedCreatedAt = new Date("2101-01-01T00:00:00.123Z");
      for (let index = 0; index < 101; index += 1) {
        const fixture = await createFixture(testDb, {
          createdAt: sharedCreatedAt,
        });
        fixtureIds.add(fixture.quarantineId);
      }

      await withApp(testDb, async (app) => {
        const first = await app.inject({
          method: "GET",
          url: "/api/admin/evidence-quarantine?limit=100",
        });
        expect(first.statusCode).toBe(200);
        expect(first.headers["cache-control"]).toBe("private, no-store");
        const firstBody = first.json<{
          items: Array<{ id: string }>;
          nextCursor: string | null;
        }>();
        expect(firstBody.items).toHaveLength(100);
        expect(firstBody.nextCursor).not.toBeNull();
        expect(firstBody.items.every((item) => fixtureIds.has(item.id))).toBe(
          true,
        );

        const second = await app.inject({
          method: "GET",
          url: `/api/admin/evidence-quarantine?limit=100&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
        });
        expect(second.statusCode).toBe(200);
        expect(second.headers["cache-control"]).toBe("private, no-store");
        const secondBody = second.json<{
          items: Array<{ id: string }>;
          nextCursor: string | null;
        }>();
        const firstIds = new Set(firstBody.items.map((item) => item.id));
        expect(secondBody.items.some((item) => firstIds.has(item.id))).toBe(
          false,
        );
        const seenFixtures = new Set(
          [...firstBody.items, ...secondBody.items]
            .map((item) => item.id)
            .filter((id) => fixtureIds.has(id)),
        );
        expect(seenFixtures.size).toBe(101);
      });
    });
  }, 120_000);

  it("returns private 400 responses for malformed limits, cursors, and ids", async () => {
    await withRollbackFixture(async (testDb, fixture) => {
      process.env.ADMIN_AUTH_DISABLED = "true";
      process.env.ADMIN_AUTH_REQUIRED = "false";
      await withApp(testDb, async (app) => {
        for (const query of [
          "limit=0",
          "limit=101",
          "limit=not-a-number",
          "cursor=not-a-cursor",
          `cursor=${encodeURIComponent(`2026-02-31T00:00:00.000000Z|${fixture.quarantineId}`)}`,
          `cursor=${encodeURIComponent(`0000-01-01T00:00:00.000000Z|${fixture.quarantineId}`)}`,
        ]) {
          const response = await app.inject({
            method: "GET",
            url: `/api/admin/evidence-quarantine?${query}`,
          });
          expect(response.statusCode).toBe(400);
          expect(response.headers["cache-control"]).toBe("private, no-store");
        }

        for (const suffix of ["", "/download"]) {
          const response = await app.inject({
            method: "GET",
            url: `/api/admin/evidence-quarantine/not-a-uuid${suffix}`,
          });
          expect(response.statusCode).toBe(400);
          expect(response.headers["cache-control"]).toBe("private, no-store");
          expect(response.json().error).toContain("invalid quarantine id");
        }
      });
    });
  });

  it("downloads only through the exact generation-pinned gateway identity", async () => {
    await withRollbackFixture(async (testDb, fixture) => {
      process.env.ADMIN_AUTH_DISABLED = "true";
      process.env.ADMIN_AUTH_REQUIRED = "false";
      const fetchMock = vi.fn(async () => {
        return new Response(archiveBytes, {
          status: 200,
          headers: {
            "content-type": "application/zstd",
            "content-length": String(archiveBytes.byteLength),
            "x-content-sha256": fixture.storedSha256,
            "x-gcs-generation": fixture.generation,
          },
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      await withApp(testDb, async (app) => {
        const response = await app.inject({
          method: "GET",
          url: `/api/admin/evidence-quarantine/${fixture.quarantineId}/download`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("application/zstd");
        expect(response.headers["x-content-sha256"]).toBe(fixture.storedSha256);
        expect(response.headers["x-gcs-generation"]).toBe(fixture.generation);
        expect(response.rawPayload).toEqual(archiveBytes);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
      expect(requestUrl.pathname).toContain(
        `/jobs/${fixture.engineJobId}/files/${fixture.evidencePath}/engine_evidence.tar.zst`,
      );
      expect(requestUrl.searchParams.get("expected_bucket")).toBe(
        fixture.bucket,
      );
      expect(requestUrl.searchParams.get("expected_object_key")).toBe(
        fixture.objectKey,
      );
      expect(requestUrl.searchParams.get("expected_generation")).toBe(
        fixture.generation,
      );
      expect(requestUrl.searchParams.get("expected_stored_sha256")).toBe(
        fixture.storedSha256,
      );
      expect(requestUrl.searchParams.get("expected_stored_size")).toBe(
        String(archiveBytes.byteLength),
      );
    });
  });

  it("rejects a gateway response whose asserted immutable identity drifts", async () => {
    await withRollbackFixture(async (testDb, fixture) => {
      process.env.ADMIN_AUTH_DISABLED = "true";
      process.env.ADMIN_AUTH_REQUIRED = "false";
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(archiveBytes, {
              status: 200,
              headers: {
                "content-type": "application/zstd",
                "content-length": String(archiveBytes.byteLength),
                "x-content-sha256": "0".repeat(64),
                "x-gcs-generation": fixture.generation,
              },
            }),
        ),
      );
      await withApp(testDb, async (app) => {
        const response = await app.inject({
          method: "GET",
          url: `/api/admin/evidence-quarantine/${fixture.quarantineId}/download`,
        });
        expect(response.statusCode).toBe(502);
        expect(response.json().error).toContain("integrity verification");
      });
    });
  });
});
