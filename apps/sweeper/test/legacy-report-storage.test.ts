import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@aerodb/db/client";
import {
  legacyInventorySql,
  legacyNormalizeSql,
  type LegacyReportScope,
} from "@aerodb/db/legacy-report-storage";
import {
  LegacyHubGcsStore,
  legacySha256,
  LegacyStorageOperationError,
  legacySshOperationError,
  legacyLocalStorageError,
  type LegacyBackupObject,
  type LegacyBackupStore,
} from "../src/legacy-report-storage-gcs";
import {
  decodeLegacyPage,
  encodeLegacyPage,
  inspectLegacyPage,
  exportLegacyReports,
  LegacySshReader,
  readLegacyPage,
  type LegacySqlReader,
  type LegacyBackupReceipt,
} from "../src/legacy-report-storage";
import { legacyReportStorageCli } from "../src/legacy-report-storage-cli";
import {
  legacyCustodyWorkerFailure,
  parseLegacyCustodyWorkerFailure,
} from "../src/legacy-report-storage-custody-worker";
import { LegacyHubSshStore } from "../src/legacy-report-storage-hub";
import { runLegacyUntilComplete } from "../src/legacy-report-storage-loop";
import {
  LegacyOperatorPaused,
  legacyOperatorWriteCommand,
  legacyOperatorWriteFailure,
} from "../src/legacy-report-storage-operator";
import {
  applyVerifiedLegacyPage,
  migrateLegacyReceipts,
  legacyNormalizationTelemetry,
  type LegacyPageNormalizer,
  LegacySshNormalizer,
} from "../src/legacy-report-storage-migration";
import { readLegacyPageMember } from "@aerodb/db/legacy-report-storage-codec";

// Dedicated operator integration: existing report tests exercise dispatched work,
// not an SSH copy with NO dispatch, full conflict backup and local-only restore.
// No production DB, SSH, metadata service, GCS account or solver is contacted.
class MemoryBackup implements LegacyBackupStore {
  objects = new Map<string, Buffer>();
  corrupt = false;
  failAfterPut = false;
  async put(objectKey: string, bytes: Buffer): Promise<LegacyBackupObject> {
    const existing = this.objects.get(objectKey);
    if (existing && !existing.equals(bytes))
      throw new Error("immutable conflict");
    this.objects.set(objectKey, Buffer.from(bytes));
    if (this.failAfterPut)
      throw new Error("interrupted after immutable upload");
    return {
      bucket: "backup-test",
      objectKey,
      generation: "90071992547409931",
      sha256: legacySha256(bytes),
      byteSize: bytes.length,
      crc32c: "AAAAAA==",
      verifiedAt: "2026-11-19T00:00:00Z",
    };
  }
  async read(object: LegacyBackupObject) {
    return this.corrupt
      ? Buffer.from("corrupt")
      : Buffer.from(this.objects.get(object.objectKey)!);
  }
}

let client: ReturnType<typeof createClient>;
const paths: string[] = [];
beforeAll(async () => {
  if (
    process.env.LEGACY_REPORT_STORAGE_DISPOSABLE_DB !== "1" ||
    !process.env.DATABASE_URL
  )
    throw new Error(
      "Use a governed check with LEGACY_REPORT_STORAGE_DISPOSABLE_DB=1 and a dedicated empty PostgreSQL",
    );
  client = createClient({ max: 1 });
  const [existing] =
    await client.sql`SELECT to_regclass('public.progressive_worker_reports') AS present`;
  if (existing.present)
    throw new Error(
      "Legacy fixture refuses a database with existing report tables",
    );
  await client.sql
    .unsafe(
      `
    CREATE FUNCTION reject_progressive_artifact_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;
    CREATE FUNCTION protect_progressive_worker_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TABLE progressive_worker_reports(sim_job_id uuid NOT NULL, sequence bigint NOT NULL, content_signature text NOT NULL,
      report jsonb NOT NULL, created_at timestamptz DEFAULT clock_timestamp(), acknowledged_at timestamptz,
      archived_at timestamptz, archive_bundle_id uuid, PRIMARY KEY(sim_job_id,sequence));
    CREATE TRIGGER progressive_worker_report_immutable BEFORE UPDATE ON progressive_worker_reports
      FOR EACH ROW EXECUTE FUNCTION protect_progressive_worker_report();
    CREATE TABLE progressive_remote_reports(sim_job_id uuid NOT NULL, sequence bigint NOT NULL, content_signature text NOT NULL,
      report jsonb NOT NULL, received_at timestamptz DEFAULT clock_timestamp(), PRIMARY KEY(sim_job_id,sequence));
    CREATE TRIGGER progressive_remote_reports_immutable BEFORE UPDATE ON progressive_remote_reports
      FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
    CREATE TABLE progressive_worker_report_conflicts(sim_job_id uuid NOT NULL, sequence bigint NOT NULL,
      content_signature text NOT NULL, report jsonb NOT NULL, reason text, created_at timestamptz DEFAULT clock_timestamp(),
      archived_at timestamptz,archive_bundle_id uuid,PRIMARY KEY(sim_job_id,sequence));
    CREATE TABLE progressive_remote_dispatches(sim_job_id uuid PRIMARY KEY,solver_id uuid);
  `,
    )
    .simple();
  // Real versioned 0198 functions, checks and immutable representation guards.
  await client.sql
    .unsafe(
      await readFile(
        fileURLToPath(
          new URL(
            "../../../packages/db/migrations/0198_progressive_report_result_payloads.sql",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    )
    .simple();
  const aliasMigration = await readFile(
    fileURLToPath(
      new URL(
        "../../../packages/db/migrations/0203_redundant_report_conflicts.sql",
        import.meta.url,
      ),
    ),
    "utf8",
  );
  await client.sql.unsafe(
    "ALTER TABLE public.progressive_worker_report_conflicts ADD COLUMN body_source_sequence bigint",
  );
  // Use the real source-resolution view. Its alias mutation guards are covered
  // by the existing 0203 suite; this operator never changes an alias.
  const view = aliasMigration.match(
    /CREATE (?:OR REPLACE )?VIEW (?:public\.)?progressive_worker_conflict_storage\b[^;]*;/i,
  )?.[0];
  if (!view)
    throw new Error(
      "Migration 0203 must define the worker conflict source view",
    );
  await client.sql.unsafe(view).simple();
}, 30000);
afterAll(async () => {
  await client?.sql.end();
  for (const path of paths) await rm(path, { recursive: true, force: true });
});

const source: LegacySqlReader = {
  async query(query, maxBytes) {
    try {
      const result = await client.sql.unsafe(query).simple();
      const statements = Array.from(result) as unknown[];
      const rows = statements.flatMap((item) =>
        Array.isArray(item) ? item : [item],
      );
      const texts = rows
        .map((row) => Object.values(row as Record<string, unknown>)[0])
        .filter((v): v is string => typeof v === "string");
      if (Buffer.byteLength(texts.join("\n")) > maxBytes)
        throw new Error("bounded source output");
      return texts.map((value) => JSON.parse(value));
    } catch (error) {
      await client.sql.unsafe("ROLLBACK");
      throw error;
    }
  },
};
async function fixture(conflicts = true): Promise<LegacyReportScope> {
  await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=false`;
  const executionId = randomUUID();
  const solverId = randomUUID();
  const common = `"version":1,"executionId":"${executionId}","solverId":"${solverId}","status":{"state":"failed","unknown":"retained"}`;
  // Sparse sequences, absent versus null, huge integer, scale and unknown fields.
  for (const sequence of [1, 3, 8, 9, 10]) {
    const result =
      sequence === 9
        ? ',"result":null'
        : sequence === 10
          ? ""
          : ',"result":{"state":"failed","large":900719925474099312345678901234567890,"precise":0.100000000000000000001,"unknown":"' +
            "retained".repeat(20000) +
            '"}';
    await client.sql`INSERT INTO public.progressive_worker_reports(sim_job_id,sequence,content_signature,report)
      VALUES (${executionId},${sequence},${String(sequence).padStart(64, "a")},${`{${common},"sequence":${sequence}${result}}`}::jsonb)`;
  }
  if (conflicts)
    await client.sql`INSERT INTO public.progressive_worker_report_conflicts(sim_job_id,sequence,content_signature,report,reason)
    VALUES (${executionId},3,${"f".repeat(64)},${`{${common},"sequence":3,"result":{"untrusted":true,"number":999999999999999999999.0001}}`}::jsonb,'original conflict')`;
  return {
    version: 1,
    sourceInstance: "hz-fixture",
    solverId,
    measuredAt: "2026-11-19T00:00:00Z",
    executions: [
      {
        executionId,
        reports: 5,
        reportHighWater: 10,
        conflicts: conflicts ? 1 : 0,
        conflictHighWater: conflicts ? 3 : 0,
      },
    ],
  };
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "legacy-reports-"));
  paths.push(path);
  return path;
}
async function execute(query: string) {
  try {
    return await client.sql.unsafe(query).simple();
  } catch (error) {
    await client.sql.unsafe("ROLLBACK");
    throw error;
  }
}
async function logical(executionId: string) {
  return client.sql`SELECT sequence,content_signature,to_jsonb(r.*)-'report'-'result_payload_hash' AS metadata,
    public.resolve_progressive_report(to_jsonb(r.*))::text AS text FROM public.progressive_worker_reports r
    WHERE sim_job_id=${executionId} ORDER BY sequence`;
}

describe.sequential("worker-only legacy backup and 0198 representation", () => {
  it("persists custody proof for a real 64.64.generation receipt without exceeding NAME_MAX", async () => {
    const scope = await fixture(false),
      path = await directory();
    const page = await readLegacyPage(source, scope),
      packed = encodeLegacyPage(page);
    const hash = legacySha256(packed.bytes);
    const receipt: LegacyBackupReceipt = {
      version: 1,
      scopeSha256: page.scopeSha256,
      sourceInstance: page.sourceInstance,
      solverId: page.solverId,
      start: page.start,
      next: page.next,
      memberCount: page.members.length,
      rawByteSize: packed.rawByteSize,
      object: {
        bucket: "legacy-name-limit",
        objectKey: `legacy-worker-reports/v1/${scope.sourceInstance}/${scope.solverId}/${page.scopeSha256}/${hash}.jsonl.gz`,
        generation: "18446744073709551615",
        sha256: hash,
        byteSize: packed.bytes.length,
        crc32c: "AAAAAA==",
        verifiedAt: new Date().toISOString(),
      },
    };
    const bytes = Buffer.from(JSON.stringify(receipt) + "\n"),
      name = `${legacySha256(bytes)}.${hash}.${receipt.object.generation}.receipt.json`;
    await writeFile(join(path, name), bytes, { mode: 0o600 });
    const normalizer: LegacyPageNormalizer = {
      binding: "filename-fixture",
      receiptPhase: "custody",
      phaseBinding: "p".repeat(64),
      apply: async () => ({
        verifiedReports: 5,
        normalizedReports: 0,
        rowProofs: [],
        newlyNormalizedReports: 0,
        transactionCommitted: true,
        sourceDatabaseWrites: false,
        archiveMembersReleased: 0,
        remainingWarmReports: 0,
        coldReleaseComplete: true,
        retentionStrategy: "gcs-and-worker-working-volume",
      }),
    };
    await applyVerifiedLegacyPage({
      page,
      receipt,
      receiptFile: name,
      directory: path,
      normalizer,
    });
    for (const file of await readdir(path)) {
      expect(Buffer.byteLength(file)).toBeLessThanOrEqual(255);
      expect(file).not.toContain(".tmp-");
    }
    expect(
      (
        await migrateLegacyReceipts({
          scope,
          directory: path,
          store: new MemoryBackup(),
          normalizer,
          apply: true,
        })
      ).complete,
    ).toBe(true);
  });

  it("continues beyond six hours by default and only obeys explicit overall ceilings", async () => {
    let clock = 0,
      calls = 0;
    const result = await runLegacyUntilComplete(
      async () => {
        clock += 4 * 3600 * 1000;
        calls++;
        return { complete: calls === 3, next: { execution: calls } };
      },
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    );
    expect(result).toMatchObject({
      complete: true,
      passesCompleted: 3,
      stopReason: "scope_complete",
    });
    expect(result.elapsedSeconds).toBeGreaterThan(6 * 3600);
    calls = 0;
    const bounded = await runLegacyUntilComplete(
      async () => ({ complete: false, next: ++calls }),
      { maxPasses: 2, now: () => 0, sleep: async () => undefined },
    );
    expect(bounded).toMatchObject({
      complete: false,
      passesCompleted: 2,
      stopReason: "pass_budget_exhausted",
    });
    await expect(
      runLegacyUntilComplete(async () => ({ complete: false, next: 1 }), {
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(/no progress/);
  });

  it("retries only typed transport/deploy pauses and keeps retry diagnostics private", async () => {
    const events: Record<string, unknown>[] = [],
      waits: number[] = [];
    let attempt = 0;
    const result = await runLegacyUntilComplete(
      async () => {
        attempt++;
        if (attempt === 1) throw new LegacyOperatorPaused();
        if (attempt === 2)
          throw legacySshOperationError(
            "hub_put",
            { code: 255 },
            "Connection reset by peer",
            true,
          );
        if (attempt === 3)
          throw new LegacyStorageOperationError({
            operation: "gcs_upload",
            category: "gcs_server_error",
            httpStatus: 503,
          });
        return { complete: true, next: 1 };
      },
      {
        sleep: async (ms) => {
          waits.push(ms);
        },
        emit: (event) => events.push(event),
      },
    );
    expect(result).toMatchObject({
      complete: true,
      deployPauses: 1,
      transientRetries: 2,
    });
    expect(waits).toEqual([5000, 1000, 2000]);
    for (const stderr of [
      "Permission denied (publickey)",
      "Host key verification failed",
      "No such container: wrong-input",
    ]) {
      const error = legacySshOperationError(
        "hub_read",
        { code: 255 },
        stderr,
        false,
      );
      expect(error.retryable).toBe(false);
      let calls = 0;
      await expect(
        runLegacyUntilComplete(
          async () => {
            calls++;
            throw error;
          },
          { sleep: async () => undefined },
        ),
      ).rejects.toBe(error);
      expect(calls).toBe(1);
    }
    const sensitive = "owner@example.invalid Bearer secret-token /private/path";
    for (const [code, category] of [
      ["ENAMETOOLONG", "local_name_too_long"],
      ["ENOSPC", "local_space_exhausted"],
    ] as const) {
      const failure = legacyLocalStorageError(
        "save_proof",
        Object.assign(new Error(sensitive), { code, path: sensitive }),
      )!;
      expect(failure).toMatchObject({
        retryable: false,
        details: { operation: "save_proof", category, localCode: code },
      });
      expect(
        JSON.stringify({ message: failure.message, ...failure.details }),
      ).not.toMatch(/example|secret|private\/path/);
    }
    expect(JSON.stringify(events)).not.toMatch(/Bearer|@|private\/path/);
  });

  it("retries the identical saved receipt after transient worker SQL failures and backs off without rereading source bodies", async () => {
    const scope = await fixture(false),
      path = await directory(),
      store = new MemoryBackup();
    await client.sql`UPDATE progressive_report_storage_policy SET normalization_enabled=true`;
    const waits: number[] = [],
      events: Record<string, unknown>[] = [];
    const query = vi.spyOn(source, "query");
    let calls = 0,
      originalPacked: Buffer | undefined,
      originalReceipt: string | undefined,
      readsAtFailure = 0;
    const before = await logical(scope.executions[0].executionId);
    const applyVerifiedPage = async (
      page: import("../src/legacy-report-storage").LegacyBackupPage,
      receipt: LegacyBackupReceipt,
      receiptFile: string,
      packed: Buffer,
    ) => {
      calls++;
      if (!originalPacked) {
        originalPacked = Buffer.from(packed);
        originalReceipt = receiptFile;
        readsAtFailure = query.mock.calls.length;
      }
      expect(packed.equals(originalPacked)).toBe(true);
      expect(receiptFile).toBe(originalReceipt);
      expect(query.mock.calls).toHaveLength(readsAtFailure);
      if (calls <= 3) {
        const code = ["55P03", "40P01", "40001"][calls - 1];
        const failure = legacyCustodyWorkerFailure({
          code,
          workerPhase: "job_lock",
          message: "sensitive SQL body /private/path",
        });
        throw legacyOperatorWriteFailure(
          { code: 1 },
          "LEGACY_CUSTODY_FAILURE " + JSON.stringify(failure) + "\n",
          "worker_custody",
          true,
        );
      }
      await execute(
        legacyNormalizeSql(page.members, { apply: true, readersReady: true }),
      );
      return {
        sourceReportRowsVerified: page.members.length,
        sourceReportBodiesRetained: page.members.length,
        rowsNewlyNormalized: 3,
        archiveMembersReleased: 0,
        migrationTransactionsCommitted: 1,
        sourceDatabaseWrites: true,
      };
    };
    try {
      const result = await runLegacyUntilComplete(
        () =>
          exportLegacyReports({
            scope,
            source,
            store,
            directory: path,
            sourceBinding: "worker-lock-recovery",
            rows: 16,
            pages: 1,
            applyVerifiedPage,
          }),
        {
          maxPasses: 4,
          random: () => 0.5,
          emit: (event) => events.push(event),
          sleep: async (ms) => {
            waits.push(ms);
            expect(
              (await readFile(join(path, "pending.jsonl.gz"))).equals(
                originalPacked!,
              ),
            ).toBe(true);
            const checkpoint = JSON.parse(
              await readFile(join(path, "checkpoint.json"), "utf8"),
            );
            expect(checkpoint.next).toMatchObject({
              execution: 0,
              kind: "report",
              after: 0,
              copied: 0,
            });
            expect(store.objects.size).toBe(1);
          },
        },
      );
      expect(result).toMatchObject({
        complete: true,
        passesAttempted: 4,
        passesCompleted: 1,
        transientRetries: 3,
      });
      expect(waits).toEqual([1250, 2500, 5000]);
      expect(
        events
          .filter((event) => event.event === "retry")
          .map((event) => ({
            sqlState: event.sqlState,
            phase: event.workerPhase,
          })),
      ).toEqual(
        ["55P03", "40P01", "40001"].map((sqlState) => ({
          sqlState,
          phase: "job_lock",
        })),
      );
      expect(await logical(scope.executions[0].executionId)).toEqual(before);
      expect(store.objects.size).toBe(1);
      await expect(
        readFile(join(path, "pending.jsonl.gz")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.stringify(events)).not.toMatch(/sensitive|private\/path/);
    } finally {
      query.mockRestore();
    }
  });

  it.each(["57P01", "57P02", "57P03", "08006", "CONNECTION_CLOSED"])(
    "retries a diagnosed worker database interruption %s",
    async (code) => {
      const failure = legacyCustodyWorkerFailure({
        code,
        workerPhase: "normalization",
      });
      const error = legacyOperatorWriteFailure(
        { code: 1 },
        "LEGACY_CUSTODY_FAILURE " + JSON.stringify(failure),
        "worker_custody",
        true,
      );
      expect(error).toMatchObject({
        retryable: true,
        details: {
          category: "database_unavailable",
          workerPhase: "normalization",
        },
      });
      let calls = 0;
      const result = await runLegacyUntilComplete(
        async () => {
          if (++calls === 1) throw error;
          return { complete: true, next: 1 };
        },
        { maxPasses: 2, random: () => 0, sleep: async () => undefined },
      );
      expect(result).toMatchObject({ complete: true, transientRetries: 1 });
    },
  );

  it.each(["P0001", "23514", "42501", "57014", "XX000"])(
    "does not retry hard worker SQLSTATE %s or expose SQL text",
    async (code) => {
      const sensitive =
        "SELECT secret_payload FROM /private/path owner@example.invalid";
      const failure = legacyCustodyWorkerFailure({
        code,
        workerPhase: "custody_registration",
        message: sensitive,
        detail: sensitive,
        query: sensitive,
      });
      const error = legacyOperatorWriteFailure(
        { code: 1 },
        "LEGACY_CUSTODY_FAILURE " + JSON.stringify(failure),
        "worker_custody",
        true,
      );
      expect(error).toMatchObject({
        retryable: false,
        details: { sqlState: code, workerPhase: "custody_registration" },
      });
      let calls = 0;
      await expect(
        runLegacyUntilComplete(
          async () => {
            calls++;
            throw error;
          },
          { sleep: async () => undefined },
        ),
      ).rejects.toBe(error);
      expect(calls).toBe(1);
      expect(JSON.stringify({ failure, error })).not.toMatch(
        /secret_payload|private\/path|example/,
      );
    },
  );

  it("fails malformed, contradictory or duplicate worker diagnostics closed", () => {
    const valid = legacyCustodyWorkerFailure({
      code: "55P03",
      workerPhase: "job_lock",
    });
    const line = "LEGACY_CUSTODY_FAILURE " + JSON.stringify(valid);
    for (const stderr of [
      line + "\n" + line,
      "LEGACY_CUSTODY_FAILURE {bad}",
      "LEGACY_CUSTODY_FAILURE " +
        JSON.stringify({ ...valid, category: "integrity" }),
      "LEGACY_CUSTODY_FAILURE " +
        JSON.stringify({ ...valid, sqlState: "payload secret" }),
    ]) {
      expect(parseLegacyCustodyWorkerFailure(stderr)).toBeNull();
      expect(
        legacyOperatorWriteFailure({ code: 1 }, stderr, "worker_custody", true),
      ).toMatchObject({ retryable: false });
    }
  });

  it("caps repeated database backoff within the existing invocation budget", async () => {
    const failure = legacyCustodyWorkerFailure({
      code: "55P03",
      workerPhase: "job_lock",
    });
    const error = legacyOperatorWriteFailure(
      { code: 1 },
      "LEGACY_CUSTODY_FAILURE " + JSON.stringify(failure),
      "worker_custody",
      true,
    );
    const waits: number[] = [];
    const result = await runLegacyUntilComplete(
      async () => {
        throw error;
      },
      {
        maxPasses: 9,
        random: () => 0.5,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(result).toMatchObject({
      complete: false,
      stopReason: "pass_budget_exhausted",
      transientRetries: 9,
      passesCompleted: 0,
    });
    expect(waits).toEqual([
      1250, 2500, 5000, 10000, 20000, 40000, 60000, 60000,
    ]);
  });

  it("pauses writes for deployment without advancing the page and preserves the pre-lock binding", async () => {
    const scope = await fixture(false),
      path = await directory(),
      store = new MemoryBackup();
    const before = await logical(scope.executions[0].executionId);
    const input = {
      scope,
      directory: path,
      store,
      source,
      sourceBinding: "migrate-with-lock",
      rows: 16,
      pages: 1,
    };
    expect(
      new LegacySshNormalizer("existing-worker", "existing-postgres", true)
        .binding,
    ).toBe(
      legacySha256(
        JSON.stringify({
          host: "existing-worker",
          command:
            "docker exec -i existing-postgres psql -X -w -qAt -v ON_ERROR_STOP=1 -U aerodb -d aerodb",
          operation: "0198-normalize",
        }),
      ),
    );
    expect(
      legacyOperatorWriteCommand("docker exec -i existing-postgres psql"),
    ).toMatch(
      /^flock -s -w 15 -E 75 \/tmp\/airfoils-pro-deploy\.lock docker exec/,
    );
    const paused = legacyOperatorWriteFailure({ code: 75 });
    expect(paused).toBeInstanceOf(LegacyOperatorPaused);
    await expect(
      exportLegacyReports({
        ...input,
        applyVerifiedPage: async () => {
          throw paused;
        },
      }),
    ).rejects.toBe(paused);
    expect(
      JSON.parse(await readFile(join(path, "checkpoint.json"), "utf8")).next
        .after,
    ).toBe(0);
    expect(await logical(scope.executions[0].executionId)).toEqual(before);
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".gz")),
    ).toEqual(["pending.jsonl.gz"]);
    await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=true`;
    const resumed = await exportLegacyReports({
      ...input,
      source: {
        query: async () => {
          throw new Error("must use pending page");
        },
      },
      applyVerifiedPage: async (page) => {
        await execute(
          legacyNormalizeSql(page.members, { apply: true, readersReady: true }),
        );
        return {
          sourceDatabaseWrites: true,
          sourceReportRowsVerified: 5,
          sourceReportBodiesRetained: 5,
          rowsNewlyNormalized: 3,
          archiveMembersReleased: 0,
          migrationTransactionsCommitted: 1,
        };
      },
    });
    expect(resumed).toMatchObject({
      complete: true,
      sourceDatabaseWrites: true,
      rowsNewlyNormalized: 3,
      archiveMembersReleased: 0,
    });
    expect(await logical(scope.executions[0].executionId)).toEqual(before);
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".gz")),
    ).toEqual([]);
  });

  it("reports copy, newly normalized rows, retained bodies, idempotent replay and unknown hooks distinctly", async () => {
    const scope = await fixture(false),
      store = new MemoryBackup();
    const base = {
      scope,
      store,
      source,
      sourceBinding: "telemetry",
      rows: 16,
      pages: 1,
    };
    const copied = await exportLegacyReports({
      ...base,
      directory: await directory(),
    });
    expect(copied).toMatchObject({
      reportRowsVerified: 5,
      archiveMembersVerified: 5,
      sourceDatabaseWrites: false,
      rowsNewlyNormalized: 0,
      archiveMembersReleased: 0,
      migrationTransactionsCommitted: 0,
    });
    await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=true`;
    const applyVerifiedPage = async (
      page: import("../src/legacy-report-storage").LegacyBackupPage,
    ) => {
      await client.sql.unsafe(
        "DROP TABLE IF EXISTS pg_temp.legacy_report_storage_changes",
      );
      await execute(
        legacyNormalizeSql(page.members, {
          apply: true,
          readersReady: true,
          trackChanges: true,
        }),
      );
      const [changes] =
        await client.sql`SELECT coalesce(sum(newly_normalized),0)::int AS n FROM pg_temp.legacy_report_storage_changes`;
      return legacyNormalizationTelemetry(
        {
          verifiedReports: page.members.length,
          normalizedReports: 3,
          rowProofs: [],
          newlyNormalizedReports: changes.n,
          transactionCommitted: true,
        },
        page.members.length,
      );
    };
    const migrated = await exportLegacyReports({
      ...base,
      directory: await directory(),
      applyVerifiedPage,
    });
    expect(migrated).toMatchObject({
      reportRowsVerified: 5,
      sourceReportRowsVerified: 5,
      sourceReportBodiesRetained: 5,
      sourceDatabaseWrites: true,
      rowsNewlyNormalized: 3,
      archiveMembersReleased: 0,
      migrationTransactionsCommitted: 1,
    });
    const replay = await exportLegacyReports({
      ...base,
      directory: await directory(),
      applyVerifiedPage,
    });
    expect(replay).toMatchObject({
      reportRowsVerified: 5,
      sourceReportRowsVerified: 5,
      sourceReportBodiesRetained: 5,
      sourceDatabaseWrites: false,
      rowsNewlyNormalized: 0,
      archiveMembersReleased: 0,
      migrationTransactionsCommitted: 1,
    });
    const unknown = await exportLegacyReports({
      ...base,
      directory: await directory(),
      applyVerifiedPage: async () => undefined,
    });
    expect(unknown).toMatchObject({
      reportRowsVerified: 5,
      sourceDatabaseWrites: null,
      rowsNewlyNormalized: null,
      archiveMembersReleased: null,
    });
  });

  it("adopts copy-only receipts before its saved cursor, normalizes new pages, and retries a lost post-commit acknowledgement", async () => {
    const scope = await fixture(false),
      path = await directory(),
      store = new MemoryBackup();
    const before = await logical(scope.executions[0].executionId);
    const copy = {
      scope,
      directory: path,
      store,
      source,
      sourceBinding: "copy-mode",
      rows: 2,
      pages: 1,
    };
    await exportLegacyReports(copy);
    const copiedState = await readFile(join(path, "checkpoint.json"), "utf8");
    await expect(
      exportLegacyReports({ ...copy, sourceBinding: "migrate-mode" }),
    ).rejects.toThrow(/binding/);
    expect(await readFile(join(path, "checkpoint.json"), "utf8")).toBe(
      copiedState,
    );
    await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=true`;
    const normalizer: LegacyPageNormalizer = {
      binding: "isolated-pg",
      async apply(page) {
        if (page.members.length)
          await execute(
            legacyNormalizeSql(page.members, {
              apply: true,
              readersReady: true,
            }),
          );
        const [row] =
          await client.sql`SELECT count(result_payload_hash)::int AS n FROM public.progressive_worker_reports WHERE sim_job_id=${scope.executions[0].executionId}`;
        return {
          verifiedReports: page.members.filter((m) => m.kind === "report")
            .length,
          normalizedReports: row.n,
          rowProofs: [],
        };
      },
    };
    let lost = true;
    const migrate = {
      ...copy,
      sourceBinding: "migrate-mode",
      adoptCopy: {
        sourceBinding: "copy-mode",
        applyReceipts: async (
          through: import("../src/legacy-report-storage").LegacyCursor,
        ) => {
          const result = await migrateLegacyReceipts({
            scope,
            directory: path,
            store,
            normalizer,
            apply: true,
            through,
          });
          expect(result.complete).toBe(true);
        },
      },
      applyVerifiedPage: async (
        page: import("../src/legacy-report-storage").LegacyBackupPage,
        receipt: LegacyBackupReceipt,
        receiptFile: string,
      ) => {
        await applyVerifiedLegacyPage({
          page,
          receipt,
          receiptFile,
          directory: path,
          normalizer,
        });
        if (lost) {
          lost = false;
          throw new Error("lost acknowledgement after commit");
        }
      },
    };
    await expect(exportLegacyReports(migrate)).rejects.toThrow(
      /lost acknowledgement/,
    );
    expect(
      JSON.parse(await readFile(join(path, "checkpoint.json"), "utf8")).next
        .after,
    ).toBe(3);
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".gz")),
    ).toEqual(["pending.jsonl.gz"]);
    expect(
      (
        await client.sql`SELECT count(result_payload_hash)::int AS n FROM public.progressive_worker_reports WHERE sim_job_id=${scope.executions[0].executionId}`
      )[0].n,
    ).toBe(3);
    for (let page = 0; page < 8; page++)
      if ((await exportLegacyReports(migrate)).complete) break;
    expect(await logical(scope.executions[0].executionId)).toEqual(before);
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".gz")),
    ).toEqual([]);
    expect(
      (
        await migrateLegacyReceipts({
          scope,
          directory: path,
          store,
          normalizer,
          apply: true,
        })
      ).remaining,
    ).toBe(0);
  });

  it("refuses adoption with a missing prefix receipt and authenticates exactly one member for custody readers", async () => {
    const scope = await fixture(false),
      path = await directory(),
      store = new MemoryBackup();
    const copy = {
      scope,
      directory: path,
      store,
      source,
      sourceBinding: "copy",
      rows: 2,
      pages: 1,
    };
    const result = await exportLegacyReports(copy);
    const name = result.receipts[0];
    const receipt = JSON.parse(
      await readFile(join(path, name), "utf8"),
    ) as LegacyBackupReceipt;
    const bytes = await store.read(receipt.object),
      page = decodeLegacyPage(bytes, receipt),
      first = page.members[0];
    const identity = {
      storedSha256: receipt.object.sha256,
      storedByteSize: bytes.length,
      scopeSha256: receipt.scopeSha256,
      sourceInstance: scope.sourceInstance,
      solverId: scope.solverId,
      executionId: first.executionId,
      sequence: first.sequence,
      kind: first.kind,
      contentSignature: first.contentSignature,
      reportSha256: first.reportSha256,
      reportByteSize: first.reportByteSize,
    };
    expect(readLegacyPageMember(bytes, identity)).toEqual(first);
    expect(() =>
      readLegacyPageMember(bytes, { ...identity, solverId: randomUUID() }),
    ).toThrow(/identity/);
    expect(() =>
      readLegacyPageMember(bytes, { ...identity, sequence: 2 }),
    ).toThrow(/missing/);
    const state = await readFile(join(path, "checkpoint.json"), "utf8");
    await rm(join(path, name));
    const normalizer: LegacyPageNormalizer = {
      binding: "pg",
      apply: async () => {
        throw new Error("must not normalize without coverage");
      },
    };
    await expect(
      exportLegacyReports({
        ...copy,
        sourceBinding: "migrate",
        adoptCopy: {
          sourceBinding: "copy",
          applyReceipts: async (through) => {
            await migrateLegacyReceipts({
              scope,
              directory: path,
              store,
              normalizer,
              apply: true,
              through,
            });
          },
        },
      }),
    ).rejects.toThrow(/cover/);
    expect(await readFile(join(path, "checkpoint.json"), "utf8")).toBe(state);
  });

  it("exports conflict alias source bytes before and after worker normalization and refuses missing/cold sources", async () => {
    const scope = await fixture(false);
    const executionId = scope.executions[0].executionId;
    const [worker] =
      await client.sql`SELECT report::text AS body,content_signature FROM public.progressive_worker_reports WHERE sim_job_id=${executionId} AND sequence=3`;
    await client.sql`INSERT INTO public.progressive_worker_report_conflicts(sim_job_id,sequence,content_signature,report,reason,body_source_sequence)
      SELECT sim_job_id,sequence,content_signature,jsonb_set(report,'{result}',public.progressive_report_result_header(report->'result'),false),'aliased original',sequence
      FROM public.progressive_worker_reports WHERE sim_job_id=${executionId} AND sequence=3`;
    scope.executions[0].conflicts = 1;
    scope.executions[0].conflictHighWater = 3;
    const page = await readLegacyPage(source, scope);
    const conflict = page.members.find((m) => m.kind === "conflict")!;
    expect(conflict.reportText).toBe(worker.body);
    expect(conflict.rowText).toContain('"body_source_sequence": 3');
    expect(conflict.rowText).not.toContain("retainedretained");
    await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=true`;
    await execute(
      legacyNormalizeSql(page.members, { apply: true, readersReady: true }),
    );
    expect(
      (await readLegacyPage(source, scope)).members.find(
        (m) => m.kind === "conflict",
      )!.reportText,
    ).toBe(worker.body);
    await client.sql`UPDATE public.progressive_worker_report_conflicts SET body_source_sequence=2 WHERE sim_job_id=${executionId}`;
    await expect(readLegacyPage(source, scope)).rejects.toThrow(
      /missing source/,
    );
    await client.sql`UPDATE public.progressive_worker_report_conflicts SET body_source_sequence=3 WHERE sim_job_id=${executionId}`;
    await client.sql`UPDATE public.progressive_worker_reports SET archive_bundle_id=${randomUUID()} WHERE sim_job_id=${executionId} AND sequence=3`;
    await expect(readLegacyPage(source, scope)).rejects.toThrow(
      /cold or missing/,
    );
  });

  it("copies every sparse report/conflict, resumes after failure and preserves exact queries without a dispatch or cloud reader", async () => {
    const scope = await fixture();
    const path = await directory();
    const store = new MemoryBackup();
    const input = {
      source,
      store,
      scope,
      directory: path,
      sourceBinding: "existing-ssh-fixture",
      rows: 2,
      maxBytes: 2_000_000,
      pages: 1,
    };
    const before = await logical(scope.executions[0].executionId);
    store.failAfterPut = true;
    await expect(exportLegacyReports(input)).rejects.toThrow(/interrupted/);
    expect(
      JSON.parse(await readFile(join(path, "checkpoint.json"), "utf8")).next
        .after,
    ).toBe(0);
    const pending = await readFile(join(path, "pending.jsonl.gz"));
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".gz")),
    ).toEqual(["pending.jsonl.gz"]);
    // Process stopped after upload; an operator may normalize before resumption.
    // Resumption must use the frozen transfer bytes, not reread changed storage.
    await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=true`;
    await execute(
      legacyNormalizeSql(inspectLegacyPage(pending).page.members, {
        apply: true,
        readersReady: true,
      }),
    );
    store.failAfterPut = false;
    const receipts: LegacyBackupReceipt[] = [];
    const noSource: LegacySqlReader = {
      query: async () => {
        throw new Error("source is offline");
      },
    };
    const resumed = await exportLegacyReports({ ...input, source: noSource });
    for (const name of resumed.receipts)
      receipts.push(JSON.parse(await readFile(join(path, name), "utf8")));
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".gz")),
    ).toEqual([]);
    // Simulate death after durable checkpoint but before the pending-page drop.
    await writeFile(join(path, "pending.jsonl.gz"), pending);
    store.corrupt = true;
    await expect(
      exportLegacyReports({ ...input, source: noSource }),
    ).rejects.toThrow(/proof/);
    expect(
      (await readFile(join(path, "pending.jsonl.gz"))).equals(pending),
    ).toBe(true);
    store.corrupt = false;
    await exportLegacyReports({ ...input, source: noSource });
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".gz")),
    ).toEqual([]);
    for (let page = 0; page < 12; page++) {
      const result = await exportLegacyReports(input);
      for (const name of result.receipts)
        receipts.push(JSON.parse(await readFile(join(path, name), "utf8")));
      if (result.complete) break;
    }
    expect(
      JSON.parse(await readFile(join(path, "checkpoint.json"), "utf8")).next
        .execution,
    ).toBe(1);
    const members = [];
    for (const receipt of receipts)
      members.push(
        ...decodeLegacyPage(await store.read(receipt.object), receipt).members,
      );
    expect(members.map((m) => `${m.kind}:${m.sequence}`)).toEqual([
      "report:1",
      "report:3",
      "report:8",
      "report:9",
      "report:10",
      "conflict:3",
    ]);
    expect(members[0].reportText).toContain(
      "900719925474099312345678901234567890",
    );
    expect(members[0].reportText).toContain("0.100000000000000000001");
    expect(members[0].rowText).toContain("created_at");
    expect(
      (
        await client.sql`SELECT count(*)::int AS n FROM public.progressive_remote_dispatches`
      )[0].n,
    ).toBe(0);
    await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=true`;
    for (const receipt of receipts) {
      const page = decodeLegacyPage(await store.read(receipt.object), receipt);
      if (page.members.length)
        await execute(
          legacyNormalizeSql(page.members, { apply: true, readersReady: true }),
        );
    }
    // The normal broker remains unavailable. Existing SQL reconstruction is sufficient.
    store.corrupt = true;
    expect(await logical(scope.executions[0].executionId)).toEqual(before);
    const [dedup] =
      await client.sql`SELECT count(*)::int AS n,count(DISTINCT result_payload_hash)::int AS payloads,
      count(result_payload_hash)::int AS normalized,bool_and(archived_at IS NULL AND archive_bundle_id IS NULL) AS local
      FROM public.progressive_worker_reports WHERE sim_job_id=${scope.executions[0].executionId}`;
    expect(dedup).toEqual({ n: 5, payloads: 1, normalized: 3, local: true });
    for (const member of members.filter((m) => m.kind === "report")) {
      // Exact reapplication/readback remains idempotent, including absent/null.
      await execute(
        legacyNormalizeSql([member], { apply: true, readersReady: true }),
      );
    }
    const [conflict] =
      await client.sql`SELECT report::text AS text,reason FROM public.progressive_worker_report_conflicts WHERE sim_job_id=${scope.executions[0].executionId}`;
    expect(conflict.text).toBe(
      members.find((m) => m.kind === "conflict")!.reportText,
    );
    expect(conflict.reason).toBe("original conflict");
    await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=false`;
    await execute(
      legacyNormalizeSql(members, {
        apply: true,
        readersReady: true,
        restoreInline: true,
      }),
    );
    expect(await logical(scope.executions[0].executionId)).toEqual(before);
    expect(
      (
        await client.sql`SELECT count(result_payload_hash)::int AS n FROM public.progressive_worker_reports WHERE sim_job_id=${scope.executions[0].executionId}`
      )[0].n,
    ).toBe(0);
  });

  it("refuses corruption, count drift, wrong solver, oversized rows, source rebinding and unsafe input", async () => {
    const scope = await fixture(false);
    const store = new MemoryBackup();
    const path = await directory();
    const input = {
      source,
      store,
      scope,
      directory: path,
      sourceBinding: "owner-ssh",
      rows: 16,
    };
    store.corrupt = true;
    await expect(exportLegacyReports(input)).rejects.toThrow(/proof/);
    expect(
      JSON.parse(await readFile(join(path, "checkpoint.json"), "utf8")).next
        .after,
    ).toBe(0);
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".gz")),
    ).toEqual(["pending.jsonl.gz"]);
    store.corrupt = false;
    await expect(
      readLegacyPage(source, scope, undefined, 2, 1),
    ).rejects.toThrow(/budget/);
    await expect(
      readLegacyPage(source, { ...scope, solverId: randomUUID() }),
    ).rejects.toThrow(/identity/);
    await expect(
      readLegacyPage(source, {
        ...scope,
        executions: [{ ...scope.executions[0], reports: 4 }],
      }),
    ).rejects.toThrow(/grew/);
    const result = await exportLegacyReports(input);
    expect(result.complete).toBe(true);
    await expect(
      exportLegacyReports({ ...input, sourceBinding: "another-host" }),
    ).rejects.toThrow(/binding/);
    expect(() => new LegacySshReader("-oProxyCommand=bad", "pg")).toThrow();
    expect(() => new LegacySshReader("owner", "pg;evil")).toThrow();
    expect(
      (await readdir(path)).filter((name) => name.endsWith(".gz")),
    ).toEqual([]);
  });

  it("rolls back the whole exact page on a changed/missing member, enforces policy and leaves acknowledgements alone", async () => {
    const scope = await fixture(false);
    const page = await readLegacyPage(source, scope);
    expect(page.members).toHaveLength(5);
    const executionId = scope.executions[0].executionId;
    const before = await logical(executionId);
    await expect(
      execute(
        legacyNormalizeSql(page.members, { apply: true, readersReady: true }),
      ),
    ).rejects.toThrow(/prerequisite/);
    await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=true`;
    const changed = page.members.map((m, index) =>
      index === 1 ? { ...m, reportSha256: "0".repeat(64) } : m,
    );
    await expect(
      execute(legacyNormalizeSql(changed, { apply: true, readersReady: true })),
    ).rejects.toThrow(/differs/);
    expect(await logical(executionId)).toEqual(before);
    await expect(
      execute(
        legacyNormalizeSql([{ ...page.members[0], sequence: 2 }], {
          apply: true,
          readersReady: true,
        }),
      ),
    ).rejects.toThrow(/no rows/);
    await execute(legacyNormalizeSql(page.members)); // ROLLBACK default
    expect(
      (
        await client.sql`SELECT count(result_payload_hash)::int AS n FROM public.progressive_worker_reports WHERE sim_job_id=${executionId}`
      )[0].n,
    ).toBe(0);
    await client.sql`UPDATE public.progressive_worker_reports SET acknowledged_at=clock_timestamp() WHERE sim_job_id=${executionId} AND sequence=1`;
    const current = await logical(executionId);
    await execute(
      legacyNormalizeSql(page.members, { apply: true, readersReady: true }),
    );
    expect(await logical(executionId)).toEqual(current);
  });

  it("keeps short byte pages resumable and detects a missing source row without skipping it", async () => {
    const scope = await fixture(false);
    const first = await readLegacyPage(source, scope, undefined, 1);
    const cost =
      Buffer.byteLength(first.members[0].rowText) +
      first.members[0].reportByteSize;
    const page = await readLegacyPage(source, scope, undefined, 16, cost + 10);
    expect(page.members).toHaveLength(1);
    expect(page.next.after).toBe(1);
    const second = await readLegacyPage(source, scope, page.next, 1);
    expect(second.members[0].sequence).toBe(3);
    const missing: LegacySqlReader = {
      async query(sql, max) {
        return sql.includes("WITH selected") ? [] : source.query(sql, max);
      },
    };
    await expect(readLegacyPage(missing, scope)).rejects.toThrow(/missing/);
    const packed = encodeLegacyPage(first);
    expect(packed.bytes.length).toBeLessThan(cost);
    const all = await readLegacyPage(source, scope);
    const dictionary = inspectLegacyPage(encodeLegacyPage(all).bytes);
    expect(dictionary.page.members).toEqual(all.members);
    expect(dictionary.uniqueChunkBytes).toBeLessThan(
      dictionary.decodedBytes * 0.7,
    );
    const sliced = {
      ...scope,
      executions: [
        {
          ...scope.executions[0],
          reportAfter: 2,
          reports: 2,
          reportHighWater: 8,
        },
      ],
    };
    expect(
      (await readLegacyPage(source, sliced)).members.map((m) => m.sequence),
    ).toEqual([3, 8]);
    expect(legacyInventorySql("worker")).toContain("READ ONLY");
    expect(legacyInventorySql("hub")).toContain("hasDispatch");
  });
});

describe("canonical hub identity and immutable object REST contract", () => {
  it("waits for the hub deployment lock before uploading or reading a generation", async () => {
    const dir = await directory();
    const capture = join(dir, "commands");
    await writeFile(
      join(dir, "ssh"),
      `#!/bin/sh
for arg do command=$arg; done
printf '%.72s\\n' "$command" >> "$LEGACY_LOCK_TEST_LOG"
cat >/dev/null
exit 75
`,
      { mode: 0o700 },
    );
    const body = Buffer.from("one stored report");
    const sha256 = legacySha256(body);
    const object = {
      bucket: "backup-test",
      objectKey: `legacy-worker-reports/v1/hz/${randomUUID()}/${"a".repeat(64)}/${sha256}.jsonl.gz`,
      generation: "12345",
      sha256,
      byteSize: body.length,
      crc32c: "AAAAAA==",
      verifiedAt: new Date().toISOString(),
    };
    const store = new LegacyHubSshStore(
      "existing-hub",
      "hub-sweeper",
      object.bucket,
      "workload@example.invalid",
    );
    vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
    vi.stubEnv("LEGACY_LOCK_TEST_LOG", capture);
    try {
      await expect(store.put(object.objectKey, body)).rejects.toBeInstanceOf(
        LegacyOperatorPaused,
      );
      await expect(store.read(object)).rejects.toBeInstanceOf(
        LegacyOperatorPaused,
      );
      const commands = (await readFile(capture, "utf8")).trimEnd().split("\n");
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        expect(command).toMatch(
          /^flock -s -w 15 -E 75 \/tmp\/airfoils-pro-deploy\.lock docker exec/,
        );
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([429, 503, 401, 403, 404])(
    "sanitizes HTTP %s and only retries explicit transient storage status",
    async (status) => {
      const account = "fixture@unit-project.iam.gserviceaccount.com",
        secret = "private@example.invalid Bearer hidden-token error-body";
      const fetcher = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/email"))
          return new Response(account, {
            headers: { "Metadata-Flavor": "Google" },
          });
        if (url.endsWith("/token"))
          return new Response(
            JSON.stringify({
              token_type: "Bearer",
              access_token: "hidden-token",
            }),
            { headers: { "Metadata-Flavor": "Google" } },
          );
        return new Response(secret, { status });
      }) as typeof fetch;
      const object: LegacyBackupObject = {
        bucket: "backup-test",
        objectKey: `legacy-worker-reports/v1/unit/${"a".repeat(64)}.jsonl.gz`,
        generation: "1",
        sha256: "a".repeat(64),
        byteSize: 1,
        crc32c: "AAAAAA==",
        verifiedAt: new Date().toISOString(),
      };
      const error = await new LegacyHubGcsStore("backup-test", account, fetcher)
        .read(object)
        .catch((error) => error);
      expect(error).toBeInstanceOf(LegacyStorageOperationError);
      expect(error).toMatchObject({
        retryable: status === 429 || status === 503,
        details: {
          operation: "gcs_metadata",
          httpStatus: status,
          category:
            status === 429
              ? "gcs_rate_limited"
              : status === 503
                ? "gcs_server_error"
                : status === 404
                  ? "integrity"
                  : "credentials_denied",
        },
      });
      expect(
        JSON.stringify({ message: error.message, ...error.details }),
      ).not.toMatch(/@|Bearer|hidden-token|error-body/);
    },
  );

  it("creates only absent objects, pins generations and refuses corrupt/redirected/wrong-account reads", async () => {
    const oldRole = process.env.DEPLOYMENT_ROLE;
    process.env.DEPLOYMENT_ROLE = "hub";
    const account = "canonical@test-project.iam.gserviceaccount.com";
    const bytes = Buffer.from("exact gzip object bytes");
    const key = `legacy-worker-reports/v1/hz/${randomUUID()}/${"a".repeat(64)}/${legacySha256(bytes)}.jsonl.gz`;
    let present = false;
    let badBytes = false;
    let wrongAccount = false;
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      const url = String(input);
      requests.push({ url, init });
      expect(init.redirect).toBe("error");
      if (url.endsWith("/email"))
        return new Response(wrongAccount ? "other" : account, {
          headers: { "Metadata-Flavor": "Google" },
        });
      if (url.endsWith("/token"))
        return new Response(
          JSON.stringify({
            token_type: "Bearer",
            access_token: "private-test-token",
          }),
          { headers: { "Metadata-Flavor": "Google" } },
        );
      if (url.includes("uploadType=media")) {
        expect(url).toContain("ifGenerationMatch=0");
        const status = present ? 412 : 200;
        present = true;
        return new Response("", { status });
      }
      if (url.includes("alt=media")) {
        expect(url).toContain("generation=90071992547409931");
        return new Response(
          new Uint8Array(badBytes ? Buffer.from("bad") : bytes),
        );
      }
      return new Response(
        JSON.stringify({
          generation: "90071992547409931",
          size: String(bytes.length),
          crc32c: "AAAAAA==",
          contentType: "application/gzip",
        }),
      );
    }) as typeof fetch;
    try {
      const store = new LegacyHubGcsStore("backup-test", account, fetcher);
      const object = await store.put(key, bytes);
      expect((await store.put(key, bytes)).generation).toBe(object.generation);
      expect(requests.filter((r) => r.url.includes("alt=media")).length).toBe(
        2,
      );
      badBytes = true;
      await expect(store.read(object)).rejects.toMatchObject({
        details: { operation: "gcs_download", category: "integrity" },
        retryable: false,
      });
      badBytes = false;
      wrongAccount = true;
      await expect(store.read(object)).rejects.toMatchObject({
        details: { operation: "hub_identity", category: "credentials_denied" },
        retryable: false,
      });
      await expect(
        store.read({ ...object, bucket: "another-bucket" }),
      ).rejects.toMatchObject({
        details: { operation: "gcs_download", category: "bad_input" },
        retryable: false,
      });
      expect(
        requests
          .filter((r) => r.url.includes("storage.googleapis.com"))
          .every(
            (r) =>
              (r.init.headers as Record<string, string>).Authorization ===
              "Bearer private-test-token",
          ),
      ).toBe(true);
    } finally {
      if (oldRole === undefined) delete process.env.DEPLOYMENT_ROLE;
      else process.env.DEPLOYMENT_ROLE = oldRole;
    }
  });
  it("plans without contacting SSH/GCS or creating a checkpoint and rejects unknown mutation switches", async () => {
    const scope = await fixture(false);
    const path = await directory();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(path, "scope.json"), JSON.stringify(scope));
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await legacyReportStorageCli([
        "plan",
        `--scope=${path}/scope.json`,
        `--directory=${path}/not-created`,
        "--ssh-host=existing-owner-hz",
        "--container=existing-pg",
        "--hub-ssh-host=existing-hub",
        "--hub-container=existing-sweeper",
        "--bucket=backup-test",
        "--hub-service-account=canonical@test-project.iam.gserviceaccount.com",
      ]);
      const plan = JSON.parse(output.mock.calls[0][0]);
      expect(plan.source.readOnly).toBe(true);
      expect(plan.writes).toContain("none in plan");
      expect(await readdir(path)).toEqual(["scope.json"]);
      await expect(
        legacyReportStorageCli(["copy", "--grant-dispatch"]),
      ).rejects.toThrow();
    } finally {
      output.mockRestore();
    }
  });
});
