import { setTimeout as delay } from "node:timers/promises";
import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { reconcileProgressiveRemoteWorker } from "./progressive-remote-reconciliation";
import { MAX_ACTIVE_RECONCILE_JOB_LIMIT } from "./reconcile";

export async function runProgressiveRemoteObservationService(
  db: DB,
  engine: EngineClient,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const receipt = await reconcileProgressiveRemoteWorker(db, engine, {
        limit: MAX_ACTIVE_RECONCILE_JOB_LIMIT,
      });
      if (receipt.inspected || receipt.errors.length)
        console.log(
          JSON.stringify({
            component: "progressive-remote-observation",
            ...receipt,
          }),
        );
    } catch (error) {
      console.error(
        "[sweeper] progressive remote observation failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (signal.aborted) break;
    try {
      await delay(5000, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
