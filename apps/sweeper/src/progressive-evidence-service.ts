import type { DB, Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";
import { runNotificationDrain } from "./notification-drain";
import { deliverNextProgressiveWorkerEvidence } from "./progressive-worker-evidence-delivery";
import { stageNextProgressiveWorkerEvidence } from "./progressive-worker-evidence";

export function progressiveEvidenceDrain(
  stage: (preferActive: boolean) => Promise<boolean>,
  deliver: (preferActive: boolean) => Promise<boolean>,
) {
  let preferActive = true;
  return async () => {
    const preference = preferActive;
    preferActive = !preferActive;
    let progress = false;
    const errors: unknown[] = [];
    for (const operation of [stage, deliver]) {
      try {
        progress = (await operation(preference)) || progress;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "Progressive evidence pass has retryable or conflicting work",
      );
    return progress;
  };
}

export async function nextProgressiveEvidenceWakeAt(
  db: DB,
): Promise<Date | null> {
  const [pending] = await db.execute(sql`
    WITH owned_reports AS (
      SELECT report.sim_job_id, report.sequence, job.ingest_lease_expires_at
      FROM progressive_worker_reports report JOIN sim_jobs job ON job.id = report.sim_job_id
      JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
      JOIN sync_api_settings settings ON settings.id = 1
      WHERE report.acknowledged_at IS NOT NULL AND jsonb_typeof(report.report->'result') = 'object'
        AND NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
        AND settings.upstream_base_url IS NOT NULL AND job.request_payload->>'remoteSolver' = 'true'
        AND promise.registered_solver_id = settings.remote_solver_registered_id
        AND promise.source_base_url = settings.upstream_base_url
        AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
    )
    SELECT min(wake_at) AS wake_at FROM (
      SELECT owned.ingest_lease_expires_at AS wake_at FROM owned_reports owned
      WHERE owned.ingest_lease_expires_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts staged
          WHERE staged.sim_job_id = owned.sim_job_id AND staged.sequence = owned.sequence)
      UNION ALL
      SELECT failure.retry_after FROM owned_reports owned
      JOIN progressive_worker_staging_failures failure ON failure.sim_job_id = owned.sim_job_id AND failure.sequence = owned.sequence
      WHERE failure.retry_after > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts staged
          WHERE staged.sim_job_id = owned.sim_job_id AND staged.sequence = owned.sequence)
      UNION ALL
      SELECT failure.retry_after FROM owned_reports owned
      JOIN progressive_worker_delivery_failures failure ON failure.sim_job_id = owned.sim_job_id AND failure.sequence = owned.sequence
      WHERE failure.state = 'retry' AND failure.retry_after > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_hub_receipts delivered
          WHERE delivered.sim_job_id = failure.sim_job_id AND delivered.point_content_signature = failure.point_content_signature)
    ) pending
  `);
  return pending?.wake_at == null
    ? null
    : pending.wake_at instanceof Date
      ? pending.wake_at
      : new Date(String(pending.wake_at));
}

export async function runProgressiveEvidenceService(
  db: DB,
  notifications: Pick<Sql, "listen">,
  engine: EngineClient,
  signal: AbortSignal,
  options: {
    drain?: () => Promise<boolean>;
    nextWakeAt?: () => Promise<Date | null>;
    reportError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  await runNotificationDrain(
    notifications,
    "progressive_worker_evidence_changed",
    signal,
    {
      drain:
        options.drain ??
        progressiveEvidenceDrain(
          (preferActive) =>
            stageNextProgressiveWorkerEvidence(db, engine, { preferActive }),
          (preferActive) =>
            deliverNextProgressiveWorkerEvidence(db, fetch, { preferActive }),
        ),
      nextWakeAt:
        options.nextWakeAt ?? (() => nextProgressiveEvidenceWakeAt(db)),
      reportError:
        options.reportError ??
        ((error) =>
          console.error(
            "[sweeper] progressive compact evidence delivery failed:",
            error instanceof Error ? error.message : String(error),
          )),
    },
  );
}
