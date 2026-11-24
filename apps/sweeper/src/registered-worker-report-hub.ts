import { Readable } from "node:stream";
import { verifyProgressiveRemoteExecution, type DB } from "@aerodb/db";
import { sql } from "drizzle-orm";
import { configuredDeploymentRole } from "./config";
import { HubWorkloadGcs, boundedHubBody } from "./hub-workload-gcs";
import {
  assertReportPin,
  assertRegisteredPage,
  inspectHubReportPage,
  maxPacked,
  reportUuid,
  reportHash,
  requireReportProof,
  type PointAnchor,
  type ReportOwner,
  type HubReportLink,
  type ReportPin,
} from "./registered-worker-report-read";

export interface SourceKey {
  executionId: string;
  sequence: number;
  signature: string;
}
export function assertSourceKey(k: SourceKey) {
  requireReportProof(
    reportUuid.test(k.executionId) &&
      Number.isSafeInteger(k.sequence) &&
      k.sequence > 0 &&
      reportHash.test(k.signature),
    "Expected exact native report key",
  );
}
// A separate signed report must own each point acknowledgement. Keep its original
// sequence even when the target observed the point before it was acknowledged.
export async function hubReportLink(
  db: DB,
  owner: ReportOwner,
  key: SourceKey,
): Promise<HubReportLink | null> {
  assertSourceKey(key);
  requireReportProof(
    configuredDeploymentRole() === "hub" &&
      owner.executionId === key.executionId,
    "Expected authoritative report hub",
  );
  const [r] =
    await db.execute(sql`SELECT cfg.instance_id::text AS hub_instance,reg.instance_id AS worker_instance,d.envelope,
      d.solver_id,d.promise_id,d.content_signature AS assignment,b.*,m.report_sha256,m.report_byte_size,
      inv.inventory_signature,inv.source_count
    FROM progressive_remote_reports r JOIN progressive_remote_dispatches d ON d.sim_job_id=r.sim_job_id
    JOIN registered_remote_solvers reg ON reg.id=d.solver_id AND reg.revoked_at IS NULL
    JOIN sync_sweep_promises pr ON pr.id=d.promise_id AND pr.registered_solver_id=d.solver_id
    JOIN sim_jobs job ON job.id=r.sim_job_id JOIN sync_api_settings cfg ON cfg.id=1
    JOIN progressive_report_archive_members m ON m.bundle_id=r.archive_bundle_id AND m.source_kind='remote' AND m.member_kind='report'
      AND m.sim_job_id=r.sim_job_id AND m.sequence=r.sequence AND m.content_signature=r.content_signature
    JOIN progressive_report_archive_bundles b ON b.id=m.bundle_id AND b.sim_job_id=r.sim_job_id AND b.source_kind='remote'
    JOIN progressive_remote_report_inventories inv ON inv.sim_job_id=r.sim_job_id AND inv.sequence=r.sequence AND inv.report_content_signature=r.content_signature
    JOIN progressive_remote_progress_receipts applied ON applied.sim_job_id=r.sim_job_id AND applied.sequence=r.sequence AND applied.content_signature=r.content_signature
    WHERE r.sim_job_id=${key.executionId}::uuid AND r.sequence=${key.sequence} AND r.content_signature=${key.signature}
      AND r.archived_at IS NOT NULL AND b.verified_at IS NOT NULL AND b.archive_format='jsonl'
      AND pr.status IN ('expired','cancelled','fulfilled') AND job.status IN ('done','failed','cancelled')
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
      AND EXISTS(SELECT FROM progressive_cfd_execution_stops s WHERE s.sim_job_id=r.sim_job_id AND s.engine_job_id=job.engine_job_id)
      AND EXISTS(SELECT FROM progressive_remote_reports later WHERE later.sim_job_id=r.sim_job_id AND later.sequence>r.sequence)`);
  if (
    !r ||
    Number(r.source_count) < 1 ||
    Number(r.source_count) > 512 ||
    Number(r.stored_byte_size) > maxPacked ||
    Number(r.report_byte_size) > 32 * 1024 ** 2 ||
    Number(r.member_count) > 128
  )
    return null;
  requireReportProof(
    r.worker_instance === owner.workerInstance &&
      r.hub_instance !== owner.workerInstance &&
      r.solver_id === owner.solverId &&
      r.promise_id === owner.promiseId &&
      r.assignment === owner.assignmentSignature,
    "Hub dispatch differs from registered worker owner",
  );
  verifyProgressiveRemoteExecution(r.envelope, {
    executionId: owner.executionId,
    solverId: owner.solverId,
    promiseId: owner.promiseId,
    contentSignature: owner.assignmentSignature,
  });
  const p: ReportPin = {
    sourceKind: "worker",
    memberKind: "report",
    executionId: key.executionId,
    sequence: key.sequence,
    signature: key.signature,
    bucket: String(r.bucket),
    objectKey: String(r.object_key),
    generation: String(r.generation),
    crc32c: String(r.crc32c),
    storedSha256: String(r.stored_sha256),
    storedByteSize: Number(r.stored_byte_size),
    mimeType: String(r.mime_type),
    compression: String(r.compression),
    archiveFormat: String(r.archive_format),
    firstSequence: Number(r.first_sequence),
    lastSequence: Number(r.last_sequence),
    memberCount: Number(r.member_count),
    reportByteSize: Number(r.report_byte_size),
    reportSha256: String(r.report_sha256),
  };
  assertReportPin(p);
  const a =
    await db.execute(sql`SELECT s.point_content_signature AS signature,s.aoa_deg,s.case_slug,e.sequence,
      e.remote_result_attempt_id,e.remote_result_id,e.result_attempt_id,attempt.result_id,
      later.content_signature AS later_transport_signature
    FROM progressive_remote_report_sources s JOIN progressive_remote_evidence_receipts e USING(sim_job_id,point_content_signature)
    JOIN result_attempts attempt ON attempt.id=e.result_attempt_id AND attempt.sim_job_id=s.sim_job_id
      AND attempt.engine_job_id=s.sim_job_id::text AND attempt.engine_case_slug IS NOT DISTINCT FROM s.case_slug AND attempt.aoa_deg=s.aoa_deg
    JOIN progressive_remote_report_sources origin ON origin.sim_job_id=e.sim_job_id AND origin.sequence=e.sequence
      AND origin.point_content_signature=s.point_content_signature AND origin.aoa_deg=s.aoa_deg AND origin.case_slug IS NOT DISTINCT FROM s.case_slug
    LEFT JOIN LATERAL (
      SELECT transport.content_signature FROM progressive_remote_reports transport
      JOIN progressive_remote_report_inventories inventory ON inventory.sim_job_id=transport.sim_job_id AND inventory.sequence=transport.sequence
        AND inventory.report_content_signature=transport.content_signature
      JOIN progressive_remote_progress_receipts applied ON applied.sim_job_id=transport.sim_job_id AND applied.sequence=transport.sequence
        AND applied.content_signature=transport.content_signature
      WHERE e.sequence>s.sequence AND transport.sim_job_id=e.sim_job_id AND transport.sequence=e.sequence
    ) later ON true
    WHERE s.sim_job_id=${key.executionId}::uuid AND s.sequence=${key.sequence}
      AND (e.sequence<s.sequence OR later.content_signature IS NOT NULL)
    ORDER BY s.point_content_signature COLLATE "C" LIMIT 513`);
  if (a.length !== Number(r.source_count)) return null;
  const anchors: PointAnchor[] = a.map((v) => ({
    signature: String(v.signature),
    sequence: Number(v.sequence),
    ...(v.later_transport_signature ? { receiptReportSignature: String(v.later_transport_signature) } : {}),
    aoa: Number(v.aoa_deg),
    caseSlug: v.case_slug === null ? null : String(v.case_slug),
    workerAttempt: String(v.remote_result_attempt_id),
    workerResult: String(v.remote_result_id),
    hubAttempt: String(v.result_attempt_id),
    hubResult: String(v.result_id),
  }));
  return {
    owner,
    pin: p,
    anchors,
    hubBundle: String(r.id),
    hubInstance: String(r.hub_instance),
    inventory: String(r.inventory_signature),
  };
}
export class ExistingHubReportStore extends HubWorkloadGcs {
  restore(link: HubReportLink) {
    return this.restorePage([link]);
  }
  async restorePage(links: readonly HubReportLink[]) {
    assertRegisteredPage(links);
    const p = links[0]!.pin;
    assertReportPin(p);
    const prefix =
      process.env.AIRFOILFOAM_REPORT_ARCHIVE_PREFIX ?? "progressive-reports/v1";
    requireReportProof(
      configuredDeploymentRole() === "hub" &&
        this.bucket === process.env.AIRFOILFOAM_EVIDENCE_BUCKET &&
        p.bucket === this.bucket &&
        p.objectKey ===
          `${prefix}/remote/${p.executionId}/${p.storedSha256}.jsonl.gz`,
      "Foreign original report location",
    );
    const url = this.url(p.objectKey, p.generation);
    const m = JSON.parse(
      (await boundedHubBody(await this.call(url.toString()), 65536)).toString(
        "utf8",
      ),
    );
    requireReportProof(
      m.bucket === p.bucket &&
        m.name === p.objectKey &&
        m.generation === p.generation &&
        m.size === String(p.storedByteSize) &&
        m.contentType === p.mimeType &&
        !m.contentEncoding &&
        m.crc32c === p.crc32c &&
        m.metadata?.sha256 === p.storedSha256 &&
        m.metadata?.byteSize === String(p.storedByteSize) &&
        m.metadata?.executionId === p.executionId &&
        m.metadata?.sourceKind === "remote" &&
        m.metadata?.archiveFormat === "jsonl",
      "Pinned hub report metadata differs",
    );
    url.searchParams.set("alt", "media");
    const bytes = await boundedHubBody(
      await this.call(url.toString()),
      p.storedByteSize,
    );
    await inspectHubReportPage(Readable.from([bytes]), links);
    return bytes;
  }
}
