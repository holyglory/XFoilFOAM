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
const dbName = `aerodb_disposable_generations_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;
const DISCARDED_BLOB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let beforeRemovalDir = "";
let removalDir = "";

function migrationFolder(upTo: number): string {
  const dir = mkdtempSync(join(tmpdir(), `aerodb-migrations-0${upTo}-`));
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

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  client = postgres(targetUrl.toString(), { max: 1 });
  beforeRemovalDir = migrationFolder(120);
  removalDir = migrationFolder(121);
  await migrate(drizzle(client), { migrationsFolder: beforeRemovalDir });
}, 120_000);

afterAll(async () => {
  await client?.end();
  if (admin) {
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
    await admin.end();
  }
  for (const dir of [beforeRemovalDir, removalDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("0121 disposable failed-generation migration", () => {
  it("rehearses a 0120 production-shaped schema through removal of only the obsolete forensic tables", async () => {
    if (!client) throw new Error("migration test database is unavailable");

    // Seed the exact old ownership shape without needing a complete CFD graph.
    // The obsolete quarantine owner disappears, while the content-addressed
    // locator remains until the operator has deleted and verified the exact
    // external GCS generation.
    await client.unsafe(`
      SET session_replication_role = replica;
      INSERT INTO sim_jobs (
        id, airfoil_id, bc_ids, reference_chord_m, status, total_cases, completed_cases
      ) VALUES (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        '[]'::jsonb, 1, 'failed', 0, 0
      );
      INSERT INTO solver_evidence_blobs (
        id, backend, bucket, object_key, generation, compression, mime_type,
        sha256, byte_size, crc32c, uncompressed_tar_sha256,
        uncompressed_tar_byte_size, "verifiedAt", metadata
      ) VALUES (
        '${DISCARDED_BLOB_ID}', 'gcs', 'test-bucket',
        'solver-evidence-partial/v1/sha256/aa/discarded.tar.zst', '9001',
        'zstd', 'application/zstd', '${"a".repeat(64)}', 117179656,
        'AAAAAA==', '${"b".repeat(64)}', 117179656, now(), '{}'::jsonb
      );
      INSERT INTO solver_evidence_incomplete_quarantines (
        sim_job_id, engine_job_id, engine_case_slug, evidence_path,
        blob_id, original_manifest_sha256, original_manifest_byte_size,
        expected_member_set_sha256, expected_member_count,
        retained_member_set_sha256, retained_member_count,
        missing_member_set_sha256, missing_member_count,
        expected_members, retained_members, missing_members, source_archives,
        package_manifest_sha256, package_manifest_byte_size,
        package_member_set_sha256, package_member_count, package_members,
        migration_receipt_sha256, migration_receipt_byte_size,
        verification_mode, "remoteVerifiedAt"
      ) VALUES (
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'discarded-engine',
        'case-a0', 'cases/a0/evidence', '${DISCARDED_BLOB_ID}',
        '${"c".repeat(64)}', 1, '${"d".repeat(64)}', 1,
        '${"e".repeat(64)}', 1, '${"f".repeat(64)}', 0,
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[{}]'::jsonb,
        '${"1".repeat(64)}', 1, '${"2".repeat(64)}', 1, '[]'::jsonb,
        '${"3".repeat(64)}', 1, 'generation-pinned', now()
      );
      SET session_replication_role = DEFAULT;
    `);

    const [before] = await client<{
      terminal_uploads: string | null;
      incomplete_quarantines: string | null;
      canonical_archives: string | null;
      discarded_blob: string | null;
    }>`
      SELECT
        to_regclass('public.sync_remote_terminal_evidence_uploads')::text AS terminal_uploads,
        to_regclass('public.solver_evidence_incomplete_quarantines')::text AS incomplete_quarantines,
        to_regclass('public.solver_evidence_archives')::text AS canonical_archives,
        (SELECT id::text FROM solver_evidence_blobs WHERE id = ${DISCARDED_BLOB_ID}) AS discarded_blob
    `;
    expect(before).toEqual({
      terminal_uploads: "sync_remote_terminal_evidence_uploads",
      incomplete_quarantines: "solver_evidence_incomplete_quarantines",
      canonical_archives: "solver_evidence_archives",
      discarded_blob: DISCARDED_BLOB_ID,
    });

    await migrate(drizzle(client), { migrationsFolder: removalDir });

    const [after] = await client<{
      obsolete_tables: number;
      obsolete_functions: number;
      canonical_archives: string | null;
      discarded_blob: string | null;
      artifact_guard_mentions_orphans: boolean;
    }>`
      SELECT
        (
          SELECT count(*)::int
          FROM pg_class
          WHERE oid IN (
            to_regclass('public.sync_remote_terminal_evidence_uploads'),
            to_regclass('public.sync_remote_terminal_evidence_receipts'),
            to_regclass('public.sync_brokered_terminal_evidence_uploads'),
            to_regclass('public.solver_evidence_incomplete_quarantines'),
            to_regclass('public.solver_evidence_orphan_quarantines')
          )
        ) AS obsolete_tables,
        (
          SELECT count(*)::int
          FROM pg_proc
          WHERE oid IN (
            to_regprocedure('public.enforce_solver_evidence_incomplete_quarantine()'),
            to_regprocedure('public.enforce_solver_evidence_orphan_quarantine()'),
            to_regprocedure('public.prevent_remote_terminal_evidence_receipt_mutation()')
          )
        ) AS obsolete_functions,
        to_regclass('public.solver_evidence_archives')::text AS canonical_archives,
        (SELECT id::text FROM solver_evidence_blobs WHERE id = ${DISCARDED_BLOB_ID}) AS discarded_blob,
        pg_get_functiondef(
          to_regprocedure('public.reject_linked_solver_evidence_artifact_update()')
        ) LIKE '%solver_evidence_orphan_quarantines%' AS artifact_guard_mentions_orphans
    `;
    expect(after).toEqual({
      obsolete_tables: 0,
      obsolete_functions: 0,
      canonical_archives: "solver_evidence_archives",
      discarded_blob: DISCARDED_BLOB_ID,
      artifact_guard_mentions_orphans: false,
    });
  }, 120_000);
});
