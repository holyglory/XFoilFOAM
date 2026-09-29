import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { expect, vi } from "vitest";
import type { EngineClient } from "../../engine-client/src";
import type { DB } from "../src/client";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import { sealProgressiveRemoteExecution } from "../src/progressive-remote-execution";
import { validateProgressiveRemoteReport } from "../src/progressive-remote-report";
import {
  simJobs,
  syncSweepPromises,
  progressiveWorkerSubmissionIntents,
  progressiveWorkerReports,
} from "../src/schema";
import {
  acknowledgeProgressiveWorkerReport,
  settleProgressiveWorkerFinalReport,
} from "../src/progressive-worker-reports";
import {
  stageProgressiveWorkerEvidence,
  stageNextProgressiveWorkerEvidence,
} from "../../../apps/sweeper/src/progressive-worker-evidence";
import { nextProgressiveEvidenceWakeAt } from "../../../apps/sweeper/src/progressive-evidence-service";
import { verifyProgressiveWorkerEvidenceDelivery } from "./progressive-worker-evidence-delivery-fixture";
import { progressiveEvidencePriority } from "../../../apps/sweeper/src/progressive-evidence-priority";
import { verifyProgressiveEvidenceReuse } from "./progressive-evidence-reuse-fixture";

async function verifyParallelStagingClaims(
  db: DB,
  engine: EngineClient,
  source: ProgressiveRemoteExecutionEnvelope,
) {
  const [originalJob] = await db
    .select()
    .from(simJobs)
    .where(eq(simJobs.id, source.scope.executionId));
  const [originalPromise] = await db
    .select()
    .from(syncSweepPromises)
    .where(eq(syncSweepPromises.id, source.promiseId));
  const [originalReport] = await db
    .select()
    .from(progressiveWorkerReports)
    .where(eq(progressiveWorkerReports.simJobId, source.scope.executionId))
    .orderBy(progressiveWorkerReports.sequence)
    .limit(1);
  const jobIds: string[] = [];
  const promiseIds: string[] = [];
  try {
    await db
      .update(simJobs)
      .set({
        ingestLeaseToken: randomUUID(),
        ingestLeaseExpiresAt: new Date(Date.now() + 60000),
      })
      .where(eq(simJobs.id, originalJob.id));
    for (let slot = 0; slot < 4; slot += 1) {
      const executionId = randomUUID();
      const promiseId = randomUUID();
      const envelope = sealProgressiveRemoteExecution({
        solverId: source.solverId,
        promiseId,
        scope: { ...source.scope, executionId },
        request: { ...source.request, execution_id: executionId },
      });
      await db
        .insert(syncSweepPromises)
        .values({
          ...originalPromise,
          id: promiseId,
          status: "active",
          expiresAt: new Date(Date.now() + 60000),
        });
      promiseIds.push(promiseId);
      await db.insert(simJobs).values({
        ...originalJob,
        id: executionId,
        engineJobId: executionId,
        status: "done",
        requestPayload: {
          ...(originalJob.requestPayload as Record<string, unknown>),
          syncPromiseId: promiseId,
          engineRequest: envelope.request,
          remoteProgressiveExecution: envelope,
        },
        ingestLeaseToken: null,
        ingestLeaseExpiresAt: null,
        ingestLeaseClaimedAt: null,
        ingestLeasePreviousStatus: null,
      });
      jobIds.push(executionId);
      await db
        .insert(progressiveWorkerSubmissionIntents)
        .values({
          simJobId: executionId,
          token: randomUUID(),
          assignmentSignature: envelope.contentSignature,
          authorization: {
            kind: "authorized",
            executionId,
            contentSignature: envelope.contentSignature,
          },
        });
      const report = JSON.parse(
        JSON.stringify(originalReport.report).replaceAll(
          source.scope.executionId,
          executionId,
        ),
      );
      report.promiseId = promiseId;
      report.assignmentSignature = envelope.contentSignature;
      report.sequence = 1;
      const validated = validateProgressiveRemoteReport(report, envelope);
      await db
        .insert(progressiveWorkerReports)
        .values({
          simJobId: executionId,
          sequence: 1,
          contentSignature: validated.contentSignature,
          report,
          acknowledgedAt: new Date(),
        });
    }
    let release: () => void = () => {};
    let allClaimed: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      allClaimed = resolve;
    });
    const claimed = new Set<string>();
    const interruption = new Error(
      "Finish isolated parallel claim observation",
    );
    const stages = Promise.allSettled(
      Array.from({ length: 4 }, () =>
        stageNextProgressiveWorkerEvidence(db, engine, {
          afterEvidenceClaimed: async (executionId) => {
            claimed.add(executionId);
            if (claimed.size === 4) allClaimed();
            await gate;
            throw interruption;
          },
        }),
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Parallel staging failed to claim four distinct jobs",
                ),
              ),
            15000,
          );
        }),
      ]);
      expect(claimed).toEqual(new Set(jobIds));
      const leased = await db
        .select({ token: simJobs.ingestLeaseToken })
        .from(simJobs)
        .where(inArray(simJobs.id, jobIds));
      expect(new Set(leased.map((row) => row.token)).size).toBe(4);
      expect(leased.every((row) => row.token !== null)).toBe(true);
    } finally {
      clearTimeout(timer);
      release();
      const completed = await stages;
      expect(
        completed.every(
          (result) =>
            result.status === "rejected" && result.reason === interruption,
        ),
      ).toBe(true);
    }
    const released = await db
      .select({ token: simJobs.ingestLeaseToken })
      .from(simJobs)
      .where(inArray(simJobs.id, jobIds));
    expect(released.every((row) => row.token === null)).toBe(true);
    console.info(
      JSON.stringify({
        parallelStagingClaims: claimed.size,
        uniqueJobs: jobIds.length,
        leasesReleased: true,
      }),
    );
  } finally {
    if (jobIds.length) {
      await db
        .delete(progressiveWorkerReports)
        .where(inArray(progressiveWorkerReports.simJobId, jobIds));
      await db
        .delete(progressiveWorkerSubmissionIntents)
        .where(inArray(progressiveWorkerSubmissionIntents.simJobId, jobIds));
      await db.delete(simJobs).where(inArray(simJobs.id, jobIds));
    }
    if (promiseIds.length)
      await db
        .delete(syncSweepPromises)
        .where(inArray(syncSweepPromises.id, promiseIds));
    await db
      .update(simJobs)
      .set({
        ingestLeaseToken: originalJob.ingestLeaseToken,
        ingestLeaseExpiresAt: originalJob.ingestLeaseExpiresAt,
      })
      .where(eq(simJobs.id, originalJob.id));
  }
}

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
    const [index] =
      await db.execute(sql`SELECT indisvalid,pg_get_expr(indpred,indrelid) AS predicate FROM pg_index
      WHERE indexrelid='progressive_worker_reports_staging_candidate_idx'::regclass`);
    expect(index.indisvalid).toBe(true);
    expect(index.predicate).toContain("acknowledged_at IS NOT NULL");
    const candidates = () =>
      db.execute(sql`SELECT sequence FROM progressive_worker_reports
      WHERE sim_job_id=${executionId}::uuid AND acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object' ORDER BY sequence`);
    expect(await candidates()).toHaveLength(0);
    for (const preferActive of [true, false]) {
      const rows =
        await db.execute(sql`WITH promise(status,"expiresAt",created_at,label) AS (VALUES
        ('cancelled',clock_timestamp()+interval '1 hour',1,'retained'),
        ('active',clock_timestamp()-interval '1 second',2,'expired-active'),
        ('expired',clock_timestamp()+interval '1 hour',3,'expired'),
        ('active',clock_timestamp()+interval '1 hour',4,'current'))
        SELECT label FROM promise ORDER BY ${progressiveEvidencePriority(preferActive)},created_at`);
      expect(rows.map((row) => row.label)).toEqual(
        preferActive
          ? ["current", "retained", "expired-active", "expired"]
          : ["retained", "expired-active", "expired", "current"],
      );
    }
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
    expect((await candidates()).map((row) => Number(row.sequence))).toContain(
      Number(report.sequence),
    );
    const plannerRollback = new Error(
      "Restore staging planner diagnostic flags",
    );
    try {
      await db.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL enable_seqscan=off`);
        await transaction.execute(sql`SET LOCAL enable_bitmapscan=off`);
        const [plan] =
          await transaction.execute(sql`EXPLAIN(FORMAT JSON) SELECT sim_job_id,sequence,created_at
          FROM progressive_worker_reports WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object'
          ORDER BY sim_job_id,sequence,created_at LIMIT 1`);
        expect(JSON.stringify(plan)).toContain(
          "progressive_worker_reports_staging_candidate_idx",
        );
        throw plannerRollback;
      });
    } catch (error) {
      if (error !== plannerRollback) throw error;
    }
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
    await verifyParallelStagingClaims(db, engine, envelope);
    const rollbackRace = new Error("Rollback isolated staging completion race");
    for (const failAfterProjection of [false, true]) {
      const rollbackProjection = new Error(
        "Rollback terminal report projection race",
      );
      try {
        await db.transaction(async (transaction) => {
          const connection = transaction as unknown as DB;
          const [latest] =
            await connection.execute(sql`SELECT report#>>'{status,state}' AS state
            FROM progressive_worker_reports WHERE sim_job_id=${executionId}::uuid ORDER BY sequence DESC LIMIT 1`);
          const terminalState =
            latest.state === "completed" ? "done" : latest.state;
          const staging = stageProgressiveWorkerEvidence(
            connection,
            engine,
            executionId,
            {
              afterEvidenceStaged: async () => {
                const [before] = await connection.execute(
                  sql`SELECT ingest_lease_token FROM sim_jobs WHERE id=${executionId}::uuid`,
                );
                expect(
                  await settleProgressiveWorkerFinalReport(
                    connection,
                    executionId,
                  ),
                ).toBe(true);
                const [during] =
                  await connection.execute(sql`SELECT status,ingest_lease_token,ingest_lease_previous_status
                FROM sim_jobs WHERE id=${executionId}::uuid`);
                expect(during).toMatchObject({
                  status: "ingesting",
                  ingest_lease_token: before.ingest_lease_token,
                  ingest_lease_previous_status: terminalState,
                });
                if (failAfterProjection)
                  throw new Error("isolated failure after terminal projection");
              },
            },
          );
          if (failAfterProjection)
            await expect(staging).rejects.toThrow(
              "isolated failure after terminal projection",
            );
          else expect((await staging).kind).toBe("staged");
          const [after] =
            await connection.execute(sql`SELECT status,ingest_lease_token,ingest_lease_previous_status
            FROM sim_jobs WHERE id=${executionId}::uuid`);
          expect(after).toMatchObject({
            status: terminalState,
            ingest_lease_token: null,
            ingest_lease_previous_status: null,
          });
          throw rollbackProjection;
        });
      } catch (error) {
        if (error !== rollbackProjection) throw error;
      }
    }
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
    await verifyProgressiveEvidenceReuse(db, executionId);
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
