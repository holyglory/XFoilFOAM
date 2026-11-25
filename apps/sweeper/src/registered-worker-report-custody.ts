import { createHash } from "node:crypto";
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
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
import {
  readWorkerReportVolume,
  storeWorkerReportVolume,
} from "./worker-report-volume";
import {
  assertReportPin,
  inspectHubReport,
  inspectHubReportPage,
  assertRegisteredPage,
  withRegisteredWorkingPage,
  nativeReportOwner,
  reportUuid,
  reportHash,
  requireReportProof,
  verifyInventory,
  type HubReportLink,
} from "./registered-worker-report-read";
import {
  assertSourceKey,
  type SourceKey,
} from "./registered-worker-report-hub";

import { SHARED_REPORT_FORMAT } from "./shared-report-archive";
import { openRegisteredSharedPage, stageSharedObjects, volumeSharedObject, type PinnedScientificResult } from "./registered-shared-report";

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
          (a.sequence < p.sequence ||
            (a.sequence > p.sequence && reportHash.test(a.receiptReportSignature ?? ""))) &&
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
  if (r.archived_at && !r.linked)
    return { status: "other_storage" as const };
  return { status: "candidate" as const, owner: o, ...(r.result_payload_hash ? { normalized: true } : {}) };
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
  if (r.result_payload_hash && p.archiveFormat !== SHARED_REPORT_FORMAT) return "other_storage";
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
    a(signature text,sequence bigint,"receiptReportSignature" text,aoa double precision,"caseSlug" text,"workerAttempt" uuid,"workerResult" uuid,"hubAttempt" uuid,"hubResult" uuid)
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
    WHERE a.sequence<${p.sequence} OR (a.sequence>${p.sequence}
      AND origin.content_signature=a."receiptReportSignature"
      AND EXISTS (SELECT FROM progressive_worker_reports stop WHERE stop.sim_job_id=j.id
        AND stop.stopped_engine_job_id=j.engine_job_id AND stop.assignment_signature=origin.assignment_signature
        AND stop.acknowledged_at IS NOT NULL AND stop.sequence>=a.sequence))
    ${lock ? sql`FOR SHARE OF e,assoc,st,origin,attempt NOWAIT` : sql``}`);
  return witnesses.length === l.anchors.length
    ? "ready"
    : "science_not_settled";
}
async function assertBinding(db: DB, l: HubReportLink, scientific?: PinnedScientificResult) {
  const { pin: p, owner: o } = l;
  const [proof] =
    await db.execute(sql`SELECT ${p.archiveFormat === SHARED_REPORT_FORMAT ? sql`shared_result_object` : sql`1`} FROM progressive_worker_hub_report_links WHERE sim_job_id=${p.executionId}::uuid AND sequence=${p.sequence}
    AND worker_instance=${o.workerInstance}::uuid AND hub_instance=${l.hubInstance}::uuid AND hub_bundle_id=${l.hubBundle}::uuid
    AND registered_solver_id=${o.solverId}::uuid AND promise_id=${o.promiseId}::uuid AND assignment_signature=${o.assignmentSignature}
    AND upstream_base_url=${o.upstream} AND inventory_signature=${l.inventory} AND point_anchors=${JSON.stringify(l.anchors)}::jsonb
    AND read_identity=${JSON.stringify(p)}::jsonb`);
  requireReportProof(proof && (!scientific || isDeepStrictEqual(scientific, proof.shared_result_object)), "Existing registered report binding differs");
  return proof.shared_result_object;
}
export async function verifyNativeBytes(db: DB, p: HubReportLink["pin"]) {
  const shared = p.archiveFormat === SHARED_REPORT_FORMAT;
  const [exact] = await db.execute(sql`WITH original AS MATERIALIZED (
    SELECT ${shared ? sql`public.resolve_progressive_report(report,result_payload_hash)` : sql`report`}::text body
    FROM progressive_worker_reports WHERE sim_job_id=${p.executionId}::uuid AND sequence=${p.sequence}
      AND content_signature=${p.signature} AND archived_at IS NULL ${shared ? sql`` : sql`AND result_payload_hash IS NULL`}
  ) SELECT FROM original WHERE octet_length(body)=${p.reportByteSize}
    AND encode(sha256(convert_to(body,'UTF8')),'hex')=${p.reportSha256}`);
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
  dependencies: readonly Buffer[] = [],
) {
  if (l.pin.archiveFormat === SHARED_REPORT_FORMAT)
    return (await stageRegisteredPage(db, [l], packed, cloudReadAt, dependencies))[0]!;
  requireReportProof(!dependencies.length, "Unexpected JSONL dependencies");
  checkLink(l);
  fresh(cloudReadAt);
  const { pin: p, owner: o } = l;
  const fence = { instance: o.workerInstance, solver: o.solverId };
  await checkHzTransferFence(db, fence);
  const before = await originalState(db, l);
  if (before !== "ready" && before !== "already_retired") return before;
  await inspectHubReport(packed, l);
  await storeWorkerReportVolume(Readable.from([packed]), p);
  return registerStagedMember(db, l, cloudReadAt);
}
async function registerStagedMember(
  db: DB,
  l: HubReportLink,
  cloudReadAt: string,
  scientific?: PinnedScientificResult,
) {
  fresh(cloudReadAt);
  const { pin: p, owner: o } = l;
  requireReportProof((p.archiveFormat === SHARED_REPORT_FORMAT) === Boolean(scientific), "Missing shared scientific object");
  const fence = { instance: o.workerInstance, solver: o.solverId };
  return withActiveHzTransfer(db, fence, async (tx) => {
    const status = await originalState(tx, l, true);
    if (status === "already_retired") {
      await assertBinding(tx, l, scientific);
      return status;
    }
    if (status !== "ready") return status;
    await verifyNativeBytes(tx, p);
    await tx.execute(sql`INSERT INTO progressive_worker_hub_report_links(sim_job_id,sequence,worker_instance,hub_instance,hub_bundle_id,registered_solver_id,
      promise_id,assignment_signature,upstream_base_url,inventory_signature,point_anchors,read_identity,hub_read_at${scientific ? sql`,shared_result_object` : sql``})
      VALUES(${p.executionId}::uuid,${p.sequence},${o.workerInstance}::uuid,${l.hubInstance}::uuid,${l.hubBundle}::uuid,${o.solverId}::uuid,
        ${o.promiseId}::uuid,${o.assignmentSignature},${o.upstream},${l.inventory},${JSON.stringify(l.anchors)}::jsonb,${JSON.stringify(p)}::jsonb,${cloudReadAt}::timestamptz${scientific ? sql`,${JSON.stringify(scientific)}::jsonb` : sql``})
      ON CONFLICT(sim_job_id,sequence) DO NOTHING`);
    await assertBinding(tx, l, scientific);
    return "staged" as const;
  });
}
export async function proveRegisteredReader(
  db: DB,
  l: HubReportLink,
  committed: boolean,
) {
  checkLink(l);
  const scientific = await assertBinding(db, l);
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
    ...(p.archiveFormat === SHARED_REPORT_FORMAT ? { scientific } : {}),
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
  const sweeper = await proveRegisteredReader(db, l, false);
  if (p.archiveFormat === SHARED_REPORT_FORMAT)
    requireReportProof(api.scientific && isDeepStrictEqual(api.scientific, sweeper.scientific), "Scientific reader proof differs");
  return commitRegisteredMember(db, l, cloudReadAt, api.at);
}
async function commitRegisteredMember(
  db: DB,
  l: HubReportLink,
  cloudReadAt: string,
  apiAt: string,
) {
  const { pin: p, owner: o } = l;
  return withActiveHzTransfer(
    db,
    { instance: o.workerInstance, solver: o.solverId },
    async (tx) => {
      const status = await originalState(tx, l, true);
      if (status !== "ready") return status;
      fresh(cloudReadAt);
      fresh(apiAt);
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
      AND last_sequence=${p.lastSequence} AND archive_format=${p.archiveFormat} AND mime_type='application/gzip' AND compression='gzip'`);
      requireReportProof(b, "Registered local archive catalog differs");
      await tx.execute(sql`INSERT INTO progressive_report_archive_members(bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
      VALUES(${b.id}::uuid,'worker',${p.executionId}::uuid,${p.sequence},'report',${p.signature},${p.reportSha256},${p.reportByteSize})`);
      // 0202 reauthenticates the actual old PG bytes inside this same transaction.
      let previousPayload: string | null = null;
      if (p.archiveFormat === SHARED_REPORT_FORMAT) {
        // originalState already locked this exact signed report. A 0198 reference
        // remains live through the independent OLD-body archive trigger.
        const [row] = await tx.execute(sql`SELECT result_payload_hash AS hash FROM progressive_worker_reports
          WHERE sim_job_id=${p.executionId}::uuid AND sequence=${p.sequence} AND content_signature=${p.signature}`);
        previousPayload = row?.hash == null ? null : String(row.hash);
      }
      const changed = await tx.execute(sql`UPDATE progressive_worker_reports
        SET report=progressive_report_compact_header(report), result_payload_hash=NULL, archive_bundle_id=${b.id}::uuid,
        archived_at=clock_timestamp() WHERE sim_job_id=${p.executionId}::uuid AND sequence=${p.sequence} AND content_signature=${p.signature}
        AND result_payload_hash IS NOT DISTINCT FROM ${previousPayload}::text AND archived_at IS NULL RETURNING sequence`);
      requireReportProof(
        changed.length === 1,
        "Native report changed before commit",
      );
      if (previousPayload) {
        await tx.execute(sql`DELETE FROM progressive_report_result_payloads p WHERE p.content_hash=${previousPayload}
          AND NOT EXISTS(SELECT FROM progressive_worker_reports w WHERE w.result_payload_hash=p.content_hash)
          AND NOT EXISTS(SELECT FROM progressive_remote_reports r WHERE r.result_payload_hash=p.content_hash)`);
      }
      return "retired" as const;
    },
  );
}

type ReaderProof = Awaited<ReturnType<typeof proveRegisteredReader>>;

// Each member commits under the ordinary native owner/lease gates. Return a
// prefix if the host's shared deployment lock needs to be released between
// members. A subsequent call must reacquire it and recheck the same receipts.
export class RegisteredMemberFailure extends Error {
  constructor(
    readonly sequence: number,
    cause: unknown,
  ) {
    super("Registered member verification failed", { cause });
  }
}
async function writePrefix<T>(
  links: readonly HubReportLink[],
  started: number,
  write: (l: HubReportLink, index: number) => Promise<T>,
) {
  const statuses: T[] = [];
  for (const [i, l] of links.entries()) {
    if (i && performance.now() - started >= 5000) break;
    try {
      statuses.push(await write(l, i));
    } catch (error) {
      throw new RegisteredMemberFailure(l.pin.sequence, error);
    }
  }
  return statuses;
}
export async function stageRegisteredPage(
  db: DB,
  links: HubReportLink[],
  bytes: Buffer | null,
  cloudAt: string,
  dependencies: readonly Buffer[] = [],
) {
  const started = performance.now();
  assertRegisteredPage(links);
  links.forEach(checkLink);
  fresh(cloudAt);
  const first = links[0]!,
    p = first.pin;
  await checkHzTransferFence(db, {
    instance: first.owner.workerInstance,
    solver: first.owner.solverId,
  });
  if (bytes !== null)
    requireReportProof(
      bytes.byteLength === p.storedByteSize &&
        createHash("sha256").update(bytes).digest("hex") === p.storedSha256,
      "Registered transfer bytes differ",
    );
  const before = await writePrefix(links, started, (l) => originalState(db, l));
  const admitted = links.slice(0, before.length);
  if (
    before.every((status) => status !== "ready" && status !== "already_retired")
  )
    return before;
  if (p.archiveFormat === SHARED_REPORT_FORMAT) {
    const checked = await stageSharedObjects(links.map(l => l.pin), first.owner, bytes, dependencies,
      members => { for (const l of links) verifyInventory(l, members.get(l.pin.sequence)!.text); });
    return writePrefix(admitted, started, (l, i) =>
      before[i] === "ready" || before[i] === "already_retired"
        ? registerStagedMember(db, l, cloudAt, checked.get(l.pin.sequence)!.scientific)
        : Promise.resolve(before[i]!));
  }
  requireReportProof(!dependencies.length, "Unexpected JSONL dependencies");
  const local = await readWorkerReportVolume(p);
  if (local) {
    await inspectHubReportPage(local, admitted);
  } else {
    if (bytes === null)
      throw new HistoryOperationError(
        "registered_volume_missing",
        "transport",
        true,
      );
    await inspectHubReportPage(Readable.from([bytes]), admitted);
    await storeWorkerReportVolume(Readable.from([bytes]), p);
  }
  return writePrefix(admitted, started, (l, i) =>
    before[i] === "ready" || before[i] === "already_retired"
      ? registerStagedMember(db, l, cloudAt)
      : Promise.resolve(before[i]!),
  );
}
export async function readRegisteredPage(
  db: DB,
  links: HubReportLink[],
  committed: boolean,
) {
  return withRegisteredWorkingPage(db, links, async () => {
    const results: ReaderProof[] = [];
    for (const l of links) {
      try {
        results.push(await proveRegisteredReader(db, l, committed));
      } catch (error) {
        throw new RegisteredMemberFailure(l.pin.sequence, error);
      }
    }
    return results;
  });
}
export async function retireRegisteredPage(
  db: DB,
  links: HubReportLink[],
  cloudAt: string,
  api: ReaderProof[],
  sweeper: ReaderProof[],
) {
  const started = performance.now();
  assertRegisteredPage(links);
  links.forEach(checkLink);
  fresh(cloudAt);
  requireReportProof(
    api.length === links.length && sweeper.length === links.length,
    "Incomplete registered reader set",
  );
  // Reopen the physical working file inside the host write fence. Its bytes
  // must still be the generation decoded independently by both product readers.
  const pin = links[0]!.pin;
  if (pin.archiveFormat === SHARED_REPORT_FORMAT) {
    const checked = await openRegisteredSharedPage(links.map(l => l.pin), links[0]!.owner, volumeSharedObject);
    for (const [i, l] of links.entries()) {
      const member = checked.members.get(l.pin.sequence)!;
      verifyInventory(l, member.text);
      requireReportProof(isDeepStrictEqual(member.scientific, api[i]!.scientific) &&
        isDeepStrictEqual(member.scientific, sweeper[i]!.scientific), "Scientific reader proof differs");
      await assertBinding(db, l, member.scientific);
    }
  } else {
    const file = await readWorkerReportVolume(pin);
    requireReportProof(
      file,
      "Registered working copy disappeared before retirement",
    );
    let size = 0;
    const hash = createHash("sha256");
    try {
      for await (const part of file) {
        size += part.length;
        requireReportProof(
          size <= pin.storedByteSize,
          "Working file exceeds pin",
        );
        hash.update(part);
      }
    } finally {
      file.destroy();
    }
    requireReportProof(
      size === pin.storedByteSize && hash.digest("hex") === pin.storedSha256,
      "Working file changed before retirement",
    );
  }
  return writePrefix(links, started, async (l, i) => {
    for (const r of [api[i]!, sweeper[i]!]) {
      fresh(r.at);
      requireReportProof(
        r.signature === l.pin.signature &&
          r.sha256 === l.pin.reportSha256 &&
          r.byteSize === l.pin.reportByteSize &&
          r.generation === l.pin.generation,
        "Registered member reader proof differs",
      );
    }
    return commitRegisteredMember(
      db,
      l,
      cloudAt,
      new Date(
        Math.min(Date.parse(api[i]!.at), Date.parse(sweeper[i]!.at)),
      ).toISOString(),
    );
  });
}
