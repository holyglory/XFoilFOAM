import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../src/env";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const dbName = `aerodb_evidence_storage_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

const IDS = {
  category: "67000000-0000-0000-0000-000000000001",
  airfoil: "67000000-0000-0000-0000-000000000002",
  medium: "67000000-0000-0000-0000-000000000003",
  bc: "67000000-0000-0000-0000-000000000004",
  resultA: "67000000-0000-0000-0000-000000000005",
  attemptA: "67000000-0000-0000-0000-000000000006",
  bundleA: "67000000-0000-0000-0000-000000000007",
  memberA: "67000000-0000-0000-0000-000000000008",
  resultB: "67000000-0000-0000-0000-000000000009",
  attemptB: "67000000-0000-0000-0000-00000000000a",
  bundleB: "67000000-0000-0000-0000-00000000000b",
  blobA: "67000000-0000-0000-0000-00000000000c",
  blobB: "67000000-0000-0000-0000-00000000000d",
  archiveA: "67000000-0000-0000-0000-00000000000e",
  archiveB: "67000000-0000-0000-0000-00000000000f",
  memberA2: "67000000-0000-0000-0000-000000000010",
} as const;

const OPENCFD_2606_SOLVER_IMPLEMENTATION_ID =
  "2f8bc764-09ae-4ff3-8fd2-260600000001";
const STORED_SHA_A = "c".repeat(64);
const STORED_SHA_B = "d".repeat(64);
const TAR_SHA = "e".repeat(64);

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let through66 = "";
let through67 = "";
let legacyArtifactsBefore: unknown[] = [];

function makeMigrationFolder(upTo: number): string {
  const dir = mkdtempSync(join(tmpdir(), `aerodb-migrations-00${upTo}-`));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= upTo);
  for (const entry of entries) {
    cpSync(join(migrations, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  return dir;
}

async function insertBlob(
  id: string,
  key: string,
  generation: string,
  sha256: string,
) {
  if (!client) throw new Error("migration test database is unavailable");
  await client.unsafe(`
    INSERT INTO solver_evidence_blobs
      (id, backend, bucket, object_key, generation, compression, mime_type,
       sha256, byte_size, crc32c, uncompressed_tar_sha256,
       uncompressed_tar_byte_size, "verifiedAt", metadata)
    VALUES
      ('${id}', 'gcs', 'airfoils-pro-storage-bucket', '${key}',
       '${generation}', 'zstd', 'application/zstd', '${sha256}', 4096,
       'ImIEBA==', '${TAR_SHA}', 8192, now(), '{"verifiedBy":"test"}'::jsonb)
  `);
}

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  client = postgres(targetUrl.toString(), { max: 1 });
  through66 = makeMigrationFolder(66);
  through67 = makeMigrationFolder(67);
  await migrate(drizzle(client), { migrationsFolder: through66 });

  await client.unsafe(`
    INSERT INTO categories (id, slug, name, path)
    VALUES ('${IDS.category}', 'evidence-storage', 'Evidence storage', 'evidence-storage');

    INSERT INTO airfoils (id, slug, name, category_id, source, points)
    VALUES (
      '${IDS.airfoil}', 'evidence-storage-foil', 'Evidence storage foil',
      '${IDS.category}', 'test-coordinates',
      '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb
    );

    INSERT INTO mediums
      (id, slug, name, phase, density, viscosity_model,
       constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity)
    VALUES
      ('${IDS.medium}', 'evidence-storage-air', 'Evidence storage air', 'gas',
       1.225, 'constant', 0.00001789, 0.00001789, 0.000014604);

    INSERT INTO boundary_conditions (id, slug, name, medium_id, reynolds)
    VALUES
      ('${IDS.bc}', 'evidence-storage-bc', 'Evidence storage BC',
       '${IDS.medium}', 100000);

    INSERT INTO results
      (id, airfoil_id, bc_id, aoa_deg, status, source, regime,
       method_key, solver_implementation_id)
    VALUES
      ('${IDS.resultA}', '${IDS.airfoil}', '${IDS.bc}', 0, 'done', 'solved',
       'rans', 'openfoam.rans', '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}'),
      ('${IDS.resultB}', '${IDS.airfoil}', '${IDS.bc}', 1, 'done', 'solved',
       'rans', 'openfoam.rans', '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}');

    INSERT INTO result_attempts
      (id, result_id, airfoil_id, bc_id, aoa_deg, status, source, regime,
       method_key, solver_implementation_id)
    VALUES
      ('${IDS.attemptA}', '${IDS.resultA}', '${IDS.airfoil}', '${IDS.bc}', 0,
       'done', 'solved', 'rans', 'openfoam.rans',
       '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}'),
      ('${IDS.attemptB}', '${IDS.resultB}', '${IDS.airfoil}', '${IDS.bc}', 1,
       'done', 'solved', 'rans', 'openfoam.rans',
       '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}');

    INSERT INTO solver_evidence_artifacts
      (id, result_id, result_attempt_id, airfoil_id, aoa_deg, kind, field,
       role, storage_key, mime_type, sha256, byte_size, metadata, method_key,
       solver_implementation_id)
    VALUES
      ('${IDS.bundleA}', '${IDS.resultA}', '${IDS.attemptA}', '${IDS.airfoil}',
       0, 'openfoam_bundle', NULL, 'raw-evidence',
       'legacy/a/openfoam-evidence.tar.gz', 'application/gzip',
       '${"a".repeat(64)}', 6000, '{"legacy":true}'::jsonb,
       'openfoam.rans', '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}'),
      ('${IDS.memberA}', '${IDS.resultA}', '${IDS.attemptA}', '${IDS.airfoil}',
       0, 'vtk_window', 'velocity', 'mean', 'legacy/a/VTK/0/U.vtu',
       'application/vnd.vtk', '${"b".repeat(64)}', 3000,
       '{"legacy":true}'::jsonb, 'openfoam.rans',
       '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}'),
      ('${IDS.memberA2}', '${IDS.resultA}', '${IDS.attemptA}', '${IDS.airfoil}',
       0, 'log', NULL, 'solver-log', 'legacy/a/log.simpleFoam', 'text/plain',
       '${"1".repeat(64)}', 2000, '{"legacy":true}'::jsonb,
       'openfoam.rans', '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}'),
      ('${IDS.bundleB}', '${IDS.resultB}', '${IDS.attemptB}', '${IDS.airfoil}',
       1, 'openfoam_bundle', NULL, 'raw-evidence',
       'legacy/b/openfoam-evidence.tar.gz', 'application/gzip',
       '${"f".repeat(64)}', 7000, '{"legacy":true}'::jsonb,
       'openfoam.rans', '${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}');
  `);

  legacyArtifactsBefore = await client`
    SELECT id::text, result_id::text, result_attempt_id::text, kind::text,
           field, role, storage_key, mime_type, sha256, byte_size::text,
           metadata, method_key, solver_implementation_id::text,
           "createdAt"::text
    FROM solver_evidence_artifacts
    ORDER BY id
  `;

  await migrate(drizzle(client), { migrationsFolder: through67 });
});

afterAll(async () => {
  await client?.end();
  if (admin) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
  if (through66) rmSync(through66, { recursive: true, force: true });
  if (through67) rmSync(through67, { recursive: true, force: true });
});

describe("0067 solver evidence object storage migration", () => {
  it("leaves every legacy artifact row unchanged and creates no invented archive", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const artifactsAfter = await client`
      SELECT id::text, result_id::text, result_attempt_id::text, kind::text,
             field, role, storage_key, mime_type, sha256, byte_size::text,
             metadata, method_key, solver_implementation_id::text,
             "createdAt"::text
      FROM solver_evidence_artifacts
      ORDER BY id
    `;
    expect(artifactsAfter).toEqual(legacyArtifactsBefore);
    const [counts] = await client<
      Array<{ blobs: number; archives: number; members: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM solver_evidence_blobs) AS blobs,
        (SELECT count(*)::int FROM solver_evidence_archives) AS archives,
        (SELECT count(*)::int FROM solver_evidence_artifact_members) AS members
    `;
    expect(counts).toEqual({ blobs: 0, archives: 0, members: 0 });
  });

  it("stores one verified GCS zstd blob and rejects malformed or duplicate physical identity", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await insertBlob(
      IDS.blobA,
      `sha256/${STORED_SHA_A}/evidence.tar.zst`,
      "1780000000000001",
      STORED_SHA_A,
    );
    const [blob] = await client<
      Array<{
        backend: string;
        compression: string;
        crc32c: string;
        tarSha: string;
        metadata: Record<string, unknown>;
      }>
    >`
      SELECT backend::text, compression::text, crc32c,
             uncompressed_tar_sha256 AS "tarSha", metadata
      FROM solver_evidence_blobs WHERE id = ${IDS.blobA}
    `;
    expect(blob).toEqual({
      backend: "gcs",
      compression: "zstd",
      crc32c: "ImIEBA==",
      tarSha: TAR_SHA,
      metadata: { verifiedBy: "test" },
    });

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_blobs
          (backend, bucket, object_key, generation, compression, mime_type,
           sha256, byte_size, crc32c, uncompressed_tar_sha256,
           uncompressed_tar_byte_size, "verifiedAt")
        VALUES ('volume', 'not-valid-for-volume', 'bad.tar.zst', '1', 'zstd',
                'application/zstd', '${STORED_SHA_B}', 1, 'ImIEBA==',
                '${TAR_SHA}', 1, now())
      `),
    ).rejects.toThrow(/backend_shape/);

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_blobs
          (backend, bucket, object_key, generation, compression, mime_type,
           sha256, byte_size, crc32c, uncompressed_tar_sha256,
           uncompressed_tar_byte_size, "verifiedAt")
        VALUES ('gcs', 'airfoils-pro-storage-bucket', 'bad-sha.tar.zst', '2',
                'zstd', 'application/zstd', 'ABC', 1, 'ImIEBA==',
                '${TAR_SHA}', 1, now())
      `),
    ).rejects.toThrow(/sha256_check/);

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_blobs
          (backend, bucket, object_key, generation, compression, mime_type,
           sha256, byte_size, crc32c, uncompressed_tar_sha256,
           uncompressed_tar_byte_size, "verifiedAt")
        SELECT backend, bucket, object_key, generation, compression, mime_type,
               '${STORED_SHA_B}', byte_size, crc32c, uncompressed_tar_sha256,
               uncompressed_tar_byte_size, "verifiedAt"
        FROM solver_evidence_blobs WHERE id = '${IDS.blobA}'
      `),
    ).rejects.toThrow(/gcs_identity/);

    await expect(
      client.unsafe(`
        UPDATE solver_evidence_blobs SET metadata = '{"changed":true}'::jsonb
        WHERE id = '${IDS.blobA}'
      `),
    ).rejects.toThrow(/immutable/);
  });

  it("enforces exact attempt/source ownership and only one current archive", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await insertBlob(
      IDS.blobB,
      `sha256/${STORED_SHA_B}/evidence.tar.zst`,
      "1780000000000002",
      STORED_SHA_B,
    );
    await client.unsafe(`
      INSERT INTO solver_evidence_archives
        (id, result_id, result_attempt_id, source_artifact_id, blob_id)
      VALUES
        ('${IDS.archiveA}', '${IDS.resultA}', '${IDS.attemptA}',
         '${IDS.bundleA}', '${IDS.blobA}')
    `);

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_archives
          (result_id, result_attempt_id, source_artifact_id, blob_id)
        VALUES ('${IDS.resultA}', '${IDS.attemptA}', '${IDS.bundleA}',
                '${IDS.blobB}')
      `),
    ).rejects.toThrow(/current_attempt/);

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_archives
          (result_id, result_attempt_id, source_artifact_id, blob_id,
           state, "supersededAt")
        VALUES ('${IDS.resultA}', '${IDS.attemptA}', '${IDS.bundleB}',
                '${IDS.blobB}', 'superseded', now())
      `),
    ).rejects.toThrow(/exact owned bundle artifact/);

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_archives
          (result_id, result_attempt_id, source_artifact_id, blob_id,
           state, "supersededAt")
        VALUES ('${IDS.resultA}', '${IDS.attemptB}', '${IDS.bundleB}',
                '${IDS.blobB}', 'superseded', now())
      `),
    ).rejects.toThrow(/exact owned bundle artifact/);

    await client.unsafe(`
      UPDATE solver_evidence_archives
      SET state = 'superseded', "supersededAt" = now()
      WHERE id = '${IDS.archiveA}';
      INSERT INTO solver_evidence_archives
        (id, result_id, result_attempt_id, source_artifact_id, blob_id)
      VALUES
        ('${IDS.archiveB}', '${IDS.resultA}', '${IDS.attemptA}',
         '${IDS.bundleA}', '${IDS.blobB}');
      UPDATE solver_evidence_archives
      SET superseded_by_archive_id = '${IDS.archiveB}'
      WHERE id = '${IDS.archiveA}';
    `);
    const archives = await client<
      Array<{ id: string; state: string; successor: string | null }>
    >`
      SELECT id::text, state::text,
             superseded_by_archive_id::text AS successor
      FROM solver_evidence_archives ORDER BY id
    `;
    expect(archives).toEqual([
      { id: IDS.archiveA, state: "superseded", successor: IDS.archiveB },
      { id: IDS.archiveB, state: "current", successor: null },
    ]);
    await expect(
      client.unsafe(`
        UPDATE solver_evidence_archives
        SET state = 'current', "supersededAt" = NULL,
            superseded_by_archive_id = NULL
        WHERE id = '${IDS.archiveA}'
      `),
    ).rejects.toThrow(/cannot become current|immutable/);
  });

  it("maps logical artifacts to safe archive members without cross-attempt leakage", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await client.unsafe(`
      INSERT INTO solver_evidence_artifact_members
        (archive_id, artifact_id, member_path)
      VALUES
        ('${IDS.archiveB}', '${IDS.memberA}', 'evidence/VTK/0/U.vtu')
    `);
    const [member] = await client<
      Array<{
        memberPath: string;
        artifactStorageKey: string;
        archiveObjectKey: string;
        solverImplementationId: string;
      }>
    >`
      SELECT member.member_path AS "memberPath",
             artifact.storage_key AS "artifactStorageKey",
             blob.object_key AS "archiveObjectKey",
             source.solver_implementation_id::text AS "solverImplementationId"
      FROM solver_evidence_artifact_members member
      JOIN solver_evidence_archives archive ON archive.id = member.archive_id
      JOIN solver_evidence_blobs blob ON blob.id = archive.blob_id
      JOIN solver_evidence_artifacts artifact ON artifact.id = member.artifact_id
      JOIN solver_evidence_artifacts source ON source.id = archive.source_artifact_id
      WHERE member.archive_id = ${IDS.archiveB}
    `;
    expect(member).toEqual({
      memberPath: "evidence/VTK/0/U.vtu",
      artifactStorageKey: "legacy/a/VTK/0/U.vtu",
      archiveObjectKey: `sha256/${STORED_SHA_B}/evidence.tar.zst`,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    });

    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_artifact_members
          (archive_id, artifact_id, member_path)
        VALUES ('${IDS.archiveB}', '${IDS.bundleB}', 'foreign/bundle.tar.gz')
      `),
    ).rejects.toThrow(/same exact result attempt/);
    await expect(
      client.unsafe(`
        INSERT INTO solver_evidence_artifact_members
          (archive_id, artifact_id, member_path)
        VALUES ('${IDS.archiveB}', '${IDS.memberA2}', '../solver.log')
      `),
    ).rejects.toThrow(/path_check/);

    await expect(
      client.unsafe(`
        UPDATE solver_evidence_artifacts
        SET sha256 = '${"2".repeat(64)}'
        WHERE id = '${IDS.memberA}'
      `),
    ).rejects.toThrow(/linked solver evidence artifacts are immutable/);
    await expect(
      client.unsafe(`
        UPDATE solver_evidence_artifacts
        SET storage_key = 'rewritten/source.tar.zst'
        WHERE id = '${IDS.bundleA}'
      `),
    ).rejects.toThrow(/linked solver evidence artifacts are immutable/);
  });
});
