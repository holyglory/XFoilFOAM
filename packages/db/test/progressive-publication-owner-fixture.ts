import { eq, sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import { syncApiSettings } from "../src/schema";
import { readyLegacyRemoteResultJobs } from "../../../apps/sweeper/src/remote-solver";

export async function verifyProgressivePublicationOwner(
  db: DB,
  executionId: string,
) {
  const rollback = new Error("Restore isolated publication owner fixture");
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const [settings] = await connection
        .select()
        .from(syncApiSettings)
        .where(eq(syncApiSettings.id, 1));
      await connection.execute(
        sql`UPDATE sim_jobs SET status='done' WHERE id=${executionId}::uuid`,
      );
      const [promise] = await connection.execute(
        sql`SELECT request_payload->>'syncPromiseId' AS id FROM sim_jobs WHERE id=${executionId}::uuid`,
      );
      await connection.execute(
        sql`UPDATE sync_sweep_promises SET status='active',"expiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${promise.id}::uuid`,
      );
      const [empty] = await connection.execute(
        sql`SELECT count(*)::integer AS count FROM results WHERE sim_job_id=${executionId}::uuid`,
      );
      expect(empty.count).toBe(0);
      expect(
        (await readyLegacyRemoteResultJobs(connection, settings)).some(
          (job) => job.id === executionId,
        ),
      ).toBe(false);
      await connection.execute(
        sql`UPDATE sim_jobs SET request_payload=request_payload-'remoteProgressiveExecution' WHERE id=${executionId}::uuid`,
      );
      expect(
        (await readyLegacyRemoteResultJobs(connection, settings)).some(
          (job) => job.id === executionId,
        ),
      ).toBe(true);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
