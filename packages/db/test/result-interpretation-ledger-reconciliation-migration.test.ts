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
const historicalAuditSourceStateFenceMigration = join(
  migrations,
  "0103_historical_archive_audit_decision_source_and_state_fence.sql",
);
const historicalAuditCanonicalSelectionFenceMigration = join(
  migrations,
  "0104_historical_audit_canonical_selection_fence.sql",
);
const historicalAuditRunIdentityFenceMigration = join(
  migrations,
  "0105_historical_audit_run_identity_fence.sql",
);
const historicalAuditChildReceiptFenceMigration = join(
  migrations,
  "0106_historical_audit_child_receipt_fence.sql",
);
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
const ARCHIVE_SOURCE_RECONCILIATION_TIMESTAMP = 1789516800000;
const HISTORICAL_AUDIT_DECISION_TIMESTAMP = 1789603200000;
const HISTORICAL_AUDIT_PROVENANCE_TIMESTAMP = 1789689600000;
const HISTORICAL_AUDIT_HARDENING_TIMESTAMP = 1789776000000;
const HISTORICAL_AUDIT_CANONICAL_SELECTION_FENCE_TIMESTAMP = 1789862400000;
const HISTORICAL_AUDIT_RUN_IDENTITY_FENCE_TIMESTAMP = 1789948800000;
const HISTORICAL_AUDIT_CHILD_RECEIPT_FENCE_TIMESTAMP = 1790035200000;
const FIRST_LEDGER_TIMESTAMP = 1788998400000;

const HISTORICAL_AUDIT_FIXTURE = {
  category: "b1020000-0000-4000-8000-000000000001",
  airfoil: "b1020000-0000-4000-8000-000000000002",
  medium: "b1020000-0000-4000-8000-000000000003",
  boundary: "b1020000-0000-4000-8000-000000000004",
  result: "b1020000-0000-4000-8000-000000000005",
  attempt: "b1020000-0000-4000-8000-000000000006",
  artifact: "b1020000-0000-4000-8000-000000000007",
  blob: "b1020000-0000-4000-8000-000000000008",
  archive: "b1020000-0000-4000-8000-000000000009",
  reducer: "b1020000-0000-4000-8000-00000000000a",
  auditRun: "b1020000-0000-4000-8000-00000000000b",
  invalidAuditRun: "b1020000-0000-4000-8000-00000000000c",
  historicalInterpretation: "b1020000-0000-4000-8000-00000000000d",
  publicationInterpretation: "b1020000-0000-4000-8000-00000000000e",
  wrongSourceAuditRun: "b1020000-0000-4000-8000-00000000000f",
  nonMatchingSourceArchive: "b1020000-0000-4000-8000-000000000010",
  invalidSourceAttempt: "b1020000-0000-4000-8000-000000000011",
  invalidSourceArtifact: "b1020000-0000-4000-8000-000000000012",
  invalidSourceBlob: "b1020000-0000-4000-8000-000000000013",
  invalidSourceArchive: "b1020000-0000-4000-8000-000000000014",
  invalidSourceAuditRun: "b1020000-0000-4000-8000-000000000015",
  singleBackslashAttempt: "b1020000-0000-4000-8000-000000000016",
  singleBackslashArtifact: "b1020000-0000-4000-8000-000000000017",
  singleBackslashBlob: "b1020000-0000-4000-8000-000000000018",
  singleBackslashArchive: "b1020000-0000-4000-8000-000000000019",
  singleBackslashAuditRun: "b1020000-0000-4000-8000-00000000001a",
  missingFidelityAttempt: "b1020000-0000-4000-8000-00000000001b",
  missingFidelityArtifact: "b1020000-0000-4000-8000-00000000001c",
  missingFidelityArchive: "b1020000-0000-4000-8000-00000000001d",
  missingFidelityAuditRun: "b1020000-0000-4000-8000-00000000001e",
  missingRegimeAttempt: "b1020000-0000-4000-8000-00000000001f",
  missingRegimeArtifact: "b1020000-0000-4000-8000-000000000020",
  missingRegimeArchive: "b1020000-0000-4000-8000-000000000021",
  missingRegimeAuditRun: "b1020000-0000-4000-8000-000000000022",
  missingZstdLevelAttempt: "b1020000-0000-4000-8000-000000000023",
  missingZstdLevelArtifact: "b1020000-0000-4000-8000-000000000024",
  missingZstdLevelBlob: "b1020000-0000-4000-8000-000000000025",
  missingZstdLevelArchive: "b1020000-0000-4000-8000-000000000026",
  missingZstdLevelAuditRun: "b1020000-0000-4000-8000-000000000027",
  missingGenerationAttempt: "b1020000-0000-4000-8000-000000000028",
  missingGenerationArtifact: "b1020000-0000-4000-8000-000000000029",
  missingGenerationBlob: "b1020000-0000-4000-8000-00000000002a",
  missingGenerationArchive: "b1020000-0000-4000-8000-00000000002b",
  missingGenerationAuditRun: "b1020000-0000-4000-8000-00000000002c",
  malformedScopeAuditRun: "b1020000-0000-4000-8000-00000000002d",
  auditCanonicalSelection: "b1020000-0000-4000-8000-00000000002e",
  publicationCanonicalSelection: "b1020000-0000-4000-8000-00000000002f",
  alternateReducer: "b1020000-0000-4000-8000-000000000030",
  auditItem: "b1020000-0000-4000-8000-000000000031",
  wrongSourceAuditItem: "b1020000-0000-4000-8000-000000000032",
  invalidSourceAuditItem: "b1020000-0000-4000-8000-000000000033",
  singleBackslashAuditItem: "b1020000-0000-4000-8000-000000000034",
  missingFidelityAuditItem: "b1020000-0000-4000-8000-000000000035",
  missingRegimeAuditItem: "b1020000-0000-4000-8000-000000000036",
  missingZstdLevelAuditItem: "b1020000-0000-4000-8000-000000000037",
  missingGenerationAuditItem: "b1020000-0000-4000-8000-000000000038",
  auditClaim: "b1020000-0000-4000-8000-000000000039",
  wrongSourceAuditClaim: "b1020000-0000-4000-8000-00000000003a",
  validAuditDecision: "b1020000-0000-4000-8000-00000000003b",
  releasedSourceDecision: "b1020000-0000-4000-8000-00000000003c",
  invalidSourceDecision: "b1020000-0000-4000-8000-00000000003d",
  singleBackslashDecision: "b1020000-0000-4000-8000-00000000003e",
  missingFidelityDecision: "b1020000-0000-4000-8000-00000000003f",
  missingRegimeDecision: "b1020000-0000-4000-8000-000000000040",
  missingZstdLevelDecision: "b1020000-0000-4000-8000-000000000041",
  missingGenerationDecision: "b1020000-0000-4000-8000-000000000042",
  malformedNoDecisionAuditRun: "b1020000-0000-4000-8000-000000000043",
  malformedNoDecisionAuditItem: "b1020000-0000-4000-8000-000000000044",
  forgedLifecycleReducer: "b1020000-0000-4000-8000-000000000045",
  forgedLifecycleAuditRun: "b1020000-0000-4000-8000-000000000046",
  forgedLifecycleAuditItem: "b1020000-0000-4000-8000-000000000047",
  forgedLifecycleAuditDecision: "b1020000-0000-4000-8000-000000000048",
  pre0106TerminalNoDecisionAuditRun: "b1020000-0000-4000-8000-000000000049",
  pre0106TerminalNoDecisionAuditItem: "b1020000-0000-4000-8000-00000000004a",
  expiredLeaseAuditRun: "b1020000-0000-4000-8000-00000000004b",
  expiredLeaseAuditItem: "b1020000-0000-4000-8000-00000000004c",
  expiredLeaseAuditClaim: "b1020000-0000-4000-8000-00000000004d",
  expiredLeaseAuditDecision: "b1020000-0000-4000-8000-00000000004e",
  inactiveParentAuditRun: "b1020000-0000-4000-8000-00000000004f",
  inactiveParentAuditItem: "b1020000-0000-4000-8000-000000000050",
  inactiveParentAuditClaim: "b1020000-0000-4000-8000-000000000051",
  genericToAuditRun: "b1020000-0000-4000-8000-000000000052",
  genericToAuditItem: "b1020000-0000-4000-8000-000000000053",
  genericToAuditParent: "b1020000-0000-4000-8000-000000000054",
  terminalStateAuditRun: "b1020000-0000-4000-8000-000000000055",
  terminalStateAuditItem: "b1020000-0000-4000-8000-000000000056",
} as const;
const HISTORICAL_AUDIT_SHA = "a".repeat(64);
const PUBLICATION_ARCHIVE_SHA = "b".repeat(64);
const INVALID_AUDIT_SHA = "c".repeat(64);
const NULL_POINTER_AUDIT_SHA = "d".repeat(64);
const CONTINUATION_AUDIT_SHA = "e".repeat(64);
const INVALID_SOURCE_AUDIT_SHA = "f".repeat(64);
const SINGLE_BACKSLASH_AUDIT_SHA = "1".repeat(64);
const MISSING_FIDELITY_AUDIT_SHA = "2".repeat(64);
const MISSING_REGIME_AUDIT_SHA = "3".repeat(64);
const MISSING_ZSTD_LEVEL_AUDIT_SHA = "4".repeat(64);
const MISSING_GENERATION_AUDIT_SHA = "5".repeat(64);
const MALFORMED_SCOPE_AUDIT_SHA = "6".repeat(64);

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

function historicalAuditDecisionValidatorSql(): string {
  const migration = readFileSync(historicalAuditChildReceiptFenceMigration, "utf8");
  const start = migration.indexOf(
    'CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_decision_insert"()',
  );
  const end = migration.indexOf("\n$$;", start);
  if (start < 0 || end < 0) {
    throw new Error("0106 historical audit decision validator was not found in its migration");
  }
  return migration.slice(start, end + "\n$$;".length);
}

function historicalAuditItemLifecycleValidatorSql(): string {
  const migration = readFileSync(historicalAuditChildReceiptFenceMigration, "utf8");
  const start = migration.indexOf(
    'CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_item_lifecycle"()',
  );
  const end = migration.indexOf("\n$$;", start);
  if (start < 0 || end < 0) {
    throw new Error(
      "0106 historical audit item lifecycle validator was not found in its migration",
    );
  }
  return migration.slice(start, end + "\n$$;".length);
}

function historicalAuditItemAdmissionValidatorSql(): string {
  const migration = readFileSync(historicalAuditChildReceiptFenceMigration, "utf8");
  const start = migration.indexOf(
    'CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_item_admission"()',
  );
  const end = migration.indexOf("\n$$;", start);
  if (start < 0 || end < 0) {
    throw new Error(
      "0106 historical audit item admission validator was not found in its migration",
    );
  }
  return migration.slice(start, end + "\n$$;".length);
}

function historicalAuditPreChildReceiptDecisionValidatorSql(): string {
  const migration = readFileSync(historicalAuditSourceStateFenceMigration, "utf8");
  const start = migration.indexOf(
    'CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_decision_insert"()',
  );
  const end = migration.indexOf("\n$$;", start);
  if (start < 0 || end < 0) {
    throw new Error("0103 historical audit decision validator was not found in its migration");
  }
  return migration.slice(start, end + "\n$$;".length);
}

function historicalAuditCanonicalSelectionFenceValidatorSql(
  functionName:
    | "validate_result_canonical_selection"
    | "validate_result_interpretation_projection",
): string {
  const migration = readFileSync(
    historicalAuditCanonicalSelectionFenceMigration,
    "utf8",
  );
  const start = migration.indexOf(
    `CREATE OR REPLACE FUNCTION "${functionName}"()`,
  );
  const end = migration.indexOf("\n$$;", start);
  if (start < 0 || end < 0) {
    throw new Error(`0104 ${functionName} validator was not found in its migration`);
  }
  return migration.slice(start, end + "\n$$;".length);
}

function historicalAuditCanonicalSelectionFenceProjectionTriggerSql(): string {
  const migration = readFileSync(
    historicalAuditCanonicalSelectionFenceMigration,
    "utf8",
  );
  const start = migration.indexOf(
    'DROP TRIGGER IF EXISTS "results_validate_interpretation_projection" ON "results";',
  );
  const end = migration.indexOf(
    'FOR EACH ROW EXECUTE FUNCTION "validate_result_interpretation_projection"();',
    start,
  );
  if (start < 0 || end < 0) {
    throw new Error(
      "0104 projection trigger replacement was not found in its migration",
    );
  }
  const terminator =
    'FOR EACH ROW EXECUTE FUNCTION "validate_result_interpretation_projection"();';
  return migration.slice(
    start,
    end + terminator.length,
  );
}

function historicalAuditCanonicalSelectionFencePreflightSql(): string {
  const migration = readFileSync(
    historicalAuditCanonicalSelectionFenceMigration,
    "utf8",
  );
  const start = migration.indexOf("DO $$");
  const end = migration.indexOf("\n$$;", start);
  const firstValidator = migration.indexOf(
    'CREATE OR REPLACE FUNCTION "validate_result_canonical_selection"()',
  );
  if (start < 0 || end < 0 || firstValidator < 0 || start > firstValidator) {
    throw new Error(
      "0104 historical audit projection preflight must run before its validators",
    );
  }
  return migration.slice(start, end + "\n$$;".length);
}

function historicalAuditRunIdentityFenceValidatorSql(): string {
  const migration = readFileSync(historicalAuditRunIdentityFenceMigration, "utf8");
  const start = migration.indexOf(
    'CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_run_identity"()',
  );
  const end = migration.indexOf("\n$$;", start);
  if (start < 0 || end < 0) {
    throw new Error("0105 historical audit run identity validator was not found in its migration");
  }
  return migration.slice(start, end + "\n$$;".length);
}

function historicalAuditRunIdentityFenceTriggerSql(): string {
  const migration = readFileSync(historicalAuditRunIdentityFenceMigration, "utf8");
  const start = migration.indexOf(
    'DROP TRIGGER IF EXISTS "result_interpretation_backfill_runs_validate_historical_audit_identity"',
  );
  const terminator =
    'FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_run_identity"();';
  const end = migration.indexOf(terminator, start);
  if (start < 0 || end < 0) {
    throw new Error("0105 historical audit run identity trigger was not found in its migration");
  }
  return migration.slice(start, end + terminator.length);
}

function historicalAuditRunIdentityFencePreflightSql(): string {
  const migration = readFileSync(historicalAuditRunIdentityFenceMigration, "utf8");
  const start = migration.indexOf("DO $$");
  const end = migration.indexOf("\n$$;", start);
  const validator = migration.indexOf(
    'CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_run_identity"()',
  );
  if (start < 0 || end < 0 || validator < 0 || start > validator) {
    throw new Error(
      "0105 historical audit run identity preflight must run before its validator",
    );
  }
  return migration.slice(start, end + "\n$$;".length);
}

type HistoricalAuditReducerState =
  | "accepted"
  | "continuation_required"
  | "recovery_exhausted"
  | "rerun_required"
  | "missing_evidence";

function historicalAuditChildState(
  reducerState: HistoricalAuditReducerState,
): "reduced" | "continuation_required" | "terminal_failure" | "rerun_required" | "missing_evidence" {
  switch (reducerState) {
    case "accepted":
      return "reduced";
    case "continuation_required":
      return "continuation_required";
    case "recovery_exhausted":
      return "terminal_failure";
    case "rerun_required":
      return "rerun_required";
    case "missing_evidence":
      return "missing_evidence";
  }
}

/**
 * The production finalizer writes the claimed child receipt first, then the
 * immutable decision in the same transaction. The 0106 FK and pair triggers
 * are deferred specifically for this child-first ordering; tests must not
 * simulate a worker by inserting a decision with no actual execution receipt.
 */
async function insertHistoricalAuditDecisionWithChildReceipt(input: {
  itemId: string;
  decisionId: string;
  auditRunId: string;
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
  reducerVersionId: string;
  inputEvidenceSignature: string;
  reducerState: HistoricalAuditReducerState;
  resultInterpretationId?: string | null;
}) {
  if (!client) throw new Error("migration test database is unavailable");
  const resultInterpretationId = input.resultInterpretationId
    ? `'${input.resultInterpretationId}'`
    : "NULL";
  const childState = historicalAuditChildState(input.reducerState);

  return client.begin(async (tx) => {
    await tx.unsafe(`
      UPDATE result_interpretation_backfill_items
      SET state = '${childState}',
          attempt_count = GREATEST(attempt_count, 1),
          claim_token = NULL,
          claim_expires_at = NULL,
          result_interpretation_id = ${resultInterpretationId},
          historical_audit_decision_id = '${input.decisionId}',
          historical_audit_reducer_state = '${input.reducerState}',
          historical_audit_input_evidence_signature = '${input.inputEvidenceSignature}'
      WHERE id = '${input.itemId}'
        AND run_id = '${input.auditRunId}'
        AND result_id = '${input.resultId}'
        AND result_attempt_id = '${input.resultAttemptId}'
        AND source_archive_id = '${input.sourceArchiveId}';
    `);
    await tx.unsafe(`
      INSERT INTO historical_archive_audit_decisions
        (id, audit_run_id, result_id, result_attempt_id, source_archive_id,
         reducer_version_id, input_evidence_signature, reducer_state,
         result_interpretation_id, diagnostics)
      VALUES
        ('${input.decisionId}', '${input.auditRunId}', '${input.resultId}',
         '${input.resultAttemptId}', '${input.sourceArchiveId}',
         '${input.reducerVersionId}', '${input.inputEvidenceSignature}',
         '${input.reducerState}', ${resultInterpretationId}, '{}'::jsonb);
    `);
  });
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

describe("0096–0106 result interpretation ledger reconciliation", () => {
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
      state: "postledger_0106",
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
        historicalAuditDecisionColumns: string[];
        historicalAuditHasSchedulerTarget: boolean;
        historicalAuditIndexes: string[];
        historicalAuditAppendOnly: boolean;
        historicalAuditRunIdentityFence: boolean;
        historicalAuditRunOutcomeFence: boolean;
        historicalAuditChildReceiptColumns: string[];
        historicalAuditChildReceiptShapeFence: boolean;
        historicalAuditChildReceiptForeignKey: boolean;
        historicalAuditChildReceiptIndex: boolean;
        historicalAuditChildReceiptTriggers: string[];
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
            to_regclass('public.result_archive_reduction_queue'),
            to_regclass('public.historical_archive_audit_decisions')
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
              'ri_historical_archive_attempt_reducer_source_evidence_uq',
              'result_interpretations_archive_attempt_reducer_src_evidence_uq',
              'result_interpretations_nonarchive_attempt_reducer_evidence_uq'
            )
          ORDER BY indexname
        ) AS "sourceScopedIndexes",
        ARRAY(
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'historical_archive_audit_decisions'
          ORDER BY ordinal_position
        ) AS "historicalAuditDecisionColumns",
        EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'historical_archive_audit_decisions'
            AND column_name IN ('target_urans_request_id', 'target_verify_queue_id')
        ) AS "historicalAuditHasSchedulerTarget",
        ARRAY(
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname IN (
              'historical_archive_audit_decisions_identity_uq',
              'historical_archive_audit_decisions_audit_run_idx',
              'historical_archive_audit_decisions_audit_run_uq',
              'historical_archive_audit_decisions_result_created_idx'
            )
          ORDER BY indexname
        ) AS "historicalAuditIndexes",
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'public.historical_archive_audit_decisions'::regclass
            AND tgname = 'historical_archive_audit_decisions_append_only'
            AND NOT tgisinternal
        ) AS "historicalAuditAppendOnly",
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'public.result_interpretation_backfill_runs'::regclass
            AND tgname =
              'result_interpretation_backfill_runs_validate_historical_audit_identity'
            AND NOT tgisinternal
            AND tgenabled = 'O'
            AND tgqual IS NULL
            AND (tgtype::integer & 1) = 1
            AND tgfoid = to_regprocedure(
              'public.validate_historical_archive_audit_run_identity()'
            )
            AND pg_get_triggerdef(oid) LIKE '%BEFORE INSERT OR UPDATE ON%'
        ) AS "historicalAuditRunIdentityFence",
        EXISTS (
          SELECT 1
          FROM pg_index index_row
          JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
          WHERE index_class.relname =
              'historical_archive_audit_decisions_audit_run_uq'
            AND index_class.relnamespace = 'public'::regnamespace
            AND index_row.indrelid = 'public.historical_archive_audit_decisions'::regclass
            AND index_row.indisunique
            AND index_row.indisvalid
            AND index_row.indisready
            AND index_row.indislive
            AND index_row.indnkeyatts = 1
            AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'audit_run_id'
            AND index_row.indpred IS NULL
        ) AS "historicalAuditRunOutcomeFence",
        ARRAY(
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'result_interpretation_backfill_items'
            AND column_name IN (
              'historical_audit_decision_id',
              'historical_audit_reducer_state',
              'historical_audit_input_evidence_signature'
            )
          ORDER BY ordinal_position
        ) AS "historicalAuditChildReceiptColumns",
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.result_interpretation_backfill_items'::regclass
            AND conname =
              'ri_bf_item_audit_receipt_shape_ck'
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%historical_audit_decision_id%'
            AND pg_get_constraintdef(oid) LIKE '%historical_audit_reducer_state%'
            AND pg_get_constraintdef(oid) LIKE '%historical_audit_input_evidence_signature%'
        ) AS "historicalAuditChildReceiptShapeFence",
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.result_interpretation_backfill_items'::regclass
            AND conname =
              'ri_bf_item_audit_decision_fk'
            AND contype = 'f'
            AND confrelid = 'public.historical_archive_audit_decisions'::regclass
            AND condeferrable
            AND condeferred
            AND confdeltype = 'a'
            AND array_length(conkey, 1) = 1
        ) AS "historicalAuditChildReceiptForeignKey",
        EXISTS (
          SELECT 1
          FROM pg_index index_row
          JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
          WHERE index_class.relname =
              'ri_bf_item_audit_decision_uq'
            AND index_class.relnamespace = 'public'::regnamespace
            AND index_row.indrelid = 'public.result_interpretation_backfill_items'::regclass
            AND index_row.indisunique
            AND index_row.indisvalid
            AND index_row.indisready
            AND index_row.indislive
            AND index_row.indnkeyatts = 1
            AND pg_get_indexdef(index_row.indexrelid, 1, true)
              = 'historical_audit_decision_id'
            AND pg_get_expr(index_row.indpred, index_row.indrelid)
              = '(historical_audit_decision_id IS NOT NULL)'
        ) AS "historicalAuditChildReceiptIndex",
        ARRAY(
          SELECT tgname
          FROM pg_trigger
          WHERE tgrelid IN (
            'public.result_interpretation_backfill_items'::regclass,
            'public.historical_archive_audit_decisions'::regclass,
            'public.result_interpretation_backfill_runs'::regclass,
            'public.result_attempts'::regclass
          )
            AND NOT tgisinternal
            AND tgname IN (
              'ri_bf_item_audit_admission',
              'ri_bf_item_audit_lifecycle',
              'ri_bf_item_audit_receipt',
              'ri_bf_item_audit_owner_cascade',
              'result_attempt_audit_owner_cascade',
              'hist_audit_decision_child_pair',
              'ri_bf_item_audit_decision_pair',
              'ri_bf_run_audit_child_shape',
              'ri_bf_item_audit_parent_shape'
            )
          ORDER BY tgname
        ) AS "historicalAuditChildReceiptTriggers";
    `;

    expect(shape).toEqual({
      tables: [
        "historical_archive_audit_decisions",
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
      latestMigration: String(HISTORICAL_AUDIT_CHILD_RECEIPT_FENCE_TIMESTAMP),
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
        "ri_historical_archive_attempt_reducer_source_evidence_uq",
      ],
      historicalAuditDecisionColumns: [
        "id",
        "audit_run_id",
        "result_id",
        "result_attempt_id",
        "source_archive_id",
        "reducer_version_id",
        "input_evidence_signature",
        "reducer_state",
        "result_interpretation_id",
        "advisory_continuation_action",
        "advisory_tail_periods",
        "diagnostics",
        "createdAt",
      ],
      historicalAuditHasSchedulerTarget: false,
      historicalAuditIndexes: [
        "historical_archive_audit_decisions_audit_run_idx",
        "historical_archive_audit_decisions_audit_run_uq",
        "historical_archive_audit_decisions_identity_uq",
        "historical_archive_audit_decisions_result_created_idx",
      ],
      historicalAuditAppendOnly: true,
      historicalAuditRunIdentityFence: true,
      historicalAuditRunOutcomeFence: true,
      historicalAuditChildReceiptColumns: [
        "historical_audit_decision_id",
        "historical_audit_reducer_state",
        "historical_audit_input_evidence_signature",
      ],
      historicalAuditChildReceiptShapeFence: true,
      historicalAuditChildReceiptForeignKey: true,
      historicalAuditChildReceiptIndex: true,
      historicalAuditChildReceiptTriggers: [
        "hist_audit_decision_child_pair",
        "result_attempt_audit_owner_cascade",
        "ri_bf_item_audit_admission",
        "ri_bf_item_audit_decision_pair",
        "ri_bf_item_audit_lifecycle",
        "ri_bf_item_audit_owner_cascade",
        "ri_bf_item_audit_parent_shape",
        "ri_bf_item_audit_receipt",
        "ri_bf_run_audit_child_shape",
      ],
    });

    // Reproduce the exact pre-release 0099 index identity emitted by
    // PostgreSQL: the original overlong declaration was stored under this
    // 63-byte truncation. With the 0100 journal row absent, it is a valid
    // upgrade baseline rather than an incompatible partial schema.
    await client.unsafe(`
      DELETE FROM drizzle.__drizzle_migrations
      WHERE created_at IN (
        ${ARCHIVE_SOURCE_RECONCILIATION_TIMESTAMP},
        ${HISTORICAL_AUDIT_DECISION_TIMESTAMP},
        ${HISTORICAL_AUDIT_PROVENANCE_TIMESTAMP},
        ${HISTORICAL_AUDIT_HARDENING_TIMESTAMP},
        ${HISTORICAL_AUDIT_CANONICAL_SELECTION_FENCE_TIMESTAMP},
        ${HISTORICAL_AUDIT_RUN_IDENTITY_FENCE_TIMESTAMP},
        ${HISTORICAL_AUDIT_CHILD_RECEIPT_FENCE_TIMESTAMP}
      );
    `);
    await client.unsafe(`
      DROP TRIGGER IF EXISTS hist_audit_decision_child_pair
        ON historical_archive_audit_decisions;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_decision_pair
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_parent_shape
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_run_audit_child_shape
        ON result_interpretation_backfill_runs;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_admission
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_owner_cascade
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS result_attempt_audit_owner_cascade
        ON result_attempts;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_lifecycle
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_receipt
        ON result_interpretation_backfill_items;
      ALTER TABLE result_interpretation_backfill_items
        DROP CONSTRAINT IF EXISTS ri_bf_item_audit_decision_fk,
        DROP CONSTRAINT IF EXISTS ri_bf_item_audit_receipt_shape_ck;
      DROP INDEX IF EXISTS ri_bf_item_audit_decision_uq;
      ALTER TABLE result_interpretation_backfill_items
        DROP COLUMN IF EXISTS historical_audit_decision_id,
        DROP COLUMN IF EXISTS historical_audit_reducer_state,
        DROP COLUMN IF EXISTS historical_audit_input_evidence_signature;
      DROP FUNCTION IF EXISTS validate_historical_archive_audit_item_admission();
      DROP FUNCTION IF EXISTS close_historical_archive_audit_after_owner_cascade();
      DROP FUNCTION IF EXISTS close_historical_archive_audit_after_attempt_owner_cascade();
      DROP FUNCTION IF EXISTS validate_historical_archive_audit_item_lifecycle();
      DROP FUNCTION IF EXISTS validate_historical_archive_audit_item_receipt_identity();
      DROP FUNCTION IF EXISTS validate_historical_archive_audit_decision_child_pair();
      DROP FUNCTION IF EXISTS validate_historical_archive_audit_run_child_shape();
      DROP TABLE historical_archive_audit_decisions;
      DROP FUNCTION IF EXISTS validate_historical_archive_audit_decision_insert();
      DROP TRIGGER IF EXISTS result_interpretation_backfill_runs_validate_historical_audit_identity
        ON result_interpretation_backfill_runs;
      DROP FUNCTION IF EXISTS validate_historical_archive_audit_run_identity();
      DROP INDEX IF EXISTS historical_archive_audit_decisions_audit_run_uq;
      DROP INDEX ri_historical_archive_attempt_reducer_source_evidence_uq;
      DROP INDEX result_interpretations_nonarchive_attempt_reducer_evidence_uq;
      CREATE UNIQUE INDEX result_interpretations_nonarchive_attempt_reducer_evidence_uq
        ON result_interpretations (
          result_attempt_id, reducer_version_id, input_evidence_signature
        )
        WHERE source <> 'archive_backfill';
      ALTER TABLE result_interpretations
        DROP CONSTRAINT result_interpretations_source_check;
      ALTER TABLE result_interpretations
        ADD CONSTRAINT result_interpretations_source_check
        CHECK (
          source IN (
            'engine_reported', 'archive_backfill', 'continuation', 'corrective_generation'
          )
          AND btrim(input_evidence_signature) <> ''
          AND ((source = 'archive_backfill' AND source_archive_id IS NOT NULL)
            OR source <> 'archive_backfill')
        );
      ALTER TABLE result_archive_reduction_queue
        DROP CONSTRAINT result_archive_reduction_queue_state_check;
      ALTER TABLE result_archive_reduction_queue
        ADD CONSTRAINT result_archive_reduction_queue_state_check
        CHECK (state IN (
          'pending', 'hydrating', 'reduced', 'superseded', 'missing_evidence',
          'continuation_required', 'rerun_required', 'terminal_failure', 'failed'
        ));
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

    // Any 0105 object before its journal entry is a hand-edited/interrupted
    // future migration, not an older baseline that may overwrite it. Exercise
    // the earliest supported ledger upgrade state with one such marker.
    await client.unsafe(historicalAuditRunIdentityFenceValidatorSql());
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "incompatible",
      issues: expect.arrayContaining([
        "0105 historical audit run identity fence marker exists before its journal entry",
      ]),
    });
    await client.unsafe(`
      DROP FUNCTION validate_historical_archive_audit_run_identity();
    `);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "postledger_0099_upgrade",
      issues: [],
    });

    await migrateWithResultInterpretationLedgerPreflight(readerDb, migrations);
    await expect(readResultInterpretationLedgerPreflight(readerDb)).resolves.toMatchObject({
      state: "postledger_0106",
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
      latestMigration: String(HISTORICAL_AUDIT_CHILD_RECEIPT_FENCE_TIMESTAMP),
    });
  }, 300_000);

  it("rejects spoofed direct historical-audit decisions and pre-fence public projections at the database boundary", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;

    await client.unsafe(`
      BEGIN;
      INSERT INTO categories (id, slug, name, path)
      VALUES ('${id.category}', '0102-audit', '0102 audit', '0102-audit');
      INSERT INTO airfoils (id, slug, name, category_id, source, points)
      VALUES (
        '${id.airfoil}', '0102-audit-foil', '0102 audit foil', '${id.category}',
        'test-coordinates',
        '[{"x":1,"y":0},{"x":0,"y":0},{"x":1,"y":0}]'::jsonb
      );
      INSERT INTO mediums
        (id, slug, name, phase, density, viscosity_model,
         constant_dynamic_viscosity, dynamic_viscosity, kinematic_viscosity)
      VALUES
        ('${id.medium}', '0102-audit-air', '0102 audit air', 'gas',
         1.225, 'constant', 0.00001789, 0.00001789, 0.000014604);
      INSERT INTO boundary_conditions (id, slug, name, medium_id, reynolds)
      VALUES ('${id.boundary}', '0102-audit-bc', '0102 audit BC', '${id.medium}', 100000);
      INSERT INTO results
        (id, airfoil_id, bc_id, aoa_deg, status, source, regime)
      VALUES
        ('${id.result}', '${id.airfoil}', '${id.boundary}', 3, 'done', 'solved', 'urans');
      INSERT INTO result_attempts
        (id, result_id, airfoil_id, bc_id, aoa_deg, status, source, regime,
         evidence_payload)
      VALUES
        ('${id.attempt}', '${id.result}', '${id.airfoil}', '${id.boundary}', 3,
         'done', 'solved', 'urans', '{"fidelity":"urans_precalc"}'::jsonb);
      INSERT INTO solver_evidence_artifacts
        (id, result_id, result_attempt_id, airfoil_id, aoa_deg, kind,
         storage_key, mime_type, sha256, byte_size, metadata)
      VALUES
        ('${id.artifact}', '${id.result}', '${id.attempt}', '${id.airfoil}', 3,
         'openfoam_bundle', 'test/0102/source.tar.zst', 'application/zstd',
         '${HISTORICAL_AUDIT_SHA}', 101, '{}'::jsonb);
      INSERT INTO solver_evidence_blobs
        (id, backend, bucket, object_key, generation, compression, mime_type,
         sha256, byte_size, crc32c, uncompressed_tar_sha256,
         uncompressed_tar_byte_size, "verifiedAt", metadata)
      VALUES
        ('${id.blob}', 'gcs', 'test-bucket', 'test/0102/source.tar.zst', '102', 'zstd',
         'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, 'AAAAAA==',
         '${PUBLICATION_ARCHIVE_SHA}', 202, now(),
         '{"archiveFormat":"tar+zstd","zstdLevel":9}'::jsonb);
      INSERT INTO solver_evidence_archives
        (id, result_id, result_attempt_id, source_artifact_id, blob_id, state)
      VALUES
        ('${id.archive}', '${id.result}', '${id.attempt}', '${id.artifact}', '${id.blob}', 'current');
      INSERT INTO result_reducer_versions
        (id, reducer_key, reducer_version, build_id, policy_sha256, policy, source)
      VALUES
        ('${id.reducer}', '0102-audit', 'v1', 'test-build', '${HISTORICAL_AUDIT_SHA}',
         '{}'::jsonb, 'test');
      INSERT INTO result_interpretation_backfill_runs
        (id, reducer_version_id, state, scope, summary, requested_by, started_at)
      VALUES
        (
          '${id.auditRun}', '${id.reducer}', 'running',
          jsonb_build_object(
            'contract', 'archive-clean-cycle-historical-released-audit-v1',
            'canonicalSelection', 'forbidden',
            'physicalRecovery', 'record-only',
            'campaignMutation', 'forbidden',
            'rawEvidenceImmutable', true,
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.attempt}',
              'sourceArchiveId', '${id.archive}'
            )
          ),
          '{}'::jsonb, '0102-test', now()
        ),
        (
          '${id.invalidAuditRun}', '${id.reducer}', 'running',
          jsonb_build_object(
            'contract', 'ordinary-backfill-v1',
            'canonicalSelection', 'allowed',
            'physicalRecovery', 'may-schedule',
            'campaignMutation', 'allowed',
            'rawEvidenceImmutable', false,
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.attempt}',
              'sourceArchiveId', '${id.archive}'
            )
          ),
          '{}'::jsonb, '0102-test', now()
        ),
        (
          '${id.wrongSourceAuditRun}', '${id.reducer}', 'running',
          jsonb_build_object(
            'contract', 'archive-clean-cycle-historical-released-audit-v1',
            'canonicalSelection', 'forbidden',
            'physicalRecovery', 'record-only',
            'campaignMutation', 'forbidden',
            'rawEvidenceImmutable', true,
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.attempt}',
              'sourceArchiveId', '${id.archive}'
            )
          ),
          '{}'::jsonb, '0102-test', now()
        );
      INSERT INTO result_interpretation_backfill_items
        (id, run_id, result_id, result_attempt_id, source_archive_id,
         state, attempt_count, claim_token, claim_expires_at)
      VALUES
        ('${id.auditItem}', '${id.auditRun}', '${id.result}', '${id.attempt}',
         '${id.archive}', 'pending', 0, NULL, NULL),
        ('${id.wrongSourceAuditItem}', '${id.wrongSourceAuditRun}', '${id.result}',
         '${id.attempt}', '${id.archive}', 'pending', 0, NULL, NULL);
      UPDATE result_interpretation_backfill_items
      SET state = 'hydrating',
          attempt_count = 1,
          claim_token = CASE id
            WHEN '${id.auditItem}' THEN '${id.auditClaim}'
            WHEN '${id.wrongSourceAuditItem}' THEN '${id.wrongSourceAuditClaim}'
          END::uuid,
          claim_expires_at = now() + interval '15 minutes'
      WHERE id IN ('${id.auditItem}', '${id.wrongSourceAuditItem}');
      INSERT INTO result_interpretations
        (id, result_id, result_attempt_id, reducer_version_id, source_archive_id,
         source, input_evidence_signature, state, regime, selected_window,
         statistics, diagnostics, cl, cd, cm, cl_cd, cl_cd_interval_state,
         uncertainty_basis, effective_blocks)
      VALUES
        (
          '${id.historicalInterpretation}', '${id.result}', '${id.attempt}', '${id.reducer}',
          '${id.archive}', 'historical_archive_audit', '${HISTORICAL_AUDIT_SHA}',
          'accepted', 'periodic', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          0.6, 0.02, -0.1, 30, 'bounded', 'paired_cycles', 3
        ),
        (
          '${id.publicationInterpretation}', '${id.result}', '${id.attempt}', '${id.reducer}',
          '${id.archive}', 'archive_backfill', '${PUBLICATION_ARCHIVE_SHA}',
          'accepted', 'periodic', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          0.6, 0.02, -0.1, 30, 'bounded', 'paired_cycles', 3
        );
      COMMIT;
    `);

    // A direct decision has no claimed child lifecycle. It must fail before
    // it can occupy the audit run's one immutable-decision slot.
    await expect(client.unsafe(`
      INSERT INTO historical_archive_audit_decisions
        (audit_run_id, result_id, result_attempt_id, source_archive_id,
         reducer_version_id, input_evidence_signature, reducer_state,
         result_interpretation_id, diagnostics)
      VALUES
        ('${id.auditRun}', '${id.result}', '${id.attempt}', '${id.archive}',
         '${id.reducer}', '${HISTORICAL_AUDIT_SHA}', 'accepted',
         '${id.historicalInterpretation}', '{}'::jsonb);
    `)).rejects.toThrow(
      /historical archive audit decision requires one exact terminal child execution receipt/,
    );

    // A child cannot skip the decision either. The state is terminal and has
    // a real historical interpretation, but without the reverse immutable
    // receipt it is still a forged completion.
    await expect(client.unsafe(`
      UPDATE result_interpretation_backfill_items
      SET state = 'reduced',
          claim_token = NULL,
          claim_expires_at = NULL,
          result_interpretation_id = '${id.historicalInterpretation}'
      WHERE id = '${id.auditItem}';
    `)).rejects.toThrow(
      /historical archive audit scientific terminal state requires its immutable decision receipt/,
    );

    // A deferred child->decision FK is necessary for the real finalizer's
    // child-first transaction, but it must not license a direct writer to
    // insert a fully terminal child and only *then* fabricate a matching
    // decision. The child begins pending, is claimed into hydrating, and is
    // settled only by that claimed lifecycle. Keep the planned decision in
    // this same transaction so this catches a fence that merely checks for a
    // decision ID rather than the lifecycle transition itself.
    await expect(
      client.begin(async (tx) => {
        await tx.unsafe(`
          INSERT INTO result_reducer_versions
            (id, reducer_key, reducer_version, build_id, policy_sha256, policy, source)
          VALUES
            ('${id.forgedLifecycleReducer}', '0106-forged-child-lifecycle', 'v1',
             'test-build', '${NULL_POINTER_AUDIT_SHA}', '{}'::jsonb, 'test');
          INSERT INTO result_interpretation_backfill_runs
            (id, reducer_version_id, state, scope, summary, requested_by, started_at)
          VALUES
            (
              '${id.forgedLifecycleAuditRun}', '${id.forgedLifecycleReducer}', 'running',
              jsonb_build_object(
                'contract', 'archive-clean-cycle-historical-released-audit-v1',
                'canonicalSelection', 'forbidden',
                'physicalRecovery', 'record-only',
                'campaignMutation', 'forbidden',
                'rawEvidenceImmutable', true,
                'exactSource', jsonb_build_object(
                  'resultId', '${id.result}',
                  'resultAttemptId', '${id.attempt}',
                  'sourceArchiveId', '${id.archive}'
                )
              ),
              '{}'::jsonb, '0106-forged-lifecycle-test', now()
            );
          INSERT INTO result_interpretation_backfill_items
            (id, run_id, result_id, result_attempt_id, source_archive_id,
             state, attempt_count, claim_token, claim_expires_at,
             result_interpretation_id, historical_audit_decision_id,
             historical_audit_reducer_state,
             historical_audit_input_evidence_signature)
          VALUES
            ('${id.forgedLifecycleAuditItem}', '${id.forgedLifecycleAuditRun}',
             '${id.result}', '${id.attempt}', '${id.archive}',
             'reduced', 1, NULL, NULL, '${id.historicalInterpretation}',
             '${id.forgedLifecycleAuditDecision}', 'accepted',
             '${HISTORICAL_AUDIT_SHA}');
        `);
        await tx.unsafe(`
          INSERT INTO historical_archive_audit_decisions
            (id, audit_run_id, result_id, result_attempt_id, source_archive_id,
             reducer_version_id, input_evidence_signature, reducer_state,
             result_interpretation_id, diagnostics)
          VALUES
            ('${id.forgedLifecycleAuditDecision}', '${id.forgedLifecycleAuditRun}',
             '${id.result}', '${id.attempt}', '${id.archive}',
             '${id.forgedLifecycleReducer}', '${HISTORICAL_AUDIT_SHA}',
             'accepted', '${id.historicalInterpretation}', '{}'::jsonb);
        `);
        // If a lifecycle regression lets both direct writes through, force
        // rollback so this must-catch test cannot contaminate later fixtures.
        throw new Error("forged terminal child escaped lifecycle fence");
      }),
    ).rejects.toThrow(
      /historical archive audit child must be inserted as an unclaimed pending receipt/,
    );

    // The valid path is atomically child-first: terminal claimed receipt,
    // explicit decision id, then immutable decision. Deferred FK/pair checks
    // validate the completed transaction, rather than accepting a free
    // standing decision.
    await insertHistoricalAuditDecisionWithChildReceipt({
      itemId: id.auditItem,
      decisionId: id.validAuditDecision,
      auditRunId: id.auditRun,
      resultId: id.result,
      resultAttemptId: id.attempt,
      sourceArchiveId: id.archive,
      reducerVersionId: id.reducer,
      inputEvidenceSignature: HISTORICAL_AUDIT_SHA,
      reducerState: "accepted",
      resultInterpretationId: id.historicalInterpretation,
    });

    // A second direct decision cannot reuse the settled run: it carries no
    // child pointer, and must not be admitted merely because the first valid
    // receipt already exists.
    await expect(client.unsafe(`
      INSERT INTO historical_archive_audit_decisions
        (audit_run_id, result_id, result_attempt_id, source_archive_id,
         reducer_version_id, input_evidence_signature, reducer_state, diagnostics)
      VALUES
        ('${id.auditRun}', '${id.result}', '${id.attempt}', '${id.archive}',
         '${id.reducer}', '${NULL_POINTER_AUDIT_SHA}', 'missing_evidence', '{}'::jsonb);
    `)).rejects.toThrow(
      /historical archive audit decision requires one exact terminal child execution receipt/,
    );

    // Once an actual child receipt is prepared, the older released-source
    // admission fence still runs. 0106 adds provenance; it must not obscure
    // source/publication failures behind the new child requirement.
    await client.unsafe(`
      UPDATE results
      SET current_result_attempt_id = '${id.attempt}'
      WHERE id = '${id.result}';
    `);
    try {
      await expect(insertHistoricalAuditDecisionWithChildReceipt({
        itemId: id.wrongSourceAuditItem,
        decisionId: id.releasedSourceDecision,
        auditRunId: id.wrongSourceAuditRun,
        resultId: id.result,
        resultAttemptId: id.attempt,
        sourceArchiveId: id.archive,
        reducerVersionId: id.reducer,
        inputEvidenceSignature: INVALID_AUDIT_SHA,
        reducerState: "missing_evidence",
      })).rejects.toThrow(
        /requires a released, completed URANS-compatible attempt with an exact current verified GCS Zstandard archive/,
      );
    } finally {
      await client.unsafe(`
        UPDATE results
        SET current_result_attempt_id = NULL
        WHERE id = '${id.result}';
      `);
    }

    await client.unsafe(`
      INSERT INTO result_attempts
        (id, result_id, airfoil_id, bc_id, aoa_deg, status, source, regime,
         evidence_payload)
      VALUES
        ('${id.invalidSourceAttempt}', '${id.result}', '${id.airfoil}', '${id.boundary}', 4,
         'done', 'solved', 'urans', '{"fidelity":"urans_precalc"}'::jsonb);
      INSERT INTO solver_evidence_artifacts
        (id, result_id, result_attempt_id, airfoil_id, aoa_deg, kind,
         storage_key, mime_type, sha256, byte_size, metadata)
      VALUES
        ('${id.invalidSourceArtifact}', '${id.result}', '${id.invalidSourceAttempt}',
         '${id.airfoil}', 4, 'openfoam_bundle', 'test/0103/volume-source.tar.zst',
         'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, '{}'::jsonb);
      INSERT INTO solver_evidence_blobs
        (id, backend, bucket, object_key, generation, compression, mime_type,
         sha256, byte_size, crc32c, uncompressed_tar_sha256,
         uncompressed_tar_byte_size, "verifiedAt", metadata)
      VALUES
        ('${id.invalidSourceBlob}', 'volume', NULL, 'test/0103/volume-source.tar.zst', NULL,
         'zstd', 'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, 'AAAAAA==',
         '${PUBLICATION_ARCHIVE_SHA}', 202, now(),
         '{"archiveFormat":"tar+zstd","zstdLevel":9}'::jsonb);
      INSERT INTO solver_evidence_archives
        (id, result_id, result_attempt_id, source_artifact_id, blob_id, state)
      VALUES
        ('${id.invalidSourceArchive}', '${id.result}', '${id.invalidSourceAttempt}',
         '${id.invalidSourceArtifact}', '${id.invalidSourceBlob}', 'current');
      INSERT INTO result_interpretation_backfill_runs
        (id, reducer_version_id, state, scope, summary, requested_by, started_at)
      VALUES
        (
          '${id.invalidSourceAuditRun}', '${id.reducer}', 'running',
          jsonb_build_object(
            'contract', 'archive-clean-cycle-historical-released-audit-v1',
            'canonicalSelection', 'forbidden',
            'physicalRecovery', 'record-only',
            'campaignMutation', 'forbidden',
            'rawEvidenceImmutable', true,
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.invalidSourceAttempt}',
              'sourceArchiveId', '${id.invalidSourceArchive}'
            )
          ),
          '{}'::jsonb, '0103-test', now()
        );
      INSERT INTO result_interpretation_backfill_items
        (id, run_id, result_id, result_attempt_id, source_archive_id,
         state, attempt_count, claim_token, claim_expires_at)
      VALUES
        ('${id.invalidSourceAuditItem}', '${id.invalidSourceAuditRun}',
         '${id.result}', '${id.invalidSourceAttempt}', '${id.invalidSourceArchive}',
         'pending', 0, NULL, NULL);
      UPDATE result_interpretation_backfill_items
      SET state = 'hydrating',
          attempt_count = 1,
          claim_token = '${id.auditClaim}',
          claim_expires_at = now() + interval '15 minutes'
      WHERE id = '${id.invalidSourceAuditItem}';
    `);

    await expect(insertHistoricalAuditDecisionWithChildReceipt({
      itemId: id.invalidSourceAuditItem,
      decisionId: id.invalidSourceDecision,
      auditRunId: id.invalidSourceAuditRun,
      resultId: id.result,
      resultAttemptId: id.invalidSourceAttempt,
      sourceArchiveId: id.invalidSourceArchive,
      reducerVersionId: id.reducer,
      inputEvidenceSignature: INVALID_SOURCE_AUDIT_SHA,
      reducerState: "missing_evidence",
    })).rejects.toThrow(
      /requires a released, completed URANS-compatible attempt with an exact current verified GCS Zstandard archive/,
    );
    // The pre-existing blob key constraint came from a raw SQL migration that
    // historically accepted one backslash. Preserve that representative
    // legacy shape: 0103's audit-only trigger itself must still refuse it,
    // because audit admission is a new proof boundary.
    await client.unsafe(`
      INSERT INTO result_attempts
        (id, result_id, airfoil_id, bc_id, aoa_deg, status, source, regime,
         evidence_payload)
      VALUES
        ('${id.singleBackslashAttempt}', '${id.result}', '${id.airfoil}', '${id.boundary}', 5,
         'done', 'solved', 'urans', '{"fidelity":"urans_precalc"}'::jsonb);
      INSERT INTO solver_evidence_artifacts
        (id, result_id, result_attempt_id, airfoil_id, aoa_deg, kind,
         storage_key, mime_type, sha256, byte_size, metadata)
      VALUES
        ('${id.singleBackslashArtifact}', '${id.result}', '${id.singleBackslashAttempt}',
         '${id.airfoil}', 5, 'openfoam_bundle', 'test/0103/single-backslash.tar.zst',
         'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, '{}'::jsonb);
      INSERT INTO solver_evidence_blobs
        (id, backend, bucket, object_key, generation, compression, mime_type,
         sha256, byte_size, crc32c, uncompressed_tar_sha256,
         uncompressed_tar_byte_size, "verifiedAt", metadata)
      VALUES
        ('${id.singleBackslashBlob}', 'gcs', 'test-bucket',
         'test/0103/single' || chr(92) || 'backslash.tar.zst', '103', 'zstd',
         'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, 'AAAAAA==',
         '${PUBLICATION_ARCHIVE_SHA}', 202, now(),
         '{"archiveFormat":"tar+zstd","zstdLevel":9}'::jsonb);
      INSERT INTO solver_evidence_archives
        (id, result_id, result_attempt_id, source_artifact_id, blob_id, state)
      VALUES
        ('${id.singleBackslashArchive}', '${id.result}', '${id.singleBackslashAttempt}',
         '${id.singleBackslashArtifact}', '${id.singleBackslashBlob}', 'current');
      INSERT INTO result_interpretation_backfill_runs
        (id, reducer_version_id, state, scope, summary, requested_by, started_at)
      VALUES
        (
          '${id.singleBackslashAuditRun}', '${id.reducer}', 'running',
          jsonb_build_object(
            'contract', 'archive-clean-cycle-historical-released-audit-v1',
            'canonicalSelection', 'forbidden',
            'physicalRecovery', 'record-only',
            'campaignMutation', 'forbidden',
            'rawEvidenceImmutable', true,
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.singleBackslashAttempt}',
              'sourceArchiveId', '${id.singleBackslashArchive}'
            )
          ),
          '{}'::jsonb, '0103-test', now()
        );
      INSERT INTO result_interpretation_backfill_items
        (id, run_id, result_id, result_attempt_id, source_archive_id,
         state, attempt_count, claim_token, claim_expires_at)
      VALUES
        ('${id.singleBackslashAuditItem}', '${id.singleBackslashAuditRun}',
         '${id.result}', '${id.singleBackslashAttempt}', '${id.singleBackslashArchive}',
         'pending', 0, NULL, NULL);
      UPDATE result_interpretation_backfill_items
      SET state = 'hydrating',
          attempt_count = 1,
          claim_token = '${id.auditClaim}',
          claim_expires_at = now() + interval '15 minutes'
      WHERE id = '${id.singleBackslashAuditItem}';
    `);

    await expect(insertHistoricalAuditDecisionWithChildReceipt({
      itemId: id.singleBackslashAuditItem,
      decisionId: id.singleBackslashDecision,
      auditRunId: id.singleBackslashAuditRun,
      resultId: id.result,
      resultAttemptId: id.singleBackslashAttempt,
      sourceArchiveId: id.singleBackslashArchive,
      reducerVersionId: id.reducer,
      inputEvidenceSignature: SINGLE_BACKSLASH_AUDIT_SHA,
      reducerState: "missing_evidence",
    })).rejects.toThrow(
      /requires a released, completed URANS-compatible attempt with an exact current verified GCS Zstandard archive/,
    );

    // The historical interpretation is admissible immutable audit evidence,
    // but must never become a canonical selection through a direct writer.
    await expect(client.unsafe(`
      INSERT INTO result_canonical_selections
        (id, result_id, result_attempt_id, result_interpretation_id,
         selection_namespace, reason, actor)
      VALUES
        ('${id.auditCanonicalSelection}', '${id.result}', '${id.attempt}',
         '${id.historicalInterpretation}', 'audit-v1',
         'must remain audit-only', '0104-test');
    `)).rejects.toThrow(
      /canonical selection cannot reference a historical archive audit interpretation/,
    );

    // A normal archive-backfill interpretation remains selectable and its
    // projection must carry the exact selected attempt.
    await client.unsafe(`
      INSERT INTO result_canonical_selections
        (id, result_id, result_attempt_id, result_interpretation_id,
         selection_namespace, reason, actor)
      VALUES
        ('${id.publicationCanonicalSelection}', '${id.result}', '${id.attempt}',
         '${id.publicationInterpretation}', 'publication-v1',
         'accepted archive publication', '0104-test');
    `);

    await expect(client.unsafe(`
      UPDATE results
      SET current_result_attempt_id = NULL,
          current_result_interpretation_id = '${id.publicationInterpretation}',
          current_canonical_selection_id = '${id.publicationCanonicalSelection}'
      WHERE id = '${id.result}';
    `)).rejects.toThrow(
      /current attempt must match its canonical selection/,
    );

    await expect(client.unsafe(`
      UPDATE results
      SET current_result_attempt_id = '${id.invalidSourceAttempt}',
          current_result_interpretation_id = '${id.publicationInterpretation}',
          current_canonical_selection_id = '${id.publicationCanonicalSelection}'
      WHERE id = '${id.result}';
    `)).rejects.toThrow(
      /current attempt, interpretation, and selection must match one canonical selection/,
    );

    await expect(client.unsafe(`
      UPDATE results
      SET current_result_attempt_id = '${id.attempt}',
          current_result_interpretation_id = '${id.publicationInterpretation}',
          current_canonical_selection_id = '${id.publicationCanonicalSelection}'
      WHERE id = '${id.result}';
    `)).resolves.toBeDefined();

    // The projection trigger must also fire when only the current attempt is
    // changed.  Before 0104 it listened only to the two projection pointers,
    // so this direct write could silently detach the result from its selected
    // attempt after a valid canonical projection had been installed.
    await expect(client.unsafe(`
      UPDATE results
      SET current_result_attempt_id = '${id.invalidSourceAttempt}'
      WHERE id = '${id.result}';
    `)).rejects.toThrow(
      /current attempt, interpretation, and selection must match one canonical selection/,
    );

    // Simulate an immutable historical selection inserted before 0104 (or
    // imported through a controlled forensic path). The projection validator
    // must still reject it even though the selection insert validator was not
    // allowed to inspect that pre-existing row at its original write time.
    await client.unsafe(`
      ALTER TABLE result_canonical_selections
        DISABLE TRIGGER result_canonical_selections_validate_insert;
    `);
    try {
      await client.unsafe(`
        INSERT INTO result_canonical_selections
          (id, result_id, result_attempt_id, result_interpretation_id,
           selection_namespace, reason, actor)
        VALUES
          ('${id.auditCanonicalSelection}', '${id.result}', '${id.attempt}',
           '${id.historicalInterpretation}', 'audit-v1',
           'immutable pre-fence audit history', '0104-test');
      `);
    } finally {
      await client.unsafe(`
        ALTER TABLE result_canonical_selections
          ENABLE TRIGGER result_canonical_selections_validate_insert;
      `);
    }

    await expect(client.unsafe(`
      UPDATE results
      SET current_result_attempt_id = '${id.attempt}',
          current_result_interpretation_id = '${id.historicalInterpretation}',
          current_canonical_selection_id = '${id.auditCanonicalSelection}'
      WHERE id = '${id.result}';
    `)).rejects.toThrow(
      /result projection cannot reference a historical archive audit interpretation/,
    );

    // A pre-0104 direct writer could have installed this exact projection
    // before the new validator existed. The migration must reject that live
    // public pointer rather than merely preserving it and fencing later
    // writes. The standalone immutable audit selection above remains valid
    // forensic history once the result projection is cleared.
    await client.unsafe(`
      ALTER TABLE results
        DISABLE TRIGGER results_validate_interpretation_projection;
    `);
    try {
      await client.unsafe(`
        UPDATE results
        SET current_result_attempt_id = NULL,
            current_result_interpretation_id = '${id.historicalInterpretation}',
            current_canonical_selection_id = '${id.auditCanonicalSelection}'
        WHERE id = '${id.result}';
      `);
    } finally {
      await client.unsafe(`
        ALTER TABLE results
          ENABLE TRIGGER results_validate_interpretation_projection;
      `);
    }

    const preexistingAuditProjection = await readResultInterpretationLedgerPreflight(
      drizzle(client) as unknown as DB,
    );
    expect(preexistingAuditProjection.state).toBe("incompatible");
    expect(preexistingAuditProjection.issues).toContain(
      "historical audit interpretation is exposed by a current result projection",
    );
    await expect(
      client.unsafe(historicalAuditCanonicalSelectionFencePreflightSql()),
    ).rejects.toThrow(
      /0104 migration blocked: a current result projects a historical archive audit interpretation/,
    );

    // Keep later 0103 admission cases on the released-result fixture. The
    // append-only selections remain durable test evidence; only the current
    // result read-model projection is reset.
    await client.unsafe(`
      UPDATE results
      SET current_result_attempt_id = NULL,
          current_result_interpretation_id = NULL,
          current_canonical_selection_id = NULL
      WHERE id = '${id.result}';
    `);
    await expect(
      readResultInterpretationLedgerPreflight(drizzle(client) as unknown as DB),
    ).resolves.toMatchObject({ state: "postledger_0106", issues: [] });
  });

  it("rejects an expired scientific historical-audit settlement but permits an expired operational failure", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;

    // A claim must be admitted while live. Let it expire naturally rather than
    // fabricating a past claim, so this exercises the stale-worker settlement
    // path instead of only the pending-claim admission fence.
    await client.unsafe(`
      BEGIN;
      INSERT INTO result_interpretation_backfill_runs
        (id, reducer_version_id, state, scope, summary, requested_by, started_at)
      VALUES
        (
          '${id.expiredLeaseAuditRun}', '${id.reducer}', 'running',
          jsonb_build_object(
            'contract', 'archive-clean-cycle-historical-released-audit-v1',
            'canonicalSelection', 'forbidden',
            'physicalRecovery', 'record-only',
            'campaignMutation', 'forbidden',
            'rawEvidenceImmutable', true,
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.attempt}',
              'sourceArchiveId', '${id.archive}'
            )
          ),
          '{}'::jsonb, '0106-expired-lease-test', now()
        );
      INSERT INTO result_interpretation_backfill_items
        (id, run_id, result_id, result_attempt_id, source_archive_id,
         state, attempt_count, claim_token, claim_expires_at)
      VALUES
        ('${id.expiredLeaseAuditItem}', '${id.expiredLeaseAuditRun}',
         '${id.result}', '${id.attempt}', '${id.archive}',
         'pending', 0, NULL, NULL);
      UPDATE result_interpretation_backfill_items
      SET state = 'hydrating',
          attempt_count = 1,
          claim_token = '${id.expiredLeaseAuditClaim}',
          claim_expires_at = clock_timestamp() + interval '250 milliseconds'
      WHERE id = '${id.expiredLeaseAuditItem}';
      COMMIT;
    `);
    await client.unsafe("SELECT pg_sleep(0.35);");

    // Scientific terminal evidence must be committed by the worker that still
    // owns the lease. The deliberately absent decision row is harmless here:
    // lifecycle rejection happens before deferred receipt/FK validation.
    await expect(client.unsafe(`
      UPDATE result_interpretation_backfill_items
      SET state = 'reduced',
          claim_token = NULL,
          claim_expires_at = NULL,
          result_interpretation_id = '${id.historicalInterpretation}',
          historical_audit_decision_id = '${id.expiredLeaseAuditDecision}',
          historical_audit_reducer_state = 'accepted',
          historical_audit_input_evidence_signature = '${HISTORICAL_AUDIT_SHA}'
      WHERE id = '${id.expiredLeaseAuditItem}';
    `)).rejects.toThrow(
      /historical archive audit scientific terminal settlement requires a still-live claimed lease/,
    );

    // A stale claim can still be closed as an operational failure. It must not
    // carry a scientific interpretation or decision receipt.
    await client.unsafe(`
      UPDATE result_interpretation_backfill_items
      SET state = 'failed',
          claim_token = NULL,
          claim_expires_at = NULL,
          last_error = 'expired audit lease closed without scientific settlement'
      WHERE id = '${id.expiredLeaseAuditItem}';
    `);
    const [closed] = await client<
      Array<{
        state: string;
        claimTokenNull: boolean;
        claimExpiresAtNull: boolean;
        resultInterpretationId: string | null;
        historicalAuditDecisionId: string | null;
        historicalAuditReducerState: string | null;
        historicalAuditInputEvidenceSignature: string | null;
        lastError: string | null;
      }>
    >`
      SELECT
        state,
        claim_token IS NULL AS "claimTokenNull",
        claim_expires_at IS NULL AS "claimExpiresAtNull",
        result_interpretation_id AS "resultInterpretationId",
        historical_audit_decision_id AS "historicalAuditDecisionId",
        historical_audit_reducer_state AS "historicalAuditReducerState",
        historical_audit_input_evidence_signature AS "historicalAuditInputEvidenceSignature",
        last_error AS "lastError"
      FROM result_interpretation_backfill_items
      WHERE id = ${id.expiredLeaseAuditItem};
    `;
    expect(closed).toEqual({
      state: "failed",
      claimTokenNull: true,
      claimExpiresAtNull: true,
      resultInterpretationId: null,
      historicalAuditDecisionId: null,
      historicalAuditReducerState: null,
      historicalAuditInputEvidenceSignature: null,
      lastError: "expired audit lease closed without scientific settlement",
    });
  });

  it("requires a running historical-audit parent for lease entry and renewal", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;
    const inactiveParentStates = [
      "planned",
      "completed",
      "failed",
      "cancelled",
    ] as const;

    const insertAuditReceipt = async (
      state: typeof inactiveParentStates[number],
    ) => {
      await client.unsafe(`
        INSERT INTO result_interpretation_backfill_runs
          (id, reducer_version_id, state, scope, summary, requested_by, started_at)
        VALUES
          (
            '${id.inactiveParentAuditRun}', '${id.reducer}', '${state}',
            jsonb_build_object(
              'contract', 'archive-clean-cycle-historical-released-audit-v1',
              'canonicalSelection', 'forbidden',
              'physicalRecovery', 'record-only',
              'campaignMutation', 'forbidden',
              'rawEvidenceImmutable', true,
              'exactSource', jsonb_build_object(
                'resultId', '${id.result}',
                'resultAttemptId', '${id.attempt}',
                'sourceArchiveId', '${id.archive}'
              )
            ),
            '{}'::jsonb, '0106-parent-authority-test', now()
          );
        INSERT INTO result_interpretation_backfill_items
          (id, run_id, result_id, result_attempt_id, source_archive_id,
           state, attempt_count, claim_token, claim_expires_at)
        VALUES
          ('${id.inactiveParentAuditItem}', '${id.inactiveParentAuditRun}',
           '${id.result}', '${id.attempt}', '${id.archive}',
           'pending', 0, NULL, NULL);
      `);
    };

    try {
      // Direct SQL must not turn an audit receipt into a lease once its parent
      // has not yet started or has already stopped. The controller can still
      // retain those audit rows as immutable forensic history.
      for (const state of inactiveParentStates) {
        await insertAuditReceipt(state);
        await expect(client.unsafe(`
          UPDATE result_interpretation_backfill_items
          SET state = 'hydrating',
              attempt_count = 1,
              claim_token = '${id.inactiveParentAuditClaim}',
              claim_expires_at = clock_timestamp() + interval '15 minutes'
          WHERE id = '${id.inactiveParentAuditItem}';
        `)).rejects.toThrow(
          /historical archive audit child lease requires a running parent audit run/,
        );
        await client.unsafe(`
          DELETE FROM result_interpretation_backfill_runs
          WHERE id = '${id.inactiveParentAuditRun}';
        `);
      }

      // A parent can stop after a valid lease was granted. Renewal follows the
      // same child → parent guard so a stale worker cannot keep that lease
      // alive after the audit run completes.
      await insertAuditReceipt("running");
      await client.unsafe(`
        UPDATE result_interpretation_backfill_items
        SET state = 'hydrating',
            attempt_count = 1,
            claim_token = '${id.inactiveParentAuditClaim}',
            claim_expires_at = clock_timestamp() + interval '15 minutes'
        WHERE id = '${id.inactiveParentAuditItem}';
        UPDATE result_interpretation_backfill_runs
        SET state = 'completed',
            completed_at = clock_timestamp()
        WHERE id = '${id.inactiveParentAuditRun}';
      `);
      await expect(client.unsafe(`
        UPDATE result_interpretation_backfill_items
        SET claim_expires_at = clock_timestamp() + interval '15 minutes'
        WHERE id = '${id.inactiveParentAuditItem}';
      `)).rejects.toThrow(
        /historical archive audit child lease requires a running parent audit run/,
      );
    } finally {
      await client.unsafe(`
        DELETE FROM result_interpretation_backfill_runs
        WHERE id = '${id.inactiveParentAuditRun}';
      `);
    }
  });

  it("rejects resurrection of a terminal historical-audit run while retaining completed-to-failed correction", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;
    const terminalStates = ["failed", "cancelled", "completed"] as const;

    for (const state of terminalStates) {
      // An existing pending child makes this the real direct-SQL bypass: without
      // the run lifecycle fence, changing the parent back to running would hand
      // the same immutable audit receipt back to the normal claim path.
      await expect(client.begin(async (tx) => {
        await tx.unsafe(`
          INSERT INTO result_interpretation_backfill_runs
            (id, reducer_version_id, state, scope, summary, requested_by, started_at)
          VALUES
            (
              '${id.terminalStateAuditRun}', '${id.reducer}', '${state}',
              jsonb_build_object(
                'contract', 'archive-clean-cycle-historical-released-audit-v1',
                'canonicalSelection', 'forbidden',
                'physicalRecovery', 'record-only',
                'campaignMutation', 'forbidden',
                'rawEvidenceImmutable', true,
                'exactSource', jsonb_build_object(
                  'resultId', '${id.result}',
                  'resultAttemptId', '${id.attempt}',
                  'sourceArchiveId', '${id.archive}'
                )
              ),
              '{}'::jsonb, '0105-terminal-lifecycle-test', now()
            );
          INSERT INTO result_interpretation_backfill_items
            (id, run_id, result_id, result_attempt_id, source_archive_id,
             state, attempt_count, claim_token, claim_expires_at)
          VALUES
            ('${id.terminalStateAuditItem}', '${id.terminalStateAuditRun}',
             '${id.result}', '${id.attempt}', '${id.archive}',
             'pending', 0, NULL, NULL);
          UPDATE result_interpretation_backfill_runs
          SET state = 'running',
              completed_at = NULL
          WHERE id = '${id.terminalStateAuditRun}';
        `);
      })).rejects.toThrow(
        /historical archive audit run is terminal and cannot be resumed/,
      );
    }

    // A completed audit whose source disappears during final reconciliation
    // remains allowed to become failed; that preserves the forensic truth
    // without treating completion as an irreversible publication result.
    try {
      await client.unsafe(`
        INSERT INTO result_interpretation_backfill_runs
          (id, reducer_version_id, state, scope, summary, requested_by, started_at, completed_at)
        VALUES
          (
            '${id.terminalStateAuditRun}', '${id.reducer}', 'completed',
            jsonb_build_object(
              'contract', 'archive-clean-cycle-historical-released-audit-v1',
              'canonicalSelection', 'forbidden',
              'physicalRecovery', 'record-only',
              'campaignMutation', 'forbidden',
              'rawEvidenceImmutable', true,
              'exactSource', jsonb_build_object(
                'resultId', '${id.result}',
                'resultAttemptId', '${id.attempt}',
                'sourceArchiveId', '${id.archive}'
              )
            ),
            '{}'::jsonb, '0105-terminal-lifecycle-test', now(), now()
          );
        INSERT INTO result_interpretation_backfill_items
          (id, run_id, result_id, result_attempt_id, source_archive_id,
           state, attempt_count, claim_token, claim_expires_at)
        VALUES
          ('${id.terminalStateAuditItem}', '${id.terminalStateAuditRun}',
           '${id.result}', '${id.attempt}', '${id.archive}',
           'pending', 0, NULL, NULL);
        UPDATE result_interpretation_backfill_runs
        SET state = 'failed'
        WHERE id = '${id.terminalStateAuditRun}';
      `);
      const [corrected] = await client<
        Array<{ state: string }>
      >`
        SELECT state
        FROM result_interpretation_backfill_runs
        WHERE id = ${id.terminalStateAuditRun};
      `;
      expect(corrected).toEqual({ state: "failed" });
    } finally {
      await client.unsafe(`
        DELETE FROM result_interpretation_backfill_runs
        WHERE id = '${id.terminalStateAuditRun}';
      `);
    }
  });

  it("rejects moving an ordinary pending receipt into a historical audit run", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;

    // This is the reciprocal of the existing audit-child reparenting guard.
    // The generic receipt happens to name the exact same source, but it was
    // not born through the explicit audit command and must not become a
    // forensic audit lifecycle by changing only run_id.
    await expect(client.begin(async (tx) => {
      await tx.unsafe(`
        INSERT INTO result_interpretation_backfill_runs
          (id, reducer_version_id, state, scope, summary, requested_by, started_at)
        VALUES
          ('${id.genericToAuditRun}', '${id.reducer}', 'running',
           '{}'::jsonb, '{}'::jsonb, '0106-generic-reparent-test', now()),
          (
            '${id.genericToAuditParent}', '${id.reducer}', 'running',
            jsonb_build_object(
              'contract', 'archive-clean-cycle-historical-released-audit-v1',
              'canonicalSelection', 'forbidden',
              'physicalRecovery', 'record-only',
              'campaignMutation', 'forbidden',
              'rawEvidenceImmutable', true,
              'exactSource', jsonb_build_object(
                'resultId', '${id.result}',
                'resultAttemptId', '${id.attempt}',
                'sourceArchiveId', '${id.archive}'
              )
            ),
            '{}'::jsonb, '0106-generic-reparent-test', now()
          );
        INSERT INTO result_interpretation_backfill_items
          (id, run_id, result_id, result_attempt_id, source_archive_id,
           state, attempt_count, claim_token, claim_expires_at)
        VALUES
          ('${id.genericToAuditItem}', '${id.genericToAuditRun}',
           '${id.result}', '${id.attempt}', '${id.archive}',
           'pending', 0, NULL, NULL);
      `);
      await tx.unsafe(`
        UPDATE result_interpretation_backfill_items
        SET run_id = '${id.genericToAuditParent}'
        WHERE id = '${id.genericToAuditItem}';
      `);
    })).rejects.toThrow(
      /historical archive audit child must be inserted directly into its exact audit run/,
    );
  });

  it("rejects NULL-required historical audit source and run fields at the direct SQL boundary", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;

    await client.unsafe(`
      INSERT INTO result_attempts
        (id, result_id, airfoil_id, bc_id, aoa_deg, status, source, regime,
         evidence_payload)
      VALUES
        ('${id.missingFidelityAttempt}', '${id.result}', '${id.airfoil}', '${id.boundary}', 6,
         'done', 'solved', 'urans', '{}'::jsonb),
        ('${id.missingRegimeAttempt}', '${id.result}', '${id.airfoil}', '${id.boundary}', 7,
         'done', 'solved', NULL, '{"fidelity":"urans_precalc"}'::jsonb),
        ('${id.missingZstdLevelAttempt}', '${id.result}', '${id.airfoil}', '${id.boundary}', 8,
         'done', 'solved', 'urans', '{"fidelity":"urans_precalc"}'::jsonb);
      INSERT INTO solver_evidence_artifacts
        (id, result_id, result_attempt_id, airfoil_id, aoa_deg, kind,
         storage_key, mime_type, sha256, byte_size, metadata)
      VALUES
        ('${id.missingFidelityArtifact}', '${id.result}', '${id.missingFidelityAttempt}',
         '${id.airfoil}', 6, 'openfoam_bundle', 'test/0103/missing-fidelity.tar.zst',
         'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, '{}'::jsonb),
        ('${id.missingRegimeArtifact}', '${id.result}', '${id.missingRegimeAttempt}',
         '${id.airfoil}', 7, 'openfoam_bundle', 'test/0103/missing-regime.tar.zst',
         'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, '{}'::jsonb),
        ('${id.missingZstdLevelArtifact}', '${id.result}', '${id.missingZstdLevelAttempt}',
         '${id.airfoil}', 8, 'openfoam_bundle', 'test/0103/missing-zstd-level.tar.zst',
         'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, '{}'::jsonb);
      INSERT INTO solver_evidence_blobs
        (id, backend, bucket, object_key, generation, compression, mime_type,
         sha256, byte_size, crc32c, uncompressed_tar_sha256,
         uncompressed_tar_byte_size, "verifiedAt", metadata)
      VALUES
        ('${id.missingZstdLevelBlob}', 'gcs', 'test-bucket',
         'test/0103/missing-zstd-level.tar.zst', '104', 'zstd',
         'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, 'AAAAAA==',
         '${PUBLICATION_ARCHIVE_SHA}', 202, now(),
         '{"archiveFormat":"tar+zstd"}'::jsonb);
      INSERT INTO solver_evidence_archives
        (id, result_id, result_attempt_id, source_artifact_id, blob_id, state)
      VALUES
        ('${id.missingFidelityArchive}', '${id.result}', '${id.missingFidelityAttempt}',
         '${id.missingFidelityArtifact}', '${id.blob}', 'current'),
        ('${id.missingRegimeArchive}', '${id.result}', '${id.missingRegimeAttempt}',
         '${id.missingRegimeArtifact}', '${id.blob}', 'current'),
        ('${id.missingZstdLevelArchive}', '${id.result}', '${id.missingZstdLevelAttempt}',
         '${id.missingZstdLevelArtifact}', '${id.missingZstdLevelBlob}', 'current');
      INSERT INTO result_interpretation_backfill_runs
        (id, reducer_version_id, state, scope, summary, requested_by, started_at)
      VALUES
        (
          '${id.missingFidelityAuditRun}', '${id.reducer}', 'running',
          jsonb_build_object(
            'contract', 'archive-clean-cycle-historical-released-audit-v1',
            'canonicalSelection', 'forbidden',
            'physicalRecovery', 'record-only',
            'campaignMutation', 'forbidden',
            'rawEvidenceImmutable', true,
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.missingFidelityAttempt}',
              'sourceArchiveId', '${id.missingFidelityArchive}'
            )
          ), '{}'::jsonb, '0103-null-test', now()
        ),
        (
          '${id.missingRegimeAuditRun}', '${id.reducer}', 'running',
          jsonb_build_object(
            'contract', 'archive-clean-cycle-historical-released-audit-v1',
            'canonicalSelection', 'forbidden',
            'physicalRecovery', 'record-only',
            'campaignMutation', 'forbidden',
            'rawEvidenceImmutable', true,
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.missingRegimeAttempt}',
              'sourceArchiveId', '${id.missingRegimeArchive}'
            )
          ), '{}'::jsonb, '0103-null-test', now()
        ),
        (
          '${id.missingZstdLevelAuditRun}', '${id.reducer}', 'running',
          jsonb_build_object(
            'contract', 'archive-clean-cycle-historical-released-audit-v1',
            'canonicalSelection', 'forbidden',
            'physicalRecovery', 'record-only',
            'campaignMutation', 'forbidden',
            'rawEvidenceImmutable', true,
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.missingZstdLevelAttempt}',
              'sourceArchiveId', '${id.missingZstdLevelArchive}'
            )
          ), '{}'::jsonb, '0103-null-test', now()
        );
      INSERT INTO result_interpretation_backfill_items
        (id, run_id, result_id, result_attempt_id, source_archive_id,
         state, attempt_count, claim_token, claim_expires_at)
      VALUES
        ('${id.missingFidelityAuditItem}', '${id.missingFidelityAuditRun}',
         '${id.result}', '${id.missingFidelityAttempt}', '${id.missingFidelityArchive}',
         'pending', 0, NULL, NULL),
        ('${id.missingRegimeAuditItem}', '${id.missingRegimeAuditRun}',
         '${id.result}', '${id.missingRegimeAttempt}', '${id.missingRegimeArchive}',
         'pending', 0, NULL, NULL),
        ('${id.missingZstdLevelAuditItem}', '${id.missingZstdLevelAuditRun}',
         '${id.result}', '${id.missingZstdLevelAttempt}', '${id.missingZstdLevelArchive}',
         'pending', 0, NULL, NULL);
      UPDATE result_interpretation_backfill_items
      SET state = 'hydrating',
          attempt_count = 1,
          claim_token = '${id.auditClaim}',
          claim_expires_at = now() + interval '15 minutes'
      WHERE id IN (
        '${id.missingFidelityAuditItem}',
        '${id.missingRegimeAuditItem}',
        '${id.missingZstdLevelAuditItem}'
      );
    `);

    // 0105 validates an audit receipt before the decision writer can see it.
    // The string lookalike and extra exact-source field both differ from the
    // typed, exact contract accepted by the application boundary.
    await expect(client.unsafe(`
      INSERT INTO result_interpretation_backfill_runs
        (id, reducer_version_id, state, scope, summary, requested_by, started_at)
      VALUES
        (
          '${id.malformedScopeAuditRun}', '${id.reducer}', 'running',
          jsonb_build_object(
            'contract', 'archive-clean-cycle-historical-released-audit-v1',
            'canonicalSelection', 'forbidden',
            'physicalRecovery', 'record-only',
            'campaignMutation', 'forbidden',
            'rawEvidenceImmutable', 'true',
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.attempt}',
              'sourceArchiveId', '${id.archive}',
              'unexpected', 'must-not-survive'
            )
          ), '{}'::jsonb, '0105-contract-test', now()
        );
    `)).rejects.toThrow(
      /historical archive audit run requires its exact no-publication authority contract/,
    );

    const sourceError =
      /requires a released, completed URANS-compatible attempt with an exact current verified GCS Zstandard archive/;
    await expect(insertHistoricalAuditDecisionWithChildReceipt({
      itemId: id.missingFidelityAuditItem,
      decisionId: id.missingFidelityDecision,
      auditRunId: id.missingFidelityAuditRun,
      resultId: id.result,
      resultAttemptId: id.missingFidelityAttempt,
      sourceArchiveId: id.missingFidelityArchive,
      reducerVersionId: id.reducer,
      inputEvidenceSignature: MISSING_FIDELITY_AUDIT_SHA,
      reducerState: "missing_evidence",
    })).rejects.toThrow(sourceError);
    await expect(insertHistoricalAuditDecisionWithChildReceipt({
      itemId: id.missingRegimeAuditItem,
      decisionId: id.missingRegimeDecision,
      auditRunId: id.missingRegimeAuditRun,
      resultId: id.result,
      resultAttemptId: id.missingRegimeAttempt,
      sourceArchiveId: id.missingRegimeArchive,
      reducerVersionId: id.reducer,
      inputEvidenceSignature: MISSING_REGIME_AUDIT_SHA,
      reducerState: "missing_evidence",
    })).rejects.toThrow(sourceError);
    await expect(insertHistoricalAuditDecisionWithChildReceipt({
      itemId: id.missingZstdLevelAuditItem,
      decisionId: id.missingZstdLevelDecision,
      auditRunId: id.missingZstdLevelAuditRun,
      resultId: id.result,
      resultAttemptId: id.missingZstdLevelAttempt,
      sourceArchiveId: id.missingZstdLevelArchive,
      reducerVersionId: id.reducer,
      inputEvidenceSignature: MISSING_ZSTD_LEVEL_AUDIT_SHA,
      reducerState: "missing_evidence",
    })).rejects.toThrow(sourceError);
  });

  it("rejects an otherwise-GCS historical source with no generation", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;

    // The normal blob constraint already rejects this malformed GCS shape.
    // Remove it only inside the disposable migration fixture so 0103 itself
    // proves it remains a fail-closed audit admission boundary even if an old
    // or manually repaired database carries the bad row.
    await client.unsafe(`
      ALTER TABLE solver_evidence_blobs
        DROP CONSTRAINT solver_evidence_blobs_backend_shape_check;
    `);
    try {
      await client.unsafe(`
        INSERT INTO result_attempts
          (id, result_id, airfoil_id, bc_id, aoa_deg, status, source, regime,
           evidence_payload)
        VALUES
          ('${id.missingGenerationAttempt}', '${id.result}', '${id.airfoil}', '${id.boundary}', 9,
           'done', 'solved', 'urans', '{"fidelity":"urans_precalc"}'::jsonb);
        INSERT INTO solver_evidence_artifacts
          (id, result_id, result_attempt_id, airfoil_id, aoa_deg, kind,
           storage_key, mime_type, sha256, byte_size, metadata)
        VALUES
          ('${id.missingGenerationArtifact}', '${id.result}', '${id.missingGenerationAttempt}',
           '${id.airfoil}', 9, 'openfoam_bundle', 'test/0103/missing-generation.tar.zst',
           'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, '{}'::jsonb);
        INSERT INTO solver_evidence_blobs
          (id, backend, bucket, object_key, generation, compression, mime_type,
           sha256, byte_size, crc32c, uncompressed_tar_sha256,
           uncompressed_tar_byte_size, "verifiedAt", metadata)
        VALUES
          ('${id.missingGenerationBlob}', 'gcs', 'test-bucket',
           'test/0103/missing-generation.tar.zst', NULL, 'zstd',
           'application/zstd', '${HISTORICAL_AUDIT_SHA}', 101, 'AAAAAA==',
           '${PUBLICATION_ARCHIVE_SHA}', 202, now(),
           '{"archiveFormat":"tar+zstd","zstdLevel":9}'::jsonb);
        INSERT INTO solver_evidence_archives
          (id, result_id, result_attempt_id, source_artifact_id, blob_id, state)
        VALUES
          ('${id.missingGenerationArchive}', '${id.result}', '${id.missingGenerationAttempt}',
           '${id.missingGenerationArtifact}', '${id.missingGenerationBlob}', 'current');
        INSERT INTO result_interpretation_backfill_runs
          (id, reducer_version_id, state, scope, summary, requested_by, started_at)
        VALUES
          (
            '${id.missingGenerationAuditRun}', '${id.reducer}', 'running',
            jsonb_build_object(
              'contract', 'archive-clean-cycle-historical-released-audit-v1',
              'canonicalSelection', 'forbidden',
              'physicalRecovery', 'record-only',
              'campaignMutation', 'forbidden',
              'rawEvidenceImmutable', true,
              'exactSource', jsonb_build_object(
                'resultId', '${id.result}',
                'resultAttemptId', '${id.missingGenerationAttempt}',
                'sourceArchiveId', '${id.missingGenerationArchive}'
              )
            ), '{}'::jsonb, '0103-null-test', now()
          );
        INSERT INTO result_interpretation_backfill_items
          (id, run_id, result_id, result_attempt_id, source_archive_id,
           state, attempt_count, claim_token, claim_expires_at)
        VALUES
          ('${id.missingGenerationAuditItem}', '${id.missingGenerationAuditRun}',
           '${id.result}', '${id.missingGenerationAttempt}',
           '${id.missingGenerationArchive}', 'pending', 0, NULL, NULL);
        UPDATE result_interpretation_backfill_items
        SET state = 'hydrating',
            attempt_count = 1,
            claim_token = '${id.auditClaim}',
            claim_expires_at = now() + interval '15 minutes'
        WHERE id = '${id.missingGenerationAuditItem}';
      `);
      await expect(insertHistoricalAuditDecisionWithChildReceipt({
        itemId: id.missingGenerationAuditItem,
        decisionId: id.missingGenerationDecision,
        auditRunId: id.missingGenerationAuditRun,
        resultId: id.result,
        resultAttemptId: id.missingGenerationAttempt,
        sourceArchiveId: id.missingGenerationArchive,
        reducerVersionId: id.reducer,
        inputEvidenceSignature: MISSING_GENERATION_AUDIT_SHA,
        reducerState: "missing_evidence",
      })).rejects.toThrow(
        /requires a released, completed URANS-compatible attempt with an exact current verified GCS Zstandard archive/,
      );
    } finally {
      await client.unsafe(`
        DELETE FROM result_interpretation_backfill_runs
        WHERE id = '${id.missingGenerationAuditRun}';
        DELETE FROM solver_evidence_archives
        WHERE id = '${id.missingGenerationArchive}';
        DELETE FROM solver_evidence_blobs
        WHERE id = '${id.missingGenerationBlob}';
        DELETE FROM solver_evidence_artifacts
        WHERE id = '${id.missingGenerationArtifact}';
        DELETE FROM result_attempts
        WHERE id = '${id.missingGenerationAttempt}';
        ALTER TABLE solver_evidence_blobs
          ADD CONSTRAINT solver_evidence_blobs_backend_shape_check CHECK (
            (backend = 'volume' AND bucket IS NULL AND generation IS NULL)
            OR (
              backend = 'gcs'
              AND btrim(COALESCE(bucket, '')) <> ''
              AND generation ~ '^[1-9][0-9]{0,19}$'
            )
          );
      `);
    }
  });

  it("fails closed when the final 0106 validator loses an exact audit-run source gate", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const validatorSql = historicalAuditDecisionValidatorSql();
    const weakenedValidatorSql = validatorSql.replace(
      /OR locked_audit_run\."scope" #>> '\{exactSource,sourceArchiveId\}'\s+IS DISTINCT FROM NEW\."source_archive_id"::text THEN/,
      "OR false THEN -- intentionally omitted exact audit archive proof",
    );
    expect(weakenedValidatorSql).not.toBe(validatorSql);

    try {
      await client.unsafe(weakenedValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0103 historical audit decision source/state fence is incompatible",
      );
    } finally {
      // This suite deliberately replays the authoritative final validator
      // rather than hand-maintaining a second copy in test code.
      await client.unsafe(validatorSql);
    }
  });

  it("fails closed when the 0106 lifecycle validator loses its running-parent lease fence", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const lifecycleSql = historicalAuditItemLifecycleValidatorSql();
    const weakenedLifecycleSql = lifecycleSql.replace(
      `    IF parent_state IS DISTINCT FROM 'running' THEN
      RAISE EXCEPTION
        'historical archive audit child lease requires a running parent audit run';
    END IF;`,
      `    IF parent_state IS DISTINCT FROM 'running' THEN
      NULL; -- intentionally omitted running-parent lease fence
    END IF;`,
    );
    expect(weakenedLifecycleSql).not.toBe(lifecycleSql);

    try {
      await client.unsafe(weakenedLifecycleSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0106 historical audit child receipt validator functions are incompatible",
      );
    } finally {
      await client.unsafe(lifecycleSql);
    }
  });

  it("fails closed when the 0106 admission validator loses its reciprocal audit-reparent guard", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const validatorSql = historicalAuditItemAdmissionValidatorSql();
    const weakenedValidatorSql = validatorSql.replace(
      `    IF existing_parent_scope ->> 'contract'
         = 'archive-clean-cycle-historical-released-audit-v1' THEN
      RAISE EXCEPTION
        'historical archive audit child must be inserted directly into its exact audit run';
    END IF;`,
      `    IF false THEN
      RAISE EXCEPTION
        'historical archive audit child must be inserted directly into its exact audit run';
    END IF;`,
    );
    expect(weakenedValidatorSql).not.toBe(validatorSql);

    try {
      await client.unsafe(weakenedValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0106 historical audit child receipt validator functions are incompatible",
      );
    } finally {
      await client.unsafe(validatorSql);
    }
  });

  it("fails closed when the final 0106 validator restores a NULL three-valued admission bypass", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const validatorSql = historicalAuditDecisionValidatorSql();
    // A bare regex comparison is NULL for a missing generation. In an OR
    // rejection predicate that NULL can fall through to acceptance, so 0103
    // must retain the explicit `NOT COALESCE(..., false)` wrapper.
    const weakenedValidatorSql = validatorSql.replace(
      /OR NOT COALESCE\(\s*locked_blob\."generation" ~ '\^\[1-9\]\[0-9\]\{0,19\}\$', false\s*\)/,
      () => `OR NOT (locked_blob."generation" ~ '^[1-9][0-9]{0,19}$')`,
    );
    expect(weakenedValidatorSql).not.toBe(validatorSql);

    try {
      await client.unsafe(weakenedValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0103 historical audit decision source/state fence is incompatible",
      );
    } finally {
      await client.unsafe(validatorSql);
    }
  });

  it("keeps the 0106 child-first direct-decision fence in deadlock-safe lock order", () => {
    const validatorSql = historicalAuditDecisionValidatorSql();
    const lockMarkers = [
      "INTO locked_child",
      "INTO locked_result",
      "INTO locked_attempt",
      "INTO locked_archive",
      "INTO locked_source_artifact",
      "INTO locked_blob",
      "INTO locked_audit_run",
    ];
    let previousOffset = -1;
    for (const marker of lockMarkers) {
      const offset = validatorSql.indexOf(marker);
      expect(offset).toBeGreaterThan(previousOffset);
      previousOffset = offset;
    }

    const childOffset = validatorSql.indexOf("INTO locked_child");
    const resultOffset = validatorSql.indexOf("INTO locked_result");
    const auditRunOffset = validatorSql.indexOf("INTO locked_audit_run");
    expect(validatorSql.indexOf("FOR UPDATE NOWAIT", childOffset)).toBeGreaterThan(
      childOffset,
    );
    expect(validatorSql.indexOf("FOR UPDATE NOWAIT", childOffset)).toBeLessThan(
      resultOffset,
    );
    expect(validatorSql.indexOf("FOR UPDATE NOWAIT", auditRunOffset)).toBeGreaterThan(
      auditRunOffset,
    );
    expect(validatorSql).toContain("WHEN lock_not_available");
    expect(validatorSql).toContain("ERRCODE = '55P03'");
  });

  it("fails closed when the final 0106 validator loses a retryable receipt lock", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const validatorSql = historicalAuditDecisionValidatorSql();
    const unlockedValidatorSql = validatorSql.replace(
      "FOR UPDATE NOWAIT;",
      "FOR UPDATE;",
    );
    expect(unlockedValidatorSql).not.toBe(validatorSql);

    try {
      await client.unsafe(unlockedValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0106 historical audit decision child-first validator is incompatible",
      );
    } finally {
      await client.unsafe(validatorSql);
    }
  });

  it("fails closed when the 0104 canonical validators lose their source or attempt fences", async () => {
    if (!client) throw new Error("migration test database is unavailable");

    const selectionValidatorSql = historicalAuditCanonicalSelectionFenceValidatorSql(
      "validate_result_canonical_selection",
    );
    const weakenedSelectionValidatorSql = selectionValidatorSql.replace(
      "IF interpretation_source = 'historical_archive_audit' THEN",
      "IF FALSE THEN -- intentionally omitted historical-audit source fence",
    );
    expect(weakenedSelectionValidatorSql).not.toBe(selectionValidatorSql);

    try {
      await client.unsafe(weakenedSelectionValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0104 canonical selection and projection fence is incompatible",
      );
    } finally {
      await client.unsafe(selectionValidatorSql);
    }

    const projectionValidatorSql = historicalAuditCanonicalSelectionFenceValidatorSql(
      "validate_result_interpretation_projection",
    );
    const weakenedProjectionValidatorSql = projectionValidatorSql.replace(
      '    AND selection."result_attempt_id" = NEW."current_result_attempt_id"\n    AND selection."result_interpretation_id" = NEW."current_result_interpretation_id";',
      '    AND selection."result_interpretation_id" = NEW."current_result_interpretation_id"; -- intentionally omitted exact selected-attempt fence',
    );
    expect(weakenedProjectionValidatorSql).not.toBe(projectionValidatorSql);

    try {
      await client.unsafe(weakenedProjectionValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0104 canonical selection and projection fence is incompatible",
      );
    } finally {
      await client.unsafe(projectionValidatorSql);
    }

    const projectionTriggerSql =
      historicalAuditCanonicalSelectionFenceProjectionTriggerSql();
    const weakenedProjectionTriggerSql = projectionTriggerSql.replace(
      '  "current_result_attempt_id",\n',
      "",
    );
    expect(weakenedProjectionTriggerSql).not.toBe(projectionTriggerSql);

    try {
      await client.unsafe(weakenedProjectionTriggerSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0104 canonical selection and projection fence is incompatible",
      );
    } finally {
      await client.unsafe(projectionTriggerSql);
    }
  });

  it("locks audit runs before audit decisions while installing the 0105 identity fence", () => {
    const migration = readFileSync(historicalAuditRunIdentityFenceMigration, "utf8");
    const runLock = migration.indexOf(
      'LOCK TABLE "result_interpretation_backfill_runs" IN SHARE ROW EXCLUSIVE MODE NOWAIT;',
    );
    const decisionLock = migration.indexOf(
      'LOCK TABLE "historical_archive_audit_decisions" IN SHARE ROW EXCLUSIVE MODE NOWAIT;',
    );
    const forensicScan = migration.indexOf("IF EXISTS (", runLock);
    const validator = migration.indexOf(
      'CREATE OR REPLACE FUNCTION "validate_historical_archive_audit_run_identity"()',
    );

    // The decision validator only takes a RowShare table lock while it reads
    // its audit run, so run-first does not block an already-started insert.
    // It does avoid the opposite cycle where a direct transaction updates a
    // run then inserts a decision while migration is acquiring its two table
    // fences.
    expect(runLock).toBeGreaterThan(-1);
    expect(decisionLock).toBeGreaterThan(runLock);
    expect(forensicScan).toBeGreaterThan(runLock);
    expect(validator).toBeGreaterThan(forensicScan);
    expect(migration).toContain("NOWAIT");
  });

  it("acquires every 0106 DDL table lock before scanning or changing forensic receipts", () => {
    const migration = readFileSync(historicalAuditChildReceiptFenceMigration, "utf8");
    const itemLock = migration.indexOf(
      'LOCK TABLE "result_interpretation_backfill_items" IN ACCESS EXCLUSIVE MODE NOWAIT;',
    );
    const decisionLock = migration.indexOf(
      'LOCK TABLE "historical_archive_audit_decisions" IN ACCESS EXCLUSIVE MODE NOWAIT;',
    );
    const runLock = migration.indexOf(
      'LOCK TABLE "result_interpretation_backfill_runs" IN ACCESS EXCLUSIVE MODE NOWAIT;',
    );
    const attemptLock = migration.indexOf(
      'LOCK TABLE "result_attempts" IN ACCESS EXCLUSIVE MODE NOWAIT;',
    );
    const firstReceiptDdl = migration.indexOf(
      'ALTER TABLE "result_interpretation_backfill_items"',
    );
    const firstForensicScan = migration.indexOf("IF EXISTS (", attemptLock);

    expect(itemLock).toBeGreaterThan(-1);
    expect(decisionLock).toBeGreaterThan(itemLock);
    expect(runLock).toBeGreaterThan(decisionLock);
    expect(attemptLock).toBeGreaterThan(runLock);
    expect(firstReceiptDdl).toBeGreaterThan(attemptLock);
    expect(firstForensicScan).toBeGreaterThan(attemptLock);
  });

  it("keeps the 0105 preflight fail-closed for a malformed audit run with no decision", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;

    // Reconstruct retained pre-0105 direct-writer history: the run is an
    // audit-shaped row with one child, but its authority contract contains a
    // string lookalike instead of the required boolean. No decision exists.
    // The 0105 migration preflight must scan this run itself rather than only
    // validating decision rows, otherwise a later decision can be smuggled
    // into an already malformed audit scope.
    await client.unsafe(`
      ALTER TABLE result_interpretation_backfill_runs
        DISABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
      ALTER TABLE result_interpretation_backfill_runs
        DISABLE TRIGGER ri_bf_run_audit_child_shape;
    `);
    try {
      await client.begin(async (tx) => {
        await tx.unsafe(`
          INSERT INTO result_interpretation_backfill_runs
            (id, reducer_version_id, state, scope, summary, requested_by, started_at)
          VALUES
            (
              '${id.malformedNoDecisionAuditRun}', '${id.reducer}', 'running',
              jsonb_build_object(
                'contract', 'archive-clean-cycle-historical-released-audit-v1',
                'canonicalSelection', 'forbidden',
                'physicalRecovery', 'record-only',
                'campaignMutation', 'forbidden',
                'rawEvidenceImmutable', 'true',
                'exactSource', jsonb_build_object(
                  'resultId', '${id.result}',
                  'resultAttemptId', '${id.attempt}',
                  'sourceArchiveId', '${id.archive}'
                )
              ), '{}'::jsonb, '0105-forensic-fixture', now()
            );
        `);
        await tx.unsafe(`
          INSERT INTO result_interpretation_backfill_items
            (id, run_id, result_id, result_attempt_id, source_archive_id, state)
          VALUES
            ('${id.malformedNoDecisionAuditItem}',
             '${id.malformedNoDecisionAuditRun}', '${id.result}',
             '${id.attempt}', '${id.archive}', 'pending');
        `);
      });

      await expect(
        client.unsafe(historicalAuditRunIdentityFencePreflightSql()),
      ).rejects.toThrow(/0105 migration blocked:.*historical archive audit run/i);
    } finally {
      await client.unsafe(`
        DELETE FROM result_interpretation_backfill_runs
        WHERE id = '${id.malformedNoDecisionAuditRun}';
        ALTER TABLE result_interpretation_backfill_runs
          ENABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
        ALTER TABLE result_interpretation_backfill_runs
          ENABLE TRIGGER ri_bf_run_audit_child_shape;
      `);
    }
  });

  it("keeps an historical audit run's exact source and reducer immutable without blocking settlement", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;
    const validatorSql = historicalAuditRunIdentityFenceValidatorSql();
    const triggerSql = historicalAuditRunIdentityFenceTriggerSql();

    // The permitted running -> completed settlement keeps its completion
    // metadata mutable; terminal audit states themselves cannot be revived.
    await expect(client.unsafe(`
      UPDATE result_interpretation_backfill_runs
      SET state = 'completed',
          summary = jsonb_build_object('decisionRecorded', true),
          completed_at = now()
      WHERE id = '${id.wrongSourceAuditRun}';
    `)).resolves.toBeDefined();

    await expect(client.unsafe(`
      UPDATE result_interpretation_backfill_runs
      SET scope = jsonb_set(
        scope,
        '{exactSource,resultId}',
        to_jsonb('${id.invalidSourceAttempt}'::text)
      )
      WHERE id = '${id.wrongSourceAuditRun}';
    `)).rejects.toThrow(
      /historical archive audit run identity is immutable/,
    );

    await client.unsafe(`
      INSERT INTO result_reducer_versions
        (id, reducer_key, reducer_version, build_id, policy_sha256, policy, source)
      VALUES
        ('${id.alternateReducer}', '0105-audit', 'v2', 'test-build-0105',
         '${HISTORICAL_AUDIT_SHA}', '{}'::jsonb, 'test');
    `);
    await expect(client.unsafe(`
      UPDATE result_interpretation_backfill_runs
      SET reducer_version_id = '${id.alternateReducer}'
      WHERE id = '${id.wrongSourceAuditRun}';
    `)).rejects.toThrow(
      /historical archive audit run identity is immutable/,
    );

    // A normal backfill remains editable, but it cannot be retyped into an
    // audit receipt after creation either (the NEW-side half of the fence).
    await expect(client.unsafe(`
      UPDATE result_interpretation_backfill_runs
      SET scope = jsonb_set(scope, '{operatorNote}', '"still mutable"'::jsonb)
      WHERE id = '${id.invalidAuditRun}';
    `)).resolves.toBeDefined();
    await expect(client.unsafe(`
      UPDATE result_interpretation_backfill_runs
      SET scope = (
        SELECT scope
        FROM result_interpretation_backfill_runs
        WHERE id = '${id.wrongSourceAuditRun}'
      )
      WHERE id = '${id.invalidAuditRun}';
    `)).rejects.toThrow(
      /historical archive audit run identity is immutable/,
    );

    // A single audit invocation carries one durable outcome. The source/signature
    // identity is intentionally still broader, but a second direct writer has
    // no terminal child receipt to attach to its new immutable decision id.
    await expect(client.unsafe(`
      INSERT INTO historical_archive_audit_decisions
        (audit_run_id, result_id, result_attempt_id, source_archive_id,
         reducer_version_id, input_evidence_signature, reducer_state, diagnostics)
      VALUES
        ('${id.auditRun}', '${id.result}', '${id.attempt}', '${id.archive}',
         '${id.reducer}', '${NULL_POINTER_AUDIT_SHA}', 'missing_evidence', '{}'::jsonb);
    `)).rejects.toThrow(
      /historical archive audit decision requires one exact terminal child execution receipt/,
    );

    // Body fingerprints must prove the bidirectional OR semantics, not merely
    // the presence of both OLD and NEW field names.
    const oneWayValidatorSql = validatorSql.replace(
      `    OR NEW."scope" ->> 'contract'\n      = 'archive-clean-cycle-historical-released-audit-v1'`,
      `    AND NEW."scope" ->> 'contract'\n      = 'archive-clean-cycle-historical-released-audit-v1'`,
    );
    expect(oneWayValidatorSql).not.toBe(validatorSql);
    try {
      await client.unsafe(oneWayValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );
    } finally {
      await client.unsafe(validatorSql);
    }

    const wrongContractValidatorSql = validatorSql.replace(
      /archive-clean-cycle-historical-released-audit-v1/g,
      "archive-clean-cycle-historical-released-audit-v0",
    );
    expect(wrongContractValidatorSql).not.toBe(validatorSql);
    try {
      await client.unsafe(wrongContractValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );
    } finally {
      await client.unsafe(validatorSql);
    }

    // The NEW-side branch is the admission gate for the first receipt. The
    // later OLD/NEW update fence must not let a weakened `IF false` admission
    // branch look healthy merely because it still freezes existing audit runs.
    const insertAuthorityBypassValidatorSql = validatorSql.replace(
      `  IF NEW."scope" ->> 'contract'\n       = 'archive-clean-cycle-historical-released-audit-v1'\n     AND (`,
      "  IF false AND (",
    );
    expect(insertAuthorityBypassValidatorSql).not.toBe(validatorSql);
    try {
      await client.unsafe(insertAuthorityBypassValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );
    } finally {
      await client.unsafe(validatorSql);
    }

    const assertWeakenedAuthorityFence = async (candidate: string) => {
      expect(candidate).not.toBe(validatorSql);
      try {
        await client.unsafe(candidate);
        const weakened = await readResultInterpretationLedgerPreflight(
          drizzle(client) as unknown as DB,
        );
        expect(weakened.state).toBe("incompatible");
        expect(weakened.issues).toContain(
          "0105 historical audit run identity fence is incompatible",
        );
      } finally {
        await client.unsafe(validatorSql);
      }
    };

    await assertWeakenedAuthorityFence(
      validatorSql.replace(
        `       NEW."scope" ->> 'canonicalSelection' IS DISTINCT FROM 'forbidden'`,
        "       false",
      ),
    );
    await assertWeakenedAuthorityFence(
      validatorSql.replace(
        `       OR NEW."scope" ->> 'physicalRecovery' IS DISTINCT FROM 'record-only'`,
        "       OR false",
      ),
    );
    await assertWeakenedAuthorityFence(
      validatorSql.replace(
        `       OR NEW."scope" ->> 'campaignMutation' IS DISTINCT FROM 'forbidden'`,
        "       OR false",
      ),
    );

    const untypedAuthorityValidatorSql = validatorSql.replace(
      `       OR jsonb_typeof(NEW."scope" -> 'rawEvidenceImmutable')
         IS DISTINCT FROM 'boolean'`,
      "       OR false -- intentionally accepts the string lookalike",
    );
    expect(untypedAuthorityValidatorSql).not.toBe(validatorSql);
    try {
      await client.unsafe(untypedAuthorityValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );
    } finally {
      await client.unsafe(validatorSql);
    }

    await assertWeakenedAuthorityFence(
      validatorSql.replace(
        `       OR NEW."scope" ->> 'rawEvidenceImmutable' IS DISTINCT FROM 'true'`,
        "       OR false",
      ),
    );

    await assertWeakenedAuthorityFence(
      validatorSql.replace(
        `       OR jsonb_typeof(NEW."scope" #> '{exactSource,resultId}')
         IS DISTINCT FROM 'string'`,
        "       OR false",
      ),
    );
    await assertWeakenedAuthorityFence(
      validatorSql.replace(
        `       OR NOT COALESCE(
         NEW."scope" #>> '{exactSource,resultId}'
           ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
         false
       )`,
        "       OR false",
      ),
    );

    // The identity fence must also retain the terminal-state edge, not merely
    // the immutable JSON/source contract. Otherwise a direct writer can turn a
    // failed or cancelled audit back into `running` and lease its pending child.
    const resurrectionValidatorSql = validatorSql.replace(
      `       OLD."state" IN ('failed', 'cancelled')`,
      "       false -- intentionally permits terminal audit resurrection",
    );
    expect(resurrectionValidatorSql).not.toBe(validatorSql);
    try {
      await client.unsafe(resurrectionValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );
    } finally {
      await client.unsafe(validatorSql);
    }

    const broadSourceValidatorSql = validatorSql.replace(
      "FROM jsonb_object_keys(NEW.\"scope\" -> 'exactSource')",
      "FROM jsonb_object_keys('{}'::jsonb)",
    );
    expect(broadSourceValidatorSql).not.toBe(validatorSql);
    try {
      await client.unsafe(broadSourceValidatorSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );
    } finally {
      await client.unsafe(validatorSql);
    }

    // A disabled trigger is just as unsafe as a dropped one.  The preflight
    // must report that state rather than trusting the trigger name alone.
    await client.unsafe(`
      ALTER TABLE result_interpretation_backfill_runs
        DISABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
      ALTER TABLE result_interpretation_backfill_runs
        DISABLE TRIGGER ri_bf_run_audit_child_shape;
    `);
    try {
      const disabled = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(disabled.state).toBe("incompatible");
      expect(disabled.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );
    } finally {
      await client.unsafe(`
        ALTER TABLE result_interpretation_backfill_runs
          ENABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
        ALTER TABLE result_interpretation_backfill_runs
          ENABLE TRIGGER ri_bf_run_audit_child_shape;
      `);
    }

    // A named/enabled trigger is not a fence when a false WHEN clause prevents
    // every invocation. The release preflight must reject that subtle rewrite
    // before any audit run can be retargeted.
    const conditionalTriggerSql = triggerSql.replace(
      'FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_run_identity"();',
      'FOR EACH ROW WHEN (false) EXECUTE FUNCTION "validate_historical_archive_audit_run_identity"();',
    );
    expect(conditionalTriggerSql).not.toBe(triggerSql);
    try {
      await client.unsafe(conditionalTriggerSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );
    } finally {
      await client.unsafe(triggerSql);
    }

    // The validator needs OLD and NEW row values. A statement-level trigger
    // advertises the same timing and function but cannot protect one audit
    // receipt's identity.
    const statementTriggerSql = triggerSql.replace(
      'FOR EACH ROW EXECUTE FUNCTION "validate_historical_archive_audit_run_identity"();',
      'FOR EACH STATEMENT EXECUTE FUNCTION "validate_historical_archive_audit_run_identity"();',
    );
    expect(statementTriggerSql).not.toBe(triggerSql);
    try {
      await client.unsafe(statementTriggerSql);
      const weakened = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(weakened.state).toBe("incompatible");
      expect(weakened.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );
    } finally {
      await client.unsafe(triggerSql);
    }

    // A pre-fence/direct-writer mismatch must fail both the live release gate
    // and the migration's own admission guard. Restore the original scope
    // under the deliberately disabled trigger so later topology checks see a
    // healthy final schema again.
    await client.unsafe(`
      ALTER TABLE result_interpretation_backfill_runs
        DISABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
      ALTER TABLE result_interpretation_backfill_runs
        DISABLE TRIGGER ri_bf_run_audit_child_shape;
    `);
    try {
      await client.unsafe(`
        UPDATE result_interpretation_backfill_runs
        SET scope = jsonb_set(
          scope,
          '{exactSource,resultId}',
          to_jsonb('${id.invalidSourceAttempt}'::text)
        )
        WHERE id = '${id.auditRun}';
      `);
    } finally {
      await client.unsafe(`
        ALTER TABLE result_interpretation_backfill_runs
          ENABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
        ALTER TABLE result_interpretation_backfill_runs
          ENABLE TRIGGER ri_bf_run_audit_child_shape;
      `);
    }

    try {
      const mismatched = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(mismatched.state).toBe("incompatible");
      expect(mismatched.issues).toContain(
        "historical archive audit decision does not match its immutable audit run identity",
      );
      await expect(
        client.unsafe(historicalAuditRunIdentityFencePreflightSql()),
      ).rejects.toThrow(
        /0105 migration blocked: a historical archive audit decision no longer matches its immutable audit run identity/,
      );
    } finally {
      await client.unsafe(`
        ALTER TABLE result_interpretation_backfill_runs
          DISABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
        ALTER TABLE result_interpretation_backfill_runs
          DISABLE TRIGGER ri_bf_run_audit_child_shape;
      `);
      try {
        await client.unsafe(`
          UPDATE result_interpretation_backfill_runs
          SET scope = jsonb_build_object(
            'contract', 'archive-clean-cycle-historical-released-audit-v1',
            'canonicalSelection', 'forbidden',
            'physicalRecovery', 'record-only',
            'campaignMutation', 'forbidden',
            'rawEvidenceImmutable', true,
            'exactSource', jsonb_build_object(
              'resultId', '${id.result}',
              'resultAttemptId', '${id.attempt}',
              'sourceArchiveId', '${id.archive}'
            )
          )
          WHERE id = '${id.auditRun}';
        `);
      } finally {
        await client.unsafe(`
          ALTER TABLE result_interpretation_backfill_runs
            ENABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
          ALTER TABLE result_interpretation_backfill_runs
            ENABLE TRIGGER ri_bf_run_audit_child_shape;
        `);
      }
    }

    await expect(
      readResultInterpretationLedgerPreflight(drizzle(client) as unknown as DB),
    ).resolves.toMatchObject({ state: "postledger_0106", issues: [] });

    // The immutable identity includes the audit-only authority contract, not
    // merely its exact source IDs. A prior direct writer must not turn a
    // retained forensic run into something that could publish a selection.
    await client.unsafe(`
      ALTER TABLE result_interpretation_backfill_runs
        DISABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
      ALTER TABLE result_interpretation_backfill_runs
        DISABLE TRIGGER ri_bf_run_audit_child_shape;
    `);
    try {
      await client.unsafe(`
        UPDATE result_interpretation_backfill_runs
        SET scope = jsonb_set(
          scope,
          '{canonicalSelection}',
          '"allowed"'::jsonb
        )
        WHERE id = '${id.auditRun}';
      `);
    } finally {
      await client.unsafe(`
        ALTER TABLE result_interpretation_backfill_runs
          ENABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
        ALTER TABLE result_interpretation_backfill_runs
          ENABLE TRIGGER ri_bf_run_audit_child_shape;
      `);
    }
    try {
      const mismatched = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(mismatched.state).toBe("incompatible");
      expect(mismatched.issues).toContain(
        "historical archive audit decision does not match its immutable audit run identity",
      );
      await expect(
        client.unsafe(historicalAuditRunIdentityFencePreflightSql()),
      ).rejects.toThrow(
        /0105 migration blocked: a historical archive audit decision no longer matches its immutable audit run identity/,
      );
    } finally {
      await client.unsafe(`
        ALTER TABLE result_interpretation_backfill_runs
          DISABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
        ALTER TABLE result_interpretation_backfill_runs
          DISABLE TRIGGER ri_bf_run_audit_child_shape;
      `);
      try {
        await client.unsafe(`
          UPDATE result_interpretation_backfill_runs
          SET scope = jsonb_set(
            scope,
            '{canonicalSelection}',
            '"forbidden"'::jsonb
          )
          WHERE id = '${id.auditRun}';
        `);
      } finally {
        await client.unsafe(`
          ALTER TABLE result_interpretation_backfill_runs
            ENABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
          ALTER TABLE result_interpretation_backfill_runs
            ENABLE TRIGGER ri_bf_run_audit_child_shape;
        `);
      }
    }

    // JSON text extraction alone would confuse the string "true" with the
    // required boolean. Existing direct-writer history must be rejected just
    // as decisively as a new malformed audit receipt.
    await client.unsafe(`
      ALTER TABLE result_interpretation_backfill_runs
        DISABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
      ALTER TABLE result_interpretation_backfill_runs
        DISABLE TRIGGER ri_bf_run_audit_child_shape;
    `);
    try {
      await client.unsafe(`
        UPDATE result_interpretation_backfill_runs
        SET scope = jsonb_set(
          scope,
          '{rawEvidenceImmutable}',
          '"true"'::jsonb
        )
        WHERE id = '${id.auditRun}';
      `);
    } finally {
      await client.unsafe(`
        ALTER TABLE result_interpretation_backfill_runs
          ENABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
        ALTER TABLE result_interpretation_backfill_runs
          ENABLE TRIGGER ri_bf_run_audit_child_shape;
      `);
    }
    try {
      const malformed = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(malformed.state).toBe("incompatible");
      expect(malformed.issues).toContain(
        "historical archive audit decision does not match its immutable audit run identity",
      );
      await expect(
        client.unsafe(historicalAuditRunIdentityFencePreflightSql()),
      ).rejects.toThrow(
        /0105 migration blocked: a historical archive audit decision no longer matches its immutable audit run identity/,
      );
    } finally {
      await client.unsafe(`
        ALTER TABLE result_interpretation_backfill_runs
          DISABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
        ALTER TABLE result_interpretation_backfill_runs
          DISABLE TRIGGER ri_bf_run_audit_child_shape;
      `);
      try {
        await client.unsafe(`
          UPDATE result_interpretation_backfill_runs
          SET scope = jsonb_set(
            scope,
            '{rawEvidenceImmutable}',
            'true'::jsonb
          )
          WHERE id = '${id.auditRun}';
        `);
      } finally {
        await client.unsafe(`
          ALTER TABLE result_interpretation_backfill_runs
            ENABLE TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity;
          ALTER TABLE result_interpretation_backfill_runs
            ENABLE TRIGGER ri_bf_run_audit_child_shape;
        `);
      }
    }

    // A legacy/manual bypass can carry two individually valid decisions under
    // one receipt. Dropping the unique index is itself incompatible; after
    // demonstrating that fact, create the retained duplicate to prove both the
    // runtime gate and migration admission preserve it for explicit repair.
    await client.unsafe(`
      DROP INDEX historical_archive_audit_decisions_audit_run_uq;
    `);
    try {
      const missingOutcomeFence = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(missingOutcomeFence.state).toBe("incompatible");
      expect(missingOutcomeFence.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );

      // Deliberately reconstruct a pre-0106 direct-writer duplicate so the
      // 0105 historical scan is still proven against retained bad history.
      // Both 0106 decision triggers are disabled only for this forensic
      // fixture; production must never accept this write.
      await client.unsafe(`
        ALTER TABLE historical_archive_audit_decisions
          DISABLE TRIGGER historical_archive_audit_decisions_validate_insert;
        ALTER TABLE historical_archive_audit_decisions
          DISABLE TRIGGER hist_audit_decision_child_pair;
      `);
      await client.unsafe(`
        INSERT INTO historical_archive_audit_decisions
          (audit_run_id, result_id, result_attempt_id, source_archive_id,
           reducer_version_id, input_evidence_signature, reducer_state, diagnostics)
        VALUES
          ('${id.auditRun}', '${id.result}', '${id.attempt}', '${id.archive}',
           '${id.reducer}', '${NULL_POINTER_AUDIT_SHA}', 'missing_evidence', '{}'::jsonb);
      `);

      const duplicate = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(duplicate.state).toBe("incompatible");
      expect(duplicate.issues).toContain(
        "historical archive audit run has more than one immutable decision",
      );
      await expect(
        client.unsafe(historicalAuditRunIdentityFencePreflightSql()),
      ).rejects.toThrow(
        /0105 migration blocked: a historical archive audit run has more than one immutable decision/,
      );
    } finally {
      await client.unsafe(`
        ALTER TABLE historical_archive_audit_decisions
          DISABLE TRIGGER historical_archive_audit_decisions_append_only;
      `);
      try {
        await client.unsafe(`
          DELETE FROM historical_archive_audit_decisions
          WHERE audit_run_id = '${id.auditRun}'
            AND input_evidence_signature = '${NULL_POINTER_AUDIT_SHA}';
        `);
      } finally {
        await client.unsafe(`
          ALTER TABLE historical_archive_audit_decisions
            ENABLE TRIGGER historical_archive_audit_decisions_append_only;
          ALTER TABLE historical_archive_audit_decisions
            ENABLE TRIGGER historical_archive_audit_decisions_validate_insert;
          ALTER TABLE historical_archive_audit_decisions
            ENABLE TRIGGER hist_audit_decision_child_pair;
        `);
      }
      await client.unsafe(`
        CREATE UNIQUE INDEX historical_archive_audit_decisions_audit_run_uq
          ON historical_archive_audit_decisions (audit_run_id);
      `);
    }

    // Use the migration-owned trigger DDL to prove a missing fence is detected
    // and then restore the exact authoritative definition for later checks.
    await client.unsafe(`
      DROP TRIGGER result_interpretation_backfill_runs_validate_historical_audit_identity
        ON result_interpretation_backfill_runs;
    `);
    try {
      const missing = await readResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
      );
      expect(missing.state).toBe("incompatible");
      expect(missing.issues).toContain(
        "0105 historical audit run identity fence is incompatible",
      );
    } finally {
      await client.unsafe(triggerSql);
    }
    await expect(
      readResultInterpretationLedgerPreflight(drizzle(client) as unknown as DB),
    ).resolves.toMatchObject({ state: "postledger_0106", issues: [] });
  }, 120_000);

  it("backfills one compatible 0105 decision into its exact terminal child receipt", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;

    // Rewind only the new 0106 schema objects and journal marker. This is a
    // disposable post-0105 forensic database: the accepted decision and its
    // already-settled child predate the reverse receipt columns. Reapplying
    // 0106 must bind the exact child; it must not invent a second child or
    // choose by rounded/display values.
    await client.unsafe(`
      DROP TRIGGER IF EXISTS hist_audit_decision_child_pair
        ON historical_archive_audit_decisions;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_decision_pair
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_parent_shape
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_run_audit_child_shape
        ON result_interpretation_backfill_runs;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_admission
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_owner_cascade
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS result_attempt_audit_owner_cascade
        ON result_attempts;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_lifecycle
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_receipt
        ON result_interpretation_backfill_items;
      ALTER TABLE result_interpretation_backfill_items
        DROP CONSTRAINT ri_bf_item_audit_decision_fk,
        DROP CONSTRAINT ri_bf_item_audit_receipt_shape_ck;
      DROP INDEX ri_bf_item_audit_decision_uq;
      ALTER TABLE result_interpretation_backfill_items
        DROP COLUMN historical_audit_decision_id,
        DROP COLUMN historical_audit_reducer_state,
        DROP COLUMN historical_audit_input_evidence_signature;
      DROP FUNCTION validate_historical_archive_audit_item_admission();
      DROP FUNCTION close_historical_archive_audit_after_owner_cascade();
      DROP FUNCTION close_historical_archive_audit_after_attempt_owner_cascade();
      DROP FUNCTION validate_historical_archive_audit_item_lifecycle();
      DROP FUNCTION validate_historical_archive_audit_item_receipt_identity();
      DROP FUNCTION validate_historical_archive_audit_decision_child_pair();
      DROP FUNCTION validate_historical_archive_audit_run_child_shape();
      DELETE FROM drizzle.__drizzle_migrations
      WHERE created_at = ${HISTORICAL_AUDIT_CHILD_RECEIPT_FENCE_TIMESTAMP};
    `);
    await client.unsafe(historicalAuditPreChildReceiptDecisionValidatorSql());

    await expect(
      readResultInterpretationLedgerPreflight(drizzle(client) as unknown as DB),
    ).resolves.toMatchObject({ state: "postledger_0105", issues: [] });

    await migrateWithResultInterpretationLedgerPreflight(
      drizzle(client) as unknown as DB,
      migrations,
    );

    const [receipt] = await client<
      Array<{
        decisionId: string | null;
        reducerState: string | null;
        evidenceSignature: string | null;
        state: string;
        interpretationId: string | null;
      }>
    >`
      SELECT
        historical_audit_decision_id AS "decisionId",
        historical_audit_reducer_state AS "reducerState",
        historical_audit_input_evidence_signature AS "evidenceSignature",
        state,
        result_interpretation_id AS "interpretationId"
      FROM result_interpretation_backfill_items
      WHERE id = ${id.auditItem}
    `;
    expect(receipt).toEqual({
      decisionId: id.validAuditDecision,
      reducerState: "accepted",
      evidenceSignature: HISTORICAL_AUDIT_SHA,
      state: "reduced",
      interpretationId: id.historicalInterpretation,
    });
    await expect(
      readResultInterpretationLedgerPreflight(drizzle(client) as unknown as DB),
    ).resolves.toMatchObject({ state: "postledger_0106", issues: [] });
  }, 30_000);

  it("rejects a pre-0106 scientific terminal child that has no immutable decision receipt", async () => {
    if (!client) throw new Error("migration test database is unavailable");
    const id = HISTORICAL_AUDIT_FIXTURE;

    // Reconstruct the precise pre-0106 hole: a direct writer could settle an
    // otherwise exact historical-audit child in a scientific terminal state
    // without ever recording the immutable decision that proves what was
    // interpreted. The 0106 migration must refuse to attach its new receipt
    // columns to this forensic ambiguity, and must leave its journal marker
    // absent so an explicit repair can retry cleanly.
    await client.unsafe(`
      DROP TRIGGER IF EXISTS hist_audit_decision_child_pair
        ON historical_archive_audit_decisions;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_decision_pair
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_parent_shape
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_run_audit_child_shape
        ON result_interpretation_backfill_runs;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_admission
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_owner_cascade
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS result_attempt_audit_owner_cascade
        ON result_attempts;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_lifecycle
        ON result_interpretation_backfill_items;
      DROP TRIGGER IF EXISTS ri_bf_item_audit_receipt
        ON result_interpretation_backfill_items;
      ALTER TABLE result_interpretation_backfill_items
        DROP CONSTRAINT ri_bf_item_audit_decision_fk,
        DROP CONSTRAINT ri_bf_item_audit_receipt_shape_ck;
      DROP INDEX ri_bf_item_audit_decision_uq;
      ALTER TABLE result_interpretation_backfill_items
        DROP COLUMN historical_audit_decision_id,
        DROP COLUMN historical_audit_reducer_state,
        DROP COLUMN historical_audit_input_evidence_signature;
      DROP FUNCTION validate_historical_archive_audit_item_admission();
      DROP FUNCTION close_historical_archive_audit_after_owner_cascade();
      DROP FUNCTION close_historical_archive_audit_after_attempt_owner_cascade();
      DROP FUNCTION validate_historical_archive_audit_item_lifecycle();
      DROP FUNCTION validate_historical_archive_audit_item_receipt_identity();
      DROP FUNCTION validate_historical_archive_audit_decision_child_pair();
      DROP FUNCTION validate_historical_archive_audit_run_child_shape();
      DELETE FROM drizzle.__drizzle_migrations
      WHERE created_at = ${HISTORICAL_AUDIT_CHILD_RECEIPT_FENCE_TIMESTAMP};
    `);
    await client.unsafe(historicalAuditPreChildReceiptDecisionValidatorSql());

    await expect(
      readResultInterpretationLedgerPreflight(drizzle(client) as unknown as DB),
    ).resolves.toMatchObject({ state: "postledger_0105", issues: [] });

    try {
      await client.unsafe(`
        INSERT INTO result_interpretation_backfill_runs
          (id, reducer_version_id, state, scope, summary, requested_by, started_at)
        VALUES
          (
            '${id.pre0106TerminalNoDecisionAuditRun}', '${id.reducer}', 'running',
            jsonb_build_object(
              'contract', 'archive-clean-cycle-historical-released-audit-v1',
              'canonicalSelection', 'forbidden',
              'physicalRecovery', 'record-only',
              'campaignMutation', 'forbidden',
              'rawEvidenceImmutable', true,
              'exactSource', jsonb_build_object(
                'resultId', '${id.result}',
                'resultAttemptId', '${id.attempt}',
                'sourceArchiveId', '${id.archive}'
              )
            ), '{}'::jsonb, '0106-terminal-without-decision-fixture', now()
          );
        INSERT INTO result_interpretation_backfill_items
          (id, run_id, result_id, result_attempt_id, source_archive_id,
           state, attempt_count, claim_token, claim_expires_at)
        VALUES
          ('${id.pre0106TerminalNoDecisionAuditItem}',
           '${id.pre0106TerminalNoDecisionAuditRun}', '${id.result}',
           '${id.attempt}', '${id.archive}',
           'missing_evidence', 1, NULL, NULL);
      `);

      // Invoke Drizzle's migration runner directly rather than the higher
      // level compatibility wrapper: this proves the 0106 migration's own
      // pre-install scan rejects retained malformed history.
      await expect(
        migrate(drizzle(client), { migrationsFolder: migrations }),
      ).rejects.toThrow(
        /0106 migration blocked: a historical archive audit scientific terminal child lacks exactly one compatible immutable decision/,
      );

      const [journal] = await client<
        Array<{ has0106: boolean; latestMigration: string | null }>
      >`
        SELECT
          EXISTS (
            SELECT 1
            FROM drizzle.__drizzle_migrations
            WHERE created_at = ${HISTORICAL_AUDIT_CHILD_RECEIPT_FENCE_TIMESTAMP}
          ) AS "has0106",
          (
            SELECT max(created_at)::text
            FROM drizzle.__drizzle_migrations
          ) AS "latestMigration"
      `;
      expect(journal).toEqual({
        has0106: false,
        latestMigration: String(HISTORICAL_AUDIT_RUN_IDENTITY_FENCE_TIMESTAMP),
      });
      await expect(
        readResultInterpretationLedgerPreflight(drizzle(client) as unknown as DB),
      ).resolves.toMatchObject({ state: "postledger_0105", issues: [] });
    } finally {
      // Preserve neither a fabricated terminal receipt nor the migration
      // failure artifact in this shared disposable fixture; restore the exact
      // final schema before the later topology assertions run.
      await client.unsafe(`
        DELETE FROM result_interpretation_backfill_runs
        WHERE id = '${id.pre0106TerminalNoDecisionAuditRun}';
      `);
      await migrateWithResultInterpretationLedgerPreflight(
        drizzle(client) as unknown as DB,
        migrations,
      );
    }

    await expect(
      readResultInterpretationLedgerPreflight(drizzle(client) as unknown as DB),
    ).resolves.toMatchObject({ state: "postledger_0106", issues: [] });
  }, 30_000);

  it("retains the final source-scoped uniqueness topology", async () => {
    if (!client) throw new Error("migration test database is unavailable");

    const [counts] = await client<
      Array<{
        actionIndexes: number;
        triggers: number;
        terminalState: boolean;
        archivePredicate: boolean;
        historicalAuditPredicate: boolean;
        nonarchivePredicate: boolean;
        archiveSourceIdentity: boolean;
        historicalAuditSourceIdentity: boolean;
        nonarchiveSourceIdentity: boolean;
        queueHoldState: boolean;
        auditDecisionValidator: boolean;
        auditDecisionTrigger: boolean;
        canonicalSelectionFence: boolean;
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
            AND indexname = 'ri_historical_archive_attempt_reducer_source_evidence_uq'
            AND indexdef LIKE '%WHERE (source = ''historical_archive_audit''::text)%'
        ) AS "historicalAuditPredicate",
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'result_interpretations_nonarchive_attempt_reducer_evidence_uq'
            AND indexdef LIKE '%source <> ''archive_backfill''::text%'
            AND indexdef LIKE '%source <> ''historical_archive_audit''::text%'
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
              'ri_historical_archive_attempt_reducer_source_evidence_uq'
            AND index_class.relnamespace = 'public'::regnamespace
            AND index_row.indrelid = 'public.result_interpretations'::regclass
            AND index_row.indisunique
            AND index_row.indnkeyatts = 4
            AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
            AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
            AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'source_archive_id'
            AND pg_get_indexdef(index_row.indexrelid, 4, true) = 'input_evidence_signature'
            AND pg_get_expr(index_row.indpred, index_row.indrelid)
              = '(source = ''historical_archive_audit''::text)'
        ) AS "historicalAuditSourceIdentity",
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
              = '((source <> ''archive_backfill''::text) AND (source <> ''historical_archive_audit''::text))'
        ) AS "nonarchiveSourceIdentity",
        EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.result_archive_reduction_queue'::regclass
            AND conname = 'result_archive_reduction_queue_state_check'
            AND pg_get_constraintdef(oid) LIKE '%historical_audit_required%'
        ) AS "queueHoldState",
        EXISTS (
          SELECT 1
          FROM pg_proc
          WHERE oid = to_regprocedure(
            'public.validate_historical_archive_audit_decision_insert()'
          )
            AND pg_get_functiondef(oid) LIKE
              '%archive-clean-cycle-historical-released-audit-v1%'
            AND pg_get_functiondef(oid) LIKE '%canonicalSelection%'
            AND pg_get_functiondef(oid) LIKE '%physicalRecovery%'
            AND pg_get_functiondef(oid) LIKE '%campaignMutation%'
        ) AS "auditDecisionValidator",
        EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'public.historical_archive_audit_decisions'::regclass
            AND tgname = 'historical_archive_audit_decisions_validate_insert'
            AND NOT tgisinternal
            AND pg_get_triggerdef(oid) LIKE
              '%EXECUTE FUNCTION validate_historical_archive_audit_decision_insert()%'
        ) AS "auditDecisionTrigger",
        EXISTS (
          SELECT 1
          FROM pg_proc
          WHERE oid = to_regprocedure(
            'public.validate_result_canonical_selection()'
          )
            AND pg_get_functiondef(oid) LIKE
              '%interpretation_source = ''historical_archive_audit''%'
            AND pg_get_functiondef(oid) LIKE
              '%canonical selection cannot reference a historical archive audit interpretation%'
        ) AND EXISTS (
          SELECT 1
          FROM pg_proc
          WHERE oid = to_regprocedure(
            'public.validate_result_interpretation_projection()'
          )
            AND pg_get_functiondef(oid) LIKE
              '%NEW."current_result_attempt_id" IS NULL%'
            AND pg_get_functiondef(oid) LIKE
              '%selection."result_attempt_id" = NEW."current_result_attempt_id"%'
            AND pg_get_functiondef(oid) LIKE
              '%selected_interpretation_source = ''historical_archive_audit''%'
            AND pg_get_functiondef(oid) LIKE
              '%result projection cannot reference a historical archive audit interpretation%'
        ) AND EXISTS (
          SELECT 1
          FROM pg_trigger
          WHERE tgrelid = 'public.results'::regclass
            AND tgname = 'results_validate_interpretation_projection'
            AND NOT tgisinternal
            AND pg_get_triggerdef(oid) LIKE
              '%UPDATE OF current_result_attempt_id, current_result_interpretation_id, current_canonical_selection_id%'
            AND pg_get_triggerdef(oid) LIKE
              '%EXECUTE FUNCTION validate_result_interpretation_projection()%'
        ) AS "canonicalSelectionFence",
        to_regclass('public.result_interpretations_archive_attempt_reducer_source_evidence_')
          IS NULL AS "legacyArchiveSourceIdentityAbsent";
    `;

    expect(counts).toEqual({
      actionIndexes: 2,
      triggers: 4,
      terminalState: true,
      archivePredicate: true,
      historicalAuditPredicate: true,
      nonarchivePredicate: true,
      archiveSourceIdentity: true,
      historicalAuditSourceIdentity: true,
      nonarchiveSourceIdentity: true,
      queueHoldState: true,
      auditDecisionValidator: true,
      auditDecisionTrigger: true,
      canonicalSelectionFence: true,
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
      ALTER TABLE result_archive_reduction_queue
        DROP CONSTRAINT result_archive_reduction_queue_state_check;
      DROP INDEX ri_recovery_active_request_owner_uq;
      DROP INDEX legacy_urans_archive_gap_recovery_active_request_uq;
      DROP INDEX result_archive_reduction_queue_identity_uq;
      DROP INDEX historical_archive_audit_decisions_identity_uq;
      DROP INDEX historical_archive_audit_decisions_audit_run_uq;
      DROP INDEX ri_historical_archive_attempt_reducer_source_evidence_uq;
      DROP INDEX ri_bf_item_audit_decision_uq;
      DROP TRIGGER historical_archive_audit_decisions_validate_insert
        ON historical_archive_audit_decisions;
      CREATE OR REPLACE FUNCTION validate_result_canonical_selection()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        RETURN NEW;
      END;
      $$;
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
        "0102 historical audit interpretation source provenance check is incompatible",
        "recovery action request-owner fence is incompatible",
        "legacy archive-gap active request fence is incompatible",
        "archive-reduction queue identity fence is incompatible",
        "0101 historical audit idempotence identity is incompatible",
        "0102 historical audit interpretation identity is incompatible",
        "0102 historical audit queue hold state is missing",
        "0102 historical audit decision provenance trigger is missing",
        "0103 historical audit decision source/state fence is incompatible",
        "0104 canonical selection and projection fence is incompatible",
        "0105 historical audit run identity fence is incompatible",
        "0106 historical audit child decision uniqueness fence is incompatible",
      ]),
    );
  });
});
