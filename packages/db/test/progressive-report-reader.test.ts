import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { analysisContentHash } from "../src/analysis-target";
import { createClient, type DB } from "../src/client";
import {
  installProgressiveReportArchiveReader,
  readProgressiveReport,
  resolveStoredProgressiveReport,
  type ProgressiveReportArchiveIdentity,
  type ProgressiveReportSourceKind,
} from "../src/progressive-report-reader";
import { archiveReportFixture } from "../test-support/progressive-report-archive-fixture";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());
afterEach(() => installProgressiveReportArchiveReader(null));

async function isolated(run: (db: DB) => Promise<void>) {
  const rollback = new Error("rollback exact report reader fixture");
  await expect(client.db.transaction(async (tx) => {
    await run(tx as unknown as DB);
    throw rollback;
  })).rejects.toBe(rollback);
}

async function fixture(db: DB, sourceKind: ProgressiveReportSourceKind, nullResult = false) {
  const executionId = randomUUID();
  const report = {
    version: 1, executionId, sequence: 3, solverId: randomUUID(), promiseId: randomUUID(),
    assignmentSignature: "a".repeat(64),
    status: { job_id: executionId, state: "cancelled", total_cases: 0, completed_cases: 0 },
    result: nullResult ? null : { job_id: executionId, state: "cancelled", polars: [], diagnostic: "exact π text" },
    stopProof: { job_id: executionId, execution_stopped: true },
  };
  const table = sql.identifier(sourceKind === "remote" ? "progressive_remote_reports" : "progressive_worker_reports");
  await db.execute(sql`CREATE TEMP TABLE ${table} (sim_job_id uuid,sequence bigint,content_signature text,
    report jsonb, PRIMARY KEY(sim_job_id,sequence)) ON COMMIT DROP`);
  const reference = { sourceKind, executionId, sequence: report.sequence, contentSignature: analysisContentHash(report) };
  await db.execute(sql`INSERT INTO ${table} VALUES (${executionId}::uuid,${report.sequence},
    ${reference.contentSignature},${JSON.stringify(report)}::jsonb)`);
  return { report, reference, table };
}

it.each(["remote", "worker"] as const)("restores exact archived %s reports with distinct raw and canonical digests", async (sourceKind) => {
  await isolated(async (db) => {
    const { report, reference, table } = await fixture(db, sourceKind);
    expect(await readProgressiveReport(db, reference)).toEqual(report);
    const archived = await archiveReportFixture(db, sourceKind, reference.executionId, reference.sequence);
    expect(archived.proof.sha256).not.toBe(reference.contentSignature);
    const read = vi.fn(async (_identity: ProgressiveReportArchiveIdentity, connection: DB) => {
      expect(connection === db, "Archive ownership reads must use the selecting transaction").toBe(true);
      return archived.text;
    });
    installProgressiveReportArchiveReader({ read });
    const before = await db.execute(sql`SELECT to_jsonb(report.*) AS row FROM ${table} report`);
    expect(await readProgressiveReport(db, reference)).toEqual(report);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0][0]).toMatchObject({
      sourceKind, memberKind: "report", executionId: reference.executionId, sequence: reference.sequence,
      signature: reference.contentSignature, reportSha256: archived.proof.sha256, reportByteSize: archived.proof.byteSize,
      generation: "7", storedSha256: "b".repeat(64), memberCount: 1,
    });
    expect(Object.keys(read.mock.calls[0][0]).some((key) => /credential|token|secret/i.test(key))).toBe(false);
    expect(await db.execute(sql`SELECT to_jsonb(report.*) AS row FROM ${table} report`)).toEqual(before);
  });
});

it("restores marked null-result snapshots even with a retained stopProof and rejects an absent reader", async () => {
  await isolated(async (db) => {
    const { report, reference, table } = await fixture(db, "worker", true);
    const archived = await archiveReportFixture(db, "worker", reference.executionId, reference.sequence);
    // New compaction preserves both null and the proof; only its marker shows
    // that status/accounting fields may have been removed.
    await db.execute(sql`UPDATE ${table} SET report=report||'{"archivedReport":true,"result":null}'::jsonb`);
    const [stored] = await db.execute(sql`SELECT report,content_signature FROM ${table}`);
    await expect(resolveStoredProgressiveReport(db, "worker", stored, reference.executionId)).rejects.toThrow("not installed");
    const read = vi.fn(async () => archived.text);
    installProgressiveReportArchiveReader({ read });
    expect(await resolveStoredProgressiveReport(db, "worker", stored, reference.executionId)).toEqual(report);
    expect(read).toHaveBeenCalledOnce();
  });
});

it("restores legacy compact headers without the explicit marker", async () => {
  await isolated(async (db) => {
    const { report, reference, table } = await fixture(db, "remote");
    const archived = await archiveReportFixture(db, "remote", reference.executionId, reference.sequence);
    await db.execute(sql`UPDATE ${table} SET report=report-'archivedReport'`);
    const [stored] = await db.execute(sql`SELECT report,content_signature FROM ${table}`);
    installProgressiveReportArchiveReader({ read: async () => archived.text });
    expect(await resolveStoredProgressiveReport(db, "remote", stored, reference.executionId)).toEqual(report);
  });
});

it("does not rehash, query or reject older fixture shapes on the live consumer path", async () => {
  const execute = vi.fn(() => { throw new Error("live fast path queried storage"); });
  const db = { execute } as unknown as DB;
  for (const report of [
    { version: 1, executionId: randomUUID(), sequence: 1, result: null, stopProof: { execution_stopped: true } },
    { result: { state: "completed", polars: [] } },
  ]) {
    expect(await resolveStoredProgressiveReport(db, "worker", { report, content_signature: "legacy-fixture" },
      "executionId" in report ? report.executionId! : "legacy-fixture")).toBe(report);
  }
  expect(execute).not.toHaveBeenCalled();
});

it("checks exact raw bytes before parsing the report", async () => {
  await isolated(async (db) => {
    const { report, reference } = await fixture(db, "remote");
    await archiveReportFixture(db, "remote", reference.executionId, reference.sequence);
    installProgressiveReportArchiveReader({ read: async () => JSON.stringify(report) });
    await expect(readProgressiveReport(db, reference)).rejects.toThrow("member bytes changed");
  });
});

it.each(["changed-content", "compact-body"] as const)("refuses authenticated raw bytes containing %s", async (kind) => {
  await isolated(async (db) => {
    const { reference } = await fixture(db, "remote");
    const archived = await archiveReportFixture(db, "remote", reference.executionId, reference.sequence, {
      memberText: (text) => {
        const value = JSON.parse(text);
        return JSON.stringify(kind === "changed-content"
          ? { ...value, status: { ...value.status, completed_cases: 1 } }
          : { ...value, archivedReport: true, result: { state: "cancelled" } });
      },
    });
    installProgressiveReportArchiveReader({ read: async () => archived.memberText });
    await expect(readProgressiveReport(db, reference)).rejects.toThrow("exact stored identity");
  });
});

it("refuses missing member custody and a different sequence or signature without trying another report", async () => {
  await isolated(async (db) => {
    const { reference } = await fixture(db, "worker");
    const archived = await archiveReportFixture(db, "worker", reference.executionId, reference.sequence, { omitMember: true });
    const read = vi.fn(async () => archived.text);
    installProgressiveReportArchiveReader({ read });
    await expect(readProgressiveReport(db, { ...reference, sequence: reference.sequence + 1 })).rejects.toThrow("not found");
    await expect(readProgressiveReport(db, { ...reference, contentSignature: "f".repeat(64) })).rejects.toThrow("not found");
    await expect(readProgressiveReport(db, reference)).rejects.toThrow("member custody");
    expect(read).not.toHaveBeenCalled();
  });
});

it("keeps the real archive catalog immutability guard enabled", async () => {
  await isolated(async (db) => {
    const { reference } = await fixture(db, "remote");
    const archived = await archiveReportFixture(db, "remote", reference.executionId, reference.sequence);
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM public.progressive_report_archive_members WHERE bundle_id=${archived.bundleId}::uuid`);
    })).rejects.toThrow("immutable");
    await expect(db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE public.progressive_report_archive_members SET report_sha256=${"f".repeat(64)}
        WHERE bundle_id=${archived.bundleId}::uuid`);
    })).rejects.toThrow("immutable");
    installProgressiveReportArchiveReader({ read: async () => archived.text });
    await expect(readProgressiveReport(db, reference)).resolves.toMatchObject({ executionId: reference.executionId });
  });
});

it("bounds a stalled restore, aborts the transport and preserves the archived row", async () => {
  await isolated(async (db) => {
    const { reference, table } = await fixture(db, "remote");
    await archiveReportFixture(db, "remote", reference.executionId, reference.sequence);
    let signal: AbortSignal | undefined;
    installProgressiveReportArchiveReader({ read: async (identity) => {
      signal = identity.signal;
      return new Promise<string>((_resolve, reject) => identity.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } }, { timeoutMs: 20 });
    const before = await db.execute(sql`SELECT to_jsonb(report.*) AS row FROM ${table} report`);
    await expect(readProgressiveReport(db, reference)).rejects.toMatchObject({
      message: "Archived progressive full report read timed out",
      member: { ...reference, generation: expect.any(String), reportSha256: expect.stringMatching(/^[a-f0-9]{64}$/), reportByteSize: expect.any(Number) },
    });
    expect(signal?.aborted).toBe(true);
    expect(await db.execute(sql`SELECT to_jsonb(report.*) AS row FROM ${table} report`)).toEqual(before);
  });
});
