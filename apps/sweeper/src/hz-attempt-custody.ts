import { replayProgressiveWorkerOutbox } from "./progressive-worker-outbox-replay";
import {
  loadAttemptSourcePins,
  prepareAttemptSources,
} from "@aerodb/db/attempt-receipt-source";
import {
  preparePublicationHistories,
  publicationHistoryJoin,
  publicationHistoryPayload,
} from "./attempt-publication-history";
import { createAttemptServerDependencyVerifier } from "@aerodb/db/attempt-evidence-dependency-verifier";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import {
  findAttemptEvidenceArchive,
  getAttemptEvidenceArchive,
  registerAttemptEvidenceArchive,
  type AttemptEvidenceArchiveIdentity,
} from "@aerodb/db/attempt-evidence-catalog";
import {
  loadSettledAttemptEvidenceCopy,
  prepareAttemptEvidenceCopy,
} from "@aerodb/db/attempt-evidence-storage";
import {
  confirmAttemptEvidenceReadback,
  getAttemptEvidenceStorage,
  prepareAttemptEvidenceProjection,
  restoreAttemptEvidence,
  shortenAttemptEvidence,
  type AttemptEvidenceAppReadback,
  type AttemptEvidenceFreshVerification,
} from "@aerodb/db/attempt-evidence-projection";
import { readAttemptEvidenceText } from "@aerodb/db/attempt-evidence-reader";
import { readHzAttemptFromWorkerReport } from "./hz-attempt-report-reader";
import { sweeperAttemptArchiveReader } from "./attempt-evidence-consumer-reader";
import {
  readHzAttemptWorkingCopy,
  retainHzAttemptVolume,
} from "./hz-attempt-volume";
import { writeAttemptEvidenceCopy } from "./attempt-evidence-archive";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readAttemptEvidenceCopy } from "./attempt-evidence-archive";
import { Readable } from "node:stream";
import { reportTextIdentity } from "@aerodb/db/progressive-report-archive";

export const ZERO_ID = "00000000-0000-0000-0000-000000000000";
export function exactId(id: unknown): string {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    throw Error("Invalid attempt identifier");
  return id.toLowerCase();
}
export function packedBytes(value: unknown) {
  if (typeof value !== "string" || !value.length || value.length > 1400000)
    throw Error("Attempt transfer size exceeded");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > 1048576)
    throw Error("Invalid packed attempt");
  return bytes;
}
function sameArchive(
  a: AttemptEvidenceArchiveIdentity,
  b: AttemptEvidenceArchiveIdentity,
) {
  for (const k of [
    "sourceInstance",
    "attemptId",
    "resultId",
    "simJobId",
    "sourceSha256",
    "sourceByteSize",
    "storedSha256",
    "storedByteSize",
    "envelopeSha256",
    "envelopeByteSize",
    "crc32c",
    "generation",
    "objectKey",
    "bucket",
  ] as const)
    if (a[k] !== b[k]) throw Error("Registered HZ envelope identity differs");
}
export async function attemptPage(
  db: DB,
  after: string,
  high: string,
  limit: number,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64)
    throw Error("Invalid page size");
  return db.execute(sql`WITH keys AS MATERIALIZED (
  SELECT DISTINCT a.id FROM progressive_worker_hub_receipts h JOIN result_attempts a ON a.id=h.result_attempt_id WHERE a.id>${exactId(after)}::uuid AND a.id<=${exactId(high)}::uuid
   AND a.status='done' AND a.regime='rans' AND h.receipt->'storageOnly'='true'::jsonb
  ORDER BY a.id LIMIT ${limit})
 SELECT k.id::text AS id,a.evidence_archive_id::text AS archive, e.app_readback_at IS NULL AND a.evidence_archive_id IS NOT NULL AS pending,
 CASE WHEN a.evidence_archive_id IS NULL THEN attempt_evidence_hz_limiter(k.id) END AS limiter,
 pg_column_size(a.evidence_payload) AS stored,CASE WHEN a.evidence_archive_id IS NULL AND pg_column_size(a.evidence_payload)<=262144 THEN octet_length(a.evidence_payload::text)-octet_length(attempt_evidence_compact(a.evidence_payload)::text) END AS logical
 FROM keys k JOIN result_attempts a ON a.id=k.id LEFT JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id ORDER BY k.id`);
}
/** The only worker mode enabled by this operator is the separately gated 0212 cohort. */
export async function enableHzCustody(db: DB) {
  const changed =
    await db.execute(sql`UPDATE attempt_evidence_storage_policy p SET hz_worker_only=true,shortening_enabled=true,consumer_contract_version=1
   WHERE id=1 AND NOT shortening_enabled AND NOT stopped_progressive_enabled AND progressive_source_scope='legacy'
   AND EXISTS(SELECT FROM sync_api_settings s WHERE s.id=1 AND s.remote_solver_registered_id IS NOT NULL AND s.upstream_base_url IS NOT NULL)
   RETURNING id`);
  if (!changed.length) {
    const [cfg] = await db.execute(
      sql`SELECT shortening_enabled AND hz_worker_only AND NOT stopped_progressive_enabled AND progressive_source_scope='legacy' AS ready FROM attempt_evidence_storage_policy WHERE id=1`,
    );
    if (cfg?.ready !== true)
      throw Error("A different attempt policy is active");
  }
}
export async function prepareHzEnvelope(db: DB, id: string) {
  const [pointer] = await db.execute(
    sql`SELECT evidence_archive_id AS archive,evidence_storage_event_id AS event FROM result_attempts WHERE id=${id}::uuid`,
  );
  if (!pointer) throw Error("Missing attempt");
  if (pointer.archive)
    return {
      archive: await getAttemptEvidenceArchive(db, String(pointer.archive)),
      cold: true,
      eventId: String(pointer.event),
    };
  const [condition] = await db.execute(
    sql`SELECT attempt_evidence_hz_limiter(${id}::uuid) AS reason`,
  );
  if (condition?.reason !== null)
    return { limited: String(condition?.reason ?? "missing") };
  const source = await loadSettledAttemptEvidenceCopy(db, id);
  const { payloadText, witness } = await readHzAttemptFromWorkerReport(
    db,
    id,
    AbortSignal.timeout(30000),
  );
  if (source.payloadText !== payloadText)
    throw Error("Worker report source differs");
  const existing = await findAttemptEvidenceArchive(
    db,
    witness.instance,
    source,
    witness.sha256,
  );
  if (existing) return { archive: existing, cold: false };
  const dir = await mkdtemp(join(tmpdir(), "hz-attempt-"));
  try {
    const path = join(dir, "original.gz"),
      proof = await writeAttemptEvidenceCopy(path, source);
    return {
      instance: witness.instance,
      solver: witness.solver,
      proof,
      packed: (await readFile(path)).toString("base64"),
      cold: false,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function stageHzEnvelope(
  db: DB,
  identity: AttemptEvidenceArchiveIdentity,
  bytes: Buffer,
) {
  const original = await retainHzAttemptVolume(db, identity, bytes);
  const stored = await getAttemptEvidenceStorage(db, identity.attemptId);
  if (!stored) throw Error("Missing source");
  if (stored.state === "archived") {
    sameArchive(stored.archive, identity);
    return stored.archive;
  }
  if (stored.inlinePayloadText !== original.payloadText)
    throw Error("Fresh GCS generation differs from HZ SQL");
  const result = await registerAttemptEvidenceArchive(
    db,
    identity,
    prepareAttemptEvidenceCopy(original),
  );
  sameArchive(result.archive, identity);
  return result.archive;
}
export async function hzScience(db: DB, id: string, archiveId: string) {
  const archive = await getAttemptEvidenceArchive(db, archiveId);
  const { payloadText } = await readHzAttemptWorkingCopy(archive);
  const verify = createAttemptServerDependencyVerifier(
    db,
    sweeperAttemptArchiveReader(),
    async (attempt, original) => {
      const replay = await readHzAttemptFromWorkerReport(
        db,
        attempt,
        AbortSignal.timeout(30000),
      );
      if (replay.payloadText !== original)
        throw Error("Signed worker report differs from original");
      const [bound] = await db.execute(
        sql`SELECT attempt_evidence_hz_scope(${attempt}::uuid) AS scope`,
      );
      if (!bound?.scope) throw Error("Worker custody scope changed");
      return bound.scope as Record<string, unknown>;
    },
  );
  return verify({
    attemptId: id,
    archive,
    originalPayloadText: payloadText,
    preview: await prepareAttemptEvidenceProjection(db, id, archive.id),
  });
}
export async function commitHzAttempt(
  db: DB,
  id: string,
  archiveId: string,
  proof: AttemptEvidenceFreshVerification,
) {
  return shortenAttemptEvidence(db, id, archiveId, proof);
}
export async function verifyHzOutboxReplay(db: DB, id: string) {
  const [owner] =
    await db.execute(sql`SELECT CASE WHEN a.evidence_archive_id IS NULL THEN attempt_evidence_hz_scope(a.id)
      ELSE e.verification#>'{dependencies,workerScope}' END AS scope
    FROM result_attempts a LEFT JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id AND e.archive_id=a.evidence_archive_id
    WHERE a.id=${id}::uuid`);
  const scope = owner?.scope as {
    job: string;
    point: string;
    sequence: number;
    attempt: string;
  } | null;
  if (!scope || scope.attempt !== id)
    throw Error("Worker replay owner differs");
  const preview = await replayProgressiveWorkerOutbox(
    db,
    {
      executionId: scope.job,
      expectedCount: 1,
      points: [
        {
          sequence: scope.sequence,
          resultAttemptId: id,
          pointContentSignature: scope.point,
        },
      ],
    },
    { apply: false },
  );
  if (
    preview.points.length !== 1 ||
    preview.points[0]?.outcome !== "already_delivered"
  )
    throw Error("Worker replay changed its delivery outcome");
  return { alreadyDelivered: true };
}
export async function confirmHzAttempt(
  db: DB,
  id: string,
  eventId: string,
  app: Omit<AttemptEvidenceAppReadback, "payloadText">,
) {
  const stored = await getAttemptEvidenceStorage(db, id);
  if (
    stored?.state !== "archived" ||
    stored.storageEventId !== eventId ||
    app.source !== "worker-volume" ||
    app.attemptId !== id ||
    app.archiveId !== stored.archive.id
  )
    throw Error("Changed HZ readback owner");
  const text = await readAttemptEvidenceText(
    db,
    sweeperAttemptArchiveReader(),
    id,
    {
      requireArchiveRead: true,
      archiveId: app.archiveId,
      signal: AbortSignal.timeout(30000),
    },
  );
  const actual = reportTextIdentity(text);
  if (
    app.sourceSha256 !== actual.sha256 ||
    app.sourceByteSize !== actual.byteSize
  )
    throw Error("Sweeper and API originals differ");
  // Exercise the receipt-bearing 0211 restart/fitting preparation and the
  // canonical repair SQL. Both must return the native HZ original.
  const pins = await loadAttemptSourcePins(db, [id]);
  const prepared = await prepareAttemptSources(
    db,
    sweeperAttemptArchiveReader(),
    [...pins.values()],
    { signal: AbortSignal.timeout(30000) },
  );
  if (prepared.get(id)?.payloadText !== text)
    throw Error("Pinned replay source differs");
  const docs = await preparePublicationHistories(db, sql`a.id=${id}::uuid`);
  const [published] =
    await db.execute(sql`SELECT (${publicationHistoryPayload(sql`a`)})::text AS original FROM result_attempts a
    ${publicationHistoryJoin(sql`a`, docs)} WHERE a.id=${id}::uuid`);
  if (published?.original !== text)
    throw Error("Canonical repair projection differs");
  await confirmAttemptEvidenceReadback(db, eventId, {
    ...app,
    payloadText: text,
  });
}
export async function restoreHzAttempt(
  db: DB,
  id: string,
  archiveId: string,
  eventId: string,
  identity: AttemptEvidenceArchiveIdentity,
  packed: Buffer,
  pending: boolean,
) {
  const archive = await getAttemptEvidenceArchive(db, archiveId);
  sameArchive(archive, identity);
  const original = await readAttemptEvidenceCopy(
    Readable.from([packed]),
    archive,
  );
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout='1s'`);
    await tx.execute(sql`SELECT attempt_evidence_lock_source(${id}::uuid)`);
    const [stored] = await tx.execute(
      sql`SELECT evidence_archive_id,evidence_storage_event_id FROM result_attempts WHERE id=${id}::uuid`,
    );
    if (
      stored?.evidence_archive_id !== archiveId ||
      stored.evidence_storage_event_id !== eventId
    )
      throw Error("Restore event changed");
    return restoreAttemptEvidence(
      tx as unknown as DB,
      id,
      archiveId,
      original.payloadText,
      "HZ operator restored verified original",
      pending ? eventId : undefined,
    );
  });
}
