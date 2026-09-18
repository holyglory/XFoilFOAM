import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";

const stoppedOwner = sql`
  FROM sim_jobs job
  JOIN sync_sweep_promises promise ON promise.id::text=job.request_payload->>'syncPromiseId'
  JOIN sync_api_settings settings ON settings.id=1
  WHERE job.request_payload->>'remoteSolver'='true'
    AND job.request_payload ? 'remoteProgressiveExecution'
    AND job.engine_job_id=job.id::text AND job.status IN ('done','failed','cancelled')
    AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
    AND promise.status = 'cancelled'
    AND promise.registered_solver_id=settings.remote_solver_registered_id
    AND promise.source_base_url=settings.upstream_base_url
    AND job.request_payload->>'upstreamBaseUrl'=settings.upstream_base_url
    AND NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token<>''
    AND EXISTS (SELECT 1 FROM progressive_worker_reports report
      JOIN progressive_worker_submission_intents intent ON intent.sim_job_id=report.sim_job_id
        AND intent.assignment_signature=report.assignment_signature
      WHERE report.sim_job_id=job.id AND report.stopped_engine_job_id=job.id::text
        AND report.acknowledged_at IS NOT NULL AND jsonb_typeof(report.report->'result')='object')
`;

export async function progressiveStoppedStorageEligible(
  db: DB,
  executionId: string,
): Promise<boolean> {
  const rows = await db.execute(
    sql`SELECT job.id ${stoppedOwner} AND job.id=${executionId}::uuid`,
  );
  return rows.length === 1;
}

export async function requeueStoppedProgressiveStorage(
  db: DB,
): Promise<number> {
  const rows = await db.execute(sql`
    WITH candidates AS (
      SELECT failure.sim_job_id,failure.point_content_signature FROM progressive_worker_delivery_failures failure
      WHERE failure.state='conflict' AND failure.last_http_status=409
        AND failure.last_error='Progressive evidence delivery failed (409)'
        AND failure.remote_conflict_ids='[]'::jsonb
        AND EXISTS (SELECT 1 ${stoppedOwner} AND job.id=failure.sim_job_id
          AND promise.response_payload->>'authoritativeLeaseLoss'='true')
      ORDER BY failure.updated_at,failure.sim_job_id,failure.point_content_signature LIMIT 16
      FOR UPDATE OF failure SKIP LOCKED
    )
    UPDATE progressive_worker_delivery_failures failure SET state='retry',retry_after=clock_timestamp(),
      last_error='Closed assignment retained-source storage retry queued',updated_at=clock_timestamp()
    FROM candidates WHERE failure.sim_job_id=candidates.sim_job_id
      AND failure.point_content_signature=candidates.point_content_signature RETURNING failure.sim_job_id
  `);
  return rows.length;
}
