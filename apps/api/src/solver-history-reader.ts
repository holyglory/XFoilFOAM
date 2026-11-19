import { Storage } from "@google-cloud/storage";
import { SolverHistoryGcsStore } from "@aerodb/core/solver-history-gcs";
import { hydrateForceHistory, type StoredForceHistory } from "@aerodb/db/solver-history-storage";
import type { DB } from "@aerodb/db/client";

let reader: SolverHistoryGcsStore | undefined;

/** Shared by detail and sync replay. Credentials never leave the API. */
export function readStoredForceHistory(db: DB, row: StoredForceHistory) {
  return hydrateForceHistory(db, {
    read(identity) {
      reader ??= new SolverHistoryGcsStore(new Storage());
      return reader.read(identity);
    },
  }, row);
}
