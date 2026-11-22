import { sql, type SQL } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import {
  readAttemptEvidenceText,
  type AttemptEvidenceArchiveReader,
} from "./attempt-evidence-reader";
import { reportTextIdentity } from "./progressive-report-archive";

/** Representation and original scientific identity. Fit state, verdicts and
 * model membership are separate snapshots owned by their normal consumers. */
export interface AttemptSourcePin {
  attemptId: string;
  resultId: string | null;
  simJobId: string | null;
  originalSimJobId: string | null;
  archiveId: string | null;
  storageEventId: string | null;
  generation: string | null;
  sourceSha256: string | null;
  sourceByteSize: number | null;
  applicationSha256: string | null;
  cfdAttemptToken: string | null;
  cfdEvidenceSignature: string | null;
}

export interface PreparedAttemptSource {
  pin: AttemptSourcePin & {
    sourceSha256: string;
    sourceByteSize: number;
    applicationSha256: string;
  };
  payloadText: string;
  payload: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const PAGE = 64;
const nullable = (v: unknown) => (v == null ? null : String(v));

function idsSql(ids: readonly string[]) {
  return sql.join(
    ids.map((id) => {
      if (!UUID.test(id))
        throw new Error("A scientific source requires an exact attempt ID");
      return sql`${id}::uuid`;
    }),
    sql`, `,
  );
}

/** Use the original 0208 tables so readers can run before 0211 is installed.
 * 0208 local events have no application digest. 0210 stopped and 0211
 * scientific events seal it against the owning archive and projection. */
export function archivedAttemptApplicationSha256Sql(
  attempt: SQL,
): SQL<string | null> {
  return sql`CASE WHEN ${attempt}.evidence_archive_id IS NOT NULL THEN (
    SELECT event.verification#>>'{dependencies,applicationSha256}'
    FROM attempt_evidence_storage_events event
    JOIN attempt_evidence_archives archive ON archive.id=event.archive_id AND archive.result_attempt_id=event.result_attempt_id
    JOIN attempt_evidence_history_projections projection ON projection.result_attempt_id=event.result_attempt_id AND projection.archive_id=archive.id
    WHERE event.id=${attempt}.evidence_storage_event_id AND event.result_attempt_id=${attempt}.id
      AND event.archive_id=${attempt}.evidence_archive_id AND event.completed AND event.action='shorten'
      AND archive.result_id IS NOT DISTINCT FROM ${attempt}.result_id
      AND (${attempt}.sim_job_id IS NULL OR archive.sim_job_id=${attempt}.sim_job_id)
      AND event.verification#>>'{dependencies,verifier}' IN ('server-consumers/stopped-progressive-rans-v1','server-consumers/receipt-bearing-rans-v1')
      AND event.verification#>>'{dependencies,sourceSha256}'=archive.source_sha256
      AND projection.projection->>'sourceSha256'=archive.source_sha256
      AND (projection.projection->>'sourceByteSize')::bigint=archive.source_byte_size
      AND event.verification#>>'{dependencies,applicationSha256}' ~ '^[a-f0-9]{64}$'
  ) END`;
}

async function sourcePins(db: DB, ids: readonly string[], lock: boolean) {
  const pins = new Map<string, AttemptSourcePin>();
  const ordered = [...new Set(ids.map((id) => id.toLowerCase()))].sort();
  for (let offset = 0; offset < ordered.length; offset += PAGE) {
    const list = idsSql(ordered.slice(offset, offset + PAGE));
    const rows =
      await db.execute(sql`SELECT a.id,a.result_id,a.sim_job_id,a.evidence_archive_id,a.evidence_storage_event_id,
      ar.sim_job_id AS original_job,ar.generation,ar.source_sha256,ar.source_byte_size,
      ${archivedAttemptApplicationSha256Sql(sql`a`)} AS application_sha256,
      cf.attempt_token,cf.evidence_signature
      FROM result_attempts a LEFT JOIN attempt_evidence_archives ar ON ar.id=a.evidence_archive_id
        AND ar.result_attempt_id=a.id AND ar.result_id IS NOT DISTINCT FROM a.result_id
        AND (a.sim_job_id IS NULL OR ar.sim_job_id=a.sim_job_id)
      LEFT JOIN progressive_cfd_evidence cf ON cf.result_attempt_id=a.id
      WHERE a.id IN (${list}) ORDER BY a.id ${lock ? sql`FOR SHARE OF a` : sql``}`);
    for (const r of rows) {
      const pin: AttemptSourcePin = {
        attemptId: String(r.id),
        resultId: nullable(r.result_id),
        simJobId: nullable(r.sim_job_id),
        originalSimJobId: nullable(
          r.evidence_archive_id ? r.original_job : r.sim_job_id,
        ),
        archiveId: nullable(r.evidence_archive_id),
        storageEventId: nullable(r.evidence_storage_event_id),
        generation: nullable(r.generation),
        sourceSha256: nullable(r.source_sha256),
        sourceByteSize:
          r.source_byte_size == null ? null : Number(r.source_byte_size),
        applicationSha256: nullable(r.application_sha256),
        cfdAttemptToken: nullable(r.attempt_token),
        cfdEvidenceSignature: nullable(r.evidence_signature),
      };
      if (
        pin.archiveId &&
        (typeof r.generation !== "string" ||
          !/^[1-9][0-9]{0,19}$/.test(r.generation) ||
          !pin.storageEventId ||
          !pin.sourceSha256 ||
          !SHA.test(pin.sourceSha256) ||
          !Number.isSafeInteger(pin.sourceByteSize) ||
          !pin.sourceByteSize ||
          (pin.cfdEvidenceSignature &&
            pin.applicationSha256 !== null &&
            pin.applicationSha256 !== pin.cfdEvidenceSignature))
      )
        throw new Error(
          "Archived scientific source has a missing or inconsistent owner/receipt",
        );
      pins.set(pin.attemptId, pin);
    }
  }
  if (pins.size !== ordered.length)
    throw new Error("An exact attempt source no longer exists");
  return pins;
}

export async function loadAttemptSourcePins(
  db: DB,
  attemptIds: readonly string[],
): Promise<ReadonlyMap<string, AttemptSourcePin>> {
  return sourcePins(db, attemptIds, false);
}

/** Inline rows have no sealed application digest. Use their actual payload.
 * Legacy cold rows without a digest require full preparation before comparison. */
export function attemptSourceApplicationSha256(
  pin: AttemptSourcePin,
  inlinePayload?: unknown,
): string {
  if (!pin.archiveId && inlinePayload === undefined)
    throw new Error(
      "An inline scientific signature requires the actual original value",
    );
  const value = pin.archiveId
    ? pin.applicationSha256
    : analysisContentHash(inlinePayload);
  if (
    !value ||
    !SHA.test(value) ||
    (pin.cfdEvidenceSignature && value !== pin.cfdEvidenceSignature)
  )
    throw new Error(
      "Attempt application digest is unavailable or differs from its CFD receipt",
    );
  return value;
}

function sameBinding(a: AttemptSourcePin, b: AttemptSourcePin) {
  return (
    a.attemptId === b.attemptId &&
    a.resultId === b.resultId &&
    a.simJobId === b.simJobId &&
    a.originalSimJobId === b.originalSimJobId &&
    a.archiveId === b.archiveId &&
    a.storageEventId === b.storageEventId &&
    a.generation === b.generation &&
    a.cfdAttemptToken === b.cfdAttemptToken &&
    a.cfdEvidenceSignature === b.cfdEvidenceSignature
  );
}

/** Outside SQL transactions. Sequential immutable reads bound the number of
 * simultaneous decompressions to one. Callers retain their existing batch and
 * total-input budgets. Every returned original is bound to its exact source. */
export async function prepareAttemptSources(
  db: DB,
  reader: AttemptEvidenceArchiveReader,
  pins: readonly AttemptSourcePin[],
  options: { signal?: AbortSignal } = {},
): Promise<ReadonlyMap<string, PreparedAttemptSource>> {
  const prepared = new Map<string, PreparedAttemptSource>();
  for (const pin of pins) {
    options.signal?.throwIfAborted();
    const text = await readAttemptEvidenceText(db, reader, pin.attemptId, {
      ...(pin.archiveId
        ? { archiveId: pin.archiveId, requireArchiveRead: true }
        : {}),
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
    const { sha256, byteSize } = reportTextIdentity(text);
    const payload: unknown = JSON.parse(text);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Attempt source requires the original point object");
    const app = analysisContentHash(payload);
    if (
      (pin.sourceSha256 !== null && sha256 !== pin.sourceSha256) ||
      (pin.sourceByteSize !== null && byteSize !== pin.sourceByteSize) ||
      (pin.applicationSha256 !== null && app !== pin.applicationSha256) ||
      (pin.cfdEvidenceSignature !== null && app !== pin.cfdEvidenceSignature)
    )
      throw new Error(
        "Prepared attempt differs from its pinned scientific original",
      );
    prepared.set(pin.attemptId, {
      pin: {
        ...pin,
        sourceSha256: sha256,
        sourceByteSize: byteSize,
        applicationSha256: app,
      },
      payloadText: text,
      payload: payload as Record<string, unknown>,
    });
  }
  // Bind the bytes to the observed owner as well as their SHA. In
  // particular, a caller-supplied result ID or a restore/re-shorten during
  // an object read cannot be returned as a valid prepared descriptor.
  const observed = await sourcePins(db, [...prepared.keys()], false);
  for (const { pin } of prepared.values()) {
    const row = observed.get(pin.attemptId);
    if (
      !row ||
      !sameBinding(pin, row) ||
      (row.sourceSha256 !== null &&
        (row.sourceSha256 !== pin.sourceSha256 ||
          row.sourceByteSize !== pin.sourceByteSize)) ||
      (row.applicationSha256 !== null &&
        row.applicationSha256 !== pin.applicationSha256)
    )
      throw new Error(
        "Attempt source binding changed during original preparation",
      );
  }
  return prepared;
}

/** At the caller's transaction boundary. SHARE locks hold the representation
 * through commit. Prepared inline bytes are checked under the same lock. An
 * inline metadata pin by itself cannot attest previously observed samples. */
export async function assertAttemptSourcePins(
  tx: DB,
  pins: readonly AttemptSourcePin[],
  options: { lock?: boolean } = {},
): Promise<void> {
  const lock = options.lock !== false;
  if (lock) {
    // The CFD insert guard takes SHARE on its original attempt. Fence a
    // first-ever receipt when absence is part of this observation. An
    // existing receipt only needs a shared lock against deletion.
    const absent = pins
      .filter((pin) => !pin.cfdAttemptToken)
      .map((pin) => pin.attemptId)
      .sort();
    for (let at = 0; at < absent.length; at += PAGE) {
      await tx.execute(sql`SELECT id FROM result_attempts WHERE id IN (${idsSql(absent.slice(at, at + PAGE))})
        ORDER BY id FOR NO KEY UPDATE NOWAIT`);
    }
    const present = pins
      .filter((pin) => pin.cfdAttemptToken)
      .map((pin) => pin.attemptId)
      .sort();
    for (let at = 0; at < present.length; at += PAGE) {
      const slice = present.slice(at, at + PAGE);
      const held =
        await tx.execute(sql`SELECT result_attempt_id FROM progressive_cfd_evidence
        WHERE result_attempt_id IN (${idsSql(slice)}) ORDER BY result_attempt_id FOR SHARE NOWAIT`);
      if (held.length !== new Set(slice).size)
        throw new Error("Scientific source receipt changed before commit");
    }
  }
  const current = await sourcePins(
    tx,
    pins.map((p) => p.attemptId),
    lock,
  );
  const inline = pins.filter((p) => !p.archiveId && p.sourceSha256 !== null);
  for (const pin of pins) {
    const found = current.get(pin.attemptId)!;
    if (
      pin.cfdEvidenceSignature &&
      pin.applicationSha256 &&
      pin.cfdEvidenceSignature !== pin.applicationSha256
    )
      throw new Error("Pinned application digest differs from its CFD receipt");
    if (
      !pin.archiveId &&
      (!pin.sourceSha256 || !pin.sourceByteSize || !pin.applicationSha256)
    )
      throw new Error(
        "Prepare the original inline evidence before a scientific source recheck",
      );
    if (
      !found ||
      !sameBinding(pin, found) ||
      (pin.archiveId &&
        (pin.sourceSha256 !== found.sourceSha256 ||
          pin.sourceByteSize !== found.sourceByteSize ||
          (found.applicationSha256 !== null &&
            pin.applicationSha256 !== found.applicationSha256)))
    )
      throw new Error("Attempt source binding changed; prepare it again");
  }
  for (let offset = 0; offset < inline.length; offset += PAGE) {
    const page = inline.slice(offset, offset + PAGE);
    const expected = sql.join(
      page.map(
        (p) =>
          sql`(${p.attemptId}::uuid,${p.sourceSha256}::text,${p.sourceByteSize}::bigint)`,
      ),
      sql`, `,
    );
    const [row] =
      await tx.execute(sql`WITH pins(id,sha,bytes) AS (VALUES ${expected})
      SELECT count(*)::integer AS matches FROM pins JOIN result_attempts a USING(id)
      WHERE a.evidence_archive_id IS NULL AND octet_length(a.evidence_payload::text)=pins.bytes
        AND encode(sha256(convert_to(a.evidence_payload::text,'UTF8')),'hex')=pins.sha`);
    if (Number(row?.matches) !== page.length)
      throw new Error("Inline scientific evidence changed before commit");
  }
}
