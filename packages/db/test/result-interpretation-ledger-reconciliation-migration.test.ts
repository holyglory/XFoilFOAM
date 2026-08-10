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
const MESH_IDENTITY_RECONCILIATION_TIMESTAMP = 1789344000000;

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

describe("0096 result interpretation ledger reconciliation", () => {
  it("upgrades a production-shaped timestamp collision through the legacy archive-gap ledger without replaying historical migrations", async () => {
    if (!client) throw new Error("migration test database is unavailable");

    await migrate(drizzle(client), { migrationsFolder: migrations });

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
      }>
    >`
      SELECT
        ARRAY(
          SELECT relname
          FROM pg_class
          WHERE oid IN (
            to_regclass('public.result_reducer_versions'),
            to_regclass('public.result_attempt_mesh_identities'),
            to_regclass('public.result_interpretations'),
            to_regclass('public.result_interpretation_cycles'),
            to_regclass('public.result_interpretation_backfill_runs'),
            to_regclass('public.result_interpretation_backfill_items'),
            to_regclass('public.result_canonical_selections'),
            to_regclass('public.result_interpretation_recovery_actions')
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
        ) AS "legacyArchiveGapIndex";
    `;

    expect(shape).toEqual({
      tables: [
        "result_attempt_mesh_identities",
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
      latestMigration: String(MESH_IDENTITY_RECONCILIATION_TIMESTAMP),
      historicalIngestTable: true,
      promiseTtlDefault: "72",
      legacyArchiveGapTable: true,
      legacyArchiveGapIndex: true,
    });
  });

  it("is safe to execute again after the ledger has converged", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    await client.unsafe(
      readFileSync(
        join(migrations, "0096_result_interpretation_ledger_reconciliation.sql"),
        "utf8",
      ),
    );

    const [counts] = await client<
      Array<{ actionIndexes: number; triggers: number; terminalState: boolean }>
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
        ) AS "terminalState";
    `;

    expect(counts).toEqual({
      actionIndexes: 2,
      triggers: 4,
      terminalState: true,
    });
  });

  it("repairs the production interpretation table that predates mesh identity ownership", async () => {
    if (!client) throw new Error("migration test database is unavailable");

    await client.unsafe(`
      ALTER TABLE result_interpretations
        DROP COLUMN mesh_identity_id CASCADE;
    `);
    const migration = readFileSync(
      join(
        migrations,
        "0098_result_interpretation_mesh_identity_reconciliation.sql",
      ),
      "utf8",
    );
    await client.unsafe(migration);
    await client.unsafe(migration);

    const [shape] = await client<
      Array<{ meshColumn: boolean; meshOwnerFk: boolean }>
    >`
      SELECT
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'result_interpretations'
            AND column_name = 'mesh_identity_id'
        ) AS "meshColumn",
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.result_interpretations'::regclass
            AND conname = 'result_interpretations_mesh_owner_fk'
        ) AS "meshOwnerFk";
    `;

    expect(shape).toEqual({ meshColumn: true, meshOwnerFk: true });
  });
});
