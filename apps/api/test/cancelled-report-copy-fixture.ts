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
import { acknowledgeLatestProgressiveRemoteStop } from "../../sweeper/src/progressive-remote-stop-receipt";
import { readProgressiveRemoteSourceClassifications, readProgressiveRemoteRetention } from "@aerodb/db/progressive-remote-retention";
import { resolveProgressiveReportedPoint } from "@aerodb/db/progressive-remote-report";
import {
  backfillProgressiveReportPayloads,
  setProgressiveReportNormalization,
} from "@aerodb/db/progressive-report-payloads";
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
import { copyStoppedReportBatch, stoppedReportCopyKeys } from "../../sweeper/src/shared-stopped-report-custody";
import { readSharedReport, SHARED_REPORT_FORMAT } from "../../sweeper/src/shared-report-archive";
import { memoryReportObjects } from "../../sweeper/test/shared-report-object-fixture";
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
  // This fixture runs inside the caller's rolled-back transaction. Start with
  // the historical inline representation even on a normalized-write backend.
  await setProgressiveReportNormalization(db, { enabled: false, readersReady: true });
  const copyReceipt = await storeProgressiveRemoteReport(db, {
    ...sender,
    report: copy,
  });
  const dependent={...copy,sequence:copy.sequence+1};
  const dependentReceipt=await storeProgressiveRemoteReport(db,{...sender,report:dependent});
  const gap = structuredClone(dependent);
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
  const repeat = { ...gap, sequence: gap.sequence + 1 };
  const repeatReceipt = await storeProgressiveRemoteReport(db, { ...sender, report: repeat });
  const nextRepeat = { ...repeat, sequence: repeat.sequence + 1 };
  const nextReceipt = await storeProgressiveRemoteReport(db, { ...sender, report: nextRepeat });
  const final = structuredClone(nextRepeat);
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
  const finalReceipt=await storeProgressiveRemoteReport(db, { ...sender, report: final });
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
  const cursor = {
    executionId: id,
    sequence: anchorSequence - 1,
  };
  const page = await nextCancelledReportCopies(db, cursor);
  expect(page.executionId).toBe(id);
  expect(page.sequences).toEqual([copy.sequence,dependent.sequence]);
  const [original] =
    await db.execute(sql`SELECT report::text AS text, result_payload_hash AS hash
    FROM progressive_remote_reports WHERE sim_job_id=${id}::uuid AND sequence=${copy.sequence}`);
  expect(original.hash).toBeNull();
  await setProgressiveReportNormalization(db, { enabled: true, readersReady: true });
  const sharing = await backfillProgressiveReportPayloads(db, {
    table: "progressive_remote_reports", after: { executionId: id, sequence: anchorSequence },
    rows: 1, apply: true,
  });
  expect(sharing.proofs).toEqual([{
    executionId: id, sequence: copy.sequence, contentSignature: copyReceipt.contentSignature,
    digest: createHash("sha256").update(String(original.text)).digest("hex"),
  }]);
  expect(sharing.normalized).toBe(1);
  expect(await nextCancelledReportCopies(db, cursor)).toEqual(page);
  const shared = await post();
  expect(shared.statusCode, shared.body).toBe(200);
  expect(shared.json().progressiveEvidenceReceipts).toEqual(warmBody.progressiveEvidenceReceipts);
  expect(shared.json().progressiveArchiveReceipts).toEqual(warmBody.progressiveArchiveReceipts);
  expect(shared.json().fulfilledAoas).toEqual([]);
  expect(await readProgressiveRemoteRetention(db, id)).toEqual(waiting);
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
    await archiveProgressiveReportBatch(db, "remote", id, put, [copy.sequence]),
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
    const lateSequence = repeat.sequence;
    const lateSignature = repeatReceipt.contentSignature;
    const incoming = {
      ...latePoint,
      aoaDeg: point.aoa_deg,
      remoteResultId: randomUUID(),
      remoteResultAttemptId: randomUUID(),
      engineCaseSlug: point.case_slug,
      evidenceArtifacts: [],
      media: [],
      progressiveEvidence: {
        sequence: lateSequence,
        reportContentSignature: lateSignature,
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
    {
      const [original] = await db.execute(sql`SELECT public.resolve_progressive_report(report,result_payload_hash)::text AS body
        FROM progressive_remote_reports WHERE sim_job_id=${id}::uuid AND sequence=${repeat.sequence}`);
      const normalized = await backfillProgressiveReportPayloads(db, {
        table:"progressive_remote_reports", after:{executionId:id,sequence:gap.sequence}, rows:2, apply:true,
      });
      expect(normalized.normalized).toBe(2);
      const [referenceHash] = await db.execute(sql`SELECT result_payload_hash AS hash FROM progressive_remote_reports
        WHERE sim_job_id=${id}::uuid AND sequence=${repeat.sequence}`);
      const protectedCount = async () => (await db.execute(sql`SELECT count(*)::int AS n FROM progressive_report_result_payloads
        WHERE content_hash=${referenceHash.hash}`))[0].n;
      const { files, store } = memoryReportObjects();
      const verifyReader = (pin:Parameters<typeof readSharedReport>[1])=>readSharedReport(store,pin);
      const adapters={readers:[verifyReader,verifyReader] as const};
      const key = { sequence: repeat.sequence, signature: lateSignature };
      const second = { sequence: nextRepeat.sequence, signature: nextReceipt.contentSignature };
      const candidates = await stoppedReportCopyKeys(db, id, gap.sequence - 1);
      expect(candidates.filter(k => k.mode === "release").map(k => k.sequence)).toEqual([repeat.sequence, nextRepeat.sequence]);
      const keptKey={sequence:gap.sequence,signature:gapReceipt.contentSignature};
      const held = await copyStoppedReportBatch(db,store,id,[keptKey],"preserve",adapters);
      expect(held.released).toBe(0);
      const firstPin=held.object;
      expect(firstPin.generation.length).toBeGreaterThan(16);
      await expect(copyStoppedReportBatch(db,store,id,[keptKey],"release",adapters)).rejects.toThrow();
      await expect(copyStoppedReportBatch(db,store,id,[{...key,signature:"0".repeat(64)}],"release",adapters)).rejects.toThrow();
      const changedJob={...store,create:async(k:string,b:Buffer)=>{
        const pin=await store.create(k,b);
        await db.execute(sql`UPDATE sim_jobs SET ingest_lease_token='copy-race',ingest_lease_expires_at=now()+interval '1 hour' WHERE id=${id}::uuid`);
        return pin;
      }};
      await expect(copyStoppedReportBatch(db,changedJob,id,[key],"release",adapters)).rejects.toThrow("owner");
      await db.execute(sql`UPDATE sim_jobs SET ingest_lease_token=NULL,ingest_lease_expires_at=NULL WHERE id=${id}::uuid`);
      await expect(copyStoppedReportBatch(db,store,id,[key],"release",{readers:[verifyReader,async()=>{throw new Error("serving reader unavailable");}]}))
        .rejects.toThrow("serving reader unavailable");
      const [warmRepeat]=await db.execute(sql`SELECT archived_at, result_payload_hash FROM progressive_remote_reports
        WHERE sim_job_id=${id}::uuid AND sequence=${key.sequence}`);
      expect(warmRepeat.archived_at).toBeNull();
      expect(warmRepeat.result_payload_hash).toBe(referenceHash.hash);
      await expect(copyStoppedReportBatch(db,store,id,[key],"release",{...adapters,beforeCommit:async()=>{throw new Error("interrupted durable receipt");}}))
        .rejects.toThrow("interrupted durable receipt");
      const [afterAbort]=await db.execute(sql`SELECT archive_bundle_id,result_payload_hash FROM progressive_remote_reports
        WHERE sim_job_id=${id}::uuid AND sequence=${key.sequence}`);
      expect(afterAbort.archive_bundle_id).toBeNull();
      expect(afterAbort.result_payload_hash).toBe(referenceHash.hash);
      const first = await copyStoppedReportBatch(db,store,id,[key],"release",adapters);
      expect(await protectedCount()).toBe(1);
      const other = await copyStoppedReportBatch(db,store,id,[second],"release",adapters);
      expect(await protectedCount()).toBe(0);
      expect([first.released,other.released]).toEqual([1,1]);
      const payloads=[...files.values()].filter(v=>v.pin.key.includes("/results/"));
      expect(payloads).toHaveLength(1);
      expect(first.object.key).not.toBe(other.object.key);
      const restore=(pin:Parameters<typeof readSharedReport>[1])=>readSharedReport(store,pin);
      installProgressiveReportArchiveReader({read:restore});
      const reference = { sourceKind: "remote" as const, executionId: id, sequence: repeat.sequence, contentSignature: lateSignature };
      const restored = await readProgressiveReport(db, reference);
      expect(restored).toEqual(repeat);
      const member = verifiedProgressiveReportMember(restored)!.identity;
      expect(member.archiveFormat).toBe(SHARED_REPORT_FORMAT);
      // A completed read's timeout signal cannot become part of the durable
      // member identity used by a second, independently cancellable reader.
      expect(member).not.toHaveProperty("signal");
      expect(await restore(member)).toBe(original.body);
      expect(await readProgressiveReport(db,{...reference,sequence:second.sequence,contentSignature:second.signature})).toEqual(nextRepeat);
      expect(await readProgressiveRemoteRetention(db, id)).toEqual(waiting);
      expect(await state()).toEqual(before);
      const [payload]=payloads;files.delete(payload.pin.key);
      expect((await deliver()).statusCode).toBeGreaterThanOrEqual(400);
      files.set(payload.pin.key,{...payload,bytes:Buffer.from("bad scientific generation")});
      expect((await deliver()).statusCode).toBeGreaterThanOrEqual(400);
      files.set(payload.pin.key,{...payload,pin:{...payload.pin,generation:String(BigInt(payload.pin.generation)+9n)}});
      expect((await deliver()).statusCode).toBeGreaterThanOrEqual(400);
      files.set(payload.pin.key,payload);
      await expect(restore({...member,sourceKind:"worker"})).rejects.toThrow();
      await expect(restore({...member,reportSha256:"0".repeat(64)})).rejects.toThrow();
      await expect(restore({...member,generation:String(BigInt(member.generation)+1n)})).rejects.toThrow();
      const endKey={sequence:final.sequence,signature:finalReceipt.contentSignature};
      const originKey={sequence:anchorSequence,signature:delivery.progressiveEvidence.reportContentSignature};
      const anchors=[originKey,keptKey,endKey];
      const originalClassification=await readProgressiveRemoteSourceClassifications(db,id);
      const copyOfOriginals=await copyStoppedReportBatch(db,store,id,anchors,"preserve",adapters);
      await expect(copyStoppedReportBatch(db,store,id,anchors,"anchor",adapters)).rejects.toThrow("preserved");
      const corruptPrevious={...copyOfOriginals,object:{...copyOfOriginals.object,generation:String(BigInt(copyOfOriginals.object.generation)+1n)}};
      await expect(copyStoppedReportBatch(db,store,id,anchors,"anchor",{...adapters,preserved:corruptPrevious})).rejects.toThrow();
      const heldCount=await db.execute(sql`SELECT count(*)::int n FROM progressive_remote_reports WHERE sim_job_id=${id}::uuid AND sequence IN (${anchorSequence},${gap.sequence},${final.sequence}) AND archived_at IS NULL`);
      expect(heldCount[0].n).toBe(3);
      const retired=await copyStoppedReportBatch(db,store,id,anchors,"anchor",{...adapters,preserved:copyOfOriginals});
      expect(retired.released).toBe(3);expect(retired.object).toEqual(copyOfOriginals.object);expect(retired.resultBytesSubmitted).toBe(0);
      expect(await readProgressiveRemoteSourceClassifications(db,id)).toEqual(originalClassification);
      expect(await readProgressiveRemoteRetention(db,id)).toEqual(waiting);
      const frozenStop=await db.execute(sql`SELECT proof_signature FROM progressive_cfd_execution_stops WHERE sim_job_id=${id}::uuid`);
      expect(await acknowledgeLatestProgressiveRemoteStop(db,id)).toBe(false); // The existing stop was replayed.
      expect(await db.execute(sql`SELECT proof_signature FROM progressive_cfd_execution_stops WHERE sim_job_id=${id}::uuid`)).toEqual(frozenStop);
      const originalItem={...latePoint,progressiveEvidence:delivery.progressiveEvidence};
      const originalReplay=await post(originalItem);expect(originalReplay.statusCode,originalReplay.body).toBe(200);
      expect(originalReplay.json().progressiveEvidenceReceipts).toEqual(warmBody.progressiveEvidenceReceipts);
      expect((await post({...originalItem,remoteResultAttemptId:randomUUID()})).statusCode).toBe(409);
      const anchorObject=files.get(retired.object.key)!;files.delete(retired.object.key);
      await expect(readProgressiveRemoteRetention(db,id)).rejects.toThrow();
      expect((await deliver()).statusCode).toBeGreaterThanOrEqual(400);
      await expect(archiveProgressiveReportBatch(db,"remote",id,put,[dependent.sequence])).rejects.toThrow();
      const [heldDependent]=await db.execute(sql`SELECT archive_bundle_id FROM progressive_remote_reports WHERE sim_job_id=${id}::uuid AND sequence=${dependent.sequence} AND content_signature=${dependentReceipt.contentSignature}`);
      expect(heldDependent.archive_bundle_id).toBeNull();
      files.set(retired.object.key,anchorObject);
      expect(await archiveProgressiveReportBatch(db,"remote",id,put,[dependent.sequence])).toBe(1);

      expect(await state()).toEqual(before);
    }
    const late = await deliver();
    expect(late.statusCode, late.body).toBe(200);
    const received = late.json();
    expect(received.progressiveEvidenceReceipts).toMatchObject([
      {
        sequence: lateSequence,
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
