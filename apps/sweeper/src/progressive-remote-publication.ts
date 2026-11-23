import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  acknowledgeProgressiveWorkerReport,
  quarantineProgressiveWorkerReportConflict,
  quarantineProgressiveWorkerReportConflicts,
  readPendingProgressiveWorkerReport,
  readPendingProgressiveReportUpdates,
  validateProgressiveRemoteReport,
  verifyProgressiveRemoteExecution,
  type DB,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import {
  progressivePublicationSelectionSql,
  type ProgressivePublicationPass,
} from "./progressive-publication-selection";
import { fetchProgressiveRemote } from "./progressive-remote-http";

const immutableReportConflictReasons = new Set([
  "Remote report replay changed immutable content",
  "Final remote execution evidence cannot change after its stop fence",
  "An acknowledged stopped remote execution cannot resume",
]);
const staleRemoteOwnerReason = "remote solver does not own this execution";
// HZ has one configured upstream. A peer which explicitly rejects the batch
// extension keeps receiving ordinary v1 requests while its version changes.
let singleReportPeer: { baseUrl: string; until: number } | undefined;

export interface ProgressivePublicationCursor {
  nextPass: ProgressivePublicationPass;
  after?: Partial<Record<ProgressivePublicationPass, string>>;
}

export async function publishProgressiveWorkerReport(
  db: DB,
  executionId: string,
  fetcher: typeof fetch = fetch,
): Promise<
  | { kind: "idle" | "paused" }
  | { kind: "published" | "quarantined"; sequence: number }
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
  const canBatch =
    singleReportPeer?.baseUrl !== baseUrl ||
    singleReportPeer.until <= Date.now();
  const updates =
    canBatch &&
    pending.report.result?.state === "running" &&
    pending.report.status.state === "running" &&
    pending.report.stopProof === null
      ? await readPendingProgressiveReportUpdates(
          db,
          validated.report,
          pending.contentSignature,
        )
      : [];
  const send = (batch: boolean) =>
    fetchProgressiveRemote(
      fetcher,
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
          ...(batch ? { updates } : {}),
        }),
      },
    );
  let batched = updates.length > 0;
  let response = await send(batched);
  if (batched && [400, 403, 404, 409, 413, 422].includes(response.status)) {
    // Old peers reject the extension. A bad later member must never quarantine
    // an independently valid head. Retry that exact original through the v1 path.
    const rejected = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    if (
      response.status === 400 &&
      rejected?.error === "invalid progressive report request"
    )
      singleReportPeer = { baseUrl, until: Date.now() + 60_000 };
    batched = false;
    response = await send(false);
  }
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    const conflictReason = String(body?.error ?? "");
    if (
      immutableReportConflictReasons.has(conflictReason) &&
      (await quarantineProgressiveWorkerReportConflict(db, {
        executionId,
        solverId: String(owned.solver_id),
        sequence: pending.sequence,
        contentSignature: pending.contentSignature,
        reason: conflictReason,
      }))
    )
      return { kind: "quarantined", sequence: pending.sequence };
  }
  if (response.status === 403) {
    const body = (await response.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    if (
      body?.error === staleRemoteOwnerReason &&
      (await quarantineProgressiveWorkerReportConflicts(db, {
        executionId,
        solverId: String(owned.solver_id),
        reason: staleRemoteOwnerReason,
      })) > 0
    )
      return { kind: "quarantined", sequence: pending.sequence };
  }
  if (!response.ok)
    throw new Error(`Remote report publication failed (${response.status})`);
  type Receipt = {
    executionId?: unknown;
    sequence?: unknown;
    contentSignature?: unknown;
    replayed?: unknown;
  };
  const body = (await response.json()) as {
    received?: unknown;
    receipt?: Receipt;
    receipts?: Receipt[];
  } | null;
  const expected = [
    { sequence: pending.sequence, contentSignature: pending.contentSignature },
    ...(batched && body?.receipts !== undefined ? updates : []),
  ];
  const matches = (r: Receipt | undefined, entry: (typeof expected)[number]) =>
    r?.executionId === executionId &&
    r.sequence === entry.sequence &&
    r.contentSignature === entry.contentSignature &&
    typeof r.replayed === "boolean";
  if (body?.received !== true || !matches(body.receipt, expected[0]!))
    throw new Error("Hub did not acknowledge the exact durable report");
  if (batched && body.receipts === undefined)
    singleReportPeer = { baseUrl, until: Date.now() + 60_000 };
  const acknowledgements =
    batched && body.receipts !== undefined ? body.receipts : [body.receipt];
  if (
    !Array.isArray(acknowledgements) ||
    acknowledgements.length !== expected.length ||
    !expected.every((entry, i) => matches(acknowledgements[i], entry))
  )
    throw new Error("Hub did not acknowledge the exact ordered report batch");
  const owner = { executionId, solverId: String(owned.solver_id) };
  if (expected.length === 1) {
    await acknowledgeProgressiveWorkerReport(db, {
      ...owner,
      sequence: pending.sequence,
      contentSignature: pending.contentSignature,
    });
  } else {
    await db.transaction(async (tx) => {
      for (const entry of expected)
        await acknowledgeProgressiveWorkerReport(tx as unknown as DB, {
          ...owner,
          sequence: entry.sequence,
          contentSignature: entry.contentSignature,
        });
    });
  }
  return {
    kind: "published",
    sequence: expected[expected.length - 1]!.sequence,
  };
}

export async function publishNextProgressiveWorkerReport(
  db: DB,
  fetcher: typeof fetch = fetch,
  lane = 0,
  laneCount = 1,
  pass: ProgressivePublicationPass = "active",
  cursor?: ProgressivePublicationCursor,
): Promise<boolean> {
  const [pending] = await db.execute(
    progressivePublicationSelectionSql(
      lane,
      laneCount,
      pass,
      cursor?.after?.[pass],
    ),
  );
  if (!pending) return false;
  if (cursor) (cursor.after ??= {})[pass] = String(pending.sim_job_id);
  const result = await publishProgressiveWorkerReport(
    db,
    String(pending.sim_job_id),
    fetcher,
  );
  return result.kind === "published" || result.kind === "quarantined";
}

export async function publishProgressiveWorkerReports(
  db: DB,
  fetcher: typeof fetch = fetch,
  lane = 0,
  laneCount = 1,
  cursor: ProgressivePublicationCursor = { nextPass: "active" },
): Promise<boolean> {
  let published = false;
  for (let index = 0; index < 32; index += 1) {
    const pass = cursor.nextPass;
    cursor.nextPass = pass === "active" ? "backlog" : "active";
    const next = await publishNextProgressiveWorkerReport(
      db,
      fetcher,
      lane,
      laneCount,
      pass,
      cursor,
    );
    if (!next) break;
    published = true;
  }
  return published;
}
