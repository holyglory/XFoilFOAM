import { pathToFileURL } from "node:url";
import { createClient, type DB } from "@aerodb/db/client";
import { sql } from "drizzle-orm";
import {
  historyHighWater,
  hasExactHzHistoryReceipt,
  hzHistoryInstance,
  scanHzHistories,
  prepareHzHistory,
  applyHzHistoryCustody,
} from "@aerodb/db/hz-point-history-storage";
import {
  historyArchiveIdentity,
  retainPointHistoryWorkingCopy,
  pointHistoryIdentityDigest,
} from "@aerodb/core/point-history-working-copy";
import {
  HistoryMessages,
  boundedPacked,
  HistoryOperationError,
} from "@aerodb/core/point-history-protocol";

/** The same production handler is driven in DB fixtures. Read operations use
 * bounded READ ONLY transactions; the operator calls writes under host flock. */
export async function handleHzHistoryRequest(
  db: DB,
  request: Record<string, any>,
  root?: string,
) {
  if (
    !["hello", "status", "scan", "prepare", "store", "apply"].includes(
      request.operation,
    )
  )
    throw new HistoryOperationError("worker", "input");
  if (["hello", "status", "scan", "prepare"].includes(request.operation))
    return db.transaction(async (transaction) => {
      const tx = transaction as unknown as DB;
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout='10s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='500ms'`);
      if (request.operation === "hello")
        return {
          instance: await hzHistoryInstance(tx),
          high: await historyHighWater(tx),
          protocol: 1,
        };
      if (request.operation === "status") {
        const [counts] = await tx.execute(sql`SELECT
          (SELECT count(*)::text FROM force_history WHERE history_archive_id IS NULL AND t IS NOT NULL) AS force_inline_rows,
          (SELECT count(*)::text FROM force_history WHERE history_archive_id IS NOT NULL) AS force_archived_rows,
          (SELECT count(*)::text FROM results WHERE steady_history IS NOT NULL AND steady_history_archive_id IS NULL) AS steady_inline_rows,
          (SELECT count(*)::text FROM results WHERE steady_history_archive_id IS NOT NULL) AS steady_archived_rows,
          (SELECT count(*)::text FROM results WHERE frame_track IS NOT NULL AND frame_track_archive_id IS NULL) AS frame_inline_rows,
          (SELECT count(*)::text FROM results WHERE frame_track_archive_id IS NOT NULL) AS frame_archived_rows`);
        return {
          instance: await hzHistoryInstance(tx),
          counts,
          inlineIncludesSmallOrIneligible: true,
          workingCopiesVerified: false,
        };
      }
      if (request.operation === "scan")
        return scanHzHistories(tx, request.input);
      return prepareHzHistory(tx, request.selection);
    });
  request.identity = historyArchiveIdentity(request.identity);
  if (
    (await hzHistoryInstance(db)) !== request.identity?.sourceInstance &&
    !(await hasExactHzHistoryReceipt(db, request.identity))
  )
    throw new HistoryOperationError("worker", "denied");
  if (request.operation === "store") {
    const packed = boundedPacked(request.packed);
    return retainPointHistoryWorkingCopy(packed, request.identity, root);
  }
  const proof = request.apiReadback;
  if (
    proof?.identityDigest !== pointHistoryIdentityDigest(request.identity) ||
    proof?.sourceSha256 !== request.identity.sourceSha256 ||
    proof?.sourceByteSize !== request.identity.sourceByteSize ||
    Math.abs(Date.now() - Date.parse(proof.checkedAt)) > 120000 ||
    !Number.isFinite(Date.parse(proof.checkedAt))
  )
    throw new HistoryOperationError("api_readback", "integrity");
  return applyHzHistoryCustody(db, request.identity, {
    root,
    hubReadbackAt: request.hubReadbackAt,
  });
}
/** All retryable SQL states here mean PostgreSQL refused/rolled back the
 * bounded transaction. Never infer a retry from error text or stderr. */
export function hzHistoryWorkerFailure(operation: unknown, error: unknown) {
  if (error instanceof HistoryOperationError) return error;
  const step =
    typeof operation === "string" &&
    ["hello", "status", "scan", "prepare", "store", "apply"].includes(operation)
      ? operation
      : "request";
  let cause: unknown = error;
  const reasons: Record<string, string> = {
    "55P03": "lock_timeout",
    "40001": "serialization",
    "40P01": "deadlock",
  };
  for (
    let depth = 0;
    depth < 4 && cause && typeof cause === "object";
    depth++
  ) {
    const { code, cause: next } = cause as { code?: unknown; cause?: unknown };
    if (
      step !== "store" &&
      step !== "request" &&
      typeof code === "string" &&
      Object.hasOwn(reasons, code)
    ) {
      // Protocol-v1 controllers already back off on this wire category.
      // The operation names the exact reason; new controllers display it as DB contention.
      return new HistoryOperationError(
        `worker_${step}_${reasons[code]}`,
        "transport",
        true,
      );
    }
    if (
      typeof code === "string" &&
      [
        "23503",
        "23505",
        "23514",
        "42P01",
        "57014",
        "ENOSPC",
        "EIO",
        "EACCES",
      ].includes(code)
    )
      return new HistoryOperationError(`worker_${step}_${code}`, "integrity");
    cause = next;
  }
  return new HistoryOperationError(`worker_${step}`, "integrity");
}
export async function runHzHistoryWorker() {
  if (
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver" ||
    !process.env.DATABASE_URL
  )
    throw new HistoryOperationError("worker_role", "denied");
  const channel = new HistoryMessages(process.stdin, process.stdout),
    client = createClient({
      max: 1,
      connection: {
        application_name: "hz-point-history-storage",
        statement_timeout: "10s",
        lock_timeout: "1s",
        idle_in_transaction_session_timeout: "15s",
      },
    });
  try {
    for (;;) {
      let request: Record<string, any>;
      try {
        request = await channel.read(600000);
      } catch (error) {
        if (process.stdin.readableEnded) return;
        throw error;
      }
      if (request.operation === "close") return;
      try {
        const result = await handleHzHistoryRequest(client.db, request);
        await channel.send({ id: request.id, result });
      } catch (error) {
        const failure = hzHistoryWorkerFailure(request.operation, error);
        await channel.send({
          id: request.id,
          error: {
            operation: failure.operation,
            category: failure.category,
            retryable: failure.retryable,
          },
        });
      }
    }
  } finally {
    await client.sql.end({ timeout: 2 });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runHzHistoryWorker().catch(() => {
    process.stderr.write("HZ point history worker failed\n");
    process.exitCode = 1;
  });
