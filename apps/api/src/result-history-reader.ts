import { Storage } from "@google-cloud/storage";
import { ResultHistoryGcsStore } from "@aerodb/core/result-history-storage";
import {
  hydrateResultHistories,
  type ResultHistoryRow,
} from "@aerodb/db/result-history-storage";
import type { DB } from "@aerodb/db/client";
import { env } from "./env";
import { readHzPointHistory } from "./hz-point-history-reader";
import type {
  ResultHistoryArchiveIdentity,
  ResultHistoryEnvelope,
} from "@aerodb/core/result-history-storage";

let store: ResultHistoryGcsStore | undefined;

/** Both result rows and selected-attempt field reads use the role's verified
 * 0206 transport. The caller supplies a catalog identity from its owning row. */
export async function readStoredResultHistory(
  db: DB,
  identity: ResultHistoryArchiveIdentity,
  signal?: AbortSignal,
): Promise<ResultHistoryEnvelope> {
  signal?.throwIfAborted();
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver")
    return readHzPointHistory(db, identity) as Promise<ResultHistoryEnvelope>;
  if (!env.evidenceBucket || identity.bucket !== env.evidenceBucket.trim())
    throw new Error("Result history archive bucket is not configured");
  store ??= new ResultHistoryGcsStore(new Storage());
  return store.read(identity, signal);
}

export function readStoredResultHistories<T extends ResultHistoryRow>(
  db: DB,
  row: T,
): Promise<T> {
  return hydrateResultHistories(
    db,
    { read: (id) => readStoredResultHistory(db, id) },
    row,
  );
}
