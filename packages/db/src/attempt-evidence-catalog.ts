import { sql, type SQL } from "drizzle-orm";
import type { DB } from "./client";
import {
  MAX_ATTEMPT_EVIDENCE_BYTES,
  attemptHistorySizesSql,
  hasAttemptEvidenceStoragePointer,
  type AttemptEvidenceCopyPlan,
  type AttemptEvidenceCopySource,
} from "./attempt-evidence-storage";

export interface AttemptEvidenceArchiveIdentity {
  sourceInstance: string;
  attemptId: string;
  resultId: string | null;
  simJobId: string | null;
  sourceSha256: string;
  sourceByteSize: number;
  envelopeSha256: string;
  envelopeByteSize: number;
  storedSha256: string;
  storedByteSize: number;
  crc32c: string;
  bucket: string;
  objectKey: string;
  generation: string;
  verifiedAt: Date;
}

export interface AttemptEvidenceArchiveRecord extends AttemptEvidenceArchiveIdentity {
  id: string;
  historySeries: AttemptEvidenceCopyPlan["historySeries"];
  historyByteSize: number;
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
export function assertAttemptEvidenceArchive(
  identity: AttemptEvidenceArchiveIdentity,
): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identity.sourceInstance) ||
    !UUID.test(identity.attemptId) ||
    (identity.resultId !== null && !UUID.test(identity.resultId)) ||
    (identity.simJobId !== null && !UUID.test(identity.simJobId)) ||
    ![
      identity.sourceSha256,
      identity.envelopeSha256,
      identity.storedSha256,
    ].every((value) => SHA.test(value)) ||
    !Number.isSafeInteger(identity.sourceByteSize) ||
    identity.sourceByteSize < 1 ||
    identity.sourceByteSize > MAX_ATTEMPT_EVIDENCE_BYTES ||
    !Number.isSafeInteger(identity.envelopeByteSize) ||
    identity.envelopeByteSize < 1 ||
    identity.envelopeByteSize > 2 * MAX_ATTEMPT_EVIDENCE_BYTES + 65536 ||
    !Number.isSafeInteger(identity.storedByteSize) ||
    identity.storedByteSize < 1 ||
    identity.storedByteSize > 2 * MAX_ATTEMPT_EVIDENCE_BYTES + 196608 ||
    !identity.bucket.trim() ||
    identity.bucket.includes("/") ||
    !identity.objectKey.trim() ||
    /(^\/|\/\/|(^|\/)\.{1,2}(\/|$))/.test(identity.objectKey) ||
    !/^[1-9][0-9]{0,19}$/.test(identity.generation) ||
    BigInt(identity.generation) > 18446744073709551615n ||
    !/^[A-Za-z0-9+/]{6}==$/.test(identity.crc32c) ||
    !Number.isFinite(identity.verifiedAt?.getTime())
  )
    throw new Error("Invalid verified attempt evidence archive identity");
}

const COLUMNS = sql`id,source_instance AS "sourceInstance",result_attempt_id AS "attemptId",result_id AS "resultId",sim_job_id AS "simJobId",
  source_sha256 AS "sourceSha256",source_byte_size::float8 AS "sourceByteSize",history_series AS "historySeries",history_byte_size::float8 AS "historyByteSize",
  envelope_sha256 AS "envelopeSha256",envelope_byte_size::float8 AS "envelopeByteSize",stored_sha256 AS "storedSha256",stored_byte_size::float8 AS "storedByteSize",
  bucket,object_key AS "objectKey",generation,crc32c,verified_at AS "verifiedAt"`;

function record(row: unknown): AttemptEvidenceArchiveRecord {
  const result = row as AttemptEvidenceArchiveRecord;
  result.verifiedAt = new Date(result.verifiedAt);
  assertAttemptEvidenceArchive(result);
  return result;
}

export async function attemptEvidenceCatalogReady(db: DB): Promise<boolean> {
  const [row] = await db.execute(
    sql`SELECT to_regclass('attempt_evidence_archives') IS NOT NULL AS ready`,
  );
  return row?.ready === true;
}

export async function getAttemptEvidenceArchive(
  db: DB,
  id: string,
): Promise<AttemptEvidenceArchiveRecord> {
  if (!UUID.test(id))
    throw new Error("Attempt evidence archive requires a stable catalog UUID");
  const [row] = await db.execute(
    sql`SELECT ${COLUMNS} FROM attempt_evidence_archives WHERE id=${id}::uuid`,
  );
  if (!row) throw new Error("Attempt evidence archive receipt was not found");
  return record(row);
}

export async function findAttemptEvidenceArchive(
  db: DB,
  sourceInstance: string,
  source: AttemptEvidenceCopySource,
  sha: string,
) {
  const [row] =
    await db.execute(sql`SELECT ${COLUMNS} FROM attempt_evidence_archives
    WHERE source_instance=${sourceInstance} AND result_attempt_id=${source.attemptId}::uuid AND source_sha256=${sha}
      AND result_id IS NOT DISTINCT FROM ${source.resultId}::uuid AND sim_job_id IS NOT DISTINCT FROM ${source.simJobId}::uuid
    ORDER BY verified_at DESC,id DESC LIMIT 1`);
  return row ? record(row) : null;
}

/** The SQL trigger independently checks owner, settled writers, exact PG source
 * and series hashes. It never shortens or updates result_attempts. */
export async function registerAttemptEvidenceArchive(
  db: DB,
  identity: AttemptEvidenceArchiveIdentity,
  plan: AttemptEvidenceCopyPlan,
) {
  assertAttemptEvidenceArchive(identity);
  if (
    identity.attemptId !== plan.source.attemptId ||
    identity.resultId !== plan.source.resultId ||
    identity.simJobId !== plan.source.simJobId ||
    identity.sourceSha256 !== plan.sourceSha256 ||
    identity.sourceByteSize !== plan.sourceByteSize ||
    !plan.historySeries.length
  )
    throw new Error("Attempt evidence receipt differs from its copied source");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
    const [row] = await tx.execute(sql`INSERT INTO attempt_evidence_archives
      (source_instance,result_attempt_id,result_id,sim_job_id,source_sha256,source_byte_size,history_series,history_byte_size,
       envelope_sha256,envelope_byte_size,stored_sha256,stored_byte_size,bucket,object_key,generation,crc32c,verified_at)
      VALUES (${identity.sourceInstance},${identity.attemptId}::uuid,${identity.resultId}::uuid,${identity.simJobId}::uuid,
        ${identity.sourceSha256},${identity.sourceByteSize},${JSON.stringify(plan.historySeries)}::jsonb,
        ${plan.historySeries.reduce((sum, field) => sum + field.byteSize, 0)},${identity.envelopeSha256},${identity.envelopeByteSize},
        ${identity.storedSha256},${identity.storedByteSize},${identity.bucket},${identity.objectKey},${identity.generation},${identity.crc32c},${identity.verifiedAt.toISOString()}::timestamptz)
      ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`);
    if (row) return { archive: record(row), created: true };
    const existing = await findAttemptEvidenceArchive(
      tx as unknown as DB,
      identity.sourceInstance,
      plan.source,
      plan.sourceSha256,
    );
    if (!existing)
      throw new Error(
        "Attempt evidence archive receipt conflicts with another exact source",
      );
    return { archive: existing, created: false };
  });
}

export function attemptEvidenceArchiveCandidatesSql(
  after: string | null = null,
  sourceInstance?: string,
  readThroughReady = false,
): SQL {
  if (after !== null && !UUID.test(after))
    throw new Error("Invalid attempt evidence archive cursor");
  return sql`WITH ids AS MATERIALIZED (SELECT id FROM result_attempts WHERE true
    ${after ? sql`AND id>${after}::uuid` : sql``}
    ${readThroughReady ? sql`AND evidence_archive_id IS NULL` : sql``} ORDER BY id LIMIT 32),
    sources AS MATERIALIZED (
      SELECT a.id,a.result_id,a.sim_job_id,
        (a.status IN ('done','failed') AND (a.sim_job_id IS NULL OR (job.id IS NOT NULL AND job.status IN ('done','failed','cancelled')
          AND job."ingestedAt" IS NOT NULL AND (job.ingest_lease_token IS NULL OR coalesce(job.ingest_lease_expires_at<=clock_timestamp(),false))))) AS settled,
        CASE WHEN pg_column_size(a.evidence_payload)<=${MAX_ATTEMPT_EVIDENCE_BYTES} THEN a.evidence_payload END AS payload
      FROM ids JOIN result_attempts a USING(id) LEFT JOIN sim_jobs job ON job.id=a.sim_job_id
    ), measured AS MATERIALIZED (
      SELECT sources.*,octet_length(payload::text) AS byte_size,series.*
      FROM sources CROSS JOIN LATERAL (${attemptHistorySizesSql(sql`payload`)}) series
    ) SELECT id,byte_size,history_bytes::text,
      (settled AND byte_size BETWEEN 1 AND ${MAX_ATTEMPT_EVIDENCE_BYTES} AND has_samples AND NOT EXISTS (
        SELECT 1 FROM attempt_evidence_archives archive WHERE archive.result_attempt_id=measured.id
          ${sourceInstance ? sql`AND archive.source_instance=${sourceInstance}` : sql``}
          AND archive.source_sha256=encode(sha256(convert_to(payload::text,'UTF8')),'hex') AND archive.source_byte_size=byte_size
          AND archive.result_id IS NOT DISTINCT FROM measured.result_id AND archive.sim_job_id IS NOT DISTINCT FROM measured.sim_job_id)) AS eligible
    FROM measured ORDER BY id`;
}

export async function attemptEvidenceArchiveCandidates(
  db: DB,
  after: string | null,
  sourceInstance: string,
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
    const hasPointer = await hasAttemptEvidenceStoragePointer(
      tx as unknown as DB,
    );
    return tx.execute(
      attemptEvidenceArchiveCandidatesSql(after, sourceInstance, hasPointer),
    ) as unknown as Promise<
      Array<{
        id: string;
        byte_size: number | null;
        history_bytes: string;
        eligible: boolean | null;
      }>
    >;
  });
}

/** Bounded current-use and remaining-copy census. Canonical selection, fit
 * inputs, fitted models and continuation references are distinct real uses. */
export function attemptEvidenceUseAuditSql(
  options: {
    after?: string;
    limit?: number;
    catalogReady?: boolean;
    sourceInstance?: string;
  } = {},
): SQL {
  const limit = options.limit ?? 32;
  if (
    (options.after !== undefined && !UUID.test(options.after)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 128
  )
    throw new Error("Invalid attempt evidence use-audit bounds");
  return sql`WITH ids AS MATERIALIZED (
    SELECT id FROM result_attempts ${options.after ? sql`WHERE id>${options.after}::uuid` : sql``} ORDER BY id LIMIT ${limit}
  ), reference_rows AS (
    SELECT current_result_attempt_id AS id,'canonical' AS role FROM results WHERE current_result_attempt_id IN (SELECT id FROM ids)
    UNION ALL SELECT result_attempt_id,'fit_receipt' FROM progressive_cfd_evidence WHERE result_attempt_id IN (SELECT id FROM ids)
    UNION ALL SELECT result_attempt_id,'fit_model' FROM progressive_polar_model_evidence WHERE result_attempt_id IN (SELECT id FROM ids)
    UNION ALL SELECT result_attempt_id,'campaign' FROM sim_campaign_points WHERE result_attempt_id IN (SELECT id FROM ids)
    UNION ALL SELECT source_result_attempt_id,'continuation' FROM sim_precalc_obligations WHERE source_result_attempt_id IN (SELECT id FROM ids)
    UNION ALL SELECT result_attempt_id,'continuation' FROM sim_precalc_obligation_attempts WHERE result_attempt_id IN (SELECT id FROM ids)
  ), use_flags AS (
    SELECT id,bool_or(role='canonical') AS canonical,bool_or(role='fit_receipt') AS fit_receipt,bool_or(role='fit_model') AS fit_model,
      bool_or(role='campaign') AS campaign,bool_or(role='continuation') AS continuation FROM reference_rows GROUP BY id
  ), measured AS MATERIALIZED (
    SELECT a.id,a.result_id,a.sim_job_id,coalesce(canonical,false) AS canonical,coalesce(fit_receipt,false) AS fit_receipt,
      coalesce(fit_model,false) AS fit_model,coalesce(campaign,false) AS campaign,coalesce(continuation,false) AS continuation,
      pg_column_size(a.evidence_payload)::bigint AS stored_bytes,
      CASE WHEN pg_column_size(a.evidence_payload)<=${MAX_ATTEMPT_EVIDENCE_BYTES} THEN a.evidence_payload END AS payload,
      (a.status IN ('done','failed') AND (a.sim_job_id IS NULL OR (job.id IS NOT NULL AND job.status IN ('done','failed','cancelled')
        AND job."ingestedAt" IS NOT NULL AND (job.ingest_lease_token IS NULL OR coalesce(job.ingest_lease_expires_at<=clock_timestamp(),false))))) AS settled
    FROM ids JOIN result_attempts a USING(id) LEFT JOIN use_flags ON use_flags.id=a.id LEFT JOIN sim_jobs job ON job.id=a.sim_job_id
  ), sizes AS MATERIALIZED (
    SELECT measured.*,octet_length(payload::text)::bigint AS source_bytes,series.*
    FROM measured CROSS JOIN LATERAL (${attemptHistorySizesSql(sql`payload`)}) series
  ), copies AS (
    SELECT *, (settled AND source_bytes BETWEEN 1 AND ${MAX_ATTEMPT_EVIDENCE_BYTES} AND has_samples) AS copy_eligible,
      ${
        options.catalogReady
          ? sql`EXISTS (SELECT 1 FROM attempt_evidence_archives archive WHERE archive.result_attempt_id=sizes.id
        ${options.sourceInstance ? sql`AND archive.source_instance=${options.sourceInstance}` : sql``}
        AND archive.result_id IS NOT DISTINCT FROM sizes.result_id AND archive.sim_job_id IS NOT DISTINCT FROM sizes.sim_job_id
        AND archive.source_byte_size=source_bytes AND archive.source_sha256=encode(sha256(convert_to(payload::text,'UTF8')),'hex'))`
          : sql`false`
      } AS catalogued
    FROM sizes
  ), groups AS (
    SELECT canonical,fit_receipt,fit_model,campaign,continuation,settled,count(*)::text AS rows,
      coalesce(sum(stored_bytes),0)::text AS "onlineStoredPayloadBytes",coalesce(sum(source_bytes),0)::text AS "sourceTextBytes",
      coalesce(sum(history_bytes),0)::text AS "historyBytes",count(*) FILTER (WHERE copy_eligible)::text AS "copyEligibleRows",
      count(*) FILTER (WHERE copy_eligible AND catalogued)::text AS "cataloguedRows",
      coalesce(sum(source_bytes) FILTER (WHERE copy_eligible AND NOT catalogued),0)::text AS "remainingGcsSourceBytes",
      coalesce(sum(history_bytes) FILTER (WHERE copy_eligible AND NOT catalogued),0)::text AS "remainingGcsHistoryBytes",
      count(*) FILTER (WHERE payload IS NULL)::text AS "uninspectedRows"
    FROM copies GROUP BY canonical,fit_receipt,fit_model,campaign,continuation,settled
  ) SELECT jsonb_build_object('measuredAt',clock_timestamp(),'rows',(SELECT count(*)::text FROM ids),
    'groups',coalesce((SELECT jsonb_agg(to_jsonb(groups)) FROM groups),'[]'::jsonb),
    'next',CASE WHEN (SELECT count(*) FROM ids)=${limit} THEN (SELECT id::text FROM ids ORDER BY id DESC LIMIT 1) END,
    'complete',(SELECT count(*) FROM ids)<${limit},'catalogReady',${options.catalogReady === true},'onlineBytesRemoved','0') AS audit`;
}

export async function auditAttemptEvidenceUsePage(
  db: DB,
  options: Parameters<typeof attemptEvidenceUseAuditSql>[0] = {},
) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
    const [row] = await tx.execute(attemptEvidenceUseAuditSql(options));
    return row.audit as {
      measuredAt: string;
      rows: string;
      groups: Array<Record<string, boolean | string>>;
      next: string | null;
      complete: boolean;
      catalogReady: boolean;
      onlineBytesRemoved: string;
    };
  });
}
