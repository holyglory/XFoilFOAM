import {
  checkHzTransferFence,
  withActiveHzTransfer,
  hzAttemptRpcFailure,
} from "./hz-attempt-transfer-fence";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "@aerodb/db/client";
import {
  HistoryMessages,
  HistoryOperationError,
} from "@aerodb/core/point-history-protocol";
import { getAttemptEvidenceArchive } from "@aerodb/db/attempt-evidence-catalog";
import {
  attemptPage,
  commitHzAttempt,
  confirmHzAttempt,
  exactId,
  verifyHzOutboxReplay,
  hzScience,
  packedBytes,
  prepareHzEnvelope,
  restoreHzAttempt,
  stageHzEnvelope,
} from "./hz-attempt-custody";
import { HzAttemptHubStore } from "./hz-attempt-hub";

export async function attemptWorkerOperation(db: DB, r: Record<string, any>) {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver")
    throw Error("Unexpected worker role");
  const owner = r.owner && {
    instance: exactId(r.owner.instance),
    solver: exactId(r.owner.solver),
  };
  if (
    r.requireTransfers === true &&
    ["pending", "prepare", "page", "stage"].includes(r.operation)
  )
    await checkHzTransferFence(db, owner);
  switch (r.operation) {
    case "bound": {
      const [row] =
        await db.execute(sql`SELECT s.instance_id::text AS instance,s.remote_solver_registered_id::text AS solver,1 AS transfer_fence_protocol,
    to_regprocedure('attempt_evidence_hz_retained_limiter(uuid,uuid)') IS NOT NULL AS retained_contract,
    (SELECT a.id::text FROM result_attempts a ORDER BY a.id DESC LIMIT 1) AS high FROM sync_api_settings s
    WHERE s.id=1 AND s.remote_solver_registered_id IS NOT NULL AND s.upstream_base_url IS NOT NULL AND to_regprocedure('attempt_evidence_hz_limiter(uuid,uuid)') IS NOT NULL`);
      if (!row) throw Error("Worker contract unavailable");
      return row;
    }
    case "one": {
      const [row] = await db.execute(
        sql`SELECT a.id,${r.retained === true ? sql`attempt_evidence_hz_retained_limiter(a.id)` : sql`attempt_evidence_hz_limiter(a.id)`} AS limiter,a.evidence_archive_id AS archive,pg_column_size(a.evidence_payload) AS stored,octet_length(a.evidence_payload::text)-octet_length(attempt_evidence_compact(a.evidence_payload)::text) AS logical FROM result_attempts a WHERE a.id=${exactId(r.attemptId)}::uuid`,
      );
      if (!row) throw Error("Missing attempt");
      return row;
    }
    case "page":
      return attemptPage(db, r.after, r.high, r.limit, r.retained === true);
    case "status": {
      const [row] =
        await db.execute(sql`SELECT count(*)::int AS archived,count(*) FILTER(WHERE e.app_readback_at IS NULL)::int AS pending,
        count(*) FILTER(WHERE e.app_readback_at IS NOT NULL)::int AS confirmed,coalesce(sum(e.source_stored_bytes-e.result_stored_bytes),0)::text AS "payloadBytesReclaimed",
        coalesce(sum(e.net_value_bytes_saved),0)::text AS "netValueBytesReclaimed",coalesce(sum((p.projection->>'removedLogicalBytes')::bigint),0)::text AS "removedLogicalBytes"
        FROM result_attempts a JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id AND e.archive_id=a.evidence_archive_id AND e.result_attempt_id=a.id
        JOIN attempt_evidence_history_projections p ON p.result_attempt_id=a.id AND p.archive_id=e.archive_id
        WHERE e.action='shorten' AND e.completed AND e.verification#>>'{dependencies,verifier}' IN ('server-consumers/hz-worker-steady-rans-v1','server-consumers/hz-retained-original-v2')`);
      return row;
    }
    case "pending":
      return db.execute(sql`SELECT a.id::text AS id FROM attempt_evidence_storage_events e JOIN result_attempts a ON a.evidence_storage_event_id=e.id
  WHERE e.action='shorten' AND e.completed AND e.app_readback_at IS NULL AND e.verification#>>'{dependencies,verifier}' IN ('server-consumers/hz-worker-steady-rans-v1','server-consumers/hz-retained-original-v2')
  ORDER BY e.created_at,e.id LIMIT 8`);
    case "prepare":
      return prepareHzEnvelope(db, exactId(r.attemptId), r.retained === true);
    case "stage": {
      const ar = await stageHzEnvelope(
        db,
        { ...r.identity, verifiedAt: new Date(r.identity.verifiedAt) },
        packedBytes(r.packed),
        owner,
        r.enable === true ? { retained: r.retained === true } : undefined,
      );
      return { id: ar.id, attemptId: ar.attemptId };
    }
    case "replay":
      return verifyHzOutboxReplay(db, exactId(r.attemptId));
    case "science":
      return hzScience(db, exactId(r.attemptId), exactId(r.archiveId));
    case "commit":
      try {
        return await withActiveHzTransfer(db, owner, (tx) =>
          commitHzAttempt(
            tx,
            exactId(r.attemptId),
            exactId(r.archiveId),
            r.proof,
          ),
        );
      } catch (e) {
        if (
          (e as { code?: string }).code === "P0002" ||
          (e as { cause?: { code?: string } }).cause?.code === "P0002"
        )
          return { limited: "insufficient-net-savings" };
        throw e;
      }
    case "confirm":
      await confirmHzAttempt(
        db,
        exactId(r.attemptId),
        exactId(r.eventId),
        r.app,
        owner,
      );
      return { confirmed: true };
    case "restore":
      return restoreHzAttempt(
        db,
        exactId(r.attemptId),
        exactId(r.archiveId),
        exactId(r.eventId),
        { ...r.identity, verifiedAt: new Date(r.identity.verifiedAt) },
        packedBytes(r.packed),
        r.pending === true,
      );
    case "catalog":
      return getAttemptEvidenceArchive(db, exactId(r.archiveId));
    default:
      throw Error("Unknown worker operation");
  }
}
export async function attemptHubOperation(r: Record<string, any>) {
  if (
    (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE ?? "hub") !== "hub" ||
    !r.bucket ||
    r.bucket !== process.env.AIRFOILFOAM_EVIDENCE_BUCKET
  )
    throw Error("Unexpected hub role or bucket");
  const store = new HzAttemptHubStore(r.bucket, r.account);
  if (r.operation === "put") {
    const instance = exactId(r.instance),
      solver = exactId(r.solver);
    const c = createClient({
      max: 1,
      connection: {
        default_transaction_read_only: "on",
        statement_timeout: "5s",
      },
    });
    try {
      const [registration] = await c.db.execute(
        sql`SELECT id FROM registered_remote_solvers WHERE id=${solver}::uuid AND instance_id=${instance} AND revoked_at IS NULL`,
      );
      if (!registration)
        throw new HistoryOperationError("hub_registration", "denied");
    } finally {
      await c.sql.end({ timeout: 1 });
    }
    return store.put(instance, r.proof, packedBytes(r.packed));
  }
  if (r.operation === "read")
    return store.read({
      ...r.identity,
      verifiedAt: new Date(r.identity.verifiedAt),
    });
  throw Error("Unknown hub operation");
}
export async function attemptRpc(
  handler: (r: Record<string, any>) => Promise<unknown>,
) {
  const wire = new HistoryMessages(process.stdin, process.stdout);
  const r = await wire.read();
  try {
    await wire.send({ id: r.id, result: await handler(r) });
  } catch (e) {
    const operation =
      "attempt_" +
      String(r.operation)
        .replace(/[^a-z_]/g, "")
        .slice(0, 20);
    await wire.send({ id: r.id, error: hzAttemptRpcFailure(operation, e) });
  } finally {
    wire.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await attemptRpc(async (r) => {
    if (["put", "read"].includes(r.operation)) return attemptHubOperation(r);
    const write = ["stage", "commit", "confirm", "restore", "replay"].includes(
      r.operation,
    );
    const client = createClient({
      max: 1,
      connection: {
        default_transaction_read_only: write ? "off" : "on",
        statement_timeout: "20s",
        lock_timeout: "1s",
        idle_in_transaction_session_timeout: "5s",
      },
    });
    try {
      if (r.operation === "replay") {
        const { installProgressiveReportArchiveReader } =
          await import("@aerodb/db/progressive-report-reader");
        const { readStoredWorkerArchiveText } =
          await import("./report-archive-broker-client");
        installProgressiveReportArchiveReader({
          read: (identity, connection) =>
            readStoredWorkerArchiveText(connection, identity),
        });
      }
      return await attemptWorkerOperation(client.db, r);
    } finally {
      await client.sql.end({ timeout: 1 });
    }
  });
}
