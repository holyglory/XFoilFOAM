import { canonicalAnalysisJson } from "@aerodb/db";
import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { ProgressiveReportArchiveStore, type ProgressiveReportArchiveMember } from "./progressive-report-archive-store";

const PAGE_SIZE = 128;
const COMPACTION_REPORT_LIMIT = 512;
const COMPACTION_CANDIDATE_LIMIT = COMPACTION_REPORT_LIMIT * 8;
const COMPACTION_CONFLICT_LIMIT = 256;

type SourceKind = "remote" | "worker";

function deploymentRole(): "hub" | "remote-solver" {
  return process.env.AIRFOILFOAM_DEPLOYMENT_ROLE?.trim() === "remote-solver"
    ? "remote-solver"
    : "hub";
}

function bucketFromEnv(): string | null {
  const value = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
  return value || null;
}

function reportHash(report: unknown): {sha256: string; byteSize: number} {
  const text = canonicalAnalysisJson(report);
  const bytes = Buffer.from(text, "utf8");
  const hash = createHash("sha256");
  hash.update(bytes);
  return {sha256: hash.digest("hex"), byteSize: bytes.byteLength};
}

async function* remoteArchiveLines(
  db: DB,
  executionId: string,
  members: ProgressiveReportArchiveMember[],
): AsyncGenerator<string> {
  let after = 0;
  while (true) {
    const rows = await db.execute(sql`
      SELECT sequence, content_signature,
        public.resolve_progressive_report(to_jsonb(progressive_remote_reports.*)) AS report
      FROM progressive_remote_reports
      WHERE sim_job_id = ${executionId}::uuid
        AND sequence > ${after}
      ORDER BY sequence
      LIMIT ${PAGE_SIZE}
    `);
    if (!rows.length) break;
    for (const row of rows) {
      const sequence = Number(row.sequence);
      const report = row.report as Record<string, unknown>;
      const serialized = canonicalAnalysisJson({
        kind: "report",
        sourceKind: "remote",
        executionId,
        sequence,
        contentSignature: String(row.content_signature),
        report,
      });
      const identity = reportHash(report);
      members.push({
        sourceKind: "remote",
        executionId,
        sequence,
        memberKind: "report",
        contentSignature: String(row.content_signature),
        reportSha256: identity.sha256,
        reportByteSize: identity.byteSize,
      });
      yield serialized;
      after = sequence;
    }
  }
}

async function archiveRemoteExecution(
  db: DB,
  store: ProgressiveReportArchiveStore,
  executionId: string,
): Promise<boolean> {
  const [candidate] = await db.execute(sql`
    SELECT job.id
    FROM sim_jobs job
    JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id = job.id
    JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
    WHERE job.id = ${executionId}::uuid
      AND job.request_payload->>'remoteSolver' = 'true'
      AND job.status IN ('done', 'failed', 'cancelled')
      AND job."ingestedAt" IS NOT NULL
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
      AND promise.status <> 'active'
      AND EXISTS (
        SELECT 1 FROM progressive_cfd_execution_stops stop
        WHERE stop.sim_job_id = job.id AND stop.engine_job_id = job.engine_job_id
      )
      AND EXISTS (
        SELECT 1 FROM progressive_remote_reports report
        WHERE report.sim_job_id = job.id AND report.archive_bundle_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM progressive_remote_reports report
        WHERE report.sim_job_id = job.id AND report.archive_bundle_id IS NOT NULL
      )
  `);
  if (!candidate) return false;

  const members: ProgressiveReportArchiveMember[] = [];
  const tempPath = store.temporaryPath();
  try {
    const local = await store.writeBundle(
      tempPath,
      remoteArchiveLines(db, executionId, members),
    );
    if (!members.length) return false;
    const remote = await store.putFile(tempPath, local, "remote", executionId);
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const [locked] = await connection.execute(sql`
        SELECT job.id FROM sim_jobs job
        JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
        WHERE job.id = ${executionId}::uuid
          AND job.status IN ('done', 'failed', 'cancelled')
          AND job."ingestedAt" IS NOT NULL
          AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
          AND promise.status <> 'active'
        FOR UPDATE OF job
      `);
      if (!locked) throw new Error("remote report archive scope changed before commit");
      const [reportCount] = await connection.execute(sql`
        SELECT count(*)::integer AS count
        FROM progressive_remote_reports
        WHERE sim_job_id=${executionId}::uuid AND archive_bundle_id IS NULL
      `);
      if (Number(reportCount?.count ?? 0) !== members.length)
        throw new Error("remote report archive scope changed after GCS upload");
      const [bundle] = await connection.execute(sql`
        INSERT INTO progressive_report_archive_bundles
          (source_kind,sim_job_id,bucket,object_key,generation,mime_type,compression,archive_format,
           stored_sha256,stored_byte_size,crc32c,member_count,first_sequence,last_sequence,verified_at)
        VALUES ('remote',${executionId}::uuid,${remote.bucket},${remote.objectKey},${remote.generation},
          ${remote.mimeType},${remote.compression},${remote.archiveFormat},${remote.storedSha256},
          ${remote.storedByteSize},${remote.crc32c},${members.length},${members[0]!.sequence},
          ${members[members.length-1]!.sequence},${remote.verifiedAt.toISOString()}::timestamptz)
        ON CONFLICT (source_kind,sim_job_id) DO NOTHING
        RETURNING id
      `);
      const resolvedBundle = bundle ?? (await connection.execute(sql`
        SELECT id,bucket,object_key,generation,stored_sha256,stored_byte_size,crc32c
        FROM progressive_report_archive_bundles
        WHERE source_kind='remote' AND sim_job_id=${executionId}::uuid
        FOR UPDATE
      `))[0];
      if (!resolvedBundle) throw new Error("report archive bundle was not registered");
      if (
        String(resolvedBundle.bucket) !== remote.bucket ||
        String(resolvedBundle.object_key) !== remote.objectKey ||
        String(resolvedBundle.generation) !== remote.generation ||
        String(resolvedBundle.stored_sha256) !== remote.storedSha256 ||
        Number(resolvedBundle.stored_byte_size) !== remote.storedByteSize ||
        String(resolvedBundle.crc32c) !== remote.crc32c
      )
        throw new Error("existing report archive bundle has a different GCS identity");
      const memberJson = JSON.stringify(
        members.map((member) => ({
          source_kind: member.sourceKind,
          execution_id: member.executionId,
          sequence: member.sequence,
          member_kind: member.memberKind,
          content_signature: member.contentSignature,
          report_sha256: member.reportSha256,
          report_byte_size: member.reportByteSize,
        })),
      );
      await connection.execute(sql`
        INSERT INTO progressive_report_archive_members
          (bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
        SELECT ${resolvedBundle.id}::uuid, member.source_kind, member.execution_id::uuid, member.sequence,
          member.member_kind, member.content_signature, member.report_sha256, member.report_byte_size
        FROM jsonb_to_recordset(${memberJson}::jsonb) AS member(
          source_kind text, execution_id text, sequence bigint, member_kind text,
          content_signature text, report_sha256 text, report_byte_size bigint)
        ON CONFLICT (source_kind,sim_job_id,member_kind,sequence) DO NOTHING
      `);
      const compacted = await connection.execute(sql`
        UPDATE progressive_remote_reports report SET
          archive_bundle_id=${resolvedBundle.id}::uuid,
          archived_at=clock_timestamp(),
          result_payload_hash=NULL,
          report=progressive_report_compact_header(report.report)
        WHERE report.sim_job_id=${executionId}::uuid
          AND report.archive_bundle_id IS NULL
        RETURNING report.sequence
      `);
      if (compacted.length !== members.length)
        throw new Error("report archive member count changed during compaction");
      await connection.execute(sql`
        DELETE FROM progressive_report_result_payloads payload
        WHERE NOT EXISTS (SELECT 1 FROM progressive_worker_reports worker WHERE worker.result_payload_hash=payload.content_hash)
          AND NOT EXISTS (SELECT 1 FROM progressive_remote_reports remote WHERE remote.result_payload_hash=payload.content_hash)
      `);
    });
    return true;
  } finally {
    await store.removeTemporary(tempPath);
  }
}

async function compactWorkerReports(db: DB): Promise<number> {
  const rows = await db.execute(sql`
    WITH eligible_jobs AS MATERIALIZED (
      SELECT job.id
      FROM sim_jobs job
      WHERE job.status IN ('done', 'failed', 'cancelled')
        AND job."ingestedAt" IS NOT NULL
        AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
        AND NOT EXISTS (
          SELECT 1
          FROM progressive_worker_reports pending
          WHERE pending.sim_job_id = job.id
            AND pending.acknowledged_at IS NULL
        )
    ),
    candidate_pool AS MATERIALIZED (
      SELECT report.sim_job_id, report.sequence
      FROM progressive_worker_reports report
      JOIN eligible_jobs job ON job.id = report.sim_job_id
      WHERE report.archive_bundle_id IS NULL
        AND report.archived_at IS NULL
        AND report.acknowledged_at IS NOT NULL
        AND jsonb_typeof(report.report->'result') = 'object'
      ORDER BY report.created_at, report.sim_job_id, report.sequence
      LIMIT ${COMPACTION_CANDIDATE_LIMIT}
    ),
    candidates AS MATERIALIZED (
      SELECT pool.sim_job_id, pool.sequence
      FROM candidate_pool pool
      WHERE progressive_worker_report_compaction_safe(pool.sim_job_id, pool.sequence)
      LIMIT ${COMPACTION_REPORT_LIMIT}
    )
    UPDATE progressive_worker_reports report SET
      archived_at=clock_timestamp(),
      result_payload_hash=NULL,
      report=progressive_report_compact_header(report.report)
    FROM candidates
    WHERE report.sim_job_id=candidates.sim_job_id AND report.sequence=candidates.sequence
    RETURNING report.sim_job_id
  `);
  await db.execute(sql`
    WITH candidates AS MATERIALIZED (
      SELECT conflict.sim_job_id, conflict.sequence
      FROM progressive_worker_report_conflicts conflict
      JOIN sim_jobs job ON job.id = conflict.sim_job_id
      WHERE conflict.archived_at IS NULL
        AND job.status IN ('done', 'failed', 'cancelled')
        AND job."ingestedAt" IS NOT NULL
        AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
        AND NOT EXISTS (
          SELECT 1
          FROM progressive_worker_reports report
          WHERE report.sim_job_id = conflict.sim_job_id
            AND report.archived_at IS NULL
        )
      ORDER BY conflict.created_at, conflict.sim_job_id, conflict.sequence
      LIMIT 256
    )
    UPDATE progressive_worker_report_conflicts conflict SET
      archived_at=clock_timestamp(),
      report=progressive_report_compact_header(conflict.report)
    FROM candidates
    WHERE conflict.sim_job_id = candidates.sim_job_id
      AND conflict.sequence = candidates.sequence
  `);
  await db.execute(sql`
    DELETE FROM progressive_report_result_payloads payload
    WHERE NOT EXISTS (SELECT 1 FROM progressive_worker_reports worker WHERE worker.result_payload_hash=payload.content_hash)
      AND NOT EXISTS (SELECT 1 FROM progressive_remote_reports remote WHERE remote.result_payload_hash=payload.content_hash)
  `);
  return rows.length;
}

export async function runProgressiveReportArchiveService(
  db: DB,
  signal: AbortSignal,
): Promise<void> {
  const role = deploymentRole();
  const bucket = bucketFromEnv();
  const store = role === "hub" && bucket
    ? new ProgressiveReportArchiveStore(bucket)
    : null;
  while (!signal.aborted) {
    try {
      if (store) {
        const [candidate] = await db.execute(sql`
          SELECT job.id
          FROM sim_jobs job
          JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
          JOIN sync_sweep_promises promise ON promise.id=dispatch.promise_id
          WHERE job.status IN ('done','failed','cancelled')
            AND job."ingestedAt" IS NOT NULL
            AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
            AND promise.status <> 'active'
            AND NOT EXISTS (SELECT 1 FROM progressive_report_archive_bundles bundle
              WHERE bundle.source_kind='remote' AND bundle.sim_job_id=job.id)
            AND EXISTS (SELECT 1 FROM progressive_remote_reports report
              WHERE report.sim_job_id=job.id AND report.archive_bundle_id IS NULL)
          ORDER BY coalesce(job."finishedAt",job."updatedAt"),job.id LIMIT 1
        `);
        if (candidate && await archiveRemoteExecution(db, store, String(candidate.id)))
          console.log(JSON.stringify({component:"progressive-report-archive", executionId:String(candidate.id), source:"remote"}));
      } else {
        const compacted = await compactWorkerReports(db);
        if (compacted)
          console.log(JSON.stringify({component:"progressive-report-compaction", compacted}));
      }
    } catch (error) {
      console.error("[sweeper] progressive report archive/compaction failed:", error instanceof Error ? error.message : String(error));
    }
    try {
      await delay(30_000, undefined, {signal});
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
