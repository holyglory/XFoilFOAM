import type { DB } from "@aerodb/db/client";
import {
  attemptEvidenceStorageEvents,
  resultAttempts,
} from "@aerodb/db/schema";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  hydrateAttemptEvidence,
  hydrateAttemptEvidenceBatch,
  readAttemptEvidenceText,
  type AttemptEvidenceReadRow,
  type AttemptEvidenceReadOptions,
} from "@aerodb/db/attempt-evidence-reader";
import { AttemptEvidenceStore } from "./attempt-evidence-store";
import { createAttemptServerDependencyVerifier } from "@aerodb/db/attempt-evidence-dependency-verifier";

let reader: AttemptEvidenceStore | undefined;

/** Use PostgreSQL's original text when a SQL projection copies history fields.
 * Parsing and re-encoding the document in JavaScript can round numeric tokens. */
export function readOriginalAttemptForProjection(db: DB, id: string, archiveId: string): Promise<string> {
  return readAttemptEvidenceText(db, sweeperAttemptArchiveReader(), id, {
    archiveId,
    requireArchiveRead: true,
    signal: AbortSignal.timeout(30_000),
  });
}

export function sweeperAttemptArchiveReader() {
  return {
    async read(
      identity: Parameters<AttemptEvidenceStore["read"]>[0],
      signal?: AbortSignal,
    ) {
      if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver") {
        const { readHzAttemptWorkingCopy } =
          await import("./hz-attempt-volume");
        return readHzAttemptWorkingCopy(identity, signal);
      }
      const bucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
      if (!bucket || identity.bucket !== bucket)
        throw new Error(
          "Attempt evidence source archive is unavailable on this solver",
        );
      reader ??= new AttemptEvidenceStore();
      return reader.read(identity, signal);
    },
  };
}

/** Fetch only cold candidates and observed current attempts, before taking
 * publication locks. The inline path transfers only index keys on this lookup. */
export async function prepareAttemptPublicationEvidence(
  db: DB,
  attemptIds: readonly (string | null)[],
): Promise<ReadonlyMap<string, AttemptEvidenceReadRow>> {
  const ids = [
    ...new Set(attemptIds.filter((id): id is string => id !== null)),
  ];
  const prepared = new Map<string, AttemptEvidenceReadRow>();
  for (let offset = 0; offset < ids.length; offset += 32) {
    const cold = await db
      .select({
        id: resultAttempts.id,
        resultId: resultAttempts.resultId,
        simJobId: resultAttempts.simJobId,
        evidenceArchiveId: resultAttempts.evidenceArchiveId,
        stoppedReceipt: sql<boolean>`${attemptEvidenceStorageEvents.verification}#>>'{dependencies,verifier}'='server-consumers/stopped-progressive-rans-v1'`,
      })
      .from(resultAttempts)
      .innerJoin(
        attemptEvidenceStorageEvents,
        and(
          eq(
            attemptEvidenceStorageEvents.id,
            resultAttempts.evidenceStorageEventId,
          ),
          eq(attemptEvidenceStorageEvents.resultAttemptId, resultAttempts.id),
          eq(
            attemptEvidenceStorageEvents.archiveId,
            resultAttempts.evidenceArchiveId,
          ),
          eq(attemptEvidenceStorageEvents.action, "shorten"),
          eq(attemptEvidenceStorageEvents.completed, true),
        ),
      )
      .where(
        and(
          inArray(resultAttempts.id, ids.slice(offset, offset + 32)),
          isNotNull(resultAttempts.evidenceArchiveId),
        ),
      );
    if (cold.length === 0) continue;
    const restored = await hydrateAttemptEvidenceBatch(
      db,
      sweeperAttemptArchiveReader(),
      cold.map((row) => ({ ...row, evidencePayload: null as unknown })),
      { signal: AbortSignal.timeout(30_000) },
    );
    for (const row of restored) {
      // A closed progressive source re-entering publication must supply full
      // history to subsequent SQL reprojection of its selected result. Only
      // this cohort proved that this JSON round-trip preserves exact PG text.
      // Acquire the ordinary job/cell/attempt locks before publication starts.
      if (row.stoppedReceipt)
        await db.execute(sql`SELECT attempt_evidence_restore(a.id,e.archive_id,(${JSON.stringify(row.evidencePayload)}::jsonb)::text,
        'original required for result publication')
        FROM result_attempts a JOIN attempt_evidence_storage_events e
          ON e.id=a.evidence_storage_event_id AND e.result_attempt_id=a.id AND e.archive_id=a.evidence_archive_id
        WHERE a.id=${row.id}::uuid AND a.result_id=${row.resultId}::uuid AND a.sim_job_id IS NOT DISTINCT FROM ${row.simJobId}::uuid
          AND e.archive_id=${row.evidenceArchiveId}::uuid AND e.action='shorten' AND e.completed
          AND e.verification#>>'{dependencies,verifier}'='server-consumers/stopped-progressive-rans-v1'`);
      prepared.set(row.id, row);
    }
  }
  return prepared;
}

/** The transaction rechecks the exact owner and pointer. If the candidate
 * became cold after preparation, the caller must retry from a fresh snapshot. */
export function publicationAttemptPayload(
  row: AttemptEvidenceReadRow,
  prepared: ReadonlyMap<string, AttemptEvidenceReadRow>,
): unknown {
  if (row.evidenceArchiveId === null) return row.evidencePayload;
  const full = prepared.get(row.id);
  if (
    !full ||
    !row.evidenceArchiveId ||
    full.evidenceArchiveId !== row.evidenceArchiveId ||
    full.resultId !== row.resultId ||
    full.simJobId !== row.simJobId
  )
    throw new Error(
      "Attempt archive owner or generation changed before publication",
    );
  return full.evidencePayload;
}

/** Galileo's writer uses this proof after upload/API readback and before its
 * final locked source/dependency recheck. It performs no removal itself. */
export function sweeperAttemptEvidenceDependencyVerifier(db: DB) {
  return createAttemptServerDependencyVerifier(db, sweeperAttemptArchiveReader());
}

/** Call at a bounded preparation boundary, before opening publication/write
 * transactions. Metadata-only SQL consumers must use the verified facts. */
export function readSweeperAttemptEvidence<T extends AttemptEvidenceReadRow>(
  db: DB,
  row: T,
  options: AttemptEvidenceReadOptions = {},
): Promise<T> {
  const deadline = AbortSignal.timeout(30_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline])
    : deadline;
  return hydrateAttemptEvidence(db, sweeperAttemptArchiveReader(), row, {
    ...options,
    signal,
  });
}
