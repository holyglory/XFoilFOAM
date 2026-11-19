import type { DB } from "@aerodb/db/client";
import {
  getSolverHistoryArchive,
  loadSolverHistorySource,
  registerSolverHistoryArchive,
  forceHistoryArchiveForRow,
  offloadForceHistoryArrays,
} from "@aerodb/db/solver-history-storage";
import {
  compareSolverHistoryRaw,
  type SolverHistoryArchiveIdentity,
  type SolverHistoryEnvelope,
  type SolverHistoryKind,
  type SolverHistorySource,
} from "@aerodb/core/solver-history-storage";

export interface SolverHistoryArchiveStore {
  put(bucket: string, sourceInstance: string, source: SolverHistorySource): Promise<SolverHistoryArchiveIdentity>;
  read(identity: SolverHistoryArchiveIdentity): Promise<SolverHistoryEnvelope>;
}

/** Online offload of the four force-history arrays only. Point metadata and
 * result_attempts payloads remain untouched. Verification never constructs a
 * polar or changes physical eligibility. */
export async function archiveSolverHistory(
  db: DB,
  store: SolverHistoryArchiveStore,
  input: {
    bucket: string; sourceInstance: string; sourceKind: SolverHistoryKind; sourceId: string;
    // Exact bytes of an authenticated raw archive member, if available. Raw
    // provenance/authentication is an operator prerequisite, not guessed here.
    existingRawMember?: Buffer;
  },
) {
  const prior = await forceHistoryArchiveForRow(db, input.sourceId);
  if (prior) {
    await store.read(prior);
    return { archive: prior, rawComparison: { status: "unavailable" as const, byteIdentical: null },
      inlineRetained: false as const, offloaded: false, sourceBytes: 0 };
  }
  const source = await loadSolverHistorySource(db, input.sourceKind, input.sourceId);
  const arrays = JSON.parse(source.payloadText) as Record<string, unknown>;
  if (![arrays.t, arrays.cl, arrays.cd].every(Array.isArray) || (arrays.cm !== null && !Array.isArray(arrays.cm)))
    throw new Error("Malformed force-history arrays remain inline");
  const rawComparison = input.existingRawMember
    ? { status: "compared" as const, ...compareSolverHistoryRaw(source, input.existingRawMember) }
    : { status: "unavailable" as const, byteIdentical: null };
  const identity = await store.put(input.bucket, input.sourceInstance, source);
  const restored = await store.read(identity);
  // A store implementation must restore the exact source and stable owner,
  // not merely return success or a matching object metadata checksum.
  if (restored.sourceInstance !== input.sourceInstance ||
      restored.sourceKind !== source.sourceKind || restored.sourceId !== source.sourceId ||
      restored.resultId !== source.resultId || restored.resultAttemptId !== source.resultAttemptId ||
      restored.payloadText !== source.payloadText)
    throw new Error("Solver history restore differs from the exact PostgreSQL source");
  const record = await registerSolverHistoryArchive(db, identity);
  // If a restart/race reused an existing catalog entry, verify THAT recorded
  // generation too. The newly uploaded generation is not a substitute for it.
  const recorded = await store.read(record);
  if (recorded.payloadText !== source.payloadText)
    throw new Error("Recorded solver history archive differs from the source");
  const offload = await offloadForceHistoryArrays(db, record);
  return { archive: record, rawComparison, inlineRetained: !offload.offloaded, ...offload };
}

export async function restoreSolverHistory(db: DB, store: SolverHistoryArchiveStore, archiveId: string) {
  const identity = await getSolverHistoryArchive(db, archiveId);
  return store.read(identity);
}
