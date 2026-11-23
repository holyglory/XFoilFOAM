import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createMinimalSolverFixture } from "../../../packages/db/test/solver-fixture";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createClient, type DB } from "@aerodb/db/client";
import { analysisContentHash } from "@aerodb/db/analysis-target";
import {
  canonicalReportJson,
  parseReportJson,
} from "@aerodb/db/progressive-report-archive";
import { backfillWorkerReportPrefix } from "@aerodb/db/progressive-report-prefix";
import {
  backfillProgressiveReportPayloads,
  setProgressiveReportNormalization,
} from "@aerodb/db/progressive-report-payloads";
import { readProgressiveReport } from "@aerodb/db/progressive-report-reader";
import {
  archiveSha256,
  withArchiveFixture,
  type ArchiveFixture,
} from "./progressive-report-archive-fixture";
import { runNativeWorkerReportSharing } from "../src/progressive-report-archive-service";

const client = createClient({ max: 1 });
beforeAll(() =>
  expect(process.env.PROGRESSIVE_REPORT_ARCHIVE_DISPOSABLE_DB).toBe("1"),
);
afterAll(() => client.sql.end());
const run = (body: (f: ArchiveFixture) => Promise<void>) =>
  withArchiveFixture(client, "worker", body, {
    normalized: false,
    reportCount: 2,
  });
const enabled = (db: DB, value: boolean) =>
  setProgressiveReportNormalization(db, { enabled: value, readersReady: true });

async function append(
  f: ArchiveFixture,
  sequence: number,
  history: string,
  opts: {
    scale?: string;
    bad?: boolean;
    largeEnvelope?: boolean;
    shape?: "null" | "absent";
  } = {},
) {
  const report = JSON.parse(f.reports[1].text);
  // Normal application signature plus exact PostgreSQL decimal formatting.
  delete report.status.diagnosticLargeInteger;
  report.sequence = sequence;
  report.status.diagnostic = opts.largeEnvelope
    ? history
    : `snapshot ${sequence} λ`;
  report.result = {
    job_id: f.executionId,
    state: "completed",
    history: opts.largeEnvelope ? "" : history,
    scale: "__scale__",
    polars: [{ points: [{ aoa_deg: 2, cl: 0.42, cd: 0.007, cm: -0.01 }] }],
  };
  if (opts.shape === "null") report.result = null;
  if (opts.shape === "absent") delete report.result;
  const text = JSON.stringify(report).replace(
    '"__scale__"',
    opts.scale ?? "1.0",
  );
  const sig = opts.bad
    ? "f".repeat(64)
    : archiveSha256(canonicalReportJson(parseReportJson(text)));
  await f.db
    .execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,acknowledged_at)
    VALUES(${f.executionId}::uuid,${sequence},${sig},${text}::jsonb,clock_timestamp())`);
  return sig;
}
async function originals(f: ArchiveFixture) {
  return f.db
    .execute(sql`SELECT sequence::int,content_signature,acknowledged_at::text,created_at::text,
    encode(sha256(convert_to(public.resolve_progressive_report(report,result_payload_hash)::text,'UTF8')),'hex') AS full_sha
    FROM progressive_worker_reports WHERE sim_job_id=${f.executionId}::uuid ORDER BY sequence`);
}
async function science(f: ArchiveFixture) {
  const state: Record<string, unknown> = {};
  for (const name of [
    "results",
    "result_attempts",
    "progressive_worker_evidence_receipts",
    "progressive_worker_evidence_attempts",
    "progressive_remote_dispatches",
    "progressive_worker_hub_receipts",
  ]) {
    state[name] = await f.db.execute(
      sql`SELECT to_jsonb(r.*)::text AS original FROM ${sql.identifier(name)} r WHERE sim_job_id=${f.executionId}::uuid ORDER BY 1`,
    );
  }
  state.job = await f.db.execute(
    sql`SELECT to_jsonb(j.*)::text FROM sim_jobs j WHERE id=${f.executionId}::uuid`,
  );
  state.promise = await f.db.execute(
    sql`SELECT to_jsonb(p.*)::text FROM sync_sweep_promises p WHERE id=${f.promiseId}::uuid`,
  );
  return state;
}

it("discovers an exact bounded prefix, preserves every distinct envelope, and stops at different numeric bytes", async () => {
  await run(async (f) => {
    const payload = randomBytes(256 * 1024).toString("base64");
    const sigs = [];
    for (let n = 10; n <= 15; n++)
      sigs.push(
        await append(f, n, payload, { scale: n < 14 ? "1.0" : "1.00" }),
      );
    const from = { executionId: f.executionId, sequence: 9 };
    const args = {
      executionId: f.executionId,
      after: from,
      rows: 8,
      minStoredBytes: 1024,
    };
    const original = await originals(f),
      evidence = await science(f);
    expect(
      await backfillWorkerReportPrefix(f.db, { ...args, apply: true }),
    ).toMatchObject({ state: "disabled", normalized: 0 });
    await enabled(f.db, true);
    expect(
      await backfillWorkerReportPrefix(f.db, {
        ...args,
        apply: true,
        excludeJobs: [f.executionId],
      }),
    ).toMatchObject({ state: "excluded", normalized: 0 });
    expect(await backfillWorkerReportPrefix(f.db, args)).toMatchObject({
      state: "preview",
      matched: 4,
      normalized: 0,
      after: { sequence: 13 },
    });
    const result = await backfillWorkerReportPrefix(f.db, {
      ...args,
      apply: true,
    });
    expect(result).toMatchObject({
      state: "shared",
      normalized: 4,
      binaryVerified: 4,
      after: { sequence: 13 },
      contentSignaturesSha256: archiveSha256(
        sigs
          .slice(0, 4)
          .map((s, i) => 10 + i + ":" + s)
          .join(","),
      ),
    });
    expect(result.netValueBytesSavedAtLeast).toBeGreaterThan(0);
    const next = await backfillWorkerReportPrefix(f.db, {
      ...args,
      apply: true,
      after: result.after,
    });
    expect(next).toMatchObject({
      normalized: 2,
      binaryVerified: 2,
      after: { sequence: 15 },
    });
    expect(next.sharedHash).not.toBe(result.sharedHash);
    expect(await originals(f)).toEqual(original);
    expect(await science(f)).toEqual(evidence);
    for (const [i, signature] of sigs.entries()) {
      const recovered = await readProgressiveReport(f.db, {
        sourceKind: "worker",
        executionId: f.executionId,
        sequence: 10 + i,
        contentSignature: signature,
      });
      expect(analysisContentHash(recovered)).toBe(signature);
      expect(recovered.result!.polars[0].points[0].cl).toBe(0.42);
    }
    expect(
      await backfillWorkerReportPrefix(f.db, { ...args, apply: true }),
    ).toMatchObject({ normalized: 0 });
  });
});
it("reuses the adjacent protected payload for a one-row tail without rehashing or charging it again", async () => {
  await run(async (f) => {
    const data = randomBytes(32 * 1024).toString("base64");
    for (let n = 10; n <= 12; n++) await append(f, n, data);
    await enabled(f.db, true);
    const opts = {
      executionId: f.executionId,
      apply: true,
      rows: 2,
      minStoredBytes: 32,
    };
    const first = await backfillWorkerReportPrefix(f.db, {
      ...opts,
      after: { executionId: f.executionId, sequence: 9 },
    });
    expect(first).toMatchObject({
      normalized: 2,
      reusedPreviousPayload: false,
      after: { sequence: 11 },
    });
    expect(first.sharedValueBytesCharged).toBeGreaterThan(0);
    const last = await backfillWorkerReportPrefix(f.db, {
      ...opts,
      after: first.after,
    });
    expect(last).toMatchObject({
      normalized: 1,
      reusedPreviousPayload: true,
      sharedHash: first.sharedHash,
      sharedValueBytesCharged: 0,
      after: { sequence: 12 },
    });
    expect(last.netValueBytesSavedAtLeast).toBeGreaterThan(0);
    const done = await backfillWorkerReportPrefix(f.db, {
      ...opts,
      after: last.after,
    });
    expect(done).toMatchObject({
      state: "scanned",
      after: { sequence: null },
      inspectedThrough: 11,
    });
  });
});
it("protects lost signatures, singleton results, null/absent results, unprofitable sharing and closed ownership", async () => {
  await run(async (f) => {
    const value = randomBytes(70 * 1024).toString("base64");
    await append(f, 10, value, { bad: true });
    await append(f, 11, value);
    await append(f, 12, value + "different");
    await append(f, 13, value, { largeEnvelope: true, shape: "null" });
    await append(f, 14, value, { largeEnvelope: true, shape: "absent" });
    await append(f, 15, value, { largeEnvelope: true });
    await append(f, 16, value, { largeEnvelope: true });
    const from = (sequence: number) => ({
      apply: true,
      executionId: f.executionId,
      after: { executionId: f.executionId, sequence },
      rows: 2,
      minStoredBytes: 32,
    });
    const original = await originals(f);
    await enabled(f.db, true);
    expect(
      await backfillWorkerReportPrefix(f.db, { ...from(9), maxBytes: 1000 }),
    ).toMatchObject({ normalized: 0 });
    expect(await backfillWorkerReportPrefix(f.db, from(9))).toMatchObject({
      state: "reader-unverified",
      normalized: 0,
    });
    expect(await backfillWorkerReportPrefix(f.db, from(10))).toMatchObject({
      state: "scanned",
      matched: 1,
      normalized: 0,
    });
    expect(await backfillWorkerReportPrefix(f.db, from(12))).toMatchObject({
      state: "scanned",
      matched: 0,
      normalized: 0,
    });
    expect(await backfillWorkerReportPrefix(f.db, from(14))).toMatchObject({
      state: "no-saving",
      normalized: 0,
    });
    const [leak] = await f.db
      .execute(sql`SELECT count(*)::int AS n FROM progressive_report_result_payloads
      WHERE result->>'job_id'=${f.executionId}`);
    expect(leak.n).toBe(0);
    await f.db.execute(
      sql`UPDATE sim_jobs SET ingest_lease_token=gen_random_uuid(),ingest_lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=${f.executionId}::uuid`,
    );
    expect(await backfillWorkerReportPrefix(f.db, from(9))).toMatchObject({
      state: "ineligible",
    });
    expect(await originals(f)).toEqual(original);
  });
});
it("rolls back a cancelled SQL step and retries from the prior cursor", async () => {
  await run(async (f) => {
    const data = randomBytes(32 * 1024).toString("base64");
    for (let n = 10; n <= 12; n++) await append(f, n, data);
    await enabled(f.db, true);
    await f.db
      .execute(sql`CREATE FUNCTION pg_temp.cancel_native_step() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'cancel test step' USING ERRCODE='57014'; END; $$`);
    await f.db
      .execute(sql`CREATE TRIGGER cancel_fixture_prefix BEFORE UPDATE OF result_payload_hash ON public.progressive_worker_reports
      FOR EACH ROW EXECUTE FUNCTION pg_temp.cancel_native_step()`);
    const args = {
      executionId: f.executionId,
      after: { executionId: f.executionId, sequence: 9 },
      rows: 3,
      minStoredBytes: 32,
      apply: true,
    };
    expect(await backfillWorkerReportPrefix(f.db, args)).toMatchObject({
      state: "timed-out",
      normalized: 0,
      after: args.after,
    });
    expect(
      (
        await f.db.execute(
          sql`SELECT count(result_payload_hash)::int AS n FROM progressive_worker_reports WHERE sim_job_id=${f.executionId}::uuid`,
        )
      )[0].n,
    ).toBe(0);
    await f.db.execute(
      sql`DROP TRIGGER cancel_fixture_prefix ON public.progressive_worker_reports`,
    );
    expect(
      await backfillWorkerReportPrefix(f.db, { ...args, rows: 2 }),
    ).toMatchObject({ normalized: 2, after: { sequence: 11 } });
  });
});
it("runs bounded discovery in the existing HZ worker and respects the excluded private cohort", async () => {
  await run(async (f) => {
    const history = randomBytes(300 * 1024).toString("base64");
    await append(f, 10, history);
    await append(f, 11, history);
    await enabled(f.db, true);
    vi.stubEnv("AIRFOILFOAM_NATIVE_REPORT_SHARING", "true");
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
    try {
      // Seek from the actual preceding report key so other isolated fixtures
      // never become part of this job's transaction.
      const [prev] = await f.db.execute(
        sql`SELECT sim_job_id FROM progressive_worker_reports WHERE sim_job_id<${f.executionId}::uuid AND archived_at IS NULL ORDER BY sim_job_id DESC LIMIT 1`,
      );
      const after = prev
        ? { executionId: String(prev.sim_job_id), sequence: null }
        : null;
      expect(
        await backfillWorkerReportPrefix(f.db, {
          apply: true,
          after,
          excludeJobs: [f.executionId],
        }),
      ).toMatchObject({
        state: "excluded",
        after: { executionId: f.executionId },
      });
      const stop = new AbortController();
      const messages: Array<{ component: string; normalized: number }> = [];
      const logger = vi.spyOn(console, "info").mockImplementation((value) => {
        const event = JSON.parse(String(value));
        if (event.component === "native-worker-report-sharing") {
          messages.push(event);
          stop.abort();
        }
      });
      try {
        await runNativeWorkerReportSharing(
          f.db,
          AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]),
          after,
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          normalized: 2,
          after: { executionId: f.executionId },
          physicalSpaceReleased: null,
        });
      } finally {
        logger.mockRestore();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
it("alternates bounded priority ranges with ordinary discovery in one HZ worker", async () => {
  await run(async (f) => {
    const medium = randomBytes(56 * 1024).toString("base64");
    const large = randomBytes(310 * 1024).toString("base64");
    for (const n of [10, 11, 12, 40, 41, 42]) await append(f, n, medium);
    for (const n of [20, 21]) await append(f, n, large);
    const before = await originals(f);
    await enabled(f.db, true);
    vi.stubEnv("AIRFOILFOAM_NATIVE_REPORT_SHARING", "true");
    vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
    vi.stubEnv(
      "AIRFOILFOAM_NATIVE_REPORT_PRIORITY_RANGES",
      `${f.executionId}:10-11,${f.executionId}:40-41`,
    );
    const captures: Array<{
      firstSequence: number;
      normalized: number;
      binaryVerified: number;
      priorityThrough?: number;
    }> = [];
    const stop = new AbortController();
    const logger = vi.spyOn(console, "info").mockImplementation((value) => {
      const event = JSON.parse(String(value));
      if (
        event.component !== "native-worker-report-sharing" ||
        event.state !== "shared"
      )
        return;
      captures.push(event);
      if (captures.length === 3) stop.abort();
    });
    try {
      await runNativeWorkerReportSharing(
        f.db,
        AbortSignal.any([stop.signal, AbortSignal.timeout(5000)]),
        { executionId: f.executionId, sequence: 9 },
      );
      expect(
        captures.map((r) => [
          r.firstSequence,
          r.priorityThrough,
          r.normalized,
          r.binaryVerified,
        ]),
      ).toEqual([
        [10, 11, 2, 2],
        [20, undefined, 2, 2],
        [40, 41, 2, 2],
      ]);
      expect(await originals(f)).toEqual(before);
      const shared = await f.db
        .execute(sql`SELECT sequence::int AS n FROM progressive_worker_reports
        WHERE sim_job_id=${f.executionId}::uuid AND result_payload_hash IS NOT NULL ORDER BY sequence`);
      expect(shared.map((r) => r.n)).toEqual([10, 11, 20, 21, 40, 41]);
      expect(
        await backfillWorkerReportPrefix(f.db, {
          apply: true,
          executionId: f.executionId,
          throughSequence: 42,
          after: { executionId: f.executionId, sequence: 41 },
          excludeJobs: [f.executionId],
        }),
      ).toMatchObject({ state: "excluded", normalized: 0 });
    } finally {
      logger.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
it("runs the portable worker entry point, pins a locked middle row, and verifies a retry through the ordinary reader", async () => {
  const job = randomUUID(),
    promise = randomUUID(),
    fixture = await createMinimalSolverFixture(client.db, "prefix-lock-" + job);
  const blocker = createClient({ max: 1 }),
    lock = await blocker.sql.reserve();
  const [airfoil] = await client.sql`SELECT id FROM airfoils LIMIT 1`;
  const { id } = airfoil;
  const body = (sequence: number) => ({
    version: 1,
    executionId: job,
    sequence,
    solverId: randomUUID(),
    promiseId: promise,
    status: { job_id: job, state: "completed" },
    stopProof: { job_id: job, execution_stopped: true },
    result: {
      state: "completed",
      job_id: job,
      polars: [{ points: [{ aoa_deg: 2, cl: 0.45 }] }],
      history,
    },
  });
  const history = randomBytes(32 * 1024).toString("base64");
  let initial: boolean | undefined;
  let held = false;
  const signatures: string[] = [];
  try {
    await client.sql.begin(async (tx) => {
      const [policy] =
        await tx`SELECT normalization_enabled FROM progressive_report_storage_policy WHERE id=1 FOR UPDATE`;
      initial = policy.normalization_enabled;
      await tx`UPDATE progressive_report_storage_policy SET normalization_enabled=false WHERE id=1`;
      await tx`INSERT INTO sync_sweep_promises(id,status,airfoil_id,simulation_preset_revision_id,"expiresAt") VALUES(${promise},'expired',${id},${fixture.revisionId},now())`;
      await tx`INSERT INTO sim_jobs(id,airfoil_id,bc_ids,reference_chord_m,status,"ingestedAt",engine_job_id,request_payload)
        VALUES(${job},${id},'[]'::jsonb,1,'done',now(),${job},${JSON.stringify({ remoteSolver: true, syncPromiseId: promise })}::jsonb)`;
      for (let n = 1; n <= 3; n++) {
        const report = body(n),
          signature = analysisContentHash(report);
        signatures.push(signature);
        await tx`INSERT INTO progressive_worker_reports(sim_job_id,sequence,report,content_signature,acknowledged_at) VALUES(${job},${n},${JSON.stringify(report)}::jsonb,${signature},now())`;
      }
      await tx`UPDATE progressive_report_storage_policy SET normalization_enabled=true WHERE id=1`;
    });
    const cwd = fileURLToPath(
      new URL("../../../packages/db/src/", import.meta.url),
    );
    const script = fileURLToPath(
      new URL(
        "../../../scripts/deploy/emit-native-report-prefix.mjs",
        import.meta.url,
      ),
    );
    const input = execFileSync(process.execPath, [script]);
    const invoke = (...args: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-",
            "--native-prefix",
            "--execution=" + job,
            "--rows=3",
            "--min-stored-bytes=32",
            ...args,
          ],
          {
            input,
            cwd,
            encoding: "utf8",
            timeout: 20000,
            env: {
              ...process.env,
              AIRFOILFOAM_DEPLOYMENT_ROLE: "remote-solver",
            },
          },
        ),
      );
    expect(invoke("--dry-run")).toMatchObject({
      state: "preview",
      matched: 3,
      normalized: 0,
    });
    await lock`BEGIN`;
    held = true;
    await lock`SELECT sequence FROM progressive_worker_reports WHERE sim_job_id=${job} AND sequence=2 FOR UPDATE`;
    expect(invoke("--apply")).toMatchObject({
      state: "busy",
      after: { executionId: job, sequence: 0 },
      normalized: 0,
    });
    expect(
      (
        await client.sql`SELECT count(result_payload_hash)::int AS n FROM progressive_worker_reports WHERE sim_job_id=${job}`
      )[0].n,
    ).toBe(0);
    await lock`ROLLBACK`;
    held = false;
    await lock`BEGIN`;
    held = true;
    await lock`SELECT id FROM sim_jobs WHERE id=${job} FOR UPDATE`;
    expect(invoke("--apply")).toMatchObject({
      state: "busy",
      normalized: 0,
      after: { executionId: job, sequence: 0 },
    });
    await lock`ROLLBACK`;
    held = false;
    expect(invoke("--apply")).toMatchObject({
      state: "shared",
      binaryVerified: 3,
      normalized: 3,
      physicalSpaceReleased: null,
    });
    expect(invoke("--apply")).toMatchObject({
      state: "scanned",
      normalized: 0,
    });
    expect(
      (
        await readProgressiveReport(client.db, {
          sourceKind: "worker",
          executionId: job,
          sequence: 3,
          contentSignature: signatures[2],
        })
      ).result!.polars[0].points[0].cl,
    ).toBe(0.45);
  } finally {
    if (held) await lock`ROLLBACK`;
    lock.release();
    await blocker.sql.end();
    await client.sql.begin(async (tx) => {
      const hashes =
        await tx`SELECT DISTINCT result_payload_hash AS hash FROM progressive_worker_reports WHERE sim_job_id=${job} AND result_payload_hash IS NOT NULL`;
      await tx`DELETE FROM sim_jobs WHERE id=${job}`;
      await tx`DELETE FROM sync_sweep_promises WHERE id=${promise}`;
      for (const { hash } of hashes)
        await tx`DELETE FROM progressive_report_result_payloads p WHERE content_hash=${hash}
        AND NOT EXISTS(SELECT 1 FROM progressive_worker_reports WHERE result_payload_hash=p.content_hash)
        AND NOT EXISTS(SELECT 1 FROM progressive_remote_reports WHERE result_payload_hash=p.content_hash)`;
      if (initial !== undefined)
        await tx`UPDATE progressive_report_storage_policy SET normalization_enabled=${initial} WHERE id=1`;
    });
    await fixture.cleanup();
  }
}, 60000);

it("benchmarks equal work against per-row SHA readback on the same PostgreSQL originals", async () => {
  await run(async (f) => {
    const history = randomBytes(384 * 1024).toString("base64");
    for (let n = 20; n < 28; n++) await append(f, n, history);
    await enabled(f.db, true);
    let valueBytes:
      | {
          original: number;
          reduction: number;
          netAtLeast: number;
          retained: number;
          refs: number;
        }
      | undefined;
    const original = await originals(f),
      timings: Record<string, number[]> = { prefix: [], perRow: [] };
    for (const mode of [
      "perRow",
      "prefix",
      "prefix",
      "perRow",
      "perRow",
      "prefix",
    ]) {
      await f.db.execute(sql`SAVEPOINT native_sharing_benchmark`);
      const start = performance.now();
      if (mode === "prefix") {
        const r = await backfillWorkerReportPrefix(f.db, {
          executionId: f.executionId,
          after: { executionId: f.executionId, sequence: 19 },
          apply: true,
          rows: 8,
        });
        expect(r.normalized).toBe(8);
        expect(r.binaryVerified).toBe(8);
        const measured = {
          original: r.originalReportValueBytes,
          reduction: r.reportValueBytesReduced,
          netAtLeast: r.netValueBytesSavedAtLeast,
          retained: r.retainedPayloadBytes,
          refs: r.referenceBytesAdded,
        };
        expect(measured.netAtLeast).toBeGreaterThan(0);
        if (valueBytes) expect(measured).toEqual(valueBytes);
        valueBytes = measured;
      } else {
        const r = await backfillProgressiveReportPayloads(f.db, {
          table: "progressive_worker_reports",
          after: { executionId: f.executionId, sequence: 19 },
          apply: true,
          rows: 8,
        });
        expect(r.normalized).toBe(8);
        expect(r.proofs).toHaveLength(8);
      }
      timings[mode].push(Math.round(performance.now() - start));
      expect(await originals(f)).toEqual(original);
      await f.db.execute(sql`ROLLBACK TO SAVEPOINT native_sharing_benchmark`);
      await f.db.execute(sql`RELEASE SAVEPOINT native_sharing_benchmark`);
    }
    console.info(
      JSON.stringify({
        benchmark: "native-worker-report-prefix",
        rows: 8,
        historyBytes: Buffer.byteLength(history),
        timingMs: timings,
        storedValueBytes: valueBytes,
        physicalSpaceReleased: null,
      }),
    );
  });
}, 120_000);
