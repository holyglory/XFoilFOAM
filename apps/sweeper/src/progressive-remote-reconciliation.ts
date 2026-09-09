import { sql } from "drizzle-orm";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import { settleProgressiveWorkerFinalReport, type DB } from "@aerodb/db";
import {
  ENGINE_SUBMIT_TIMEOUT_MS,
  type EngineClient,
} from "@aerodb/engine-client";
import {
  observeProgressiveRemoteJob,
  ProgressiveRemoteJobMissingError,
} from "./progressive-remote-observation";
import {
  activeReconcileJobLimit,
  activeReconcileConcurrency,
  runWithConcurrency,
} from "./reconcile";

export async function reconcileProgressiveRemoteWorker(
  db: DB,
  engine: EngineClient,
  options: { jobIds?: string[]; limit?: number; fetcher?: typeof fetch } = {},
) {
  const limit = options.limit ?? activeReconcileJobLimit();
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 64 ||
    (options.jobIds &&
      (options.jobIds.length > 64 ||
        new Set(options.jobIds).size !== options.jobIds.length))
  )
    throw new Error("Invalid progressive remote reconciliation scope");
  const receipt = {
    inspected: 0,
    reported: 0,
    stopped: 0,
    errors: [] as Array<{ executionId: string; error: string }>,
  };
  if (options.jobIds?.length === 0) return receipt;
  const finalMirrors = await db.execute(sql`
    SELECT job.id FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.request_payload->>'remoteSolver' = 'true' AND job.request_payload ? 'remoteProgressiveExecution'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = job.request_payload->>'upstreamBaseUrl'
      AND (job.status IN ('pending', 'submitted', 'running', 'ingesting') OR job.engine_state IN ('cancelling', 'cancel_pending'))
      AND EXISTS (SELECT 1 FROM progressive_worker_reports report WHERE report.sim_job_id = job.id
        AND report.report#>>'{stopProof,execution_stopped}' = 'true'
        AND report.report#>>'{stopProof,job_id}' = job.id::text)
      ${
        options.jobIds
          ? sql`AND job.id IN (${sql.join(
              options.jobIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``
      }
    ORDER BY job."updatedAt", job.id LIMIT ${limit}
  `);
  await runWithConcurrency(
    finalMirrors,
    activeReconcileConcurrency(),
    async (job) => {
      const executionId = String(job.id);
      try {
        if (await settleProgressiveWorkerFinalReport(db, executionId)) {
          receipt.inspected += 1;
          receipt.stopped += 1;
        }
      } catch (error) {
        receipt.errors.push({
          executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  const candidates = await db.execute(sql`
    SELECT job.id, job.engine_job_id, job.request_payload,
      coalesce(intent.assignment_signature, job.request_payload#>>'{remoteProgressiveExecution,contentSignature}') AS assignment_signature,
      settings.remote_solver_auth_token AS auth_token, settings.upstream_base_url,
      promise.source_base_url,
      (NOT settings.remote_solver_enabled OR job.status = 'cancelled'
        OR promise.status <> 'active' OR promise."expiresAt" <= clock_timestamp()) AS stop_required
    FROM sim_jobs job LEFT JOIN progressive_worker_submission_intents intent ON intent.sim_job_id = job.id
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.request_payload->>'remoteSolver' = 'true' AND NOT settings.remote_solver_transfer_paused
      AND job.request_payload ? 'remoteProgressiveExecution'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND (job.engine_job_id IS NOT NULL OR intent.created_at <= clock_timestamp() - ${120000 + ENGINE_SUBMIT_TIMEOUT_MS} * interval '1 millisecond'
        OR NOT settings.remote_solver_enabled OR job.status IN ('done', 'failed', 'cancelled')
        OR promise.status <> 'active' OR promise."expiresAt" <= clock_timestamp())
      AND ((job.engine_job_id IS NOT NULL AND job.engine_job_id <> job.id::text) OR NOT EXISTS (
        SELECT 1 FROM progressive_worker_reports report WHERE report.sim_job_id = job.id
          AND report.report#>>'{stopProof,job_id}' = job.id::text
          AND report.report#>>'{stopProof,execution_stopped}' = 'true'
          AND (report.report#>>'{stopProof,ownership_basis}' = 'never_started_cancellation_fence'
            OR report.report#>>'{result,state}' IN ('completed', 'failed', 'cancelled')
            OR (report.report->'result' = 'null'::jsonb AND report.report#>>'{status,state}' = 'failed'
              AND report.report#>>'{status,total_cases}' = '0' AND report.report#>>'{status,completed_cases}' = '0'
              AND report.report#>>'{status,failure_disposition}' IN ('deterministic_mesh', 'infrastructure')))
          AND report.report->>'assignmentSignature' = coalesce(intent.assignment_signature, job.request_payload#>>'{remoteProgressiveExecution,contentSignature}')))
      ${
        options.jobIds
          ? sql`AND job.id IN (${sql.join(
              options.jobIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`
          : sql``
      }
    ORDER BY job."updatedAt", job.id LIMIT ${limit}
  `);
  await runWithConcurrency(
    candidates,
    activeReconcileConcurrency(),
    async (candidate) => {
      const executionId = String(candidate.id);
      receipt.inspected += 1;
      try {
        if (
          candidate.engine_job_id !== null &&
          candidate.engine_job_id !== executionId
        )
          throw new Error(
            "Foreign engine identity requires explicit reconciliation; CPU ownership is retained",
          );
        const payload = candidate.request_payload as Record<string, unknown>;
        const baseUrl = canonicalRemoteHubBaseUrl(
          String(candidate.upstream_base_url ?? ""),
        );
        if (
          baseUrl !== candidate.source_base_url ||
          baseUrl !== payload.upstreamBaseUrl
        )
          throw new Error(
            "Progressive observation upstream differs from the registered assignment",
          );
        let stop = Boolean(candidate.stop_required);
        if (!stop) {
          try {
            if (!candidate.auth_token)
              throw new Error(
                "The registered worker credential is unavailable",
              );
            const response = await (options.fetcher ?? fetch)(
              `${baseUrl}/progressive-executions/${executionId}/control`,
              {
                headers: {
                  "x-xfoilfoam-solver-token": String(candidate.auth_token),
                },
                redirect: "error",
                signal: AbortSignal.timeout(10000),
              },
            );
            if ([401, 403, 404].includes(response.status)) stop = true;
            else {
              if (!response.ok)
                throw new Error(
                  `Progressive continuation control failed (${response.status})`,
                );
              const body = (await response.json()) as {
                executionId?: unknown;
                contentSignature?: unknown;
                continuation?: { kind?: unknown };
              } | null;
              if (
                body?.executionId !== executionId ||
                body.contentSignature !== candidate.assignment_signature ||
                !["continue", "stop"].includes(String(body.continuation?.kind))
              )
                throw new Error(
                  "The hub returned invalid exact-execution continuation control",
                );
              stop = body.continuation?.kind === "stop";
            }
          } catch (error) {
            receipt.errors.push({
              executionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        let observed;
        try {
          observed = await observeProgressiveRemoteJob(
            db,
            engine,
            executionId,
            {
              stop,
            },
          );
        } catch (error) {
          if (stop || !(error instanceof ProgressiveRemoteJobMissingError))
            throw error;
          observed = await observeProgressiveRemoteJob(
            db,
            engine,
            executionId,
            {
              stop: true,
            },
          );
        }
        if (!observed.replayed) receipt.reported += 1;
        if (observed.stopped) receipt.stopped += 1;
      } catch (error) {
        receipt.errors.push({
          executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        try {
          await db.execute(
            sql`UPDATE sim_jobs SET "updatedAt" = clock_timestamp() WHERE id = ${executionId}::uuid`,
          );
        } catch (error) {
          receipt.errors.push({
            executionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    },
  );
  return receipt;
}
