import { sql, type SQLWrapper } from "drizzle-orm";
import {
  MAX_RESULT_HISTORY_BYTES,
  resultHistorySha256,
  type ResultHistoryKind,
  type ResultHistoryReader,
} from "@aerodb/core/result-history-storage";
import type { DB } from "./client";
import type { AttemptEvidenceReadRow } from "./attempt-evidence-reader";
import type { AttemptEvidenceValueFacts } from "./attempt-evidence-projection";
import { getResultHistoryArchive } from "./result-history-storage";

const detailFields = [
  "frame_track",
  "frameTrack",
  "steady_history",
  "steadyHistory",
  "fidelity",
] as const;
export type PublicAttemptField = (typeof detailFields)[number];
export type PublicAttemptFieldOwner = Pick<
  AttemptEvidenceReadRow,
  | "id"
  | "resultId"
  | "simJobId"
  | "evidenceArchiveId"
  | "evidenceStorageEventId"
>;
type Payload = Partial<Record<PublicAttemptField, unknown>>;
/** Public SQL projection for inline rows. The cold branch supplies only its owner/pointer columns. */
export function inlinePublicAttemptFieldsSql(
  payload: SQLWrapper,
  archiveId: SQLWrapper,
) {
  const keys = sql.join(
    detailFields.map((key) => sql`(${key}::text)`),
    sql`, `,
  );
  return sql<Payload | null>`CASE WHEN ${archiveId} IS NULL THEN (
    WITH doc AS MATERIALIZED (SELECT ${payload} || '{}'::jsonb AS value)
    SELECT coalesce(jsonb_object_agg(key,value->key) FILTER (WHERE value ? key),'{}'::jsonb)
    FROM doc CROSS JOIN (VALUES ${keys}) AS wanted(key) WHERE jsonb_typeof(value)='object'
  ) END`;
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const sha = /^[a-f0-9]{64}$/;

type FieldRow = {
  id: string;
  result_id: string;
  source_instance: string;
  field: PublicAttemptField;
  removed: boolean;
  original: AttemptEvidenceValueFacts | null;
  field_text: string | null;
  pin: string;
};

function kindFor(field: PublicAttemptField): ResultHistoryKind | null {
  if (field === "frame_track" || field === "frameTrack") return "frame_track";
  if (field === "steady_history" || field === "steadyHistory")
    return "steady_history";
  return null;
}

// Check the complete PG compact fingerprint once per stable attempt. Only the
// requested public subtrees and their sealed original facts leave PostgreSQL.
async function readFields(
  db: DB,
  owners: PublicAttemptFieldOwner[],
  fields: readonly PublicAttemptField[],
) {
  const values = sql.join(
    owners.map(
      (r) => sql`(${r.id}::uuid,${r.resultId}::uuid,${r.simJobId}::uuid,
    ${r.evidenceArchiveId}::uuid,${r.evidenceStorageEventId}::uuid)`,
    ),
    sql`, `,
  );
  const keys = sql.join(
    fields.map((f) => sql`(${f}::text)`),
    sql`, `,
  );
  return db.execute<FieldRow>(sql`WITH requested(id,result_id,job_id,archive_id,event_id) AS (VALUES ${values}),
    owned AS MATERIALIZED (
      SELECT a.id,a.result_id,ar.source_instance,proj.projection,a.evidence_payload || '{}'::jsonb AS compact,
        jsonb_build_array(ar.id,e.id,ar.sim_job_id,ar.source_instance,ar.generation,ar.source_sha256,ar.source_byte_size,
          proj.projection->>'compactSha256',cf.attempt_token,cf.evidence_signature,e.verification#>>'{dependencies,applicationSha256}')::text AS pin
      FROM requested q JOIN result_attempts a ON a.id=q.id AND a.result_id=q.result_id
        AND a.sim_job_id IS NOT DISTINCT FROM q.job_id AND a.evidence_archive_id=q.archive_id AND a.evidence_storage_event_id=q.event_id
      JOIN attempt_evidence_archives ar ON ar.id=q.archive_id AND ar.result_attempt_id=a.id AND ar.result_id=a.result_id
        AND (a.sim_job_id IS NULL OR ar.sim_job_id=a.sim_job_id)
      JOIN attempt_evidence_storage_events e ON e.id=q.event_id AND e.result_attempt_id=a.id AND e.archive_id=ar.id
        AND e.action='shorten' AND e.completed
      JOIN attempt_evidence_history_projections proj ON proj.result_attempt_id=a.id AND proj.archive_id=ar.id
      LEFT JOIN progressive_cfd_evidence cf ON cf.result_attempt_id=a.id
      WHERE proj.projection @> jsonb_build_object('version',1,'attemptId',a.id,'archiveId',ar.id,
              'sourceSha256',ar.source_sha256,'sourceByteSize',ar.source_byte_size)
        AND jsonb_typeof(proj.projection->'removedPaths')='array' AND jsonb_typeof(proj.projection->'values')='object'
        AND jsonb_typeof(a.evidence_payload)='object'
        AND e.verification->'direct' @> jsonb_build_object('attemptId',a.id,'archiveId',ar.id,'bucket',ar.bucket,
              'objectKey',ar.object_key,'generation',ar.generation,'storedSha256',ar.stored_sha256,'storedByteSize',ar.stored_byte_size,
              'crc32c',ar.crc32c,'sourceSha256',ar.source_sha256,'sourceByteSize',ar.source_byte_size)
        AND e.verification->'app' @> jsonb_build_object('attemptId',a.id,'archiveId',ar.id,'forceArchive',true,
              'sourceSha256',ar.source_sha256,'sourceByteSize',ar.source_byte_size)
        AND (CASE e.verification#>>'{dependencies,verifier}'
          WHEN 'server-consumers/hz-worker-steady-rans-v1' THEN
            e.verification#>>'{app,source}'='worker-volume' AND e.verification#>'{dependencies,workerScope}' @>
              jsonb_build_object('job',ar.sim_job_id,'attempt',a.id,'result',a.result_id,'instance',ar.source_instance)
          ELSE e.verification#>>'{app,source}'='gcs' END)
        AND e.verification->'dependencies' @> jsonb_build_object('contractVersion',1,'attemptId',a.id,'archiveId',ar.id,
              'sourceSha256',ar.source_sha256, 'readDependenciesSatisfied',true, 'scientificEquivalent',true)
        AND cf.attempt_token::text IS NOT DISTINCT FROM e.verification#>>'{dependencies,progressiveScope,scientific,attemptToken}'
        AND cf.evidence_signature IS NOT DISTINCT FROM e.verification#>>'{dependencies,progressiveScope,scientific,applicationSha256}'
        AND (cf.attempt_token IS NULL OR cf.evidence_signature=e.verification#>>'{dependencies,applicationSha256}')
        AND (e.verification#>>'{dependencies,verifier}' NOT IN
              ('server-consumers/receipt-bearing-rans-v1','server-consumers/receipt-bearing-urans-v1')
          OR (e.verification#>'{dependencies,progressiveScope}' @> jsonb_build_object(
              'attemptId',a.id,'resultId',a.result_id,'simJobId',ar.sim_job_id)
            AND e.verification#>>'{dependencies,applicationSha256}' ~ '^[0-9a-f]{64}$'))
    ), pinned AS MATERIALIZED (
      SELECT * FROM owned WHERE encode(sha256(convert_to(compact::text,'UTF8')),'hex')=projection->>'compactSha256'
    )
    SELECT id,result_id,source_instance,pin,field,
      projection->'values'->(array_to_json(ARRAY[field])::text) AS original,
      EXISTS(SELECT FROM jsonb_array_elements(projection->'removedPaths') p(path) WHERE path->>0=field) AS removed,
      (compact->field)::text AS field_text
    FROM pinned CROSS JOIN (VALUES ${keys}) AS wanted(field)`);
}

type MissingField = FieldRow & {
  kind: ResultHistoryKind;
  original: AttemptEvidenceValueFacts & {
    sourceSha256: string;
    byteSize: number;
  };
};
type Source = {
  id: string;
  field: PublicAttemptField;
  archive_id: string | null;
  inline_text: string | null;
};

// The current result owns an inline field only while it points at this attempt.
// An immutable 0206 catalog row remains available by its original owner even
// after a newer attempt becomes current at the same result.
async function historySources(db: DB, fields: MissingField[]) {
  const values = sql.join(
    fields.map(
      (f) => sql`(${f.id}::uuid,${f.result_id}::uuid,${f.source_instance}::text,
      ${f.field}::text,${f.kind}::text,${f.original.sourceSha256}::text,${f.original.byteSize}::bigint)`,
    ),
    sql`, `,
  );
  return db.execute<Source>(sql`WITH wanted(id,result_id,instance,field,kind,sha,bytes) AS (VALUES ${values}),
    owned AS MATERIALIZED (
      SELECT w.*,r.current_result_attempt_id AS selected,
        CASE w.kind WHEN 'frame_track' THEN r.frame_track_archive_id ELSE r.steady_history_archive_id END AS pointer,
        CASE WHEN r.current_result_attempt_id=w.id THEN
          CASE w.kind WHEN 'frame_track' THEN r.frame_track ELSE r.steady_history END END AS result_value
      FROM wanted w JOIN results r ON r.id=w.result_id
    ), candidates AS MATERIALIZED (
      SELECT o.*,CASE WHEN selected=id AND pointer IS NULL AND octet_length(result_value::text)=bytes
        THEN result_value::text END AS possible_inline FROM owned o
    )
    SELECT c.id,c.field,archive.id AS archive_id,
      CASE WHEN encode(sha256(convert_to(possible_inline,'UTF8')),'hex')=c.sha THEN possible_inline END AS inline_text
    FROM candidates c LEFT JOIN LATERAL (
      SELECT h.id FROM result_history_archives h WHERE h.source_instance=c.instance AND h.source_kind=c.kind
        AND h.result_id=c.result_id AND h.result_attempt_id=c.id AND h.source_sha256=c.sha AND h.source_byte_size=c.bytes
        AND (c.selected IS DISTINCT FROM c.id OR c.pointer IS NULL OR
          (h.id=c.pointer AND h.inline_metadata=c.result_value))
      ORDER BY h.id LIMIT 1
    ) archive ON true`);
}

function exactText(text: string, fact: AttemptEvidenceValueFacts) {
  const bytes = Buffer.from(text, "utf8");
  return (
    bytes.length === fact.byteSize &&
    resultHistorySha256(bytes) === fact.sourceSha256
  );
}

function presentField(
  f: FieldRow,
): f is FieldRow & { original: MissingField["original"] } {
  const fact = f.original;
  return (
    !!fact &&
    fact.present === true &&
    fact.path?.length === 1 &&
    fact.path[0] === f.field &&
    typeof fact.sourceSha256 === "string" &&
    sha.test(fact.sourceSha256) &&
    Number.isSafeInteger(fact.byteSize) &&
    fact.byteSize! > 0 &&
    fact.byteSize! <= MAX_RESULT_HISTORY_BYTES
  );
}

async function archiveText(
  db: DB,
  reader: ResultHistoryReader,
  ref: string,
  f: MissingField,
): Promise<string | null> {
  try {
    const archive = await getResultHistoryArchive(db, ref);
    if (
      archive.sourceInstance !== f.source_instance ||
      archive.sourceKind !== f.kind ||
      archive.resultId !== f.result_id ||
      archive.resultAttemptId !== f.id ||
      archive.sourceSha256 !== f.original.sourceSha256 ||
      archive.sourceByteSize !== f.original.byteSize
    )
      return null;
    const body = await reader.read(archive);
    if (
      body.version !== 1 ||
      body.sourceInstance !== archive.sourceInstance ||
      body.sourceKind !== archive.sourceKind ||
      body.resultId !== archive.resultId ||
      body.resultAttemptId !== archive.resultAttemptId ||
      typeof body.payloadText !== "string"
    )
      return null;
    return body.payloadText;
  } catch {
    // The caller can still authenticate the complete 0207 original.
    return null;
  }
}

async function readPage(
  db: DB,
  owners: PublicAttemptFieldOwner[],
  reader: ResultHistoryReader,
  keys: readonly PublicAttemptField[],
  hits: Map<string, Payload>,
) {
  const rows = await readFields(db, owners, keys);
  const missing: MissingField[] = [];
  const invalid = new Set<string>();
  const payloads = new Map<string, Payload>();
  for (const f of rows) {
    let payload = payloads.get(f.id);
    if (!payload) {
      payload = {};
      payloads.set(f.id, payload);
    }
    const kind = kindFor(f.field);
    if (f.removed) {
      if (!kind || !presentField(f)) invalid.add(f.id);
      else missing.push({ ...f, kind });
    } else if (
      kind &&
      (f.field_text === null
        ? f.original?.present !== false ||
          f.original.path?.length !== 1 ||
          f.original.path[0] !== f.field ||
          f.original.byteSize !== null ||
          f.original.sourceSha256 !== null ||
          f.original.jsonType !== null
        : !presentField(f) || !exactText(f.field_text, f.original))
    ) {
      invalid.add(f.id);
    } else if (f.field_text !== null) {
      payload[f.field] = JSON.parse(f.field_text);
    }
  }
  const needed = missing.filter((f) => !invalid.has(f.id));
  if (needed.length) {
    const sources = new Map(
      (await historySources(db, needed)).map((s) => [s.id + s.field, s]),
    );
    const cache = new Map<string, Promise<string | null>>();
    for (let at = 0; at < needed.length; at += 2) {
      await Promise.all(
        needed.slice(at, at + 2).map(async (f) => {
          const source = sources.get(f.id + f.field);
          let text = source?.inline_text ?? null;
          if (text === null && source?.archive_id && !("rollback" in db)) {
            let read = cache.get(source.archive_id);
            if (!read) {
              read = archiveText(db, reader, source.archive_id, f);
              cache.set(source.archive_id, read);
            }
            text = await read;
          }
          if (text === null || !exactText(text, f.original)) {
            invalid.add(f.id);
            return;
          }
          payloads.get(f.id)![f.field] = JSON.parse(text);
        }),
      );
    }
    const checked = needed.filter((f) => !invalid.has(f.id));
    if (checked.length) {
      const ids = new Set(checked.map((f) => f.id));
      const again = await readFields(
        db,
        owners.filter((r) => ids.has(r.id)),
        [...new Set(checked.map((f) => f.field))],
      );
      const current = new Map(again.map((f) => [f.id + f.field, f]));
      for (const f of checked) {
        const now = current.get(f.id + f.field);
        if (
          !now?.removed ||
          now.pin !== f.pin ||
          now.original?.sourceSha256 !== f.original.sourceSha256 ||
          now.original?.byteSize !== f.original.byteSize
        )
          invalid.add(f.id);
      }
    }
  }
  for (const [id, payload] of payloads)
    if (!invalid.has(id)) hits.set(id, payload);
}

/** Missing map entries require the caller's existing full attempt reader.
 * Keys are literal original JSON keys. SQL NULL (absence) and JSON null stay distinct.
 * Use a pool-backed DB for 0206 reads. The compact-only path performs no object I/O. */
export async function readPublicAttemptFields(
  db: DB,
  owners: readonly PublicAttemptFieldOwner[],
  historyReader: ResultHistoryReader,
  fields: readonly PublicAttemptField[] = detailFields,
): Promise<ReadonlyMap<string, Payload>> {
  const keys = [...new Set(fields)];
  if (keys.some((f) => !detailFields.includes(f)))
    throw new Error("Unsupported public attempt field");
  const hits = new Map<string, Payload>();
  if (!keys.length) return hits;
  const unique = new Map<string, PublicAttemptFieldOwner | null>();
  for (const r of owners) {
    const prior = unique.get(r.id);
    if (
      prior === null ||
      (prior &&
        (prior.resultId !== r.resultId ||
          prior.simJobId !== r.simJobId ||
          prior.evidenceArchiveId !== r.evidenceArchiveId ||
          prior.evidenceStorageEventId !== r.evidenceStorageEventId))
    ) {
      unique.set(r.id, null);
    } else if (
      !uuid.test(r.id) ||
      !r.resultId ||
      !uuid.test(r.resultId) ||
      (r.simJobId !== null && !uuid.test(r.simJobId)) ||
      !r.evidenceArchiveId ||
      !uuid.test(r.evidenceArchiveId) ||
      !r.evidenceStorageEventId ||
      !uuid.test(r.evidenceStorageEventId)
    ) {
      unique.set(r.id, null);
    } else unique.set(r.id, r);
  }
  const cold = [...unique.values()].filter(
    (r): r is PublicAttemptFieldOwner => r !== null,
  );
  for (let offset = 0; offset < cold.length; offset += 32)
    await readPage(
      db,
      cold.slice(offset, offset + 32),
      historyReader,
      keys,
      hits,
    );
  return hits;
}
