import type { DB, Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";
import { runNotificationDrain } from "./notification-drain";
import { deliverNextProgressiveWorkerEvidence } from "./progressive-worker-evidence-delivery";
import { stageNextProgressiveWorkerEvidence } from "./progressive-worker-evidence";
import { runSweeperServices } from "./service-lifecycle";

const MAX_SEQUENTIAL_EVIDENCE_DELIVERIES = 8;
const MAX_PARALLEL_EVIDENCE_STAGES = 4;

export async function drainProgressiveWorkerEvidencePass(
  deliver: (preferActive: boolean) => Promise<boolean>,
  preferActive: boolean,
  maximum = MAX_SEQUENTIAL_EVIDENCE_DELIVERIES,
  signal?: AbortSignal,
): Promise<boolean> {
  let changed = false;
  for (let pass = 0; pass < maximum; pass += 1) {
    if (signal?.aborted) break;
    const delivered = await deliver(preferActive);
    changed ||= delivered;
    if (!delivered) break;
  }
  return changed;
}

export async function nextProgressiveEvidenceWakeAt(
  db: DB,
  scope: "staging" | "delivery" | "all" = "all",
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
      (SELECT clock_timestamp() AS wake_at
      FROM owned_reports owned
      WHERE ${scope !== "delivery"}
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts staged
          WHERE staged.sim_job_id = owned.sim_job_id AND staged.sequence = owned.sequence)
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_staging_failures failure
          WHERE failure.sim_job_id = owned.sim_job_id AND failure.sequence = owned.sequence
            AND failure.retry_after > clock_timestamp())
      LIMIT 1)
      UNION ALL
      (SELECT clock_timestamp() AS wake_at
      FROM owned_reports owned
      JOIN progressive_worker_evidence_receipts staged
        ON staged.sim_job_id = owned.sim_job_id AND staged.sequence = owned.sequence
      JOIN progressive_worker_evidence_attempts association
        ON association.sim_job_id = staged.sim_job_id AND association.sequence = staged.sequence
      WHERE ${scope !== "staging"} AND NOT EXISTS (SELECT 1 FROM progressive_worker_hub_receipts delivered
        WHERE delivered.sim_job_id = association.sim_job_id
          AND delivered.point_content_signature = association.point_content_signature)
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_delivery_failures failure
          WHERE failure.sim_job_id = association.sim_job_id
            AND failure.point_content_signature = association.point_content_signature)
      LIMIT 1)
      UNION ALL
      SELECT owned.ingest_lease_expires_at AS wake_at FROM owned_reports owned
      WHERE ${scope !== "delivery"} AND owned.ingest_lease_expires_at > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts staged
          WHERE staged.sim_job_id = owned.sim_job_id AND staged.sequence = owned.sequence)
      UNION ALL
      SELECT failure.retry_after FROM owned_reports owned
      JOIN progressive_worker_staging_failures failure ON failure.sim_job_id = owned.sim_job_id AND failure.sequence = owned.sequence
      WHERE ${scope !== "delivery"} AND failure.retry_after > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_evidence_receipts staged
          WHERE staged.sim_job_id = owned.sim_job_id AND staged.sequence = owned.sequence)
      UNION ALL
      SELECT failure.retry_after FROM owned_reports owned
      JOIN progressive_worker_delivery_failures failure ON failure.sim_job_id = owned.sim_job_id AND failure.sequence = owned.sequence
      WHERE ${scope !== "staging"} AND failure.state = 'retry' AND failure.retry_after > clock_timestamp()
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_hub_receipts delivered
          WHERE delivered.sim_job_id = failure.sim_job_id AND delivered.point_content_signature = failure.point_content_signature)
      UNION ALL
      SELECT clock_timestamp() AS wake_at FROM owned_reports owned
      JOIN progressive_worker_delivery_failures failure ON failure.sim_job_id = owned.sim_job_id
        AND failure.sequence = owned.sequence
      WHERE ${scope !== "staging"} AND failure.state = 'retry' AND failure.retry_after <= clock_timestamp()
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
    stage?: (preferActive: boolean) => Promise<boolean>;
    deliver?: (preferActive: boolean) => Promise<boolean>;
    nextWakeAt?: (scope: "staging" | "delivery") => Promise<Date | null>;
    reportError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const stage =
    options.stage ??
    ((preferActive: boolean) =>
      stageNextProgressiveWorkerEvidence(db, engine, { preferActive }));
  const deliver =
    options.deliver ??
    ((preferActive: boolean) =>
      deliverNextProgressiveWorkerEvidence(db, fetch, { preferActive }));
  const service = (scope: "staging" | "delivery", lane: number) => ({
    name: `progressive-evidence-${scope}-${lane}`,
    run: async (childSignal: AbortSignal) => {
      let preferActive = lane % 2 === 0;
      await runNotificationDrain(
        notifications,
        "progressive_worker_evidence_changed",
        childSignal,
        {
          drain: async () => {
            const preference = preferActive;
            preferActive = !preferActive;
            return scope === "staging"
              ? stage(preference)
              : drainProgressiveWorkerEvidencePass(
                  deliver,
                  preference,
                  MAX_SEQUENTIAL_EVIDENCE_DELIVERIES,
                  childSignal,
                );
          },
          nextWakeAt: () =>
            options.nextWakeAt
              ? options.nextWakeAt(scope)
              : nextProgressiveEvidenceWakeAt(db, scope),
          reportError:
            options.reportError ??
            ((error) =>
              console.error(
                `[sweeper] progressive evidence ${scope} failed:`,
                error instanceof Error ? error.message : String(error),
              )),
        },
      );
    },
  });
  await runSweeperServices(signal, [
    ...Array.from({ length: MAX_PARALLEL_EVIDENCE_STAGES }, (_, lane) =>
      service("staging", lane),
    ),
    service("delivery", 0),
  ]);
}
