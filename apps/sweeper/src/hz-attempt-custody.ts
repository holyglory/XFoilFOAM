import { limitSettledReportCandidates } from "./hz-settled-report-bounds";
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";
import {
  checkHzTransferFence,
  withActiveHzTransfer,
  type HzWorkerOwner,
} from "./hz-attempt-transfer-fence";
import { ProgressiveWorkerReplayNeedsFinalReport, ProgressiveWorkerTransferPaused } from "./progressive-worker-outbox-replay";
import { readSettledWorkerPoint, settledWorkerScope, type HzSettledReceiptScope } from "./hz-settled-attempt-receipt";
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
import {
  createAttemptServerDependencyVerifier,
  storedJobDecisionSha256,
} from "@aerodb/db/attempt-evidence-dependency-verifier";
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
export function sameArchive(
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
  retained = false,
  settled = false,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 64)
    throw Error("Invalid page size");
  const rows = await db.execute(sql`WITH keys AS MATERIALIZED (
  SELECT DISTINCT a.id FROM progressive_worker_hub_receipts h JOIN result_attempts a ON a.id=h.result_attempt_id WHERE h.result_attempt_id>${exactId(after)}::uuid AND h.result_attempt_id<=${exactId(high)}::uuid
   AND ${retained ? sql`a.status IN ('done','failed') AND h.receipt->>'kind'='retained-progressive-attempt'` : sql`a.status='done' AND a.regime='rans'`} AND h.receipt->'storageOnly' IN ('true'::jsonb,${retained ? sql`'false'::jsonb` : sql`'true'::jsonb`})
  ORDER BY a.id LIMIT ${limit})
 SELECT k.id::text AS id,a.evidence_archive_id::text AS archive, e.app_readback_at IS NULL AND a.evidence_archive_id IS NOT NULL AS pending,
 CASE WHEN a.evidence_archive_id IS NULL THEN ${workerAttemptLimiter(sql`k.id`, retained, settled)} END AS limiter,
 pg_column_size(a.evidence_payload) AS stored,CASE WHEN a.evidence_archive_id IS NULL AND pg_column_size(a.evidence_payload)<=${settled ? 8388608 : 262144} THEN octet_length(a.evidence_payload::text)-octet_length(attempt_evidence_compact(a.evidence_payload)::text) END AS logical
 FROM keys k JOIN result_attempts a ON a.id=k.id LEFT JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id ORDER BY k.id`);
  return settled ? limitSettledReportCandidates(db, rows) : rows;
}
export function workerAttemptLimiter(id: ReturnType<typeof sql>, retained: boolean, settled: boolean) {
  if (settled) return sql`attempt_evidence_hz_supported_limiter(${id})`;
  return retained ? sql`attempt_evidence_hz_retained_limiter(${id})` : sql`attempt_evidence_hz_limiter(${id})`;
}
/** The only worker mode enabled by this operator is the separately gated 0212 cohort. */
export async function enableHzCustody(db: DB, retained = false, settled = false) {
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
  if (retained) {
    const [ready] =
      await db.execute(sql`UPDATE attempt_evidence_storage_policy SET hz_retained_enabled=true WHERE id=1 AND NOT hz_retained_enabled AND hz_worker_only AND shortening_enabled AND consumer_contract_version=1
      AND progressive_source_scope='legacy' AND EXISTS(SELECT FROM sync_api_settings WHERE id=1 AND remote_solver_enabled AND remote_solver_registered_id IS NOT NULL) RETURNING id`);
    if (!ready) {
      const [enabled] =
        await db.execute(sql`SELECT hz_retained_enabled AND hz_worker_only AND shortening_enabled AND consumer_contract_version=1 AND progressive_source_scope='legacy' AS ready
        FROM attempt_evidence_storage_policy WHERE id=1`);
      if (enabled?.ready !== true)
        throw Error("Worker retained-source policy unavailable");
    }
  }
  if (settled) {
    const [policy] = await db.execute(sql`UPDATE attempt_evidence_storage_policy SET hz_settled_receipts_enabled=true
      WHERE id=1 AND hz_retained_enabled AND NOT hz_settled_receipts_enabled RETURNING id`);
    if (!policy) {
      const [enabled] = await db.execute(sql`SELECT hz_settled_receipts_enabled AS ready FROM attempt_evidence_storage_policy WHERE id=1`);
      if (enabled?.ready !== true) throw Error("Worker settled-receipt policy unavailable");
    }
  }
}
export async function prepareHzEnvelope(db: DB, id: string, retained = false, settled = false) {
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
    sql`SELECT ${workerAttemptLimiter(sql`${id}::uuid`, retained, settled)} AS reason`,
  );
  if (condition?.reason !== null)
    return { limited: String(condition?.reason ?? "missing") };
  if (settled) {
    const scope = await settledWorkerScope(db, id);
    if (scope) {
      const { archive } = await readSettledWorkerPoint(db, scope, AbortSignal.timeout(30_000));
      return { archive, cold: false };
    }
  }
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
  return {
    instance: witness.instance,
    solver: witness.solver,
    ...(await packHzAttemptSource(source)),
    cold: false,
  };
}

/** The same native 0207 document is used by archive-only and shortening. */
export async function packHzAttemptSource(
  source: Awaited<ReturnType<typeof loadSettledAttemptEvidenceCopy>>,
) {
  const dir = await mkdtemp(join(tmpdir(), "hz-attempt-"));
  try {
    const path = join(dir, "original.gz"),
      proof = await writeAttemptEvidenceCopy(path, source);
    return { proof, packed: (await readFile(path)).toString("base64") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function stageHzEnvelope(
  db: DB,
  identity: AttemptEvidenceArchiveIdentity,
  bytes: Buffer,
  expected?: HzWorkerOwner,
  enable?: { retained: boolean; settled?: boolean },
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
  const plan = prepareAttemptEvidenceCopy(original);
  return withActiveHzTransfer(db, expected, async (tx) => {
    const result = await registerAttemptEvidenceArchive(tx, identity, plan);
    sameArchive(result.archive, identity);
    if (enable) await enableHzCustody(tx, enable.retained, enable.settled);
    return result.archive;
  });
}
export async function hzScience(db: DB, id: string, archiveId: string) {
  const archive = await getAttemptEvidenceArchive(db, archiveId);
  const { payloadText } = await readHzAttemptWorkingCopy(archive);
  const verify = createAttemptServerDependencyVerifier(
    db,
    sweeperAttemptArchiveReader(),
    async (attempt, original) => {
      const [bound] = await db.execute(
        sql`SELECT attempt_evidence_hz_scope(${attempt}::uuid) AS scope`,
      );
      if (!bound?.scope) throw Error("Worker custody scope changed");
      const scope = bound.scope as Record<string, unknown>;
      const replay = scope.contract === "settled-receipt-v3"
        ? await readSettledWorkerPoint(db, bound.scope as HzSettledReceiptScope, AbortSignal.timeout(30_000))
        : await readHzAttemptFromWorkerReport(db, attempt, AbortSignal.timeout(30_000));
      if (replay.payloadText !== original)
        throw Error("Signed worker report differs from original");
      return scope;
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
    contract?: string;
    stopSequence?: number;
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
  ).catch((error) => {
    if (error instanceof ProgressiveWorkerReplayNeedsFinalReport && scope.contract === "settled-receipt-v3"
        && Number(scope.stopSequence) > scope.sequence)
      return null;
    if (error instanceof ProgressiveWorkerTransferPaused)
      throw new HistoryOperationError(
        "worker_transfer_paused",
        "transfer_paused",
        true,
      );
    throw error;
  });
  // A previously delivered running snapshot is still ineligible for the
  // final-only requeue command. Its actual point and terminal signatures are
  // independently checked in the scientific source read.
  if (preview === null) return { replayDisposition: "nonfinal-already-received" };
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
  expected?: HzWorkerOwner,
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
  const [event] = await db.execute(
    sql`SELECT e.verification->'dependencies' AS deps FROM attempt_evidence_storage_events e WHERE e.id=${eventId}::uuid AND e.result_attempt_id=${id}::uuid AND e.archive_id=${app.archiveId}::uuid`,
  );
  const deps = event?.deps as
    | {
        verifier?: string;
        jobDecisionsSha256?: string;
        workerScope?: HzSettledReceiptScope | { selectionSha256?: string };
      }
    | undefined;
  if (deps?.verifier === "server-consumers/hz-retained-original-v2" || deps?.verifier === "server-consumers/hz-settled-receipt-v3") {
    if (deps.verifier === "server-consumers/hz-settled-receipt-v3") {
      const source = deps.workerScope;
      if (!source || !("contract" in source) || source.contract !== "settled-receipt-v3")
        throw Error("Missing sealed worker receipt");
      const signed = await readSettledWorkerPoint(db, source, AbortSignal.timeout(30_000));
      if (signed.payloadText !== text) throw Error("Stored attempt differs from the acknowledged signed point");
    }
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      await tx.execute(sql`SET LOCAL statement_timeout='8s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='1s'`);
      await checkHzTransferFence(tx, expected, true);
      await tx.execute(sql`SELECT attempt_evidence_lock_source(${id}::uuid)`);
      if (deps.verifier === "server-consumers/hz-settled-receipt-v3") {
        const [unchanged] = await tx.execute(sql`SELECT attempt_evidence_hz_settled_scope(${id}::uuid,${app.archiveId}::uuid)
          = ${JSON.stringify(deps.workerScope)}::jsonb AS verified`);
        if (unchanged?.verified !== true) throw Error("Worker receipt, assignment or selected evidence changed");
      }
      const [selection] = await tx.execute(
        sql`SELECT attempt_evidence_hz_selection_sha256(${id}::uuid) AS sha`,
      );
      if (
        selection?.sha !== deps.workerScope?.selectionSha256 ||
        (await storedJobDecisionSha256(tx, id, deps.verifier === "server-consumers/hz-settled-receipt-v3")) !== deps.jobDecisionsSha256
      )
        throw Error(
          "Stored worker classification, selection, interpretation or fit changed",
        );
      await tx.execute(
        sql`SELECT set_config('airfoilfoam.hz_retained_post_readback',${JSON.stringify({ event: eventId, source: app.sourceSha256, decisions: deps.jobDecisionsSha256, selection: selection.sha })},true)`,
      );
      await confirmAttemptEvidenceReadback(tx, eventId, {
        ...app,
        payloadText: text,
      });
    });
    return;
  }
  await withActiveHzTransfer(db, expected, (tx) =>
    confirmAttemptEvidenceReadback(tx, eventId, {
      ...app,
      payloadText: text,
    }),
  );
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
