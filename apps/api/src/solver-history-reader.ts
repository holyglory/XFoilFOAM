import { Storage } from "@google-cloud/storage";
import { SolverHistoryGcsStore } from "@aerodb/core/solver-history-gcs";
import {
  hydrateForceHistory,
  type StoredForceHistory,
} from "@aerodb/db/solver-history-storage";
import type { DB } from "@aerodb/db/client";
import { readHzPointHistory } from "./hz-point-history-reader";
import type { SolverHistoryEnvelope } from "@aerodb/core/solver-history-storage";

let reader: SolverHistoryGcsStore | undefined;

/** Shared by detail and sync replay. Credentials never leave the API. */
export function readStoredForceHistory(db: DB, row: StoredForceHistory) {
  return hydrateForceHistory(
    db,
    {
      read(identity) {
        if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver")
          return readHzPointHistory(
            db,
            identity,
          ) as Promise<SolverHistoryEnvelope>;
        reader ??= new SolverHistoryGcsStore(new Storage());
        return reader.read(identity);
      },
    },
    row,
  );
}
