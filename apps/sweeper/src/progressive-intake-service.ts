import { setTimeout as delay } from "node:timers/promises";
import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { receiveProgressiveCampaignAssignments } from "./remote-solver";
import { reconcileTerminalProgressiveMirror } from "./progressive-terminal-mirror";

const priorPromises = new WeakMap<DB, Map<string, number>>();

// Intake has already rolled back before returning these named conflicts. Keep
// their verification off the normal start path and never replace mirror guards.
async function reconcilePriorPromise(db: DB) {
  const queue = priorPromises.get(db);
  const entry = queue && [...queue].find(([, next]) => next <= Date.now());
  if (!entry) return;
  const [promiseId] = entry;
  queue!.delete(promiseId);
  queue!.set(promiseId, Date.now() + 60_000);
  const receipt = await reconcileTerminalProgressiveMirror(db, {
    promiseId,
    bounded: true,
  });
  if (["reconciled", "no-candidate"].includes(receipt.outcome))
    queue!.delete(promiseId);
  if (receipt.outcome !== "no-candidate")
    console.log(
      JSON.stringify({
        component: "progressive-intake-prior-promise",
        ...receipt,
      }),
    );
}

export async function runProgressiveAssignmentIntakeService(
  db: DB,
  engine: EngineClient,
  signal: AbortSignal,
  options: { expiredPending?: boolean } = {},
): Promise<void> {
  while (!signal.aborted) {
    try {
      if (options.expiredPending) await reconcilePriorPromise(db);
      const receipt = options.expiredPending
        ? await receiveProgressiveCampaignAssignments(
            db,
            engine,
            undefined,
            options,
          )
        : await receiveProgressiveCampaignAssignments(db, engine);
      const queue = priorPromises.get(db) ?? new Map<string, number>();
      for (const error of receipt.errors) {
        if (
          error.deferred === "unreconciled_promise" &&
          error.conflictingPromiseId &&
          !queue.has(error.conflictingPromiseId) &&
          queue.size < 64
        )
          queue.set(error.conflictingPromiseId, 0);
      }
      priorPromises.set(db, queue);
      if (receipt.mirrored || receipt.errors.length)
        console.log(
          JSON.stringify({
            component: options.expiredPending
              ? "progressive-expired-assignment-recovery"
              : "progressive-assignment-intake",
            ...receipt,
          }),
        );
    } catch (error) {
      console.error(
        "[sweeper] progressive assignment intake failed:",
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
