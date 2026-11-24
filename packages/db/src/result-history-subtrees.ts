import { sql, type SQL } from "drizzle-orm";
import type { DB } from "./client";
import {
  getAttemptEvidenceArchive,
  type AttemptEvidenceArchiveRecord,
} from "./attempt-evidence-catalog";
import type { AttemptEvidenceArchiveReader } from "./attempt-evidence-reader";
import type { AttemptEvidenceCopySource } from "./attempt-evidence-storage";
import {
  parseReportJson,
  reportTextIdentity,
} from "./progressive-report-archive";
import { canonicalAnalysisJson } from "./analysis-target";
import type { ResultHistoryKind } from "@aerodb/core/result-history-storage";

export interface CanonicalHistoryCandidate {
  result_id: string;
  kind: ResultHistoryKind;
  archive: string;
  generation: string;
  selected: string | null;
  field_sha: string;
  field_bytes: number;
  existing_ref: string | null;
}
export interface CanonicalFieldProof {
  resultId: string;
  kind: ResultHistoryKind;
  reference: string;
  archiveId: string;
  generation: string;
  fieldText: string;
}

/** Normal pages contain many already-settled attempts. Check their result PK
 * and native field shape before looking up any original or decoding a fact. */
export function canonicalSubtreeCandidateSql(attempt: SQL, enabled: boolean) {
  if (!enabled) return sql`false`;
  const steadyArrays = sql.join(
    ["iterations", "cl", "cd", "cm"].map(
      (key) =>
        sql`(jsonb_typeof(r.steady_history->${key}::text)='array' AND r.steady_history->${key}::text<>'[]'::jsonb)`,
    ),
    sql` OR `,
  );
  return sql`CASE WHEN EXISTS(SELECT FROM results r WHERE r.id=${attempt}.result_id AND (
    EXISTS(SELECT FROM result_history_subtree_refs b WHERE b.id IN(r.steady_history_subtree_id,r.frame_track_subtree_id)
       AND b.source_attempt_id=${attempt}.id AND b.app_readback_at IS NULL) OR
    ((r.current_result_attempt_id IS NULL OR r.current_result_attempt_id=${attempt}.id) AND (
       CASE WHEN r.steady_history_archive_id IS NULL AND r.steady_history_subtree_id IS NULL AND pg_column_size(r.steady_history)<=4096
         THEN ${steadyArrays} ELSE false END OR
       CASE WHEN r.frame_track_archive_id IS NULL AND r.frame_track_subtree_id IS NULL AND pg_column_size(r.frame_track)<=4096
         THEN jsonb_typeof(r.frame_track->'frames')='array' AND r.frame_track->'frames'<>'[]'::jsonb ELSE false END))))
    THEN EXISTS(SELECT FROM result_history_subtree_candidates(${attempt}.id)) ELSE false END`;
}

export async function canonicalSubtreeCandidates(
  db: DB,
  attempt: string,
  kind?: ResultHistoryKind,
) {
  return (await db.execute(
    sql`SELECT * FROM result_history_subtree_candidates(${attempt}::uuid,${kind ?? null})`,
  )) as unknown as CanonicalHistoryCandidate[];
}

export async function pendingCanonicalSubtrees(db: DB): Promise<boolean> {
  const [row] =
    await db.execute(sql`SELECT EXISTS(SELECT FROM result_history_subtree_refs b JOIN results r
    ON r.id=b.result_id AND b.id IN(r.steady_history_subtree_id,r.frame_track_subtree_id)
    WHERE b.app_readback_at IS NULL) pending`);
  return row?.pending === true;
}

/** The field must be extracted from the authenticated PG spelling of the whole
 * source. A JS parse/stringify round-trip would lose significant decimal scale. */
export function canonicalFieldText(
  source: AttemptEvidenceCopySource,
  archive: AttemptEvidenceArchiveRecord,
  kind: ResultHistoryKind,
  expectedSha: string,
  expectedBytes: number,
) {
  const identity = reportTextIdentity(source.payloadText);
  if (
    source.attemptId !== archive.attemptId ||
    source.resultId !== archive.resultId ||
    source.simJobId !== archive.simJobId ||
    identity.sha256 !== archive.sourceSha256 ||
    identity.byteSize !== archive.sourceByteSize
  )
    throw new Error("Canonical history source owner or original bytes changed");
  const roots = new Map<string, string>();
  parseReportJson(source.payloadText, roots);
  const field = roots.get(kind);
  if (field === undefined || expectedBytes <= 0 || expectedBytes >= 4096)
    throw new Error("Missing bounded canonical history field");
  const actual = reportTextIdentity(field);
  if (actual.sha256 !== expectedSha || actual.byteSize !== expectedBytes)
    throw new Error(
      "Archived attempt subtree differs from the canonical history",
    );
  return field;
}

function subtreeColumn(kind: ResultHistoryKind) {
  if (kind !== "steady_history" && kind !== "frame_track")
    throw new Error("Unknown canonical history field");
  return sql.identifier(kind + "_subtree_id");
}
export async function storedCanonicalSubtree(
  db: DB,
  resultId: string,
  kind: ResultHistoryKind,
  expectedRef?: string,
) {
  // Older schema-isolated fixtures and rolling upgrades can still hydrate 0206.
  const [schema] =
    await db.execute(sql`SELECT EXISTS(SELECT FROM pg_attribute WHERE attrelid=to_regclass('results')
    AND attname='steady_history_subtree_id' AND NOT attisdropped) ready`);
  if (schema?.ready !== true) return null;
  const col = subtreeColumn(kind);
  const [r] =
    await db.execute(sql`SELECT r.${col} ref,r.${sql.identifier(kind)}::text metadata,
    b.source_archive_id archive,b.source_attempt_id attempt,b.source_sha sha,b.source_bytes bytes,b.generation
    FROM results r CROSS JOIN LATERAL result_history_subtree_binding(r.id,${kind},r.${col}) b
    WHERE r.id=${resultId}::uuid AND (${expectedRef ?? null}::uuid IS NULL OR r.${col}=${expectedRef ?? null}::uuid)`);
  if (!r) return null;
  return {
    ref: String(r.ref),
    metadataText: String(r.metadata),
    archive: String(r.archive),
    attempt: String(r.attempt),
    sha: String(r.sha),
    bytes: Number(r.bytes),
    generation: String(r.generation),
  };
}

export async function readCanonicalSubtree(
  db: DB,
  reader: AttemptEvidenceArchiveReader,
  resultId: string,
  kind: ResultHistoryKind,
  expectedRef?: string,
  suppliedMetadata?: unknown,
): Promise<CanonicalFieldProof | null> {
  const bound = await storedCanonicalSubtree(db, resultId, kind, expectedRef);
  if (!bound) {
    if (expectedRef) {
      const [owner] = await db.execute(
        sql`SELECT ${subtreeColumn(kind)} AS ref FROM results WHERE id=${resultId}::uuid`,
      );
      if (owner?.ref === expectedRef)
        throw new Error("Pinned canonical history reference is incomplete");
    }
    return null;
  }
  if (
    suppliedMetadata !== undefined &&
    canonicalAnalysisJson(suppliedMetadata) !==
      canonicalAnalysisJson(JSON.parse(bound.metadataText))
  )
    throw new Error("Canonical history metadata changed before read-through");
  const ar = await getAttemptEvidenceArchive(db, bound.archive);
  if (
    ar.resultId !== resultId ||
    ar.attemptId !== bound.attempt ||
    ar.generation !== bound.generation
  )
    throw new Error(
      "Canonical history references a different immutable attempt",
    );
  const original = await reader.read(ar, AbortSignal.timeout(30000));
  const fieldText = canonicalFieldText(
    original,
    ar,
    kind,
    bound.sha,
    bound.bytes,
  );
  const [still] =
    await db.execute(sql`SELECT id FROM results WHERE id=${resultId}::uuid
    AND ${subtreeColumn(kind)}=${bound.ref}::uuid`);
  if (!still) throw new Error("Canonical history changed during read-through");
  return {
    resultId,
    kind,
    reference: bound.ref,
    archiveId: ar.id,
    generation: ar.generation,
    fieldText,
  };
}

export async function bindCanonicalSubtree(
  db: DB,
  candidate: CanonicalHistoryCandidate,
  archive: AttemptEvidenceArchiveRecord,
  source: AttemptEvidenceCopySource,
  verifiedAt: Date,
) {
  if (
    candidate.archive !== archive.id ||
    candidate.generation !== archive.generation ||
    candidate.result_id !== archive.resultId
  )
    throw new Error("Canonical history candidate belongs to another source");
  const fieldText = canonicalFieldText(
    source,
    archive,
    candidate.kind,
    candidate.field_sha,
    candidate.field_bytes,
  );
  if (candidate.existing_ref) {
    const bound = await storedCanonicalSubtree(
      db,
      candidate.result_id,
      candidate.kind,
      candidate.existing_ref,
    );
    if (!bound) return null;
    if (
      bound.archive !== archive.id ||
      bound.attempt !== archive.attemptId ||
      bound.generation !== archive.generation
    )
      throw new Error("Pending canonical history names another original");
    return {
      reference: bound.ref,
      fieldText,
      kind: candidate.kind,
      resultId: candidate.result_id,
      archiveId: archive.id,
      generation: archive.generation,
    };
  }
  const [r] =
    await db.execute(sql`SELECT bind_canonical_history_subtree(${candidate.result_id}::uuid,${candidate.kind},
    ${archive.attemptId}::uuid,${archive.id}::uuid,${archive.generation},${candidate.selected}::uuid,${source.payloadText},
    ${verifiedAt.toISOString()}::timestamptz) ref`);
  if (r?.ref === null) return null;
  if (typeof r?.ref !== "string")
    throw new Error("Canonical history reference was not installed");
  return {
    reference: r.ref,
    fieldText,
    kind: candidate.kind,
    resultId: candidate.result_id,
    archiveId: archive.id,
    generation: archive.generation,
  };
}
export async function confirmCanonicalSubtree(
  db: DB,
  proof: CanonicalFieldProof,
) {
  const [r] =
    await db.execute(sql`SELECT confirm_canonical_history_subtree(${proof.resultId}::uuid,${proof.kind},
    ${proof.reference}::uuid,${proof.fieldText}) AS current`);
  return r?.current === true;
}
export async function restoreCanonicalSubtree(
  db: DB,
  proof: CanonicalFieldProof,
) {
  const [r] =
    await db.execute(sql`SELECT restore_canonical_history_subtree(${proof.resultId}::uuid,${proof.kind},
    ${proof.reference}::uuid,${proof.fieldText}) AS restored`);
  return r?.restored === true;
}
