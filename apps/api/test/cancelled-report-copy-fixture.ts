import { CRC32C } from "@google-cloud/storage";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import {
  acknowledgeProgressiveCfdExecutionStop,
  storeProgressiveRemoteReport,
  type DB,
  type ProgressiveRemoteEvidenceDelivery,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import { prepareProgressiveRemoteEvidence, resolveProgressiveRemoteEvidence } from "@aerodb/db/progressive-remote-evidence";
import { readProgressiveRemoteRetention } from "@aerodb/db/progressive-remote-retention";
import { resolveProgressiveReportedPoint } from "@aerodb/db/progressive-remote-report";
import {
  readProgressiveReportArchiveText,
  verifyProgressiveReportArchive,
} from "@aerodb/db/progressive-report-archive";
import {
  installProgressiveReportArchiveReader,
  recheckRemoteReportMember, verifiedProgressiveReportMember,
  readProgressiveReport,
} from "@aerodb/db/progressive-report-reader";
import { nextCancelledReportCopies } from "../../sweeper/src/cancelled-report-copies";
import { applyProgressiveRemoteProgress } from "../../sweeper/src/progressive-remote-progress";
import { archiveProgressiveReportBatch } from "../../sweeper/src/progressive-report-archive-service";
import type { importPolarPush } from "../src/sync-routes";

// The caller has already delivered the original physical attempt and bound its
// raw archive through the registered API. All changes roll back with that fixture.
export async function verifyCancelledReportCopyReplay(
  db: DB,
  app: FastifyInstance,
  token: string,
  payload: Parameters<typeof importPolarPush>[0],
  delivery: ProgressiveRemoteEvidenceDelivery,
) {
  const id = delivery.engineJobId;
  const anchorSequence = delivery.progressiveEvidence.sequence;
  const anchor = await readProgressiveReport(db, {
    sourceKind: "remote",
    executionId: id,
    sequence: anchorSequence,
    contentSignature: delivery.progressiveEvidence.reportContentSignature,
  });
  expect(anchor.result!.polars[0].attempts![0].force_history?.t).toHaveLength(
    3,
  );
  const sender = {
    executionId: id,
    solverId: delivery.solverId,
    promiseId: delivery.promiseId,
  };
  const copy: ProgressiveRemoteReport = {
    ...anchor,
    sequence: anchorSequence + 1,
  };
  const copyReceipt = await storeProgressiveRemoteReport(db, {
    ...sender,
    report: copy,
  });
  const gap = structuredClone(copy);
  gap.sequence++;
  const [sibling] =
    await db.execute(sql`SELECT aoa_deg FROM sync_sweep_promise_points
    WHERE promise_id=${delivery.promiseId}::uuid AND aoa_deg<>${delivery.aoaDeg} ORDER BY aoa_deg LIMIT 1`);
  expect(
    sibling,
    "The unresolved source must be a second real assigned cell",
  ).toBeDefined();
  const point = structuredClone(gap.result!.polars[0].attempts![0]);
  point.aoa_deg = Number(sibling.aoa_deg);
  point.case_slug = point.case_slug + "-late";
  gap.result!.polars[0].attempts!.push(point);
  gap.status.completed_cases = 2;
  const manifest = point.evidence_artifacts!.find(
    (artifact) => artifact.kind === "manifest",
  )!;
  manifest.sha256 = "f".repeat(64);
  const gapReceipt = await storeProgressiveRemoteReport(db, {
    ...sender,
    report: gap,
  });
  const final = structuredClone(gap);
  final.sequence++;
  final.status.state = "failed";
  final.result!.state = "failed";
  for (const progress of final.status.solver_budget_progress?.cases ?? [])
    progress.solver_running = false;
  final.stopProof = {
    version: 1,
    job_id: id,
    execution_stopped: true,
    producer_stopped: true,
    namespace_verified: true,
    remaining: [],
    observed_at: new Date().toISOString(),
    error: null,
    fence: "terminal_result",
    ownership_basis: "recorded_execution_namespace",
  };
  await storeProgressiveRemoteReport(db, { ...sender, report: final });
  for (let i = 0; i < final.sequence; i++)
    await applyProgressiveRemoteProgress(db, id);
  await acknowledgeProgressiveCfdExecutionStop(db, {
    simJobId: id,
    proof: final.stopProof,
  });
  await db.execute(sql`UPDATE sim_jobs SET status='cancelled',engine_state='failed',"ingestedAt"=NULL,
    error='Scheduling promise became inactive; evidence delivery remains unresolved' WHERE id=${id}::uuid`);
  await db.execute(
    sql`UPDATE progressive_cfd_attempts SET outcome='cancelled' WHERE sim_job_id=${id}::uuid`,
  );
  const latePoint = {
    ...payload.results[0],
    progressiveEvidence: {
      ...delivery.progressiveEvidence,
      sequence: copy.sequence,
      reportContentSignature: copyReceipt.contentSignature,
    },
  };
  const post = (item = latePoint) =>
    app.inject({
      method: "POST",
      url: "/api/sync/v1/polars",
      headers: { "x-xfoilfoam-solver-token": token },
      payload: { ...payload, results: [item] },
    });
  const state = () =>
    db.execute(sql`SELECT j.status,j."ingestedAt",p.status AS promise,
    (SELECT count(*)::int FROM progressive_remote_evidence_receipts WHERE sim_job_id=j.id) AS receipts,
    (SELECT count(*)::int FROM result_attempts WHERE engine_job_id=j.id::text) AS attempts,
    (SELECT count(*)::int FROM results cell JOIN result_attempts selected ON selected.id=cell.current_result_attempt_id
       WHERE selected.engine_job_id=j.id::text) AS published,
    (SELECT count(*)::int FROM sync_sweep_promise_points WHERE promise_id=p.id AND status='fulfilled') AS fulfilled
    FROM sim_jobs j JOIN progressive_remote_dispatches d ON d.sim_job_id=j.id
    JOIN sync_sweep_promises p ON p.id=d.promise_id WHERE j.id=${id}::uuid`);
  const before = await state();
  expect(before[0]).toMatchObject({
    status: "cancelled",
    ingestedAt: null,
    promise: "cancelled",
    receipts: 1,
    attempts: 1,
    published: 0,
    fulfilled: 0,
  });
  const waiting = await readProgressiveRemoteRetention(db, id);
  expect(waiting).toMatchObject({
    kind: "waiting",
    reason: "raw_evidence",
    pendingCount: 1,
  });
  const warm = await post();
  expect(warm.statusCode, warm.body).toBe(200);
  const warmBody = warm.json();
  expect(warmBody.fulfilledAoas).toEqual([]);
  expect(warmBody.progressiveEvidenceReceipts[0].sequence).toBe(anchorSequence);
  const page = await nextCancelledReportCopies(db, {
    executionId: id,
    sequence: anchorSequence - 1,
  });
  expect(page.executionId).toBe(id);
  expect(page.sequences).toEqual([copy.sequence]);
  const [original] =
    await db.execute(sql`SELECT public.resolve_progressive_report(report,result_payload_hash)::text AS text
    FROM progressive_remote_reports WHERE sim_job_id=${id}::uuid AND sequence=${copy.sequence}`);
  let bytes = Buffer.alloc(0);
  const put: Parameters<typeof archiveProgressiveReportBatch>[3] = async (
    path,
    local,
  ) => {
    bytes = Buffer.from(await readFile(path));
    const checksum = new CRC32C();
    checksum.update(bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(local.sha256);
    const identity = {
      bucket: "disposable-hub",
      objectKey: `reports/${local.sha256}.gz`,
      generation: "9007199254740993123",
      mimeType: "application/gzip" as const,
      compression: "gzip" as const,
      archiveFormat: "jsonl" as const,
      storedSha256: local.sha256,
      storedByteSize: bytes.byteLength,
      crc32c: checksum.toString(),
      verifiedAt: new Date(),
    };
    await verifyProgressiveReportArchive(Readable.from([bytes]), identity);
    return identity;
  };
  expect(
    await archiveProgressiveReportBatch(
      db,
      "remote",
      id,
      async (...args) => {
        const stored = await put(...args);
        await db.execute(sql`UPDATE sim_jobs SET ingest_lease_token='late-report-fixture',
      ingest_lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=${id}::uuid`);
        return stored;
      },
      page.sequences,
    ),
  ).toBe(0);
  await db.execute(
    sql`UPDATE sim_jobs SET ingest_lease_token=NULL,ingest_lease_expires_at=NULL WHERE id=${id}::uuid`,
  );
  const count = await archiveProgressiveReportBatch(db, "remote", id, put, [
    anchorSequence,
    copy.sequence,
    gap.sequence,
    final.sequence,
  ]);
  expect(count).toBe(1);
  const cold =
    await db.execute(sql`SELECT sequence::int AS seq FROM progressive_remote_reports
    WHERE sim_job_id=${id}::uuid AND archived_at IS NOT NULL ORDER BY sequence`);
  expect(cold).toEqual([{ seq: copy.sequence }]);
  expect(
    await archiveProgressiveReportBatch(db, "remote", id, put, page.sequences),
  ).toBe(0);
  let reads = 0;
  try {
    installProgressiveReportArchiveReader({
      read: async (ref) => {
        expect(ref.sequence).toBe(copy.sequence);
        expect(ref.signature).toBe(copyReceipt.contentSignature);
        const text = await readProgressiveReportArchiveText(
          Readable.from([bytes]),
          ref,
        );
        expect(text).toBe(original.text);
        reads++;
        return text;
      },
    });
    const replay = await post();
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json().progressiveEvidenceReceipts).toEqual(
      warmBody.progressiveEvidenceReceipts,
    );
    expect(replay.json().progressiveArchiveReceipts).toEqual(
      warmBody.progressiveArchiveReceipts,
    );
    expect(replay.json().fulfilledAoas).toEqual([]);
    expect(reads).toBe(1);
    const reference = { ...delivery, progressiveEvidence: { ...latePoint.progressiveEvidence } };
    const selected = await prepareProgressiveRemoteEvidence(db, reference);
    expect(selected?.contentSignature).toBe(delivery.progressiveEvidence.pointContentSignature);
    const rechecked = await resolveProgressiveRemoteEvidence(db, reference);
    expect(rechecked!.report).toBe(selected!.report);
    expect(Object.isFrozen(rechecked!.point)).toBe(true);
    const archived = await readProgressiveReport(db, {
      sourceKind: "remote", executionId: id, sequence: copy.sequence, contentSignature: copyReceipt.contentSignature,
    });
    const pin = verifiedProgressiveReportMember(archived)!;
    expect(await recheckRemoteReportMember(db, pin)).toBe(true);
    for (const changed of [{ generation: String(BigInt(pin.identity.generation) - 1n) },
      { reportSha256: "0".repeat(64) }, { reportByteSize: pin.identity.reportByteSize + 1 }]) {
      expect(await recheckRemoteReportMember(db, { ...pin, identity: { ...pin.identity, ...changed } })).toBe(false);
    }
    const preparedReads = reads;
    for (const changed of [
      { ...reference, engineCaseSlug: "foreign-solver-case" },
      { ...reference, aoaDeg: reference.aoaDeg + 0.25 },
      { ...reference, solverId: randomUUID() },
    ]) {
      await expect(resolveProgressiveRemoteEvidence(db, changed)).rejects.toThrow();
    }
    expect(reads).toBe(preparedReads);
    expect(
      (
        await readProgressiveReport(db, {
          sourceKind: "remote",
          executionId: id,
          sequence: copy.sequence,
          contentSignature: copyReceipt.contentSignature,
        })
      ).result!.polars[0].attempts![0].force_history,
    ).toEqual(anchor.result!.polars[0].attempts![0].force_history);
    expect(
      (await post({ ...latePoint, remoteResultAttemptId: randomUUID() }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await post({
          ...latePoint,
          progressiveEvidence: {
            ...latePoint.progressiveEvidence,
            pointContentSignature: "0".repeat(64),
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(await readProgressiveRemoteRetention(db, id)).toEqual(waiting);
    bytes = Buffer.from("corrupt compressed generation");
    expect((await post()).statusCode).toBeGreaterThanOrEqual(400);
    installProgressiveReportArchiveReader(null);
    expect((await post()).statusCode).toBeGreaterThanOrEqual(400);
    expect(await state()).toEqual(before);

    // A real later delivery may account for the missing attempt. Its declared
    // raw manifest still has no bound upload and the cancelled work stays closed.
    const polar = gap.result!.polars[0];
    const gapSource = resolveProgressiveReportedPoint(gap.result!, {
      alpha: point.aoa_deg,
      caseSlug: point.case_slug,
      speed: polar.speed,
      chord: polar.chord,
    });
    const incoming = {
      ...latePoint,
      aoaDeg: point.aoa_deg,
      remoteResultId: randomUUID(),
      remoteResultAttemptId: randomUUID(),
      engineCaseSlug: point.case_slug,
      evidenceArtifacts: [],
      media: [],
      progressiveEvidence: {
        sequence: gap.sequence,
        reportContentSignature: gapReceipt.contentSignature,
        pointContentSignature: gapSource.contentSignature,
      },
    };
    const deliver = () =>
      app.inject({
        method: "POST",
        url: "/api/sync/v1/retained-progressive-evidence",
        headers: { "x-xfoilfoam-solver-token": token },
        payload: { ...payload, results: [incoming] },
      });
    const late = await deliver();
    expect(late.statusCode, late.body).toBe(200);
    const received = late.json();
    expect(received.progressiveEvidenceReceipts).toMatchObject([
      {
        sequence: gap.sequence,
        storageOnly: true,
        pointContentSignature: gapSource.contentSignature,
        remoteResultAttemptId: incoming.remoteResultAttemptId,
      },
    ]);
    expect(received.fulfilledAoas).toEqual([]);
    expect((await deliver()).json().progressiveEvidenceReceipts).toEqual(
      received.progressiveEvidenceReceipts,
    );
    expect((await state())[0]).toMatchObject({
      status: "cancelled",
      ingestedAt: null,
      promise: "cancelled",
      receipts: 2,
      attempts: 2,
      published: 0,
      fulfilled: 0,
    });
    expect(await readProgressiveRemoteRetention(db, id)).toMatchObject({
      kind: "waiting",
      reason: "archives",
      pendingCount: 1,
    });
  } finally {
    installProgressiveReportArchiveReader(null);
  }
}
