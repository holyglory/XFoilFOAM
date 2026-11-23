import { isDeepStrictEqual } from "node:util";
import {
  HistoryMessages,
  HistoryOperationError,
  boundedPacked,
} from "@aerodb/core/point-history-protocol";
import { createClient, type DB } from "@aerodb/db/client";
import { installProgressiveReportArchiveReader } from "@aerodb/db/progressive-report-reader";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { historyHubFailure } from "./hz-point-history-hub";
import { configuredDeploymentRole } from "./config";
import {
  checkNativeKey,
  originalState,
  proveRegisteredReader,
  retireRegisteredReport,
  stageRegisteredReport,
  verifyNativeBytes,
} from "./registered-worker-report-custody";
import {
  hubReportLink,
  ExistingHubReportStore,
  assertSourceKey,
  type SourceKey,
} from "./registered-worker-report-hub";
import {
  reportUuid,
  requireReportProof,
} from "./registered-worker-report-read";
import { readStoredWorkerArchiveText } from "./report-archive-broker-client";
import {
  checkHzTransferFence,
  hzAttemptRpcFailure,
} from "./hz-attempt-transfer-fence";

export async function registeredReaderBuild() {
  const files = [
    "registered-worker-report-rpc.ts",
    "registered-worker-report-read.ts",
    "registered-worker-report-hub.ts",
    "registered-worker-report-custody.ts",
    "report-archive-broker-client.ts",
    "worker-report-volume.ts",
    "hz-attempt-transfer-fence.ts",
    "hub-workload-gcs.ts",
    "../../../packages/db/src/retained-solver-reports.ts",
    "../../../packages/db/src/progressive-remote-execution.ts",
    "worker-report-volume-cleanup.ts",
    "../../api/src/progressive-report-archive-reader.ts",
    "../../../packages/db/src/progressive-report-reader.ts",
    "../../../packages/db/src/progressive-report-archive.ts",
    "../../../packages/db/migrations/0221_registered_worker_hub_report_links.sql",
  ];
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(await readFile(new URL(file, import.meta.url)))
      .update("\0");
  return hash.digest("hex");
}
type Message = Record<string, any>;
export async function registeredReportRequest(db: DB, m: Message) {
  const role = configuredDeploymentRole();
  if (m.operation === "hello") {
    const [r] = await db.execute(
      sql`SELECT instance_id::text,remote_solver_registered_id::text,to_regclass('public.progressive_worker_hub_report_links') IS NOT NULL AS installed FROM sync_api_settings WHERE id=1`,
    );
    requireReportProof(
      r?.installed && reportUuid.test(String(r.instance_id)),
      "Registered report schema unavailable",
    );
    return {
      role,
      instance: r.instance_id,
      solver: r.remote_solver_registered_id,
      build: await registeredReaderBuild(),
    };
  }
  if (m.operation === "scan") {
    requireReportProof(
      role === "hub" &&
        reportUuid.test(m.workerInstance) &&
        reportUuid.test(m.solverId) &&
        reportUuid.test(m.after.job) &&
        Number.isSafeInteger(m.after.seq) &&
        m.after.seq >= 0,
      "Invalid report catalog scan",
    );
    const rows =
      await db.execute(sql`WITH page AS MATERIALIZED (SELECT sim_job_id,sequence,content_signature,bundle_id
      FROM progressive_report_archive_members WHERE source_kind='remote' AND member_kind='report' AND (sim_job_id,sequence)>(${m.after.job}::uuid,${m.after.seq}::bigint)
      ORDER BY sim_job_id,sequence LIMIT 128)
      SELECT p.sim_job_id,p.sequence,p.content_signature,(b.archive_format='jsonl' AND reg.id IS NOT NULL) AS eligible
      FROM page p JOIN progressive_report_archive_bundles b ON b.id=p.bundle_id AND b.sim_job_id=p.sim_job_id AND b.source_kind='remote'
      LEFT JOIN progressive_remote_dispatches d ON d.sim_job_id=p.sim_job_id AND d.solver_id=${m.solverId}::uuid
      LEFT JOIN registered_remote_solvers reg ON reg.id=d.solver_id AND reg.instance_id=${m.workerInstance} AND reg.revoked_at IS NULL
      ORDER BY p.sim_job_id,p.sequence`);
    return {
      keys: rows
        .filter((r) => r.eligible)
        .map((r) => ({
          executionId: r.sim_job_id,
          sequence: Number(r.sequence),
          signature: r.content_signature,
        })),
      after: rows.length
        ? { job: rows.at(-1)!.sim_job_id, seq: Number(rows.at(-1)!.sequence) }
        : null,
    };
  }
  if (m.operation === "describe" || m.operation === "restore") {
    requireReportProof(
      role === "hub",
      "Hub report source requires its serving hub",
    );
    const link = await hubReportLink(db, m.owner, m.key);
    if (m.operation === "describe" || !link) return link;
    requireReportProof(
      isDeepStrictEqual(link, m.expected),
      "Existing report generation or owner changed",
    );
    const packed = await new ExistingHubReportStore(
      String(process.env.AIRFOILFOAM_EVIDENCE_BUCKET ?? ""),
      m.account,
    ).restore(link);
    return { packed: packed.toString("base64"), at: new Date().toISOString() };
  }
  requireReportProof(role === "remote-solver", "Expected worker report reader");
  if (m.operation === "filter") {
    requireReportProof(
      reportUuid.test(m.workerInstance) &&
        reportUuid.test(m.solverId) &&
        Array.isArray(m.keys) &&
        m.keys.length <= 128,
      "Invalid native catalog page",
    );
    await checkHzTransferFence(db, {
      instance: m.workerInstance,
      solver: m.solverId,
    });
    for (const k of m.keys) assertSourceKey(k);
    return await db
      .execute(
        sql`SELECT k."executionId",k.sequence,k.signature FROM jsonb_to_recordset(${JSON.stringify(m.keys)}::jsonb) k("executionId" uuid,sequence int8,signature text)
      JOIN progressive_worker_reports r ON r.sim_job_id=k."executionId" AND r.sequence=k.sequence AND r.content_signature=k.signature
      WHERE r.result_payload_hash IS NULL AND r.archived_at IS NULL AND r.acknowledged_at IS NOT NULL AND r.stopped_engine_job_id IS NULL
      AND NOT EXISTS(SELECT FROM progressive_worker_evidence_receipts s WHERE s.sim_job_id=r.sim_job_id AND s.sequence=r.sequence)
      AND NOT EXISTS(SELECT FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=r.sim_job_id AND c.sequence=r.sequence)
      ORDER BY k."executionId",k.sequence`,
      )
      .then((rows) =>
        rows.map((r) => ({ ...r, sequence: Number(r.sequence) })),
      );
  }
  if (m.operation === "key") return checkNativeKey(db, m.key as SourceKey);
  if (m.operation === "state") {
    // Both statements use one read-only snapshot while native sharing can advance.
    return db.transaction(
      async (tx) => {
        const conn = tx as unknown as DB;
        const status = await originalState(conn, m.link);
        if (status === "ready") await verifyNativeBytes(conn, m.link.pin);
        return status;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  if (m.operation === "stage")
    return stageRegisteredReport(db, m.link, boundedPacked(m.bytes), m.cloudAt);
  if (m.operation === "retire")
    return retireRegisteredReport(db, m.link, m.cloudAt, m.api);
  if (m.operation === "read") {
    if (m.reader === "api") {
      const { installApiReportArchiveReader } =
        await import("../../api/src/progressive-report-archive-reader");
      await installApiReportArchiveReader();
    } else {
      requireReportProof(m.reader === "sweeper", "Unknown report consumer");
      installProgressiveReportArchiveReader({
        read: (i, conn) => readStoredWorkerArchiveText(conn, i),
      });
    }
    return proveRegisteredReader(db, m.link, m.committed === true);
  }
  throw new HistoryOperationError("registered_report_rpc", "input");
}

async function serve() {
  const wire = new HistoryMessages(process.stdin, process.stdout);
  const build = await registeredReaderBuild();
  for (;;) {
    let m: Message;
    try {
      m = await wire.read(600000);
    } catch (error) {
      if (process.stdin.readableEnded) break;
      throw error;
    }
    const operation =
      typeof m.operation === "string" &&
      /^(?:hello|scan|describe|restore|filter|key|state|stage|retire|read)$/.test(
        m.operation,
      )
        ? m.operation
        : "invalid";
    const write = operation === "stage" || operation === "retire";
    const c = createClient({
      max: 1,
      connection: {
        application_name: "registered_report_" + operation,
        statement_timeout: "20s",
        lock_timeout: "1s",
        default_transaction_read_only: write ? "off" : "on",
        idle_in_transaction_session_timeout: "15s",
      },
    });
    try {
      requireReportProof(
        m.build === build,
        "Installed registered report helper differs",
      );
      const result = await registeredReportRequest(c.db, m);
      await wire.send({ id: m.id, result });
    } catch (error) {
      const failure = hzAttemptRpcFailure(
        "registered_report_" + operation,
        error,
      );
      const wireFailure =
        operation === "restore" && historyHubFailure(error, "read").retryable;
      await wire.send({
        id: m.id,
        error: wireFailure
          ? {
              operation: "registered_report_generation_read",
              category: "transport",
              retryable: true,
            }
          : failure,
      });
    } finally {
      await c.sql.end({ timeout: 2 });
    }
    if (write) break;
  }
  wire.close();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  serve().catch(() => {
    process.exitCode = 1;
  });
