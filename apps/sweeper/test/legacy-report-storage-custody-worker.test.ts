import { Storage } from "@google-cloud/storage";
import { installProgressiveReportArchiveReader } from "@aerodb/db/progressive-report-reader";
import { createHash, randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "@aerodb/db/client";
import {
  legacyNormalizeSql,
  type LegacyReportMember,
} from "@aerodb/db/legacy-report-storage";
import {
  encodeLegacyPage,
  readLegacyPageMembers,
  type LegacyBackupPage,
} from "@aerodb/db/legacy-report-storage-codec";
import {
  legacyReportCustodySql,
  verifyLegacyReportCustodyPage,
} from "@aerodb/db/legacy-report-custody";
import {
  withArchiveFixture,
  archiveSha256,
  LARGE_REPORT_INTEGER,
} from "./progressive-report-archive-fixture";
import { legacyNormalizationTelemetry } from "../src/legacy-report-storage-migration";
import {
  applyLegacyCustodyWorkerTransaction,
  lockLegacyCustodyWorkerScope,
  legacyCustodyWorkerFailure,
  type LegacyWorkerSqlTransaction,
} from "../src/legacy-report-storage-custody-worker";
import { legacyOperatorWriteFailure } from "../src/legacy-report-storage-operator";

// Run in the migrated archive graph (schema + seed), not the empty-schema case.
// This is the production worker transaction with the real postgres-js driver,
// actual 0205 registration/compaction and rollback-owned fixture data.
const client = createClient({ max: 1 });
const blockerClient = createClient({ max: 1 }),
  retryClient = createClient({ max: 1 });
afterAll(async () => {
  await Promise.all([
    client.sql.end(),
    blockerClient.sql.end(),
    retryClient.sql.end(),
  ]);
});
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

it.each(["job", "settings"])(
  "releases the transaction after a real %s row contention and retries the same scope after its owner finishes",
  async (target) => {
    // This committed fixture owns only a disposable job, so another real
    // postgres-js connection can lock it. No campaign or solver work is launched.
    const id = randomUUID();
    const [airfoil] =
      await client.sql`SELECT id FROM public.airfoils ORDER BY id LIMIT 1`;
    if (!airfoil)
      throw new Error("The governed graph must seed its disposable catalog");
    await client.sql`INSERT INTO public.sim_jobs(id,airfoil_id,bc_ids,reference_chord_m,status)
    VALUES (${id},${airfoil.id},'[]'::jsonb,1,'failed')`;
    let release!: () => void,
      acquired!: () => void,
      acquireFailed!: (error: unknown) => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<void>((resolve, reject) => {
      acquired = resolve;
      acquireFailed = reject;
    });
    const owner = blockerClient.sql.begin(async (tx) => {
      if (target === "job")
        await tx`SELECT id FROM public.sim_jobs WHERE id=${id} FOR UPDATE`;
      else
        await tx`SELECT id FROM public.sync_api_settings WHERE id=1 FOR UPDATE`;
      acquired();
      await held;
    });
    // Observe early acquisition errors without leaving the contender suspended.
    void owner.catch(acquireFailed);
    try {
      await locked;
      let failure: unknown;
      try {
        await retryClient.sql.begin(async (tx) => {
          await lockLegacyCustodyWorkerScope(
            tx as unknown as LegacyWorkerSqlTransaction,
            [id],
          );
        });
      } catch (error) {
        failure = error;
      }
      const diagnostic = legacyCustodyWorkerFailure(failure);
      expect(diagnostic).toMatchObject({
        sqlState: "55P03",
        category: "database_lock_timeout",
        workerPhase: target === "job" ? "job_lock" : "settings_lock",
      });
      const wire = legacyOperatorWriteFailure(
        { code: 1 },
        "LEGACY_CUSTODY_FAILURE " + JSON.stringify(diagnostic),
        "worker_custody",
        true,
      );
      expect(wire).toMatchObject({
        retryable: true,
        details: { sqlState: "55P03" },
      });
      if (target === "job") {
        // The failed job acquisition has rolled back its earlier settings SHARE
        // lock; a telemetry writer can now take its normal update lock at once.
        await retryClient.sql.begin(async (tx) => {
          await tx`SELECT id FROM public.sync_api_settings WHERE id=1 FOR NO KEY UPDATE NOWAIT`;
        });
      }
      release();
      await owner;
      await retryClient.sql.begin(async (tx) => {
        await lockLegacyCustodyWorkerScope(
          tx as unknown as LegacyWorkerSqlTransaction,
          [id],
        );
      });
      const [unchanged] =
        await client.sql`SELECT status,request_payload FROM public.sim_jobs WHERE id=${id}`;
      expect(unchanged).toEqual({ status: "failed", request_payload: null });
    } finally {
      release();
      await owner;
      await client.sql`DELETE FROM public.sim_jobs WHERE id=${id}`;
    }
  },
  30_000,
);

it("takes no settings or job locks for an empty worker scope", async () => {
  let calls = 0;
  const tx = {
    unsafe: () => {
      calls++;
      throw new Error("Empty scope must be inert");
    },
  } as unknown as LegacyWorkerSqlTransaction;
  await lockLegacyCustodyWorkerScope(tx, []);
  expect(calls).toBe(0);
});

it.each([false, true])(
  "binds the real worker driver and distinguishes report/conflict retention on replay (mixed=%s)",
  async (mixed) => {
    await withArchiveFixture(
      client,
      "worker",
      async (fixture) => {
        const instanceId = randomUUID();
        const [owner] = await fixture.db.execute(
          sql`SELECT registered_solver_id::text AS solver_id FROM sync_sweep_promises WHERE id=${fixture.promiseId}::uuid`,
        );
        const solverId = String(owner.solver_id);
        await fixture.db
          .execute(sql`UPDATE sync_api_settings SET instance_id=${instanceId}::uuid,remote_solver_registered_id=${solverId}::uuid,
      upstream_base_url='https://legacy-worker-driver.invalid/api/sync/v1' WHERE id=1`);
        await fixture.db.execute(
          sql`UPDATE sync_sweep_promises SET source_base_url='https://legacy-worker-driver.invalid/api/sync/v1' WHERE id=${fixture.promiseId}::uuid`,
        );
        await fixture.db.execute(
          sql`UPDATE sim_jobs SET request_payload=request_payload||'{"upstreamBaseUrl":"https://legacy-worker-driver.invalid/api/sync/v1"}'::jsonb WHERE id=${fixture.executionId}::uuid`,
        );
        if (mixed) {
          // Keep the fixture's exact engine-issued final report (sequence 4) last.
          // Only its earlier sequence 3 becomes unstaged and inline for this page.
          await fixture.db.execute(
            sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=false WHERE id=1`,
          );
          await fixture.db.execute(
            sql`DELETE FROM public.progressive_worker_evidence_receipts WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=3`,
          );
          await fixture.db
            .execute(sql`UPDATE public.progressive_worker_reports r SET report=public.resolve_progressive_report(to_jsonb(r.*)),result_payload_hash=NULL
        WHERE sim_job_id=${fixture.executionId}::uuid AND sequence=3`);
          await fixture.db.execute(
            sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=true WHERE id=1`,
          );
        }
        const stored = await fixture.db
          .execute(sql`SELECT 'report' AS kind,r.sim_job_id::text AS id,r.sequence,r.content_signature,r.report->>'solverId' AS solver_id,
      to_jsonb(r.*)::text AS row_text,public.resolve_progressive_report(to_jsonb(r.*))::text AS report_text FROM progressive_worker_reports r
      WHERE sim_job_id=${fixture.executionId}::uuid
      UNION ALL SELECT 'conflict',c.sim_job_id::text,c.sequence,c.content_signature,c.report->>'solverId',to_jsonb(c.*)::text,
        public.resolve_progressive_report(v.report,v.result_payload_hash)::text FROM progressive_worker_report_conflicts c
        JOIN progressive_worker_conflict_storage v USING(sim_job_id,sequence,content_signature) WHERE c.sim_job_id=${fixture.executionId}::uuid ORDER BY sequence,kind DESC`);
        const members: LegacyReportMember[] = stored.map((row) => ({
          kind: row.kind as "report" | "conflict",
          executionId: String(row.id),
          sequence: Number(row.sequence),
          contentSignature: String(row.content_signature),
          solverId: String(row.solver_id),
          rowText: String(row.row_text),
          rowSha256: digest(String(row.row_text)),
          reportText: String(row.report_text),
          reportSha256: digest(String(row.report_text)),
          reportByteSize: Buffer.byteLength(String(row.report_text)),
        }));
        const page: LegacyBackupPage = {
          version: 1,
          sourceInstance: instanceId,
          solverId,
          scopeSha256: digest(fixture.executionId),
          members,
          start: { execution: 0, kind: "report", after: 0, copied: 0 },
          next: { execution: 1, kind: "report", after: 0, copied: 0 },
        };
        const packed = encodeLegacyPage(page).bytes;
        const object = {
          bucket: "legacy-worker-driver",
          objectKey: "",
          generation: "18446744073709551615",
          sha256: digest(packed),
          byteSize: packed.length,
          crc32c: "AAAAAA==",
          verifiedAt: new Date().toISOString(),
        };
        object.objectKey = `legacy-worker-reports/v1/${instanceId}/${solverId}/${page.scopeSha256}/${object.sha256}.jsonl.gz`;
        const proof = await verifyLegacyReportCustodyPage({
          page,
          object,
          access: {
            mode: "hub-local-reader",
            readHubObject: async () => packed,
            reader: {
              readPage: async () => ({
                storedBytes: packed,
                storageKey: `report-archives/v1/${object.sha256.slice(0, 2)}/${object.sha256}.jsonl.gz`,
                durableAt: new Date().toISOString(),
              }),
            },
          },
        });
        // Drizzle's fixture already owns the transaction. Its session client is the
        // real transaction-bound postgres-js callable, not a SQL/parameter double.
        const native = (
          fixture.db as unknown as {
            session: { client: LegacyWorkerSqlTransaction };
          }
        ).session.client;
        const input = {
          page,
          object,
          proof,
          custody: { legacyReportCustodySql },
          normalization: { legacyNormalizeSql },
          codec: { readLegacyPageMembers },
          productBytes: packed,
          verifiedMembers: members.map((member) => ({ ...member })),
        };
        const applied = await applyLegacyCustodyWorkerTransaction(
          native,
          input,
        );
        expect(applied).toMatchObject({
          verifiedReports: mixed ? 4 : 3,
          newlyNormalizedReports: mixed ? 1 : 0,
          normalizedReports: mixed ? 1 : 0,
          sourceDatabaseWrites: true,
          archiveMembersReleased: 4,
          replayMembersVerified: mixed ? 5 : 4,
          remainingWarmReports: mixed ? 1 : 0,
        });
        expect(
          legacyNormalizationTelemetry(
            { ...applied, rowProofs: [] },
            members.length,
          ),
        ).toMatchObject({
          sourceReportBodiesRetained: mixed ? 1 : 0,
          archiveMembersReleased: 4,
          reportRowsVerified: mixed ? 4 : 3,
        });
        const replay = await applyLegacyCustodyWorkerTransaction(native, input);
        expect(replay).toMatchObject({
          verifiedReports: mixed ? 4 : 3,
          newlyNormalizedReports: 0,
          normalizedReports: mixed ? 1 : 0,
          sourceDatabaseWrites: false,
          archiveMembersReleased: 0,
          replayMembersVerified: mixed ? 5 : 4,
          remainingWarmReports: mixed ? 1 : 0,
        });
        expect(
          legacyNormalizationTelemetry(
            { ...replay, rowProofs: [] },
            members.length,
          ),
        ).toMatchObject({
          sourceReportBodiesRetained: mixed ? 1 : 0,
          archiveMembersReleased: 0,
          sourceDatabaseWrites: false,
        });
        const [rows] = await fixture.db.execute(
          sql`SELECT count(*)::integer AS n FROM progressive_worker_reports WHERE sim_job_id=${fixture.executionId}::uuid AND archived_at IS NOT NULL`,
        );
        expect(rows.n).toBe(3);
      },
      { legacyConflict: "distinct", reportCount: mixed ? 4 : 3 },
    );
  },
  120000,
);

// Both round trips hold the normalization singleton for the rollback fixture.
// This case owns a migrated database apart from the parallel sync and reader suites.
describe.sequential(
  "native report custody, durable storage and normal readers",
  { timeout: 60_000 },
  () => {
    beforeAll(() =>
      expect(process.env.PROGRESSIVE_REPORT_ARCHIVE_DISPOSABLE_DB).toBe("1"),
    );
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      installProgressiveReportArchiveReader(null);
    });
    it.each([false, true])("retires an unstaged native report through its independent hub generation and both registered volume readers, later acknowledgement=%s", async (later) => {
      const { registeredWorkerRoundtrip } =
        await import("./registered-worker-report-fixture");
      await withArchiveFixture(client, "worker", f => registeredWorkerRoundtrip(f, later), {
        normalized: false,
        settled: false,
        reportCount: later ? 8 : 7,
      });
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
            read: vi.fn(
              async (o: { generation: string; objectKey: string }) => {
                expect(o.generation).toBe("1795380355397132222");
                expect(o.objectKey).toBe(objectKey);
                return bytes;
              },
            ),
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
            details: {
              operation: "conflict_origin",
              category: "origin_mismatch",
            },
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
  },
);

it("retries one confirmed registration timeout at the same pin and holds a real administrative cancel", async () => {
  const { withLegacyCustodyRollback, measureLegacyCustodyRegistration } =
    await import("../src/legacy-report-storage-custody-worker");
  const { applyPinnedCustodyWithRetry } =
    await import("../src/legacy-report-storage-custody");
  const receipt = {
    object: {
      bucket: "test-archive",
      objectKey: "test",
      generation: "1795452221132176",
      sha256: "a".repeat(64),
      crc32c: "AAAAAA==",
      byteSize: 1,
      verifiedAt: new Date().toISOString(),
    },
  };
  await retryClient.sql`CREATE TEMP TABLE custody_cancel_journal (id integer PRIMARY KEY)`;
  const [backend] = await retryClient.sql`SELECT pg_backend_pid() AS pid`;
  try {
    for (const mode of ["once", "twice", "admin"] as const) {
      let attempts = 0;
      const applied = applyPinnedCustodyWithRetry(receipt, async () => {
        expect(
          (await retryClient.sql`SELECT FROM custody_cancel_journal`).length,
        ).toBe(0);
        attempts++;
        try {
          await withLegacyCustodyRollback<void>(
            (fn) =>
              retryClient.sql.begin((tx) =>
                fn(tx as unknown as LegacyWorkerSqlTransaction),
              ),
            async (tx) => {
              await tx.unsafe("INSERT INTO custody_cancel_journal VALUES(1)");
              if (mode === "once" && attempts === 2) return;
              await tx.unsafe(
                mode === "admin"
                  ? "SET LOCAL statement_timeout='5s'"
                  : "SET LOCAL statement_timeout='60ms'",
              );
              await measureLegacyCustodyRegistration(() =>
                tx
                  .unsafe("SELECT pg_sleep(8) /* custody_cancel_fixture */")
                  .simple(),
              );
            },
          );
        } catch (error) {
          const diagnostic = legacyCustodyWorkerFailure(error);
          expect(diagnostic).toMatchObject({
            sqlState: "57014",
            workerPhase: "custody_registration",
            transactionRolledBack: true,
            category:
              mode === "admin"
                ? "database_user_cancelled"
                : "database_statement_timeout",
            cancellation:
              mode === "admin" ? "user_request" : "statement_timeout",
          });
          expect(diagnostic.registrationElapsedMs).toBeGreaterThan(0);
          expect(JSON.stringify(diagnostic)).not.toContain("pg_sleep");
          throw legacyOperatorWriteFailure(
            { code: 1 },
            "LEGACY_CUSTODY_FAILURE " + JSON.stringify(diagnostic),
            "worker_custody",
            true,
          );
        }
        return { verifiedReports: 1, normalizedReports: 0, rowProofs: [] };
      });
      const observed = applied.catch((e) => e);
      if (mode === "admin") {
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i++) {
          const [row] =
            await blockerClient.sql`SELECT wait_event FROM pg_stat_activity WHERE pid=${backend.pid}`;
          waiting = row?.wait_event === "PgSleep";
          if (!waiting) await new Promise((r) => setTimeout(r, 10));
        }
        expect(waiting).toBe(true);
        expect(
          (
            await blockerClient.sql`SELECT pg_cancel_backend(${backend.pid}) AS stopped`
          )[0].stopped,
        ).toBe(true);
      }
      const result = await observed;
      if (mode === "once")
        expect(result).toMatchObject({
          custody: {
            registrationTimeoutRetries: 1,
            retriedGeneration: receipt.object.generation,
          },
        });
      else
        expect(result).toMatchObject({
          retryable: false,
          details: {
            category:
              mode === "admin"
                ? "database_user_cancelled"
                : "database_statement_timeout",
            transactionRolledBack: true,
          },
        });
      expect(attempts).toBe(mode === "admin" ? 1 : 2);
      expect(
        await retryClient.sql`SELECT FROM custody_cancel_journal`,
      ).toHaveLength(mode === "once" ? 1 : 0);
      await retryClient.sql`DELETE FROM custody_cancel_journal`;
    }
  } finally {
    await retryClient.sql`DROP TABLE custody_cancel_journal`;
  }
});
