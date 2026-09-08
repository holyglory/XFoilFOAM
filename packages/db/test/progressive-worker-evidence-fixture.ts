import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { EngineClient } from "../../engine-client/src";
import type { DB } from "../src/client";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import { acknowledgeProgressiveWorkerReport } from "../src/progressive-worker-reports";
import {
  stageProgressiveWorkerEvidence,
  stageNextProgressiveWorkerEvidence,
} from "../../../apps/sweeper/src/progressive-worker-evidence";
import { nextProgressiveEvidenceWakeAt } from "../../../apps/sweeper/src/progressive-evidence-service";
import { verifyProgressiveWorkerEvidenceDelivery } from "./progressive-worker-evidence-delivery-fixture";

export async function verifyProgressiveWorkerEvidence(
  db: DB,
  engine: EngineClient,
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  const executionId = envelope.scope.executionId;
  const [settings] = await db.execute(
    sql`SELECT remote_solver_transfer_paused FROM sync_api_settings WHERE id = 1`,
  );
  const [original] = await db.execute(
    sql`SELECT status FROM sim_jobs WHERE id = ${executionId}::uuid`,
  );
  try {
    expect(
      await stageProgressiveWorkerEvidence(db, engine, executionId),
    ).toEqual({ kind: "idle" });
    const [report] =
      await db.execute(sql`SELECT sequence, content_signature FROM progressive_worker_reports
      WHERE sim_job_id = ${executionId}::uuid ORDER BY sequence LIMIT 1`);
    await acknowledgeProgressiveWorkerReport(db, {
      executionId,
      solverId: envelope.solverId,
      sequence: Number(report.sequence),
      contentSignature: String(report.content_signature),
    });
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused = true WHERE id = 1`,
    );
    expect(
      await stageProgressiveWorkerEvidence(db, engine, executionId),
    ).toEqual({ kind: "idle" });
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused = false WHERE id = 1`,
    );
    await db.execute(
      sql`UPDATE sim_jobs SET status = 'cancelled' WHERE id = ${executionId}::uuid`,
    );
    const rollbackRace = new Error("Rollback isolated staging completion race");
    try {
      await db.transaction(async (transaction) => {
        const connection = transaction as unknown as DB;
        await expect(
          stageNextProgressiveWorkerEvidence(connection, engine, {
            afterEvidenceStaged: async () => {
              await connection.execute(
                sql`UPDATE sim_jobs SET ingest_lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${executionId}::uuid`,
              );
              expect(
                (
                  await stageProgressiveWorkerEvidence(
                    connection,
                    engine,
                    executionId,
                  )
                ).kind,
              ).toBe("staged");
              throw new Error(
                "isolated late failure after replacement completed",
              );
            },
          }),
        ).rejects.toThrow("isolated late failure");
        const [completed] = await connection.execute(sql`SELECT
          (SELECT count(*)::integer FROM progressive_worker_evidence_receipts WHERE sim_job_id = ${executionId}::uuid) AS receipts,
          (SELECT count(*)::integer FROM progressive_worker_staging_failures WHERE sim_job_id = ${executionId}::uuid) AS failures`);
        expect(completed).toEqual({ receipts: 1, failures: 0 });
        throw rollbackRace;
      });
    } catch (error) {
      if (error !== rollbackRace) throw error;
    }
    const interrupted = vi.fn(async () => {
      throw new Error("isolated staging interruption");
    });
    await expect(
      stageNextProgressiveWorkerEvidence(db, engine, {
        afterEvidenceStaged: interrupted,
      }),
    ).rejects.toThrow("isolated staging interruption");
    expect(interrupted).toHaveBeenCalledOnce();
    const retryAt = new Date(Date.now() + 10057);
    await db.execute(sql`UPDATE progressive_worker_staging_failures SET retry_after = ${retryAt.toISOString()}::timestamptz
      WHERE sim_job_id = ${executionId}::uuid AND sequence = ${report.sequence}::bigint`);
    expect(await nextProgressiveEvidenceWakeAt(db)).toEqual(retryAt);
    expect(
      await stageNextProgressiveWorkerEvidence(db, engine, {
        afterEvidenceStaged: interrupted,
      }),
    ).toBe(false);
    expect(interrupted).toHaveBeenCalledOnce();
    const attempts = await db.execute(
      sql`SELECT id, valid_for_polar FROM result_attempts WHERE sim_job_id = ${executionId}::uuid`,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0].valid_for_polar).toBe(false);
    const [unreceipted] =
      await db.execute(sql`SELECT count(*)::integer AS count FROM progressive_worker_evidence_receipts
      WHERE sim_job_id = ${executionId}::uuid`);
    expect(unreceipted.count).toBe(0);
    const [restored] = await db.execute(
      sql`SELECT status, ingest_lease_token FROM sim_jobs WHERE id = ${executionId}::uuid`,
    );
    expect(restored).toMatchObject({
      status: "cancelled",
      ingest_lease_token: null,
    });
    await db.execute(sql`UPDATE sim_jobs SET status = 'ingesting', ingest_lease_previous_status = 'cancelled',
      ingest_lease_token = ${randomUUID()}, ingest_lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${executionId}::uuid`);
    const results = await Promise.all([
      stageProgressiveWorkerEvidence(db, engine, executionId),
      stageProgressiveWorkerEvidence(db, engine, executionId),
    ]);
    expect(results.filter((receipt) => receipt.kind === "staged")).toHaveLength(
      1,
    );
    expect(results.filter((receipt) => receipt.kind === "idle")).toHaveLength(
      1,
    );
    const [receipt] =
      await db.execute(sql`SELECT receipt.content_signature, binding.result_attempt_id
      FROM progressive_worker_evidence_receipts receipt JOIN progressive_worker_evidence_attempts binding
        USING (sim_job_id, sequence) WHERE receipt.sim_job_id = ${executionId}::uuid`);
    expect(receipt).toMatchObject({
      content_signature: report.content_signature,
      result_attempt_id: attempts[0].id,
    });
    const retained = await db.execute(
      sql`SELECT id FROM result_attempts WHERE sim_job_id = ${executionId}::uuid`,
    );
    expect(retained.map((attempt) => attempt.id)).toEqual(
      attempts.map((attempt) => attempt.id),
    );
    const [failures] = await db.execute(
      sql`SELECT count(*)::integer AS count FROM progressive_worker_staging_failures WHERE sim_job_id = ${executionId}::uuid`,
    );
    expect(failures.count).toBe(0);
    const [state] =
      await db.execute(sql`SELECT status, ingest_lease_token, ingest_lease_previous_status
      FROM sim_jobs WHERE id = ${executionId}::uuid`);
    expect(state).toMatchObject({
      status: "cancelled",
      ingest_lease_token: null,
      ingest_lease_previous_status: null,
    });
    expect(
      await stageProgressiveWorkerEvidence(db, engine, executionId),
    ).toEqual({ kind: "idle" });
    await expect(
      db.execute(sql`UPDATE progressive_worker_evidence_receipts SET content_signature = ${"0".repeat(64)}
      WHERE sim_job_id = ${executionId}::uuid`),
    ).rejects.toThrow();
    await expect(
      db.execute(sql`UPDATE progressive_worker_evidence_attempts SET sequence = sequence + 1
      WHERE sim_job_id = ${executionId}::uuid`),
    ).rejects.toThrow();
    await verifyProgressiveWorkerEvidenceDelivery(db, executionId);
  } finally {
    await db.execute(sql`UPDATE sim_jobs SET status = ${original.status}::sim_job_status, ingest_lease_token = NULL,
      ingest_lease_previous_status = NULL, ingest_lease_claimed_at = NULL, ingest_lease_expires_at = NULL
      WHERE id = ${executionId}::uuid`);
    await db.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused = ${settings.remote_solver_transfer_paused} WHERE id = 1`,
    );
  }
}
