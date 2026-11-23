import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import { HistoryOperationError, SETTLED_REPORT_SIZE_LIMIT } from "@aerodb/core/point-history-protocol";

export interface HzWorkerOwner {
  instance: string;
  solver: string;
}

/** Only a positively identified, enabled worker can return a retryable pause. */
export function requireActiveHzTransfer(paused: unknown) {
  if (paused === true)
    throw new HistoryOperationError(
      "worker_transfer_paused",
      "transfer_paused",
      true,
    );
  if (paused !== false)
    throw new HistoryOperationError("worker_registration", "denied");
}

export async function checkHzTransferFence(
  db: DB,
  expected?: HzWorkerOwner,
  lock = false,
) {
  const [row] = await db.execute(sql`
    SELECT cfg.instance_id::text AS instance, worker.id::text AS solver,
      cfg.remote_solver_transfer_paused AS paused
    FROM sync_api_settings cfg JOIN registered_remote_solvers worker
      ON worker.id=cfg.remote_solver_registered_id AND worker.instance_id=cfg.instance_id::text
        AND worker.revoked_at IS NULL
    WHERE cfg.id=1 AND cfg.remote_solver_enabled AND cfg.upstream_base_url IS NOT NULL
    ${lock ? sql`FOR SHARE OF cfg,worker NOWAIT` : sql``}`);
  if (
    !row ||
    (expected &&
      (row.instance !== expected.instance || row.solver !== expected.solver))
  )
    throw new HistoryOperationError("worker_registration", "denied");
  requireActiveHzTransfer(row.paused);
}

export async function withActiveHzTransfer<T>(
  db: DB,
  owner: HzWorkerOwner | undefined,
  work: (tx: DB) => Promise<T>,
) {
  return db.transaction(async (tx) => {
    const connection = tx as unknown as DB;
    await checkHzTransferFence(connection, owner, true);
    return work(connection);
  });
}

/** Older controller releases retry the transport wire category. New controllers
 * distinguish an observed fence, rolled-back SQL contention, and a host flock. */
export function hzAttemptRpcFailure(operation: string, error: unknown) {
  if (error instanceof HistoryOperationError && error.operation === SETTLED_REPORT_SIZE_LIMIT && error.category === "input")
    return { operation: SETTLED_REPORT_SIZE_LIMIT, category: "input", retryable: false };
  const e = error as { code?: string; cause?: { code?: string } } | null;
  const code = e?.cause?.code ?? e?.code;
  const busy =
    code === "55P03"
      ? "lock_timeout"
      : code === "40P01"
        ? "deadlock"
        : code === "40001"
          ? "serialization"
          : null;
  if (busy)
    return {
      operation: operation + "_" + busy,
      category: "transport",
      retryable: true,
    };
  if (
    error instanceof HistoryOperationError &&
    error.category === "transfer_paused"
  )
    return {
      operation: "worker_transfer_paused",
      category: "transport",
      retryable: true,
    };
  const retryable =
    (error instanceof HistoryOperationError && error.retryable) ||
    ["08003", "08006", "57P01", "57P02", "57P03"].includes(code ?? "");
  return {
    operation,
    category: retryable
      ? "transport"
      : error instanceof HistoryOperationError && error.category === "denied"
        ? "denied"
        : "integrity",
    retryable,
  };
}
