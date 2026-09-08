import { sql } from "drizzle-orm";
import { activeReconcileConcurrency, runWithConcurrency } from "./reconcile";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  verifyProgressiveRemoteExecution,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
} from "@aerodb/db";

export interface ProgressiveAssignmentDocument extends Record<string, unknown> {
  envelope: ProgressiveRemoteExecutionEnvelope;
  promise: Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

export async function receiveProgressiveAssignmentPage(
  db: DB,
  receive: (
    document: ProgressiveAssignmentDocument,
    owner: { solverId: string; baseUrl: string },
  ) => Promise<void>,
  fetcher: typeof fetch = fetch,
) {
  const receipt = {
    seen: 0,
    mirrored: 0,
    existing: 0,
    stopped: 0,
    cursorAdvanced: false,
    errors: [] as Array<{ executionId: string; error: string }>,
  };
  const [settings] =
    await db.execute(sql`SELECT remote_solver_enabled, remote_solver_transfer_paused,
    remote_solver_registered_id AS solver_id, remote_solver_auth_token AS auth_token, upstream_base_url
    FROM sync_api_settings WHERE id = 1`);
  if (
    !settings?.remote_solver_enabled ||
    settings.remote_solver_transfer_paused ||
    !settings.solver_id ||
    !settings.auth_token ||
    !settings.upstream_base_url
  )
    return receipt;
  const solverId = String(settings.solver_id);
  const baseUrl = canonicalRemoteHubBaseUrl(String(settings.upstream_base_url));
  const [cursor] =
    await db.execute(sql`SELECT after_execution_id FROM progressive_worker_assignment_cursors
    WHERE settings_id = 1 AND solver_id = ${solverId}::uuid AND upstream_base_url = ${baseUrl}`);
  const after =
    cursor?.after_execution_id == null
      ? null
      : String(cursor.after_execution_id);
  const request = async (path: string) => {
    const response = await fetcher(`${baseUrl}${path}`, {
      headers: { "x-xfoilfoam-solver-token": String(settings.auth_token) },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(
        `Progressive assignment intake failed (${response.status})`,
      );
    return response.json() as Promise<unknown>;
  };
  const page = await request(
    `/progressive-executions?limit=25${after ? `&after=${encodeURIComponent(after)}` : ""}`,
  );
  if (
    !record(page) ||
    !Array.isArray(page.items) ||
    page.items.length > 25 ||
    !(page.nextCursor === null || uuid(page.nextCursor))
  )
    throw new Error("The hub returned an invalid assignment page");
  const identities: Array<{
    executionId: string;
    promiseId: string;
    contentSignature: string;
  }> = [];
  let previous = after;
  for (const item of page.items) {
    if (
      !record(item) ||
      !uuid(item.executionId) ||
      !uuid(item.promiseId) ||
      typeof item.contentSignature !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.contentSignature) ||
      (previous !== null && item.executionId <= previous)
    )
      throw new Error(
        "The hub returned unordered or malformed assignment identities",
      );
    identities.push({
      executionId: item.executionId,
      promiseId: item.promiseId,
      contentSignature: item.contentSignature,
    });
    previous = item.executionId;
  }
  if (
    page.nextCursor !== null &&
    page.nextCursor !== identities.at(-1)?.executionId
  )
    throw new Error(
      "The hub assignment cursor would skip unreceived executions",
    );
  const mirrored = async (identity: (typeof identities)[number]) => {
    const [job] = await db.execute(sql`SELECT job.id FROM sim_jobs job
      JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
      WHERE job.id = ${identity.executionId}::uuid AND promise.id = ${identity.promiseId}::uuid
        AND promise.registered_solver_id = ${solverId}::uuid AND promise.source_base_url = ${baseUrl}
        AND job.request_payload->>'upstreamBaseUrl' = ${baseUrl}
        AND job.request_payload#>>'{remoteProgressiveExecution,contentSignature}' = ${identity.contentSignature}
        AND job.request_payload#>>'{remoteProgressiveExecution,solverId}' = ${solverId}`);
    return Boolean(job);
  };
  await runWithConcurrency(
    identities,
    activeReconcileConcurrency(),
    async (identity) => {
      receipt.seen += 1;
      try {
        if (await mirrored(identity)) {
          receipt.existing += 1;
          return;
        }
        const body = await request(
          `/progressive-executions/${identity.executionId}`,
        );
        if (
          !record(body) ||
          !record(body.assignment) ||
          !record(body.assignment.promise) ||
          body.assignment.promise.id !== identity.promiseId ||
          typeof body.assignment.executionStopped !== "boolean"
        )
          throw new Error(
            "The hub returned an invalid exact assignment document",
          );
        const envelope = verifyProgressiveRemoteExecution(
          body.assignment.envelope,
          { ...identity, solverId },
        );
        if (body.assignment.executionStopped) {
          receipt.stopped += 1;
          return;
        }
        await receive(
          { ...body.assignment, envelope, promise: body.assignment.promise },
          { solverId, baseUrl },
        );
        if (!(await mirrored(identity)))
          throw new Error(
            "Assignment intake did not persist its exact worker mirror",
          );
        receipt.mirrored += 1;
      } catch (error) {
        receipt.errors.push({
          executionId: identity.executionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  const [advanced] = await db.execute(sql`
    INSERT INTO progressive_worker_assignment_cursors (settings_id, solver_id, upstream_base_url, after_execution_id)
    SELECT 1, ${solverId}::uuid, ${baseUrl}, ${page.nextCursor}::uuid FROM sync_api_settings settings
    WHERE settings.id = 1 AND settings.remote_solver_registered_id = ${solverId}::uuid
      AND settings.upstream_base_url = ${settings.upstream_base_url}
    ON CONFLICT (settings_id) DO UPDATE SET solver_id = EXCLUDED.solver_id, upstream_base_url = EXCLUDED.upstream_base_url,
      after_execution_id = EXCLUDED.after_execution_id, updated_at = clock_timestamp()
    WHERE progressive_worker_assignment_cursors.solver_id <> ${solverId}::uuid
      OR progressive_worker_assignment_cursors.upstream_base_url <> ${baseUrl}
      OR progressive_worker_assignment_cursors.after_execution_id IS NOT DISTINCT FROM ${after}::uuid
    RETURNING settings_id
  `);
  receipt.cursorAdvanced = Boolean(advanced);
  return receipt;
}
