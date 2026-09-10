import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { DB } from "../src/client";
import { reclaimProgressiveRestartState } from "../../../apps/sweeper/src/progressive-restart-retention";

export async function verifyProgressiveRestartRetention(
  db: DB,
  executionId: string,
) {
  const rollback = new Error("Restore isolated restart retention fixture");
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const stripJob = vi.fn(async () => ({
        job_id: executionId,
        unknown_entries: [],
        bytes_freed: 8192,
        files_removed: 3,
        kept_case_state: false,
      }));
      const before = await connection.execute(
        sql`SELECT sequence,content_signature FROM progressive_worker_reports WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`,
      );
      await connection.execute(
        sql`UPDATE sweeper_state SET disk_admission_blocked=false WHERE id=1`,
      );
      expect(
        await reclaimProgressiveRestartState(
          connection,
          { stripJob },
          executionId,
        ),
      ).toEqual({ stripped: 0, bytesFreed: 0 });
      expect(stripJob).not.toHaveBeenCalled();
      await connection.execute(
        sql`UPDATE sweeper_state SET disk_admission_blocked=true WHERE id=1`,
      );
      const [original] = await connection.execute(
        sql`SELECT status,engine_job_id FROM sim_jobs WHERE id=${executionId}::uuid`,
      );
      for (const state of ["pending", "submitted", "running", "ingesting"]) {
        await connection.execute(
          sql`UPDATE sim_jobs SET status=${state}::sim_job_status WHERE id=${executionId}::uuid`,
        );
        expect(
          await reclaimProgressiveRestartState(
            connection,
            { stripJob },
            executionId,
          ),
        ).toEqual({ stripped: 0, bytesFreed: 0 });
      }
      await connection.execute(
        sql`UPDATE sim_jobs SET status=${original.status}::sim_job_status,engine_job_id='foreign' WHERE id=${executionId}::uuid`,
      );
      expect(
        await reclaimProgressiveRestartState(
          connection,
          { stripJob },
          executionId,
        ),
      ).toEqual({ stripped: 0, bytesFreed: 0 });
      await connection.execute(
        sql`UPDATE sim_jobs SET engine_job_id=${original.engine_job_id},ingest_lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=${executionId}::uuid`,
      );
      expect(
        await reclaimProgressiveRestartState(
          connection,
          { stripJob },
          executionId,
        ),
      ).toEqual({ stripped: 0, bytesFreed: 0 });
      expect(stripJob).not.toHaveBeenCalled();
      await connection.execute(
        sql`UPDATE sim_jobs SET ingest_lease_expires_at=NULL WHERE id=${executionId}::uuid`,
      );
      expect(
        await reclaimProgressiveRestartState(
          connection,
          { stripJob },
          executionId,
        ),
      ).toEqual({ stripped: 1, bytesFreed: 8192 });
      expect(stripJob).toHaveBeenCalledOnce();
      expect(
        await reclaimProgressiveRestartState(
          connection,
          { stripJob },
          executionId,
        ),
      ).toEqual({ stripped: 0, bytesFreed: 0 });
      expect(stripJob).toHaveBeenCalledOnce();
      expect(
        await connection.execute(
          sql`SELECT sequence,content_signature FROM progressive_worker_reports WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`,
        ),
      ).toEqual(before);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}
