import { eq, sql, type SQL } from "drizzle-orm";
import type { DB } from "./client";
import {
  MAX_SOLVER_HISTORY_BYTES,
  assertSolverHistoryArchive,
  assertSolverHistorySource,
  solverHistorySha256,
  type SolverHistoryArchiveIdentity,
  type SolverHistoryKind,
  type SolverHistorySource,
  type SolverHistoryEnvelope,
} from "@aerodb/core/solver-history-storage";
import { forceHistory, type ForceHistoryRow } from "./schema";

type InventoryKind = SolverHistoryKind | "result_steady_history" | "result_frame_track" | "attempt_payload";
const INVENTORY_KINDS: InventoryKind[] = ["force_history", "result_steady_history", "result_frame_track", "attempt_payload"];

export function forceHistoryArraysSql(alias: SQL): SQL {
  return sql`jsonb_build_object('t', ${alias}.t, 'cl', ${alias}.cl, 'cd', ${alias}.cd, 'cm', ${alias}.cm)`;
}

// Deliberately separate from progressive transport report archives. These are
// immutable copies of physical solver evidence, not scheduling/report state.
function sourceQuery(kind: InventoryKind): SQL {
  switch (kind) {
    case "force_history": return sql`
      SELECT h.id, h.result_id, h.result_attempt_id, ${forceHistoryArraysSql(sql`h`)} AS payload
      FROM force_history h WHERE h.t IS NOT NULL`;
    case "result_steady_history": return sql`
      SELECT r.id, r.id AS result_id, NULL::uuid AS result_attempt_id, r.steady_history AS payload
      FROM results r WHERE r.steady_history IS NOT NULL AND r.steady_history <> 'null'::jsonb`;
    case "result_frame_track": return sql`
      SELECT r.id, r.id AS result_id, NULL::uuid AS result_attempt_id, r.frame_track AS payload
      FROM results r WHERE r.frame_track IS NOT NULL AND r.frame_track <> 'null'::jsonb`;
    case "attempt_payload": return sql`
      SELECT a.id, a.result_id, a.id AS result_attempt_id, a.evidence_payload AS payload
      FROM result_attempts a WHERE a.evidence_payload IS NOT NULL AND a.evidence_payload <> 'null'::jsonb`;
    default: throw new Error("Unknown physical solver history kind");
  }
}

function assertId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new Error("Solver history requires a stable source UUID");
}

export interface SolverHistoryInventoryRow {
  source_id: string;
  result_id: string | null;
  result_attempt_id: string | null;
  source_byte_size: string;
  has_force_history: boolean;
  has_steady_history: boolean;
  has_frame_track: boolean;
}

/** Keyset inventory of actual JSON sizes, without transferring sample arrays.
 * No report archive table or network observability query is involved. */
export async function solverHistoryInventoryPage(
  db: DB,
  kind: InventoryKind,
  options: { after?: string; limit?: number } = {},
) {
  if (options.after) assertId(options.after);
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Solver history inventory limit must be 1..1000");
  const rows = await db.execute(sql`
    SELECT s.id AS source_id, s.result_id, s.result_attempt_id,
      octet_length(s.payload::text)::bigint::text AS source_byte_size,
      (s.payload ? 'force_history' OR s.payload ? 'forceHistory') AS has_force_history,
      (s.payload ? 'steady_history' OR s.payload ? 'steadyHistory') AS has_steady_history,
      (s.payload ? 'frame_track' OR s.payload ? 'frameTrack') AS has_frame_track
    FROM (${sourceQuery(kind)}) s
    ${options.after ? sql`WHERE s.id > ${options.after}::uuid` : sql``}
    ORDER BY s.id LIMIT ${limit + 1}
  `) as unknown as SolverHistoryInventoryRow[];
  const page = rows.slice(0, limit);
  return { sourceKind: kind, rows: page, next: rows.length > limit ? page.at(-1)!.source_id : null };
}

/** Explicit full census: may read TOAST for all physical histories. It is an
 * operator action, never a polled endpoint or automatic sweeper query. */
export async function solverHistoryInventory(db: DB) {
  const inventory: Array<{
    sourceKind: InventoryKind; source_count: string; source_byte_size: string;
    largest_source_byte_size: string; oversized_source_count: string;
  }> = [];
  for (const kind of INVENTORY_KINDS) {
    const [row] = await db.execute(sql`
      SELECT count(*)::text AS source_count,
        COALESCE(sum(octet_length(s.payload::text)::bigint), 0)::text AS source_byte_size,
        COALESCE(max(octet_length(s.payload::text)), 0)::text AS largest_source_byte_size,
        count(*) FILTER (WHERE octet_length(s.payload::text) > ${MAX_SOLVER_HISTORY_BYTES})::text AS oversized_source_count
      FROM (${sourceQuery(kind)}) s
    `) as unknown as Array<{
      source_count: string; source_byte_size: string; largest_source_byte_size: string; oversized_source_count: string;
    }>;
    inventory.push({ sourceKind: kind, ...row });
  }
  const relations = await db.execute(sql`
    SELECT relname AS relation, pg_total_relation_size(oid)::text AS total_byte_size
    FROM pg_class WHERE oid IN ('force_history'::regclass, 'results'::regclass, 'result_attempts'::regclass)
    ORDER BY relname
  `);
  return { inventory, relations };
}

export async function loadSolverHistorySource(db: DB, kind: SolverHistoryKind, sourceId: string): Promise<SolverHistorySource> {
  assertId(sourceId);
  const [row] = await db.execute(sql`
    SELECT s.id, s.result_id, s.result_attempt_id,
      octet_length(s.payload::text) AS byte_size,
      CASE WHEN octet_length(s.payload::text) <= ${MAX_SOLVER_HISTORY_BYTES}
        THEN s.payload::text ELSE NULL END AS payload_text
    FROM (${sourceQuery(kind)}) s WHERE s.id = ${sourceId}::uuid
  `) as unknown as Array<{
    id: string; result_id: string | null; result_attempt_id: string | null;
    byte_size: number; payload_text: string | null;
  }>;
  if (!row) throw new Error("Physical solver history source is missing");
  if (row.payload_text === null) throw new Error(`Solver history source exceeds ${MAX_SOLVER_HISTORY_BYTES} bytes`);
  const source: SolverHistorySource = {
    sourceKind: kind, sourceId: row.id, resultId: row.result_id,
    resultAttemptId: row.result_attempt_id, payloadText: row.payload_text,
  };
  assertSolverHistorySource(source);
  return source;
}

export interface SolverHistoryArchiveRecord extends SolverHistoryArchiveIdentity { id: string }

const ARCHIVE_COLUMNS = sql`
  id, source_instance AS "sourceInstance", source_kind AS "sourceKind", source_id AS "sourceId",
  result_id AS "resultId", result_attempt_id AS "resultAttemptId",
  source_sha256 AS "sourceSha256", source_byte_size::float8 AS "sourceByteSize",
  envelope_sha256 AS "envelopeSha256", envelope_byte_size::float8 AS "envelopeByteSize",
  stored_sha256 AS "storedSha256", stored_byte_size::float8 AS "storedByteSize",
  bucket, object_key AS "objectKey", generation, crc32c`;

export async function getSolverHistoryArchive(db: DB, id: string): Promise<SolverHistoryArchiveRecord> {
  assertId(id);
  const [row] = await db.execute(sql`SELECT ${ARCHIVE_COLUMNS} FROM solver_history_archives WHERE id = ${id}::uuid`) as unknown as SolverHistoryArchiveRecord[];
  if (!row) throw new Error("Solver history archive record is missing");
  assertSolverHistoryArchive(row);
  return row;
}

/** Called only after a fresh generation-pinned complete readback. The source
 * is compared again; the separate final CAS is the only array removal path. */
export async function registerSolverHistoryArchive(db: DB, identity: SolverHistoryArchiveIdentity): Promise<SolverHistoryArchiveRecord> {
  assertSolverHistoryArchive(identity);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const source = await loadSolverHistorySource(tx as unknown as DB, identity.sourceKind, identity.sourceId);
    if (source.resultId !== identity.resultId || source.resultAttemptId !== identity.resultAttemptId ||
        Buffer.byteLength(source.payloadText, "utf8") !== identity.sourceByteSize ||
        solverHistorySha256(Buffer.from(source.payloadText, "utf8")) !== identity.sourceSha256)
      throw new Error("Solver history source changed during archive upload; keep the original inline");
    const rows = await tx.execute(sql`
      INSERT INTO solver_history_archives (
        source_instance, source_kind, source_id, result_id, result_attempt_id,
        source_sha256, source_byte_size, envelope_sha256, envelope_byte_size,
        stored_sha256, stored_byte_size, bucket, object_key, generation, crc32c
      ) VALUES (
        ${identity.sourceInstance}, ${identity.sourceKind}, ${identity.sourceId}::uuid,
        ${identity.resultId}::uuid, ${identity.resultAttemptId}::uuid,
        ${identity.sourceSha256}, ${identity.sourceByteSize}, ${identity.envelopeSha256}, ${identity.envelopeByteSize},
        ${identity.storedSha256}, ${identity.storedByteSize}, ${identity.bucket}, ${identity.objectKey}, ${identity.generation}, ${identity.crc32c}
      ) ON CONFLICT (source_instance, source_kind, source_id, source_sha256) DO NOTHING
      RETURNING ${ARCHIVE_COLUMNS}
    `) as unknown as SolverHistoryArchiveRecord[];
    if (rows[0]) return rows[0];
    const [existing] = await tx.execute(sql`
      SELECT ${ARCHIVE_COLUMNS} FROM solver_history_archives
      WHERE source_instance = ${identity.sourceInstance} AND source_kind = ${identity.sourceKind}
        AND source_id = ${identity.sourceId}::uuid AND source_sha256 = ${identity.sourceSha256}
    `) as unknown as SolverHistoryArchiveRecord[];
    if (!existing || existing.resultId !== identity.resultId || existing.resultAttemptId !== identity.resultAttemptId)
      throw new Error("Conflicting solver history archive owner");
    assertSolverHistoryArchive(existing);
    return existing;
  });
}

export type StoredForceHistory = ForceHistoryRow;
export type HydratedForceHistory = Omit<ForceHistoryRow, "t" | "cl" | "cd"> & { t: number[]; cl: number[]; cd: number[] };
export interface SolverHistoryReader { read(identity: SolverHistoryArchiveIdentity): Promise<SolverHistoryEnvelope> }

export async function forceHistoryArchiveForRow(db: DB, historyId: string): Promise<SolverHistoryArchiveRecord | null> {
  assertId(historyId);
  const [pointer] = await db.execute(sql`
    SELECT history_archive_id AS id FROM force_history WHERE id = ${historyId}::uuid
  `) as unknown as Array<{ id: string | null }>;
  return pointer?.id ? getSolverHistoryArchive(db, pointer.id) : null;
}

/** All normal readers must pass their stored row through here before using
 * t/cl/cd/cm. Inline reads never touch GCS. Missing/corrupt remote evidence is
 * an error, never an empty or invented history. The scalar row is preserved. */
export async function hydrateForceHistory(
  db: DB, reader: SolverHistoryReader, row: StoredForceHistory,
): Promise<HydratedForceHistory> {
  if (row.t !== null && row.cl !== null && row.cd !== null) return row as HydratedForceHistory;
  if (row.t !== null || row.cl !== null || row.cd !== null || row.cm !== null)
    throw new Error("Force history has partially missing inline arrays");
  const archive = await forceHistoryArchiveForRow(db, row.id);
  if (!archive) {
    // An ingest replay can restore arrays between the original SELECT and
    // pointer read. Re-read once instead of reporting a false missing object.
    const [current] = await db.select().from(forceHistory).where(eq(forceHistory.id, row.id)).limit(1);
    if (current && current.resultId === row.resultId && current.resultAttemptId === row.resultAttemptId &&
        current.t !== null && current.cl !== null && current.cd !== null) return current as HydratedForceHistory;
  }
  if (!archive || archive.sourceId !== row.id || archive.resultId !== row.resultId ||
      archive.resultAttemptId !== row.resultAttemptId)
    throw new Error("Force history archive pointer is missing or belongs to another result");
  const restored = await reader.read(archive);
  if (restored.sourceId !== row.id || restored.resultId !== row.resultId || restored.resultAttemptId !== row.resultAttemptId)
    throw new Error("Restored force history belongs to another result");
  const arrays = JSON.parse(restored.payloadText) as { t: unknown; cl: unknown; cd: unknown; cm: unknown };
  if (!Array.isArray(arrays.t) || !Array.isArray(arrays.cl) || !Array.isArray(arrays.cd) ||
      (arrays.cm !== null && !Array.isArray(arrays.cm)))
    throw new Error("Restored force history arrays are malformed");
  return { ...row, t: arrays.t, cl: arrays.cl, cd: arrays.cd, cm: arrays.cm } as HydratedForceHistory;
}

/** The caller has just restored the recorded generation. One atomic UPDATE
 * installs the pointer and removes only byte-identical arrays. A concurrent
 * ingestion wins safely: this CAS changes zero rows and keeps its new arrays.
 * Neither coefficients nor classification/polar metadata are touched. */
export async function offloadForceHistoryArrays(db: DB, archive: SolverHistoryArchiveRecord) {
  assertSolverHistoryArchive(archive);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const [row] = await tx.execute(sql`
    UPDATE force_history h SET history_archive_id = ${archive.id}::uuid, t = NULL, cl = NULL, cd = NULL, cm = NULL
    WHERE h.id = ${archive.sourceId}::uuid AND h.result_id = ${archive.resultId}::uuid
      AND h.result_attempt_id IS NOT DISTINCT FROM ${archive.resultAttemptId}::uuid
      AND h.t IS NOT NULL AND h.history_archive_id IS NULL
      AND octet_length(${forceHistoryArraysSql(sql`h`)}::text) = ${archive.sourceByteSize}
      AND encode(sha256(convert_to(${forceHistoryArraysSql(sql`h`)}::text, 'UTF8')), 'hex') = ${archive.sourceSha256}
    RETURNING h.id
    `) as unknown as Array<{ id: string }>;
    return { offloaded: Boolean(row), sourceId: archive.sourceId, sourceBytes: row ? archive.sourceByteSize : 0 };
  });
}

/** Bounded fair scan. Failed/oversize sources advance the cursor so one bad
 * row cannot starve its siblings; wrap only after an empty tail query. */
export async function forceHistoryOffloadCandidates(db: DB, after: string | null = null, limit = 32) {
  if (after) assertId(after);
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error("Force history scan limit must be 1..128");
  return await db.execute(sql`
    SELECT h.id, octet_length(${forceHistoryArraysSql(sql`h`)}::text)::int AS byte_size
    FROM force_history h
    LEFT JOIN result_attempts a ON a.id = h.result_attempt_id
    LEFT JOIN sim_jobs j ON j.id = a.sim_job_id
    WHERE h.history_archive_id IS NULL AND h.t IS NOT NULL
      AND jsonb_typeof(h.t) = 'array' AND jsonb_typeof(h.cl) = 'array' AND jsonb_typeof(h.cd) = 'array'
      AND (h.cm IS NULL OR jsonb_typeof(h.cm) = 'array')
      AND (h.result_attempt_id IS NULL OR (a.status IN ('done', 'failed') AND (a.sim_job_id IS NULL OR j.status IN ('done', 'failed', 'cancelled'))))
      ${after ? sql`AND h.id > ${after}::uuid` : sql``}
    ORDER BY h.id LIMIT ${limit}
  `) as unknown as Array<{ id: string; byte_size: number }>;
}
