import type { DB } from "@aerodb/db/client";
import { resultHistoryOffloadCandidates } from "@aerodb/db/result-history-storage";
import {
  assertResultHistoryInstance,
  MAX_RESULT_HISTORY_BYTES,
  type ResultHistoryArchiveStore,
} from "@aerodb/core/result-history-storage";
import { sql } from "drizzle-orm";
import { setTimeout } from "node:timers/promises";
import { archiveResultHistory } from "./result-history-archive";
import { ResultHistoryStore } from "./result-history-store";

const PROGRESS_YIELD_MS = 100;
const IDLE_OR_ERROR_BACKOFF_MS = 30_000;

export async function runResultHistoryOffloadPass(
  db: DB,
  store: ResultHistoryArchiveStore,
  options: {
    bucket: string;
    sourceInstance: string;
    after?: string | null;
    maxRows?: number;
    maxBytes?: number;
    signal?: AbortSignal;
  },
) {
  assertResultHistoryInstance(options.sourceInstance);
  const maxRows = options.maxRows ?? 8;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isInteger(maxRows) ||
    maxRows < 2 ||
    maxRows > 32 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 2 * MAX_RESULT_HISTORY_BYTES
  )
    throw new Error("Invalid bounded result history offload budget");
  const candidates = await resultHistoryOffloadCandidates(
    db,
    options.after ?? null,
  );
  const groups = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.id) ?? [];
    group.push(candidate);
    groups.set(candidate.id, group);
  }
  let next = options.after ?? null;
  let processed = 0,
    offloaded = 0,
    sourceBytes = 0,
    attemptedBytes = 0;
  const failures: Array<{
    resultId: string;
    sourceKind: string;
    error: string;
  }> = [];
  for (const [id, group] of groups) {
    if (options.signal?.aborted) break;
    const ready = group.filter((candidate) => candidate.eligible === true);
    const bytes = ready.reduce(
      (total, candidate) => total + Number(candidate.byte_size),
      0,
    );
    // Advance by whole result IDs so a budget boundary cannot skip its sibling
    // history. One first result can exceed the soft pass budget, at most 64 MiB.
    if (
      processed > 0 &&
      (processed + ready.length > maxRows || attemptedBytes + bytes > maxBytes)
    )
      break;
    for (const candidate of ready) {
      processed++;
      attemptedBytes += Number(candidate.byte_size);
      try {
        const result = await archiveResultHistory(db, store, {
          bucket: options.bucket,
          sourceInstance: options.sourceInstance,
          resultId: id,
          sourceKind: candidate.kind,
        });
        if (result.offloaded) {
          offloaded++;
          sourceBytes += result.sourceBytes;
        }
      } catch (error) {
        failures.push({
          resultId: id,
          sourceKind: candidate.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    next = id;
  }
  // Consuming a full page, even if every row was skipped or failed, is forward
  // progress. Wrap only when a subsequent query proves the tail is empty.
  if (!candidates.length) next = null;
  return { processed, offloaded, sourceBytes, next, failures };
}

/** Parent starts this in the isolated report-storage-worker after migration
 * and reader handoff. No cloud credentials are obtained on remote workers. */
export async function runResultHistoryStorageService(
  db: DB,
  signal: AbortSignal,
): Promise<void> {
  const bucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
  if (
    !bucket ||
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver" ||
    process.env.AIRFOILFOAM_RESULT_HISTORY_OFFLOAD === "false"
  )
    return;
  const [settings] = await db.execute(
    sql`SELECT instance_id::text AS id FROM sync_api_settings WHERE id=1`,
  );
  const sourceInstance =
    process.env.AIRFOILFOAM_HISTORY_SOURCE_INSTANCE?.trim() ||
    String(settings?.id ?? "");
  assertResultHistoryInstance(sourceInstance);
  const store = new ResultHistoryStore();
  let after: string | null = null;
  while (!signal.aborted) {
    let delayMs = IDLE_OR_ERROR_BACKOFF_MS;
    try {
      const result = await runResultHistoryOffloadPass(db, store, {
        bucket,
        sourceInstance,
        after,
        signal,
      });
      const advanced = result.next !== null && result.next !== after;
      if (!result.failures.length && (result.offloaded > 0 || advanced))
        delayMs = PROGRESS_YIELD_MS;
      after = result.next;
      if (result.offloaded || result.failures.length)
        console.info("result-history-storage", result);
    } catch (error) {
      console.error(
        "result-history-storage",
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      await setTimeout(delayMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
