import { sql, type SQL } from "drizzle-orm";
import type { DB } from "./client";
import {
  parseReportJson,
  reportJsonObject,
  reportTextIdentity,
  type ReportJson,
} from "./progressive-report-archive";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const MAX_ATTEMPT_EVIDENCE_BYTES = 32 * 1024 ** 2;
export const ATTEMPT_EVIDENCE_INLINE_REQUIRED =
  "sql-classification-and-immutable-payload-signatures" as const;

/** Resolve the actual relation on this connection's search path. A copied
 * 0207 table may coexist with 0208 tables in another schema during upgrades. */
export async function hasAttemptEvidenceStoragePointer(
  db: DB,
): Promise<boolean> {
  const [row] = await db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid=to_regclass('result_attempts') AND attname='evidence_archive_id' AND NOT attisdropped) AS ready`);
  return row?.ready === true;
}

export interface AttemptEvidenceAuditOptions {
  after?: string;
  limit?: number;
  maxStoredPayloadBytes?: number;
}

export interface AttemptEvidenceFieldMeasurement {
  path: string[];
  type: string;
  category: "history_series" | "point_metadata";
  occurrences: string;
  jsonTextBytes: string;
  largestValueBytes: string;
  largeValues: string;
}

export interface AttemptEvidenceAuditPage {
  measuredAt: string;
  rows: string;
  settledRows: string;
  inspectedRows: string;
  skippedRows: string;
  storedPayloadBytes: string;
  inspectedPayloadTextBytes: string;
  fields: AttemptEvidenceFieldMeasurement[];
  next: string | null;
  complete: boolean;
  inlineRequired: typeof ATTEMPT_EVIDENCE_INLINE_REQUIRED;
}

/** An ID page is fixed before any JSONB detoasting. Only aggregate byte counts
 * leave PostgreSQL; this query cannot update attempts or materialize pointers. */
export function attemptEvidenceAuditSql(
  options: AttemptEvidenceAuditOptions = {},
): SQL {
  const limit = options.limit ?? 32;
  const maxStored = options.maxStoredPayloadBytes ?? 8 * 1024 ** 2;
  if (
    (options.after !== undefined && !UUID.test(options.after)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 128 ||
    !Number.isSafeInteger(maxStored) ||
    maxStored < 1 ||
    maxStored > MAX_ATTEMPT_EVIDENCE_BYTES
  )
    throw new Error("Invalid bounded attempt evidence audit options");
  return sql`
    WITH ids AS MATERIALIZED (
      SELECT id FROM result_attempts ${options.after ? sql`WHERE id > ${options.after}::uuid` : sql``}
      ORDER BY id LIMIT ${limit}
    ), measured AS MATERIALIZED (
      SELECT a.id, pg_column_size(a.evidence_payload)::bigint AS stored_bytes,
        (a.status IN ('done','failed') AND (a.sim_job_id IS NULL OR
          (job.id IS NOT NULL AND job.status IN ('done','failed','cancelled') AND job."ingestedAt" IS NOT NULL
            AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())))) AS settled,
        CASE WHEN pg_column_size(a.evidence_payload) <= ${maxStored} THEN a.evidence_payload END AS payload
      FROM ids JOIN result_attempts a USING(id) LEFT JOIN sim_jobs job ON job.id=a.sim_job_id
    ), roots AS (
      SELECT root.key, root.value FROM measured
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(payload)='object' THEN payload ELSE '{}'::jsonb END) root
    ), leaves AS (
      SELECT ARRAY[root.key] AS path, root.value FROM roots root
      WHERE root.key NOT IN ('force_history','forceHistory','steady_history','steadyHistory','frame_track','frameTrack')
        OR jsonb_typeof(root.value) <> 'object'
      UNION ALL
      SELECT ARRAY[root.key,child.key],child.value FROM roots root
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(root.value)='object' THEN root.value ELSE '{}'::jsonb END) child
      WHERE root.key IN ('force_history','forceHistory','steady_history','steadyHistory','frame_track','frameTrack')
    ), sizes AS MATERIALIZED (
      SELECT path,jsonb_typeof(value) AS type,octet_length(value::text)::bigint AS bytes,
        CASE WHEN jsonb_typeof(value)='array' AND (
          (path[1] IN ('force_history','forceHistory') AND path[2] IN ('t','cl','cd','cm')) OR
          (path[1] IN ('steady_history','steadyHistory') AND path[2] IN ('iterations','cl','cd','cm')) OR
          (path[1] IN ('frame_track','frameTrack') AND path[2]='frames'))
          THEN 'history_series' ELSE 'point_metadata' END AS category FROM leaves
    ), fields AS (
      SELECT path,type,category,count(*)::text AS occurrences,sum(bytes)::text AS "jsonTextBytes",
        max(bytes)::text AS "largestValueBytes",count(*) FILTER (WHERE bytes >= 4096)::text AS "largeValues"
      FROM sizes GROUP BY path,type,category
    )
    SELECT jsonb_build_object('measuredAt',clock_timestamp(),'rows',count(*)::text,
      'settledRows',count(*) FILTER (WHERE settled)::text,
      'inspectedRows',count(*) FILTER (WHERE payload IS NOT NULL)::text,
      'skippedRows',count(*) FILTER (WHERE stored_bytes > ${maxStored})::text,
      'storedPayloadBytes',coalesce(sum(stored_bytes),0)::text,
      'inspectedPayloadTextBytes',coalesce(sum(octet_length(payload::text)::bigint),0)::text,
      'fields',coalesce((SELECT jsonb_agg(to_jsonb(fields) ORDER BY "jsonTextBytes"::bigint DESC,path) FROM fields),'[]'::jsonb),
      'next',CASE WHEN count(*)=${limit} THEN (SELECT id::text FROM ids ORDER BY id DESC LIMIT 1) END,
      'complete',count(*) < ${limit},'inlineRequired',${ATTEMPT_EVIDENCE_INLINE_REQUIRED}::text) AS audit
    FROM measured`;
}

/** The read-only transaction also bounds locks and CPU time on each page. */
export async function auditAttemptEvidencePage(
  db: DB,
  options: AttemptEvidenceAuditOptions = {},
): Promise<AttemptEvidenceAuditPage> {
  const query = attemptEvidenceAuditSql(options);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
    const [row] = await tx.execute(query);
    return row.audit as AttemptEvidenceAuditPage;
  });
}

const SERIES: Readonly<Record<string, readonly string[]>> = {
  force_history: ["t", "cl", "cd", "cm"],
  forceHistory: ["t", "cl", "cd", "cm"],
  steady_history: ["iterations", "cl", "cd", "cm"],
  steadyHistory: ["iterations", "cl", "cd", "cm"],
  frame_track: ["frames"],
  frameTrack: ["frames"],
};

export interface AttemptEvidenceCopySource {
  attemptId: string;
  resultId: string | null;
  simJobId: string | null;
  payloadText: string;
}

export interface AttemptEvidenceCopyPlan {
  version: "attempt-evidence-copy-v1";
  source: AttemptEvidenceCopySource;
  sourceSha256: string;
  sourceByteSize: number;
  historySeries: Array<{ path: string[]; byteSize: number; sha256: string }>;
  /** Copy verification does not authorize any shortening of the online payload. */
  inlineRequired: typeof ATTEMPT_EVIDENCE_INLINE_REQUIRED;
}

function objectOrNull(
  value: ReportJson | undefined,
): Record<string, ReportJson> | null {
  try {
    return reportJsonObject(value!);
  } catch {
    return null;
  }
}

/** Exact PostgreSQL source text stays inside a string envelope. Arrays are only
 * inventoried, never replaced by objects, sentinels, empty values or references. */
export function prepareAttemptEvidenceCopy(
  source: AttemptEvidenceCopySource,
): AttemptEvidenceCopyPlan {
  if (
    !source ||
    typeof source.attemptId !== "string" ||
    !UUID.test(source.attemptId)
  )
    throw new Error("Attempt evidence copy requires an exact attempt UUID");
  for (const id of [source.attemptId, source.resultId, source.simJobId])
    if (id !== null && (typeof id !== "string" || !UUID.test(id)))
      throw new Error("Attempt evidence copy requires exact owner UUIDs");
  if (
    typeof source.payloadText !== "string" ||
    Buffer.byteLength(source.payloadText, "utf8") > MAX_ATTEMPT_EVIDENCE_BYTES
  )
    throw new Error(
      "Attempt evidence exceeds its copy byte limit or is missing exact text",
    );
  const proof = reportTextIdentity(source.payloadText);
  const roots = new Map<string, string>();
  const payload = reportJsonObject(parseReportJson(source.payloadText, roots));
  const historySeries: AttemptEvidenceCopyPlan["historySeries"] = [];
  for (const [key, children] of Object.entries(SERIES)) {
    if (!objectOrNull(payload[key])) continue;
    const fields = new Map<string, string>();
    const history = reportJsonObject(parseReportJson(roots.get(key)!, fields));
    for (const child of children) {
      if (!Array.isArray(history[child])) continue;
      const exact = reportTextIdentity(fields.get(child)!);
      historySeries.push({
        path: [key, child],
        byteSize: exact.byteSize,
        sha256: exact.sha256,
      });
    }
  }
  return {
    version: "attempt-evidence-copy-v1",
    source: { ...source },
    sourceSha256: proof.sha256,
    sourceByteSize: proof.byteSize,
    historySeries,
    inlineRequired: ATTEMPT_EVIDENCE_INLINE_REQUIRED,
  };
}

/** Read-only preparation for a future copy. Active/missing owners and oversized
 * bodies never leave PostgreSQL; this is not an offload/compaction operation. */
export async function loadSettledAttemptEvidenceCopy(
  db: DB,
  attemptId: string,
): Promise<AttemptEvidenceCopySource> {
  if (!UUID.test(attemptId))
    throw new Error("Attempt evidence copy requires a stable UUID");
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
    const hasPointer = await hasAttemptEvidenceStoragePointer(
      tx as unknown as DB,
    );
    const [row] = await tx.execute(sql`
      SELECT a.id AS "attemptId",a.result_id AS "resultId",a.sim_job_id AS "simJobId",
        CASE WHEN octet_length(a.evidence_payload::text) <= ${MAX_ATTEMPT_EVIDENCE_BYTES}
          THEN a.evidence_payload::text END AS "payloadText"
      FROM result_attempts a LEFT JOIN sim_jobs job ON job.id=a.sim_job_id
      WHERE a.id=${attemptId}::uuid AND a.status IN ('done','failed') AND jsonb_typeof(a.evidence_payload)='object'
        ${hasPointer ? sql`AND a.evidence_archive_id IS NULL` : sql``}
        AND (a.sim_job_id IS NULL OR (job.id IS NOT NULL AND job.status IN ('done','failed','cancelled')
          AND job."ingestedAt" IS NOT NULL AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())))`);
    if (!row || typeof row.payloadText !== "string")
      throw new Error(
        "Attempt evidence is active, missing, or exceeds its copy byte limit",
      );
    const source = row as unknown as AttemptEvidenceCopySource;
    prepareAttemptEvidenceCopy(source);
    return source;
  });
}
