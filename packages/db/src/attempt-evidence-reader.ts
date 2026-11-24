import { readAttemptProjections } from "./attempt-evidence-proof-reader";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import {
  assertAttemptEvidenceArchive,
  type AttemptEvidenceArchiveIdentity,
  type AttemptEvidenceArchiveRecord,
} from "./attempt-evidence-catalog";
import {
  MAX_ATTEMPT_EVIDENCE_BYTES,
  prepareAttemptEvidenceCopy,
  type AttemptEvidenceCopySource,
} from "./attempt-evidence-storage";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import {
  loadAttemptSourcePins,
  type AttemptSourcePin,
} from "./attempt-receipt-source";
import {
  canonicalReportJson,
  parseReportJson,
  ReportJsonNumber,
  reportTextIdentity,
  type ReportJson,
} from "./progressive-report-archive";
import type { AttemptEvidenceProjection } from "./attempt-evidence-projection";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const LOOKUP_BATCH = 128;
export interface AttemptEvidenceArchiveReader {
  read(
    identity: AttemptEvidenceArchiveIdentity,
    signal?: AbortSignal,
  ): Promise<AttemptEvidenceCopySource>;
}
export interface AttemptEvidenceReadRow {
  id: string;
  resultId: string | null;
  simJobId: string | null;
  evidencePayload: unknown;
  /** Authoritative 0208 pointer. Undefined projections are resolved by ID;
   * a null pointer is the normal inline fast path. */
  evidenceArchiveId?: string | null;
  evidenceStorageEventId?: string | null;
}
export interface AttemptEvidenceReadOptions {
  signal?: AbortSignal;
  /** Readiness/retention probes must prove archive access, not just inline
   * readability. Normal API consumers may reuse exact original inline bytes. */
  requireArchiveRead?: boolean;
}
export interface AttemptEvidenceTextReadOptions extends AttemptEvidenceReadOptions {
  archiveId?: string;
  /** Explicit original-GCS probe while the complete source is still inline. */
  forceArchive?: boolean;
}
export class AttemptEvidenceReadError extends Error {
  constructor(
    readonly code: "missing" | "stale" | "invalid" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}
function fail(code: AttemptEvidenceReadError["code"], message: string): never {
  throw new AttemptEvidenceReadError(code, message);
}
const ids = (values: readonly string[]) => {
  if (values.some((id) => !UUID.test(id)))
    fail("invalid", "Attempt evidence requires stable UUIDs");
  return sql.join(
    values.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
};
interface CurrentRow {
  id: string;
  resultId: string | null;
  simJobId: string | null;
  archiveId: string | null;
  storageEventId?: string | null;
  sourcePin?: AttemptSourcePin;
  payloadText: string | null;
  payloadBytes: number | null;
  projection?: AttemptEvidenceProjection;
  forcedInline?: boolean;
}

async function currentRows(
  db: DB,
  attemptIds: string[],
  fullInline: boolean,
): Promise<CurrentRow[]> {
  if (!attemptIds.length) return [];
  const [schema] = await db.execute(
    sql`SELECT to_regclass('attempt_evidence_history_projections') IS NOT NULL AS ready`,
  );
  const pointer =
    schema?.ready === true ? sql`a.evidence_archive_id` : sql`NULL::uuid`;
  return (await db.execute(sql`
    SELECT a.id, a.result_id AS "resultId", a.sim_job_id AS "simJobId",
      ${pointer} AS "archiveId",
      ${schema?.ready === true ? sql`a.evidence_storage_event_id` : sql`NULL::uuid`} AS "storageEventId",
      CASE WHEN ${fullInline} OR ${pointer} IS NOT NULL
        THEN octet_length(a.evidence_payload::text) END AS "payloadBytes",
      CASE WHEN (${fullInline} OR ${pointer} IS NOT NULL)
        AND octet_length(a.evidence_payload::text) <= ${MAX_ATTEMPT_EVIDENCE_BYTES}
        THEN a.evidence_payload::text END AS "payloadText"
    FROM result_attempts a WHERE a.id IN (${ids(attemptIds)})
  `)) as unknown as CurrentRow[];
}

type ReadArchive = AttemptEvidenceArchiveRecord;
async function archives(
  db: DB,
  archiveIds: string[],
): Promise<Map<string, ReadArchive>> {
  if (!archiveIds.length) return new Map();
  const rows = await db.execute(
    sql`SELECT archive.* FROM attempt_evidence_archives archive WHERE archive.id IN (${ids(archiveIds)})`,
  );
  const result = new Map<string, ReadArchive>();
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const record: ReadArchive = {
      id: String(r.id),
      sourceInstance: String(r.source_instance),
      attemptId: String(r.result_attempt_id),
      resultId: r.result_id === null ? null : String(r.result_id),
      simJobId: r.sim_job_id === null ? null : String(r.sim_job_id),
      sourceSha256: String(r.source_sha256),
      sourceByteSize: Number(r.source_byte_size),
      envelopeSha256: String(r.envelope_sha256),
      envelopeByteSize: Number(r.envelope_byte_size),
      storedSha256: String(r.stored_sha256),
      storedByteSize: Number(r.stored_byte_size),
      crc32c: String(r.crc32c),
      bucket: String(r.bucket),
      objectKey: String(r.object_key),
      generation: String(r.generation),
      verifiedAt: new Date(r.verified_at as string | Date),
      historySeries:
        r.history_series as AttemptEvidenceArchiveRecord["historySeries"],
      historyByteSize: Number(r.history_byte_size),
    };
    if (
      (typeof r.generation !== "string" &&
        (typeof r.generation !== "number" ||
          !Number.isSafeInteger(r.generation))) ||
      !UUID.test(record.id)
    )
      fail("invalid", "Attempt archive catalog generation or ID is not exact");
    assertAttemptEvidenceArchive(record);
    if (
      !Array.isArray(record.historySeries) ||
      !record.historySeries.length ||
      !Number.isSafeInteger(record.historyByteSize) ||
      record.historyByteSize < 1 ||
      record.historyByteSize > record.sourceByteSize
    )
      fail("invalid", "Attempt archive history inventory is invalid");
    result.set(record.id, record);
  }
  return result;
}

/** Metadata is allowed to differ ONLY by omission of inventoried array leaves.
 * No []/null placeholders, added sentinels or changed certificate/scalar values
 * are accepted. Both sides are parsed losslessly from PostgreSQL/source text. */
export function attemptEvidenceMetadataMatches(
  fullText: string,
  currentText: string,
  paths: readonly string[][],
): boolean {
  const omitted = new Set(paths.map((path) => JSON.stringify(path)));
  const plain = (v: ReportJson): v is Record<string, ReportJson> =>
    v !== null &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    !(v instanceof ReportJsonNumber);
  const equal = (
    full: ReportJson,
    current: ReportJson,
    path: string[],
  ): boolean => {
    if (Array.isArray(full))
      return (
        Array.isArray(current) &&
        full.length === current.length &&
        full.every((v, i) => equal(v, current[i]!, [...path, String(i)]))
      );
    if (plain(full)) {
      if (
        !plain(current) ||
        Object.keys(current).some((key) => !Object.hasOwn(full, key))
      )
        return false;
      return Object.entries(full).every(([key, value]) =>
        Object.hasOwn(current, key)
          ? equal(value, current[key]!, [...path, key])
          : Array.isArray(value) && omitted.has(JSON.stringify([...path, key])),
      );
    }
    return canonicalReportJson(full) === canonicalReportJson(current);
  };
  return equal(parseReportJson(fullText), parseReportJson(currentText), []);
}

async function attachProjections(db: DB, current: CurrentRow[]): Promise<void> {
  const cold = current.filter((row) => row.archiveId && !row.forcedInline);
  if (!cold.length) return;
  const withEvents = cold.filter((row) => row.storageEventId);
  if (withEvents.length) {
    const [schema] = await db.execute(
      sql`SELECT to_regprocedure('attempt_evidence_archived_application_sha256(uuid,uuid,uuid)') IS NOT NULL AS ready`,
    );
    if (schema?.ready === true) {
      const pins = await loadAttemptSourcePins(
        db,
        withEvents.map((row) => row.id),
      );
      const sealed = await db.execute(sql`SELECT result_attempt_id,
          verification#>>'{dependencies,progressiveScope,scientific,attemptToken}' AS token,
          verification#>>'{dependencies,progressiveScope,scientific,applicationSha256}' AS scientific,
          verification#>>'{dependencies,applicationSha256}' AS application
        FROM attempt_evidence_storage_events WHERE id IN (${ids(withEvents.map((row) => row.storageEventId!))})
        AND completed AND action='shorten' AND verification#>>'{dependencies,verifier}' IN ('server-consumers/receipt-bearing-rans-v1','server-consumers/receipt-bearing-urans-v1')`);
      const originals = new Map(
        sealed.map((r) => [String(r.result_attempt_id), r]),
      );
      for (const row of withEvents) {
        const pin = pins.get(row.id);
        if (
          !pin ||
          pin.archiveId !== row.archiveId ||
          pin.storageEventId !== row.storageEventId ||
          pin.resultId !== row.resultId ||
          pin.simJobId !== row.simJobId
        )
          fail(
            "stale",
            "Attempt receipt or storage event changed before the archived read",
          );
        const original = originals.get(row.id);
        if (
          original &&
          (original.token !== pin.cfdAttemptToken ||
            original.scientific !== pin.cfdEvidenceSignature ||
            !pin.applicationSha256 ||
            original.application !== pin.applicationSha256)
        )
          fail(
            "stale",
            "Original attempt token or scientific receipt changed after shortening",
          );
        row.sourcePin = pin;
      }
    }
  }
  const projections = await readAttemptProjections(db, cold.map(row => ({ attemptId: row.id, archiveId: row.archiveId! })));
  for (const row of cold) {
    const p = projections.get(`${row.id}:${row.archiveId}`);
    if (
      !p ||
      p.version !== 1 ||
      p.attemptId !== row.id ||
      p.archiveId !== row.archiveId ||
      row.payloadText === null ||
      !Array.isArray(p.removedPaths) ||
      !p.values ||
      typeof p.values !== "object" ||
      Array.isArray(p.values)
    )
      fail("stale", "Attempt compact payload or immutable projection changed");
    row.projection = p;
  }
}

async function recheckReadSources(db: DB, rows: Iterable<CurrentRow>) {
  const pins = [...rows].flatMap((row) =>
    row.sourcePin ? [row.sourcePin] : [],
  );
  if (!pins.length) return;
  const current = await loadAttemptSourcePins(
    db,
    pins.map((pin) => pin.attemptId),
  );
  for (const pin of pins)
    if (
      canonicalAnalysisJson(current.get(pin.attemptId) ?? null) !==
      canonicalAnalysisJson(pin)
    )
      fail(
        "stale",
        "Attempt source or receipt changed during the archived read",
      );
}

function assertOwner(
  current: CurrentRow,
  archive: AttemptEvidenceArchiveRecord,
): void {
  if (
    archive.id !== current.archiveId ||
    archive.attemptId !== current.id ||
    archive.resultId !== current.resultId ||
    (current.simJobId !== null && archive.simJobId !== current.simJobId)
  )
    fail("stale", "Attempt archive does not belong to its exact current owner");
  if (current.payloadText === null)
    fail("invalid", "Attempt metadata is missing or exceeds its read bound");
  if (
    current.projection &&
    (current.projection.sourceSha256 !== archive.sourceSha256 ||
      current.projection.sourceByteSize !== archive.sourceByteSize)
  )
    fail("stale", "Attempt projection and catalog source identity differ");
}

async function fullText(
  current: CurrentRow,
  archive: ReadArchive,
  reader: AttemptEvidenceArchiveReader,
  options: AttemptEvidenceReadOptions,
): Promise<string> {
  options.signal?.throwIfAborted();
  assertOwner(current, archive);
  if (
    current.projection &&
    reportTextIdentity(current.payloadText!).sha256 !==
      current.projection.compactSha256
  )
    fail("stale", "Attempt compact payload fingerprint changed");
  const inline = reportTextIdentity(current.payloadText!);
  if (
    current.forcedInline &&
    (inline.sha256 !== archive.sourceSha256 ||
      inline.byteSize !== archive.sourceByteSize)
  )
    fail(
      "stale",
      "Forced archive does not contain the exact current inline source",
    );
  if (
    !options.requireArchiveRead &&
    !current.sourcePin?.applicationSha256 &&
    !current.sourcePin?.cfdEvidenceSignature &&
    inline.sha256 === archive.sourceSha256 &&
    inline.byteSize === archive.sourceByteSize
  )
    return current.payloadText!;
  let source: AttemptEvidenceCopySource;
  try {
    source = await reader.read(archive, options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    fail(
      "unavailable",
      "Exact archived attempt evidence is unavailable or failed verification",
    );
  }
  options.signal?.throwIfAborted();
  const plan = prepareAttemptEvidenceCopy(source!);
  if (
    source!.attemptId !== current.id ||
    source!.resultId !== current.resultId ||
    source!.simJobId !== archive.simJobId ||
    plan.sourceSha256 !== archive.sourceSha256 ||
    plan.sourceByteSize !== archive.sourceByteSize ||
    canonicalAnalysisJson(plan.historySeries) !==
      canonicalAnalysisJson(archive.historySeries) ||
    plan.historySeries.reduce((sum, series) => sum + series.byteSize, 0) !==
      archive.historyByteSize
  )
    fail(
      "stale",
      "Attempt archive source or complete history inventory differs from its catalog",
    );
  const paths = current.projection?.removedPaths ?? [];
  if (
    paths.some(
      (path) =>
        !plan.historySeries.some(
          (entry) =>
            canonicalAnalysisJson(entry.path) === canonicalAnalysisJson(path),
        ),
    ) ||
    !attemptEvidenceMetadataMatches(
      source!.payloadText,
      current.payloadText!,
      paths,
    )
  )
    fail(
      "stale",
      "Retained attempt metadata differs from its immutable archived source",
    );
  const pin = current.sourcePin;
  if (pin?.applicationSha256 || pin?.cfdEvidenceSignature) {
    const digest = analysisContentHash(JSON.parse(source!.payloadText));
    if (
      (pin.applicationSha256 && digest !== pin.applicationSha256) ||
      (pin.cfdEvidenceSignature && digest !== pin.cfdEvidenceSignature)
    )
      fail(
        "stale",
        "Archived attempt payload differs from its scientific receipt",
      );
  }
  return source!.payloadText;
}

/** Complete text reads always resolve the authoritative row/catalog by ID.
 * Reader access is injected: unavailable HZ canonical access never creates a
 * proxy grant, picks another attempt or substitutes a compact payload. */
export async function readAttemptEvidenceText(
  db: DB,
  reader: AttemptEvidenceArchiveReader,
  attemptId: string,
  options: AttemptEvidenceTextReadOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  if (!UUID.test(attemptId))
    fail("invalid", "Attempt evidence requires an exact stable UUID");
  attemptId = attemptId.toLowerCase();
  if (options.archiveId)
    options = { ...options, archiveId: options.archiveId.toLowerCase() };
  let [current] = await currentRows(db, [attemptId], true);
  if (!current) fail("missing", "Attempt evidence was not found");
  if (options.archiveId) {
    if (
      !UUID.test(options.archiveId) ||
      (current.archiveId !== null && current.archiveId !== options.archiveId)
    )
      fail(
        "stale",
        "Requested attempt archive is not its authoritative generation",
      );
    if (current.archiveId === null) {
      if (!options.forceArchive)
        fail(
          "unavailable",
          "Normal attempt reads must follow the stored archive pointer",
        );
      current = {
        ...current,
        archiveId: options.archiveId,
        forcedInline: true,
      };
    }
  }
  if (!current.archiveId) {
    if (options.requireArchiveRead)
      fail(
        "unavailable",
        "Attempt evidence has no authoritative archive pointer",
      );
    if (current.payloadText === null)
      fail("invalid", "Attempt evidence is missing or exceeds its read bound");
    return current.payloadText!;
  }
  const archive = (await archives(db, [current.archiveId])).get(
    current.archiveId,
  );
  if (!archive)
    fail("missing", "Exact attempt archive catalog entry was not found");
  assertOwner(current, archive);
  await attachProjections(db, [current]);
  const text = await fullText(current, archive!, reader, {
    ...options,
    requireArchiveRead: options.requireArchiveRead || options.forceArchive,
  });
  await recheckReadSources(db, [current]);
  return text;
}

export async function hydrateAttemptEvidenceBatch<
  T extends AttemptEvidenceReadRow,
>(
  db: DB,
  reader: AttemptEvidenceArchiveReader,
  rows: readonly T[],
  options: AttemptEvidenceReadOptions = {},
): Promise<T[]> {
  options.signal?.throwIfAborted();
  rows.forEach((row) => {
    if (!UUID.test(row.id))
      fail(
        "invalid",
        "Attempt hydration requires an exact stable attempt UUID",
      );
  });
  // An older Drizzle schema may omit the 0208 pointer property entirely. Ask
  // the authoritative row query in that case so compact rows still hydrate;
  // an inline row returns immediately after the bounded lookup.
  const pending = [
    ...new Set(
      rows
        .filter(
          (r) => r.evidenceArchiveId !== null || options.requireArchiveRead,
        )
        .map((r) => r.id.toLowerCase()),
    ),
  ];
  if (!pending.length) return [...rows];
  const current = new Map<string, CurrentRow>(),
    catalog = new Map<string, ReadArchive>();
  for (let offset = 0; offset < pending.length; offset += LOOKUP_BATCH) {
    options.signal?.throwIfAborted();
    const found = await currentRows(
      db,
      pending.slice(offset, offset + LOOKUP_BATCH),
      false,
    );
    found.forEach((row) => current.set(row.id, row));
    const archiveIds = [
      ...new Set(
        found.flatMap((row) => (row.archiveId ? [row.archiveId] : [])),
      ),
    ];
    for (const [id, entry] of await archives(db, archiveIds))
      catalog.set(id, entry);
    for (const row of found)
      if (row.archiveId) {
        const archive = catalog.get(row.archiveId);
        if (!archive)
          fail("missing", "Selected attempt archive catalog is missing");
        assertOwner(row, archive);
      }
    await attachProjections(db, found);
  }
  const payloads = new Map<string, unknown>();
  const result: T[] = [];
  for (const row of rows) {
    options.signal?.throwIfAborted();
    if (row.evidenceArchiveId === null && !options.requireArchiveRead) {
      result.push(row);
      continue;
    }
    const stored = current.get(row.id.toLowerCase());
    if (!stored) fail("missing", "Selected attempt evidence is missing");
    if (
      stored.resultId !== row.resultId ||
      stored.simJobId !== row.simJobId ||
      (row.evidenceStorageEventId !== undefined &&
        row.evidenceStorageEventId !== stored.storageEventId) ||
      (row.evidenceArchiveId !== undefined &&
        row.evidenceArchiveId?.toLowerCase() !== stored.archiveId)
    )
      fail("stale", "Selected attempt owner or archive pointer changed");
    if (!stored.archiveId) {
      if (options.requireArchiveRead)
        fail(
          "unavailable",
          "Selected attempt has no authoritative archive pointer",
        );
      result.push(row);
      continue;
    }
    const archive = catalog.get(stored.archiveId);
    if (!archive)
      fail("missing", "Selected attempt archive catalog entry is missing");
    assertOwner(stored, archive);
    if (!payloads.has(archive.id))
      payloads.set(
        archive.id,
        JSON.parse(await fullText(stored, archive, reader, options)),
      );
    result.push({ ...row, evidencePayload: payloads.get(archive.id) });
  }
  await recheckReadSources(db, current.values());
  return result;
}

export async function hydrateAttemptEvidence<T extends AttemptEvidenceReadRow>(
  db: DB,
  reader: AttemptEvidenceArchiveReader,
  row: T,
  options: AttemptEvidenceReadOptions = {},
): Promise<T> {
  return (await hydrateAttemptEvidenceBatch(db, reader, [row], options))[0]!;
}
