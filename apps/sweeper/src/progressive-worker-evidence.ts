import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  simJobs,
  simulationPresetRevisions,
  resolveProgressiveReportedPoint,
  type DB,
  type ProgressiveRemoteReport,
  type ProgressiveRemoteExecutionEnvelope,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import type { EngineClient, JobResult } from "@aerodb/engine-client";
import { assertProgressiveWorkerEvidenceJob } from "./progressive-remote-jobs";
import { progressiveStagingSelectionSql } from "./progressive-staging-selection";
import { ingestResult } from "./ingest";
import {
  DEFAULT_INGEST_LEASE_MS,
  IngestLeaseLostError,
  ingestLeaseOwnedWhere,
  renewIngestLeaseOrThrow,
} from "./ingest-lease";

export async function stageProgressiveWorkerEvidence(
  db: DB,
  engine: EngineClient,
  executionId: string,
  hooks: {
    afterEvidenceStaged?: () => Promise<void>;
    reportSequence?: number;
  } = {},
) {
  const claimed = await db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [candidate] = await connection.execute(sql`
      SELECT job.id, report.sequence, report.content_signature, report.report
      FROM sim_jobs job JOIN sync_api_settings settings ON settings.id = 1
      JOIN progressive_worker_reports report ON report.sim_job_id = job.id
      WHERE job.id = ${executionId}::uuid AND NOT settings.remote_solver_transfer_paused
        AND (${hooks.reportSequence ?? null}::bigint IS NULL OR report.sequence = ${hooks.reportSequence ?? null}::bigint)
        AND report.acknowledged_at IS NOT NULL AND jsonb_typeof(report.report->'result') = 'object'
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts receipt
          WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
        AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
      ORDER BY report.sequence LIMIT 1 FOR UPDATE OF job SKIP LOCKED
    `);
    if (!candidate) return null;
    const report = candidate.report as unknown as ProgressiveRemoteReport;
    const sequence = Number(candidate.sequence);
    const result = report.result as JobResult;
    await assertProgressiveWorkerEvidenceJob(connection, {
      simJobId: executionId,
      engineJobId: executionId,
      reportSequence: sequence,
      result,
    });
    const [job] = await connection
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, executionId));
    if (!job?.simulationPresetRevisionId)
      throw new Error("Worker evidence requires its immutable setup revision");
    const restoreStatus =
      job.status === "ingesting" ? job.ingestLeasePreviousStatus : job.status;
    if (!restoreStatus || restoreStatus === "ingesting")
      throw new Error(
        "Worker evidence lease has no recoverable prior job state",
      );
    const [revision] = await connection
      .select()
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, job.simulationPresetRevisionId));
    if (!revision) throw new Error("Worker evidence setup revision is missing");
    const setup = revision.snapshot as unknown as SimulationSetupSnapshot;
    const envelope = (
      job.requestPayload as {
        remoteProgressiveExecution: ProgressiveRemoteExecutionEnvelope;
      }
    ).remoteProgressiveExecution;
    if (!setup.preset.legacyBoundaryConditionId)
      throw new Error(
        "Worker evidence setup has no physical boundary identity",
      );
    const token = randomUUID();
    await connection.execute(sql`
      UPDATE sim_jobs SET status = 'ingesting', engine_job_id = ${executionId}, ingest_lease_token = ${token},
        ingest_lease_previous_status = ${restoreStatus}::sim_job_status,
        ingest_lease_claimed_at = clock_timestamp(),
        ingest_lease_expires_at = clock_timestamp() + ${DEFAULT_INGEST_LEASE_MS} * interval '1 millisecond'
      WHERE id = ${executionId}::uuid
    `);
    return {
      job,
      restoreStatus,
      setup,
      envelope,
      sequence,
      result,
      token,
      signature: String(candidate.content_signature),
    };
  });
  if (!claimed) return { kind: "idle" as const };
  const lease = { jobId: executionId, token: claimed.token };
  try {
    const ingested = await ingestResult({
      db,
      engine,
      engineJobId: executionId,
      simJobId: executionId,
      airfoilId: claimed.job.airfoilId,
      speedMap: [
        {
          speed: claimed.setup.flowState.speedMps,
          bcId: claimed.setup.preset.legacyBoundaryConditionId!,
          presetRevisionId: claimed.job.simulationPresetRevisionId,
          mach: claimed.setup.flowState.mach,
        },
      ],
      jobAoas: claimed.envelope.scope.units.map((unit) => unit.alpha),
      uransFidelity:
        claimed.job.wave === 2
          ? claimed.envelope.request.solver?.urans_fidelity
          : undefined,
      result: claimed.result,
      remoteProgressiveReportSequence: claimed.sequence,
      ingestLeaseToken: claimed.token,
      heartbeat: () => renewIngestLeaseOrThrow(db, lease),
    });
    await hooks.afterEvidenceStaged?.();
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const [owned] = await connection
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(ingestLeaseOwnedWhere(executionId, claimed.token))
        .for("update");
      if (!owned) throw new IngestLeaseLostError(executionId);
      await renewIngestLeaseOrThrow(connection, lease);
      await assertProgressiveWorkerEvidenceJob(connection, {
        simJobId: executionId,
        engineJobId: executionId,
        result: claimed.result,
        reportSequence: claimed.sequence,
      });
      await connection.execute(sql`
        INSERT INTO progressive_worker_evidence_receipts (sim_job_id, sequence, content_signature)
        VALUES (${executionId}::uuid, ${claimed.sequence}, ${claimed.signature})
      `);
      for (const attemptId of ingested.resultAttemptIds) {
        const [attempt] =
          await connection.execute(sql`SELECT aoa_deg, engine_case_slug FROM result_attempts
          WHERE id = ${attemptId}::uuid AND sim_job_id = ${executionId}::uuid AND engine_job_id = ${executionId}`);
        if (!attempt)
          throw new Error(
            "Worker evidence attempt belongs to another execution",
          );
        const source = resolveProgressiveReportedPoint(claimed.result, {
          alpha: Number(attempt.aoa_deg),
          caseSlug:
            attempt.engine_case_slug === null
              ? null
              : String(attempt.engine_case_slug),
          speed: claimed.setup.flowState.speedMps,
          chord: claimed.setup.referenceGeometry.referenceLengthM,
        });
        const [bound] = await connection.execute(sql`
          INSERT INTO progressive_worker_evidence_attempts (sim_job_id, sequence, result_attempt_id, point_content_signature)
          SELECT ${executionId}::uuid, ${claimed.sequence}, id, ${source.contentSignature} FROM result_attempts
          WHERE id = ${attemptId}::uuid AND sim_job_id = ${executionId}::uuid AND engine_job_id = ${executionId}
          RETURNING result_attempt_id
        `);
        if (!bound)
          throw new Error(
            "Worker evidence attempt belongs to another execution",
          );
      }
      await connection.execute(sql`DELETE FROM progressive_worker_staging_failures
        WHERE sim_job_id = ${executionId}::uuid AND sequence = ${claimed.sequence}`);
      await connection
        .update(simJobs)
        .set({
          status: claimed.restoreStatus,
          ingestLeaseToken: null,
          ingestLeasePreviousStatus: null,
          ingestLeaseClaimedAt: null,
          ingestLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(ingestLeaseOwnedWhere(executionId, claimed.token));
    });
    return {
      kind: "staged" as const,
      executionId,
      sequence: claimed.sequence,
      contentSignature: claimed.signature,
      resultAttemptIds: ingested.resultAttemptIds,
    };
  } catch (error) {
    await db
      .update(simJobs)
      .set({
        status: claimed.restoreStatus,
        ingestLeaseToken: null,
        ingestLeasePreviousStatus: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(ingestLeaseOwnedWhere(executionId, claimed.token));
    throw error;
  }
}

export async function stageNextProgressiveWorkerEvidence(
  db: DB,
  engine: EngineClient,
  hooks: {
    afterEvidenceStaged?: () => Promise<void>;
    preferActive?: boolean;
  } = {},
): Promise<boolean> {
  const [pending] = await db.execute(
    progressiveStagingSelectionSql(hooks.preferActive === true),
  );
  if (!pending) return false;
  try {
    return (
      (
        await stageProgressiveWorkerEvidence(
          db,
          engine,
          String(pending.sim_job_id),
          { ...hooks, reportSequence: Number(pending.sequence) },
        )
      ).kind === "staged"
    );
  } catch (error) {
    await db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT id FROM sim_jobs WHERE id = ${pending.sim_job_id}::uuid FOR UPDATE`,
      );
      await transaction.execute(sql`
      INSERT INTO progressive_worker_staging_failures(sim_job_id, sequence, attempt_count, retry_after, last_error)
      SELECT ${pending.sim_job_id}::uuid, ${pending.sequence}::bigint, 1, clock_timestamp() + interval '2 seconds',
        ${(error instanceof Error ? error.message : String(error)).slice(0, 1000)}
      WHERE NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts staged
        WHERE staged.sim_job_id = ${pending.sim_job_id}::uuid AND staged.sequence = ${pending.sequence}::bigint)
      ON CONFLICT (sim_job_id, sequence) DO UPDATE SET
        attempt_count = progressive_worker_staging_failures.attempt_count + 1,
        retry_after = clock_timestamp() + make_interval(secs => LEAST(60, power(2, LEAST(6, progressive_worker_staging_failures.attempt_count + 1)))::double precision),
        last_error = excluded.last_error, updated_at = clock_timestamp()
    `);
    });
    throw error;
  }
}
