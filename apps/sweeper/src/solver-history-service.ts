import type { DB } from "@aerodb/db/client";
import { forceHistoryOffloadCandidates } from "@aerodb/db/solver-history-storage";
import { MAX_SOLVER_HISTORY_BYTES, assertSolverHistoryInstance } from "@aerodb/core/solver-history-storage";
import { setTimeout } from "node:timers/promises";
import { archiveSolverHistory, type SolverHistoryArchiveStore } from "./solver-history-archive";
import { SolverHistoryStore } from "./solver-history-store";
import { sql } from "drizzle-orm";

export interface ForceHistoryOffloadOptions {
  bucket: string;
  sourceInstance: string;
  after?: string | null;
  maxRows?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** At most 32 candidates, 8 uploads and 8 MiB of exported source per pass by
 * default; one oversized source can use a pass up to the hard 32 MiB bound.
 * Cursor advancement prevents failed sources blocking smaller siblings. */
export async function runForceHistoryOffloadPass(db: DB, store: SolverHistoryArchiveStore, options: ForceHistoryOffloadOptions) {
  assertSolverHistoryInstance(options.sourceInstance);
  const maxRows = options.maxRows ?? 8;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 32 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SOLVER_HISTORY_BYTES)
    throw new Error("Invalid bounded force-history backfill budget");
  const candidates = await forceHistoryOffloadCandidates(db, options.after ?? null);
  let next: string | null = options.after ?? null;
  let uploadedBytes = 0;
  let removedInlineBytes = 0;
  let processed = 0;
  let offloaded = 0;
  const failures: Array<{ sourceId: string; error: string }> = [];
  for (const candidate of candidates) {
    if (options.signal?.aborted || processed >= maxRows) break;
    if (candidate.byte_size > MAX_SOLVER_HISTORY_BYTES) { next = candidate.id; continue; }
    if (processed > 0 && uploadedBytes + candidate.byte_size > maxBytes) break;
    next = candidate.id;
    processed += 1;
    uploadedBytes += candidate.byte_size;
    try {
      const result = await archiveSolverHistory(db, store, {
        bucket: options.bucket, sourceInstance: options.sourceInstance,
        sourceKind: "force_history", sourceId: candidate.id,
      });
      if (result.offloaded) { offloaded += 1; removedInlineBytes += result.sourceBytes; }
    } catch (error) {
      failures.push({ sourceId: candidate.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (candidates.length === 0 || next === candidates.at(-1)?.id) next = null;
  return { processed, offloaded, removedInlineBytes, next, failures };
}

/** Parent starts this with the normal sweeper supervisor only after detail
 * and sync replay hydrate on both hosts. Remote nodes without GCS credentials
 * keep inline histories. No separate scheduler, runtime, or queue is created. */
export async function runSolverHistoryStorageService(db: DB, signal: AbortSignal): Promise<void> {
  const bucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
  if (process.env.AIRFOILFOAM_FORCE_HISTORY_OFFLOAD === "false" || !bucket) return;
  const [settings] = await db.execute(sql`SELECT instance_id::text AS id FROM sync_api_settings WHERE id = 1`) as unknown as Array<{ id: string }>;
  const sourceInstance = process.env.AIRFOILFOAM_HISTORY_SOURCE_INSTANCE?.trim() || settings?.id;
  if (!sourceInstance) throw new Error("Force-history offload requires the configured local instance identity");
  assertSolverHistoryInstance(sourceInstance);
  const store = new SolverHistoryStore();
  let after: string | null = null;
  while (!signal.aborted) {
    try {
      const result = await runForceHistoryOffloadPass(db, store, { bucket, sourceInstance, after, signal });
      after = result.next;
      if (result.offloaded || result.failures.length) console.info("force-history-storage", result);
    } catch (error) {
      console.error("force-history-storage", error instanceof Error ? error.message : String(error));
    }
    try { await setTimeout(30_000, undefined, { signal }); }
    catch (error) { if (!signal.aborted) throw error; }
  }
}
