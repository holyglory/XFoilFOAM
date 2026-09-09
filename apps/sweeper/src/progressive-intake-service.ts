import { setTimeout as delay } from "node:timers/promises";
import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { receiveProgressiveCampaignAssignments } from "./remote-solver";

export async function runProgressiveAssignmentIntakeService(
  db: DB,
  engine: EngineClient,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const receipt = await receiveProgressiveCampaignAssignments(db, engine);
      if (receipt.mirrored || receipt.errors.length)
        console.log(
          JSON.stringify({
            component: "progressive-assignment-intake",
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
