import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";

type StagingScan = {
  requested: number;
  emptyThrough: number;
  running: Promise<void> | null;
};
const stagingScans = new WeakMap<DB, Map<boolean, StagingScan>>();

// An empty scan answers only calls already waiting when that scan started.
// A successful claim belongs to one caller. Its ingestion proceeds independently.
export async function withStagingSelection<T>(
  db: DB,
  preferActive: boolean,
  scan: () => Promise<T | undefined>,
): Promise<T | undefined> {
  let lanes = stagingScans.get(db);
  if (!lanes) {
    lanes = new Map();
    stagingScans.set(db, lanes);
  }
  let lane = lanes.get(preferActive);
  if (!lane) {
    lane = { requested: 0, emptyThrough: 0, running: null };
    lanes.set(preferActive, lane);
  }
  const state = lane;
  const ticket = ++state.requested;
  while (state.running) {
    await state.running;
    if (ticket <= state.emptyThrough) return undefined;
  }
  const through = state.requested;
  const result = scan();
  state.running = result
    .then(
      (claimed) => {
        if (claimed === undefined) state.emptyThrough = through;
      },
      () => {
        /* The caller that selected the report records its failure. */
      },
    )
    .finally(() => {
      state.running = null;
    });
  return result;
}

// A hub can retain registration settings from an earlier deployment. The
// existing worker-job index also detects real retained work in that situation.
export async function hasRegisteredWorkerJob(db: DB): Promise<boolean> {
  const rows = await db.execute(sql`SELECT 1 FROM sync_api_settings settings
    WHERE settings.id=1 AND NOT settings.remote_solver_transfer_paused
      AND settings.remote_solver_auth_token<>'' AND settings.remote_solver_registered_id IS NOT NULL
      AND settings.upstream_base_url IS NOT NULL AND EXISTS (
        SELECT 1 FROM sim_jobs job WHERE job.request_payload->>'remoteSolver'='true'
          AND job.request_payload->>'upstreamBaseUrl'=settings.upstream_base_url
      )`);
  return rows.length > 0;
}

// Probe the ordinary receipt first. Keep the protected closed-copy lookup
// correlated to the same job and sequence in both selection and wake queries.
export const workerReportWithoutStagingProof = sql`NOT EXISTS (
  SELECT 1 FROM progressive_worker_evidence_receipts receipt
    WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence
  UNION ALL
  SELECT 1 FROM public.progressive_worker_closed_staging_copies covered
    WHERE covered.sim_job_id = report.sim_job_id AND covered.sequence = report.sequence)`;

export function progressiveStagingSelectionSql(preferActive: boolean) {
  const settings = sql`SELECT upstream_base_url, remote_solver_registered_id,
      remote_solver_transfer_paused, remote_solver_auth_token
    FROM sync_api_settings WHERE id = 1`;
  const enabled = sql`NOT settings.remote_solver_transfer_paused
        AND settings.remote_solver_auth_token <> ''
        AND settings.upstream_base_url IS NOT NULL`;
  const outstanding = sql`${workerReportWithoutStagingProof}
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_report_conflicts conflict
          WHERE conflict.sim_job_id = report.sim_job_id AND conflict.sequence = report.sequence)
        AND (failure.sim_job_id IS NULL OR failure.retry_after <= clock_timestamp())`;
  const workerAt = (upstream = sql`settings.upstream_base_url`) =>
    sql`job.request_payload->>'remoteSolver' = 'true' AND job.request_payload->>'upstreamBaseUrl' = ${upstream}`;
  const registeredPromise = sql`promise.registered_solver_id = settings.remote_solver_registered_id
    AND promise.source_base_url = settings.upstream_base_url`;
  const leaseAvailable = sql`(job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())`;
  const livePromise = sql`promise.status = 'active' AND promise."expiresAt" > clock_timestamp()`;
  const failures = sql`LEFT JOIN progressive_worker_staging_failures failure
        ON failure.sim_job_id = report.sim_job_id AND failure.sequence = report.sequence`;
  const candidates = sql`progressive_worker_staging_candidates`;
  const report = (active: boolean, terminalOnly: boolean, source = candidates) => {
    const direction = active ? sql`DESC` : sql`ASC`;
    return sql`SELECT report.sim_job_id, report.sequence, report.created_at
      FROM ${source} report
      CROSS JOIN settings
      ${failures}
      WHERE ${enabled}
        AND ${outstanding}
        ${terminalOnly ? sql`AND report.stopped_engine_job_id = report.sim_job_id::text` : sql``}
        AND EXISTS (
          SELECT 1
          FROM sim_jobs job
          JOIN sync_sweep_promises promise
            ON promise.id::text = job.request_payload->>'syncPromiseId'
          WHERE job.id = report.sim_job_id AND ${workerAt()} AND ${registeredPromise} AND ${leaseAvailable}
            ${active ? sql`AND ${livePromise}` : sql``}
        )
      ORDER BY report.created_at ${direction}, report.sim_job_id ${direction}, report.sequence ${direction}
      LIMIT 1`;
  };
  const terminal = report(false, true);
  const fallback = report(false, false);
  if (!preferActive)
    return sql`WITH settings AS MATERIALIZED (${settings}),
        terminal AS MATERIALIZED (${terminal}), fallback AS MATERIALIZED (${fallback})
      SELECT sim_job_id, sequence, created_at FROM terminal
      UNION ALL SELECT sim_job_id, sequence, created_at FROM fallback
      WHERE NOT EXISTS (SELECT 1 FROM terminal)`;
  // A hit among the newest 256 keys is the global maximum in the same
  // (created_at, job, sequence) order. A miss still searches every active owner.
  const recentKeys = sql`SELECT sim_job_id, sequence, created_at FROM ${candidates}
    ORDER BY created_at DESC, sim_job_id DESC, sequence DESC LIMIT 256`;
  // Materialize the live promises first so the worker identity index can
  // seek (upstream URL, promise ID) for each one, including all of its jobs.
  const activePromises = sql`SELECT promise.id, settings.upstream_base_url
    FROM settings JOIN sync_sweep_promises promise ON ${registeredPromise}
    WHERE ${enabled} AND ${livePromise}`;
  const activeJobs = sql`SELECT job.id FROM active_promises promise
    JOIN sim_jobs job ON job.request_payload->>'syncPromiseId' = promise.id::text
    WHERE ${workerAt(sql`promise.upstream_base_url`)} AND ${leaseAvailable}`;
  const perOwner = sql`SELECT found.sim_job_id, found.sequence, found.created_at FROM active_jobs job
    CROSS JOIN LATERAL (
      SELECT report.sim_job_id, report.sequence, report.created_at FROM ${candidates} report
      ${failures}
      WHERE report.sim_job_id = job.id AND ${outstanding}
      ORDER BY report.created_at DESC, report.sequence DESC LIMIT 1
    ) found
    ORDER BY found.created_at DESC, found.sim_job_id DESC, found.sequence DESC LIMIT 1`;
  return sql`WITH settings AS MATERIALIZED (${settings}),
    active_terminal AS MATERIALIZED (${report(true, true)}),
    recent_keys AS MATERIALIZED (${recentKeys}),
    active_recent AS MATERIALIZED (${report(true, false, sql`recent_keys`)}),
    active_promises AS MATERIALIZED (${activePromises}), active_jobs AS MATERIALIZED (${activeJobs}),
    active_by_owner AS MATERIALIZED (${perOwner}),
    active AS MATERIALIZED (
      SELECT * FROM active_terminal
      UNION ALL SELECT * FROM active_recent WHERE NOT EXISTS (SELECT 1 FROM active_terminal)
      UNION ALL SELECT * FROM active_by_owner WHERE NOT EXISTS (SELECT 1 FROM active_terminal)
        AND NOT EXISTS (SELECT 1 FROM active_recent)
    ), terminal AS MATERIALIZED (${terminal}),
    fallback AS MATERIALIZED (${fallback})
  SELECT sim_job_id, sequence, created_at FROM active
  UNION ALL SELECT sim_job_id, sequence, created_at FROM terminal
    WHERE NOT EXISTS (SELECT 1 FROM active)
  UNION ALL SELECT sim_job_id, sequence, created_at FROM fallback
    WHERE NOT EXISTS (SELECT 1 FROM active) AND NOT EXISTS (SELECT 1 FROM terminal)`;
}
