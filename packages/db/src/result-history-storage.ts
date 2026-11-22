import { sql, type SQL } from "drizzle-orm";
import type { DB } from "./client";
import { canonicalAnalysisJson } from "./analysis-target";
import {
  MAX_RESULT_HISTORY_BYTES,
  assertResultHistoryArchive,
  assertResultHistorySource,
  resultHistorySha256,
  type ResultHistoryArchiveIdentity,
  type ResultHistoryKind,
  type ResultHistoryReader,
  type ResultHistorySource,
} from "@aerodb/core/result-history-storage";

function assertId(id: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id))
    throw new Error("Result history requires an exact result UUID");
}
function column(kind: ResultHistoryKind) {
  if (kind !== "steady_history" && kind !== "frame_track")
    throw new Error("Unknown result history kind");
  return sql.identifier(kind);
}
function pointer(kind: ResultHistoryKind) {
  column(kind);
  return sql.identifier(`${kind}_archive_id`);
}

/** Shared SQL equality boundary for full incoming histories and compact rows. */
export function resultHistoryMatchesSql(
  rowAlias: SQL,
  kind: ResultHistoryKind,
  candidate: SQL,
): SQL<boolean> {
  column(kind);
  return sql<boolean>`result_history_matches(to_jsonb(${rowAlias}), ${kind}, ${candidate})`;
}
export async function resultHistoriesMatch(
  db: DB,
  resultId: string,
  histories: { steadyHistory: unknown; frameTrack: unknown },
): Promise<boolean> {
  assertId(resultId);
  const [row] = await db.execute(sql`
    SELECT ${resultHistoryMatchesSql(sql`r`, "steady_history", sql`${JSON.stringify(histories.steadyHistory ?? null)}::jsonb`)}
      AND ${resultHistoryMatchesSql(sql`r`, "frame_track", sql`${JSON.stringify(histories.frameTrack ?? null)}::jsonb`)} AS matches
    FROM results r WHERE r.id = ${resultId}::uuid
  `);
  return row?.matches === true;
}

function eligible(alias: SQL) {
  return sql`NOT EXISTS (SELECT 1 FROM sim_jobs job WHERE job.id = ${alias}.sim_job_id
    AND (job.status NOT IN ('done','failed','cancelled') OR
      (job.ingest_lease_token IS NOT NULL AND job.ingest_lease_expires_at > clock_timestamp())))
    AND NOT EXISTS (SELECT 1 FROM result_attempts attempt JOIN sim_jobs job ON job.id = attempt.sim_job_id
      WHERE attempt.id = ${alias}.current_result_attempt_id AND
        (job.status NOT IN ('done','failed','cancelled') OR
          (job.ingest_lease_token IS NOT NULL AND job.ingest_lease_expires_at > clock_timestamp())))`;
}

export async function loadResultHistorySource(
  db: DB,
  resultId: string,
  kind: ResultHistoryKind,
): Promise<ResultHistorySource & { compactByteSize: number }> {
  assertId(resultId);
  const [row] = await db.execute(sql`
    SELECT r.current_result_attempt_id, octet_length(r.${column(kind)}::text) AS byte_size,
      octet_length(result_history_compact(r.${column(kind)})::text) AS compact_byte_size,
      CASE WHEN octet_length(r.${column(kind)}::text) <= ${MAX_RESULT_HISTORY_BYTES}
        THEN r.${column(kind)}::text END AS payload_text
    FROM results r WHERE r.id=${resultId}::uuid AND r.${pointer(kind)} IS NULL
      AND r.${column(kind)} IS NOT NULL AND r.${column(kind)} <> 'null'::jsonb
  `);
  if (!row || typeof row.payload_text !== "string")
    throw new Error(
      "Result history is missing, archived, or exceeds its byte limit",
    );
  const source: ResultHistorySource = {
    sourceKind: kind,
    resultId,
    resultAttemptId: row.current_result_attempt_id
      ? String(row.current_result_attempt_id)
      : null,
    payloadText: row.payload_text,
  };
  assertResultHistorySource(source);
  return { ...source, compactByteSize: Number(row.compact_byte_size) };
}

export interface ResultHistoryArchiveRecord extends ResultHistoryArchiveIdentity {
  id: string;
  metadataText: string;
}
const ARCHIVE_COLUMNS = sql`id, source_instance AS "sourceInstance", source_kind AS "sourceKind",
  result_id AS "resultId", result_attempt_id AS "resultAttemptId", source_sha256 AS "sourceSha256",
  source_byte_size::float8 AS "sourceByteSize", inline_metadata::text AS "metadataText",
  envelope_sha256 AS "envelopeSha256", envelope_byte_size::float8 AS "envelopeByteSize",
  stored_sha256 AS "storedSha256", stored_byte_size::float8 AS "storedByteSize", bucket,
  object_key AS "objectKey", generation, crc32c, verified_at AS "verifiedAt"`;

export async function getResultHistoryArchive(
  db: DB,
  id: string,
): Promise<ResultHistoryArchiveRecord> {
  assertId(id);
  const [row] = (await db.execute(
    sql`SELECT ${ARCHIVE_COLUMNS} FROM result_history_archives WHERE id=${id}::uuid`,
  )) as unknown as ResultHistoryArchiveRecord[];
  if (!row) throw new Error("Result history archive catalog entry is missing");
  row.verifiedAt = new Date(row.verifiedAt);
  assertResultHistoryArchive(row);
  return row;
}

export async function resultHistoryArchiveForRow(
  db: DB,
  resultId: string,
  kind: ResultHistoryKind,
) {
  assertId(resultId);
  const [row] = await db.execute(
    sql`SELECT r.${pointer(kind)} AS id FROM results r WHERE r.id=${resultId}::uuid`,
  );
  return row?.id ? getResultHistoryArchive(db, String(row.id)) : null;
}

/** Called after generation-pinned readback. The database independently matches
 * source bytes and the selected generation before registering the receipt. */
export async function registerResultHistoryArchive(
  db: DB,
  identity: ResultHistoryArchiveIdentity,
): Promise<ResultHistoryArchiveRecord> {
  assertResultHistoryArchive(identity);
  const rows = (await db.execute(sql`
    INSERT INTO result_history_archives (source_instance,source_kind,result_id,result_attempt_id,
      source_sha256,value_sha256,source_byte_size,inline_metadata,envelope_sha256,envelope_byte_size,
      stored_sha256,stored_byte_size,bucket,object_key,generation,crc32c,verified_at)
    SELECT ${identity.sourceInstance},${identity.sourceKind},r.id,${identity.resultAttemptId}::uuid,
      ${identity.sourceSha256},encode(sha256(convert_to(result_history_normalized(r.${column(identity.sourceKind)})::text,'UTF8')),'hex'),
      ${identity.sourceByteSize},result_history_compact(r.${column(identity.sourceKind)}),
      ${identity.envelopeSha256},${identity.envelopeByteSize},${identity.storedSha256},${identity.storedByteSize},
      ${identity.bucket},${identity.objectKey},${identity.generation},${identity.crc32c},${identity.verifiedAt.toISOString()}::timestamptz
    FROM results r WHERE r.id=${identity.resultId}::uuid AND r.${pointer(identity.sourceKind)} IS NULL
      AND r.current_result_attempt_id IS NOT DISTINCT FROM ${identity.resultAttemptId}::uuid
      AND octet_length(r.${column(identity.sourceKind)}::text)=${identity.sourceByteSize}
      AND encode(sha256(convert_to(r.${column(identity.sourceKind)}::text,'UTF8')),'hex')=${identity.sourceSha256}
    ON CONFLICT DO NOTHING RETURNING ${ARCHIVE_COLUMNS}
  `)) as unknown as ResultHistoryArchiveRecord[];
  const existing =
    rows[0] ??
    (
      (await db.execute(sql`
    SELECT ${ARCHIVE_COLUMNS} FROM result_history_archives WHERE source_instance=${identity.sourceInstance}
      AND source_kind=${identity.sourceKind} AND result_id=${identity.resultId}::uuid
      AND result_attempt_id IS NOT DISTINCT FROM ${identity.resultAttemptId}::uuid AND source_sha256=${identity.sourceSha256}
  `)) as unknown as ResultHistoryArchiveRecord[]
    )[0];
  if (!existing)
    throw new Error(
      "Result history changed during archive upload; original remains inline",
    );
  existing.verifiedAt = new Date(existing.verifiedAt);
  assertResultHistoryArchive(existing);
  return existing;
}

export async function offloadResultHistory(
  db: DB,
  archive: ResultHistoryArchiveRecord,
): Promise<boolean> {
  assertResultHistoryArchive(archive);
  const rows = await db.execute(sql`
    UPDATE results r SET ${column(archive.sourceKind)}=a.inline_metadata, ${pointer(archive.sourceKind)}=a.id
    FROM result_history_archives a WHERE a.id=${archive.id}::uuid AND a.result_id=r.id AND a.source_kind=${archive.sourceKind}
      AND r.id=${archive.resultId}::uuid AND r.${pointer(archive.sourceKind)} IS NULL
      AND r.current_result_attempt_id IS NOT DISTINCT FROM a.result_attempt_id
      AND octet_length(r.${column(archive.sourceKind)}::text)=a.source_byte_size
      AND encode(sha256(convert_to(r.${column(archive.sourceKind)}::text,'UTF8')),'hex')=a.source_sha256
      AND ${eligible(sql`r`)}
    RETURNING r.id
  `);
  return rows.length === 1;
}

/** One keyset page of result IDs is selected before measuring/detoasting the
 * histories. Small metadata, sentinels and sources with no material saving stay. */
export async function resultHistoryOffloadCandidates(
  db: DB,
  after: string | null = null,
  kind?: ResultHistoryKind,
) {
  if (after) assertId(after);
  const inline = kind
    ? sql`r.${column(kind)} IS NOT NULL AND r.${pointer(kind)} IS NULL`
    : sql`((r.steady_history IS NOT NULL AND r.steady_history_archive_id IS NULL)
          OR (r.frame_track IS NOT NULL AND r.frame_track_archive_id IS NULL))`;
  const rows = (await db.execute(sql`
    WITH page AS MATERIALIZED (
      SELECT r.id FROM results r WHERE ${after ? sql`r.id > ${after}::uuid AND` : sql``}
        ${inline}
      ORDER BY r.id LIMIT 32
    )
    SELECT r.id, history.kind, octet_length(history.value::text) AS byte_size,
      (octet_length(history.value::text) BETWEEN 4096 AND ${MAX_RESULT_HISTORY_BYTES}
        AND octet_length(history.value::text)-octet_length(result_history_compact(history.value)::text) >= 1024
        AND ${eligible(sql`r`)}) AS eligible
    FROM page JOIN results r ON r.id=page.id
    CROSS JOIN LATERAL (VALUES ('steady_history',r.steady_history,r.steady_history_archive_id),
      ('frame_track',r.frame_track,r.frame_track_archive_id)) history(kind,value,archive_id)
    WHERE history.archive_id IS NULL ${kind ? sql`AND history.kind = ${kind}` : sql``}
    ORDER BY r.id, history.kind
  `)) as unknown as Array<{
    id: string;
    kind: ResultHistoryKind;
    byte_size: number | null;
    eligible: boolean | null;
  }>;
  return rows;
}

export interface ResultHistoryRow {
  id: string;
  steadyHistory?: unknown;
  frameTrack?: unknown;
  steadyHistoryArchiveId?: string | null;
  frameTrackArchiveId?: string | null;
}
export function hasArchivedResultHistory(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (
    !Array.isArray(value) &&
    (value as Record<string, unknown>).archivedResultHistoryArray === true
  )
    return true;
  return Object.values(value).some(hasArchivedResultHistory);
}

/** Use only on the canonical row, before constructing an exact-attempt
 * projection. Inline values need no object read. Missing archives fail closed. */
export async function hydrateResultHistories<T extends ResultHistoryRow>(
  db: DB,
  reader: ResultHistoryReader,
  row: T,
): Promise<T> {
  const restoredRow = { ...row };
  for (const kind of ["steady_history", "frame_track"] as const) {
    const field = kind === "steady_history" ? "steadyHistory" : "frameTrack";
    const archiveField =
      kind === "steady_history"
        ? "steadyHistoryArchiveId"
        : "frameTrackArchiveId";
    if (!row[archiveField] && !hasArchivedResultHistory(row[field])) continue;
    const archive = row[archiveField]
      ? await getResultHistoryArchive(db, row[archiveField]!)
      : await resultHistoryArchiveForRow(db, row.id, kind);
    if (
      !archive ||
      archive.resultId !== row.id ||
      archive.sourceKind !== kind ||
      canonicalAnalysisJson(JSON.parse(archive.metadataText)) !==
        canonicalAnalysisJson(row[field])
    )
      throw new Error(
        "Result history pointer is missing, changed, or belongs to another source",
      );
    const restored = await reader.read(archive);
    if (
      restored.sourceInstance !== archive.sourceInstance ||
      restored.sourceKind !== kind ||
      restored.resultId !== row.id ||
      restored.resultAttemptId !== archive.resultAttemptId ||
      Buffer.byteLength(restored.payloadText) !== archive.sourceByteSize ||
      resultHistorySha256(Buffer.from(restored.payloadText)) !==
        archive.sourceSha256
    )
      throw new Error("Restored result history differs from its exact source");
    restoredRow[field] = JSON.parse(restored.payloadText);
  }
  return restoredRow;
}
