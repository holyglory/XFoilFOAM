import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import {
  isFinalProgressiveRemoteReport,
  validateProgressiveRemoteReport,
} from "./progressive-remote-report";
import { acknowledgeProgressiveCfdExecutionStop } from "./progressive-cfd-settlement";

const PUBLICATION_LOSS_REASON =
  "remote job completed without canonical result evidence";

export async function recoverProgressivePublicationLosses(
  db: DB,
  campaignId: string,
) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(campaignId))
    throw new Error("Publication recovery requires an exact campaign UUID");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    const [campaign] = await connection.execute(
      sql`SELECT status,current_plan_revision_id FROM sim_campaigns WHERE id=${campaignId}::uuid FOR UPDATE`,
    );
    if (
      !epoch ||
      !campaign ||
      !["active", "attention"].includes(String(campaign.status))
    )
      throw new Error(
        "Publication recovery requires an active campaign and epoch",
      );
    const jobs = await connection.execute(sql`
      SELECT DISTINCT job.id,dispatch.solver_id,dispatch.promise_id,dispatch.content_signature,dispatch.envelope,
        promise.response_payload->'remoteCancellation' AS cancellation
      FROM sim_jobs job JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
      JOIN sync_sweep_promises promise ON promise.id=dispatch.promise_id
      JOIN registered_remote_solvers solver ON solver.id=dispatch.solver_id
      WHERE job.campaign_id=${campaignId}::uuid AND job.status='cancelled' AND job."ingestedAt" IS NULL
        AND promise.status='cancelled' AND promise.registered_solver_id=dispatch.solver_id AND solver.revoked_at IS NULL
        AND promise.response_payload#>>'{remoteCancellation,disposition}'='terminal_local_state'
        AND promise.response_payload#>>'{remoteCancellation,reason}'=${PUBLICATION_LOSS_REASON}
        AND EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
          JOIN progressive_work work ON work.id=unit.work_id JOIN progressive_generations generation ON generation.id=work.generation_id
          WHERE attempt.sim_job_id=job.id AND generation.epoch_id=${epoch.id}::uuid AND generation.status='active'
            AND generation.plan_revision_id=${campaign.current_plan_revision_id} AND generation.stage=2 AND work.stage=2
            AND work.state='pending' AND unit.state='gap' AND attempt.outcome='cancelled'
            AND NOT EXISTS(SELECT 1 FROM progressive_publication_recoveries recovery WHERE recovery.unit_id=unit.id))
      ORDER BY job.id LIMIT 128`);
    const receipt = {
      inspectedJobs: jobs.length,
      queuedUnits: 0,
      skippedJobs: 0,
    };
    for (const job of jobs) {
      const executionId = String(job.id);
      const envelope = verifyProgressiveRemoteExecution(job.envelope, {
        executionId,
        solverId: String(job.solver_id),
        promiseId: String(job.promise_id),
        contentSignature: String(job.content_signature),
      });
      const [latest] =
        await connection.execute(sql`SELECT report,sequence,content_signature FROM progressive_remote_reports
        WHERE sim_job_id=${executionId}::uuid ORDER BY sequence DESC LIMIT 1`);
      const [stopped] = await connection.execute(
        sql`SELECT proof FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}::uuid`,
      );
      const [ready] = await connection.execute(sql`SELECT
        EXISTS(SELECT 1 FROM progressive_remote_report_sources WHERE sim_job_id=${executionId}::uuid) AS sources,
        EXISTS(SELECT 1 FROM progressive_remote_reports report WHERE sim_job_id=${executionId}::uuid AND NOT EXISTS(
          SELECT 1 FROM progressive_remote_progress_receipts applied WHERE applied.sim_job_id=report.sim_job_id AND applied.sequence=report.sequence)) AS pending,
        EXISTS(SELECT 1 FROM sim_jobs WHERE id=${executionId}::uuid AND ingest_lease_expires_at>clock_timestamp()) AS ingestion_owned`);
      if (
        !latest ||
        !stopped ||
        !ready.sources ||
        ready.pending ||
        ready.ingestion_owned
      ) {
        receipt.skippedJobs += 1;
        continue;
      }
      const validated = validateProgressiveRemoteReport(
        latest.report,
        envelope,
      );
      if (
        validated.contentSignature !== latest.content_signature ||
        !isFinalProgressiveRemoteReport(validated.report)
      )
        throw new Error(
          "Publication recovery has no immutable final source report",
        );
      await acknowledgeProgressiveCfdExecutionStop(connection, {
        simJobId: executionId,
        proof: stopped.proof as Parameters<
          typeof acknowledgeProgressiveCfdExecutionStop
        >[1]["proof"],
      });
      const units = await connection.execute(sql`
        SELECT unit.id,unit.active_seconds,unit.attempts,attempt.token FROM progressive_cfd_attempts attempt
        JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id JOIN progressive_work work ON work.id=unit.work_id
        JOIN progressive_generations generation ON generation.id=work.generation_id
        WHERE attempt.sim_job_id=${executionId}::uuid AND attempt.outcome='cancelled' AND unit.state='gap'
          AND unit.lease_token IS NULL AND unit.lease_owner IS NULL AND unit.lease_until IS NULL
          AND unit.active_seconds<unit.active_budget_seconds AND unit.attempts BETWEEN 1 AND 2
          AND generation.epoch_id=${epoch.id}::uuid AND generation.campaign_id=${campaignId}::uuid
          AND generation.plan_revision_id=${campaign.current_plan_revision_id} AND generation.status='active'
          AND generation.stage=2 AND work.stage=2 AND work.state='pending'
          AND NOT EXISTS(SELECT 1 FROM progressive_cfd_attempts newer WHERE newer.unit_id=unit.id AND newer.started_at>attempt.started_at)
          AND NOT EXISTS(SELECT 1 FROM progressive_cfd_attempts running WHERE running.unit_id=unit.id AND running.outcome='running')
          AND NOT EXISTS(SELECT 1 FROM progressive_cfd_recovery_plans numerical WHERE numerical.unit_id=unit.id)
          AND NOT EXISTS(SELECT 1 FROM progressive_publication_recoveries recovery WHERE recovery.unit_id=unit.id)
        ORDER BY unit.id FOR UPDATE OF generation,work,unit,attempt`);
      for (const unit of units) {
        await connection.execute(sql`INSERT INTO progressive_publication_recoveries
          (unit_id,predecessor_attempt_token,sim_job_id,report_sequence,report_signature,cancellation,active_seconds,attempts_before)
          VALUES(${unit.id}::uuid,${unit.token}::uuid,${executionId}::uuid,${latest.sequence},${validated.contentSignature},
            ${JSON.stringify(job.cancellation)}::jsonb,${unit.active_seconds},${unit.attempts})`);
        await connection.execute(sql`UPDATE progressive_cfd_units SET state='pending',error='One corrective retry for lost publication; prior measured budget retained'
          WHERE id=${unit.id}::uuid`);
        receipt.queuedUnits += 1;
      }
      if (!units.length) receipt.skippedJobs += 1;
    }
    return receipt;
  });
}
