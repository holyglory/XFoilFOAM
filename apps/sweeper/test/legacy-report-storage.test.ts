import * as legacyCodec from "@aerodb/db/legacy-report-storage-codec";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@aerodb/db/client";
import {
  legacyInventorySql,
  legacyMemberSql,
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
import {
  LegacyPeerOccupied,
  openLegacyPeerBudget,
} from "../src/legacy-report-peer-memory";
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
async function fixture(
  conflicts = true,
  solverId: string = randomUUID(),
): Promise<LegacyReportScope> {
  await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=false`;
  const executionId = randomUUID();
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
function signal() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}
function observeMember(
  after: (sequence: number) => void | Promise<void>,
): LegacySqlReader {
  return {
    ...source,
    async readMember(executionId, kind, sequence, bytes) {
      const member = await source.query(
        legacyMemberSql(executionId, kind, sequence, bytes),
        bytes * 6 + 1024 ** 2,
      );
      await after(sequence);
      return member;
    },
  };
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
  it.each(["front", "peer"] as const)(
    "recovers a lost %s commit at the original generation across slot and page limits",
    async (failed) => {
      const a = await fixture(),
        b = await fixture(true, a.solverId);
      const scope = {
        ...a,
        executions: [...a.executions, ...b.executions].sort((x, y) =>
          x.executionId.localeCompare(y.executionId),
        ),
      };
      const store = new MemoryBackup(),
        path = await directory(),
        seen = new Map<string, string>();
      // Read and preserve an ordinary serial prefix before opening a pair.
      const base = {
        scope,
        source,
        store,
        directory: path,
        sourceBinding: "native-owner-job-pair",
        rows: 2,
      };
      const expected = await Promise.all(
        scope.executions.map((x) => logical(x.executionId)),
      );
      await client.sql`UPDATE public.progressive_report_storage_policy SET normalization_enabled=true`;
      const completed = new Set<string>();
      let lose = true;
      const normalizer: LegacyPageNormalizer = {
        binding: "exact-db",
        async apply(page) {
          if (page.members.length)
            await execute(
              legacyNormalizeSql(page.members, {
                apply: true,
                readersReady: true,
              }),
            );
          const reports = page.members.filter(
            (m) => m.kind === "report",
          ).length;
          return {
            verifiedReports: reports,
            normalizedReports: reports,
            transactionCommitted: true,
            remainingWarmReports: reports,
            archiveMembersReleased: 0,
            rowProofs: [],
          };
        },
      };
      const good = signal();
      let inPair = false;
      const apply: NonNullable<
        Parameters<typeof exportLegacyReports>[0]["applyVerifiedPage"]
      > = async (page, receipt, receiptFile, packed, dir) => {
        const key = JSON.stringify(page.start),
          pin =
            receipt.object.sha256 +
            "/" +
            receipt.object.generation +
            "/" +
            receiptFile;
        expect(seen.get(key) ?? pin).toBe(pin);
        seen.set(key, pin);
        expect(packed.equals(await store.read(receipt.object))).toBe(true);
        if (
          inPair &&
          page.start.execution === (failed === "front" ? 0 : 1) &&
          lose
        )
          await good.reached;
        const proof = await applyVerifiedLegacyPage({
          page,
          receipt,
          receiptFile,
          directory: dir,
          normalizer,
        });
        completed.add(pin);
        if (
          inPair &&
          page.start.execution === (failed === "front" ? 0 : 1) &&
          lose
        ) {
          lose = false;
          throw new Error("successful SQL reply lost");
        }
        if (inPair) good.release();
        return legacyNormalizationTelemetry(proof, page.members.length);
      };
      const options = {
        slots: 2 as const,
        targetBinding: normalizer.binding,
        peerSource: source,
        openBudget: async () => ({
          admit: true,
          finish: async () => ({
            minAvailableMiB: 12000,
            peakWorkerRssMiB: 2500,
            peakControllerRssMiB: 1500,
            permitted: true,
          }),
        }),
      };
      const first = await exportLegacyReports({
        ...base,
        applyVerifiedPage: apply,
        pages: 1,
      });
      inPair = true;
      await expect(
        exportLegacyReports({
          ...base,
          applyVerifiedPage: apply,
          pages: 2,
          maxBytes: 128 * 1024 ** 2,
          executionSupervisor: options,
        }),
      ).rejects.toThrow(/reply lost/);
      const raw = JSON.parse(
        await readFile(join(path, "checkpoint.json"), "utf8"),
      );
      expect(raw.next.execution).toBe(0);
      if (failed === "front") expect(raw.next).toEqual(first.next);
      const entries = await readdir(join(path, "pending.jsonl.gz"));
      expect(entries.some((n) => n.startsWith("page-"))).toBe(true);
      await expect(exportLegacyReports({ ...base, pages: 1 })).rejects.toThrow(
        /supervisor/,
      );
      await expect(
        exportLegacyReports({
          ...base,
          pages: 2,
          applyVerifiedPage: apply,
          executionSupervisor: { ...options, targetBinding: "wrong-worker" },
        }),
      ).rejects.toThrow(/journal/);
      const publicReceipts = () =>
        readdir(path).then((ns) =>
          ns.filter((n) => n.endsWith(".receipt.json")),
        );
      for (const name of await publicReceipts())
        expect(
          JSON.parse(await readFile(join(path, name), "utf8")).start.execution,
        ).toBe(0);
      const puts = vi.spyOn(store, "put");
      let last;
      // A restart at 256 MiB and one slot first consumes exactly the old 128 MiB work.
      for (let i = 0; i < 16; i++) {
        last = await exportLegacyReports({
          ...base,
          pages: 2,
          maxBytes: 256 * 1024 ** 2,
          applyVerifiedPage: apply,
          executionSupervisor: { ...options, slots: 1 },
        });
        if (last.complete) break;
      }
      expect(last?.complete).toBe(true);
      expect(new Set(puts.mock.calls.map((x) => x[0])).size).toBe(
        puts.mock.calls.length,
      );
      await expect(
        readdir(join(path, "pending.jsonl.gz")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        await Promise.all(scope.executions.map((x) => logical(x.executionId))),
      ).toEqual(expected);
      const all = await publicReceipts();
      const receipts = await Promise.all(
        all.map(async (name) => ({
          name,
          r: JSON.parse(
            await readFile(join(path, name), "utf8"),
          ) as LegacyBackupReceipt,
        })),
      );
      let cursor = {
        execution: 0,
        kind: "report" as const,
        after: 0,
        copied: 0,
      } as legacyCodec.LegacyCursor;
      const members = new Set<string>();
      for (let i = 0; i < receipts.length; i++) {
        const match = receipts.filter((x) =>
          legacyCodec.sameLegacyCursor(x.r.start, cursor),
        );
        expect(match).toHaveLength(1);
        const { r, name } = match[0],
          page = decodeLegacyPage(await store.read(r.object), r);
        expect(r.scopeSha256).toBe(legacySha256(JSON.stringify(scope)));
        expect(
          completed.has(
            r.object.sha256 + "/" + r.object.generation + "/" + name,
          ),
        ).toBe(true);
        const marker = JSON.parse(
          await readFile(join(path, name + ".normalized.json"), "utf8"),
        );
        expect(marker.archiveReceiptSha256).toBe(name.split(".")[0]);
        for (const m of page.members) {
          const key = m.executionId + "/" + m.kind + "/" + m.sequence;
          expect(members.has(key)).toBe(false);
          members.add(key);
        }
        cursor = r.next;
      }
      expect(members.size).toBe(12);
      expect(cursor).toEqual(last!.next);
      expect((await exportLegacyReports({ ...base })).complete).toBe(true);
    },
    60000,
  );

  it("keeps a finished peer private across long execution pages and stops pairing at measured memory pressure", async () => {
    const first = await fixture(false),
      second = await fixture(false, first.solverId);
    const scope = {
      ...first,
      executions: [...first.executions, ...second.executions].sort((a, b) =>
        a.executionId.localeCompare(b.executionId),
      ),
    };
    const [long, short] = scope.executions;
    await client.sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report)
      SELECT ${long.executionId}::uuid,n,encode(sha256(int4send(n)),'hex'),
        jsonb_build_object('version',1,'sequence',n,'solverId',${scope.solverId}::text,'executionId',${long.executionId}::text,'result',jsonb_build_object('step',n))
      FROM generate_series(11,1126) n`;
    long.reports += 1116;
    long.reportHighWater = 1126;
    const store = new MemoryBackup(),
      path = await directory(),
      peerFinished = signal(),
      allowFront = signal();
    const inputs = {
      source,
      store,
      scope,
      directory: path,
      sourceBinding: "long-tail",
      pages: 2,
      rows: 128,
      maxBytes: 128 * 1024 ** 2,
    };
    let checks = 0,
      firstFront = true;
    const options = {
      slots: 2 as const,
      targetBinding: "physical-test",
      peerSource: source,
      openBudget: async () => {
        checks++;
        return {
          admit: true,
          finish: async () => ({
            minAvailableMiB: 6200,
            peakWorkerRssMiB: 4200,
            peakControllerRssMiB: 900,
            permitted: false,
          }),
        };
      },
    };
    const applied = new Map<string, number>();
    const apply: NonNullable<
      Parameters<typeof exportLegacyReports>[0]["applyVerifiedPage"]
    > = async (page, receipt) => {
      expect(
        page.members.every(
          (m) =>
            m.executionId ===
            scope.executions[page.start.execution].executionId,
        ),
      ).toBe(true);
      if (page.start.execution === 0 && firstFront) {
        firstFront = false;
        await allowFront.reached;
      }
      expect(
        decodeLegacyPage(await store.read(receipt.object), receipt).members,
      ).toEqual(page.members);
      for (const m of page.members)
        applied.set(m.executionId, (applied.get(m.executionId) ?? 0) + 1);
      if (page.start.execution === 1) peerFinished.release();
    };
    const pair = exportLegacyReports({
      ...inputs,
      executionSupervisor: options,
      applyVerifiedPage: apply,
    });
    try {
      await peerFinished.reached;
      const checkpoint = JSON.parse(
        await readFile(join(path, "checkpoint.json"), "utf8"),
      );
      expect(checkpoint.next.after).toBe(0);
      expect(
        (await readdir(path)).filter((n) => n.endsWith(".receipt.json")),
      ).toHaveLength(0);
      await expect(exportLegacyReports(inputs)).rejects.toThrow(
        /holds this backup directory/,
      );
    } finally {
      allowFront.release();
    }
    const res = await pair;
    expect(res.executionSupervisor).toMatchObject({
      maxActive: 2,
      published: 1,
      appliedAhead: 1,
    });
    const hold = JSON.parse(
      await readFile(join(path, "execution-peer-memory-hold.json"), "utf8"),
    );
    expect(hold.memory.peakWorkerRssMiB).toBe(4200);
    const reopened = await exportLegacyReports({
      ...inputs,
      pages: 2,
      maxBytes: 256 * 1024 ** 2,
      executionSupervisor: options,
      applyVerifiedPage: apply,
    });
    expect(reopened.next.execution).toBe(0);
    const done = await exportLegacyReports({
      ...inputs,
      pages: 32,
      executionSupervisor: options,
      applyVerifiedPage: apply,
    });
    expect(done.complete).toBe(true);
    expect(checks).toBe(1);
    expect(applied.get(long.executionId)).toBe(long.reports);
    expect(applied.get(short.executionId)).toBe(short.reports);
    expect(
      (await readdir(path)).filter((n) => n.endsWith(".receipt.json")).length,
    ).toBeGreaterThan(8);
  }, 90000);

  it("holds a corrupted ahead receipt and resumes only from its authentic bytes", async () => {
    const a = await fixture(false),
      b = await fixture(false, a.solverId);
    const scope = {
      ...a,
      executions: [...a.executions, ...b.executions].sort((x, y) =>
        x.executionId.localeCompare(y.executionId),
      ),
    };
    const path = await directory(),
      store = new MemoryBackup();
    const apply = async () => undefined;
    const options = {
      slots: 2 as const,
      targetBinding: "strict-proof",
      peerSource: source,
      openBudget: async () => ({
        admit: true,
        finish: async () => ({
          minAvailableMiB: 12000,
          peakWorkerRssMiB: 500,
          peakControllerRssMiB: 500,
          permitted: true,
        }),
      }),
    };
    const base = {
      scope,
      source,
      store,
      directory: path,
      sourceBinding: "corrupt-peer",
      rows: 2,
      pages: 2,
      executionSupervisor: options,
      applyVerifiedPage: apply,
    };
    const first = await exportLegacyReports(base);
    expect(first.executionSupervisor?.appliedAhead).toBe(1);
    const stage = join(path, "pending.jsonl.gz", "page-1-report-0-0");
    const ready = JSON.parse(await readFile(join(stage, "ready.json"), "utf8")),
      f = join(stage, ready.receipt);
    const original = await readFile(f);
    await writeFile(f, Buffer.concat([original, Buffer.from(" ")]));
    const single = {
      ...base,
      pages: 32,
      executionSupervisor: { ...options, slots: 1 as const },
    };
    await expect(exportLegacyReports(single)).rejects.toThrow(
      /journal or coverage/,
    );
    const checkpoint = JSON.parse(
      await readFile(join(path, "checkpoint.json"), "utf8"),
    );
    expect(checkpoint.next).toEqual({
      execution: 1,
      kind: "report",
      after: 0,
      copied: 0,
    });
    expect((await readFile(f)).length).toBe(original.length + 1);
    await writeFile(f, original);
    let done = await exportLegacyReports(single);
    if (!done.complete) done = await exportLegacyReports(single);
    expect(done.complete).toBe(true);
  }, 60000);

  it("does not overlap an uncertain 256 MiB page when restarted with a 128 MiB peer", async () => {
    const a = await fixture(false),
      b = await fixture(false, a.solverId);
    const scope = {
      ...a,
      executions: [...a.executions, ...b.executions].sort((x, y) =>
        x.executionId.localeCompare(y.executionId),
      ),
    };
    const path = await directory(),
      store = new MemoryBackup();
    let budgetOpens = 0;
    const slots = {
      slots: 2 as const,
      targetBinding: "memory-recovery",
      peerSource: source,
      openBudget: async () => {
        budgetOpens++;
        return {
          admit: true,
          finish: async () => ({
            minAvailableMiB: 20000,
            peakWorkerRssMiB: 900,
            peakControllerRssMiB: 500,
            permitted: true,
          }),
        };
      },
    };
    const base = {
      scope,
      source,
      store,
      directory: path,
      sourceBinding: "mixed-cap",
      rows: 1,
      pages: 2,
      maxBytes: 128 * 1024 ** 2,
      executionSupervisor: slots,
      applyVerifiedPage: async () => undefined,
    };
    await exportLegacyReports(base);
    const firstCursor = JSON.parse(
      await readFile(join(path, "checkpoint.json"), "utf8"),
    ).next;
    await expect(
      exportLegacyReports({
        ...base,
        pages: 1,
        maxBytes: 256 * 1024 ** 2,
        applyVerifiedPage: async () => {
          throw Error("uncertain wide reply");
        },
      }),
    ).rejects.toThrow(/uncertain wide/);
    const file = join(
      path,
      "pending.jsonl.gz",
      `page-0-report-${firstCursor.after}-${firstCursor.copied}`,
      "budget.json",
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toBe(256 * 1024 ** 2);
    const recovered = await exportLegacyReports({ ...base, pages: 2 });
    expect(recovered.executionSupervisor?.maxActive).toBe(1);
    expect(budgetOpens).toBe(1);
    let done = await exportLegacyReports({ ...base, pages: 32 });
    if (!done.complete)
      done = await exportLegacyReports({ ...base, pages: 32 });
    expect(done.complete).toBe(true);
    expect(budgetOpens).toBeGreaterThan(1);
  }, 60000);

  it("pairs two long executions across a short intervening job and joins the exact complete prefix", async () => {
    const a = await fixture(false),
      b = await fixture(false, a.solverId),
      c = await fixture(false, a.solverId);
    const scope = {
      ...a,
      executions: [...a.executions, ...b.executions, ...c.executions].sort(
        (x, y) => x.executionId.localeCompare(y.executionId),
      ),
    };
    for (const [i, extra] of [
      [0, 1116],
      [2, 1101],
    ] as const) {
      const e = scope.executions[i];
      await client.sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report)
        SELECT ${e.executionId}::uuid,n,encode(sha256(int4send(n)),'hex'),jsonb_build_object('version',1,'executionId',${e.executionId}::text,'solverId',${scope.solverId}::text,'sequence',n,'result',jsonb_build_object('step',n)) FROM generate_series(11,${10 + extra}::int) n`;
      e.reports += extra;
      e.reportHighWater += extra;
    }
    const path = await directory(),
      store = new MemoryBackup();
    const ids = scope.executions.map((x) => x.executionId);
    const firstBudgets = new Map<string, number>();
    const watched: LegacySqlReader = {
      ...source,
      async readMember(id, kind, seq, cap) {
        if (!firstBudgets.has(id)) firstBudgets.set(id, cap);
        return source.query(
          legacyMemberSql(id, kind, seq, cap),
          cap * 6 + 1024 ** 2,
        );
      },
    };
    const options = {
      slots: 2 as const,
      targetBinding: "long-two",
      peerSource: watched,
      openBudget: async () => ({
        admit: true,
        finish: async () => ({
          minAvailableMiB: 12000,
          peakWorkerRssMiB: 500,
          peakControllerRssMiB: 500,
          permitted: true,
        }),
      }),
    };
    const specs = {
      scope,
      source: watched,
      store,
      directory: path,
      sourceBinding: "multi-long",
      executionSupervisor: options,
      rows: 128,
      pages: 4,
      maxBytes: 256 * 1024 ** 2,
      applyVerifiedPage: async () => undefined,
    };
    const initial = await exportLegacyReports(specs);
    expect(initial.next).toMatchObject({ execution: 0, copied: 256 });
    expect(initial.executionSupervisor?.peerNext).toMatchObject({
      execution: 2,
      copied: 256,
    });
    expect(initial.executionSupervisor?.pairedExecutions).toEqual([
      [ids[0], ids[2]],
      [ids[0], ids[2]],
    ]);
    let next = initial.next;
    const names = [...initial.receipts];
    for (
      let pass = 0;
      pass < 16 && next.execution < scope.executions.length;
      pass++
    ) {
      const run = await exportLegacyReports({
        ...specs,
        maxBytes: 256 * 1024 ** 2,
        pages: 4,
        executionSupervisor: { ...options, slots: 1 },
      });
      next = run.next;
      names.push(...run.receipts);
    }
    expect(next.execution).toBe(3);
    let start = {
      execution: 0,
      kind: "report",
      after: 0,
      copied: 0,
    } as legacyCodec.LegacyCursor;
    const memberKeys = new Set<string>();
    for (const name of names) {
      const bytes = await readFile(join(path, name));
      expect(legacySha256(bytes)).toBe(name.split(".")[0]);
      const r = JSON.parse(bytes.toString()) as LegacyBackupReceipt;
      expect(r.start).toEqual(start);
      const page = decodeLegacyPage(await store.read(r.object), r);
      for (const v of page.members) {
        const k = v.executionId + "/" + v.sequence;
        expect(memberKeys.has(k)).toBe(false);
        memberKeys.add(k);
      }
      start = r.next;
    }
    expect(firstBudgets.get(ids[0])).toBe(128 * 1024 ** 2);
    expect(firstBudgets.get(ids[2])).toBe(128 * 1024 ** 2);
    expect(firstBudgets.get(ids[1])).toBe(256 * 1024 ** 2);
    expect(start).toEqual(next);
    expect(memberKeys.size).toBe(
      scope.executions.reduce((n, e) => n + e.reports, 0),
    );
    await expect(readdir(join(path, "pending.jsonl.gz"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  }, 90000);

  it("runs a full ordinary 256 MiB head when the optional sampler is unavailable", async () => {
    const a = await fixture(false),
      b = await fixture(false, a.solverId);
    const scope = {
      ...a,
      executions: [...a.executions, ...b.executions].sort((x, y) =>
        x.executionId.localeCompare(y.executionId),
      ),
    };
    const path = await directory(),
      store = new MemoryBackup(),
      budgets: number[] = [];
    const real = {
      ...source,
      async readMember(
        id: string,
        kind: legacyCodec.LegacyBackupPage["members"][number]["kind"],
        seq: number,
        bytes: number,
      ) {
        budgets.push(bytes);
        return source.query(
          legacyMemberSql(id, kind, seq, bytes),
          bytes * 6 + 1024 ** 2,
        );
      },
    };
    const previousPath = process.env.PATH;
    await writeFile(
      join(path, "ssh"),
      "#!/bin/sh\nprintf invalid-sample\\n\nexit 1\n",
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", path + ":" + previousPath);
    try {
      const result = await exportLegacyReports({
        scope,
        directory: path,
        store,
        source: real,
        sourceBinding: "capacity-fallback",
        rows: 2,
        pages: 2,
        maxBytes: 256 * 1024 ** 2,
        executionSupervisor: {
          slots: 2,
          targetBinding: "working-volume",
          peerSource: real,
          openBudget: () =>
            openLegacyPeerBudget(
              "fixture-worker.invalid",
              "fixture-sweeper",
              8192,
              4096,
            ),
        },
        applyVerifiedPage: async (page, receipt) => {
          expect(
            decodeLegacyPage(await store.read(receipt.object), receipt).members,
          ).toEqual(page.members);
        },
      });
      expect(result.executionSupervisor).toMatchObject({
        maxActive: 1,
        appliedAhead: 0,
        admissionReasons: ["capacity_unavailable"],
        published: 2,
        pendingPeerExecution: null,
      });
      expect(budgets[0]).toBe(268435456);
      expect(result.next).toMatchObject({ execution: 0, copied: 4 });
      expect(result.receipts.length).toBe(2);
      await expect(
        readdir(join(path, "pending.jsonl.gz")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("charges the same front and peer work in serial and concurrent controls and preserves both receipt chains", async () => {
    const a = await fixture(false),
      b = await fixture(false, a.solverId);
    const scope = {
      ...a,
      executions: [...a.executions, ...b.executions].sort((x, y) =>
        x.executionId.localeCompare(y.executionId),
      ),
    };
    const [front, peer] = scope.executions;
    const results = [];
    for (const order of ["serial", "concurrent"] as const) {
      const path = await directory(),
        store = new MemoryBackup(),
        peerStarted = signal(),
        frontStarted = signal();
      let active = 0,
        peak = 0,
        frontApplied = false;
      const peerSource = {
        ...source,
        async query(q: string, bytes: number) {
          if (order === "serial") {
            expect(frontApplied).toBe(true);
            const frontStage = join(
              path,
              "pending.jsonl.gz",
              "page-0-report-0-0",
            );
            expect(
              JSON.parse(await readFile(join(frontStage, "ready.json"), "utf8"))
                .receipt,
            ).toMatch(/receipt\.json$/);
            await expect(
              readFile(join(frontStage, "transfer.gz")),
            ).rejects.toMatchObject({ code: "ENOENT" });
          }
          return source.query(q, bytes);
        },
      };
      const result = await exportLegacyReports({
        scope,
        source,
        store,
        directory: path,
        rows: 2,
        pages: 2,
        maxBytes: 256 * 1024 ** 2,
        sourceBinding: "same-target",
        executionSupervisor: {
          slots: 2,
          pairOrder: order,
          targetBinding: "same-worker",
          peerSource,
          openBudget: async () => ({
            admit: true,
            finish: async () => ({
              permitted: true,
              peakWorkerRssMiB: 100,
              peakControllerRssMiB: 100,
              minAvailableMiB: 12000,
            }),
          }),
        },
        applyVerifiedPage: async (page, receipt) => {
          active++;
          peak = Math.max(peak, active);
          try {
            const owner = page.members[0].executionId;
            if (order === "concurrent") {
              if (owner === front.executionId) {
                frontStarted.release();
                await peerStarted.reached;
              } else {
                peerStarted.release();
                await frontStarted.reached;
              }
            }
            expect(
              decodeLegacyPage(await store.read(receipt.object), receipt)
                .members,
            ).toEqual(page.members);
            if (owner === peer.executionId) peerStarted.release();
            if (owner === front.executionId) frontApplied = true;
          } finally {
            active--;
          }
        },
      });
      expect(peak).toBe(order === "serial" ? 1 : 2);
      expect(result.executionSupervisor?.maxActive).toBe(peak);
      expect(result.executionSupervisor?.pairOrder).toBe(order);
      expect(result.executionSupervisor?.pairedExecutions).toEqual([
        [front.executionId, peer.executionId],
      ]);
      const costs = result.executionSupervisor!.pageWork;
      expect(costs).toHaveLength(2);
      expect(
        costs.every(
          (x) => x.elapsedMs >= 0 && x.members === 2 && x.packedBytes > 0,
        ),
      ).toBe(true);
      results.push({
        next: result.next,
        receipts: result.receipts,
        peerReceipts: result.executionSupervisor!.peerReceipts,
        peerNext: result.executionSupervisor!.peerNext,
      });
    }
    expect(results[0]).toEqual(results[1]);
  }, 30000);

  it("stops serial-control admissions before a peer when the front reply is lost", async () => {
    const a = await fixture(false),
      b = await fixture(false, a.solverId);
    const scope = {
      ...a,
      executions: [...a.executions, ...b.executions].sort((x, y) =>
        x.executionId.localeCompare(y.executionId),
      ),
    };
    const path = await directory(),
      store = new MemoryBackup();
    const peer = vi.fn(source.query);
    const base = {
      scope,
      source,
      store,
      directory: path,
      rows: 2,
      pages: 2,
      maxBytes: 256 * 1024 ** 2,
      sourceBinding: "serial-failure",
      executionSupervisor: {
        slots: 2 as const,
        pairOrder: "serial" as const,
        targetBinding: "same-worker",
        peerSource: { query: peer },
        openBudget: async () => ({
          admit: true,
          finish: async () => ({
            permitted: true,
            peakWorkerRssMiB: 100,
            peakControllerRssMiB: 100,
            minAvailableMiB: 10000,
          }),
        }),
      },
    };
    await expect(
      exportLegacyReports({
        ...base,
        applyVerifiedPage: async () => {
          throw Error("lost front reply");
        },
      }),
    ).rejects.toThrow(/lost front reply/);
    expect(peer).not.toHaveBeenCalled();
    expect(
      JSON.parse(await readFile(join(path, "checkpoint.json"), "utf8"))
        .lastReceipt,
    ).toBeNull();
    const resumed = await exportLegacyReports({
      ...base,
      applyVerifiedPage: async () => undefined,
    });
    expect(resumed.executionSupervisor).toMatchObject({
      pairOrder: "serial",
      maxActive: 1,
      appliedAhead: 1,
      published: 1,
    });
    expect(resumed.next.copied).toBe(2);
  });

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
        if (attempt === 4) throw new LegacyPeerOccupied();
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
      peerWorkerPauses: 1,
      transientRetries: 2,
    });
    expect(waits).toEqual([5000, 1000, 2000, 5000]);
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
    await expect(readLegacyPage(source, scope)).rejects.toMatchObject({
      details: {
        operation: "worker_read",
        category: "origin_unavailable",
        member: { executionId, kind: "conflict", sequence: 3 },
      },
      retryable: false,
    });
    await client.sql`UPDATE public.progressive_worker_report_conflicts SET body_source_sequence=3 WHERE sim_job_id=${executionId}`;
    await client.sql`UPDATE public.progressive_worker_reports SET archive_bundle_id=${randomUUID()} WHERE sim_job_id=${executionId} AND sequence=3`;
    await expect(readLegacyPage(source, scope)).rejects.toMatchObject({
      details: {
        operation: "worker_read",
        category: "origin_unavailable",
        member: { executionId, kind: "conflict", sequence: 3 },
      },
      retryable: false,
    });
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
    const normalizedTuples =
      () => client.sql`SELECT sequence::int AS seq,concat_ws('/',tableoid,xmin,ctid) AS revision
      FROM public.progressive_worker_reports WHERE sim_job_id=${scope.executions[0].executionId} AND result_payload_hash IS NOT NULL ORDER BY sequence`;
    const priorTuples = await normalizedTuples();
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
    expect(Array.from(await normalizedTuples())).toEqual(
      Array.from(priorTuples),
    );
    const held = members.find(
      (m) => m.kind === "report" && m.sequence === priorTuples[0].seq,
    )!;
    await expect(
      execute(
        legacyNormalizeSql([{ ...held, reportSha256: "0".repeat(64) }], {
          apply: true,
          readersReady: true,
        }),
      ),
    ).rejects.toThrow(/differs from verified backup/);
    expect(Array.from(await normalizedTuples())).toEqual(
      Array.from(priorTuples),
    );
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

  it("rechecks a prepared page after commit and exports identical sparse reports, conflicts, and receipts", async () => {
    const scope = await fixture(),
      id = scope.executions[0].executionId;
    const input = {
      scope,
      sourceBinding: "versioned-lookahead",
      pages: 4,
      rows: 2,
    };
    const acknowledge =
      () => client.sql`UPDATE progressive_worker_reports SET acknowledged_at='2026-11-21T00:00:00Z'
      WHERE sim_job_id=${id} AND sequence=8`;
    const nextRead = signal(),
      reads: number[] = [];
    const store = new MemoryBackup(),
      path = await directory();
    const result = await exportLegacyReports({
      ...input,
      directory: path,
      store,
      prepareNextPage: true,
      source: observeMember((sequence) => {
        reads.push(sequence);
        if (sequence === 9) nextRead.release();
      }),
      applyVerifiedPage: async (page) => {
        if (page.start.after !== 0) return;
        await nextRead.reached;
        expect(store.objects.size).toBe(1);
        expect(
          JSON.parse(await readFile(join(path, "checkpoint.json"), "utf8")).next
            .after,
        ).toBe(0);
        expect(
          inspectLegacyPage(await readFile(join(path, "pending.jsonl.gz"))).page
            .next,
        ).toEqual(page.next);
        await acknowledge(); // Same report signature, different exact source-row bytes.
      },
    });
    expect(reads.filter((seq) => seq === 8)).toHaveLength(2);
    const baselineStore = new MemoryBackup();
    const baselinePath = await directory();
    const baseline = await exportLegacyReports({
      ...input,
      source,
      store: baselineStore,
      directory: baselinePath,
      applyVerifiedPage: async () => {},
    });
    expect(result).toEqual(baseline);
    expect([...store.objects.keys()]).toEqual([
      ...baselineStore.objects.keys(),
    ]);
    for (const [key, bytes] of store.objects)
      expect(bytes.equals(baselineStore.objects.get(key)!)).toBe(true);
    expect(await readFile(join(path, "checkpoint.json"))).toEqual(
      await readFile(join(baselinePath, "checkpoint.json")),
    );
  });

  it("rereads whole-row JSON when a column is added without rewriting the source tuple", async () => {
    const scope = await fixture(false),
      directoryPath = await directory(),
      store = new MemoryBackup();
    const successor = signal();
    try {
      const result = await exportLegacyReports({
        scope,
        directory: directoryPath,
        store,
        rows: 2,
        pages: 2,
        sourceBinding: "row-layout",
        prepareNextPage: true,
        source: observeMember((sequence) => {
          if (sequence === 9) successor.release();
        }),
        applyVerifiedPage: async (page) => {
          if (page.start.after !== 0) return;
          await successor.reached;
          await client.sql`ALTER TABLE progressive_worker_reports ADD COLUMN lookahead_fixture_value integer DEFAULT 17`;
        },
      });
      const receipt: LegacyBackupReceipt = JSON.parse(
        await readFile(join(directoryPath, result.receipts[1]!), "utf8"),
      );
      const page = decodeLegacyPage(await store.read(receipt.object), receipt);
      expect(
        page.members.map(
          (member) => JSON.parse(member.rowText).lookahead_fixture_value,
        ),
      ).toEqual([17, 17]);
    } finally {
      await client.sql`ALTER TABLE progressive_worker_reports DROP COLUMN IF EXISTS lookahead_fixture_value`;
    }
  });

  it.each(["source failure", "stop"] as const)(
    "commits only the current page on a speculative %s and resumes from its receipt",
    async (reason) => {
      const scope = await fixture(false),
        path = await directory(),
        store = new MemoryBackup();
      const entered = signal();
      const input = {
        scope,
        directory: path,
        store,
        rows: 2,
        pages: 3,
        sourceBinding: reason,
        prepareNextPage: true,
      };
      let stopping = false;
      const run = exportLegacyReports({
        ...input,
        source: observeMember((sequence) => {
          if (sequence === 8) {
            entered.release();
            if (reason === "source failure")
              throw new Error("next page source interrupted");
            stopping = true;
          }
        }),
        shouldStop: () => stopping,
        applyVerifiedPage: async () => {
          await entered.reached;
        },
      });
      if (reason === "source failure")
        await expect(run).rejects.toThrow("next page source interrupted");
      else
        expect(await run).toMatchObject({
          reportRowsVerified: 2,
          complete: false,
        });
      const state = JSON.parse(
        await readFile(join(path, "checkpoint.json"), "utf8"),
      );
      expect(state.next).toMatchObject({ after: 3, copied: 2 });
      expect(store.objects.size).toBe(1);
      expect(await readdir(path)).not.toContain("pending.jsonl.gz");
      expect(await exportLegacyReports({ ...input, source })).toMatchObject({
        complete: true,
        reportRowsVerified: 3,
      });
    },
  );

  it("passes the single authenticated decode to an opted-in writer after its receipt is durable", async () => {
    const scope = await fixture(false);
    const options = {
      scope,
      source,
      store: new MemoryBackup(),
      sourceBinding: "decode-handoff",
      rows: 2,
      pages: 1,
    };
    const actualDecode = legacyCodec.decodeLegacyPage;
    const decode = vi
      .spyOn(legacyCodec, "decodeLegacyPage")
      .mockImplementation(actualDecode);
    try {
      const copied = await exportLegacyReports({
        ...options,
        directory: await directory(),
      });
      expect(copied.sourceDatabaseWrites).toBe(false);
      expect(decode).toHaveBeenCalledTimes(1);
      decode.mockClear();
      const path = await directory();
      let storeIdentity: LegacyBackupObject | undefined;
      const read = options.store.read.bind(options.store);
      vi.spyOn(options.store, "read").mockImplementation(async (identity) => {
        storeIdentity = identity;
        return read(identity);
      });
      decode.mockImplementation((bytes, receipt) => {
        const verified = actualDecode(bytes, receipt);
        // The provider retains its metadata. Changing that alias may not
        // retarget the application to a different object generation.
        queueMicrotask(() => {
          storeIdentity!.generation = "2";
        });
        return verified;
      });
      const writer = vi.fn<
        NonNullable<
          Parameters<typeof exportLegacyReports>[0]["applyVerifiedPage"]
        >
      >(async (page, receipt, file, bytes) => {
        expect(decode).toHaveBeenCalledTimes(1);
        expect(page).toBe(decode.mock.results[0]!.value);
        expect(receipt.object.generation).toBe("90071992547409931");
        expect(JSON.parse(await readFile(join(path, file), "utf8"))).toEqual(
          receipt,
        );
        expect(legacySha256(bytes)).toBe(receipt.object.sha256);
        expect(
          (await readFile(join(path, "pending.jsonl.gz"))).equals(bytes),
        ).toBe(true);
        expect(
          JSON.parse(await readFile(join(path, "checkpoint.json"), "utf8")).next
            .after,
        ).toBe(0);
      });
      await exportLegacyReports({
        ...options,
        directory: path,
        applyVerifiedPage: writer,
      });
      expect(writer).toHaveBeenCalledTimes(1);
      expect(await readdir(path)).not.toContain("pending.jsonl.gz");
    } finally {
      decode.mockRestore();
    }
  });

  it("holds the cursor if readback bytes change during receipt persistence and reuses the pinned object on retry", async () => {
    const scope = await fixture(false),
      path = await directory(),
      store = new MemoryBackup();
    const writer = vi.fn(async () => {}),
      options = {
        scope,
        source,
        store,
        directory: path,
        sourceBinding: "changed-readback",
        rows: 2,
        pages: 1,
        applyVerifiedPage: writer,
      };
    const actual = legacyCodec.decodeLegacyPage;
    const decode = vi
      .spyOn(legacyCodec, "decodeLegacyPage")
      .mockImplementationOnce((bytes, receipt) => {
        const result = actual(bytes, receipt);
        queueMicrotask(() => {
          bytes[0] = bytes[0]! ^ 1;
        });
        return result;
      });
    try {
      await expect(exportLegacyReports(options)).rejects.toThrow(
        "changed before application",
      );
      expect(writer).not.toHaveBeenCalled();
      const files = await readdir(path),
        receipts = files.filter((f) => f.endsWith(".receipt.json"));
      expect(receipts).toHaveLength(1);
      expect(files).toContain("pending.jsonl.gz");
      expect(
        JSON.parse(await readFile(join(path, "checkpoint.json"), "utf8")).next
          .after,
      ).toBe(0);
      const recovered = await exportLegacyReports(options);
      expect(recovered.receipts).toEqual(receipts);
      expect(writer).toHaveBeenCalledTimes(1);
      expect(store.objects.size).toBe(1);
    } finally {
      decode.mockRestore();
    }
  });

  it("holds the single writer lock until a failed upload's speculative read has drained", async () => {
    const scope = await fixture(false),
      path = await directory();
    const entered = signal(),
      finish = signal(),
      failed = signal(),
      store = new MemoryBackup();
    const input = {
      scope,
      directory: path,
      store,
      rows: 2,
      pages: 2,
      sourceBinding: "drain-read",
      prepareNextPage: true,
    };
    const put = vi.spyOn(store, "put").mockImplementationOnce(async () => {
      await entered.reached;
      failed.release();
      throw new Error("current upload refused");
    });
    const run = exportLegacyReports({
      ...input,
      source: observeMember(async (seq) => {
        if (seq === 8) {
          entered.release();
          await finish.reached;
        }
      }),
    });
    const rejected = expect(run).rejects.toThrow("current upload refused");
    try {
      await failed.reached;
      await expect(exportLegacyReports({ ...input, source })).rejects.toThrow(
        "Another copy holds",
      );
    } finally {
      finish.release();
    }
    await rejected;
    expect(put).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(await readFile(join(path, "checkpoint.json"), "utf8")).next
        .after,
    ).toBe(0);
    const pending = await readFile(join(path, "pending.jsonl.gz"));
    expect(
      inspectLegacyPage(pending).page.members.map((item) => item.sequence),
    ).toEqual([1, 3]);
    expect(
      await exportLegacyReports({ ...input, source, pages: 1 }),
    ).toMatchObject({ next: { after: 3, copied: 2 } });
    expect([...store.objects.values()][0].equals(pending)).toBe(true);
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
