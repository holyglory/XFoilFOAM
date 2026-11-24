import type { DB } from "@aerodb/db/client";
import { readCanonicalSubtree, storedCanonicalSubtree } from "@aerodb/db/result-history-subtrees";
import {
  getResultHistoryArchive,
  loadResultHistorySource,
  offloadResultHistory,
  registerResultHistoryArchive,
  resultHistoryArchiveForRow,
} from "@aerodb/db/result-history-storage";
import {
  resultHistorySha256,
  type ResultHistoryArchiveIdentity,
  type ResultHistoryArchiveStore,
  type ResultHistoryEnvelope,
  type ResultHistoryKind,
  type ResultHistorySource,
} from "@aerodb/core/result-history-storage";

function exactSource(
  restored: ResultHistoryEnvelope,
  identity: ResultHistoryArchiveIdentity,
  source: ResultHistorySource,
) {
  if (
    restored.sourceInstance !== identity.sourceInstance ||
    restored.sourceKind !== source.sourceKind ||
    restored.resultId !== source.resultId ||
    restored.resultAttemptId !== source.resultAttemptId ||
    restored.payloadText !== source.payloadText ||
    Buffer.byteLength(restored.payloadText) !== identity.sourceByteSize ||
    resultHistorySha256(Buffer.from(restored.payloadText)) !==
      identity.sourceSha256
  )
    throw new Error(
      "Result history restore differs from its exact PostgreSQL source",
    );
}

/** Only the two canonical history columns change representation. The producing
 * attempt, coefficients, polar caches and classification are never mutated. */
export async function archiveResultHistory(
  db: DB,
  store: ResultHistoryArchiveStore,
  input: {
    bucket: string;
    sourceInstance: string;
    resultId: string;
    sourceKind: ResultHistoryKind;
  },
) {
  const prior = await resultHistoryArchiveForRow(
    db,
    input.resultId,
    input.sourceKind,
  );
  if (prior) {
    await store.read(prior);
    return {
      offloaded: false,
      retainedSmall: false,
      sourceBytes: 0,
      archive: prior,
    };
  }
  const reference=await storedCanonicalSubtree(db,input.resultId,input.sourceKind);
  if (reference) {
    const {sweeperAttemptArchiveReader}=await import("./attempt-evidence-consumer-reader");
    const field=await readCanonicalSubtree(db,sweeperAttemptArchiveReader(),input.resultId,input.sourceKind,reference.ref);
    if(!field) throw new Error("Canonical history changed while verifying its attempt source");
    return {offloaded:false,retainedSmall:false,sourceBytes:0,archive:null,subtreeReference:field.reference};
  }
  const source = await loadResultHistorySource(
    db,
    input.resultId,
    input.sourceKind,
  );
  const size = Buffer.byteLength(source.payloadText);
  if (size < 4096 || size - source.compactByteSize < 1024)
    return {
      offloaded: false,
      retainedSmall: true,
      sourceBytes: 0,
      archive: null,
    };
  const identity = await store.put(input.bucket, input.sourceInstance, source);
  if (
    identity.sourceInstance !== input.sourceInstance ||
    identity.sourceKind !== source.sourceKind ||
    identity.resultId !== source.resultId ||
    identity.resultAttemptId !== source.resultAttemptId
  )
    throw new Error("Result history upload returned a different source owner");
  exactSource(await store.read(identity), identity, source);
  const archive = await registerResultHistoryArchive(db, identity);
  // A previous crash can have registered another exact generation. Restore
  // THAT recorded generation immediately before the atomic source comparison.
  exactSource(await store.read(archive), archive, source);
  const offloaded = await offloadResultHistory(db, archive);
  return {
    offloaded,
    retainedSmall: false,
    sourceBytes: offloaded ? size : 0,
    archive,
  };
}

export async function restoreResultHistory(
  db: DB,
  store: ResultHistoryArchiveStore,
  archiveId: string,
) {
  return store.read(await getResultHistoryArchive(db, archiveId));
}
