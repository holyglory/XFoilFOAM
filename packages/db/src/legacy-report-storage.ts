/** Operator backup SQL only. No dispatch, broker, scientific-result or policy writes. */
export const LEGACY_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const LEGACY_HASH = /^[a-f0-9]{64}$/;
/** Worker operator SQL supports actual per-row mutation counts. */
export const LEGACY_REPORT_NORMALIZATION_COUNTERS = 1;
export type LegacyReportKind = "report" | "conflict";
export interface LegacyReportTarget {
  executionId: string;
  reportAfter?: number;
  reports: number;
  reportHighWater: number;
  conflicts: number;
  conflictHighWater: number;
}
export interface LegacyReportScope {
  version: 1;
  sourceInstance: string;
  solverId: string;
  measuredAt: string;
  executions: LegacyReportTarget[];
}
export interface LegacyReportMember {
  kind: LegacyReportKind;
  executionId: string;
  sequence: number;
  contentSignature: string;
  solverId: string | null;
  rowText: string;
  rowSha256: string;
  reportText: string;
  reportSha256: string;
  reportByteSize: number;
}

export function legacyBound(
  value: number,
  max: number,
  name: string,
  min = 1,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`Invalid ${name}: expected ${min}..${max}`);
  return value;
}

export function assertLegacyScope(scope: LegacyReportScope): void {
  if (
    scope.version !== 1 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(scope.sourceInstance) ||
    !LEGACY_UUID.test(scope.solverId) ||
    !Number.isFinite(Date.parse(scope.measuredAt)) ||
    !Array.isArray(scope.executions) ||
    scope.executions.length < 1 ||
    scope.executions.length > 10000
  )
    throw new Error("Invalid legacy report scope");
  let previous = "";
  for (const item of scope.executions) {
    if (!LEGACY_UUID.test(item.executionId) || item.executionId <= previous)
      throw new Error(
        "Scope execution ids must be unique, sorted lowercase UUIDs",
      );
    previous = item.executionId;
    legacyBound(item.reports, Number.MAX_SAFE_INTEGER, "report count");
    legacyBound(
      item.reportHighWater,
      Number.MAX_SAFE_INTEGER,
      "report high water",
    );
    legacyBound(
      item.reportAfter ?? 0,
      item.reportHighWater - 1,
      "report lower bound",
      0,
    );
    legacyBound(item.conflicts, Number.MAX_SAFE_INTEGER, "conflict count", 0);
    legacyBound(
      item.conflictHighWater,
      Number.MAX_SAFE_INTEGER,
      "conflict high water",
      0,
    );
    if (
      item.reports > item.reportHighWater - (item.reportAfter ?? 0) ||
      item.conflicts > item.conflictHighWater ||
      (item.conflicts === 0) !== (item.conflictHighWater === 0)
    )
      throw new Error("Inconsistent scope counts/high water");
  }
}

function target(executionId: string, kind: LegacyReportKind): string {
  if (!LEGACY_UUID.test(executionId) || !["report", "conflict"].includes(kind))
    throw new Error("Invalid legacy report key");
  return kind === "report"
    ? "public.progressive_worker_reports"
    : "public.progressive_worker_report_conflicts";
}

export function legacyReadOnlySql(query: string): string {
  return `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '2s';
SET LOCAL idle_in_transaction_session_timeout = '35s';
SET LOCAL timezone = 'UTC';
${query}
COMMIT;\n`;
}

/** Bounded, metadata-only inventories; union hub reports AND dispatches before anti-join. */
export function legacyInventorySql(
  side: "worker" | "hub",
  after = "00000000-0000-0000-0000-000000000000",
  limit = 256,
): string {
  if (!LEGACY_UUID.test(after) || !["worker", "hub"].includes(side))
    throw new Error("Invalid inventory request");
  legacyBound(limit, 1000, "inventory limit");
  const query =
    side === "hub"
      ? `SELECT jsonb_build_object('executionId', ids.sim_job_id::text,
 'hasReports', EXISTS(SELECT 1 FROM public.progressive_remote_reports r WHERE r.sim_job_id=ids.sim_job_id),
 'hasDispatch', EXISTS(SELECT 1 FROM public.progressive_remote_dispatches d WHERE d.sim_job_id=ids.sim_job_id))::text
FROM (SELECT sim_job_id FROM public.progressive_remote_reports
      UNION SELECT sim_job_id FROM public.progressive_remote_dispatches) ids
WHERE sim_job_id > '${after}'::uuid ORDER BY sim_job_id LIMIT ${limit};`
      : `WITH ids AS (SELECT DISTINCT sim_job_id FROM public.progressive_worker_reports
      WHERE sim_job_id > '${after}'::uuid ORDER BY sim_job_id LIMIT ${limit})
SELECT jsonb_build_object('executionId', ids.sim_job_id::text,
  'reports', (SELECT count(*) FROM public.progressive_worker_reports r WHERE r.sim_job_id=ids.sim_job_id),
  'reportHighWater', (SELECT max(sequence) FROM public.progressive_worker_reports r WHERE r.sim_job_id=ids.sim_job_id),
  'conflicts', (SELECT count(*) FROM public.progressive_worker_report_conflicts r WHERE r.sim_job_id=ids.sim_job_id),
  'conflictHighWater', coalesce((SELECT max(sequence) FROM public.progressive_worker_report_conflicts r WHERE r.sim_job_id=ids.sim_job_id),0))::text
FROM ids ORDER BY ids.sim_job_id;`;
  return legacyReadOnlySql(query);
}

export function legacyKeysSql(
  executionId: string,
  kind: LegacyReportKind,
  after: number,
  highWater: number,
  rows: number,
): string {
  const table = target(executionId, kind);
  legacyBound(after, Number.MAX_SAFE_INTEGER, "sequence cursor", 0);
  legacyBound(highWater, Number.MAX_SAFE_INTEGER, "high water", 0);
  legacyBound(rows, 128, "page rows");
  return legacyReadOnlySql(`SELECT jsonb_build_object('sequence', sequence)::text FROM ${table}
WHERE sim_job_id='${executionId}'::uuid AND sequence > ${after} AND sequence <= ${highWater}
ORDER BY sequence LIMIT ${rows};`);
}

/** No JSON numeric value crosses a JS parse/stringify boundary: both bodies are text. */
export function legacyMemberSql(
  executionId: string,
  kind: LegacyReportKind,
  sequence: number,
  maxBytes: number,
): string {
  const table = target(executionId, kind);
  legacyBound(sequence, Number.MAX_SAFE_INTEGER, "sequence");
  legacyBound(maxBytes, 256 * 1024 * 1024, "page bytes");
  const body =
    kind === "report"
      ? "public.resolve_progressive_report(to_jsonb(r.*))"
      : "public.resolve_progressive_report(storage.report, storage.result_payload_hash)";
  const join =
    kind === "conflict"
      ? `LEFT JOIN public.progressive_worker_conflict_storage storage
 ON storage.sim_job_id=r.sim_job_id AND storage.sequence=r.sequence AND storage.content_signature=r.content_signature`
      : "";
  const missing =
    kind === "conflict"
      ? "storage.report IS NULL OR storage.archive_bundle_id IS NOT NULL"
      : "false";
  return legacyReadOnlySql(`WITH selected AS MATERIALIZED (
 SELECT r.*, (${missing}) AS unavailable_source, to_jsonb(r.*)::text AS original_row_text, ${body}::text AS full_report_text
 FROM ${table} r ${join} WHERE r.sim_job_id='${executionId}'::uuid AND r.sequence=${sequence}
), measured AS MATERIALIZED (
 SELECT *, octet_length(full_report_text) AS report_bytes,
   octet_length(original_row_text) + octet_length(full_report_text) AS input_bytes FROM selected
)
SELECT CASE WHEN archived_at IS NOT NULL OR unavailable_source OR full_report_text IS NULL THEN jsonb_build_object('blocked','cold or missing source body requires its existing reader')
 WHEN input_bytes > ${maxBytes} THEN jsonb_build_object('blocked','row exceeds remaining byte budget','inputBytes',input_bytes)
 ELSE jsonb_build_object('kind','${kind}','executionId',sim_job_id::text,'sequence',sequence,
 'contentSignature',content_signature,'solverId',report->>'solverId',
 'rowText',original_row_text,'rowSha256',encode(sha256(convert_to(original_row_text,'UTF8')),'hex'),
 'reportText',full_report_text,'reportSha256',encode(sha256(convert_to(full_report_text,'UTF8')),'hex'),
 'reportByteSize',report_bytes) END::text FROM measured;`);
}

/** Generated for local operator psql, never sent through the read-only SSH adapter. */
export function legacyNormalizeSql(
  members: LegacyReportMember[],
  options: {
    apply?: boolean;
    restoreInline?: boolean;
    readersReady?: boolean;
    trackChanges?: boolean;
  } = {},
): string {
  legacyBound(members.length, 128, "normalization rows");
  if (options.apply && !options.readersReady)
    throw new Error(
      "Verify every 0198 reader before applying representation changes",
    );
  const blocks: string[] = [];
  let bytes = 0;
  const keys = new Set<string>();
  for (const member of members) {
    target(member.executionId, member.kind);
    legacyBound(member.sequence, Number.MAX_SAFE_INTEGER, "sequence");
    legacyBound(member.reportByteSize, 256 * 1024 * 1024, "report bytes");
    if (
      !LEGACY_HASH.test(member.contentSignature) ||
      !LEGACY_HASH.test(member.reportSha256)
    )
      throw new Error("Invalid report proof");
    const key = `${member.kind}:${member.executionId}:${member.sequence}`;
    if (keys.has(key)) throw new Error("Duplicate normalization key");
    keys.add(key);
    bytes += member.reportByteSize;
    if (member.kind === "conflict") continue; // 0198 has no conflict reference column.
    blocks.push(`DO $legacy$
DECLARE old_row public.progressive_worker_reports%ROWTYPE; new_row public.progressive_worker_reports%ROWTYPE; full_body jsonb; changed_rows integer:=0;
BEGIN
 SELECT * INTO STRICT old_row FROM public.progressive_worker_reports
 WHERE sim_job_id='${member.executionId}'::uuid AND sequence=${member.sequence} FOR UPDATE;
 IF old_row.archived_at IS NOT NULL THEN RAISE EXCEPTION 'Legacy report is cold archived; retain it'; END IF;
 full_body := public.resolve_progressive_report(to_jsonb(old_row.*));
 IF old_row.content_signature <> '${member.contentSignature}' OR
    encode(sha256(convert_to(full_body::text,'UTF8')),'hex') <> '${member.reportSha256}' OR
    octet_length(full_body::text) <> ${member.reportByteSize} THEN
   RAISE EXCEPTION 'Legacy source differs from verified backup; page rolled back';
 END IF;
 ${
   options.restoreInline
     ? `IF old_row.result_payload_hash IS NOT NULL THEN
   UPDATE public.progressive_worker_reports SET report=full_body,result_payload_hash=NULL
   WHERE sim_job_id=old_row.sim_job_id AND sequence=old_row.sequence;
   GET DIAGNOSTICS changed_rows = ROW_COUNT;
 END IF;`
     : `IF old_row.result_payload_hash IS NULL AND jsonb_typeof(full_body->'result')='object' THEN
   UPDATE public.progressive_worker_reports SET result_payload_hash=public.store_progressive_report_result(full_body->'result'),
     report=jsonb_set(full_body,'{result}',public.progressive_report_result_header(full_body->'result'),false)
   WHERE sim_job_id=old_row.sim_job_id AND sequence=old_row.sequence;
   GET DIAGNOSTICS changed_rows = ROW_COUNT;
 END IF;`
 }
 SELECT * INTO STRICT new_row FROM public.progressive_worker_reports WHERE sim_job_id=old_row.sim_job_id AND sequence=old_row.sequence;
 IF public.resolve_progressive_report(to_jsonb(new_row.*)) IS DISTINCT FROM full_body OR
   (to_jsonb(new_row.*)-'report'-'result_payload_hash') IS DISTINCT FROM (to_jsonb(old_row.*)-'report'-'result_payload_hash') THEN
   RAISE EXCEPTION 'Lossless legacy report proof failed; page rolled back';
 END IF;
 ${
   options.trackChanges
     ? `INSERT INTO pg_temp.legacy_report_storage_changes(sim_job_id,sequence,newly_normalized,restored_inline)
   VALUES (old_row.sim_job_id,old_row.sequence,${options.restoreInline ? "0" : "changed_rows"},${options.restoreInline ? "changed_rows" : "0"});`
     : ""
 }
END $legacy$;`);
  }
  legacyBound(bytes, 256 * 1024 * 1024, "normalization bytes");
  return `BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '35s';
DO $policy$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.progressive_report_storage_policy WHERE id=1 AND normalization_enabled=${!options.restoreInline}) THEN
   RAISE EXCEPTION '0198 reader/policy prerequisite not satisfied; policy was not changed';
 END IF;
END $policy$;
${options.trackChanges ? "CREATE TEMP TABLE legacy_report_storage_changes(sim_job_id uuid,sequence bigint,newly_normalized integer,restored_inline integer) ON COMMIT PRESERVE ROWS;" : ""}
${blocks.join("\n")}
${options.apply ? "COMMIT" : "ROLLBACK"};\n`;
}
