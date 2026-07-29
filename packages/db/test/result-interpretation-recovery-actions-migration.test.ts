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
const dbName = `aerodb_interpretation_recovery_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

const ID = {
  category: "92000000-0000-0000-0000-000000000001",
  airfoil: "92000000-0000-0000-0000-000000000002",
  medium: "92000000-0000-0000-0000-000000000003",
  boundary: "92000000-0000-0000-0000-000000000004",
  result: "92000000-0000-0000-0000-000000000005",
  resultOther: "92000000-0000-0000-0000-000000000006",
  attempt: "92000000-0000-0000-0000-000000000007",
  attemptOther: "92000000-0000-0000-0000-000000000008",
  artifact: "92000000-0000-0000-0000-000000000009",
  artifactOther: "92000000-0000-0000-0000-00000000000a",
  blob: "92000000-0000-0000-0000-00000000000b",
  blobOther: "92000000-0000-0000-0000-00000000000c",
  archive: "92000000-0000-0000-0000-00000000000d",
  archiveOther: "92000000-0000-0000-0000-00000000000e",
} as const;

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let migrationDir = "";

function migrationFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), "aerodb-migrations-0096-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ idx: number; tag: string }> };
  const entries = journal.entries.filter((entry) => entry.idx <= 96);
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
  migrationDir = migrationFolder();
  await migrate(drizzle(client), { migrationsFolder: migrationDir });

  // Two exact immutable generations give the tests a positive archive owner
  // and separate, real foreign-key mismatch cases.  These are intentionally
  // minimal: recovery-action constraints must not depend on a scheduler job.
  await client.unsafe(`
    INSERT INTO categories (id, slug, name, path)
    VALUES ('${ID.category}', 'recovery-actions', 'Recovery actions', 'recovery-actions');
    INSERT INTO airfoils (id, slug, name, category_id, source, points)
    VALUES (
      '${ID.airfoil}', 'recovery-actions-foil', 'Recovery actions foil',
      '${ID.category}', 'test-coordinates',
      '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb
    );
    INSERT INTO mediums
      (id, slug, name, phase, density, viscosity_model,
       constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity)
    VALUES
      ('${ID.medium}', 'recovery-actions-air', 'Recovery actions air', 'gas',
       1.225, 'constant', 0.00001789, 0.00001789, 0.000014604);
    INSERT INTO boundary_conditions (id, slug, name, medium_id, reynolds)
    VALUES
      ('${ID.boundary}', 'recovery-actions-bc', 'Recovery actions BC',
       '${ID.medium}', 100000);
    INSERT INTO results
      (id, airfoil_id, bc_id, aoa_deg, status, source, regime)
    VALUES
      ('${ID.result}', '${ID.airfoil}', '${ID.boundary}', 3, 'done', 'solved', 'urans'),
      ('${ID.resultOther}', '${ID.airfoil}', '${ID.boundary}', 4, 'done', 'solved', 'urans');
    INSERT INTO result_attempts
      (id, result_id, airfoil_id, bc_id, aoa_deg, status, source, regime)
    VALUES
      ('${ID.attempt}', '${ID.result}', '${ID.airfoil}', '${ID.boundary}', 3,
       'done', 'solved', 'urans'),
      ('${ID.attemptOther}', '${ID.resultOther}', '${ID.airfoil}', '${ID.boundary}', 4,
       'done', 'solved', 'urans');
    INSERT INTO solver_evidence_artifacts
      (id, result_id, result_attempt_id, airfoil_id, aoa_deg, kind,
       storage_key, mime_type, sha256, byte_size, metadata)
    VALUES
      ('${ID.artifact}', '${ID.result}', '${ID.attempt}', '${ID.airfoil}', 3,
       'openfoam_bundle', 'test/recovery/source-a.tar.zst', 'application/zstd',
       '${SHA_A}', 101, '{}'::jsonb),
      ('${ID.artifactOther}', '${ID.resultOther}', '${ID.attemptOther}', '${ID.airfoil}', 4,
       'openfoam_bundle', 'test/recovery/source-b.tar.zst', 'application/zstd',
       '${SHA_B}', 102, '{}'::jsonb);
    INSERT INTO solver_evidence_blobs
      (id, backend, bucket, object_key, generation, compression, mime_type,
       sha256, byte_size, crc32c, uncompressed_tar_sha256,
       uncompressed_tar_byte_size, "verifiedAt", metadata)
    VALUES
      ('${ID.blob}', 'gcs', 'test-bucket', 'test/recovery/a.tar.zst', '1', 'zstd',
       'application/zstd', '${SHA_A}', 101, 'AAAAAA==', '${SHA_B}', 202, now(), '{}'::jsonb),
      ('${ID.blobOther}', 'gcs', 'test-bucket', 'test/recovery/b.tar.zst', '2', 'zstd',
       'application/zstd', '${SHA_B}', 102, 'AAAAAA==', '${SHA_A}', 203, now(), '{}'::jsonb);
    INSERT INTO solver_evidence_archives
      (id, result_id, result_attempt_id, source_artifact_id, blob_id, state)
    VALUES
      ('${ID.archive}', '${ID.result}', '${ID.attempt}', '${ID.artifact}', '${ID.blob}', 'current'),
      ('${ID.archiveOther}', '${ID.resultOther}', '${ID.attemptOther}', '${ID.artifactOther}', '${ID.blobOther}', 'current');
  `);
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
  if (migrationDir) rmSync(migrationDir, { recursive: true, force: true });
});

function actionValues(overrides: Record<string, string | null> = {}) {
  return {
    resultId: ID.result,
    resultAttemptId: ID.attempt,
    sourceArchiveId: ID.archive,
    inputEvidenceSignature: SHA_A,
    fidelity: "urans_precalc",
    requestedAction: "continue_exact_case",
    correctiveTailPeriods: null,
    state: "pending",
    ...overrides,
  };
}

async function insertAction(values: ReturnType<typeof actionValues>) {
  if (!client) throw new Error("migration test database is unavailable");
  const literal = (value: string | null) =>
    value == null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
  await client.unsafe(`
    INSERT INTO result_interpretation_recovery_actions
      (result_id, result_attempt_id, source_archive_id, input_evidence_signature,
       fidelity, requested_action, corrective_tail_periods, state, claim_token, claim_expires_at,
       target_urans_request_id, target_verify_queue_id)
    VALUES
      (${literal(values.resultId)}::uuid, ${literal(values.resultAttemptId)}::uuid,
       ${literal(values.sourceArchiveId)}::uuid, ${literal(values.inputEvidenceSignature)},
       ${literal(values.fidelity)}, ${literal(values.requestedAction)},
       ${literal(values.correctiveTailPeriods)}, ${literal(values.state)},
       ${literal(values.claimToken ?? null)}::uuid,
       ${values.claimExpiresAt == null ? "NULL" : `${literal(values.claimExpiresAt)}::timestamptz`},
       ${literal(values.targetUransRequestId ?? null)}::uuid,
       ${literal(values.targetVerifyQueueId ?? null)}::uuid)
  `);
}

describe("0094-0096 result interpretation recovery actions migrations", () => {
  it("makes each active request or verify queue an exclusive archive-recovery receipt", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const indexes = await client<{
      indexname: string;
      indexdef: string;
    }[]>`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'result_interpretation_recovery_actions'
        AND indexname IN (
          'ri_recovery_active_request_owner_uq',
          'ri_recovery_active_verify_owner_uq'
        )
      ORDER BY indexname ASC
    `;
    expect(indexes.map((index) => index.indexname)).toEqual([
      "ri_recovery_active_request_owner_uq",
      "ri_recovery_active_verify_owner_uq",
    ]);
    for (const index of indexes) {
      expect(index.indexdef).toContain("UNIQUE INDEX");
      expect(index.indexdef).toContain("WHERE");
    }
  });

  it("MUST-CATCH: a routed recovery receipt blocks deletion of its request or verify target instead of being nulled into an invalid routed state", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const foreignKeys = await client<
      Array<{ columnName: string; confdeltype: string }>
    >`
      SELECT attribute.attname AS "columnName", constraint_row.confdeltype
      FROM pg_constraint constraint_row
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = ANY(constraint_row.conkey)
      WHERE constraint_row.conrelid = 'public.result_interpretation_recovery_actions'::regclass
        AND constraint_row.contype = 'f'
        AND attribute.attname IN (
          'target_urans_request_id',
          'target_verify_queue_id'
        )
      ORDER BY attribute.attname
    `;
    expect(foreignKeys).toEqual([
      {
        columnName: "target_urans_request_id",
        confdeltype: "r",
      },
      {
        columnName: "target_verify_queue_id",
        confdeltype: "r",
      },
    ]);
  });

  it("owns one idempotent recovery action for one immutable source archive and fidelity", async () => {
    await insertAction(actionValues());
    await expect(
      insertAction(
        actionValues({
          inputEvidenceSignature: SHA_B,
          requestedAction: "verify_restart_proof_then_rerun",
        }),
      ),
    ).rejects.toThrow(/result_interpretation_recovery_actions_source_fidelity_uq/);
  });

  it("rejects cross-generation result and archive ownership", async () => {
    await expect(
      insertAction(
        actionValues({
          resultId: ID.resultOther,
          fidelity: "urans_full",
        }),
      ),
    ).rejects.toThrow(/result_interpretation_recovery_actions_attempt_owner_fk/);
    await expect(
      insertAction(
        actionValues({
          sourceArchiveId: ID.archiveOther,
          fidelity: "urans_full",
        }),
      ),
    ).rejects.toThrow(/result_interpretation_recovery_actions_archive_owner_fk/);
  });

  it("requires an exclusive routing lease while state is routing", async () => {
    await expect(
      insertAction(
        actionValues({
          fidelity: "urans_full",
          state: "routing",
        }),
      ),
    ).rejects.toThrow(/result_interpretation_recovery_actions_lease_shape_check/);
    await expect(
      insertAction(
        actionValues({
          fidelity: "urans_full",
          claimToken: "92000000-0000-4000-8000-00000000000f",
          claimExpiresAt: "2026-07-28T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/result_interpretation_recovery_actions_lease_shape_check/);
  });

  it("rejects a routing target that tries to name both request and verify work", async () => {
    // The check is evaluated before its foreign-key targets, which verifies
    // the action cannot ambiguously authorize two physical scheduler lanes.
    await expect(
      insertAction(
        actionValues({
          fidelity: "urans_full",
          targetUransRequestId: "92000000-0000-4000-8000-000000000010",
          targetVerifyQueueId: "92000000-0000-4000-8000-000000000011",
        }),
      ),
    ).rejects.toThrow(/result_interpretation_recovery_actions_target_shape_check/);
  });

  it("rejects an archive continuation tail outside the bounded one-to-three-period contract", async () => {
    const valid = actionValues({
      resultId: ID.resultOther,
      resultAttemptId: ID.attemptOther,
      sourceArchiveId: ID.archiveOther,
      fidelity: "urans_full",
      correctiveTailPeriods: "3",
    });
    await insertAction(valid);

    for (const tail of ["0", "4"]) {
      await expect(
        insertAction(
          actionValues({
            resultId: ID.resultOther,
            resultAttemptId: ID.attemptOther,
            sourceArchiveId: ID.archiveOther,
            fidelity: "urans_precalc",
            correctiveTailPeriods: tail,
          }),
        ),
      ).rejects.toThrow(
        /ri_recovery_tail_periods_ck/,
      );
    }
  });
});

