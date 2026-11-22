import type { DB } from "@aerodb/db/client";
import { resultAttempts } from "@aerodb/db/schema";
import { and, inArray, isNotNull } from "drizzle-orm";
import {
  hydrateAttemptEvidence,
  hydrateAttemptEvidenceBatch,
  type AttemptEvidenceReadRow,
  type AttemptEvidenceReadOptions,
} from "@aerodb/db/attempt-evidence-reader";
import { AttemptEvidenceStore } from "./attempt-evidence-store";
import { createAttemptServerDependencyVerifier } from "@aerodb/db/attempt-evidence-dependency-verifier";

let reader: AttemptEvidenceStore | undefined;

function sourceReader() {
  return {
    read(
      identity: Parameters<AttemptEvidenceStore["read"]>[0],
      signal?: AbortSignal,
    ) {
      const bucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
      if (
        !bucket ||
        identity.bucket !== bucket ||
        process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver"
      )
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
      })
      .from(resultAttempts)
      .where(
        and(
          inArray(resultAttempts.id, ids.slice(offset, offset + 32)),
          isNotNull(resultAttempts.evidenceArchiveId),
        ),
      );
    if (cold.length === 0) continue;
    const restored = await hydrateAttemptEvidenceBatch(
      db,
      sourceReader(),
      cold.map((row) => ({ ...row, evidencePayload: null as unknown })),
      { signal: AbortSignal.timeout(30_000) },
    );
    for (const row of restored) prepared.set(row.id, row);
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
  return createAttemptServerDependencyVerifier(db, sourceReader());
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
  return hydrateAttemptEvidence(db, sourceReader(), row, {
    ...options,
    signal,
  });
}
