import { Storage } from "@google-cloud/storage";
import { ResultHistoryGcsStore } from "@aerodb/core/result-history-storage";
import {
  hydrateResultHistories,
  type ResultHistoryRow,
} from "@aerodb/db/result-history-storage";
import type { DB } from "@aerodb/db/client";
import { env } from "./env";

let store: ResultHistoryGcsStore | undefined;

/** Only canonical row consumers need this; exact selected-attempt projections
 * continue to read the immutable attempt payload without an object request. */
export function readStoredResultHistories<T extends ResultHistoryRow>(
  db: DB,
  row: T,
): Promise<T> {
  return hydrateResultHistories(
    db,
    {
      read(identity) {
        if (
          !env.evidenceBucket ||
          identity.bucket !== env.evidenceBucket.trim()
        )
          throw new Error("Result history archive bucket is not configured");
        store ??= new ResultHistoryGcsStore(new Storage());
        return store.read(identity);
      },
    },
    row,
  );
}
