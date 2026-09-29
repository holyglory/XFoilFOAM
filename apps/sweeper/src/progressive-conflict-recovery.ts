import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";
import { recordProgressiveWorkerEvidenceReceipt } from "./progressive-worker-evidence-delivery";

export async function reopenResolvedProgressiveConflicts(
  db: DB,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const candidates = await db.execute(sql`
    SELECT failure.sim_job_id, failure.point_content_signature, failure.remote_conflict_ids,
      settings.upstream_base_url, settings.remote_solver_auth_token,
      failure.result_attempt_id, attempt.result_id, delivered.receipt
    FROM progressive_worker_delivery_failures failure
    JOIN sim_jobs job ON job.id = failure.sim_job_id
    JOIN result_attempts attempt ON attempt.id = failure.result_attempt_id
    LEFT JOIN progressive_worker_hub_receipts delivered ON delivered.sim_job_id = failure.sim_job_id
      AND delivered.point_content_signature = failure.point_content_signature
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE (delivered.sim_job_id IS NOT NULL OR (
      failure.state = 'conflict' AND failure.last_http_status = 200
      AND jsonb_array_length(failure.remote_conflict_ids) > 0
      AND failure.updated_at <= clock_timestamp() - interval '5 minutes'))
      AND NOT settings.remote_solver_transfer_paused AND settings.remote_solver_auth_token <> ''
      AND settings.upstream_base_url IS NOT NULL
      AND job.request_payload->>'remoteSolver' = 'true'
      AND job.request_payload ? 'remoteProgressiveExecution'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
    ORDER BY failure.updated_at, failure.sim_job_id, failure.point_content_signature LIMIT 16
  `);
  let reopened = 0;
  const blocked: (typeof candidates)[number][] = [];
  for (const row of candidates) {
    if (row.receipt) {
      await recordProgressiveWorkerEvidenceReceipt(db, row.receipt, {
        executionId: String(row.sim_job_id),
        pointContentSignature: String(row.point_content_signature),
        resultId: String(row.result_id),
        resultAttemptId: String(row.result_attempt_id),
      });
      reopened += 1;
    } else {
      blocked.push(row);
    }
  }
  if (!blocked.length) return reopened;
  for (const row of blocked) {
    await db.execute(sql`UPDATE progressive_worker_delivery_failures
      SET updated_at = clock_timestamp()
      WHERE sim_job_id = ${row.sim_job_id}::uuid AND point_content_signature = ${row.point_content_signature}
        AND state = 'conflict' AND remote_conflict_ids = ${JSON.stringify(row.remote_conflict_ids)}::jsonb`);
  }
  const ids = [
    ...new Set(blocked.flatMap((row) => row.remote_conflict_ids as string[])),
  ].slice(0, 500);
  const response = await fetcher(
    `${canonicalRemoteHubBaseUrl(String(blocked[0].upstream_base_url))}/conflicts/status`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-xfoilfoam-solver-token": String(blocked[0].remote_solver_auth_token),
      },
      body: JSON.stringify({ ids }),
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) return reopened;
  const payload = (await response.json()) as { conflicts?: unknown } | null;
  if (!Array.isArray(payload?.conflicts)) return reopened;
  const replayable = new Set<string>();
  for (const value of payload.conflicts) {
    if (!value || typeof value !== "object") continue;
    const conflict = value as Record<string, unknown>;
    if (typeof conflict.id !== "string" || !ids.includes(conflict.id)) continue;
    if (
      conflict.status === "promoted" ||
      (conflict.status === "archived" &&
        conflict.exactGenerationAccepted === true)
    ) {
      replayable.add(conflict.id);
    }
  }
  for (const row of blocked) {
    if (
      !(row.remote_conflict_ids as string[]).every((id) => replayable.has(id))
    )
      continue;
    const changed =
      await db.execute(sql`UPDATE progressive_worker_delivery_failures
      SET state = 'retry', retry_after = clock_timestamp(), remote_conflict_ids = '[]'::jsonb,
        last_error = 'Hub resolved the exact conflict; awaiting verified evidence receipt', updated_at = clock_timestamp()
      WHERE sim_job_id = ${row.sim_job_id}::uuid AND point_content_signature = ${row.point_content_signature}
        AND state = 'conflict' AND remote_conflict_ids = ${JSON.stringify(row.remote_conflict_ids)}::jsonb
      RETURNING sim_job_id`);
    reopened += changed.length;
  }
  return reopened;
}
