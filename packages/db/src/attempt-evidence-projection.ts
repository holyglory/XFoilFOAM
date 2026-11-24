import { readAttemptProjections } from "./attempt-evidence-proof-reader";
import { hasConfiguredAttemptHubRole, requireConfiguredAttemptHubRole, verifiedAttemptCandidatesSql } from "./attempt-evidence-verified-policy";
import { sql, type SQL } from "drizzle-orm";
import type { DB } from "./client";
import {
  hasAttemptEvidenceStoragePointer,
  MAX_ATTEMPT_EVIDENCE_BYTES,
} from "./attempt-evidence-storage";
import {
  getAttemptEvidenceArchive,
  type AttemptEvidenceArchiveRecord,
} from "./attempt-evidence-catalog";
import { reportTextIdentity } from "./progressive-report-archive";

export const ATTEMPT_EVIDENCE_CONTRACT_VERSION = 1 as const;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export interface AttemptEvidenceValueFacts {
  path: string[];
  present: boolean;
  jsonType:
    | "object"
    | "array"
    | "string"
    | "number"
    | "boolean"
    | "null"
    | null;
  length: number | null;
  byteSize: number | null;
  sourceSha256: string | null;
  semanticSha256: string | null;
}

export interface AttemptEvidenceProjection {
  version: 1;
  attemptId: string;
  archiveId: string;
  sourceSha256: string;
  sourceByteSize: number;
  sourceSemanticSha256: string;
  compactSha256: string;
  compactSemanticSha256: string;
  removedPaths: string[][];
  removedLogicalBytes: number;
  /** Compact JSON path keys, e.g. '["steady_history","cl"]'. */
  values: Record<string, AttemptEvidenceValueFacts>;
}

export type AttemptEvidenceStorage =
  | {
      state: "inline";
      attemptId: string;
      resultId: string | null;
      simJobId: string | null;
      inlinePayloadText: string;
      compactPayloadText: null;
      archive: null;
      projection: null;
    }
  | {
      state: "archived";
      attemptId: string;
      storageEventId: string;
      resultId: string | null;
      simJobId: string | null;
      inlinePayloadText: null;
      compactPayloadText: string;
      archive: AttemptEvidenceArchiveRecord;
      projection: AttemptEvidenceProjection;
    };

export interface AttemptEvidenceAppReadRequest {
  attemptId: string;
  archiveId: string;
  sourceSha256: string;
  sourceByteSize: number;
  /** Exercises the archive route before the online representation changes. */
  forceArchive: boolean;
  signal?: AbortSignal;
}

export interface AttemptEvidenceAppReadback {
  attemptId: string;
  archiveId: string;
  sourceSha256: string;
  sourceByteSize: number;
  source: "gcs" | "worker-volume";
  payloadText: string;
}

export type AttemptEvidenceAppReader = (
  request: AttemptEvidenceAppReadRequest,
) => Promise<AttemptEvidenceAppReadback>;

export interface AttemptEvidenceDependencyProof {
  contractVersion: 1;
  attemptId: string;
  archiveId: string;
  sourceSha256: string;
  classificationEquivalent: boolean;
  equalityEquivalent: boolean;
  scientificEquivalent: boolean;
  readDependenciesSatisfied: boolean;
  /** Identifies the verified consumer implementation, not a user approval. */
  verifier: string;
  progressiveScope?: Record<string, unknown>;
  applicationSha256?: string;
  reportedApplicationSha256?: string;
}

export interface AttemptEvidencePreview {
  projection: AttemptEvidenceProjection;
  compactPayloadText: string;
  originalStoredBytes: number;
  projectionStoredBytes: number;
}

export type AttemptEvidenceDependencyVerifier = (input: {
  attemptId: string;
  archive: AttemptEvidenceArchiveRecord;
  originalPayloadText: string;
  preview: AttemptEvidencePreview;
}) => Promise<AttemptEvidenceDependencyProof>;

function assertId(id: string): void {
  if (!UUID.test(id))
    throw new Error("Attempt evidence requires a stable UUID");
}

/** Safe before 0208: missing pointer columns mean a complete inline value. */
export async function getAttemptEvidenceStorage(
  db: DB,
  attemptId: string,
): Promise<AttemptEvidenceStorage | null> {
  assertId(attemptId);
  attemptId = attemptId.toLowerCase();
  const hasPointer = await hasAttemptEvidenceStoragePointer(db);
  const archiveColumn = hasPointer
    ? sql`a.evidence_archive_id`
    : sql`NULL::uuid`;
  const eventColumn = hasPointer
    ? sql`a.evidence_storage_event_id`
    : sql`NULL::uuid`;
  const [row] = await db.execute(sql`SELECT a.id,a.result_id,a.sim_job_id,
    CASE WHEN ${archiveColumn} IS NULL AND octet_length(a.evidence_payload::text)<=${MAX_ATTEMPT_EVIDENCE_BYTES} THEN a.evidence_payload::text END AS payload_text,
    CASE WHEN ${archiveColumn} IS NOT NULL THEN a.evidence_payload::text END AS compact_payload_text,${archiveColumn} AS archive_id,${eventColumn} AS event_id
    FROM result_attempts a WHERE a.id=${attemptId}::uuid`);
  if (!row) return null;
  const common = {
    attemptId: String(row.id),
    resultId: row.result_id ? String(row.result_id) : null,
    simJobId: row.sim_job_id ? String(row.sim_job_id) : null,
  };
  if (!row.archive_id) {
    if (typeof row.payload_text !== "string")
      throw new Error("Attempt evidence is unavailable");
    return {
      ...common,
      state: "inline",
      inlinePayloadText: row.payload_text,
      compactPayloadText: null,
      archive: null,
      projection: null,
    };
  }
  const archiveId = String(row.archive_id);
  const projections = await readAttemptProjections(db, [{ attemptId, archiveId }]);
  const projection = projections.get(`${attemptId}:${archiveId}`);
  const archive = await getAttemptEvidenceArchive(db, archiveId);
  if (
    !projection ||
    projection.version !== 1 ||
    projection.attemptId !== attemptId ||
    projection.archiveId !== archiveId ||
    archive.attemptId !== attemptId ||
    archive.resultId !== common.resultId ||
    (common.simJobId !== null && archive.simJobId !== common.simJobId) ||
    archive.sourceSha256 !== projection.sourceSha256 ||
    archive.sourceByteSize !== projection.sourceByteSize
  )
    throw new Error(
      "Attempt evidence compact payload or immutable projection changed",
    );
  if (
    typeof row.compact_payload_text !== "string" ||
    reportTextIdentity(row.compact_payload_text).sha256 !==
      projection.compactSha256
  )
    throw new Error("Attempt compact payload fingerprint changed");
  return {
    ...common,
    state: "archived",
    storageEventId: String(row.event_id),
    inlinePayloadText: null,
    compactPayloadText: row.compact_payload_text,
    archive,
    projection,
  };
}

/** Validates a forced original read while the row is still inline. A normal
 * archived read always follows the stored pointer; a different archive is refused. */
export async function getAttemptEvidenceArchiveForRead(
  db: DB,
  attemptId: string,
  archiveId?: string,
): Promise<AttemptEvidenceArchiveRecord | null> {
  assertId(attemptId);
  attemptId = attemptId.toLowerCase();
  if (archiveId !== undefined) {
    assertId(archiveId);
    archiveId = archiveId.toLowerCase();
  }
  const stored = await getAttemptEvidenceStorage(db, attemptId);
  if (!stored) return null;
  if (stored.state === "archived") {
    if (archiveId !== undefined && archiveId !== stored.archive.id)
      throw new Error(
        "Attempt archive reference is not the current stored generation",
      );
    return stored.archive;
  }
  if (archiveId === undefined) return null;
  assertId(archiveId);
  const archive = await getAttemptEvidenceArchive(db, archiveId);
  const source = reportTextIdentity(stored.inlinePayloadText);
  if (
    archive.attemptId !== attemptId ||
    archive.resultId !== stored.resultId ||
    (stored.simJobId !== null && archive.simJobId !== stored.simJobId) ||
    archive.sourceSha256 !== source.sha256 ||
    archive.sourceByteSize !== source.byteSize
  )
    throw new Error(
      "Attempt archive does not contain the current exact inline source",
    );
  return archive;
}

export interface AttemptEvidenceSqlSource {
  attemptId: SQL;
  archiveId: SQL;
  payload: SQL;
  /** Join the immutable projection once per selected attempt. */
  projection: SQL;
}

const SERIES: Readonly<Record<string, readonly string[]>> = {
  force_history: ["t", "cl", "cd", "cm"],
  forceHistory: ["t", "cl", "cd", "cm"],
  steady_history: ["iterations", "cl", "cd", "cm"],
  steadyHistory: ["iterations", "cl", "cd", "cm"],
  frame_track: ["frames"],
  frameTrack: ["frames"],
};

function pathSql(path: readonly string[]): SQL {
  if (path.some((key) => typeof key !== "string"))
    throw new Error("Attempt evidence path requires strings");
  return sql`ARRAY[${sql.join(
    path.map((key) => sql`${key}`),
    sql`, `,
  )}]::text[]`;
}

function isProjectedPath(path: readonly string[]): boolean {
  return (
    path.length === 0 ||
    (Object.hasOwn(SERIES, path[0]!) &&
      (path.length === 1 || SERIES[path[0]!]!.includes(path[1]!)))
  );
}

function inlineValue(
  source: AttemptEvidenceSqlSource,
  path: readonly string[],
): SQL {
  const value = sql`${source.payload} #> ${pathSql(path)}`;
  return isProjectedPath(path) && path.length <= 2
    ? sql`CASE WHEN ${source.archiveId} IS NULL THEN ${value} ELSE NULL::jsonb END`
    : value;
}

/** No row serialization, hashes or recursive normalization on facts reads. */
export function attemptEvidenceArrayFactsSql(
  source: AttemptEvidenceSqlSource,
  path: readonly string[],
): SQL {
  return sql`attempt_evidence_array_facts(${source.attemptId},${source.archiveId},${inlineValue(source, path)},${source.projection},${pathSql(path)})`;
}

export function attemptEvidenceArrayTypeSql(
  source: AttemptEvidenceSqlSource,
  path: readonly string[],
): SQL {
  return sql`${attemptEvidenceArrayFactsSql(source, path)}->>'jsonType'`;
}

export function attemptEvidenceArrayLengthSql(
  source: AttemptEvidenceSqlSource,
  path: readonly string[],
): SQL {
  return sql`(${attemptEvidenceArrayFactsSql(source, path)}->>'length')::integer`;
}

/** SQL '=' semantics. Only explicit candidates for removed values are hashed. */
export function attemptEvidenceValueEqualsSql(
  source: AttemptEvidenceSqlSource,
  path: readonly string[],
  candidate: SQL,
): SQL {
  if (!isProjectedPath(path))
    return sql`(${source.payload} #> ${pathSql(path)}) = ${candidate}`;
  return sql`attempt_evidence_value_equals(${source.attemptId},${source.archiveId},${inlineValue(source, path)},${source.projection},${pathSql(path)},${candidate})`;
}

/** SQL IS NOT DISTINCT FROM semantics; SQL NULL and JSON null stay different. */
export function attemptEvidenceValueMatchesSql(
  source: AttemptEvidenceSqlSource,
  path: readonly string[],
  candidate: SQL,
): SQL {
  if (!isProjectedPath(path))
    return sql`(${source.payload} #> ${pathSql(path)}) IS NOT DISTINCT FROM ${candidate}`;
  return sql`attempt_evidence_value_matches(${source.attemptId},${source.archiveId},${inlineValue(source, path)},${source.projection},${pathSql(path)},${candidate})`;
}

export interface AttemptEvidenceStoragePolicy {
  hzWorkerOnly: boolean;
  shortProofsEnabled?: boolean;
  shortProofCanaryAttemptId?: string | null;
  tinyHistoriesEnabled?: boolean;
  tinyHistoryCanaryAttemptId?: string | null;
  shorteningEnabled: boolean;
  stoppedProgressiveEnabled: boolean;
  progressiveSourceScope: "legacy" | "stopped-only" | "receipt-bearing" | "receipt-urans" | "verified";
  canaryAttemptId: string | null;
  consumerContractVersion: number;
  minLogicalBytes: number;
  minNetValueBytes: number;
  maxSourceBytes: number;
  uransMaxSourceBytes: number | null;
  initialSubset: "unreferenced-rans-steady-v1";
}

export interface AttemptEvidenceSettlementMeasurement {
  eventId: string;
  attemptId: string;
  archiveId: string;
  sourceStoredBytes: number;
  remainingStoredBytes: number;
  projectionValueBytes: number;
  verificationValueBytes: number;
  payloadBytesReclaimed: number;
  netValueBytesReclaimed: number;
  removedLogicalBytes: number;
}

export interface AttemptEvidenceSettlementReplay {
  eventId: string;
  attemptId: string;
  archiveId: string;
  alreadyShortened: true;
  payloadBytesReclaimed: 0;
  netValueBytesReclaimed: 0;
}

export async function getAttemptEvidenceStoragePolicy(
  db: DB,
): Promise<AttemptEvidenceStoragePolicy | null> {
  const [ready] = await db.execute(
    sql`SELECT to_regclass('attempt_evidence_storage_policy') IS NOT NULL AS ready`,
  );
  if (ready?.ready !== true) return null;
  const [row] =
    await db.execute(sql`SELECT shortening_enabled AS "shorteningEnabled",canary_attempt_id AS "canaryAttemptId",consumer_contract_version AS "consumerContractVersion",
    min_logical_bytes AS "minLogicalBytes",min_net_value_bytes AS "minNetValueBytes",max_source_bytes AS "maxSourceBytes",initial_subset AS "initialSubset",
    coalesce((to_jsonb(policy)->>'stopped_progressive_enabled')::boolean,false) AS "stoppedProgressiveEnabled",
    coalesce(to_jsonb(policy)->>'progressive_source_scope','legacy') AS "progressiveSourceScope",
    coalesce((to_jsonb(policy)->>'hz_worker_only')::boolean,false) AS "hzWorkerOnly",
    coalesce((to_jsonb(policy)->>'short_proofs_enabled')::boolean,false) AS "shortProofsEnabled",
    to_jsonb(policy)->>'short_proof_canary_attempt_id' AS "shortProofCanaryAttemptId",
    coalesce((to_jsonb(policy)->>'tiny_histories_enabled')::boolean,false) AS "tinyHistoriesEnabled",
    to_jsonb(policy)->>'tiny_history_canary_attempt_id' AS "tinyHistoryCanaryAttemptId",
    (to_jsonb(policy)->>'urans_max_source_bytes')::integer AS "uransMaxSourceBytes"
    FROM attempt_evidence_storage_policy policy WHERE id=1`);
  return row as unknown as AttemptEvidenceStoragePolicy;
}

/** Change only the signed, measured-floor fallback. Other cohort policies keep
 * running during a scoped canary. Disabling writing preserves every old reader. */
export async function setShortAttemptProofPolicy(
  db: DB, enabled: boolean, canaryAttemptId?: string,
  cohort: "measured-floor" | "tiny-history" = "measured-floor",
) {
  const tinyHistories = cohort === "tiny-history";
  if (canaryAttemptId) assertId(canaryAttemptId);
  if (!enabled && canaryAttemptId) throw new Error("A short-proof canary requires enablement");
  const enabledColumn = sql.identifier(tinyHistories ? "tiny_histories_enabled" : "short_proofs_enabled");
  const canaryColumn = sql.identifier(tinyHistories ? "tiny_history_canary_attempt_id" : "short_proof_canary_attempt_id");
  const result = await db.execute(sql`UPDATE attempt_evidence_storage_policy SET ${enabledColumn}=${enabled},
    ${canaryColumn}=${canaryAttemptId ?? null}::uuid
    WHERE id=1 AND (${!enabled} OR (shortening_enabled AND consumer_contract_version=1)) RETURNING id`);
  if (!result.length) throw new Error("Short proofs require the active native attempt consumer contract");
  return getAttemptEvidenceStoragePolicy(db);
}

export async function setAttemptEvidenceStoragePolicy(
  db: DB,
  options: {
    enabled: boolean;
    consumerContractVersion?: 1;
    canaryAttemptId?: string;
    stoppedProgressive?: boolean | "only";
    receiptBearing?: boolean;
    receiptUrans?: boolean;
    uransMaxSourceBytes?: number;
  },
) {
  if (options.enabled && options.consumerContractVersion !== 1)
    throw new Error("Shortening requires consumer contract v1");
  if (options.canaryAttemptId !== undefined) assertId(options.canaryAttemptId);
  const [schema] = await db.execute(sql`SELECT EXISTS(SELECT FROM pg_attribute
    WHERE attrelid=to_regclass('attempt_evidence_storage_policy') AND attname='stopped_progressive_enabled'
      AND NOT attisdropped) AS installed, EXISTS(SELECT FROM pg_attribute
    WHERE attrelid=to_regclass('attempt_evidence_storage_policy') AND attname='progressive_source_scope' AND NOT attisdropped) AS scoped`);
  if (
    options.uransMaxSourceBytes !== undefined &&
    (!options.receiptUrans ||
      !Number.isSafeInteger(options.uransMaxSourceBytes) ||
      options.uransMaxSourceBytes < 4096 ||
      options.uransMaxSourceBytes > 8 * 1024 * 1024)
  )
    throw new Error(
      "A scoped URANS source limit must be between 4096 bytes and 8 MiB",
    );
  if (
    options.receiptUrans &&
    (options.receiptBearing || options.stoppedProgressive)
  )
    throw new Error("Select one progressive storage scope");
  if (options.receiptUrans) {
    const [ready] = await db.execute(
      sql`SELECT to_regprocedure('attempt_evidence_urans_shortening_limiter(uuid,uuid)') IS NOT NULL AS ready`,
    );
    if (!ready?.ready)
      throw new Error(
        "URANS attempt shortening requires forward migration 0213",
      );
  }
  if (options.receiptBearing && options.stoppedProgressive)
    throw new Error("Select one scientific storage scope");
  const scope = options.receiptUrans
    ? "receipt-urans"
    : options.receiptBearing
      ? "receipt-bearing"
      : options.stoppedProgressive === "only"
        ? "stopped-only"
        : "legacy";
  if (scope !== "legacy" && (!schema?.scoped || !options.enabled))
    throw new Error(
      "Scoped progressive shortening requires migration 0211 and enabled readers",
    );
  if (options.stoppedProgressive && (!options.enabled || !schema?.installed))
    throw new Error(
      "Stopped progressive shortening requires 0210 and enabled readers",
    );
  const stopped = schema?.installed
    ? sql`stopped_progressive_enabled=${Boolean(options.stoppedProgressive)},`
    : sql``;
  const scoped = schema?.scoped
    ? sql`progressive_source_scope=${scope},`
    : sql``;
  const uransBudget =
    options.uransMaxSourceBytes === undefined
      ? sql` `
      : sql`urans_max_source_bytes=${options.uransMaxSourceBytes},`;
  await db.execute(sql`UPDATE attempt_evidence_storage_policy SET ${uransBudget} ${scoped} ${stopped} shortening_enabled=${options.enabled},
    consumer_contract_version=${options.consumerContractVersion ?? 0},canary_attempt_id=${options.canaryAttemptId ?? null}::uuid WHERE id=1`);
  return getAttemptEvidenceStoragePolicy(db);
}

/** Counts only each attempt's current event. Restored or superseded receipts
 * remain history and cannot inflate the current reduction. */
export async function attemptEvidenceSettlementTotals(db: DB) {
  const [row] =
    await db.execute(sql`SELECT count(*)::text AS "shortenedAttempts",
    count(*) FILTER(WHERE e.app_readback_at IS NULL)::text AS "pendingAppReadbacks",
    coalesce(sum(e.source_stored_bytes-e.result_stored_bytes),0)::text AS "payloadBytesReclaimed",
    coalesce(sum(e.net_value_bytes_saved),0)::text AS "netValueBytesReclaimed"
    FROM result_attempts a JOIN attempt_evidence_storage_events e
      ON e.id=a.evidence_storage_event_id AND e.result_attempt_id=a.id AND e.archive_id=a.evidence_archive_id
    WHERE a.evidence_archive_id IS NOT NULL AND e.action='shorten' AND e.completed`);
  return row;
}

/** SQL generates the immutable preview from the still-full source. Consumers
 * can verify it while the live pointer remains NULL. Settlement rebinds the
 * same exact raw source under locks before it removes any online arrays. */
export async function prepareAttemptEvidenceProjection(
  db: DB,
  attemptId: string,
  archiveId: string,
): Promise<AttemptEvidencePreview> {
  assertId(attemptId);
  assertId(archiveId);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
    const [eligible] = await tx.execute(
      sql`SELECT attempt_evidence_shortening_limiter(${attemptId}::uuid,${archiveId}::uuid) AS limiter`,
    );
    if (eligible?.limiter !== null)
      throw new Error(
        `Attempt history shortening limited: ${String(eligible?.limiter ?? "unknown")}`,
      );
    // Preview is read-only. The actual shortening transaction derives and seals
    // the projection from its locked source; rejected proofs leave no metadata.
    const [preview] = await tx.execute(sql`WITH source AS MATERIALIZED (
      SELECT evidence_payload, pg_column_size(evidence_payload) AS stored_bytes FROM result_attempts WHERE id=${attemptId}::uuid
    ), calculated AS MATERIALIZED (
      SELECT attempt_evidence_make_projection(evidence_payload,${attemptId}::uuid,${archiveId}::uuid) AS projection,
        attempt_evidence_compact(evidence_payload)::text AS compact,stored_bytes FROM source
    ) SELECT projection,compact AS "compactPayloadText",stored_bytes AS "originalStoredBytes",pg_column_size(projection) AS "projectionStoredBytes" FROM calculated`);
    if (!preview) throw new Error("Attempt projection source was not found");
    return preview as unknown as AttemptEvidencePreview;
  });
}

export interface AttemptEvidenceFreshVerification {
  direct: {
    attemptId: string;
    archiveId: string;
    bucket: string;
    objectKey: string;
    generation: string;
    storedSha256: string;
    storedByteSize: number;
    crc32c: string;
    sourceSha256: string;
    sourceByteSize: number;
    verifiedAt: string;
  };
  app: Omit<AttemptEvidenceAppReadback, "payloadText"> & {
    forceArchive: true;
    verifiedAt: string;
  };
  dependencies: AttemptEvidenceDependencyProof;
}

export async function shortenAttemptEvidence(
  db: DB,
  attemptId: string,
  archiveId: string,
  verification: AttemptEvidenceFreshVerification,
): Promise<
  AttemptEvidenceSettlementMeasurement | AttemptEvidenceSettlementReplay
> {
  assertId(attemptId);
  assertId(archiveId);
  const attempt = async (short: boolean) => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
    if (!hasConfiguredAttemptHubRole()) {
      // Match the underlying writer's first SHARE lock. A scoped worker cannot
      // race a switch to the verified hub policy between this check and commit.
      const [policy] = await tx.execute(sql`SELECT to_jsonb(p)->>'progressive_source_scope' AS scope
        FROM attempt_evidence_storage_policy p WHERE p.id=1 FOR SHARE OF p`);
      if (policy?.scope === "verified") requireConfiguredAttemptHubRole();
    }
    if (short) {
      // A pre-0233 fixture may share a search path with a newer public schema.
      const [schema] = await tx.execute(sql`SELECT EXISTS(SELECT FROM pg_proc f
        JOIN pg_class a ON a.oid=to_regclass('result_attempts') AND a.relnamespace=f.pronamespace
        WHERE f.oid=to_regprocedure('attempt_evidence_begin_short_proof(uuid,uuid,jsonb)')) AS ready`);
      if (schema?.ready !== true) return null;
      const [format] = await tx.execute(sql`SELECT attempt_evidence_begin_short_proof(${attemptId}::uuid,${archiveId}::uuid,
        ${JSON.stringify(verification)}::jsonb) AS enabled`);
      if (format?.enabled !== true) return null;
    }
    if (verification.direct?.sourceByteSize >= 4 * 1024 * 1024) {
      // Resolve against the source table's schema during rolling upgrades.
      const [local] = await tx.execute(sql`SELECT EXISTS (SELECT FROM pg_proc f
        JOIN pg_class a ON a.oid=to_regclass('result_attempts') AND a.relnamespace=f.pronamespace
        WHERE f.oid=to_regprocedure('attempt_evidence_seal_projection(uuid,uuid)')) AS ready`);
      if (local?.ready === true)
        await tx.execute(sql`SELECT attempt_evidence_seal_projection(${attemptId}::uuid,${archiveId}::uuid)`);
    }
    const [row] = await tx.execute(
      sql`SELECT attempt_evidence_shorten(${attemptId}::uuid,${archiveId}::uuid,${JSON.stringify(verification)}::jsonb) AS measurement`,
    );
    return row.measurement as
      | AttemptEvidenceSettlementMeasurement
      | AttemptEvidenceSettlementReplay;
  });
  try {
    return (await attempt(false))!;
  } catch (error) {
    // Roll back the original attempt (including its projection seal) before
    // reusing the same genuine readbacks and the same native safety gates.
    if (!(error instanceof Error)) throw error;
    const outer = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    const pg = outer.cause?.code ? outer.cause : outer;
    if (pg.code !== "P0002" || pg.message !== "Attempt shortening has insufficient net online value-byte savings") throw error;
    const compact = await attempt(true);
    if (!compact) throw error;
    return compact;
  }
}

export async function restoreAttemptEvidence(
  db: DB,
  attemptId: string,
  archiveId: string,
  originalText: string,
  reason: string,
  expectedEventId?: string,
) {
  assertId(attemptId);
  assertId(archiveId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
    const [row] = await tx.execute(
      sql`SELECT attempt_evidence_restore(${attemptId}::uuid,${archiveId}::uuid,${originalText},${reason},${expectedEventId ?? null}::uuid) AS measurement`,
    );
    return row.measurement as {
      eventId: string;
      attemptId: string;
      archiveId: string;
      restoredStoredBytes: number;
      payloadBytesReclaimed: 0;
      netValueBytesReclaimed: 0;
    };
  });
}

type AttemptShorteningCandidate = {
  id: string;
  limiter: string | null;
  archive_id: string | null;
  cohort?: string | null;
};

export async function attemptEvidenceShorteningCandidates(
  db: DB,
  after: string | null = null,
  selection:
    | boolean
    | AttemptEvidenceStoragePolicy["progressiveSourceScope"] = false,
) {
  if (after !== null) assertId(after);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
    if (selection === "verified")
      return tx.execute<AttemptShorteningCandidate>(
        verifiedAttemptCandidatesSql(after),
      );
    const stoppedProgressiveOnly =
      selection === true || selection === "stopped-only";
    const urans = selection === "receipt-urans";
    const broad = urans || selection === "receipt-bearing";
    const retained =
      !broad && stoppedProgressiveOnly
        ? sql`JOIN progressive_remote_evidence_receipts rr ON rr.result_attempt_id=ar.result_attempt_id AND rr.storage_only`
        : sql``;
    const limiter = urans
      ? sql`attempt_evidence_urans_shortening_limiter(a.id)`
      : broad
        ? sql`attempt_evidence_receipt_shortening_limiter(a.id)`
        : stoppedProgressiveOnly
          ? sql`attempt_evidence_stopped_shortening_limiter(a.id)`
          : sql`attempt_evidence_shortening_limiter(a.id)`;
    return tx.execute<AttemptShorteningCandidate>(sql`WITH ids AS MATERIALIZED (
      SELECT DISTINCT ar.result_attempt_id AS id FROM attempt_evidence_archives ar ${retained}
      ${after ? sql`WHERE ar.result_attempt_id>${after}::uuid` : sql``} ORDER BY ar.result_attempt_id LIMIT 32
    ), candidates AS MATERIALIZED (
      SELECT a.id,a.result_id,a.sim_job_id,${limiter} AS limiter
      FROM ids JOIN result_attempts a USING(id)
    ) SELECT c.id,c.limiter,origin.id AS archive_id FROM candidates c
      LEFT JOIN LATERAL (SELECT ar.id FROM attempt_evidence_archives ar
        WHERE c.limiter IS NULL AND ar.result_attempt_id=c.id AND ar.result_id IS NOT DISTINCT FROM c.result_id
          AND ar.sim_job_id IS NOT DISTINCT FROM c.sim_job_id
          AND ar.source_sha256=(SELECT encode(sha256(convert_to(a.evidence_payload::text,'UTF8')),'hex') FROM result_attempts a WHERE a.id=c.id)
        ORDER BY ar.verified_at DESC,ar.id LIMIT 1) origin ON true ORDER BY c.id`);
  });
}

/** An interrupted worker leaves its committed shortening available for a real
 * app read (or exact restore) on restart. Only the active event owns recovery. */
export async function pendingAttemptEvidenceReadbacks(
  db: DB,
  limit: number,
  afterEventId?: string | null,
) {
  if (afterEventId) assertId(afterEventId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8)
    throw new Error("Invalid attempt readback budget");
  return db.execute(sql`SELECT a.id AS "attemptId",e.archive_id AS "archiveId",e.id AS "eventId"
    FROM attempt_evidence_storage_events e JOIN result_attempts a ON a.id=e.result_attempt_id
      AND a.evidence_archive_id=e.archive_id AND a.evidence_storage_event_id=e.id
    WHERE e.completed AND e.action='shorten' AND e.app_readback_at IS NULL AND e.verification#>>'{app,source}'='gcs'
      ${
        afterEventId
          ? sql`AND (e.created_at,e.id) > (SELECT previous.created_at,previous.id
        FROM attempt_evidence_storage_events previous WHERE previous.id=${afterEventId}::uuid)`
          : sql``
      }
    ORDER BY e.created_at,e.id LIMIT ${limit}`) as unknown as Promise<
    Array<{ attemptId: string; archiveId: string; eventId: string }>
  >;
}

export async function confirmAttemptEvidenceReadback(
  db: DB,
  eventId: string,
  proof: AttemptEvidenceAppReadback,
) {
  assertId(eventId);
  const rows =
    await db.execute(sql`UPDATE attempt_evidence_storage_events e SET app_readback_at=clock_timestamp()
    FROM result_attempts a,attempt_evidence_archives ar WHERE e.id=${eventId}::uuid AND e.completed AND e.action='shorten'
      AND e.app_readback_at IS NULL AND a.id=e.result_attempt_id AND a.evidence_storage_event_id=e.id AND a.evidence_archive_id=ar.id
      AND ar.id=e.archive_id AND a.id=${proof.attemptId}::uuid AND ar.id=${proof.archiveId}::uuid
      AND ar.source_sha256=${proof.sourceSha256} AND ar.source_byte_size=${proof.sourceByteSize} RETURNING e.id`);
  if (rows.length) return;
  const [replay] =
    await db.execute(sql`SELECT 1 FROM attempt_evidence_storage_events e JOIN result_attempts a ON a.evidence_storage_event_id=e.id
    JOIN attempt_evidence_archives ar ON ar.id=e.archive_id WHERE e.id=${eventId}::uuid AND e.completed AND e.action='shorten' AND e.app_readback_at IS NOT NULL
      AND a.id=${proof.attemptId}::uuid AND ar.id=${proof.archiveId}::uuid AND ar.source_sha256=${proof.sourceSha256} AND ar.source_byte_size=${proof.sourceByteSize}`);
  if (!replay)
    throw new Error(
      "Attempt application readback belongs to a superseded storage event",
    );
}
