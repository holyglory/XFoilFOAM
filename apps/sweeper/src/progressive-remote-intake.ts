import { sql } from "drizzle-orm";
import { activeReconcileConcurrency, runWithConcurrency } from "./reconcile";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  verifyProgressiveRemoteExecution,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
} from "@aerodb/db";
import { fetchProgressiveRemote } from "./progressive-remote-http";

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

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function databaseTimestamp(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return value.toISOString();
  return timestamp(value) ? new Date(value).toISOString() : null;
}

const pendingPages = new WeakMap<
  DB,
  ReturnType<typeof receiveAssignmentPage>
>();

function progressiveAssignmentIntakeConcurrency(): number {
  const configured = Number(
    process.env.SWEEPER_PROGRESSIVE_ASSIGNMENT_INTAKE_CONCURRENCY ?? 32,
  );
  return Number.isInteger(configured) && configured > 0
    ? Math.min(configured, 32)
    : 32;
}

export async function receiveProgressiveAssignmentPage(
  ...args: Parameters<typeof receiveAssignmentPage>
) {
  const [db] = args;
  const existing = pendingPages.get(db);
  if (existing) return existing;
  const operation = receiveAssignmentPage(...args);
  pendingPages.set(db, operation);
  try {
    return await operation;
  } finally {
    if (pendingPages.get(db) === operation) pendingPages.delete(db);
  }
}

async function receiveAssignmentPage(
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
    await db.execute(sql`SELECT cycle_started_at, after_created_at, after_execution_id FROM progressive_worker_assignment_cursors
    WHERE settings_id = 1 AND solver_id = ${solverId}::uuid AND upstream_base_url = ${baseUrl}`);
  const cycleStartedAt = databaseTimestamp(cursor?.cycle_started_at);
  const afterCreatedAt = cycleStartedAt
    ? databaseTimestamp(cursor?.after_created_at)
    : null;
  const after =
    afterCreatedAt && cursor?.after_execution_id != null
      ? String(cursor.after_execution_id)
      : null;
  const request = async (path: string) => {
    const response = await fetchProgressiveRemote(
      fetcher,
      `${baseUrl}${path}`,
      {
        headers: { "x-xfoilfoam-solver-token": String(settings.auth_token) },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Progressive assignment intake failed (${response.status})`,
      );
    return response.json() as Promise<unknown>;
  };
  const page = await request(
    `/progressive-executions?limit=50${cycleStartedAt ? `&beforeCreatedAt=${encodeURIComponent(cycleStartedAt)}` : ""}${after && afterCreatedAt ? `&afterCreatedAt=${encodeURIComponent(afterCreatedAt)}&after=${encodeURIComponent(after)}` : ""}`,
  );
  if (
    !record(page) ||
    !Array.isArray(page.items) ||
    page.items.length > 50 ||
    !timestamp(page.cycleStartedAt) ||
    !(page.nextCursor === null || uuid(page.nextCursor)) ||
    !(page.nextCreatedAt === null || timestamp(page.nextCreatedAt))
  )
    throw new Error("The hub returned an invalid assignment page");
  let previousCreatedAt = afterCreatedAt
    ? Date.parse(afterCreatedAt)
    : Number.NEGATIVE_INFINITY;
  let previous = after;
  const identities: Array<{
    executionId: string;
    promiseId: string;
    contentSignature: string;
    createdAt: string;
  }> = [];
  for (const item of page.items) {
    if (
      !record(item) ||
      !uuid(item.executionId) ||
      !uuid(item.promiseId) ||
      typeof item.contentSignature !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.contentSignature) ||
      !timestamp(item.createdAt)
    )
      throw new Error(
        "The hub returned unordered or malformed assignment identities",
      );
    const itemCreatedAt = Date.parse(item.createdAt);
    if (
      itemCreatedAt < previousCreatedAt ||
      (itemCreatedAt === previousCreatedAt &&
        previous !== null &&
        item.executionId <= previous)
    )
      throw new Error(
        "The hub returned unordered or malformed assignment identities",
      );
    identities.push({
      executionId: item.executionId,
      promiseId: item.promiseId,
      contentSignature: item.contentSignature,
      createdAt: new Date(itemCreatedAt).toISOString(),
    });
    previousCreatedAt = itemCreatedAt;
    previous = item.executionId;
  }
  if (
    page.nextCursor !== null &&
    (page.nextCursor !== identities.at(-1)?.executionId ||
      page.nextCreatedAt !== identities.at(-1)?.createdAt)
  )
    throw new Error(
      "The hub assignment cursor would skip unreceived executions",
    );
  if (page.nextCursor === null && page.nextCreatedAt !== null)
    throw new Error("The hub returned an invalid terminal assignment cursor");
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
    progressiveAssignmentIntakeConcurrency(),
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
    INSERT INTO progressive_worker_assignment_cursors (settings_id, solver_id, upstream_base_url, cycle_started_at, after_created_at, after_execution_id)
    SELECT 1, ${solverId}::uuid, ${baseUrl},
      ${page.nextCursor === null ? null : page.cycleStartedAt}::timestamptz,
      ${page.nextCreatedAt}::timestamptz, ${page.nextCursor}::uuid FROM sync_api_settings settings
    WHERE settings.id = 1 AND settings.remote_solver_registered_id = ${solverId}::uuid
      AND settings.upstream_base_url = ${settings.upstream_base_url}
    ON CONFLICT (settings_id) DO UPDATE SET solver_id = EXCLUDED.solver_id, upstream_base_url = EXCLUDED.upstream_base_url,
      cycle_started_at = EXCLUDED.cycle_started_at,
      after_created_at = EXCLUDED.after_created_at,
      after_execution_id = EXCLUDED.after_execution_id, updated_at = clock_timestamp()
    WHERE progressive_worker_assignment_cursors.solver_id <> ${solverId}::uuid
      OR progressive_worker_assignment_cursors.upstream_base_url <> ${baseUrl}
      OR progressive_worker_assignment_cursors.cycle_started_at IS NOT DISTINCT FROM ${cycleStartedAt}::timestamptz
        AND progressive_worker_assignment_cursors.after_created_at IS NOT DISTINCT FROM ${databaseTimestamp(cursor?.after_created_at)}::timestamptz
        AND progressive_worker_assignment_cursors.after_execution_id IS NOT DISTINCT FROM ${cursor?.after_execution_id ?? null}::uuid
    RETURNING settings_id
  `);
  receipt.cursorAdvanced = Boolean(advanced);
  return receipt;
}
