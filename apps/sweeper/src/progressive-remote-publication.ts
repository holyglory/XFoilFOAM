import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  acknowledgeProgressiveWorkerReport,
  readPendingProgressiveWorkerReport,
  validateProgressiveRemoteReport,
  verifyProgressiveRemoteExecution,
  type DB,
} from "@aerodb/db";
import { sql } from "drizzle-orm";

export async function publishProgressiveWorkerReport(
  db: DB,
  executionId: string,
  fetcher: typeof fetch = fetch,
): Promise<
  { kind: "idle" | "paused" } | { kind: "published"; sequence: number }
> {
  const [owned] = await db.execute(sql`
    SELECT settings.remote_solver_registered_id AS solver_id, settings.remote_solver_auth_token AS auth_token,
      settings.remote_solver_transfer_paused AS paused, settings.upstream_base_url,
      promise.id AS promise_id, promise.source_base_url, job.request_payload
    FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.id = ${executionId}::uuid AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
  `);
  if (!owned)
    throw new Error("Report publication does not own this remote execution");
  if (owned.paused) return { kind: "paused" };
  const baseUrl = canonicalRemoteHubBaseUrl(
    String(owned.upstream_base_url ?? ""),
  );
  const payload = owned.request_payload as Record<string, unknown>;
  if (baseUrl !== owned.source_base_url || baseUrl !== payload.upstreamBaseUrl)
    throw new Error(
      "Report publication hub differs from the assigned upstream",
    );
  const authToken = String(owned.auth_token ?? "");
  if (!authToken)
    throw new Error(
      "Report publication requires the registered worker credential",
    );
  const pending = await readPendingProgressiveWorkerReport(db, {
    executionId,
    solverId: String(owned.solver_id),
  });
  if (!pending) return { kind: "idle" };
  const envelope = verifyProgressiveRemoteExecution(
    payload.remoteProgressiveExecution,
    {
      solverId: String(owned.solver_id),
      promiseId: String(owned.promise_id),
      executionId,
      contentSignature: pending.report.assignmentSignature,
    },
  );
  const validated = validateProgressiveRemoteReport(pending.report, envelope);
  if (validated.contentSignature !== pending.contentSignature)
    throw new Error(
      "Stored report bytes differ from their publication signature",
    );
  const response = await fetcher(
    `${baseUrl}/progressive-executions/${executionId}/reports`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xfoilfoam-solver-token": authToken,
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        promiseId: owned.promise_id,
        report: pending.report,
      }),
    },
  );
  if (!response.ok)
    throw new Error(`Remote report publication failed (${response.status})`);
  const body = (await response.json()) as {
    received?: unknown;
    receipt?: {
      executionId?: unknown;
      sequence?: unknown;
      contentSignature?: unknown;
      replayed?: unknown;
    };
  } | null;
  if (
    body?.received !== true ||
    body.receipt?.executionId !== executionId ||
    body.receipt.sequence !== pending.sequence ||
    body.receipt.contentSignature !== pending.contentSignature ||
    typeof body.receipt.replayed !== "boolean"
  )
    throw new Error("Hub did not acknowledge the exact durable report");
  await acknowledgeProgressiveWorkerReport(db, {
    executionId,
    solverId: String(owned.solver_id),
    sequence: pending.sequence,
    contentSignature: pending.contentSignature,
  });
  return { kind: "published", sequence: pending.sequence };
}

export async function publishNextProgressiveWorkerReport(
  db: DB,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const [pending] = await db.execute(sql`
    SELECT report.sim_job_id FROM progressive_worker_reports report
    JOIN sim_jobs job ON job.id = report.sim_job_id
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE report.acknowledged_at IS NULL AND NOT settings.remote_solver_transfer_paused
      AND settings.remote_solver_auth_token <> '' AND settings.upstream_base_url IS NOT NULL
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND report.report->>'solverId' = settings.remote_solver_registered_id::text
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
      AND job.request_payload->>'remoteSolver' = 'true'
    ORDER BY report.created_at, report.sim_job_id, report.sequence LIMIT 1
  `);
  if (!pending) return false;
  return (
    (
      await publishProgressiveWorkerReport(
        db,
        String(pending.sim_job_id),
        fetcher,
      )
    ).kind === "published"
  );
}
