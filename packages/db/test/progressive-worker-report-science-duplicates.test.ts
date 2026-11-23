import { sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createClient, type DB } from "../src/client";
import { analysisContentHash } from "../src/analysis-target";
import {
  canonicalReportJson,
  parseReportJson,
  reportTextIdentity,
} from "../src/progressive-report-archive";
import { encodeLegacyPage } from "../src/legacy-report-storage-codec";
import {
  verifyLegacyReportCustodyPage,
  applyLegacyReportCustodyPage,
  legacyReportCustodySql,
} from "../src/legacy-report-custody";
import {
  installProgressiveReportArchiveReader,
  readProgressiveReport,
} from "../src/progressive-report-reader";
import { progressiveEvidenceWakeSql } from "../../../apps/sweeper/src/progressive-evidence-wake";
import { progressiveStagingSelectionSql } from "../../../apps/sweeper/src/progressive-staging-selection";
import { type ProgressiveRemoteReport } from "../src/progressive-remote-report";
import { type ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import { type LegacyReportMember } from "../src/legacy-report-storage";
import { type EngineClient } from "../../engine-client/src";
import { progressiveRemoteEvidenceResult } from "./progressive-remote-evidence-fixture";
import {
  stageNextProgressiveWorkerEvidence,
  stageProgressiveWorkerEvidence,
} from "../../../apps/sweeper/src/progressive-worker-evidence";
import { readStoredWorkerArchiveText } from "../../../apps/sweeper/src/report-archive-broker-client";
import { readLegacyWorkerReportArchivePage } from "../../../apps/sweeper/src/legacy-worker-report-product-read";
import { storeWorkerReportVolume } from "../../../apps/sweeper/src/worker-report-volume";
import {
  withArchiveFixture,
  type ArchiveFixture,
} from "../../../apps/sweeper/test/progressive-report-archive-fixture";

const client = createClient({ max: 1 });
const { CRC32C } = createRequire(
  new URL("../../../apps/sweeper/package.json", import.meta.url),
)("@google-cloud/storage") as {
  CRC32C: new () => { update(bytes: Buffer): void; toString(): string };
};
afterAll(() => client.sql.end());
afterEach(() => {
  installProgressiveReportArchiveReader(null);
  vi.unstubAllEnvs();
});
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const noEngine = new Proxy(
  {},
  {
    get() {
      throw new Error(
        "Stored report staging must not call a solver/render endpoint",
      );
    },
  },
) as EngineClient;
type Fixture = Awaited<ReturnType<typeof prepare>>;

async function prepare(base: ArchiveFixture, inline = false) {
  const db = base.db,
    executionId = base.executionId,
    sourceSequence = 3487;
  const [job] = await db.execute(
    sql`SELECT * FROM sim_jobs WHERE id=${executionId}::uuid`,
  );
  const envelope = (
    job.request_payload as {
      remoteProgressiveExecution: ProgressiveRemoteExecutionEnvelope;
    }
  ).remoteProgressiveExecution;
  const instanceId = randomUUID(),
    solverId = envelope.solverId,
    upstream = "https://duplicate-proof.invalid/api/sync/v1";
  await db.execute(sql`UPDATE sync_api_settings SET instance_id=${instanceId}::uuid,remote_solver_registered_id=${solverId}::uuid,
    upstream_base_url=${upstream},remote_solver_transfer_paused=false WHERE id=1`);
  await db.execute(
    sql`UPDATE sync_sweep_promises SET source_base_url=${upstream} WHERE id=${base.promiseId}::uuid`,
  );
  // This real ingestion fixture needs the same immutable setup fields as the
  // ordinary worker. Create a new revision; never mutate a sealed snapshot.
  const [revision] =
    await db.execute(sql`INSERT INTO simulation_preset_revisions
    (preset_id,revision_number,signature_hash,reynolds,mach,reference_length_m,solver_implementation_id,snapshot)
    SELECT preset_id,2,${randomUUID()},reynolds,mach,reference_length_m,solver_implementation_id,
      snapshot||jsonb_build_object('preset',jsonb_build_object('legacyBoundaryConditionId',${(job.bc_ids as string[])[0]}::text))
    FROM simulation_preset_revisions WHERE id=${job.simulation_preset_revision_id}::uuid RETURNING id`);
  await db.execute(sql`UPDATE sim_jobs SET simulation_preset_revision_id=${revision.id}::uuid,
    request_payload=request_payload||jsonb_build_object('upstreamBaseUrl',${upstream}::text,'engineRequest',${JSON.stringify(envelope.request)}::jsonb)
    WHERE id=${executionId}::uuid`);
  await db.execute(sql`INSERT INTO progressive_worker_submission_intents(sim_job_id,token,assignment_signature,"authorization")
    VALUES (${executionId}::uuid,${randomUUID()}::uuid,${envelope.contentSignature},${JSON.stringify({ kind: "authorized", executionId, contentSignature: envelope.contentSignature })}::jsonb)`);
  const result = progressiveRemoteEvidenceResult(envelope);
  result.polars[0].attempts![0].evidence_artifacts = [];
  result.polars[0].attempts![0].error =
    "diagnostic with quote ' and backslash \\";
  const scientific: ProgressiveRemoteReport = {
    version: 1,
    solverId,
    promiseId: base.promiseId,
    executionId,
    assignmentSignature: envelope.contentSignature,
    sequence: sourceSequence,
    status: {
      job_id: executionId,
      state: "running",
      total_cases: envelope.scope.units.length,
      completed_cases: 1,
    },
    result,
    stopProof: null,
  };
  const [terminal] =
    await db.execute(sql`SELECT report->'stopProof' AS proof FROM progressive_worker_reports
    WHERE sim_job_id=${executionId}::uuid ORDER BY sequence DESC LIMIT 1`);
  const append = async (
    sequence: number,
    input: {
      nullResult?: boolean;
      headerState?: "running" | "cancelled";
      mutate?: (report: ProgressiveRemoteReport) => void;
    } = {},
  ) => {
    const report = structuredClone(scientific);
    report.sequence = sequence;
    report.status.state = input.headerState ?? "running";
    if (inline)
      report.status.solver_budget_progress = {
        version: 1,
        job_id: executionId,
        observed_at: new Date(1700000000000 + sequence * 1000).toISOString(),
        cases: [
          {
            chord: envelope.request.chord_lengths![0],
            speed: envelope.request.speeds![0],
            aoa_deg: envelope.scope.units[0].alpha,
            solver_running: input.headerState !== "cancelled",
            limit_seconds: envelope.scope.units[0].activeBudgetSeconds,
            solver_active_seconds: sequence / 10,
          },
        ],
      };
    if (input.nullResult) {
      report.result = null;
      report.status.completed_cases = 0;
    }
    if (input.headerState === "cancelled")
      report.stopProof = terminal.proof as ProgressiveRemoteReport["stopProof"];
    input.mutate?.(report);
    const signature = analysisContentHash(report);
    await db.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,acknowledged_at)
      VALUES (${executionId}::uuid,${sequence},${signature},${JSON.stringify(report)}::jsonb,clock_timestamp())`);
    return { report, signature };
  };
  if (inline)
    await db.execute(
      sql`UPDATE progressive_report_storage_policy SET normalization_enabled=false WHERE id=1`,
    );
  for (let sequence = 3465; sequence <= 3509; sequence++)
    await append(sequence, {
      nullResult: sequence < 3473,
      headerState: sequence === 3509 ? "cancelled" : "running",
    });
  await db.execute(
    sql`UPDATE sim_jobs SET status='cancelled',engine_state='cancelled' WHERE id=${executionId}::uuid`,
  );
  expect(
    await stageProgressiveWorkerEvidence(db, noEngine, executionId, {
      reportSequence: sourceSequence,
    }),
  ).toMatchObject({ kind: "staged", sequence: sourceSequence });
  const associations = await db.execute(
    sql`SELECT * FROM progressive_worker_evidence_attempts WHERE sim_job_id=${executionId}::uuid AND sequence=${sourceSequence}`,
  );
  expect(associations).toHaveLength(1);
  for (const point of associations)
    await db.execute(sql`INSERT INTO progressive_worker_hub_receipts
    (sim_job_id,sequence,result_attempt_id,point_content_signature,receipt)
    VALUES (${executionId}::uuid,${sourceSequence},${point.result_attempt_id}::uuid,${point.point_content_signature},'{"kind":"retained-progressive-attempt"}'::jsonb)`);
  const volume = await mkdtemp(join(tmpdir(), "science-duplicate-volume-"));
  vi.stubEnv("AIRFOILFOAM_REPORT_VOLUME_DIR", volume);
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "remote-solver");
  installProgressiveReportArchiveReader({
    read: (identity) => readStoredWorkerArchiveText(db, identity),
  });
  return {
    ...base,
    instanceId,
    solverId,
    sourceSequence,
    append,
    volume,
    scientific,
  };
}

async function fixture(
  run: (f: Fixture) => Promise<void>,
  inline = false,
  angles = [0],
) {
  await withArchiveFixture(
    client,
    "worker",
    async (base) => {
      const f = await prepare(base, inline);
      try {
        await run(f);
      } finally {
        await rm(f.volume, { force: true, recursive: true });
      }
    },
    { reportCount: 1, normalized: true, angles },
  );
}

async function pageFor(f: Fixture, sequences: number[]) {
  const rows = await f.db
    .execute(sql`SELECT r.sequence,r.content_signature,to_jsonb(r.*)::text AS row_text,
    public.resolve_progressive_report(r.report,r.result_payload_hash)::text AS report_text
    FROM progressive_worker_reports r WHERE r.sim_job_id=${f.executionId}::uuid
      AND r.sequence IN (${sql.join(
        sequences.map((s) => sql`${s}`),
        sql`,`,
      )}) ORDER BY r.sequence`);
  const members: LegacyReportMember[] = [];
  for (const row of rows) {
    const sequence = Number(row.sequence),
      signature = String(row.content_signature);
    // Warm logical bodies remain SQL-owned. Cold bodies are read through the
    // installed normal product reader, not interpreted from compact headers.
    let reportText = String(row.report_text);
    if (JSON.parse(reportText).archivedReport === true) {
      const [stored] = await f.db
        .execute(sql`SELECT b.*,m.report_sha256,m.report_byte_size FROM progressive_report_archive_bundles b
        JOIN progressive_report_archive_members m ON m.bundle_id=b.id WHERE m.sim_job_id=${f.executionId}::uuid AND m.sequence=${sequence}
          AND m.source_kind='worker' AND m.member_kind='report'`);
      reportText = await readStoredWorkerArchiveText(f.db, {
        sourceKind: "worker",
        memberKind: "report",
        executionId: f.executionId,
        sequence,
        signature,
        reportSha256: String(stored.report_sha256),
        reportByteSize: Number(stored.report_byte_size),
        bucket: String(stored.bucket),
        objectKey: String(stored.object_key),
        generation: String(stored.generation),
        mimeType: String(stored.mime_type),
        compression: String(stored.compression),
        archiveFormat: String(stored.archive_format),
        storedSha256: String(stored.stored_sha256),
        storedByteSize: Number(stored.stored_byte_size),
        crc32c: String(stored.crc32c),
      });
    }
    members.push({
      kind: "report",
      executionId: f.executionId,
      sequence,
      solverId: f.solverId,
      contentSignature: signature,
      rowText: String(row.row_text),
      rowSha256: hash(String(row.row_text)),
      reportText,
      reportSha256: hash(reportText),
      reportByteSize: Buffer.byteLength(reportText),
    });
  }
  const page = {
    version: 1 as const,
    sourceInstance: f.instanceId,
    solverId: f.solverId,
    scopeSha256: hash(JSON.stringify([f.executionId, sequences])),
    members,
  };
  const packed = encodeLegacyPage({
    ...page,
    start: { execution: 0, kind: "report", after: 0, copied: 0 },
    next: {
      execution: 1,
      kind: "report",
      after: sequences.at(-1)!,
      copied: sequences.length,
    },
  }).bytes;
  const crc = new CRC32C();
  crc.update(packed);
  const object = {
    bucket: "duplicate-proof-test",
    objectKey: `legacy-worker-reports/v1/${f.instanceId}/${f.solverId}/${page.scopeSha256}/${hash(packed)}.jsonl.gz`,
    generation: "1795114887415319",
    sha256: hash(packed),
    byteSize: packed.length,
    crc32c: crc.toString(),
    verifiedAt: new Date().toISOString(),
  };
  await storeWorkerReportVolume(Readable.from([packed]), {
    storedSha256: object.sha256,
    storedByteSize: object.byteSize,
  });
  const verify = () =>
    verifyLegacyReportCustodyPage({
      page,
      object,
      access: {
        mode: "hub-local-reader",
        readHubObject: async () => Buffer.from(packed),
        reader: {
          readPage: (identity) =>
            readLegacyWorkerReportArchivePage(f.db, identity),
        },
      },
    });
  return { proof: await verify(), page, verify };
}
const apply = (f: Fixture, page: Awaited<ReturnType<typeof pageFor>>) =>
  applyLegacyReportCustodyPage(f.db, page.proof, {
    apply: true,
    readersReady: true,
  });
function boundPageLiteral(proof: Parameters<typeof legacyReportCustodySql>[0]) {
  const prefix = "SELECT public.register_legacy_report_archive_custody(";
  const statement = legacyReportCustodySql(proof)
    .split("\n")
    .find((line) => line.startsWith(prefix));
  if (!statement?.endsWith(")::text;"))
    throw new Error("Expected the verified PostgreSQL custody page");
  return sql.raw(statement.slice(prefix.length, -")::text;".length));
}
const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i);

async function protectedState(f: Fixture) {
  const state: Record<string, unknown> = {};
  for (const table of [
    "results",
    "result_attempts",
    "progressive_worker_evidence_receipts",
    "progressive_worker_evidence_attempts",
    "progressive_worker_hub_receipts",
    "progressive_worker_evidence_delivery_claims",
    "progressive_remote_reports",
    "progressive_remote_dispatches",
  ]) {
    state[table] = await f.db
      .execute(sql`SELECT to_jsonb(t.*)::text AS row FROM ${sql.identifier(table)} t
      WHERE t.sim_job_id=${f.executionId}::uuid ORDER BY to_jsonb(t.*)::text`);
  }
  state.job = await f.db.execute(
    sql`SELECT to_jsonb(t.*)::text AS row FROM sim_jobs t WHERE t.id=${f.executionId}::uuid`,
  );
  state.promise = await f.db.execute(
    sql`SELECT to_jsonb(t.*)::text AS row FROM sync_sweep_promises t WHERE t.id=${f.promiseId}::uuid`,
  );
  return state;
}

async function prepareBackground(f: Fixture) {
  await f.db.execute(
    sql`UPDATE sync_api_settings SET remote_solver_auth_token='disposable-test-token' WHERE id=1`,
  );
  // The real historical backlog already has a genuine final staging receipt.
  expect(
    await stageProgressiveWorkerEvidence(f.db, noEngine, f.executionId, {
      reportSequence: 3509,
    }),
  ).toMatchObject({ kind: "staged" });
}
const coveredRows = (f: Fixture) =>
  f.db
    .execute(sql`SELECT sequence::int,source_sequence::int,result_sha256,result_byte_size::int,point_signatures
  FROM progressive_worker_staging_copies WHERE sim_job_id=${f.executionId}::uuid ORDER BY sequence`);

it.each([true, false])(
  "the ordinary backlog drain covers only exact terminal snapshots without acquiring evidence leases (inline=%s)",
  async (inline) => {
    await fixture(async (f) => {
      await prepareBackground(f);
      const before = await protectedState(f);
      const claimed = vi.fn();
      for (const preferActive of [true, false]) {
        expect(
          await stageNextProgressiveWorkerEvidence(f.db, noEngine, {
            preferActive,
            afterEvidenceClaimed: claimed,
          }),
        ).toBe(true);
      }
      expect(
        await stageNextProgressiveWorkerEvidence(f.db, noEngine, {
          afterEvidenceClaimed: claimed,
        }),
      ).toBe(false);
      expect(claimed).not.toHaveBeenCalled();
      expect(
        await f.db.execute(progressiveStagingSelectionSql(false)),
      ).toHaveLength(0);
      expect(
        await f.db.execute(progressiveEvidenceWakeSql("staging", true)),
      ).toHaveLength(0);
      expect(
        (await f.db.execute(progressiveEvidenceWakeSql("staging", false)))[0]
          .wake_at,
      ).toBeNull();
      const rows = await coveredRows(f);
      expect(rows.map((r) => r.sequence)).toEqual(
        range(3473, 3508).filter((n) => n !== f.sourceSequence),
      );
      expect(new Set(rows.map((r) => r.source_sequence))).toEqual(
        new Set([f.sourceSequence]),
      );
      expect(new Set(rows.map((r) => r.result_sha256)).size).toBe(1);
      expect(await protectedState(f)).toEqual(before);
      // Explicit recovery still performs normal staging for the individual sequence.
      expect(
        await stageProgressiveWorkerEvidence(f.db, noEngine, f.executionId, {
          reportSequence: 3473,
        }),
      ).toMatchObject({ kind: "staged", sequence: 3473 });
    }, inline);
  },
);

it("restores ordinary staging eligibility when the genuine source point or its hub acknowledgement disappears", async () => {
  await fixture(async (f) => {
    await prepareBackground(f);
    await stageNextProgressiveWorkerEvidence(f.db, noEngine);
    expect((await coveredRows(f)).length).toBeGreaterThan(0);
    const [ack] = await f.db.execute(
      sql`DELETE FROM progressive_worker_hub_receipts WHERE sim_job_id=${f.executionId}::uuid RETURNING *`,
    );
    expect(await coveredRows(f)).toHaveLength(0);
    const claimed = vi.fn();
    expect(
      await stageNextProgressiveWorkerEvidence(f.db, noEngine, {
        afterEvidenceClaimed: claimed,
      }),
    ).toBe(true);
    expect(claimed).toHaveBeenCalledOnce();
    await f.db
      .execute(sql`INSERT INTO progressive_worker_hub_receipts(sim_job_id,sequence,result_attempt_id,point_content_signature,receipt)
      VALUES(${f.executionId}::uuid,${ack.sequence},${ack.result_attempt_id}::uuid,${ack.point_content_signature},${JSON.stringify(ack.receipt)}::jsonb)`);
    await stageNextProgressiveWorkerEvidence(f.db, noEngine);
    const rows = await coveredRows(f);
    expect(rows.length).toBeGreaterThan(0);
    await f.db.execute(
      sql`DELETE FROM progressive_worker_evidence_attempts WHERE sim_job_id=${f.executionId}::uuid AND sequence=${rows[0].source_sequence}`,
    );
    expect(await coveredRows(f)).toHaveLength(0);
  }, true);
});

it("replaces per-sequence terminal staging with one indexed proof page on the same original reports", async () => {
  await fixture(async (f) => {
    await prepareBackground(f);
    const original = await protectedState(f);
    await f.db.execute(sql`SAVEPOINT per_sequence_reference`);
    const start = performance.now();
    const sequences = range(3473, 3504).filter((n) => n !== f.sourceSequence);
    for (const n of sequences)
      expect(
        await stageProgressiveWorkerEvidence(f.db, noEngine, f.executionId, {
          reportSequence: n,
        }),
      ).toMatchObject({ kind: "staged", sequence: n });
    const oldMs = Math.round(performance.now() - start);
    await f.db.execute(sql`ROLLBACK TO SAVEPOINT per_sequence_reference`);
    await f.db.execute(sql`RELEASE SAVEPOINT per_sequence_reference`);
    expect(await protectedState(f)).toEqual(original);
    const fast = performance.now(),
      claim = vi.fn();
    expect(
      await stageNextProgressiveWorkerEvidence(f.db, noEngine, {
        afterEvidenceClaimed: claim,
      }),
    ).toBe(true);
    const proofMs = Math.round(performance.now() - fast);
    const rows = await coveredRows(f);
    expect(rows.map((r) => r.sequence)).toEqual(sequences);
    expect(claim).not.toHaveBeenCalled();
    const plan = await f.db
      .execute(sql`EXPLAIN (FORMAT JSON,COSTS OFF) SELECT 1 FROM public.progressive_worker_closed_staging_copies
      WHERE sim_job_id=${f.executionId}::uuid AND sequence=3473`);
    expect(JSON.stringify(plan)).toContain(
      "progressive_worker_staging_copies_pkey",
    );
    // This is the full selector with real covered copies. A single-key plan
    // above cannot catch an uncorrelated materialization in the outer query.
    for (const preferActive of [false, true]) {
      const [measured] = await f.db.execute(sql`EXPLAIN (ANALYZE,VERBOSE,BUFFERS,FORMAT JSON)
        ${progressiveStagingSelectionSql(preferActive)}`);
      const nodes = [(measured["QUERY PLAN"] as { Plan: Record<string, unknown> }[])[0].Plan];
      const proofScans = [];
      for (const node of nodes) {
        nodes.push(...((node.Plans ?? []) as Record<string, unknown>[]));
        if (node["Relation Name"] === "progressive_worker_staging_copies" && Number(node["Actual Loops"]) > 0)
          proofScans.push(node);
      }
      expect(proofScans.length).toBeGreaterThan(0);
      for (const scan of proofScans) {
        expect(scan["Index Name"]).toBe("progressive_worker_staging_copies_pkey");
        expect(String(scan["Index Cond"])).toMatch(/sim_job_id.*sequence/);
      }
    }
    expect(await protectedState(f)).toEqual(original);
    console.info(
      JSON.stringify({
        benchmark: "terminal-staging-copies",
        reports: sequences.length,
        oldMs,
        proofMs,
        oldLeases: sequences.length,
        newLeases: claim.mock.calls.length,
        newStagingReceipts: 0,
        newAttemptAssociations: 0,
      }),
    );
  }, true);
}, 120000);

it("uses an authenticated cold 0209 staged original and keeps a reopened promise eligible", async () => {
  await fixture(async (f) => {
    await prepareBackground(f);
    const p = await pageFor(f, [f.sourceSequence]);
    await apply(f, p);
    expect(await stageNextProgressiveWorkerEvidence(f.db, noEngine)).toBe(true);
    expect((await coveredRows(f)).length).toBeGreaterThan(0);
    await stageNextProgressiveWorkerEvidence(f.db, noEngine);
    expect(
      await f.db.execute(progressiveStagingSelectionSql(false)),
    ).toHaveLength(0);
    await f.db.execute(
      sql`UPDATE sync_sweep_promises SET status='active',"expiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${f.promiseId}::uuid`,
    );
    expect(
      await f.db.execute(progressiveStagingSelectionSql(true)),
    ).toHaveLength(1);
    const claim = vi.fn();
    expect(
      await stageNextProgressiveWorkerEvidence(f.db, noEngine, {
        preferActive: true,
        afterEvidenceClaimed: claim,
      }),
    ).toBe(true);
    expect(claim).toHaveBeenCalledOnce();
  });
});
it("invalidates existing coverage when a competing attempt appears on another staged sequence", async () => {
  await fixture(async (f) => {
    await prepareBackground(f);
    await stageNextProgressiveWorkerEvidence(f.db, noEngine);
    expect((await coveredRows(f)).length).toBeGreaterThan(0);
    await f.db
      .execute(sql`INSERT INTO progressive_worker_evidence_attempts(sim_job_id,sequence,result_attempt_id,point_content_signature)
      SELECT sim_job_id,3509,${f.attemptId}::uuid,point_content_signature FROM progressive_worker_evidence_attempts
      WHERE sim_job_id=${f.executionId}::uuid AND sequence=${f.sourceSequence}`);
    expect(await coveredRows(f)).toEqual([]);
    expect(
      await f.db.execute(progressiveStagingSelectionSql(false)),
    ).toHaveLength(1);
  });
});
it("routes new AoA progress, changed coefficients and new failed evidence through the normal lease", async () => {
  await fixture(
    async (f) => {
      await prepareBackground(f);
      await stageNextProgressiveWorkerEvidence(f.db, noEngine);
      await stageNextProgressiveWorkerEvidence(f.db, noEngine);
      await f.append(3510, {
        mutate: (r) => {
          r.status.completed_cases = 2;
          const next = structuredClone(r.result!.polars[0].attempts![0]);
          next.aoa_deg = 1;
          next.case_slug = "second-reported-case";
          r.result!.polars[0].attempts!.push(next);
        },
      });
      await f.append(3511, {
        mutate: (r) => {
          r.result!.polars[0].attempts![0].cl = 0.4001;
        },
      });
      await f.append(3512, {
        mutate: (r) => {
          r.result!.polars[0].attempts![0].error =
            "different measured rejection";
        },
      });
      await f.append(3513, {
        mutate: (r) => {
          r.status.solver_budget_progress!.cases.push({
            ...r.status.solver_budget_progress!.cases[0],
            aoa_deg: 1,
            solver_active_seconds: 0,
          });
        },
      });
      await f.append(3514, { headerState: "cancelled" });
      // The terminal head is staged first. All three different histories must
      // reach their own ingestion lease even if ingest rejects a conflicting solve.
      await stageProgressiveWorkerEvidence(f.db, noEngine, f.executionId, {
        reportSequence: 3514,
      });
      const newAngle = vi.fn();
      expect(
        await stageNextProgressiveWorkerEvidence(f.db, noEngine, {
          afterEvidenceClaimed: newAngle,
        }),
      ).toBe(true);
      expect(newAngle).toHaveBeenCalledOnce();
      const [added] = await f.db
        .execute(sql`SELECT a.aoa_deg,a.status,a.valid_for_polar FROM progressive_worker_evidence_attempts s
      JOIN result_attempts a ON a.id=s.result_attempt_id WHERE s.sim_job_id=${f.executionId}::uuid AND s.sequence=3510 AND a.aoa_deg=1`);
      expect(added).toMatchObject({ aoa_deg: 1, valid_for_polar: false });
      for (let n = 3511; n <= 3513; n++) {
        const lease = vi.fn(async () => {
          throw new Error("observed ordinary lease " + n);
        });
        await expect(
          stageNextProgressiveWorkerEvidence(f.db, noEngine, {
            afterEvidenceClaimed: lease,
          }),
        ).rejects.toThrow("observed ordinary lease " + n);
        expect(lease).toHaveBeenCalledOnce();
      }
      expect(
        (await coveredRows(f)).every((r) => Number(r.sequence) < 3510),
      ).toBe(true);
    },
    true,
    [0, 1],
  );
});

it("checks every staged envelope against its own warm status before reusing shared result text", async () => {
  await fixture(async (f) => {
    const second = 3510;
    await f.append(second, {
      mutate(report) {
        Object.assign(report.status, {
          diagnostics: { result: null, 'quoted "key"': ["á", "result", 0.125] },
        });
      },
    });
    await f.append(second + 1, { headerState: "cancelled" });
    expect(await stageProgressiveWorkerEvidence(f.db, noEngine, f.executionId, {
      reportSequence: second,
    })).toMatchObject({ kind: "staged", sequence: second });
    const before = await protectedState(f);
    const sources = await pageFor(f, [f.sourceSequence, second]);
    const [decoded] = await f.db.execute(sql`SELECT ${boundPageLiteral(sources.proof)} AS page`);
    const claimed = decoded.page as {
      scientificResults: { resultText: string; reports: { sequence: number; envelopeText: string }[] }[];
      members: { sequence: number; reportSha256: string; reportByteSize: number }[];
    };
    expect(claimed.scientificResults).toHaveLength(1);
    const [group] = claimed.scientificResults;
    expect(group.reports.map((r) => r.sequence)).toEqual([f.sourceSequence, second]);

    // The altered status and its claimed full-body digest agree. Only a comparison
    // with the second warm source distinguishes the forged envelope from its original.
    const altered = group.reports[1];
    const [text] = await f.db.execute(sql`
      SELECT env::text AS envelope, jsonb_set(env,'{result}',${group.resultText}::jsonb,false)::text AS body
      FROM (SELECT jsonb_set(${altered.envelopeText}::jsonb,'{status,diagnostics,result}','1.00'::jsonb,false) env) changed`);
    altered.envelopeText = String(text.envelope);
    const member = claimed.members.find((row) => row.sequence === second)!;
    const alteredHash = hash(String(text.body));
    expect(alteredHash).not.toBe(member.reportSha256);
    member.reportSha256 = alteredHash;
    member.reportByteSize = Buffer.byteLength(String(text.body));
    await expect(f.db.transaction((tx) => tx.execute(sql`
      SELECT * FROM verified_worker_report_science_sources(${f.executionId}::uuid,${JSON.stringify(claimed)}::jsonb)`)))
      .rejects.toThrow("Warm scientific source differs from staged body");

    expect(await apply(f, sources)).toMatchObject({
      receipt: { compactedReports: 2, registeredMembers: 2, skipped: [] },
    });
    const witness = await f.db.execute(sql`SELECT sequence::integer AS sequence, report_sha256 AS digest
      FROM progressive_worker_report_science_proofs WHERE sim_job_id=${f.executionId}::uuid ORDER BY sequence`);
    expect(witness).toEqual(sources.page.members.map((row) => ({ sequence: row.sequence, digest: row.reportSha256 })));
    const cold = await pageFor(f, [f.sourceSequence, second]);
    expect(cold.page.members.map((row) => row.reportText)).toEqual(sources.page.members.map((row) => row.reportText));
    expect(await apply(f, cold)).toMatchObject({receipt: { compactedReports: 0, replayedMembers: 2 }});
    expect(await protectedState(f)).toEqual(before);
  });
});

it("checks each signed envelope and preserves a one-sample history change on repeated normalized results", async () => {
  await fixture(async (f) => {
    const sequences = [3510, 3511, 3512, 3513];
    for (const sequence of sequences) {
      await f.append(sequence, {
        mutate(report) {
          const times = Array.from({ length: 400 }, (_, i) => i / 40);
          const cl = times.map(() => 0.42);
          if (sequence === 3513) cl[399] = 0.420001;
          Object.assign(report.result!.polars[0].attempts![0], {
            force_history: { t: times, cl, cd: times.map(() => 0.03) },
          });
          if (sequence === 3512)
            Object.assign(report.status, { diagnostics: { result: null } });
        },
      });
    }
    const whole = await pageFor(f, sequences);
    type Group = {
      resultText: string;
      resultSha256: string;
      resultByteSize: number;
      pointSignatures: string[];
      reports: {
        sequence: number;
        contentSignature: string;
        envelopeText: string;
      }[];
    };
    async function scientificSql(proof: typeof whole.proof): Promise<Group[]> {
      const [decoded] = await f.db.execute(sql`SELECT ${boundPageLiteral(proof)} AS page`);
      return (decoded.page as { scientificResults: Group[] }).scientificResults;
    }
    const joined = await scientificSql(whole.proof);
    expect(joined.map((x) => x.reports.map((r) => r.sequence))).toEqual([
      [3510, 3511, 3512],
      [3513],
    ]);
    for (const member of whole.page.members) {
      const stored = JSON.parse(member.rowText);
      expect(member.rowText.length).toBeLessThan(member.reportText.length);
      const group = joined.find((g) =>
        g.reports.some((r) => r.sequence === member.sequence),
      )!;
      expect(stored.result_payload_hash).toBe(group.resultSha256);
      const [single] = await scientificSql(
        (await pageFor(f, [member.sequence])).proof,
      );
      expect({
        ...group,
        reports: group.reports.filter((r) => r.sequence === member.sequence),
      }).toEqual(single);
      const envelope = single.reports[0];
      const [reconstructed] = await f.db.execute(
        sql`SELECT jsonb_set(${envelope.envelopeText}::jsonb,'{result}',${single.resultText}::jsonb,false)::text AS body`,
      );
      expect(reconstructed.body).toBe(member.reportText);
    }

    const member = whole.page.members[1],
      original = { ...member };
    member.contentSignature = "f".repeat(64);
    member.rowText = member.rowText.replace(
      `"content_signature": "${original.contentSignature}"`,
      `"content_signature": "${member.contentSignature}"`,
    );
    member.rowSha256 = hash(member.rowText);
    await expect(whole.verify()).rejects.toThrow("canonical signature");
    Object.assign(member, original);
    // A changed canonical prefix may not borrow the prior hash midstate,
    // even when the result, suffix, and stored original-row hint all match.
    const prefix = `"assignmentSignature": "${f.scientific.assignmentSignature}"`;
    const foreignPrefix = `"assignmentSignature": "${"e".repeat(64)}"`;
    member.rowText = member.rowText.replace(prefix, foreignPrefix);
    member.reportText = member.reportText.replace(prefix, foreignPrefix);
    expect(member.rowText).not.toBe(original.rowText);
    expect(member.reportText).not.toBe(original.reportText);
    member.reportSha256 = hash(member.reportText);
    member.rowSha256 = hash(member.rowText);
    await expect(whole.verify()).rejects.toThrow("canonical signature");
    Object.assign(member, original);
    // Keep the normalized row/hash hint but change the actual restored result.
    member.reportText = member.reportText.replace("0.42", "0.43");
    expect(member.reportText).not.toBe(original.reportText);
    Object.assign(member, {
      reportSha256: hash(member.reportText),
      reportByteSize: Buffer.byteLength(member.reportText),
    });
    await expect(whole.verify()).rejects.toThrow("canonical signature");
  });
});

it("reclaims all 36 original-page duplicates using an already-cold genuinely staged source, preserving scientific identities", async () => {
  await fixture(async (f) => {
    await f.append(3464); // Another real report still references this exact shared result.
    const originalPage = await pageFor(f, range(3465, 3509));
    const duplicates = range(3473, 3509).filter(
      (sequence) => sequence !== f.sourceSequence,
    );
    const oldMigration = await readFile(
      new URL(
        "../migrations/0205_legacy_report_archive_members.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const newMigration = await readFile(
      new URL(
        "../migrations/0209_reconstructible_worker_report_duplicates.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await f.db.execute(
      sql.raw(
        oldMigration
          .slice(
            oldMigration.indexOf(
              "CREATE FUNCTION register_legacy_report_archive_custody",
            ),
          )
          .replace(
            "CREATE FUNCTION register_",
            "CREATE OR REPLACE FUNCTION register_",
          ),
      ),
    );
    expect(await apply(f, originalPage)).toMatchObject({
      receipt: {
        compactedReports: 9,
        registeredMembers: 9,
        skipped: duplicates.map((sequence) =>
          expect.objectContaining({ sequence, reason: "report_not_staged" }),
        ),
      },
    });
    // Recreate the actual deployed starting state with the real old function.
    // No immutability trigger is disabled and no proof row is deleted.
    expect(
      await f.db
        .execute(sql`SELECT sequence FROM progressive_worker_report_science_proofs
      WHERE sim_job_id=${f.executionId}::uuid`),
    ).toEqual([]);
    await f.db.execute(
      sql.raw(
        newMigration.slice(
          newMigration.indexOf(
            "CREATE OR REPLACE FUNCTION register_legacy_report_archive_custody",
          ),
        ),
      ),
    );
    originalPage.proof = await originalPage.verify();
    const before = await protectedState(f);
    // Exercise the operator's SQL text entry point with the same original page.
    const operatorSql = legacyReportCustodySql(originalPage.proof, {
      apply: true,
      readersReady: true,
    });
    const registration = operatorSql
      .split("\n")
      .find((line) => line.startsWith("SELECT public.register_"))!;
    const [outcome] = await f.db.execute(sql.raw(registration));
    const receipt = JSON.parse(String(Object.values(outcome)[0]));
    expect(
      receipt.changedMembers.map((row: { sequence: number }) => row.sequence),
    ).toEqual(duplicates);
    expect({ receipt }).toMatchObject({
      receipt: {
        duplicateReports: 36,
        compactedReports: 36,
        replayedMembers: 9,
        registeredBundles: 0,
        registeredMembers: 36,
        changedMembers: duplicates.map((sequence) =>
          expect.objectContaining({
            sequence,
            scientificSource: expect.objectContaining({
              stagedSequence: f.sourceSequence,
            }),
          }),
        ),
        prunedSharedPayloads: 0,
        prunedSharedPayloadBytes: 0,
        skipped: [],
      },
    });
    expect(await protectedState(f)).toEqual(before);
    for (const member of originalPage.page.members) {
      const restored = await readProgressiveReport(f.db, {
        sourceKind: "worker",
        executionId: f.executionId,
        sequence: member.sequence,
        contentSignature: member.contentSignature,
      });
      expect(
        hash(canonicalReportJson(parseReportJson(member.reportText))),
      ).toBe(member.contentSignature);
      expect(analysisContentHash(restored)).toBe(member.contentSignature);
      expect(analysisContentHash(restored.result)).toBe(
        analysisContentHash(JSON.parse(member.reportText).result),
      );
    }
    expect(await apply(f, originalPage)).toMatchObject({
      receipt: {
        compactedReports: 0,
        replayedMembers: 45,
        prunedSharedPayloads: 0,
      },
    });
  });
});

it("revisits earlier pages safely once a later page authenticates the genuine staged source", async () => {
  await fixture(async (f) => {
    const early = await pageFor(f, range(3473, 3475));
    const before = await protectedState(f);
    expect(await apply(f, early)).toMatchObject({
      receipt: {
        compactedReports: 0,
        skipped: range(3473, 3475).map((sequence) =>
          expect.objectContaining({ sequence, reason: "report_not_staged" }),
        ),
      },
    });
    await apply(f, await pageFor(f, [f.sourceSequence]));
    expect(await apply(f, early)).toMatchObject({
      receipt: {
        duplicateReports: 3,
        compactedReports: 3,
        prunedSharedPayloads: 0,
        skipped: [],
      },
    });
    expect(await protectedState(f)).toEqual(before);
  });
});

it("keeps a payload across pages and deletes only its known last reference; unrelated unreferenced science stays intact", async () => {
  await fixture(async (f) => {
    const [payload] = await f.db.execute(
      sql`SELECT r.result_payload_hash AS hash,p.byte_size FROM progressive_worker_reports r JOIN progressive_report_result_payloads p ON p.content_hash=r.result_payload_hash WHERE r.sim_job_id=${f.executionId}::uuid AND r.sequence=3473`,
    );
    const [orphan] = await f.db.execute(
      sql`SELECT public.store_progressive_report_result(${JSON.stringify({ unrelated: randomUUID(), polars: [] })}::jsonb) AS hash`,
    );
    const before = await protectedState(f);
    await apply(f, await pageFor(f, [f.sourceSequence]));
    const remaining = range(3473, 3509).filter((s) => s !== f.sourceSequence);
    let lastPage: Awaited<ReturnType<typeof pageFor>> | undefined;
    for (let start = 0; start < remaining.length; start += 7) {
      lastPage = await pageFor(f, remaining.slice(start, start + 7));
      const last = start + 7 >= remaining.length;
      expect(await apply(f, lastPage)).toMatchObject({
        receipt: {
          duplicateReports: Math.min(7, remaining.length - start),
          prunedSharedPayloads: last ? 1 : 0,
          prunedSharedPayloadBytes: last ? Number(payload.byte_size) : 0,
          skipped: [],
        },
      });
      expect(
        await f.db.execute(
          sql`SELECT content_hash FROM progressive_report_result_payloads WHERE content_hash=${payload.hash}`,
        ),
      ).toHaveLength(last ? 0 : 1);
    }
    expect(
      await f.db.execute(
        sql`SELECT content_hash FROM progressive_report_result_payloads WHERE content_hash=${orphan.hash}`,
      ),
    ).toHaveLength(1);
    expect(await apply(f, lastPage!)).toMatchObject({
      receipt: { prunedSharedPayloads: 0 },
    });
    expect(await protectedState(f)).toEqual(before);
    // Normal future staging of a cold duplicate reuses the same attempt IDs.
    const scienceBefore = await f.db.execute(
      sql`SELECT to_jsonb(t.*)::text AS row FROM result_attempts t WHERE t.sim_job_id=${f.executionId}::uuid ORDER BY t.id`,
    );
    expect(
      await stageProgressiveWorkerEvidence(f.db, noEngine, f.executionId, {
        reportSequence: remaining[0],
      }),
    ).toMatchObject({ kind: "staged" });
    expect(
      await f.db.execute(
        sql`SELECT to_jsonb(t.*)::text AS row FROM result_attempts t WHERE t.sim_job_id=${f.executionId}::uuid ORDER BY t.id`,
      ),
    ).toEqual(scienceBefore);
  });
});

it.each([
  "changed-point",
  "different-result-status",
  "different-envelope",
  "different-status-owner",
  "different-older-shape",
  "missing-source-attempt",
  "ambiguous-source-attempt",
  "no-staged-source",
] as const)(
  "retains genuinely different or missing evidence: %s",
  async (reason) => {
    await fixture(async (f) => {
      if (reason !== "no-staged-source")
        await apply(f, await pageFor(f, [f.sourceSequence]));
      // New immutable snapshots exercise changes; no stored report/result is edited.
      const changedSnapshot =
        reason.startsWith("different") || reason === "changed-point";
      const candidateSequence = changedSnapshot ? 3510 : 3505;
      if (changedSnapshot) {
        // Append below a later real final stop, then preserve closed ownership.
        await f.append(3510, {
          mutate: (r) => {
            if (reason === "changed-point")
              r.result!.polars[0].attempts![0].cl = 0.4001;
            if (reason === "different-result-status")
              r.result!.state = "failed";
            if (reason === "different-status-owner")
              r.status.job_id = randomUUID();
            if (reason === "different-older-shape")
              Reflect.deleteProperty(r.result!, "polars");
            if (reason === "different-envelope")
              (r as unknown as Record<string, unknown>).extraIdentity =
                "changed";
          },
        });
        await f.append(3511, { headerState: "cancelled" });
      }
      if (reason === "missing-source-attempt")
        await f.db.execute(
          sql`DELETE FROM progressive_worker_evidence_attempts WHERE sim_job_id=${f.executionId}::uuid AND sequence=${f.sourceSequence}`,
        );
      if (reason === "ambiguous-source-attempt")
        await f.db.execute(sql`INSERT INTO progressive_worker_evidence_attempts
          (sim_job_id,sequence,result_attempt_id,point_content_signature)
          SELECT sim_job_id,sequence,${f.attemptId}::uuid,point_content_signature
          FROM progressive_worker_evidence_attempts WHERE sim_job_id=${f.executionId}::uuid AND sequence=${f.sourceSequence}`);
      const page = await pageFor(f, [candidateSequence]);
      const before = await protectedState(f);
      expect(await apply(f, page)).toMatchObject({
        receipt: {
          compactedReports: 0,
          prunedSharedPayloads: 0,
          skipped: [expect.objectContaining({ reason: "report_not_staged" })],
        },
      });
      expect(await protectedState(f)).toEqual(before);
    });
  },
);

it("recognizes an inline duplicate through its exact result text", async () => {
  await fixture(async (f) => {
    await apply(f, await pageFor(f, [f.sourceSequence]));
    await f.db.execute(
      sql`UPDATE progressive_report_storage_policy SET normalization_enabled=false WHERE id=1`,
    );
    await f.append(3510, { headerState: "cancelled" });
    const [row] = await f.db
      .execute(sql`SELECT result_payload_hash FROM progressive_worker_reports
      WHERE sim_job_id=${f.executionId}::uuid AND sequence=3510`);
    expect(row.result_payload_hash).toBeNull();
    expect(await apply(f, await pageFor(f, [3510]))).toMatchObject({
      receipt: {
        compactedReports: 1,
        duplicateReports: 1,
        prunedSharedPayloads: 0,
        skipped: [],
      },
    });
  });
});

it("honors hub report references and does not prune an unrelated or replay-only unreferenced payload", async () => {
  await fixture(async (f) => {
    const [source] = await f.db
      .execute(sql`SELECT public.resolve_progressive_report(report,result_payload_hash) AS report,result_payload_hash
      FROM progressive_worker_reports WHERE sim_job_id=${f.executionId}::uuid AND sequence=${f.sourceSequence}`);
    const hubReport = {
      ...(source.report as Record<string, unknown>),
      sequence: 9000,
    };
    const [job] = await f.db
      .execute(sql`SELECT request_payload->'remoteProgressiveExecution' AS envelope
      FROM sim_jobs WHERE id=${f.executionId}::uuid`);
    const envelope = job.envelope as ProgressiveRemoteExecutionEnvelope;
    // A hub reference needs its actual transport ownership graph. This local
    // fixture adds no scientific result or point and rolls back in full.
    await f.db
      .execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,cpu_slots,content_signature,envelope)
      VALUES (${f.executionId}::uuid,${f.promiseId}::uuid,${f.solverId}::uuid,1,${envelope.contentSignature},${JSON.stringify(envelope)}::jsonb)`);
    await f.db
      .execute(sql`INSERT INTO progressive_remote_reports(sim_job_id,sequence,content_signature,report)
      VALUES (${f.executionId}::uuid,9000,${analysisContentHash(hubReport)},${JSON.stringify(hubReport)}::jsonb)`);
    const page = await pageFor(f, range(3465, 3509));
    const before = await protectedState(f);
    expect(await apply(f, page)).toMatchObject({
      receipt: {
        duplicateReports: 36,
        compactedReports: 45,
        prunedSharedPayloads: 0,
      },
    });
    expect(
      await f.db.execute(
        sql`SELECT content_hash FROM progressive_report_result_payloads WHERE content_hash=${source.result_payload_hash}`,
      ),
    ).toHaveLength(1);
    expect(await protectedState(f)).toEqual(before);
    expect(await apply(f, page)).toMatchObject({
      receipt: {
        compactedReports: 0,
        replayedMembers: 45,
        prunedSharedPayloads: 0,
      },
    });
  });
});
