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

import type { DB } from "../src/client";
import { migrateWithResultInterpretationLedgerPreflight } from "../src/result-interpretation-ledger-migration-runner";
import { databaseUrl } from "../src/env";
import { readResultInterpretationLedgerPreflight } from "../src/result-interpretation-ledger-preflight";

const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../migrations");
const dbName = `aerodb_interpretation_reconcile_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${dbName}`;

const LEGACY_TIMESTAMP = {
  promiseFailover: 1788739200000,
  resultMediaIndex: 1788825600000,
  ingestCompletion: 1788912000000,
} as const;
const FINAL_RECONCILIATION_TIMESTAMP = 1789516800000;
const FIRST_LEDGER_TIMESTAMP = 1788998400000;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let baselineDir = "";

function migrationFolder(upTo: number): string {
  const dir = mkdtempSync(join(tmpdir(), `aerodb-migrations-00${upTo}-`));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(
    readFileSync(join(migrations, "meta/_journal.json"), "utf8"),
  ) as {
    entries: Array<{ idx: number; tag: string }>;
  };
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

async function ensureHistorical0093IngestCompletionAnchor() {
  if (!client) throw new Error("migration test database is unavailable");
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS result_attempt_ingest_completions (
      result_attempt_id uuid PRIMARY KEY NOT NULL,
      result_id uuid NOT NULL,
      projection_version integer NOT NULL,
      payload_signature text NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT result_attempt_ingest_completions_attempt_owner_fk
        FOREIGN KEY (result_attempt_id, result_id)
        REFERENCES result_attempts(id, result_id)
        ON DELETE CASCADE,
      CONSTRAINT result_attempt_ingest_completions_projection_version_check
        CHECK (projection_version > 0),
      CONSTRAINT result_attempt_ingest_completions_payload_signature_check
        CHECK (payload_signature ~ '^[0-9a-f]{64}$')
    );
  `);
}

async function applyHistorical0091Through0093() {
  if (!client) throw new Error("migration test database is unavailable");
  await client.unsafe(`
    ALTER TABLE sync_api_settings
      ALTER COLUMN default_promise_ttl_hours SET DEFAULT 72;
    UPDATE sync_api_settings
    SET default_promise_ttl_hours = 72,
        "updatedAt" = now()
    WHERE default_promise_ttl_hours = 24;
    CREATE INDEX IF NOT EXISTS result_media_storage_key_idx
      ON result_media (storage_key);
  `);
  await ensureHistorical0093IngestCompletionAnchor();
  await client.unsafe(`
    INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    VALUES
      ('historical-0091-remote-promise-failover-lease', ${LEGACY_TIMESTAMP.promiseFailover}),
      ('historical-0092-result-media-storage-key-index', ${LEGACY_TIMESTAMP.resultMediaIndex}),
      ('historical-0093-result-attempt-ingest-completion', ${LEGACY_TIMESTAMP.ingestCompletion});
  `);
}

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  client = postgres(targetUrl.toString(), { max: 1 });
  baselineDir = migrationFolder(90);
  await migrate(drizzle(client), { migrationsFolder: baselineDir });
  await applyHistorical0091Through0093();
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
  if (baselineDir) rmSync(baselineDir, { recursive: true, force: true });
});

describe("0096–0100 result interpretation ledger reconciliation", () => {
  it("accepts a truly fresh disposable database with no journal or application anchors", async () => {
    if (!admin) throw new Error("migration test admin database is unavailable");
    const freshName = `${dbName}_fresh`;
    const freshUrl = new URL(baseUrl);
    freshUrl.pathname = `/${freshName}`;
    let fresh: ReturnType<typeof postgres> | null = null;
    try {
      await admin.unsafe(`CREATE DATABASE "${freshName}"`);
      fresh = postgres(freshUrl.toString(), { max: 1 });
      await expect(
        readResultInterpretationLedgerPreflight(drizzle(fresh) as unknown as DB),
      ).resolves.toEqual({
        state: "fresh",
        footprintPresent: false,
        issues: [],
      });
    } finally {
      await fresh?.end();
      await admin.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${freshName}'`,
      );
      await admin.unsafe(`DROP DATABASE IF EXISTS "${freshName}"`);
    }
  }, 30_000);

  it("upgrades a production-shaped timestamp collision through the legacy archive-gap ledger without replaying historical migrations", async () => {
    if (!client) throw new Error("migration test database is unavailable");

    const readerDb = drizzle(client) as unknown as DB;
    // First prove the read-only production gate accepts the exact 0000..0093
    // journal plus its historical anchors, then prove it rejects the common
    // false-positive shapes before the real migration is allowed to start.
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "preledger_0093",
      issues: [],
    });

    await client.unsafe(`
      DELETE FROM drizzle.__drizzle_migrations
      WHERE created_at = ${LEGACY_TIMESTAMP.resultMediaIndex};
    `);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "incompatible",
    });
    // This is the exact routine called by `pnpm db:migrate`: malformed real
    // journal state must fail before Drizzle can create a 0094–0099 table.
    await expect(
      migrateWithResultInterpretationLedgerPreflight(readerDb, migrations),
    ).rejects.toThrow(/refusing result-interpretation ledger migration/);
    const [noLedgerAfterRejectedCli] = await client<
      Array<{ present: boolean }>
    >`SELECT to_regclass('public.result_reducer_versions') IS NOT NULL AS present`;
    expect(noLedgerAfterRejectedCli?.present).toBe(false);
    await client.unsafe(`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES ('restored-0092-result-media-storage-key-index', ${LEGACY_TIMESTAMP.resultMediaIndex});
    `);

    await client.unsafe(`
      UPDATE drizzle.__drizzle_migrations
      SET created_at = 1
      WHERE created_at = ${LEGACY_TIMESTAMP.promiseFailover};
    `);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "incompatible",
    });
    await client.unsafe(`
      UPDATE drizzle.__drizzle_migrations
      SET created_at = ${LEGACY_TIMESTAMP.promiseFailover}
      WHERE created_at = 1;
    `);

    await client.unsafe(`DROP INDEX result_media_storage_key_idx`);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "incompatible",
    });
    await client.unsafe(`CREATE INDEX result_media_storage_key_idx ON result_media (storage_key)`);

    await client.unsafe(`DROP TABLE result_attempt_ingest_completions`);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "incompatible",
    });
    await ensureHistorical0093IngestCompletionAnchor();

    // A partial journal that claims even one 0094 row is neither the known
    // 0093 production baseline nor a complete 0099 schema. The runner must
    // reject it before any DDL is applied.
    await client.unsafe(`
      INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
      VALUES ('partial-0094-ledger-row', ${FIRST_LEDGER_TIMESTAMP});
    `);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "incompatible",
    });
    await expect(
      migrateWithResultInterpretationLedgerPreflight(readerDb, migrations),
    ).rejects.toThrow(/refusing result-interpretation ledger migration/);
    await client.unsafe(`
      DELETE FROM drizzle.__drizzle_migrations
      WHERE created_at = ${FIRST_LEDGER_TIMESTAMP};
    `);

    await client.unsafe(`
      ALTER TABLE sim_urans_requests ADD COLUMN corrective_tail_periods integer;
    `);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "incompatible",
    });
    await client.unsafe(`
      ALTER TABLE sim_urans_requests DROP COLUMN corrective_tail_periods;
    `);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "preledger_0093",
      issues: [],
    });

    await migrateWithResultInterpretationLedgerPreflight(readerDb, migrations);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "postledger_0100",
      issues: [],
    });

    const [shape] = await client<
      Array<{
        tables: string[];
        enumLabels: string[];
        tailColumn: boolean;
        indexes: string[];
        latestMigration: string;
        historicalIngestTable: boolean;
        promiseTtlDefault: string | null;
        legacyArchiveGapTable: boolean;
        legacyArchiveGapIndex: boolean;
        queueIndexes: string[];
        awaitingArchiveReduction: boolean;
        legacyGlobalIndexAbsent: boolean;
        sourceScopedIndexes: string[];
      }>
    >`
      SELECT
        ARRAY(
          SELECT relname
          FROM pg_class
          WHERE oid IN (
            to_regclass('public.result_reducer_versions'),
            to_regclass('public.result_interpretations'),
            to_regclass('public.result_interpretation_cycles'),
            to_regclass('public.result_interpretation_backfill_runs'),
            to_regclass('public.result_interpretation_backfill_items'),
            to_regclass('public.result_canonical_selections'),
            to_regclass('public.result_interpretation_recovery_actions'),
            to_regclass('public.legacy_urans_archive_gap_recovery_actions'),
            to_regclass('public.result_archive_reduction_queue')
          )
          ORDER BY relname
        ) AS tables,
        ARRAY(
          SELECT enumlabel
          FROM pg_enum
          WHERE enumtypid = 'public.result_interpretation_state'::regtype
          ORDER BY enumsortorder
        ) AS "enumLabels",
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'result_interpretation_recovery_actions'
            AND column_name = 'corrective_tail_periods'
        ) AS "tailColumn",
        ARRAY(
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'ri_recovery_active_request_owner_uq',
              'ri_recovery_active_verify_owner_uq'
            )
          ORDER BY indexname
        ) AS indexes,
        (SELECT max(created_at)::text FROM drizzle.__drizzle_migrations)
          AS "latestMigration",
        to_regclass('public.result_attempt_ingest_completions') IS NOT NULL
          AS "historicalIngestTable",
        (
          SELECT column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'sync_api_settings'
            AND column_name = 'default_promise_ttl_hours'
        ) AS "promiseTtlDefault",
        to_regclass('public.legacy_urans_archive_gap_recovery_actions') IS NOT NULL
          AS "legacyArchiveGapTable",
        EXISTS (
          SELECT 1
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'legacy_urans_archive_gap_recovery_source_uq'
          ) AS "legacyArchiveGapIndex",
        ARRAY(
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'result_archive_reduction_queue_identity_uq',
              'result_archive_reduction_queue_ready_idx',
              'result_archive_reduction_queue_lease_idx',
              'result_archive_reduction_queue_result_idx'
            )
          ORDER BY indexname
        ) AS "queueIndexes",
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'sim_campaign_progress'
            AND column_name = 'awaiting_archive_reduction'
            AND is_nullable = 'NO'
            AND column_default = '0'
        ) AS "awaitingArchiveReduction",
        to_regclass('public.result_interpretations_attempt_reducer_evidence_uq') IS NULL
          AS "legacyGlobalIndexAbsent",
        ARRAY(
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'result_interpretations_archive_attempt_reducer_src_evidence_uq',
              'result_interpretations_nonarchive_attempt_reducer_evidence_uq'
            )
          ORDER BY indexname
        ) AS "sourceScopedIndexes";
    `;

    expect(shape).toEqual({
      tables: [
        "legacy_urans_archive_gap_recovery_actions",
        "result_archive_reduction_queue",
        "result_canonical_selections",
        "result_interpretation_backfill_items",
        "result_interpretation_backfill_runs",
        "result_interpretation_cycles",
        "result_interpretation_recovery_actions",
        "result_interpretations",
        "result_reducer_versions",
      ],
      enumLabels: [
        "accepted",
        "continuation_required",
        "terminal_failure",
        "legacy_uncertified",
      ],
      tailColumn: true,
      indexes: [
        "ri_recovery_active_request_owner_uq",
        "ri_recovery_active_verify_owner_uq",
      ],
      latestMigration: String(FINAL_RECONCILIATION_TIMESTAMP),
      historicalIngestTable: true,
      promiseTtlDefault: "72",
      legacyArchiveGapTable: true,
      legacyArchiveGapIndex: true,
      queueIndexes: [
        "result_archive_reduction_queue_identity_uq",
        "result_archive_reduction_queue_lease_idx",
        "result_archive_reduction_queue_ready_idx",
        "result_archive_reduction_queue_result_idx",
      ],
      awaitingArchiveReduction: true,
      legacyGlobalIndexAbsent: true,
      sourceScopedIndexes: [
        "result_interpretations_archive_attempt_reducer_src_evidence_uq",
        "result_interpretations_nonarchive_attempt_reducer_evidence_uq",
      ],
    });

    // Reproduce the exact pre-release 0099 index identity emitted by
    // PostgreSQL: the original overlong declaration was stored under this
    // 63-byte truncation. With the 0100 journal row absent, it is a valid
    // upgrade baseline rather than an incompatible partial schema.
    await client.unsafe(`
      DELETE FROM drizzle.__drizzle_migrations
      WHERE created_at = ${FINAL_RECONCILIATION_TIMESTAMP};
    `);
    await client.unsafe(`
      DROP INDEX "result_interpretations_archive_attempt_reducer_src_evidence_uq";
      CREATE UNIQUE INDEX "result_interpretations_archive_attempt_reducer_source_evidence_"
        ON "result_interpretations" (
          "result_attempt_id", "reducer_version_id", "source_archive_id", "input_evidence_signature"
        )
        WHERE "source" = 'archive_backfill';
    `);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "postledger_0099_upgrade",
      issues: [],
    });

    await migrateWithResultInterpretationLedgerPreflight(readerDb, migrations);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "postledger_0100",
      issues: [],
    });
    const [reconciled] = await client<
      Array<{ legacyAbsent: boolean; canonicalPresent: boolean; latestMigration: string }>
    >`
      SELECT
        to_regclass('public.result_interpretations_archive_attempt_reducer_source_evidence_')
          IS NULL AS "legacyAbsent",
        to_regclass('public.result_interpretations_archive_attempt_reducer_src_evidence_uq')
          IS NOT NULL AS "canonicalPresent",
        (SELECT max(created_at)::text FROM drizzle.__drizzle_migrations)
          AS "latestMigration"
    `;
    expect(reconciled).toEqual({
      legacyAbsent: true,
      canonicalPresent: true,
      latestMigration: String(FINAL_RECONCILIATION_TIMESTAMP),
    });
  });

  it("retains the final source-scoped uniqueness topology", async () => {
    if (!client) throw new Error("migration test database is unavailable");

    const [counts] = await client<
      Array<{
        actionIndexes: number;
        triggers: number;
        terminalState: boolean;
        archivePredicate: boolean;
        nonarchivePredicate: boolean;
        archiveSourceIdentity: boolean;
        nonarchiveSourceIdentity: boolean;
        legacyArchiveSourceIdentityAbsent: boolean;
      }>
    >`
      SELECT
        (
          SELECT count(*)::int
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'ri_recovery_active_request_owner_uq',
              'ri_recovery_active_verify_owner_uq'
            )
        ) AS "actionIndexes",
        (
          SELECT count(*)::int
          FROM pg_trigger
          WHERE tgrelid IN (
            'public.result_interpretations'::regclass,
            'public.result_canonical_selections'::regclass,
            'public.results'::regclass
          )
            AND NOT tgisinternal
            AND tgname IN (
              'result_interpretations_append_only',
              'result_canonical_selections_append_only',
              'result_canonical_selections_validate_insert',
              'results_validate_interpretation_projection'
            )
        ) AS triggers,
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.result_interpretation_backfill_items'::regclass
            AND conname = 'result_interpretation_backfill_items_state_check'
            AND pg_get_constraintdef(oid) LIKE '%terminal_failure%'
        ) AS "terminalState",
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'result_interpretations_archive_attempt_reducer_src_evidence_uq'
            AND indexdef LIKE '%WHERE (source = ''archive_backfill''::text)%'
        ) AS "archivePredicate",
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'result_interpretations_nonarchive_attempt_reducer_evidence_uq'
            AND indexdef LIKE '%WHERE (source <> ''archive_backfill''::text)%'
        ) AS "nonarchivePredicate",
        EXISTS (
          SELECT 1
          FROM pg_index index_row
          JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
          WHERE index_class.relname =
              'result_interpretations_archive_attempt_reducer_src_evidence_uq'
            AND index_class.relnamespace = 'public'::regnamespace
            AND index_row.indrelid = 'public.result_interpretations'::regclass
            AND index_row.indisunique
            AND index_row.indnkeyatts = 4
            AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
            AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
            AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'source_archive_id'
            AND pg_get_indexdef(index_row.indexrelid, 4, true) = 'input_evidence_signature'
            AND pg_get_expr(index_row.indpred, index_row.indrelid)
              = '(source = ''archive_backfill''::text)'
        ) AS "archiveSourceIdentity",
        EXISTS (
          SELECT 1
          FROM pg_index index_row
          JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
          WHERE index_class.relname =
              'result_interpretations_nonarchive_attempt_reducer_evidence_uq'
            AND index_class.relnamespace = 'public'::regnamespace
            AND index_row.indrelid = 'public.result_interpretations'::regclass
            AND index_row.indisunique
            AND index_row.indnkeyatts = 3
            AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
            AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
            AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'input_evidence_signature'
            AND pg_get_expr(index_row.indpred, index_row.indrelid)
              = '(source <> ''archive_backfill''::text)'
        ) AS "nonarchiveSourceIdentity",
        to_regclass('public.result_interpretations_archive_attempt_reducer_source_evidence_')
          IS NULL AS "legacyArchiveSourceIdentityAbsent";
    `;

    expect(counts).toEqual({
      actionIndexes: 2,
      triggers: 4,
      terminalState: true,
      archivePredicate: true,
      nonarchivePredicate: true,
      archiveSourceIdentity: true,
      nonarchiveSourceIdentity: true,
      legacyArchiveSourceIdentityAbsent: true,
    });

    // This is intentionally the final mutation in the disposable database.
    // A journal alone must not authorize deployment if an ownership fence or
    // clean-tail constraint has been lost after a prior migration.
    await client.unsafe(`
      ALTER TABLE sim_urans_requests
        DROP CONSTRAINT sim_urans_tail_periods_ck;
      ALTER TABLE result_interpretation_recovery_actions
        DROP CONSTRAINT ri_recovery_tail_periods_ck;
      ALTER TABLE result_interpretation_recovery_actions
        DROP CONSTRAINT result_interpretation_recovery_actions_target_shape_check;
      ALTER TABLE result_interpretations
        DROP CONSTRAINT result_interpretations_source_check;
      ALTER TABLE result_interpretations
        DROP CONSTRAINT result_interpretations_archive_owner_fk;
      DROP INDEX ri_recovery_active_request_owner_uq;
      DROP INDEX legacy_urans_archive_gap_recovery_active_request_uq;
      DROP INDEX result_archive_reduction_queue_identity_uq;
    `);
    const damaged = await readResultInterpretationLedgerPreflight(
      drizzle(client) as unknown as DB,
    );
    expect(damaged.state).toBe("incompatible");
    expect(damaged.issues).toEqual(
      expect.arrayContaining([
        "0094 URANS corrective-tail constraints are incomplete",
        "recovery action tail/target-shape constraints are incompatible",
        "interpretation archive ownership is incompatible",
        "interpretation source provenance check is incompatible",
        "recovery action request-owner fence is incompatible",
        "legacy archive-gap active request fence is incompatible",
        "archive-reduction queue identity fence is incompatible",
      ]),
    );
  });
});
