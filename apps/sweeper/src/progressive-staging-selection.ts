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

export function progressiveStagingSelectionSql(preferActive: boolean) {
  const settings = sql`SELECT upstream_base_url, remote_solver_registered_id,
      remote_solver_transfer_paused, remote_solver_auth_token
    FROM sync_api_settings WHERE id = 1`;
  const report = (active: boolean, terminalOnly: boolean) => {
    const direction = active ? sql`DESC` : sql`ASC`;
    return sql`SELECT report.sim_job_id, report.sequence, report.created_at
      FROM progressive_worker_staging_candidates report
      CROSS JOIN settings
      LEFT JOIN progressive_worker_staging_failures failure
        ON failure.sim_job_id = report.sim_job_id AND failure.sequence = report.sequence
      WHERE NOT settings.remote_solver_transfer_paused
        AND settings.remote_solver_auth_token <> ''
        AND settings.upstream_base_url IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.progressive_worker_closed_staging_copies covered
          WHERE covered.sim_job_id=report.sim_job_id AND covered.sequence=report.sequence)
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_report_conflicts conflict
          WHERE conflict.sim_job_id = report.sim_job_id AND conflict.sequence = report.sequence)
        AND (failure.sim_job_id IS NULL OR failure.retry_after <= clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts receipt
          WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
        ${terminalOnly ? sql`AND report.stopped_engine_job_id = report.sim_job_id::text` : sql``}
        AND EXISTS (
          SELECT 1
          FROM sim_jobs job
          JOIN sync_sweep_promises promise
            ON promise.id::text = job.request_payload->>'syncPromiseId'
          WHERE job.id = report.sim_job_id
            AND job.request_payload->>'remoteSolver' = 'true'
            AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
            AND promise.registered_solver_id = settings.remote_solver_registered_id
            AND promise.source_base_url = settings.upstream_base_url
            AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
            ${active ? sql`AND promise.status = 'active' AND promise."expiresAt" > clock_timestamp()` : sql``}
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
  const active = sql`SELECT COALESCE(terminal.sim_job_id, fallback.sim_job_id) AS sim_job_id,
      COALESCE(terminal.sequence, fallback.sequence) AS sequence,
      COALESCE(terminal.created_at, fallback.created_at) AS created_at
    FROM (VALUES (1)) seed(value)
    LEFT JOIN LATERAL (${report(true, true)}) terminal ON true
    LEFT JOIN LATERAL (${report(true, false)}) fallback
      ON terminal.sim_job_id IS NULL
    WHERE terminal.sim_job_id IS NOT NULL OR fallback.sim_job_id IS NOT NULL
    ORDER BY (terminal.sim_job_id IS NOT NULL) DESC,
      COALESCE(terminal.created_at, fallback.created_at) DESC,
      COALESCE(terminal.sim_job_id, fallback.sim_job_id) DESC,
      COALESCE(terminal.sequence, fallback.sequence) DESC
    LIMIT 1`;
  return sql`WITH settings AS MATERIALIZED (${settings}),
    active AS MATERIALIZED (${active}), terminal AS MATERIALIZED (${terminal}),
    fallback AS MATERIALIZED (${fallback})
  SELECT sim_job_id, sequence, created_at FROM active
  UNION ALL SELECT sim_job_id, sequence, created_at FROM terminal
    WHERE NOT EXISTS (SELECT 1 FROM active)
  UNION ALL SELECT sim_job_id, sequence, created_at FROM fallback
    WHERE NOT EXISTS (SELECT 1 FROM active) AND NOT EXISTS (SELECT 1 FROM terminal)`;
}
