import { cloneStagingFixtureHub, createStagingFixtureWorker } from "./worker-staging-key-hub";
import { deliverNextProgressiveWorkerEvidence } from "../src/progressive-worker-evidence-delivery";
import { createClient, type DB } from "@aerodb/db";
import {
  readProgressiveReportArchiveText,
  verifyProgressiveReportArchive,
  type ProgressiveReportArchiveReadIdentity,
} from "@aerodb/db/progressive-report-archive";
import {
  installProgressiveReportArchiveReader,
  readProgressiveReport,
} from "@aerodb/db/progressive-report-reader";
import {
  backfillProgressiveReportPayloads,
  proveProgressiveReportsInline,
  setProgressiveReportNormalization,
} from "@aerodb/db/progressive-report-payloads";
import { acknowledgeProgressiveWorkerReport } from "@aerodb/db/progressive-worker-reports";
import { backfillWorkerStagingKeyPage, maintainWorkerStagingKeys } from "@aerodb/db/worker-staging-key-maintenance";
import { measureExistingWorkerReport, measureWorkerStagingWrites } from "./worker-staging-key-workload-cost";
import { stageProgressiveWorkerEvidence } from "../src/progressive-worker-evidence";
import { progressiveStagingSelectionSql } from "../src/progressive-staging-selection";
import type { EngineClient } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { Storage } from "@google-cloud/storage";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  archiveProgressiveReportBatch,
  nextProgressiveReportArchiveJob,
  runProgressiveReportArchiveService,
} from "../src/progressive-report-archive-service";
import {
  ProgressiveReportArchiveStore,
  type ProgressiveReportArchiveIdentity,
} from "../src/progressive-report-archive-store";
import {
  readWorkerReportArchiveText,
  WorkerReportFetchDisabled,
} from "../src/report-archive-broker-client";
import { readWorkerReportVolume } from "../src/worker-report-volume";
import { makeReportStorageDatabase } from "../src/config";
import {
  releaseUpstreamReadableVolume,
  runWorkerVolumeCleanup,
} from "../src/worker-report-volume-cleanup";
import {
  archiveSha256,
  archiveSnapshot,
  archiveTable,
  LARGE_REPORT_INTEGER,
  withArchiveFixture,
  type ArchiveFixture,
  type ArchiveSource,
} from "./progressive-report-archive-fixture";

// This file belongs to the schema-2 progressive-report-archive graph. It must
// never silently fall back to the shared development or production database.
beforeAll(() => {
  expect(
    process.env.PROGRESSIVE_REPORT_ARCHIVE_DISPOSABLE_DB,
    "Run progressive-report-archive through its disposable-Postgres graph",
  ).toBe("1");
});
const client = createClient({ max: 1 });
afterAll(() => client.sql.end());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  installProgressiveReportArchiveReader(null);
});

type PutFile = Parameters<typeof archiveProgressiveReportBatch>[3];
type StorePutFile = ProgressiveReportArchiveStore["putFile"];

/** Only the object-store boundary is substituted. Every bundle is read back
 * from disk, independently hashed, decompressed and verified before the real
 * SQL transaction is allowed to shorten a report. No network or engine runs. */
function cloudFixture() {
  const objects = new Map<string, Buffer>();
  const paths: string[] = [];
  const putFile = vi.fn<StorePutFile>(async (path, local, source, executionId) => {
    paths.push(path);
    const bytes = await readFile(path);
    expect(archiveSha256(bytes)).toBe(local.sha256);
    expect(bytes.byteLength).toBe(local.byteSize);
    const crc = new Storage({
      projectId: "disposable-report-archive",
    }).crc32cGenerator();
    crc.update(bytes);
    const identity: ProgressiveReportArchiveIdentity = {
      bucket: "disposable-report-archive",
      objectKey: `${source}/${executionId}/${local.sha256}.jsonl.gz`,
      generation: "9007199254740993123",
      mimeType: "application/gzip",
      compression: "gzip",
      archiveFormat: "jsonl",
      storedSha256: local.sha256,
      storedByteSize: local.byteSize,
      crc32c: crc.toString(),
      verifiedAt: new Date(),
    };
    // Exercise the same complete-object proof used by a generation-pinned GCS
    // read, including every member and the compressed bytes through EOF.
    const readback = Buffer.from(bytes);
    await verifyProgressiveReportArchive(Readable.from([readback]), identity);
    expect(readback.equals(bytes)).toBe(true);
    const previous = objects.get(identity.objectKey);
    if (previous) expect(previous.equals(readback)).toBe(true);
    objects.set(identity.objectKey, readback);
    return identity;
  });
  return { objects, paths, putFile };
}

async function storedMembers(fixture: ArchiveFixture) {
  const rows = await fixture.db
    .execute(sql`SELECT m.sequence,m.member_kind,m.content_signature,
    m.report_sha256,m.report_byte_size,b.* FROM progressive_report_archive_members m
    JOIN progressive_report_archive_bundles b ON b.id=m.bundle_id
    WHERE m.source_kind=${fixture.source} AND m.sim_job_id=${fixture.executionId}::uuid
    ORDER BY m.sequence,m.member_kind`);
  return rows.map(
    (row) =>
      ({
        sourceKind: fixture.source,
        memberKind: row.member_kind as "report" | "conflict",
        executionId: fixture.executionId,
        sequence: Number(row.sequence),
        signature: String(row.content_signature),
        reportSha256: String(row.report_sha256),
        reportByteSize: Number(row.report_byte_size),
        bucket: String(row.bucket),
        objectKey: String(row.object_key),
        generation: String(row.generation),
        mimeType: String(row.mime_type),
        compression: String(row.compression),
        archiveFormat: String(row.archive_format),
        storedSha256: String(row.stored_sha256),
        storedByteSize: Number(row.stored_byte_size),
        crc32c: String(row.crc32c),
        memberCount: Number(row.member_count),
        firstSequence: Number(row.first_sequence),
        lastSequence: Number(row.last_sequence),
      }) satisfies ProgressiveReportArchiveReadIdentity,
  );
}

async function expectRoundtrip(
  fixture: ArchiveFixture,
  cloud: ReturnType<typeof cloudFixture>,
) {
  const members = await storedMembers(fixture);
  const corruptedObjects = new Set<string>();
  installProgressiveReportArchiveReader({
    async read(identity) {
      expect(identity.sourceKind).toBe(fixture.source);
      expect(identity.executionId).toBe(fixture.executionId);
      expect(identity.generation).toBe("9007199254740993123");
      return readProgressiveReportArchiveText(
        Readable.from([cloud.objects.get(identity.objectKey)!]),
        identity,
      );
    },
  });
  expect(
    members.filter((member) => member.memberKind === "report"),
  ).toHaveLength(fixture.reports.length);
  for (const report of fixture.reports) {
    const member = members.find(
      (item) =>
        item.memberKind === "report" && item.sequence === report.sequence,
    )!;
    expect(member.signature).toBe(report.contentSignature);
    expect(member.reportSha256).toBe(archiveSha256(report.text));
    expect(member.reportByteSize).toBe(Buffer.byteLength(report.text));
    const bytes = cloud.objects.get(member.objectKey)!;
    expect(bytes).toBeDefined();
    const restored = await readProgressiveReportArchiveText(
      Readable.from([bytes]),
      member,
    );
    expect(restored).toBe(report.text);
    expect(restored).toContain(LARGE_REPORT_INTEGER);
    expect(restored).toContain('"diagnosticNull": null');
    expect(restored).toContain(
      report.sequence === 1 ? '"result": null' : '"cl": null',
    );
    const read = await readProgressiveReport(fixture.db, {
      sourceKind: fixture.source,
      executionId: fixture.executionId,
      sequence: report.sequence,
      contentSignature: report.contentSignature,
    });
    expect(read.executionId).toBe(fixture.executionId);
    expect(read.sequence).toBe(report.sequence);
    if (report.sequence === 1) expect(read.result).toBeNull();
    else expect(read.result!.polars[0]!.attempts![0]!.cl).toBeNull();
    // A one-byte object corruption must not return even an earlier valid
    // member. Verification owns the entire compressed generation.
    if (!corruptedObjects.has(member.objectKey)) {
      corruptedObjects.add(member.objectKey);
      const corrupt = Buffer.from(bytes);
      corrupt[corrupt.length - 1]! ^= 1;
      await expect(
        readProgressiveReportArchiveText(Readable.from([corrupt]), member),
      ).rejects.toThrow();
    }
  }
  for (const path of cloud.paths)
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
}

it("opens the production archive connections with PostgreSQL's bounded session settings", async () => {
  for (const name of ["report-storage", "report-storage-backfill"] as const) {
    const pool = makeReportStorageDatabase(name);
    try {
      const [row] = await pool.db
        .execute(sql`SELECT current_setting('application_name') AS name,
        (SELECT setting::int FROM pg_settings WHERE name='statement_timeout') AS statement_ms,
        (SELECT setting::int FROM pg_settings WHERE name='lock_timeout') AS lock_ms,
        (SELECT setting::int FROM pg_settings WHERE name='client_connection_check_interval') AS check_ms`);
      expect(row).toEqual({
        name,
        statement_ms: 60_000,
        lock_ms: 3_000,
        check_ms: 2_000,
      });
    } finally {
      await pool.sql.end();
    }
  }
});

async function expectSqlRefusal(
  db: DB,
  mutation: (connection: DB) => Promise<unknown>,
  message: RegExp,
) {
  let failure: unknown;
  try {
    await db.transaction((tx) => mutation(tx as unknown as DB));
  } catch (error) {
    failure = error;
  }
  expect(
    failure,
    "The migrated SQL guard must reject this mutation",
  ).toBeDefined();
  const messages: string[] = [];
  for (let error = failure; error instanceof Error; error = error.cause)
    messages.push(error.message);
  expect(messages.join("\n")).toMatch(message);
}

async function runOwnedWorkerArchivePass(fixture: ArchiveFixture) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  const messages: string[] = [],
    errors: unknown[][] = [];
  const info = vi.spyOn(console, "info").mockImplementation((message) => {
    messages.push(String(message));
    if (String(message).includes(fixture.executionId)) controller.abort();
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values) => {
    errors.push(values);
    controller.abort();
  });
  const dialect = new PgDialect();
  // Restrict discovery to this owned fixture so a service pass cannot archive
  // another suite's work. All admission, report, payload and commit queries
  // still run against the migrated public tables in the rollback transaction.
  const scoped = {
    execute(statement: SQL) {
      if (
        dialect
          .sqlToQuery(statement)
          .sql.trim()
          .startsWith("WITH batch AS MATERIALIZED")
      )
        return fixture.db.execute(
          sql`SELECT id,id AS last_id FROM sim_jobs WHERE id=${fixture.executionId}::uuid`,
        );
      return fixture.db.execute(statement);
    },
    transaction: fixture.db.transaction.bind(fixture.db),
  } as unknown as DB;
  try {
    await runProgressiveReportArchiveService(scoped, controller.signal);
  } finally {
    clearTimeout(timeout);
    info.mockRestore();
    error.mockRestore();
  }
  expect(
    timedOut,
    "Archive pass must produce an observable success or refusal before its deadline",
  ).toBe(false);
  return { messages, errors };
}

async function runWorkerVolumeCleanupPass(db: DB) {
  const controller = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  const messages: unknown[][] = [];
  const info = vi.spyOn(console, "info").mockImplementation((...values) => {
    messages.push(values);
    controller.abort(); // the real service has completed a release or reported retention
  });
  try {
    await runWorkerVolumeCleanup(db, controller.signal);
  } finally {
    clearTimeout(deadline);
    info.mockRestore();
  }
  expect(
    timedOut,
    "Cleanup must report its actual release or denied read before its deadline",
  ).toBe(false);
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

describe.each<ArchiveSource>(["remote", "worker"])(
  "%s progressive report archive database boundary",
  (source) => {
    it("requires upgraded readers and counts archived bodies before permitting an old-reader rollback", async () => {
      await withArchiveFixture(
        client,
        source,
        async (fixture) => {
          const inline = await proveProgressiveReportsInline(fixture.db);
          expect(inline.normalizationEnabled).toBe(false);
          expect(inline.oldReaderRollbackSafe).toBe(true);
          const before = await archiveSnapshot(fixture);
          await expect(
            setProgressiveReportNormalization(fixture.db, {
              enabled: true,
              readersReady: false,
            }),
          ).rejects.toThrow("verify all report readers");
          expect(await archiveSnapshot(fixture)).toEqual(before);

          const cloud = cloudFixture();
          expect(
            await archiveProgressiveReportBatch(
              fixture.db,
              source,
              fixture.executionId,
              cloud.putFile,
            ),
          ).toBe(fixture.reports.length);
          const archived = await archiveSnapshot(fixture);
          const table =
            source === "remote"
              ? "progressive_remote_reports"
              : "progressive_worker_reports";
          const proof = await proveProgressiveReportsInline(fixture.db);
          expect(proof.normalizationEnabled).toBe(false);
          expect(proof.oldReaderRollbackSafe).toBe(false);
          const count = proof.counts.find((row) => row.table === table)!;
          expect(count.normalizedReports).toBe("0");
          expect(Number(count.archivedReports)).toBe(fixture.reports.length);
          // The inline rollback tool cannot silently treat an archived compact
          // header as the original full body or declare the old reader safe.
          const restored = await backfillProgressiveReportPayloads(fixture.db, {
            table,
            apply: true,
            restoreInline: true,
            rows: 128,
          });
          expect(
            restored.proofs.filter(
              (row) => row.executionId === fixture.executionId,
            ),
          ).toEqual([]);
          expect(await archiveSnapshot(fixture)).toEqual(archived);
          expect(
            (await proveProgressiveReportsInline(fixture.db))
              .oldReaderRollbackSafe,
          ).toBe(false);
          await expectRoundtrip(fixture, cloud);
        },
        { normalized: false },
      );
    });

    it.each([false, true])(
      "roundtrips exact PG bytes from normalized=%s reports without changing results",
      async (normalized) => {
        vi.stubEnv(
          "AIRFOILFOAM_DEPLOYMENT_ROLE",
          source === "remote" ? "hub" : "remote-solver",
        );
        await withArchiveFixture(
          client,
          source,
          async (fixture) => {
            const stagingKeys = sql`SELECT sim_job_id,sequence,created_at,stopped_engine_job_id
              FROM public.progressive_worker_staging_keys WHERE sim_job_id=${fixture.executionId}::uuid ORDER BY sequence`;
            const sourceKeys = sql`SELECT sim_job_id,sequence,created_at,stopped_engine_job_id
              FROM public.progressive_worker_reports WHERE sim_job_id=${fixture.executionId}::uuid
                AND acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object' ORDER BY sequence`;
            const membership = source === "worker" ? await fixture.db.execute(sourceKeys) : [];
            const [tracking] = await fixture.db.execute(sql`SELECT EXISTS(SELECT FROM
              public.progressive_worker_staging_key_backfill WHERE singleton) AS active`);
            if (source === "worker") {
              expect(membership.length).toBeGreaterThan(0);
              expect(await fixture.db.execute(stagingKeys)).toEqual(tracking.active ? membership : []);
            }
            const before = await archiveSnapshot(fixture);
            expect((before.results as unknown[]).length).toBe(1);
            expect((before.result_attempts as unknown[]).length).toBe(1);
            if (source === "remote") {
              const [job] = await fixture.db.execute(
                sql`SELECT request_payload FROM sim_jobs WHERE id=${fixture.executionId}::uuid`,
              );
              expect(job.request_payload).not.toHaveProperty("remoteSolver");
              expect(job.request_payload).not.toHaveProperty("syncPromiseId");
            } else {
              const [dispatch] = await fixture.db
                .execute(sql`SELECT count(*)::int AS n FROM progressive_remote_dispatches
          WHERE sim_job_id=${fixture.executionId}::uuid`);
              expect(dispatch.n).toBe(0);
            }
            expect(fixture.reports[1]!.payloadHash !== null).toBe(normalized);
            if (normalized) {
              await expectSqlRefusal(
                fixture.db,
                (connection) =>
                  connection.execute(sql`
                DELETE FROM public.progressive_report_result_payloads
                WHERE content_hash=${fixture.reports[1]!.payloadHash}
              `),
                /still referenced|foreign key/i,
              );
            }
            const cloud = cloudFixture();
            expect(
              await archiveProgressiveReportBatch(
                fixture.db,
                source,
                fixture.executionId,
                cloud.putFile,
              ),
            ).toBe(fixture.reports.length);
            if (source === "worker") {
              expect(await fixture.db.execute(sourceKeys)).toEqual(membership);
              expect(await fixture.db.execute(stagingKeys)).toEqual(tracking.active ? membership : []);
            }
            const after = await archiveSnapshot(fixture);
            for (const table of [
              "results",
              "result_attempts",
              "sim_jobs",
              "progressive_remote_report_inventories",
              "progressive_remote_report_sources",
              "progressive_remote_progress_receipts",
              "progressive_remote_diagnostic_receipts",
              "progressive_worker_evidence_receipts",
            ])
              expect(after[table], table).toEqual(before[table]);
            const rows = await fixture.db
              .execute(sql`SELECT archived_at,archive_bundle_id,result_payload_hash,
        report ? 'result' AS has_result,report ? 'stopProof' AS has_stop,
        report->'result' AS result FROM ${archiveTable(source)} WHERE sim_job_id=${fixture.executionId}::uuid ORDER BY sequence`);
            expect(rows).toHaveLength(fixture.reports.length);
            for (const row of rows) {
              expect(row.archived_at).not.toBeNull();
              expect(row.archive_bundle_id).not.toBeNull();
              expect(row.result_payload_hash).toBeNull();
              expect(row.has_result).toBe(true);
              expect(row.has_stop).toBe(true);
            }
            expect(rows[0]!.result).toBeNull();
            expect(rows[1]!.result).not.toHaveProperty("polars");
            await expectRoundtrip(fixture, cloud);
            const archived = await archiveSnapshot(fixture);
            expect(
              await archiveProgressiveReportBatch(
                fixture.db,
                source,
                fixture.executionId,
                cloud.putFile,
              ),
            ).toBe(0);
            expect(cloud.putFile).toHaveBeenCalledTimes(1);
            expect(await archiveSnapshot(fixture)).toEqual(archived);
          },
          { normalized },
        );
      },
    );

    it("preserves full reports and payloads on storage failure, then retries exactly once", async () => {
      await withArchiveFixture(client, source, async (fixture) => {
        const before = await archiveSnapshot(fixture);
        const cloud = cloudFixture();
        cloud.putFile.mockImplementationOnce(async (path) => {
          cloud.paths.push(path);
          throw new Error("simulated generation-pinned GCS readback failure");
        });
        await expect(
          archiveProgressiveReportBatch(
            fixture.db,
            source,
            fixture.executionId,
            cloud.putFile,
          ),
        ).rejects.toThrow("GCS readback failure");
        expect(await archiveSnapshot(fixture)).toEqual(before);
        expect(
          await archiveProgressiveReportBatch(
            fixture.db,
            source,
            fixture.executionId,
            cloud.putFile,
          ),
        ).toBe(fixture.reports.length);
        await expectRoundtrip(fixture, cloud);
        expect(
          await archiveProgressiveReportBatch(
            fixture.db,
            source,
            fixture.executionId,
            cloud.putFile,
          ),
        ).toBe(0);
        expect(cloud.putFile).toHaveBeenCalledTimes(2);
      });
    });

    it.each(["hash", "size"])(
      "refuses a mismatching uploaded %s and retains all SQL data",
      async (field) => {
        await withArchiveFixture(client, source, async (fixture) => {
          const before = await archiveSnapshot(fixture);
          const cloud = cloudFixture();
          const put: PutFile = async (path, local, source, id) => {
            const identity = await cloud.putFile(path, local, source, id);
            return {
              ...identity,
              ...(field === "hash"
                ? { storedSha256: "0".repeat(64) }
                : { storedByteSize: identity.storedByteSize + 1 }),
            };
          };
          await expect(
            archiveProgressiveReportBatch(
              fixture.db,
              source,
              fixture.executionId,
              put,
            ),
          ).rejects.toThrow(/readback/i);
          expect(await archiveSnapshot(fixture)).toEqual(before);
          for (const path of cloud.paths)
            await expect(readFile(path)).rejects.toMatchObject({
              code: "ENOENT",
            });
        });
      },
    );

    it.each(["running", "not-ingested", "active-promise", "ingest-lease"])(
      "leaves %s work inline until eligibility is restored",
      async (reason) => {
        await withArchiveFixture(client, source, async (fixture) => {
          const { db, executionId, promiseId } = fixture;
          if (reason === "running")
            await db.execute(
              sql`UPDATE sim_jobs SET status='running' WHERE id=${executionId}::uuid`,
            );
          if (reason === "not-ingested")
            await db.execute(
              sql`UPDATE sim_jobs SET status='cancelled',"ingestedAt"=NULL WHERE id=${executionId}::uuid`,
            );
          if (reason === "active-promise")
            await db.execute(
              sql`UPDATE sync_sweep_promises SET status='active' WHERE id=${promiseId}::uuid`,
            );
          if (reason === "ingest-lease")
            await db.execute(sql`UPDATE sim_jobs SET ingest_lease_token='archive-fixture-owner',
        ingest_lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=${executionId}::uuid`);
          const before = await archiveSnapshot(fixture);
          const cloud = cloudFixture();
          if (source === "remote") {
            const cursor = executionId.slice(0, 14) + "0000-0000-000000000000";
            const page = await nextProgressiveReportArchiveJob(db, source, cursor);
            expect(page?.id).not.toBe(executionId);
            expect(page?.last_id).toBeTruthy();
          }
          expect(
            await archiveProgressiveReportBatch(
              db,
              source,
              executionId,
              cloud.putFile,
            ),
          ).toBe(0);
          expect(cloud.putFile).not.toHaveBeenCalled();
          expect(await archiveSnapshot(fixture)).toEqual(before);
          await db.execute(sql`UPDATE sim_jobs SET status='failed',"ingestedAt"=clock_timestamp(),
        ingest_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${executionId}::uuid`);
          await db.execute(
            sql`UPDATE sync_sweep_promises SET status='expired' WHERE id=${promiseId}::uuid`,
          );
          expect(
            await archiveProgressiveReportBatch(
              db,
              source,
              executionId,
              cloud.putFile,
            ),
          ).toBe(fixture.reports.length);
          await expectRoundtrip(fixture, cloud);
        });
      },
    );

    it.each(["physical-stop", "report-settlement"])(
      "requires %s before removing any full body",
      async (reason) => {
        await withArchiveFixture(
          client,
          source,
          async (fixture) => {
            const before = await archiveSnapshot(fixture);
            const cloud = cloudFixture();
            expect(
              await archiveProgressiveReportBatch(
                fixture.db,
                source,
                fixture.executionId,
                cloud.putFile,
              ),
            ).toBe(0);
            expect(cloud.putFile).not.toHaveBeenCalled();
            expect(await archiveSnapshot(fixture)).toEqual(before);
          },
          {
            stopped: reason !== "physical-stop",
            settled: reason !== "report-settlement",
          },
        );
      },
    );

    it.each(["hash", "size"])(
      "SQL rejects forged member %s even with registered archive custody",
      async (field) => {
        await withArchiveFixture(client, source, async (fixture) => {
          const report = fixture.reports[1]!;
          const before = await archiveSnapshot(fixture);
          await expectSqlRefusal(
            fixture.db,
            async (db) => {
              const bundleId = randomUUID();
              await db.execute(sql`INSERT INTO progressive_report_archive_bundles
          (id,source_kind,sim_job_id,bucket,object_key,generation,stored_sha256,stored_byte_size,crc32c,
            member_count,first_sequence,last_sequence,verified_at)
          VALUES (${bundleId}::uuid,${source},${fixture.executionId}::uuid,'disposable-report-archive',${bundleId},
            '9007199254740993123',${"f".repeat(64)},500,'AAAAAA==',1,${report.sequence},${report.sequence},clock_timestamp())`);
              await db.execute(sql`INSERT INTO progressive_report_archive_members
          (bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
          VALUES (${bundleId}::uuid,${source},${fixture.executionId}::uuid,${report.sequence},'report',${report.contentSignature},
            ${field === "hash" ? "0".repeat(64) : archiveSha256(report.text)},
            ${Buffer.byteLength(report.text) + (field === "size" ? 1 : 0)})`);
              await db.execute(sql`UPDATE ${archiveTable(source)} SET archived_at=clock_timestamp(),archive_bundle_id=${bundleId}::uuid,
          result_payload_hash=NULL,report=progressive_report_compact_header(report)
          WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=${report.sequence}`);
            },
            /Exact report bytes differ from verified archive member/,
          );
          expect(await archiveSnapshot(fixture)).toEqual(before);
        });
      },
    );

    it("refuses direct compaction without custody and changes to archived report identity", async () => {
      await withArchiveFixture(client, source, async (fixture) => {
        const { db, executionId } = fixture;
        const before = await archiveSnapshot(fixture);
        await expectSqlRefusal(
          db,
          (connection) =>
            connection.execute(sql`UPDATE ${archiveTable(source)} SET
        archived_at=clock_timestamp(),result_payload_hash=NULL,report=progressive_report_compact_header(report)
        WHERE sim_job_id=${executionId}::uuid`),
          /archive|immutable/i,
        );
        expect(await archiveSnapshot(fixture)).toEqual(before);
        const cloud = cloudFixture();
        expect(
          await archiveProgressiveReportBatch(
            db,
            source,
            executionId,
            cloud.putFile,
          ),
        ).toBe(fixture.reports.length);
        const archived = await archiveSnapshot(fixture);
        for (const mutation of [
          sql`UPDATE ${archiveTable(source)} SET archive_bundle_id=NULL WHERE sim_job_id=${executionId}::uuid`,
          sql`UPDATE ${archiveTable(source)} SET report=report||'{"changed":true}'::jsonb WHERE sim_job_id=${executionId}::uuid`,
          sql`UPDATE progressive_report_archive_members SET report_byte_size=report_byte_size+1 WHERE sim_job_id=${executionId}::uuid`,
          sql`DELETE FROM progressive_report_archive_bundles WHERE sim_job_id=${executionId}::uuid`,
        ])
          await expectSqlRefusal(
            db,
            (connection) => connection.execute(mutation),
            /immutable|archive/i,
          );
        expect(await archiveSnapshot(fixture)).toEqual(archived);
        await expectRoundtrip(fixture, cloud);
      });
    });
  },
);

it.each([
  "retained",
  "volume-unavailable",
  "existing-corrupt-copy",
  "unrelated-403",
])(
  "worker service preserves its last accessible full body after denied fetch: %s",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "worker-report-403-db-"));
    const volume =
      mode === "volume-unavailable"
        ? join(root, "not-a-directory")
        : join(root, "volume");
    if (mode === "volume-unavailable")
      await writeFile(volume, "unavailable volume fixture");
    vi.stubEnv("AIRFOILFOAM_REPORT_VOLUME_DIR", volume);
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
    try {
      await withArchiveFixture(client, "worker", async (fixture) => {
        const baseUrl = "https://trusted-hub.example/api/sync/v1";
        await fixture.db
          .execute(sql`UPDATE sync_sweep_promises SET source_base_url=${baseUrl}
          WHERE id=${fixture.promiseId}::uuid`);
        await fixture.db
          .execute(sql`UPDATE sim_jobs SET request_payload=request_payload||jsonb_build_object('upstreamBaseUrl',${baseUrl}::text)
          WHERE id=${fixture.executionId}::uuid`);
        await fixture.db.execute(sql`INSERT INTO sync_api_settings
          (id,remote_solver_registered_id,remote_solver_auth_token,upstream_base_url)
          SELECT 1,registered_solver_id,'synthetic-403-worker-token',${baseUrl}
          FROM sync_sweep_promises WHERE id=${fixture.promiseId}::uuid
          ON CONFLICT (id) DO UPDATE SET remote_solver_registered_id=EXCLUDED.remote_solver_registered_id,
            remote_solver_auth_token=EXCLUDED.remote_solver_auth_token,upstream_base_url=EXCLUDED.upstream_base_url`);
        const before = await archiveSnapshot(fixture);
        const uploaded: {
          bytes: Buffer;
          archive: ProgressiveReportArchiveIdentity;
        }[] = [];
        const retainedCorruption: Buffer[] = [];
        let authorised = false,
          corruptUpstream = false;
        const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
          expect(
            new Headers(init?.headers).get("x-xfoilfoam-solver-token"),
          ).toBe("synthetic-403-worker-token");
          expect(String(_url)).toContain(
            `${baseUrl}/progressive-executions/${fixture.executionId}/report-archives/`,
          );
          if (init?.method === "POST") {
            const chunks: Buffer[] = [];
            for await (const chunk of init.body as unknown as AsyncIterable<Buffer>)
              chunks.push(Buffer.from(chunk));
            const bytes = Buffer.concat(chunks),
              sha = archiveSha256(bytes);
            const crc = new Storage({
              projectId: "disposable-worker-403",
            }).crc32cGenerator();
            crc.update(bytes);
            const archive: ProgressiveReportArchiveIdentity = {
              bucket: "disposable-worker-403",
              objectKey: `progressive-reports/v1/worker/${fixture.executionId}/${sha}.jsonl.gz`,
              generation: "9007199254740993123",
              mimeType: "application/gzip",
              compression: "gzip",
              archiveFormat: "jsonl",
              storedSha256: sha,
              storedByteSize: bytes.length,
              crc32c: crc.toString(),
              verifiedAt: new Date(),
            };
            uploaded.push({ bytes, archive });
            if (mode === "existing-corrupt-copy") {
              const corrupted = Buffer.from(bytes);
              corrupted[corrupted.length - 1]! ^= 1;
              const shard = join(volume, sha.slice(0, 2));
              await mkdir(shard, { recursive: true });
              await writeFile(join(shard, sha + ".jsonl.gz"), corrupted);
              retainedCorruption.push(corrupted);
            }
            return new Response(JSON.stringify(archive), {
              headers: { "content-type": "application/json" },
            });
          }
          if (!authorised)
            return new Response(
              JSON.stringify({
                error:
                  mode === "unrelated-403"
                    ? "solver does not own this archive"
                    : "fetch disabled for evidence_artifacts",
              }),
              {
                status: 403,
                headers: { "content-type": "application/json" },
              },
            );
          const { bytes, archive } = uploaded[0]!;
          return new Response(corruptUpstream ? bytes.subarray(0, -1) : bytes, {
            headers: {
              "content-type": archive.mimeType,
              "content-length": String(bytes.length),
              "x-content-sha256": archive.storedSha256,
              "x-content-crc32c": archive.crc32c,
              "x-gcs-generation": archive.generation,
              "x-report-archive-bucket": archive.bucket,
              "x-report-archive-object-key": archive.objectKey,
            },
          });
        });
        vi.stubGlobal("fetch", fetcher);
        const outcome = await runOwnedWorkerArchivePass(fixture);
        expect(uploaded).toHaveLength(1);
        expect(fetcher).toHaveBeenCalledTimes(2); // actual POST, then the denied registered GET
        const { bytes, archive } = uploaded[0]!;
        if (mode !== "retained") {
          expect(outcome.messages).toEqual([]);
          expect(outcome.errors).toHaveLength(1);
          expect(outcome.errors.flat().map(String).join(" ")).toMatch(
            mode === "volume-unavailable"
              ? /ENOTDIR|not a directory/
              : mode === "existing-corrupt-copy"
                ? /Installed worker report failed exact readback/
                : /no access/,
          );
          expect(await archiveSnapshot(fixture)).toEqual(before);
          const rows = await fixture.db
            .execute(sql`SELECT public.resolve_progressive_report(report,result_payload_hash)::text AS text
            FROM progressive_worker_reports WHERE sim_job_id=${fixture.executionId}::uuid ORDER BY sequence`);
          expect(rows.map((row) => row.text)).toEqual(
            fixture.reports.map((report) => report.text),
          );
          if (mode === "existing-corrupt-copy")
            expect(
              await readFile(
                join(
                  volume,
                  archive.storedSha256.slice(0, 2),
                  archive.storedSha256 + ".jsonl.gz",
                ),
              ),
            ).toEqual(retainedCorruption[0]);
          return;
        }
        expect(outcome.errors).toEqual([]);
        expect(
          outcome.messages.map((message) => JSON.parse(message)),
        ).toMatchObject([
          {
            component: "progressive-report-archive",
            executionId: fixture.executionId,
            members: fixture.reports.length,
          },
        ]);
        const after = await archiveSnapshot(fixture);
        expect(after.results).toEqual(before.results);
        expect(after.result_attempts).toEqual(before.result_attempts);
        const local = await readWorkerReportVolume(archive);
        expect(local).not.toBeNull();
        const chunks: Buffer[] = [];
        for await (const chunk of local!) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks)).toEqual(bytes);
        const members = await storedMembers(fixture);
        expect(members).toHaveLength(fixture.reports.length);
        for (const member of members)
          expect(await readWorkerReportArchiveText(fixture.db, member)).toBe(
            fixture.reports.find(
              (report) => report.sequence === member.sequence,
            )!.text,
          );
        expect(fetcher).toHaveBeenCalledTimes(2); // HZ uses its own surviving persisted bytes
        const member = members[0]!;
        await expect(
          readWorkerReportArchiveText(fixture.db, member, {
            upstreamOnly: true,
          }),
        ).rejects.toBeInstanceOf(WorkerReportFetchDisabled);
        const path = join(
          volume,
          archive.storedSha256.slice(0, 2),
          archive.storedSha256 + ".jsonl.gz",
        );
        expect(await readFile(path)).toEqual(bytes);
        const denied = await runWorkerVolumeCleanupPass(fixture.db);
        expect(denied.map(String).join(" ")).toMatch(
          /working copies retained:.*hub disables evidence downloads/i,
        );
        expect(await readFile(path)).toEqual(bytes);
        expect(await archiveSnapshot(fixture)).toEqual(after);
        authorised = true;
        corruptUpstream = true;
        await expect(
          releaseUpstreamReadableVolume(
            fixture.db,
            archive,
            new AbortController().signal,
          ),
        ).rejects.toThrow();
        expect(await readFile(path)).toEqual(bytes);
        expect(await archiveSnapshot(fixture)).toEqual(after);
        corruptUpstream = false;
        expect(
          await readWorkerReportArchiveText(fixture.db, member, {
            upstreamOnly: true,
          }),
        ).toBe(fixture.reports[0]!.text);
        expect(await readFile(path)).toEqual(bytes);
        const released = await runWorkerVolumeCleanupPass(fixture.db);
        expect(released).toHaveLength(1);
        expect(JSON.parse(String(released[0]))).toEqual({
          component: "worker-report-volume-cleanup",
          releasedBytes: bytes.length,
        });
        expect(await readWorkerReportVolume(archive)).toBeNull();
        await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readWorkerReportArchiveText(fixture.db, member)).toBe(
          fixture.reports[0]!.text,
        );
        expect(await archiveSnapshot(fixture)).toEqual(after);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it.each([false, true])(
  "retains distinct worker conflict bytes even when signature matches=%s",
  async (sameSignature) => {
    await withArchiveFixture(client, "worker", async (fixture) => {
      const original = fixture.reports[1]!;
      const [conflict] = await fixture.db.execute(
        sql`SELECT (${original.text}::jsonb||'{"rejectionReason":null}'::jsonb)::text AS text`,
      );
      const text = String(conflict.text);
      const signature = sameSignature
        ? original.contentSignature
        : archiveSha256(text);
      await fixture.db
        .execute(sql`INSERT INTO progressive_worker_report_conflicts
      (sim_job_id,sequence,content_signature,report,reason)
      VALUES (${fixture.executionId}::uuid,${original.sequence},${signature},${text}::jsonb,'isolated rejected report')`);
      const [distinct] = await fixture.db
        .execute(sql`SELECT body_source_sequence,report::text AS text
      FROM progressive_worker_report_conflicts WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=${original.sequence}`);
      expect(distinct.body_source_sequence).toBeNull();
      expect(distinct.text).toBe(text);
      const cloud = cloudFixture();
      expect(
        await archiveProgressiveReportBatch(
          fixture.db,
          "worker",
          fixture.executionId,
          cloud.putFile,
        ),
      ).toBe(fixture.reports.length + 1);
      const member = (await storedMembers(fixture)).find(
        (item) => item.memberKind === "conflict",
      )!;
      expect(member.reportSha256).toBe(archiveSha256(text));
      expect(
        await readProgressiveReportArchiveText(
          Readable.from([cloud.objects.get(member.objectKey)!]),
          member,
        ),
      ).toBe(text);
      const [stored] = await fixture.db
        .execute(sql`SELECT archived_at,archive_bundle_id,reason FROM progressive_worker_report_conflicts
      WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=${original.sequence}`);
      expect(stored.archived_at).not.toBeNull();
      expect(stored.archive_bundle_id).not.toBeNull();
      expect(stored.reason).toBe("isolated rejected report");
      await expectRoundtrip(fixture, cloud);
    });
  },
);

it.each([false, true])(
  "deduplicates byte-identical conflicts when source already archived=%s",
  async (archivedFirst) => {
    await withArchiveFixture(client, "worker", async (fixture) => {
      const original = fixture.reports[1]!;
      const cloud = cloudFixture();
      if (archivedFirst)
        expect(
          await archiveProgressiveReportBatch(
            fixture.db,
            "worker",
            fixture.executionId,
            cloud.putFile,
          ),
        ).toBe(fixture.reports.length);
      await fixture.db
        .execute(sql`INSERT INTO progressive_worker_report_conflicts
      (sim_job_id,sequence,content_signature,report,reason)
      VALUES (${fixture.executionId}::uuid,${original.sequence},${original.contentSignature},${original.text}::jsonb,
        'preserved exact conflict reason')`);
      const [linked] = await fixture.db
        .execute(sql`SELECT body_source_sequence,archive_bundle_id,archived_at,reason,
      report=progressive_report_compact_header(${original.text}::jsonb) AS compact
      FROM progressive_worker_report_conflicts WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=${original.sequence}`);
      expect(Number(linked.body_source_sequence)).toBe(original.sequence);
      expect(linked.compact).toBe(true);
      expect(linked.archive_bundle_id).toBeNull();
      expect(linked.archived_at).toBeNull();
      expect(linked.reason).toBe("preserved exact conflict reason");
      if (!archivedFirst) {
        const [online] = await fixture.db
          .execute(sql`SELECT public.resolve_progressive_report(report,result_payload_hash)::text AS text,
        member_kind FROM progressive_worker_conflict_storage
        WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=${original.sequence}`);
        expect(online.text).toBe(original.text);
        expect(online.member_kind).toBe("report");
      }
      expect(
        await archiveProgressiveReportBatch(
          fixture.db,
          "worker",
          fixture.executionId,
          cloud.putFile,
        ),
      ).toBe(archivedFirst ? 0 : fixture.reports.length);
      const members = await storedMembers(fixture);
      expect(
        members.filter((member) => member.memberKind === "conflict"),
      ).toEqual([]);
      expect(members).toHaveLength(fixture.reports.length);
      const [storage] = await fixture.db
        .execute(sql`SELECT c.member_kind,c.archive_bundle_id=w.archive_bundle_id AS same_bundle
      FROM progressive_worker_conflict_storage c JOIN progressive_worker_reports w USING (sim_job_id,sequence)
      WHERE c.sim_job_id=${fixture.executionId}::uuid AND c.sequence=${original.sequence}`);
      expect(storage).toMatchObject({
        member_kind: "report",
        same_bundle: true,
      });
      const before = await archiveSnapshot(fixture);
      for (const mutation of [
        sql`UPDATE progressive_worker_report_conflicts SET reason='changed reason' WHERE sim_job_id=${fixture.executionId}::uuid`,
        sql`UPDATE progressive_worker_report_conflicts SET body_source_sequence=NULL WHERE sim_job_id=${fixture.executionId}::uuid`,
      ])
        await expectSqlRefusal(
          fixture.db,
          (db) => db.execute(mutation),
          /immutable|identical report/i,
        );
      expect(await archiveSnapshot(fixture)).toEqual(before);
      await expectRoundtrip(fixture, cloud);
      expect(cloud.putFile).toHaveBeenCalledTimes(1);
    });
  },
);

it.each(["identical", "distinct"] as const)(
  "backfills an old %s conflict only after comparing exact bytes",
  async (legacyConflict) => {
    await withArchiveFixture(
      client,
      "worker",
      async (fixture) => {
        const original = fixture.reports[1]!;
        const [before] = await fixture.db
          .execute(sql`SELECT to_jsonb(c)::text AS row,report::text AS text,body_source_sequence
      FROM progressive_worker_report_conflicts c WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=${original.sequence}`);
        expect(before.body_source_sequence).toBeNull();
        const changed = await fixture.db
          .execute(sql`UPDATE progressive_worker_report_conflicts
      SET body_source_sequence=sequence WHERE sim_job_id=${fixture.executionId}::uuid RETURNING sequence`);
        expect(changed).toHaveLength(legacyConflict === "identical" ? 1 : 0);
        const [after] = await fixture.db
          .execute(sql`SELECT to_jsonb(c)::text AS row,body_source_sequence,reason,
      report=progressive_report_compact_header(${original.text}::jsonb) AS compact
      FROM progressive_worker_report_conflicts c WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=${original.sequence}`);
        expect(after.reason).toBe("retained legacy conflict reason");
        if (legacyConflict === "identical") {
          expect(Number(after.body_source_sequence)).toBe(original.sequence);
          expect(after.compact).toBe(true);
        } else {
          expect(after.row).toBe(before.row);
          expect(after.body_source_sequence).toBeNull();
        }
        const cloud = cloudFixture();
        expect(
          await archiveProgressiveReportBatch(
            fixture.db,
            "worker",
            fixture.executionId,
            cloud.putFile,
          ),
        ).toBe(
          fixture.reports.length + (legacyConflict === "distinct" ? 1 : 0),
        );
        const members = await storedMembers(fixture);
        expect(
          members.filter((member) => member.memberKind === "conflict"),
        ).toHaveLength(legacyConflict === "distinct" ? 1 : 0);
        if (legacyConflict === "distinct") {
          const member = members.find(
            (item) => item.memberKind === "conflict",
          )!;
          const restored = await readProgressiveReportArchiveText(
            Readable.from([cloud.objects.get(member.objectKey)!]),
            member,
          );
          expect(restored).toBe(before.text);
        }
        await expectRoundtrip(fixture, cloud);
      },
      { legacyConflict },
    );
  },
);

it("finds a warm hub execution beyond cold jobs and restores all members across two service passes", async () => {
  await withArchiveFixture(
    client,
    "remote",
    async (fixture) => {
      const { db, executionId } = fixture;
      // The generated UUIDv4 sorts after this private set of 96 cold owners.
      const prefix = executionId.slice(0, 14) + "0000-0000-";
      const cursor = prefix + "000000000000";
      await db.execute(
        sql`CREATE TEMP TABLE archive_discovery_jobs (id uuid PRIMARY KEY) ON COMMIT DROP`,
      );
      await db.execute(sql`INSERT INTO archive_discovery_jobs SELECT ${executionId}::uuid
        UNION ALL SELECT (${prefix} || lpad(to_hex(n),12,'0'))::uuid FROM generate_series(1,96) n`);
      await db.execute(sql`INSERT INTO sim_jobs (id,airfoil_id,bc_ids,reference_chord_m,status,"ingestedAt")
        SELECT scope.id,job.airfoil_id,job.bc_ids,job.reference_chord_m,'done',job."ingestedAt"
        FROM archive_discovery_jobs scope CROSS JOIN sim_jobs job
        WHERE job.id=${executionId}::uuid AND scope.id<>job.id`);
      // Scope only the service's job ownership to this rollback fixture.
      // The real report index, locking, payload references and archive triggers are exercised.
      await db.execute(sql`CREATE TEMP VIEW sim_jobs AS SELECT job.* FROM public.sim_jobs job
        WHERE job.id IN (SELECT id FROM archive_discovery_jobs)`);
      expect(
        (await nextProgressiveReportArchiveJob(db, "remote", cursor))?.id,
      ).toBe(executionId);

      const before = await archiveSnapshot(fixture);
      const cloud = cloudFixture();
      vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
      vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "disposable-report-archive");
      vi.spyOn(ProgressiveReportArchiveStore.prototype, "putFile")
        .mockImplementation(cloud.putFile);
      const controller = new AbortController();
      const batches: number[] = [];
      vi.spyOn(console, "info").mockImplementation((message) => {
        const batch = JSON.parse(String(message));
        expect(batch.executionId).toBe(executionId);
        batches.push(batch.members);
        if (batches.length === 2) controller.abort();
      });
      const errors = vi.spyOn(console, "error")
        .mockImplementation(() => controller.abort());
      await runProgressiveReportArchiveService(
        db,
        AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]),
      );
      expect(errors.mock.calls).toEqual([]);
      expect(batches).toEqual([128, 1]);
      expect(
        (await nextProgressiveReportArchiveJob(db, "remote", cursor))?.id,
      ).toBeNull();
      expect(
        await archiveProgressiveReportBatch(
          fixture.db,
          "remote",
          fixture.executionId,
          cloud.putFile,
        ),
      ).toBe(0);
      expect(cloud.putFile).toHaveBeenCalledTimes(2);
      await expectRoundtrip(fixture, cloud);
      const after = await archiveSnapshot(fixture);
      expect(after.results).toEqual(before.results);
      expect(after.result_attempts).toEqual(before.result_attempts);
    },
    { reportCount: 129, historyRepeats: 4 },
  );
}, 120_000);

it.runIf(process.env.WORKER_STAGING_KEYS_ACCEPTANCE === "1")(
  "one registered worker workload through tracking, storage and rollback",
  async () => {
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
    const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const evidenceDir = join(
      sourceRoot,
      ".codex-artifacts",
      "worker-staging-key-workload",
    );
    const runId = process.env.DEVCOORDINATOR_RUN_ID;
    if (!runId)
      throw new Error(
        "Run the staging-key workload through its governed graph",
      );
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim();
    const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim();
    const publish = async (content: Record<string, unknown>) => {
      await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
      const temporary = join(evidenceDir, runId + ".tmp");
      await writeFile(
        temporary,
        JSON.stringify(
          { runId, sourceCommit, sourceTree, ...content },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      await rename(temporary, join(evidenceDir, "workload-to-storage.json"));
    };
    await publish({ outcome: "running" });
    const workerDatabase = await createStagingFixtureWorker();
    const workerUrl = workerDatabase.url.toString();
    let worker = createClient({ url: workerUrl, max: 1 });
    let { db, sql: pg } = worker;
    let paired: Awaited<ReturnType<typeof cloneStagingFixtureHub>> | undefined;
    let verified: Record<string, unknown> | undefined;
    try {
      const [[settings], [migration]] = await Promise.all([
        pg`SELECT instance_id::text AS instance FROM public.sync_api_settings WHERE id=1`,
        pg`SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=1795363913049`,
      ]);
      const migrationBytes = await readFile(
        new URL(
          "../../../packages/db/migrations/0218_worker_report_staging_keys.sql",
          import.meta.url,
        ),
      );
      expect(migration?.hash).toBe(archiveSha256(migrationBytes));
      const instance = String(settings.instance);
      const operation = (
        action: Parameters<typeof maintainWorkerStagingKeys>[1],
      ) =>
        maintainWorkerStagingKeys(pg, action, {
          instance,
          readersRevision: "ab".repeat(20),
        });
      const force = {
        t: Array.from({ length: 400 }, (_, i) => i / 100),
        cl: Array.from({ length: 400 }, (_, i) => 0.19 + i / 40000),
        cd: Array.from({ length: 400 }, (_, i) => 0.012 + i / 400000),
        cm: Array.from({ length: 400 }, (_, i) => -0.073 - i / 400000),
      };
      expect(await operation("status")).toMatchObject({
        tracking_instance_id: null,
        reads_enabled: false,
      });
      let workload!: ArchiveFixture;
      await withArchiveFixture(
        worker,
        "worker",
        async (fixture) => {
          workload = { ...fixture, db };
        },
        {
          normalized: false,
          reportCount: 3,
          historyRepeats: 9000,
          stagingAcceptance: force,
        },
      );
      await worker.sql.end();
      paired = await cloneStagingFixtureHub(workload, workerDatabase.url);
      worker = createClient({ url: workerUrl, max: 1 });
      db = worker.db;
      pg = worker.sql;
      workload.db = db;
      const engine = {
        baseUrl: "http://staging-key-fixture.invalid",
      } as EngineClient;
      const job = workload.executionId;
      const historical = await stageProgressiveWorkerEvidence(db, engine, job, {
        reportSequence: 2,
      });
      expect(historical.kind).toBe("staged");
      const [identity] =
        await pg`SELECT promise.registered_solver_id::text AS solver FROM sync_sweep_promises promise
      WHERE promise.id=${workload.promiseId}::uuid`;
      const sourceRows =
        () => pg`SELECT sequence::int,created_at::text,stopped_engine_job_id FROM public.progressive_worker_reports
      WHERE sim_job_id=${job} AND acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object' ORDER BY sequence`;
      const reads =
        () => pg`SELECT sequence::int,created_at::text,stopped_engine_job_id FROM public.progressive_worker_staging_candidates
      WHERE sim_job_id=${job} ORDER BY sequence`;
      const keys =
        () => pg`SELECT sequence::int,created_at::text,stopped_engine_job_id FROM public.progressive_worker_staging_keys
      WHERE sim_job_id=${job} ORDER BY sequence`;
      const ack = (sequence: number, solverId = identity.solver) =>
        acknowledgeProgressiveWorkerReport(db, {
          executionId: job,
          solverId,
          sequence,
          contentSignature: workload.reports[sequence - 1]!.contentSignature,
        });
      expect(await keys()).toHaveLength(0);
      expect((await reads()).map((row) => row.sequence)).toEqual([2]);
      expect(await reads()).toEqual(await sourceRows());
      await expect(operation("start")).rejects.toThrow(
        /exact registered worker instance/,
      );
      expect(
        (
          await pg`SELECT count(*)::int n FROM public.progressive_worker_staging_key_backfill`
        )[0].n,
      ).toBe(0);
      await pg`UPDATE sync_api_settings SET remote_solver_enabled=true WHERE id=1`;

      const fixedRowCrossover = await measureExistingWorkerReport(
        pg,
        job,
        2,
        async (enabled) => {
          if (!enabled) {
            await operation("stop");
            return;
          }
          await operation("start");
          while (
            !(await backfillWorkerStagingKeyPage(pg, 1, instance)).complete
          ) {
            /* one page */
          }
        },
        () => ack(2),
      );
      const measurements = [
        await measureWorkerStagingWrites(
          pg,
          job,
          3,
          workload.reports[2]!.text,
          workload.reports[0]!.text,
          "inactive",
          "inline",
        ),
      ];
      expect(await backfillWorkerStagingKeyPage(pg, 1, instance)).toMatchObject(
        { visited: 1, changed: 1, complete: false },
      );
      await expect(operation("enable")).rejects.toThrow(
        /bootstrap is incomplete/,
      );
      expect(await backfillWorkerStagingKeyPage(pg, 1, instance)).toMatchObject(
        { visited: 0, complete: true },
      );
      expect(await operation("verify")).toEqual({ matched: 1 });
      const before = await reads();
      await operation("enable");
      expect(await reads()).toEqual(before);
      measurements.push(
        await measureWorkerStagingWrites(
          pg,
          job,
          3,
          workload.reports[2]!.text,
          workload.reports[0]!.text,
          "tracking",
          "inline",
        ),
      );
      await setProgressiveReportNormalization(db, {
        enabled: true,
        readersReady: true,
      });
      await backfillProgressiveReportPayloads(db, {
        table: "progressive_worker_reports",
        apply: true,
      });
      const [originalAfterNormalization] =
        await pg`SELECT result_payload_hash,public.resolve_progressive_report(to_jsonb(r.*))::text original
      FROM public.progressive_worker_reports r WHERE sim_job_id=${job} AND sequence=3`;
      expect(originalAfterNormalization.result_payload_hash).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(originalAfterNormalization.original).toBe(
        workload.reports[2]!.text,
      );
      measurements.push(
        await measureWorkerStagingWrites(
          pg,
          job,
          3,
          workload.reports[2]!.text,
          workload.reports[0]!.text,
          "tracking",
          "normalized",
        ),
      );
      await operation("disable");
      await operation("stop");
      measurements.push(
        await measureWorkerStagingWrites(
          pg,
          job,
          3,
          workload.reports[2]!.text,
          workload.reports[0]!.text,
          "inactive",
          "normalized",
        ),
      );
      await operation("start");
      while (!(await backfillWorkerStagingKeyPage(pg, 1, instance)).complete) {
        /* commit one page */
      }
      await operation("enable");
      if (process.env.DEVCOORDINATOR_DIAGNOSTICS_DIR)
        await writeFile(
          join(
            process.env.DEVCOORDINATOR_DIAGNOSTICS_DIR,
            "matched-reads-writes.json",
          ),
          JSON.stringify(measurements),
        );
      await expect(ack(3, randomUUID())).rejects.toThrow(/does not match/);
      expect(await reads()).toEqual(before);
      await ack(3);
      const native = await sourceRows();
      expect(native.map((k) => [k.sequence, k.stopped_engine_job_id])).toEqual([
        [2, null],
        [3, job],
      ]);
      expect(await reads()).toEqual(native);
      const [selected] = await db.execute(
        progressiveStagingSelectionSql(false),
      );
      expect(String(selected?.sim_job_id)).toBe(job);
      expect(Number(selected.sequence)).toBe(3);

      const [replayPlan] =
        await pg`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) UPDATE public.progressive_worker_reports
      SET acknowledged_at=coalesce(acknowledged_at,clock_timestamp()) WHERE sim_job_id=${job} AND sequence=3`;
      expect(
        replayPlan["QUERY PLAN"][0].Triggers.filter(
          (t: { "Trigger Name": string; Calls: number }) =>
            t["Trigger Name"].startsWith("progressive_worker_staging_key") &&
            t.Calls > 0,
        ),
      ).toEqual([]);
      await ack(3);
      await expect(pg`UPDATE public.progressive_worker_reports SET report=jsonb_set(report,'{result}','null'::jsonb)
      WHERE sim_job_id=${job} AND sequence=3`).rejects.toThrow(/immutable/);
      expect(await reads()).toEqual(native);

      // No engine rerun. Stage the actual signed last report of this workload.
      const staged = await stageProgressiveWorkerEvidence(db, engine, job, {
        reportSequence: 3,
      });
      expect(staged.kind).toBe("staged");
      const [bound] =
        await pg`SELECT s.result_attempt_id::text attempt,s.point_content_signature AS point,a.aoa_deg,
      a.regime,a.status,a.converged,a.valid_for_polar,a.cl,a.cd,a.cm,encode(sha256(convert_to(a.evidence_payload::text,'UTF8')),'hex') AS evidence_hash,a.evidence_payload->'force_history' AS history
      FROM progressive_worker_evidence_attempts s JOIN result_attempts a ON s.result_attempt_id=a.id
      WHERE s.sim_job_id=${job} AND s.sequence=3`;
      expect(bound).toMatchObject({
        status: "failed",
        converged: false,
        valid_for_polar: false,
        cl: force.cl.at(-1),
        cd: force.cd.at(-1),
        cm: force.cm.at(-1),
        history: force,
      });
      expect(
        (
          await pg`SELECT count(*)::int n FROM progressive_worker_hub_receipts WHERE sim_job_id=${job}`
        )[0].n,
      ).toBe(0);

      // Status-only bytes may leave first. Both reports containing the
      // scientific point stay inline until an independent hub actually retains it.
      const objects = cloudFixture();
      const temp = await mkdtemp(join(tmpdir(), "staging-key-verified-"));
      try {
        expect(
          await archiveProgressiveReportBatch(
            db,
            "worker",
            job,
            objects.putFile,
          ),
        ).toBe(1);
        const held =
          await pg`SELECT sequence::int FROM public.progressive_worker_reports WHERE sim_job_id=${job}
        AND archived_at IS NULL ORDER BY sequence`;
        expect(held.map((r) => r.sequence)).toEqual([2, 3]);
        const delivered = await deliverNextProgressiveWorkerEvidence(
          db,
          paired.send,
        );
        if (!delivered) {
          const [failure] =
            await pg`SELECT state,last_http_status,last_error FROM public.progressive_worker_delivery_failures
          WHERE sim_job_id=${job} AND point_content_signature=${bound.point}`;
          throw new Error(
            "Fixture delivery has no hub receipt: " +
              JSON.stringify({ requests: paired.requests, failure }),
          );
        }
        const [receipt] =
          await pg`SELECT sequence::int,receipt FROM progressive_worker_hub_receipts
        WHERE sim_job_id=${job} AND point_content_signature=${bound.point}`;
        const [hubReceipt] = await paired.hub
          .sql`SELECT s.sequence::int,s.remote_result_attempt_id::text AS worker,
        s.storage_only,a.id::text attempt,a.status,a.valid_for_polar,a.cl,a.cd,a.cm,encode(sha256(convert_to(a.evidence_payload::text,'UTF8')),'hex') AS evidence_hash,a.evidence_payload->'force_history' history
        FROM progressive_remote_evidence_receipts s JOIN result_attempts a ON a.id=s.result_attempt_id
        WHERE s.sim_job_id=${job} AND s.point_content_signature=${bound.point}`;
        expect(hubReceipt).toMatchObject({
          worker: bound.attempt,
          status: "failed",
          valid_for_polar: false,
          cl: bound.cl,
          cd: bound.cd,
          cm: bound.cm,
          history: bound.history,
          evidence_hash: bound.evidence_hash,
          storage_only: true,
        });
        expect(hubReceipt.attempt).not.toBe(bound.attempt);
        const [published] = await paired.hub
          .sql`SELECT status,result_attempt_id FROM public.sync_sweep_promise_points WHERE promise_id=${workload.promiseId} AND aoa_deg=0`;
        expect(published).toEqual({
          status: "cancelled",
          result_attempt_id: null,
        });

        const [hubTracking] = await paired.hub
          .sql`SELECT public.progressive_worker_staging_key_tracking_enabled() AS enabled,
        (SELECT count(*)::int FROM public.progressive_worker_staging_key_backfill) state_rows,
        (SELECT count(*)::int FROM public.progressive_worker_staging_keys) keys`;
        expect(hubTracking).toEqual({ enabled: false, state_rows: 0, keys: 0 });
        expect(receipt.receipt).toMatchObject({
          pointContentSignature: bound.point,
          resultAttemptId: hubReceipt.attempt,
          remoteResultAttemptId: bound.attempt,
          storageOnly: true,
          sequence: hubReceipt.sequence,
        });
        expect(
          paired.requests.some((r) => r.status === 200 && r.conflicts === 0),
        ).toBe(true);
        expect(
          await archiveProgressiveReportBatch(
            db,
            "worker",
            job,
            objects.putFile,
          ),
        ).toBe(2);
        const members = await storedMembers(workload);
        expect(members.map((m) => m.sequence)).toEqual([1, 2, 3]);
        for (const [key, bytes] of objects.objects)
          await writeFile(join(temp, archiveSha256(key)), bytes);
        objects.objects.clear();
        installProgressiveReportArchiveReader({
          async read(m) {
            const bytes = await readFile(
              join(temp, archiveSha256(m.objectKey)),
            );
            return readProgressiveReportArchiveText(Readable.from([bytes]), m);
          },
        });
        const member = members.find((m) => m.sequence === 2)!;
        const bytes = await readFile(
          join(temp, archiveSha256(member.objectKey)),
        );
        const original = workload.reports.find((r) => r.sequence === 2)!;
        expect(member.signature).toBe(original.contentSignature);
        expect(member.reportSha256).toBe(archiveSha256(original.text));
        expect(
          await readProgressiveReportArchiveText(
            Readable.from([bytes]),
            member,
          ),
        ).toBe(original.text);
        const restored = await readProgressiveReport(db, {
          sourceKind: "worker",
          executionId: job,
          sequence: 2,
          contentSignature: original.contentSignature,
        });
        expect(
          restored.result?.polars[0]?.attempts?.[0]?.force_history,
        ).toEqual(force);
        const corrupt = Buffer.from(bytes);
        corrupt[corrupt.length - 1]! ^= 1;
        await expect(
          readProgressiveReportArchiveText(Readable.from([corrupt]), member),
        ).rejects.toThrow();
        for (const m of members) {
          const source = workload.reports.find(
            (r) => r.sequence === m.sequence,
          )!;
          const raw = await readFile(join(temp, archiveSha256(m.objectKey)));
          expect(
            await readProgressiveReportArchiveText(Readable.from([raw]), m),
          ).toBe(source.text);
          expect(m.signature).toBe(source.contentSignature);
        }
        expect(await keys()).toEqual(native);
        expect(await operation("verify")).toEqual({ matched: 2 });
        await operation("retire");
        await operation("restore");
        await operation("disable");
        await operation("stop");
        expect(await reads()).toEqual(native);
        expect(await keys()).toEqual([]);
        expect(
          (
            await pg`SELECT count(*)::int n FROM public.progressive_worker_staging_key_backfill`
          )[0].n,
        ).toBe(0);
        const [after] =
          await pg`SELECT id::text,valid_for_polar,status,evidence_payload->'force_history' history
        FROM result_attempts WHERE id=${bound.attempt}::uuid`;
        expect(after).toEqual({
          id: bound.attempt,
          status: "failed",
          valid_for_polar: false,
          history: bound.history,
        });
        const afterRollback = await readProgressiveReport(db, {
          sourceKind: "worker",
          executionId: job,
          sequence: 2,
          contentSignature: original.contentSignature,
        });
        expect(
          afterRollback.result?.polars[0]?.attempts?.[0]?.force_history,
        ).toEqual(force);
        const proof = {
          hubTracking,
          job,
          sourceReport: original.contentSignature,
          originalPGSHA256: member.reportSha256,
          bytes: member.reportByteSize,
          pinnedGeneration: member.generation,
          archivedSequences: [1, 2, 3],
          heldBeforeDelivery: [2, 3],
          hubAttempt: hubReceipt.attempt,
          receiptSequence: hubReceipt.sequence,
          requests: paired.requests,
          attempt: bound.attempt,
          point: bound.point,
          workerEvidenceHash: bound.evidence_hash,
          hubEvidenceHash: hubReceipt.evidence_hash,
          historySamples: force.t.length,
          validForPolar: after.valid_for_polar,
          restored: true,
          fixedRowCrossover,
          measurements,
        };
        verified = proof;
        if (process.env.DEVCOORDINATOR_DIAGNOSTICS_DIR)
          await writeFile(
            join(
              process.env.DEVCOORDINATOR_DIAGNOSTICS_DIR,
              "workload-to-storage.json",
            ),
            JSON.stringify(proof, null, 2),
          );
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    } finally {
      try {
        await paired?.close();
      } finally {
        try {
          await worker.sql.end();
        } finally {
          await workerDatabase.close();
        }
      }
    }
    if (!verified) throw new Error("Missing verified workload receipt");
    await publish({ outcome: "passed", ...verified });
  },
  180000,
);

it("retires an unstaged native report through its independent hub generation and both registered volume readers", async () => {
  const { registeredWorkerRoundtrip } = await import("./registered-worker-report-fixture");
  await withArchiveFixture(client, "worker", registeredWorkerRoundtrip, { normalized: false, settled: false, reportCount: 7 });
});

it("crosses from the final warm report into cold conflict aliases using one verified original generation", async () => {
  const { readLegacyPage, legacyScopeHash, encodeLegacyPage } =
    await import("../src/legacy-report-storage");
  const { LegacyResultTransport } =
    await import("../src/legacy-report-result-transport");
  await withArchiveFixture(
    client,
    "worker",
    async (f) => {
      const { db, executionId: job } = f;
      await db.execute(sql`INSERT INTO progressive_worker_report_conflicts(sim_job_id,sequence,content_signature,report,reason)
      SELECT sim_job_id,sequence,content_signature,report,'original conflict '||sequence FROM progressive_worker_reports WHERE sim_job_id=${job}::uuid AND sequence IN (2,3)`);
      const query = async (q: string, max: number) => {
        // This fixture owns an outer rollback. Execute the generated read-only SELECT on that same connection.
        const body = q.match(
          /SET LOCAL timezone = 'UTC';\n([\s\S]+);\nCOMMIT;\n$/,
        )?.[1];
        if (!body || !/^(WITH|SELECT) /.test(body))
          throw new Error("Unexpected source query");
        const result = await db.execute(sql.raw(body));
        const raw = result.map((r) => String(Object.values(r)[0]));
        if (Buffer.byteLength(raw.join("\n")) > max)
          throw new Error("Unbounded fixture read");
        return raw.map((t) => JSON.parse(t) as Record<string, unknown>);
      };
      const transport = new LegacyResultTransport({ query });
      const source = {
        query,
        readMember: transport.readMember.bind(transport),
      };
      const scope = {
        version: 1 as const,
        sourceInstance: randomUUID(),
        solverId: JSON.parse(f.reports[0]!.text).solverId as string,
        measuredAt: new Date().toISOString(),
        executions: [
          {
            executionId: job,
            reports: 4,
            reportHighWater: 4,
            conflicts: 2,
            conflictHighWater: 3,
          },
        ],
      };
      const hash = legacyScopeHash(scope),
        original = await readLegacyPage(source, scope, undefined, 3);
      const bytes = encodeLegacyPage(original).bytes,
        sha = archiveSha256(bytes),
        objectKey = `legacy-worker-reports/v1/${scope.sourceInstance}/${scope.solverId}/${hash}/${sha}.jsonl.gz`;
      const crc = new Storage({
        projectId: "legacy-conflict-origin",
      }).crc32cGenerator();
      crc.update(bytes);
      const [bundle] =
        await db.execute(sql`INSERT INTO progressive_report_archive_bundles(source_kind,sim_job_id,bucket,object_key,generation,
      archive_format,stored_sha256,stored_byte_size,crc32c,member_count,first_sequence,last_sequence,verified_at,
      legacy_instance_id,legacy_solver_id,legacy_scope_sha256,legacy_page_member_count,legacy_read_mode)
      VALUES ('worker',${job}::uuid,'origin-test',${objectKey},'1795380355397132222','legacy-jsonl',${sha},${bytes.length},${crc.toString()},3,1,3,now(),
        ${scope.sourceInstance}::uuid,${scope.solverId}::uuid,${hash},3,'registered-get') RETURNING id`);
      for (const m of original.members) {
        await db.execute(sql`INSERT INTO progressive_report_archive_members(bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,
        report_sha256,report_byte_size,legacy_row_sha256,legacy_row_byte_size) VALUES(${bundle!.id}::uuid,'worker',${job}::uuid,${m.sequence},'report',
        ${m.contentSignature},${m.reportSha256},${m.reportByteSize},${m.rowSha256},${Buffer.byteLength(m.rowText)})`);
        await db.execute(sql`UPDATE progressive_worker_reports SET archived_at=now(),archive_bundle_id=${bundle!.id}::uuid,report=progressive_report_compact_header(report)
        WHERE sim_job_id=${job}::uuid AND sequence=${m.sequence}`);
      }
      const store = {
        read: vi.fn(async (o: { generation: string; objectKey: string }) => {
          expect(o.generation).toBe("1795380355397132222");
          expect(o.objectKey).toBe(objectKey);
          return bytes;
        }),
      };
      const start = {
        execution: 0,
        kind: "report" as const,
        after: 3,
        copied: 3,
      };
      const page = await readLegacyPage(
        source,
        scope,
        start,
        3,
        256 * 1024 ** 2,
        undefined,
        1,
        store,
      );
      expect(store.read).toHaveBeenCalledTimes(1);
      expect(page.members.map((m) => [m.kind, m.sequence])).toEqual([
        ["report", 4],
        ["conflict", 2],
        ["conflict", 3],
      ]);
      expect(page.next).toEqual({
        execution: 0,
        kind: "conflict",
        after: 3,
        copied: 2,
      });
      for (const m of page.members.slice(1)) {
        const [c] = await db.execute(
          sql`SELECT to_jsonb(c)::text AS body FROM progressive_worker_report_conflicts c WHERE sim_job_id=${job}::uuid AND sequence=${m.sequence}`,
        );
        expect(m.rowText).toBe(c!.body);
        expect(JSON.parse(m.rowText)).toMatchObject({
          reason: "original conflict " + m.sequence,
          body_source_sequence: m.sequence,
        });
        expect(m.reportText).toBe(f.reports[m.sequence - 1]!.text);
        expect(m.reportText).toContain(LARGE_REPORT_INTEGER);
      }
      const conflict = {
        execution: 0,
        kind: "conflict" as const,
        after: 0,
        copied: 0,
      };
      const cost =
        page.members[1]!.reportByteSize +
        Buffer.byteLength(page.members[1]!.rowText);
      store.read.mockClear();
      expect(
        (
          await readLegacyPage(
            source,
            scope,
            conflict,
            2,
            cost,
            undefined,
            1,
            store,
          )
        ).next,
      ).toEqual({ ...conflict, after: 2, copied: 1 });
      await expect(
        readLegacyPage(
          source,
          scope,
          conflict,
          2,
          cost - 1,
          undefined,
          1,
          store,
        ),
      ).rejects.toMatchObject({
        details: {
          category: "member_over_budget",
          member: { executionId: job, sequence: 2 },
        },
      });
      expect(store.read).toHaveBeenCalledTimes(1);
      await expect(
        readLegacyPage(
          source,
          scope,
          conflict,
          2,
          4 * 1024 ** 2,
          undefined,
          1,
          { read: async () => Buffer.from("corrupt") },
        ),
      ).rejects.toMatchObject({
        details: { operation: "conflict_origin", category: "origin_mismatch" },
        retryable: false,
      });
      const changed = {
        ...source,
        query: async (q: string, b: number) => {
          const rows = await query(q, b);
          return q.includes("'job',job,'sequence',sequence,'snapshot'")
            ? []
            : rows;
        },
      };
      await expect(
        readLegacyPage(
          changed,
          scope,
          conflict,
          2,
          4 * 1024 ** 2,
          undefined,
          1,
          store,
        ),
      ).rejects.toMatchObject({
        details: {
          category: "origin_mismatch",
          member: { executionId: job, sequence: 2 },
        },
      });
    },
    { reportCount: 4, normalized: false },
  );
});
