import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import {
  canonicalReportJson,
  parseReportJson,
  reportJsonObject,
  reportTextIdentity,
  reportValidationValue,
  type ReportJson,
  ReportJsonNumber,
} from "@aerodb/db/progressive-report-archive";
import { readProgressiveReport } from "@aerodb/db/progressive-report-reader";
import {
  analysisContentHash,
  progressiveReportedPointSources,
  validateProgressiveRemoteReport,
  type ProgressiveRemoteExecutionEnvelope,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import { existingProgressiveReportAttempts } from "./progressive-evidence-reuse";

// These are the only transport changes this proof accepts. AoA/case counts,
// failure state, stop proof, setup and unknown fields participate in equality.
const stableHeader = sql`((r.report - ARRAY['sequence','result','archivedReport'])
  #- '{status,solver_budget_progress}' #- '{status,updated_at}')::text`;
const limitBytes = 8 * 1024 ** 2;
const limitRows = 32;

// Preserve every reported physical case, running flag, limit and unknown
// budget field. Only the two changing clocks observed in historical polls
// are omitted. Token-preserving JSON also distinguishes numeric spellings.
function budgetIdentity(report: ReportJson): string | undefined {
  const s = reportJsonObject(report).status;
  if (
    !s ||
    typeof s !== "object" ||
    Array.isArray(s) ||
    s instanceof ReportJsonNumber
  )
    return undefined;
  const status = reportJsonObject(s);
  if (!Object.hasOwn(status, "solver_budget_progress")) return "absent";
  const budget = status.solver_budget_progress;
  if (budget === null) return "null";
  if (
    !budget ||
    typeof budget !== "object" ||
    Array.isArray(budget) ||
    budget instanceof ReportJsonNumber
  )
    return undefined;
  const value = reportJsonObject(budget);
  if (
    typeof value.observed_at !== "string" ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    !Array.isArray(value.cases)
  )
    return undefined;
  const { observed_at: _clock, cases, ...metadata } = value,
    fixed = [];
  for (const item of cases) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      item instanceof ReportJsonNumber
    )
      return undefined;
    const { solver_active_seconds: elapsed, ...physical } =
      reportJsonObject(item);
    if (elapsed === undefined) return undefined;
    const seconds = reportValidationValue(elapsed);
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
      return undefined;
    fixed.push(physical);
  }
  return JSON.stringify({ ...metadata, cases: fixed });
}

// All matching snapshots have the same scientific result. Reuse the SHA
// state through its canonical root field; hash each distinct signed suffix.
function memberSigner(result: string, budget: string) {
  let prefix: string | undefined;
  let shared: ReturnType<typeof createHash> | undefined;
  return (header: string) => {
    const parsed = parseReportJson(header);
    if (budgetIdentity(parsed) !== budget) return null;
    const fields = Object.entries(reportJsonObject(parsed)).sort(([a], [b]) =>
      a.localeCompare(b, "en"),
    );
    const at = fields.findIndex(([key]) => key === "result");
    if (at < 0) return null;
    const entry = ([key, value]: (typeof fields)[number]) =>
      JSON.stringify(key) + ":" + canonicalReportJson(value);
    const leading =
      "{" + fields.slice(0, at).map(entry).concat('"result":').join(",");
    if (!shared || leading !== prefix) {
      prefix = leading;
      shared = createHash("sha256").update(leading).update(result);
    }
    const suffix = fields.slice(at + 1).map(entry);
    return shared
      .copy()
      .update((suffix.length ? "," + suffix.join(",") : "") + "}")
      .digest("hex");
  };
}

function comparableHeader(report: ProgressiveRemoteReport) {
  const { result: _result, sequence: _sequence, status, ...fixed } = report;
  const {
    solver_budget_progress: _budget,
    updated_at: _clock,
    ...progress
  } = status;
  return analysisContentHash({ ...fixed, status: progress });
}

/** The caller owns a transaction. Select and prove a bounded page BEFORE taking
 * an ingestion lease. Explicit per-sequence staging and archive readback remain
 * independent of this scheduling cache. */
export async function coverHistoricalWorkerStagingCopies(
  db: DB,
  job: string,
  sequence: number,
): Promise<number> {
  const [owner] =
    await db.execute(sql`SELECT j.request_payload->'remoteProgressiveExecution' AS envelope,p.id::text AS promise,
    s.remote_solver_registered_id::text AS solver FROM public.sim_jobs j JOIN public.sync_api_settings s ON s.id=1
    JOIN public.sync_sweep_promises p ON p.id::text=j.request_payload->>'syncPromiseId' AND p.registered_solver_id=s.remote_solver_registered_id
    WHERE j.id=${job}::uuid AND j.status IN ('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL
      AND j.engine_job_id=j.id::text AND j.request_payload->>'remoteSolver'='true' AND j.request_payload->>'upstreamBaseUrl'=s.upstream_base_url
      AND p.source_base_url=s.upstream_base_url AND p.status IN ('fulfilled','cancelled','expired')
      AND NOT s.remote_solver_transfer_paused AND s.remote_solver_auth_token<>''
      AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
      AND j.request_payload#>>'{remoteProgressiveExecution,scope,executionId}'=j.id::text
      AND jsonb_typeof(j.request_payload->'engineRequest')='object'
      AND (j.request_payload->'engineRequest')::text COLLATE "C"=(j.request_payload#>'{remoteProgressiveExecution,request}')::text COLLATE "C"
      AND EXISTS(SELECT 1 FROM (SELECT stopped_engine_job_id,report FROM public.progressive_worker_reports
        WHERE sim_job_id=j.id ORDER BY sequence DESC LIMIT 1) stop WHERE stop.stopped_engine_job_id=j.engine_job_id
        AND stop.report->>'solverId'=s.remote_solver_registered_id::text AND stop.report->>'promiseId'=p.id::text AND stop.report->>'executionId'=j.id::text
        AND stop.report#>>'{stopProof,version}'='1' AND stop.report#>>'{stopProof,fence}' IN ('cancel_marker','terminal_result')
        AND stop.report#>>'{stopProof,observed_at}' IS NOT NULL
        AND (stop.report#>>'{stopProof,ownership_basis}' IS NULL OR stop.report#>>'{stopProof,ownership_basis}' IN ('recorded_execution_namespace','never_started_cancellation_fence'))
        AND (stop.report#>>'{stopProof,ownership_basis}' IS DISTINCT FROM 'never_started_cancellation_fence' OR stop.report#>>'{stopProof,fence}'='cancel_marker')
        AND stop.report#>>'{status,state}' IN ('failed','completed','cancelled') AND stop.report#>>'{stopProof,producer_stopped}'='true'
        AND stop.report#>>'{stopProof,namespace_verified}'='true' AND stop.report#>'{stopProof,remaining}'='[]'::jsonb
        AND stop.report#>'{stopProof,error}'='null'::jsonb)
      AND NOT EXISTS(SELECT 1 FROM public.progressive_worker_staging_failures f WHERE f.sim_job_id=j.id AND f.sequence=${sequence})
      AND EXISTS(SELECT 1 FROM public.progressive_worker_evidence_attempts a WHERE a.sim_job_id=j.id AND a.sequence<>${sequence})
      AND NOT EXISTS(SELECT 1 FROM public.progressive_worker_reports pending WHERE pending.sim_job_id=j.id AND pending.acknowledged_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM public.progressive_worker_evidence_delivery_claims claim WHERE claim.sim_job_id=j.id AND claim.claim_expires_at>clock_timestamp())
      AND NOT EXISTS(SELECT 1 FROM public.progressive_worker_delivery_failures f WHERE f.sim_job_id=j.id AND f.state='retry')
    FOR UPDATE OF j SKIP LOCKED FOR SHARE OF p SKIP LOCKED`);
  if (!owner) return 0;
  const [first] = await db.execute(sql`WITH original AS MATERIALIZED (
      SELECT public.resolve_progressive_report(r.report,r.result_payload_hash)::text AS body,r.content_signature,${stableHeader} AS stable
      FROM public.progressive_worker_reports r WHERE r.sim_job_id=${job}::uuid AND r.sequence=${sequence} AND r.archived_at IS NULL
        AND r.archive_bundle_id IS NULL AND r.report->>'archivedReport' IS DISTINCT FROM 'true'
        AND r.acknowledged_at IS NOT NULL AND pg_column_size(r.report)<=${limitBytes}
        AND (r.result_payload_hash IS NULL OR EXISTS(SELECT 1 FROM public.progressive_report_result_payloads p
           WHERE p.content_hash=r.result_payload_hash AND p.byte_size<=${limitBytes})))
    SELECT * FROM original WHERE octet_length(body)<=${limitBytes}`);
  if (!first) return 0;
  const fields = new Map<string, string>(),
    parsed = parseReportJson(String(first.body), fields);
  const raw = fields.get("result"),
    env = owner.envelope as ProgressiveRemoteExecutionEnvelope;
  if (
    !raw?.startsWith("{") ||
    reportTextIdentity(canonicalReportJson(parsed)).sha256 !==
      first.content_signature
  )
    return 0;
  let report: ProgressiveRemoteReport;
  try {
    const validated = validateProgressiveRemoteReport(
      reportValidationValue(parsed),
      env,
    );
    if (validated.contentSignature !== first.content_signature) return 0;
    report = validated.report;
  } catch {
    return 0;
  } // The ordinary stage owns validation/failure reporting.
  if (
    !report.result ||
    report.solverId !== owner.solver ||
    report.promiseId !== owner.promise
  )
    return 0;
  const points = progressiveReportedPointSources(report.result)
    .map((p) => p.contentSignature)
    .sort();
  if (!points.length || points.length > 512) return 0;
  const result = reportTextIdentity(raw),
    canonical = canonicalReportJson(reportJsonObject(parsed).result!);
  // Check at most two genuine neighbors and one indexed 0209 source. A cold
  // source requires its original archive witness and the normal product read.
  const budget = budgetIdentity(parsed);
  if (budget === undefined) return 0;
  const signature = memberSigner(canonical, budget);
  const sources = await db.execute(sql`WITH ids AS (
      (SELECT sequence FROM public.progressive_worker_evidence_receipts WHERE sim_job_id=${job}::uuid AND sequence<${sequence} ORDER BY sequence DESC LIMIT 1)
      UNION (SELECT sequence FROM public.progressive_worker_evidence_receipts WHERE sim_job_id=${job}::uuid AND sequence>${sequence} ORDER BY sequence LIMIT 1)
      UNION (SELECT sequence FROM public.progressive_worker_report_science_proofs WHERE sim_job_id=${job}::uuid AND result_sha256=${result.sha256}
          AND result_byte_size=${result.byteSize} AND sequence<>${sequence} ORDER BY sequence LIMIT 1))
    SELECT r.sequence::float8 AS seq,r.content_signature AS sig,r.archived_at IS NOT NULL AS cold,
      CASE WHEN r.archived_at IS NULL THEN jsonb_set(r.report,'{result}','null',false)::text END AS header
    FROM ids JOIN public.progressive_worker_evidence_receipts e ON e.sim_job_id=${job}::uuid AND e.sequence=ids.sequence
    JOIN public.progressive_worker_reports r ON r.sim_job_id=e.sim_job_id AND r.sequence=e.sequence AND r.content_signature=e.content_signature
    WHERE r.acknowledged_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.progressive_worker_report_conflicts c WHERE c.sim_job_id=r.sim_job_id AND c.sequence=r.sequence)
      AND CASE WHEN r.archived_at IS NOT NULL THEN EXISTS(SELECT 1 FROM public.progressive_worker_report_science_proofs proof
         JOIN public.progressive_report_archive_members m ON m.bundle_id=r.archive_bundle_id AND m.source_kind='worker' AND m.member_kind='report'
           AND m.sim_job_id=r.sim_job_id AND m.sequence=r.sequence AND m.content_signature=r.content_signature
           AND m.report_sha256=proof.report_sha256 AND m.report_byte_size=proof.report_byte_size
         WHERE proof.sim_job_id=r.sim_job_id AND proof.sequence=r.sequence AND proof.report_content_signature=r.content_signature
           AND proof.result_sha256=${result.sha256} AND proof.result_byte_size=${result.byteSize} AND proof.point_signatures=${JSON.stringify(points)}::jsonb)
      ELSE r.report->>'archivedReport' IS DISTINCT FROM 'true' AND ${stableHeader} COLLATE "C"=${first.stable}::text COLLATE "C" AND
        CASE WHEN r.result_payload_hash IS NOT NULL THEN r.result_payload_hash=${result.sha256} AND EXISTS
          (SELECT 1 FROM public.progressive_report_result_payloads payload WHERE payload.content_hash=r.result_payload_hash AND payload.byte_size=${result.byteSize})
          ELSE pg_column_size(r.report)<=${limitBytes} AND pg_catalog.record_image_eq(ROW(r.report->'result'),ROW(${raw}::jsonb)) END END
      AND public.worker_report_science_evidence_matches(r.sim_job_id,r.sequence,${JSON.stringify(points)}::jsonb)
    ORDER BY abs(r.sequence-${sequence}) LIMIT 3 FOR UPDATE OF e SKIP LOCKED`);
  for (const src of sources) {
    const srcSeq = Number(src.seq);
    if (src.cold) {
      let body: ProgressiveRemoteReport;
      try {
        body = await readProgressiveReport(db, {
          sourceKind: "worker",
          executionId: job,
          sequence: srcSeq,
          contentSignature: String(src.sig),
        });
      } catch {
        continue;
      } // A missing authenticated source cannot cover a live report.
      if (
        comparableHeader(body) !== comparableHeader(report) ||
        budgetIdentity(parseReportJson(JSON.stringify(body))) !== budget
      )
        continue;
    } else if (signature(String(src.header)) !== src.sig) continue;
    const bound =
      await db.execute(sql`SELECT a.point_content_signature AS point,a.result_attempt_id::text AS id
      FROM public.progressive_worker_evidence_attempts a JOIN public.result_attempts t ON t.id=a.result_attempt_id
      JOIN public.progressive_worker_hub_receipts h ON h.sim_job_id=a.sim_job_id AND h.result_attempt_id=a.result_attempt_id AND h.point_content_signature=a.point_content_signature
      WHERE a.sim_job_id=${job}::uuid AND a.sequence=${srcSeq} ORDER BY a.point_content_signature COLLATE "C" FOR SHARE OF a,t,h SKIP LOCKED`);
    if (
      bound.length !== points.length ||
      bound.some((v, i) => v.point !== points[i])
    )
      continue;
    // The ordinary scientific reuse verifier checks the original attempt
    // payload/projection, including rejected points, once for the whole page.
    const ids = await existingProgressiveReportAttempts(db, report, env);
    if (
      !ids ||
      ids.sort().join() !==
        bound
          .map((x) => String(x.id))
          .sort()
          .join()
    )
      return 0;
    const count = Math.min(
      limitRows,
      Math.max(1, Math.floor((16 * 1024 ** 2) / result.byteSize)),
    );
    const candidates = await db.execute(sql`WITH keys AS MATERIALIZED (
        SELECT sequence FROM public.progressive_worker_reports WHERE sim_job_id=${job}::uuid AND sequence>=${sequence} ORDER BY sequence LIMIT ${count}),
      anchor AS MATERIALIZED (SELECT ${raw}::jsonb AS body), matches AS MATERIALIZED (
      SELECT r.sequence::float8 AS seq,r.content_signature AS sig,jsonb_set(r.report,'{result}','null',false)::text AS header
      FROM keys JOIN public.progressive_worker_reports r ON r.sim_job_id=${job}::uuid AND r.sequence=keys.sequence CROSS JOIN anchor
      WHERE r.acknowledged_at IS NOT NULL AND r.archived_at IS NULL AND r.archive_bundle_id IS NULL
        AND r.report->>'archivedReport' IS DISTINCT FROM 'true' AND pg_column_size(r.report)<=${limitBytes}
        AND ${stableHeader} COLLATE "C"=${first.stable}::text COLLATE "C"
        AND NOT EXISTS(SELECT 1 FROM public.progressive_worker_evidence_receipts e WHERE e.sim_job_id=r.sim_job_id AND e.sequence=r.sequence)
        AND NOT EXISTS(SELECT 1 FROM public.progressive_worker_report_conflicts c WHERE c.sim_job_id=r.sim_job_id AND c.sequence=r.sequence)
        AND NOT EXISTS(SELECT 1 FROM public.progressive_worker_staging_failures f WHERE f.sim_job_id=r.sim_job_id AND f.sequence=r.sequence)
        AND CASE WHEN r.result_payload_hash IS NOT NULL THEN r.result_payload_hash=${result.sha256} AND EXISTS
          (SELECT 1 FROM public.progressive_report_result_payloads payload WHERE payload.content_hash=r.result_payload_hash AND payload.byte_size=${result.byteSize})
          ELSE pg_catalog.record_image_eq(ROW(r.report->'result'),ROW(anchor.body)) END
      ORDER BY r.sequence FOR SHARE OF r SKIP LOCKED),
      sized AS (SELECT matches.*,sum(octet_length(header)) OVER(ORDER BY seq) AS returned_bytes FROM matches)
      SELECT seq,sig,header FROM sized WHERE returned_bytes<=${2 * 1024 ** 2} ORDER BY seq`);
    const verified = candidates
      .filter((c) => signature(String(c.header)) === c.sig)
      .map((c) => ({ seq: Number(c.seq), sig: String(c.sig) }));
    if (!verified.some((c) => c.seq === sequence)) return 0;
    const changed =
      await db.execute(sql`INSERT INTO public.progressive_worker_staging_copies
      (sim_job_id,sequence,source_sequence,report_signature,source_signature,result_sha256,result_byte_size,point_signatures,promise_id,solver_id)
      SELECT ${job}::uuid,m.seq,${srcSeq},m.sig,${src.sig},${result.sha256},${result.byteSize},${JSON.stringify(points)}::jsonb,${owner.promise}::uuid,${owner.solver}::uuid
      FROM jsonb_to_recordset(${JSON.stringify(verified)}::jsonb) m(seq bigint,sig text)
      ON CONFLICT(sim_job_id,sequence) DO UPDATE SET source_sequence=excluded.source_sequence,report_signature=excluded.report_signature,
        source_signature=excluded.source_signature,result_sha256=excluded.result_sha256,result_byte_size=excluded.result_byte_size,
        point_signatures=excluded.point_signatures,promise_id=excluded.promise_id,solver_id=excluded.solver_id RETURNING sequence`);
    return changed.length;
  }
  return 0;
}
