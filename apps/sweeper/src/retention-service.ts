import { setTimeout as delay } from "node:timers/promises";
import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";
import { retentionConfigFromEnv, retentionTick } from "./retention";
import { reclaimProgressiveRestartState } from "./progressive-restart-retention";

export async function runRetentionService(
  db: DB,
  engine: EngineClient,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const [state] = await db.execute(
        sql`SELECT disk_admission_blocked FROM sweeper_state WHERE id = 1`,
      );
      if (signal.aborted) break;
      if (state?.disk_admission_blocked === true) {
        const { stripMaxPerTick } = retentionConfigFromEnv();
        for (
          let index = 0;
          index < stripMaxPerTick && !signal.aborted;
          index += 1
        ) {
          const reclaimed = await reclaimProgressiveRestartState(db, engine);
          if (reclaimed.bytesFreed || reclaimed.error)
            console.log(
              JSON.stringify({
                component: "progressive-restart-retention",
                ...reclaimed,
              }),
            );
          if (!reclaimed.bytesFreed) break;
        }
      }
      await retentionTick(db, engine, {
        reclaimOptionalCaseState: state?.disk_admission_blocked === true,
      });
    } catch (error) {
      console.error(
        "[sweeper] retention service failed:",
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
