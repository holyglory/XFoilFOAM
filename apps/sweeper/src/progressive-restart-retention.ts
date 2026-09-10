import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { assertProgressiveWorkerEvidenceJob } from "./progressive-remote-jobs";

export async function reclaimProgressiveRestartState(
  db: DB,
  engine: Pick<EngineClient, "stripJob">,
  executionId?: string,
) {
  if (
    executionId !== undefined &&
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(executionId)
  )
    throw new Error("Restart reclamation requires an exact execution UUID");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [state] =
      await connection.execute(sql`SELECT disk_admission_blocked FROM sweeper_state
      WHERE id=1 FOR UPDATE`);
    if (state?.disk_admission_blocked !== true)
      return { stripped: 0, bytesFreed: 0 };
    const candidates = await connection.execute(sql`
      SELECT job.id,report.sequence,report.report FROM sim_jobs job
      JOIN LATERAL (SELECT sequence,report FROM progressive_worker_reports
        WHERE sim_job_id=job.id ORDER BY sequence DESC LIMIT 1) report ON true
      WHERE job.status IN ('done','failed','cancelled') AND job.engine_job_id=job.id::text
        ${executionId ? sql`AND job.id=${executionId}::uuid` : sql``}
        AND job.request_payload ? 'remoteProgressiveExecution'
        AND (job.stripped_at IS NULL OR job.strip_report->>'kept_case_state'='true')
        AND (job.ingest_lease_expires_at IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
        AND report.report#>>'{stopProof,job_id}'=job.id::text
        AND report.report#>>'{stopProof,execution_stopped}'='true'
        AND report.report#>>'{result,state}' IN ('completed','failed','cancelled')
        AND NOT EXISTS (SELECT 1 FROM sim_jobs child WHERE child.status IN ('pending','submitted','running','ingesting')
          AND (child.parent_job_id=job.id OR child.request_payload#>>'{engineRequest,continue_from,engine_job_id}'=job.id::text))
        AND NOT EXISTS (SELECT 1 FROM sim_urans_requests request JOIN results result ON result.id=request.continue_from_result_id
          WHERE result.sim_job_id=job.id AND request.state IN ('pending','submitted','running','ingesting'))
        AND NOT EXISTS (SELECT 1 FROM sim_precalc_obligation_attempts source
          JOIN sim_precalc_obligations obligation ON obligation.id=source.obligation_id
          JOIN result_attempts attempt ON attempt.id=source.result_attempt_id
          WHERE attempt.sim_job_id=job.id AND obligation.state='running')
        AND NOT EXISTS (SELECT 1 FROM sim_urans_verify_queue verification
          JOIN result_attempts attempt ON attempt.id=verification.latest_result_attempt_id
          WHERE attempt.sim_job_id=job.id AND verification.state IN ('pending','running')
            AND verification.last_outcome IN ('continuation_pending','continuation_retry_wait'))
      ORDER BY job."updatedAt",job.id LIMIT 1 FOR UPDATE OF job SKIP LOCKED`);
    if (!candidates.length) return { stripped: 0, bytesFreed: 0 };
    const candidate = candidates[0];
    const id = String(candidate.id);
    const report = candidate.report as {
      result: Parameters<
        typeof assertProgressiveWorkerEvidenceJob
      >[1]["result"];
    };
    const owned = await assertProgressiveWorkerEvidenceJob(connection, {
      simJobId: id,
      engineJobId: id,
      reportSequence: Number(candidate.sequence),
      result: report.result,
    });
    if (!owned)
      throw new Error("Restart reclamation has no exact worker evidence owner");
    try {
      const receipt = await engine.stripJob(
        id,
        { keep_case_state: false },
        { timeoutMs: 30000 },
      );
      if (
        receipt.job_id !== id ||
        receipt.kept_case_state !== false ||
        !Array.isArray(receipt.unknown_entries) ||
        receipt.unknown_entries.some((entry) => typeof entry !== "string") ||
        !Number.isSafeInteger(receipt.bytes_freed) ||
        receipt.bytes_freed < 0
      )
        throw new Error(
          "Restart reclamation returned an invalid exact-job receipt",
        );
      const complete = receipt.unknown_entries!.length === 0;
      await connection.execute(sql`UPDATE sim_jobs SET strip_report=${JSON.stringify(receipt)}::jsonb,
        stripped_at=${complete ? sql`clock_timestamp()` : sql`NULL`},"updatedAt"=clock_timestamp()
        WHERE id=${id}::uuid`);
      return { stripped: complete ? 1 : 0, bytesFreed: receipt.bytes_freed };
    } catch (error) {
      await connection.execute(
        sql`UPDATE sim_jobs SET "updatedAt"=clock_timestamp() WHERE id=${id}::uuid`,
      );
      return {
        stripped: 0,
        bytesFreed: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
