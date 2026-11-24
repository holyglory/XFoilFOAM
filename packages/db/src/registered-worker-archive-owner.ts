import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";

export async function registeredWorkerArchiveOwner(
  db: DB,
  executionId: string,
) {
  const [owned] = await db.execute(sql`
    SELECT settings.instance_id::text AS worker_instance, settings.remote_solver_registered_id AS solver_id,
      settings.remote_solver_auth_token AS auth_token, settings.upstream_base_url,
      promise.id AS promise_id, promise.source_base_url, job.request_payload
    FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.id = ${executionId}::uuid AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
  `);
  if (!owned)
    throw new Error("This registered worker does not own the report execution");
  const baseUrl = canonicalRemoteHubBaseUrl(
    String(owned.upstream_base_url ?? ""),
  );
  const payload = owned.request_payload as Record<string, unknown>;
  const authToken = String(owned.auth_token ?? "");
  if (
    !authToken ||
    baseUrl !== owned.source_base_url ||
    baseUrl !== payload.upstreamBaseUrl
  )
    throw new Error(
      "Worker report archive has no matching authenticated upstream",
    );
  const raw = payload.remoteProgressiveExecution as
    | Record<string, unknown>
    | undefined;
  const envelope = verifyProgressiveRemoteExecution(raw, {
    executionId,
    solverId: String(owned.solver_id),
    promiseId: String(owned.promise_id),
    contentSignature: String(raw?.contentSignature ?? ""),
  });
  // Historical reads deliberately ignore pause, enabled and live lease state.
  // The stored assignment and trusted upstream still have to match exactly.
  return { baseUrl, authToken, envelope, workerInstance: String(owned.worker_instance) };
}
