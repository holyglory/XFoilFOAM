import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  canonicalAnalysisJson,
  verifyProgressiveRemoteExecution,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
} from "@aerodb/db";
import type { EngineClient, JobStatus } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";
import { persistEngineRuntimeForJob } from "./engine-provenance";
import { withGlobalAdmissionPermit } from "./submit-lifecycle";

type StartAuthorization = {
  kind: "authorized";
  executionId: string;
  contentSignature: string;
  authorizedAt: string;
  expiresAt: string;
};

export type ProgressiveWorkerSubmitOutcome =
  | { kind: "submitted"; status: JobStatus }
  | {
      kind: "observe" | "waiting" | "stop_required" | "identity_conflict";
      reason: string;
    };

async function localSubmissionReady(
  db: DB,
  envelope: ProgressiveRemoteExecutionEnvelope,
  token?: string,
) {
  const [job] = await db.execute(sql`
    SELECT job.request_payload FROM sim_jobs job
    JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.id = ${envelope.scope.executionId}::uuid AND job.status = 'pending' AND job.engine_job_id IS NULL
      AND ${token ? sql`job.engine_state = 'submitting' AND EXISTS (SELECT 1 FROM progressive_worker_submission_intents intent WHERE intent.sim_job_id = job.id AND intent.token = ${token}::uuid)` : sql`job.engine_state IS NULL`}
      AND settings.remote_solver_enabled AND settings.remote_solver_registered_id = ${envelope.solverId}::uuid
      AND promise.id = ${envelope.promiseId}::uuid AND promise.registered_solver_id = ${envelope.solverId}::uuid
      AND promise.status = 'active' AND promise."expiresAt" > clock_timestamp()
      AND promise.source_base_url = settings.upstream_base_url
      AND job.request_payload->>'upstreamBaseUrl' = settings.upstream_base_url
  `);
  if (!job) return false;
  const payload = job.request_payload as Record<string, unknown>;
  return (
    payload.remoteSolver === true &&
    canonicalAnalysisJson(payload.remoteProgressiveExecution) ===
      canonicalAnalysisJson(envelope) &&
    canonicalAnalysisJson(payload.engineRequest) ===
      canonicalAnalysisJson(envelope.request)
  );
}

export async function submitProgressiveRemoteJob(
  db: DB,
  engine: EngineClient,
  executionId: string,
  fetcher: typeof fetch = fetch,
): Promise<ProgressiveWorkerSubmitOutcome> {
  const [owned] = await db.execute(sql`
    SELECT job.request_payload, promise.id AS promise_id, promise.source_base_url,
      settings.remote_solver_registered_id AS solver_id, settings.remote_solver_auth_token AS auth_token,
      settings.upstream_base_url, EXISTS (SELECT 1 FROM progressive_worker_submission_intents intent WHERE intent.sim_job_id = job.id) AS intended
    FROM sim_jobs job JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
    JOIN sync_api_settings settings ON settings.id = 1
    WHERE job.id = ${executionId}::uuid AND job.request_payload->>'remoteSolver' = 'true'
      AND promise.registered_solver_id = settings.remote_solver_registered_id
  `);
  if (!owned)
    throw new Error("This worker does not own the progressive execution");
  const payload = owned.request_payload as Record<string, unknown>;
  const rawEnvelope = payload.remoteProgressiveExecution as
    | Record<string, unknown>
    | undefined;
  const envelope = verifyProgressiveRemoteExecution(rawEnvelope, {
    solverId: String(owned.solver_id),
    promiseId: String(owned.promise_id),
    executionId,
    contentSignature: String(rawEnvelope?.contentSignature ?? ""),
  });
  const baseUrl = canonicalRemoteHubBaseUrl(
    String(owned.upstream_base_url ?? ""),
  );
  if (
    !owned.auth_token ||
    baseUrl !== owned.source_base_url ||
    baseUrl !== payload.upstreamBaseUrl
  )
    throw new Error(
      "The progressive execution has no matching authenticated upstream",
    );
  if (owned.intended)
    return {
      kind: "observe",
      reason:
        "The durable submission intent requires exact engine reconciliation",
    };
  if (!(await localSubmissionReady(db, envelope)))
    return {
      kind: "waiting",
      reason: "The local worker or promise does not admit this exact execution",
    };
  const requestedAt = performance.now();
  const response = await fetcher(
    `${baseUrl}/progressive-executions/${executionId}/start`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        "x-xfoilfoam-solver-token": String(owned.auth_token),
      },
      body: JSON.stringify({ contentSignature: envelope.contentSignature }),
    },
  );
  const body = (await response.json()) as {
    decision?: unknown;
    checkedAt?: unknown;
  } | null;
  const decision = body?.decision as Record<string, unknown> | undefined;
  if (response.status === 409 && decision?.kind === "stop")
    return {
      kind: "stop_required",
      reason: String(decision.reason ?? "The hub withdrew this execution"),
    };
  if (!response.ok)
    throw new Error(
      `Progressive start authorization failed (${response.status})`,
    );
  if (decision?.kind === "wait")
    return {
      kind: "waiting",
      reason: String(decision.reason ?? "The hub paused new work"),
    };
  if (
    decision?.kind !== "authorized" ||
    Object.keys(decision).length !== 5 ||
    decision.executionId !== executionId ||
    decision.contentSignature !== envelope.contentSignature ||
    typeof decision.authorizedAt !== "string" ||
    typeof decision.expiresAt !== "string"
  )
    throw new Error("The hub did not authorize the exact assigned execution");
  const duration =
    Date.parse(decision.expiresAt) - Date.parse(decision.authorizedAt);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 120_000)
    throw new Error("The hub returned an invalid bounded start authorization");
  const checkedAt =
    typeof body?.checkedAt === "string" ? Date.parse(body.checkedAt) : NaN;
  const remaining = Date.parse(decision.expiresAt) - checkedAt;
  if (
    !Number.isFinite(checkedAt) ||
    checkedAt < Date.parse(decision.authorizedAt) ||
    remaining > duration
  )
    throw new Error(
      "The hub did not provide a valid current authorization clock",
    );
  const deadline = requestedAt + remaining;
  if (performance.now() >= deadline)
    return {
      kind: "stop_required",
      reason: "The start authorization expired in transit",
    };
  const authorization = decision as StartAuthorization;
  const token = randomUUID();
  const reservation = await withGlobalAdmissionPermit(
    db,
    executionId,
    "remote",
    envelope.request,
    async (connection) => {
      await connection.execute(
        sql`SELECT id FROM sim_jobs WHERE id = ${executionId}::uuid FOR UPDATE`,
      );
      if (
        performance.now() >= deadline ||
        !(await localSubmissionReady(connection, envelope))
      )
        return false;
      const [intent] = await connection.execute(sql`
      INSERT INTO progressive_worker_submission_intents (sim_job_id, token, assignment_signature, "authorization")
      VALUES (${executionId}::uuid, ${token}::uuid, ${envelope.contentSignature}, ${JSON.stringify(authorization)}::jsonb)
      ON CONFLICT (sim_job_id) DO NOTHING RETURNING token
    `);
      if (!intent) return false;
      await connection.execute(sql`UPDATE sim_jobs SET engine_state = 'submitting', "updatedAt" = clock_timestamp()
      WHERE id = ${executionId}::uuid AND status = 'pending' AND engine_state IS NULL`);
      return true;
    },
  );
  if (reservation.kind === "denied")
    return { kind: "waiting", reason: reservation.error };
  if (reservation.kind !== "accepted" || !reservation.value)
    return {
      kind: "observe",
      reason: "Submission reservation did not commit for this caller",
    };
  const submitted = await withGlobalAdmissionPermit(
    db,
    executionId,
    "remote",
    envelope.request,
    async (connection) => {
      if (
        performance.now() >= deadline ||
        !(await localSubmissionReady(connection, envelope, token))
      )
        throw new Error(
          "The exact worker submission was withdrawn before the engine call",
        );
      return engine.submitPolar(envelope.request);
    },
  );
  if (submitted.kind === "denied" || submitted.kind === "check_failed")
    return { kind: "stop_required", reason: submitted.error };
  if (submitted.kind === "operation_error") {
    const message =
      submitted.error instanceof Error
        ? submitted.error.message
        : "Engine submission outcome is unknown";
    await db.execute(
      sql`UPDATE sim_jobs SET error = ${message} WHERE id = ${executionId}::uuid`,
    );
    return {
      kind: "observe",
      reason:
        "Engine acceptance is uncertain; the durable CPU reservation is retained",
    };
  }
  const status = submitted.value;
  if (status.job_id !== executionId) {
    await db.execute(sql`UPDATE sim_jobs SET engine_job_id = ${status.job_id}, engine_state = 'submission_identity_conflict',
      error = 'Engine acknowledged a foreign execution identity; both namespaces require reconciliation' WHERE id = ${executionId}::uuid`);
    return {
      kind: "identity_conflict",
      reason: "The engine returned a foreign execution identity",
    };
  }
  if (submitted.kind === "accepted_gate_commit_failed")
    return {
      kind: "observe",
      reason:
        "Engine accepted but its admission transaction did not commit; CPU ownership is retained",
    };
  if (status.total_cases !== envelope.scope.units.length)
    return {
      kind: "stop_required",
      reason: "The engine acknowledged a different physical case scope",
    };
  await persistEngineRuntimeForJob(db, executionId, status.engine);
  const [recorded] = await db.execute(sql`
    UPDATE sim_jobs SET status = 'submitted', engine_job_id = ${executionId}, engine_state = ${status.state},
      "submittedAt" = clock_timestamp(), "updatedAt" = clock_timestamp(), total_cases = ${status.total_cases}
    WHERE id = ${executionId}::uuid AND status = 'pending' AND engine_state = 'submitting'
    RETURNING id
  `);
  if (!recorded)
    return {
      kind: "stop_required",
      reason: "The worker job changed after engine acceptance",
    };
  return { kind: "submitted", status };
}
