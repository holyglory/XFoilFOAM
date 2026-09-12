import { type DB, solverCpuReservationSql } from "@aerodb/db";
import { sql } from "drizzle-orm";

export async function recordInactiveStoppedPromise(
  db: DB,
  source: {
    executionId: string;
    promiseId: string;
    solverId: string;
    upstreamBaseUrl: string;
    token: string;
  },
  response: { status: number; error?: unknown },
): Promise<boolean> {
  if (response.status !== 409 || response.error !== "promise is not active")
    return false;
  return db.transaction(async (transaction) => {
    await transaction.execute(
      sql`SELECT id FROM sweeper_state WHERE id=1 FOR UPDATE`,
    );
    const [owned] =
      await transaction.execute(sql`SELECT promise.id FROM sync_sweep_promises promise
      JOIN sim_jobs source_job ON source_job.id=${source.executionId}::uuid
        AND source_job.request_payload->>'syncPromiseId'=promise.id::text
      JOIN sync_api_settings settings ON settings.id=1
      WHERE promise.id=${source.promiseId}::uuid AND promise.status IN ('active','expired')
        AND promise.registered_solver_id=${source.solverId}::uuid AND promise.registered_solver_id=settings.remote_solver_registered_id
        AND promise.source_base_url=${source.upstreamBaseUrl} AND promise.source_base_url=settings.upstream_base_url
        AND source_job.request_payload->>'upstreamBaseUrl'=settings.upstream_base_url
        AND source_job.request_payload->>'remoteSolver'='true' AND source_job.request_payload ? 'remoteProgressiveExecution'
        AND settings.remote_solver_auth_token=${source.token} AND settings.remote_solver_auth_token<>''
        AND NOT EXISTS(SELECT 1 FROM sim_jobs job WHERE job.request_payload->>'syncPromiseId'=promise.id::text
          AND (coalesce(${solverCpuReservationSql("job")},false) OR job.engine_job_id IS DISTINCT FROM job.id::text
            OR NOT EXISTS(SELECT 1 FROM progressive_worker_reports report
              JOIN progressive_worker_submission_intents intent ON intent.sim_job_id=report.sim_job_id
                AND intent.assignment_signature=report.assignment_signature
              WHERE report.sim_job_id=job.id AND report.stopped_engine_job_id=job.id::text AND report.acknowledged_at IS NOT NULL)))
      FOR UPDATE OF promise`);
    if (!owned) return false;
    await transaction.execute(sql`UPDATE sync_sweep_promises SET status='cancelled',"cancelledAt"=clock_timestamp(),"updatedAt"=clock_timestamp(),
      response_payload=coalesce(response_payload,'{}'::jsonb)||jsonb_build_object('authoritativeLeaseLoss',true,'error','Hub rejected the inactive promise after all local executions stopped')
      WHERE id=${source.promiseId}::uuid AND status IN ('active','expired')`);
    await transaction.execute(sql`UPDATE sync_sweep_promise_points SET status='cancelled',"updatedAt"=clock_timestamp()
      WHERE promise_id=${source.promiseId}::uuid AND status='active'`);
    return true;
  });
}
