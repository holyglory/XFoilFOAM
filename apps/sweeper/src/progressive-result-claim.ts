import { sql } from "drizzle-orm";

export interface ProgressiveResultClaimUnit {
  id: string;
  alpha: number;
  token: string;
}

export function progressiveRetryClaimSql(
  unit: ProgressiveResultClaimUnit | undefined,
  simJobId: string,
) {
  if (!unit) return sql`false`;
  return sql`(
    results.status IN ('failed', 'pending', 'stale')
    AND NOT EXISTS (SELECT 1 FROM result_classifications classification
      WHERE classification.result_id = results.id AND classification.state = 'accepted')
    AND EXISTS (
      SELECT 1 FROM progressive_cfd_units owned
      JOIN progressive_cfd_attempts current_attempt ON current_attempt.unit_id = owned.id
        AND current_attempt.token = owned.lease_token
      JOIN progressive_cfd_attempts previous ON previous.unit_id = owned.id
        AND previous.token <> current_attempt.token AND previous.outcome IN ('failed', 'expired', 'cancelled')
      JOIN sim_jobs previous_job ON previous_job.id = previous.sim_job_id
      JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = previous_job.id
        AND stopped.engine_job_id = previous_job.engine_job_id
      WHERE owned.id = ${unit.id}::uuid AND owned.aoa_deg = ${unit.alpha}
        AND owned.state = 'leased' AND owned.lease_until > clock_timestamp()
        AND current_attempt.token = ${unit.token}::uuid AND current_attempt.outcome = 'running'
        AND (current_attempt.sim_job_id IS NULL OR current_attempt.sim_job_id = ${simJobId}::uuid)
        AND previous_job.status IN ('done', 'failed', 'cancelled') AND previous_job."ingestedAt" IS NOT NULL
        AND (results.sim_job_id = previous_job.id OR (results.sim_job_id IS NULL AND EXISTS (
          SELECT 1 FROM progressive_cfd_evidence receipt JOIN result_attempts raw ON raw.id = receipt.result_attempt_id
          WHERE receipt.attempt_token = previous.token AND raw.result_id = results.id
        )))
    )
  )`;
}
