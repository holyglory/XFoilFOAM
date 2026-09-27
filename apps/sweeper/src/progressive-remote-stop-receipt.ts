import {
  acknowledgeProgressiveCfdExecutionStop,
  canonicalAnalysisJson,
  validateProgressiveRemoteReport,
  verifyProgressiveRemoteExecution,
  type DB,
} from "@aerodb/db";
import { sql } from "drizzle-orm";

export async function acknowledgeLatestProgressiveRemoteStop(
  db: DB,
  executionId: string,
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [dispatch] = await connection.execute(sql`
      SELECT envelope, content_signature, solver_id, promise_id FROM progressive_remote_dispatches
      WHERE sim_job_id = ${executionId}::uuid
    `);
    if (!dispatch) throw new Error("Remote stop has no exact dispatch owner");
    const envelope = verifyProgressiveRemoteExecution(dispatch.envelope, {
      executionId,
      solverId: String(dispatch.solver_id),
      promiseId: String(dispatch.promise_id),
      contentSignature: String(dispatch.content_signature),
    });
    await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE id = ${envelope.scope.epochId}::uuid FOR SHARE`,
    );
    await connection.execute(sql`SELECT campaign.id FROM sim_campaigns campaign JOIN sim_jobs job ON job.campaign_id = campaign.id
      WHERE job.id = ${executionId}::uuid FOR UPDATE OF campaign`);
    const [job] = await connection.execute(
      sql`SELECT engine_job_id, request_payload FROM sim_jobs WHERE id = ${executionId}::uuid FOR UPDATE`,
    );
    const payload = job?.request_payload as Record<string, unknown> | undefined;
    if (
      !job ||
      (job.engine_job_id !== null && job.engine_job_id !== executionId) ||
      canonicalAnalysisJson(payload?.engineRequest) !==
        canonicalAnalysisJson(envelope.request) ||
      canonicalAnalysisJson(payload?.progressive) !==
        canonicalAnalysisJson(envelope.scope)
    )
      throw new Error(
        "Remote stop conflicts with immutable hub execution ownership",
      );
    const [stored] = await connection.execute(sql`
      SELECT report, content_signature FROM progressive_remote_reports WHERE sim_job_id = ${executionId}::uuid
      ORDER BY sequence DESC LIMIT 1
    `);
    if (!stored) return false;
    const validated = validateProgressiveRemoteReport(stored.report, envelope);
    if (validated.contentSignature !== stored.content_signature)
      throw new Error(
        "Remote stop report bytes differ from their immutable receipt",
      );
    if (!validated.report.stopProof) return false;
    if (
      validated.report.stopProof.ownership_basis ===
      "never_started_cancellation_fence"
    ) {
      const [prior] = await connection.execute(sql`
        SELECT EXISTS (SELECT 1 FROM progressive_remote_reports report
          CROSS JOIN LATERAL jsonb_array_elements(coalesce(report.report#>'{status,solver_budget_progress,cases}', '[]'::jsonb)) sample
          WHERE report.sim_job_id = ${executionId}::uuid AND (sample->>'solver_active_seconds')::double precision > 0) AS used
      `);
      if (prior.used)
        throw new Error(
          "Never-started stop conflicts with retained active-time reports",
        );
    }
    await connection.execute(
      sql`UPDATE sim_jobs SET engine_job_id = ${executionId} WHERE id = ${executionId}::uuid AND engine_job_id IS NULL`,
    );
    const receipt = await acknowledgeProgressiveCfdExecutionStop(connection, {
      simJobId: executionId,
      proof: validated.report.stopProof,
    });
    return !receipt.replayed;
  });
}

export async function acknowledgeProgressiveRemoteStops(db: DB) {
  const candidates = await db.execute(sql`
    SELECT dispatch.sim_job_id FROM progressive_remote_dispatches dispatch
    WHERE NOT EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
      WHERE stopped.sim_job_id = dispatch.sim_job_id AND stopped.engine_job_id = dispatch.sim_job_id::text)
      AND EXISTS (SELECT 1 FROM progressive_remote_reports report WHERE report.sim_job_id = dispatch.sim_job_id
        AND report.report#>>'{stopProof,execution_stopped}' = 'true')
    ORDER BY dispatch.sim_job_id LIMIT 96
  `);
  const receipt = {
    acknowledged: 0,
    errors: [] as Array<{ executionId: string; error: string }>,
  };
  for (const candidate of candidates) {
    const executionId = String(candidate.sim_job_id);
    try {
      if (await acknowledgeLatestProgressiveRemoteStop(db, executionId))
        receipt.acknowledged++;
    } catch (error) {
      receipt.errors.push({
        executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return receipt;
}
