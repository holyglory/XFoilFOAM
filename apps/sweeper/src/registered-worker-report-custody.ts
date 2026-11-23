import type { DB } from "@aerodb/db/client";
import {
  reportTextIdentity,
  parseReportJson,
  reportValidationValue,
} from "@aerodb/db/progressive-report-archive";
import { readProgressiveReport } from "@aerodb/db/progressive-report-reader";
import { sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { Readable } from "node:stream";
import {
  withActiveHzTransfer,
  checkHzTransferFence,
} from "./hz-attempt-transfer-fence";
import { readStoredWorkerArchiveText } from "./report-archive-broker-client";
import { storeWorkerReportVolume } from "./worker-report-volume";
import {
  assertReportPin,
  inspectHubReport,
  nativeReportOwner,
  reportUuid,
  reportHash,
  requireReportProof,
  type HubReportLink,
} from "./registered-worker-report-read";
import {
  assertSourceKey,
  type SourceKey,
} from "./registered-worker-report-hub";

function checkLink(l: HubReportLink) {
  const { pin: p, owner: o } = l;
  assertReportPin(p);
  requireReportProof(
    o.executionId === p.executionId &&
      [
        o.workerInstance,
        o.solverId,
        o.promiseId,
        l.hubInstance,
        l.hubBundle,
      ].every((v) => reportUuid.test(v)) &&
      l.hubInstance !== o.workerInstance &&
      reportHash.test(o.assignmentSignature) &&
      reportHash.test(l.inventory) &&
      Array.isArray(l.anchors) &&
      l.anchors.length > 0 &&
      l.anchors.length <= 512 &&
      l.anchors.every(
        (a, n) =>
          reportHash.test(a.signature) &&
          (n === 0 || a.signature > l.anchors[n - 1]!.signature) &&
          Number.isSafeInteger(a.sequence) &&
          a.sequence > 0 &&
          a.sequence < p.sequence &&
          Number.isFinite(a.aoa) &&
          (a.caseSlug === null || typeof a.caseSlug === "string") &&
          [a.workerResult, a.workerAttempt, a.hubResult, a.hubAttempt].every(
            (v) => reportUuid.test(v),
          ),
      ),
    "Invalid registered report source proof",
  );
}
export async function checkNativeKey(db: DB, k: SourceKey) {
  assertSourceKey(k);
  const o = await nativeReportOwner(db, k.executionId);
  await checkHzTransferFence(db, {
    instance: o.workerInstance,
    solver: o.solverId,
  });
  const [r] =
    await db.execute(sql`SELECT r.content_signature,r.archived_at,r.result_payload_hash,
    l.sequence IS NOT NULL AS linked FROM progressive_worker_reports r LEFT JOIN progressive_worker_hub_report_links l USING(sim_job_id,sequence)
    WHERE r.sim_job_id=${k.executionId}::uuid AND r.sequence=${k.sequence}`);
  if (!r || r.content_signature !== k.signature)
    return { status: "different_source" as const };
  if ((r.archived_at && !r.linked) || r.result_payload_hash)
    return { status: "other_storage" as const };
  return { status: "candidate" as const, owner: o };
}
export async function originalState(db: DB, l: HubReportLink, lock = false) {
  checkLink(l);
  const { pin: p, owner: o } = l;
  const [r] =
    await db.execute(sql`SELECT r.archived_at,r.archive_bundle_id,r.result_payload_hash,r.content_signature,
      r.acknowledged_at,r.assignment_signature, r.stopped_engine_job_id,
      j.status AS job_status,j."ingestedAt" IS NOT NULL AS ingested,
      (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp()) AS idle,
      pr.status AS promise_status, pr.registered_solver_id,j.engine_job_id
    FROM progressive_worker_reports r JOIN sim_jobs j ON j.id=r.sim_job_id
    JOIN sync_sweep_promises pr ON pr.id=${o.promiseId}::uuid AND pr.id::text=j.request_payload->>'syncPromiseId'
    WHERE r.sim_job_id=${p.executionId}::uuid AND r.sequence=${p.sequence}
    ${lock ? sql`FOR UPDATE OF r NOWAIT FOR SHARE OF j,pr NOWAIT` : sql``}`);
  requireReportProof(
    r &&
      r.content_signature === p.signature &&
      r.assignment_signature === o.assignmentSignature,
    "Native report identity changed",
  );
  const native = await nativeReportOwner(db, p.executionId);
  requireReportProof(
    native.workerInstance === o.workerInstance &&
      native.solverId === o.solverId &&
      native.promiseId === o.promiseId &&
      native.assignmentSignature === o.assignmentSignature &&
      native.upstream === o.upstream,
    "Native report registration changed",
  );
  if (r.archived_at) {
    const [exact] =
      await db.execute(sql`SELECT FROM progressive_report_archive_bundles b JOIN progressive_report_archive_members m ON m.bundle_id=b.id
      JOIN progressive_worker_hub_report_links l ON l.sim_job_id=m.sim_job_id AND l.sequence=m.sequence AND l.read_identity=${JSON.stringify(p)}::jsonb
      WHERE b.id=${r.archive_bundle_id}::uuid AND b.id<>l.hub_bundle_id AND b.source_kind='worker' AND b.sim_job_id=${p.executionId}::uuid
        AND b.bucket=${p.bucket} AND b.object_key=${p.objectKey} AND b.generation=${p.generation} AND b.stored_sha256=${p.storedSha256}
        AND m.source_kind=b.source_kind AND m.sim_job_id=b.sim_job_id AND m.sequence=${p.sequence} AND m.member_kind='report'
        AND m.content_signature=${p.signature} AND m.report_sha256=${p.reportSha256} AND m.report_byte_size=${p.reportByteSize}`);
    return exact ? "already_retired" : "other_storage";
  }
  if (r.result_payload_hash) return "other_storage";
  if (
    !r.acknowledged_at ||
    r.stopped_engine_job_id ||
    r.engine_job_id !== p.executionId ||
    !r.ingested ||
    !r.idle ||
    !["cancelled", "failed", "done"].includes(String(r.job_status)) ||
    !["cancelled", "expired", "fulfilled"].includes(String(r.promise_status)) ||
    r.registered_solver_id !== o.solverId
  )
    return "source_open";
  const [closed] =
    await db.execute(sql`SELECT FROM progressive_worker_reports r WHERE r.sim_job_id=${p.executionId}::uuid AND r.sequence=${p.sequence}
    AND public.progressive_worker_report_evidence_settled(r.sim_job_id,r.sequence)
    AND EXISTS(SELECT FROM progressive_worker_reports s WHERE s.sim_job_id=r.sim_job_id AND s.assignment_signature=r.assignment_signature
      AND s.stopped_engine_job_id=r.sim_job_id::text AND s.sequence>r.sequence)
    AND NOT EXISTS(SELECT FROM progressive_worker_evidence_receipts staged WHERE staged.sim_job_id=r.sim_job_id AND staged.sequence=r.sequence)
    AND NOT EXISTS(SELECT FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=r.sim_job_id AND c.sequence=r.sequence)`);
  if (!closed) return "source_ineligible";
  const witnesses =
    await db.execute(sql`SELECT a.signature FROM jsonb_to_recordset(${JSON.stringify(l.anchors)}::jsonb)
    a(signature text,sequence bigint,aoa double precision,"caseSlug" text,"workerAttempt" uuid,"workerResult" uuid,"hubAttempt" uuid,"hubResult" uuid)
    JOIN progressive_worker_hub_receipts e ON e.sim_job_id=${p.executionId}::uuid AND e.point_content_signature=a.signature
      AND e.sequence=a.sequence AND e.result_attempt_id=a."workerAttempt" AND e.receipt->>'resultId'=a."hubResult"::text
      AND e.receipt->>'resultAttemptId'=a."hubAttempt"::text
    JOIN progressive_worker_evidence_attempts assoc ON assoc.sim_job_id=e.sim_job_id AND assoc.sequence=e.sequence
      AND assoc.result_attempt_id=e.result_attempt_id AND assoc.point_content_signature=e.point_content_signature
    JOIN progressive_worker_evidence_receipts st ON st.sim_job_id=e.sim_job_id AND st.sequence=e.sequence
    JOIN progressive_worker_reports origin ON origin.sim_job_id=st.sim_job_id AND origin.sequence=st.sequence
      AND origin.content_signature=st.content_signature AND origin.assignment_signature=${o.assignmentSignature} AND origin.acknowledged_at IS NOT NULL
    JOIN result_attempts attempt ON attempt.id=e.result_attempt_id AND attempt.sim_job_id=e.sim_job_id AND attempt.engine_job_id=e.sim_job_id::text
      AND attempt.result_id=a."workerResult" AND attempt.aoa_deg=a.aoa AND attempt.engine_case_slug IS NOT DISTINCT FROM a."caseSlug"
    JOIN sim_jobs j ON j.id=attempt.sim_job_id AND j.airfoil_id=attempt.airfoil_id AND j.simulation_preset_revision_id=attempt.simulation_preset_revision_id
      AND j.bc_ids ? attempt.bc_id::text
    ${lock ? sql`FOR SHARE OF e,assoc,st,origin,attempt NOWAIT` : sql``}`);
  return witnesses.length === l.anchors.length
    ? "ready"
    : "science_not_settled";
}
async function assertBinding(db: DB, l: HubReportLink) {
  const { pin: p, owner: o } = l;
  const [proof] =
    await db.execute(sql`SELECT FROM progressive_worker_hub_report_links WHERE sim_job_id=${p.executionId}::uuid AND sequence=${p.sequence}
    AND worker_instance=${o.workerInstance}::uuid AND hub_instance=${l.hubInstance}::uuid AND hub_bundle_id=${l.hubBundle}::uuid
    AND registered_solver_id=${o.solverId}::uuid AND promise_id=${o.promiseId}::uuid AND assignment_signature=${o.assignmentSignature}
    AND upstream_base_url=${o.upstream} AND inventory_signature=${l.inventory} AND point_anchors=${JSON.stringify(l.anchors)}::jsonb
    AND read_identity=${JSON.stringify(p)}::jsonb`);
  requireReportProof(proof, "Existing registered report binding differs");
}
export async function verifyNativeBytes(db: DB, p: HubReportLink["pin"]) {
  const [exact] =
    await db.execute(sql`SELECT FROM progressive_worker_reports WHERE archived_at IS NULL AND result_payload_hash IS NULL AND content_signature=${p.signature} AND sim_job_id=${p.executionId}::uuid AND sequence=${p.sequence}
      AND octet_length(report::text)=${p.reportByteSize} AND encode(sha256(convert_to(report::text,'UTF8')),'hex')=${p.reportSha256}`);
  requireReportProof(
    exact,
    "Native PostgreSQL report differs from independently restored hub member",
  );
}
function fresh(at: string) {
  const age = Date.now() - Date.parse(at);
  requireReportProof(
    Number.isFinite(age) && age >= -5000 && age <= 300000,
    "Fresh generation read required",
  );
}
export async function stageRegisteredReport(
  db: DB,
  l: HubReportLink,
  packed: Buffer,
  cloudReadAt: string,
) {
  checkLink(l);
  fresh(cloudReadAt);
  const { pin: p, owner: o } = l;
  const fence = { instance: o.workerInstance, solver: o.solverId };
  await checkHzTransferFence(db, fence);
  const before = await originalState(db, l);
  if (before !== "ready" && before !== "already_retired") return before;
  await inspectHubReport(packed, l);
  await storeWorkerReportVolume(Readable.from([packed]), p);
  return withActiveHzTransfer(db, fence, async (tx) => {
    const status = await originalState(tx, l, true);
    if (status === "already_retired") {
      await assertBinding(tx, l);
      return status;
    }
    if (status !== "ready") return status;
    await verifyNativeBytes(tx, p);
    await tx.execute(sql`INSERT INTO progressive_worker_hub_report_links(sim_job_id,sequence,worker_instance,hub_instance,hub_bundle_id,registered_solver_id,
      promise_id,assignment_signature,upstream_base_url,inventory_signature,point_anchors,read_identity,hub_read_at)
      VALUES(${p.executionId}::uuid,${p.sequence},${o.workerInstance}::uuid,${l.hubInstance}::uuid,${l.hubBundle}::uuid,${o.solverId}::uuid,
        ${o.promiseId}::uuid,${o.assignmentSignature},${o.upstream},${l.inventory},${JSON.stringify(l.anchors)}::jsonb,${JSON.stringify(p)}::jsonb,${cloudReadAt}::timestamptz)
      ON CONFLICT(sim_job_id,sequence) DO NOTHING`);
    await assertBinding(tx, l);
    return "staged" as const;
  });
}
export async function proveRegisteredReader(
  db: DB,
  l: HubReportLink,
  committed: boolean,
) {
  checkLink(l);
  await assertBinding(db, l);
  const p = l.pin;
  const text = await readStoredWorkerArchiveText(db, {
    ...p,
    signal: AbortSignal.timeout(15000),
  });
  const exact = reportTextIdentity(text);
  requireReportProof(
    exact.sha256 === p.reportSha256 && exact.byteSize === p.reportByteSize,
    "Worker product read differs",
  );
  if (committed) {
    const normal = await readProgressiveReport(db, {
      sourceKind: "worker",
      executionId: p.executionId,
      sequence: p.sequence,
      contentSignature: p.signature,
    });
    requireReportProof(
      (await originalState(db, l)) === "already_retired" &&
        isDeepStrictEqual(normal, reportValidationValue(parseReportJson(text))),
      "Normal native consumer differs from registered volume member",
    );
  }
  return {
    generation: p.generation,
    signature: p.signature,
    ...exact,
    at: new Date().toISOString(),
  };
}
export async function retireRegisteredReport(
  db: DB,
  l: HubReportLink,
  cloudReadAt: string,
  api: Awaited<ReturnType<typeof proveRegisteredReader>>,
) {
  checkLink(l);
  fresh(cloudReadAt);
  fresh(api.at);
  const { pin: p, owner: o } = l;
  requireReportProof(
    api.generation === p.generation &&
      api.sha256 === p.reportSha256 &&
      api.byteSize === p.reportByteSize &&
      api.signature === p.signature,
    "API reader proof differs",
  );
  await proveRegisteredReader(db, l, false);
  return withActiveHzTransfer(
    db,
    { instance: o.workerInstance, solver: o.solverId },
    async (tx) => {
      const status = await originalState(tx, l, true);
      if (status !== "ready") return status;
      fresh(cloudReadAt);
      fresh(api.at);
      await assertBinding(tx, l);
      await tx.execute(sql`INSERT INTO progressive_report_archive_bundles(source_kind,sim_job_id,bucket,object_key,generation,mime_type,compression,
      archive_format,stored_sha256,stored_byte_size,crc32c,member_count,first_sequence,last_sequence,verified_at)
      VALUES('worker',${p.executionId}::uuid,${p.bucket},${p.objectKey},${p.generation},${p.mimeType},${p.compression},${p.archiveFormat},
        ${p.storedSha256},${p.storedByteSize},${p.crc32c},${p.memberCount},${p.firstSequence},${p.lastSequence},${cloudReadAt}::timestamptz)
      ON CONFLICT(bucket,object_key,generation,sim_job_id) DO NOTHING`);
      const [b] =
        await tx.execute(sql`SELECT id FROM progressive_report_archive_bundles WHERE sim_job_id=${p.executionId}::uuid AND source_kind='worker'
      AND id<>${l.hubBundle}::uuid AND bucket=${p.bucket} AND object_key=${p.objectKey} AND generation=${p.generation} AND stored_sha256=${p.storedSha256}
      AND crc32c=${p.crc32c} AND stored_byte_size=${p.storedByteSize} AND member_count=${p.memberCount} AND first_sequence=${p.firstSequence}
      AND last_sequence=${p.lastSequence} AND archive_format='jsonl' AND mime_type='application/gzip' AND compression='gzip'`);
      requireReportProof(b, "Registered local archive catalog differs");
      await tx.execute(sql`INSERT INTO progressive_report_archive_members(bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
      VALUES(${b.id}::uuid,'worker',${p.executionId}::uuid,${p.sequence},'report',${p.signature},${p.reportSha256},${p.reportByteSize})`);
      // 0202 reauthenticates the actual old PG bytes inside this same transaction.
      const changed =
        await tx.execute(sql`UPDATE progressive_worker_reports SET report=progressive_report_compact_header(report),archive_bundle_id=${b.id}::uuid,
      archived_at=clock_timestamp() WHERE sim_job_id=${p.executionId}::uuid AND sequence=${p.sequence} AND content_signature=${p.signature}
      AND result_payload_hash IS NULL AND archived_at IS NULL RETURNING sequence`);
      requireReportProof(
        changed.length === 1,
        "Native report changed before commit",
      );
      return "retired" as const;
    },
  );
}
