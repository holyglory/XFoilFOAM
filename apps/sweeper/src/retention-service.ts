import { setTimeout as delay } from "node:timers/promises";
import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";
import { retentionTick } from "./retention";

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
