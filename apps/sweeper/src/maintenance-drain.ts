import { type DB, sweeperState } from "@aerodb/db";
import { eq } from "drizzle-orm";

/**
 * A durable maintenance drain is an exclusive writer boundary, not merely a
 * scheduler admission pause. A restarted ordinary sweeper or media renderer
 * must stay inert while a watcher-owned receipt is being reconciled; only the
 * private receipt path receives the matching token and may write.
 */
export async function ordinaryWriterBlockedByMaintenanceDrain(
  db: DB,
): Promise<boolean> {
  const [state] = await db
    .select({
      maintenanceDrainToken: sweeperState.maintenanceDrainToken,
      maintenanceDrainStartedAt: sweeperState.maintenanceDrainStartedAt,
    })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  return Boolean(
    state?.maintenanceDrainToken && state.maintenanceDrainStartedAt,
  );
}
