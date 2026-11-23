import { resolveStoredProgressiveReport } from "./progressive-report-reader";
import { sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import type { DB } from "./client";
import { canonicalAnalysisJson } from "./analysis-target";
import {
  MAX_PROGRESSIVE_PUBLICATION_REPORTS,
  canRepeatLiveReport,
  sameLiveProgressStatus,
  type ProgressiveReportStatusUpdate,
} from "./progressive-report-publication-batch";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import {
  isFinalProgressiveRemoteReport,
  isMeasuredCancelledProgressiveRemoteReport,
  validateProgressiveRemoteReport,
  validateProgressiveRemoteReportOrder,
  normalizeProgressiveRemoteReportJson,
  type ProgressiveRemoteReport,
} from "./progressive-remote-report";

const STALE_REPORT_QUARANTINE_BATCH_SIZE = 128;

export function workerEvidenceDeliverySettled(jobId: ReturnType<typeof sql>) {
  return sql`NOT EXISTS (
  SELECT 1 FROM progressive_worker_reports pending
  WHERE pending.sim_job_id = ${jobId} AND pending.acknowledged_at IS NULL
)
AND NOT EXISTS (
  SELECT 1 FROM progressive_worker_delivery_failures retry
  WHERE retry.sim_job_id = ${jobId} AND retry.state = 'retry'
)
AND NOT EXISTS (
  SELECT 1
  FROM progressive_worker_evidence_attempts source
  WHERE source.sim_job_id = ${jobId}
    AND NOT EXISTS (
      SELECT 1 FROM progressive_worker_hub_receipts delivered
      WHERE delivered.sim_job_id = source.sim_job_id
        AND delivered.point_content_signature = source.point_content_signature
    )
    AND NOT EXISTS (
      SELECT 1 FROM progressive_worker_delivery_failures conflict
      WHERE conflict.sim_job_id = source.sim_job_id
        AND conflict.point_content_signature = source.point_content_signature
        AND conflict.state = 'conflict'
    )
)`;
}

function liveMeasurements(report: ProgressiveRemoteReport) {
  const { updated_at, solver_budget_progress, ...status } = report.status;
  if (!solver_budget_progress) return { ...report, status: { ...status, solver_budget_progress } };
  const { observed_at, ...budget } = solver_budget_progress;
  return { ...report, status: { ...status, solver_budget_progress: budget } };
}

async function isAcknowledgedLiveResult(
  db: DB,
  candidate: ProgressiveRemoteReport,
  previous: ProgressiveRemoteReport,
): Promise<boolean> {
  if (candidate.result?.state !== "running" || candidate.stopProof !== null || previous.stopProof !== null ||
      !sameLiveProgressStatus(previous.status, candidate.status)) return false;
  if (previous.result !== null && !isDeepStrictEqual(previous.result, candidate.result)) return false;

  // The ordered outbox keeps quarantined rows with acknowledgement timestamps.
  // A conflict is never a receipt, and an older A cannot hide a new B-to-A change.
  const [source] = await db.execute(sql`
    WITH latest AS MATERIALIZED (
      SELECT r.sequence,r.report,r.result_payload_hash,r.archived_at
      FROM progressive_worker_reports r WHERE r.sim_job_id=${candidate.executionId}::uuid
        AND (r.result_payload_hash IS NOT NULL OR r.archived_at IS NOT NULL OR r.report->'result' IS DISTINCT FROM 'null'::jsonb)
      ORDER BY r.sequence DESC LIMIT 1
    ), acknowledged AS MATERIALIZED (
      SELECT r.sequence,r.report,r.result_payload_hash,r.archived_at
      FROM progressive_worker_reports r WHERE r.sim_job_id=${candidate.executionId}::uuid AND r.acknowledged_at IS NOT NULL
        AND (r.result_payload_hash IS NOT NULL OR r.archived_at IS NOT NULL OR r.report->'result' IS DISTINCT FROM 'null'::jsonb)
      ORDER BY r.sequence DESC LIMIT 1
    )
    SELECT latest.sequence,CASE WHEN latest.sequence<>${previous.sequence}
      THEN resolve_progressive_report(latest.report,latest.result_payload_hash)->'result' END AS earlier_result
    FROM latest JOIN acknowledged a ON a.sequence=latest.sequence OR a.result_payload_hash=latest.result_payload_hash
    WHERE latest.archived_at IS NULL AND a.archived_at IS NULL
      AND latest.report->>'executionId'=${candidate.executionId} AND a.report->>'executionId'=${candidate.executionId}
      AND latest.report->>'solverId'=${candidate.solverId} AND a.report->>'solverId'=${candidate.solverId}
      AND latest.report->>'promiseId'=${candidate.promiseId} AND a.report->>'promiseId'=${candidate.promiseId}
      AND latest.report->>'assignmentSignature'=${candidate.assignmentSignature} AND a.report->>'assignmentSignature'=${candidate.assignmentSignature}
      AND latest.report->'stopProof'='null'::jsonb AND a.report->'stopProof'='null'::jsonb
      AND latest.report#>>'{status,state}'='running' AND a.report#>>'{status,state}'='running'
      AND NOT EXISTS (SELECT FROM progressive_worker_report_conflicts conflict
        WHERE conflict.sim_job_id=${candidate.executionId}::uuid AND conflict.sequence>=a.sequence)
      AND NOT EXISTS (SELECT FROM progressive_worker_reports changed
        WHERE changed.sim_job_id=${candidate.executionId}::uuid
          AND changed.sequence>a.sequence AND changed.sequence<=latest.sequence
          AND changed.result_payload_hash IS DISTINCT FROM a.result_payload_hash
          AND (changed.result_payload_hash IS NOT NULL OR changed.archived_at IS NOT NULL
            OR changed.report->'result' IS DISTINCT FROM 'null'::jsonb))
  `);
  return Boolean(source && (Number(source.sequence) === previous.sequence
    ? previous.result !== null
    : isDeepStrictEqual(source.earlier_result, candidate.result)));
}

async function projectRunningWorkerReport(
  db: DB,
  report: ProgressiveRemoteReport,
): Promise<void> {
  if (report.status.state !== "running") return;
  await db.execute(sql`
    UPDATE sim_jobs SET
      status = CASE WHEN status = 'ingesting' THEN status ELSE 'running'::sim_job_status END,
      ingest_lease_previous_status = CASE WHEN status = 'ingesting' THEN 'running'::sim_job_status ELSE ingest_lease_previous_status END,
      engine_state = 'running', total_cases = ${report.status.total_cases}, completed_cases = ${report.status.completed_cases},
      "polledAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
    WHERE id = ${report.executionId}::uuid AND engine_job_id = ${report.executionId}
      AND status IN ('pending', 'submitted', 'running', 'ingesting')
      AND coalesce(engine_state, '') NOT IN ('completed', 'failed', 'cancelled', 'cancelling', 'cancel_pending')
      AND (ingest_lease_previous_status IS NULL OR ingest_lease_previous_status IN ('pending', 'submitted', 'running'))
  `);
}

async function projectMeasuredCancellation(
  db: DB,
  report: ProgressiveRemoteReport,
): Promise<boolean> {
  if (!isMeasuredCancelledProgressiveRemoteReport(report)) return false;
  const importing = sql`status = 'ingesting' AND ingest_lease_token IS NOT NULL
    AND ingest_lease_expires_at > clock_timestamp()`;
  const rows = await db.execute(sql`
    UPDATE sim_jobs SET status = CASE WHEN ${importing} THEN status ELSE 'cancelled'::sim_job_status END,
      ingest_lease_previous_status = CASE WHEN ${importing} THEN 'cancelled'::sim_job_status ELSE ingest_lease_previous_status END,
      engine_state = 'cancelled',
      "finishedAt" = coalesce("finishedAt", clock_timestamp()), "updatedAt" = clock_timestamp(),
      error = coalesce(${report.status.message ?? null}, error)
    WHERE id = ${report.executionId}::uuid AND (engine_job_id IS NULL OR engine_job_id = ${report.executionId})
    RETURNING id
  `);
  if (rows.length !== 1)
    throw new Error(
      "Measured cancellation report has a foreign engine identity",
    );
  return true;
}

async function projectFinalWorkerReport(
  db: DB,
  report: ProgressiveRemoteReport,
): Promise<boolean> {
  if (!isFinalProgressiveRemoteReport(report)) return false;
  const state = report.status.state;
  const finished =
    typeof report.status.updated_at === "string" &&
    Number.isFinite(Date.parse(report.status.updated_at))
      ? report.status.updated_at
      : null;
  const importing = sql`status = 'ingesting' AND ingest_lease_token IS NOT NULL
    AND ingest_lease_expires_at > clock_timestamp()`;
  const terminalStatus = state === "completed" ? "done" : state;
  const rows = await db.execute(sql`
    UPDATE sim_jobs SET status = CASE WHEN ${importing} THEN status ELSE ${terminalStatus}::sim_job_status END,
      ingest_lease_previous_status = CASE WHEN ${importing} THEN ${terminalStatus}::sim_job_status ELSE ingest_lease_previous_status END,
      engine_state = ${state}, total_cases = ${report.status.total_cases}, completed_cases = ${report.status.completed_cases},
      "finishedAt" = coalesce("finishedAt", ${finished}::timestamptz), "updatedAt" = clock_timestamp(),
      error = CASE WHEN ${state} = 'completed' THEN NULL ELSE coalesce(${report.status.message ?? null}, error) END
    WHERE id = ${report.executionId}::uuid AND (engine_job_id IS NULL OR engine_job_id = ${report.executionId}) RETURNING id
  `);
  if (rows.length !== 1)
    throw new Error("Final worker report has a foreign engine identity");
  return true;
}

export async function settleProgressiveWorkerFinalReport(
  db: DB,
  executionId: string,
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [owned] = await connection.execute(sql`
      SELECT job.request_payload, promise.id AS promise_id, promise.registered_solver_id AS solver_id,
        latest.report, latest.content_signature, settings.upstream_base_url
      FROM sim_jobs job
      JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
      JOIN sync_api_settings settings ON settings.id = 1
      JOIN LATERAL (SELECT resolve_progressive_report(to_jsonb(progressive_worker_reports.*)) AS report, content_signature FROM progressive_worker_reports
        WHERE sim_job_id = job.id ORDER BY sequence DESC LIMIT 1) latest ON true
      WHERE job.id = ${executionId}::uuid AND job.request_payload->>'remoteSolver' = 'true'
        AND promise.registered_solver_id = settings.remote_solver_registered_id
        AND promise.source_base_url = job.request_payload->>'upstreamBaseUrl'
      FOR UPDATE OF job
    `);
    if (!owned) return false;
    const payload = owned.request_payload as Record<string, unknown>;
    if (
      canonicalRemoteHubBaseUrl(String(owned.upstream_base_url)) !==
      payload.upstreamBaseUrl
    )
      return false;
    const report = await resolveStoredProgressiveReport(connection, "worker", owned, executionId);
    const envelope = verifyProgressiveRemoteExecution(
      payload.remoteProgressiveExecution,
      {
        executionId,
        solverId: String(owned.solver_id),
        promiseId: String(owned.promise_id),
        contentSignature: report.assignmentSignature,
      },
    );
    if (
      canonicalAnalysisJson(payload.engineRequest) !==
      canonicalAnalysisJson(envelope.request)
    )
      throw new Error("Final worker report differs from its immutable request");
    const validated = validateProgressiveRemoteReport(report, envelope);
    if (validated.contentSignature !== owned.content_signature)
      throw new Error("Final worker report content signature changed");
    const projectedCancellation = await projectMeasuredCancellation(
      connection,
      validated.report,
    );
    const projectedFinal = await projectFinalWorkerReport(
      connection,
      validated.report,
    );
    return projectedCancellation || projectedFinal;
  });
}

/**
 * Release a worker execution whose scheduling promise closed after a terminal
 * report was durably received. Every produced evidence point must already be
 * represented by a hub receipt or a terminal delivery conflict; unresolved
 * points keep the execution ingesting so evidence cannot be silently lost.
 */
export async function settleProgressiveWorkerExpiredFinalReport(
  db: DB,
  executionId: string,
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [candidate] = await connection.execute(sql`
      SELECT job.id
      FROM sim_jobs job
      JOIN sync_sweep_promises promise
        ON promise.id::text = job.request_payload->>'syncPromiseId'
      JOIN sync_api_settings settings ON settings.id = 1
      JOIN LATERAL (
        SELECT report
        FROM progressive_worker_reports
        WHERE progressive_worker_reports.sim_job_id = job.id
          AND progressive_worker_reports.acknowledged_at IS NOT NULL
          AND progressive_worker_reports.stopped_engine_job_id = job.id::text
        ORDER BY progressive_worker_reports.sequence DESC
        LIMIT 1
      ) latest ON true
      WHERE job.id = ${executionId}::uuid
        AND job.request_payload->>'remoteSolver' = 'true'
        AND promise.registered_solver_id = settings.remote_solver_registered_id
        AND promise.source_base_url = job.request_payload->>'upstreamBaseUrl'
        AND promise.status IN ('expired', 'cancelled')
        AND job.status IN ('ingesting', 'done', 'failed', 'cancelled')
        AND job."ingestedAt" IS NULL
        AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
        AND latest.report#>>'{stopProof,execution_stopped}' = 'true'
        AND latest.report#>>'{status,state}' IN ('completed', 'failed', 'cancelled')
        AND ${workerEvidenceDeliverySettled(sql`job.id`)}
      FOR UPDATE OF job
    `);
    if (!candidate) return false;
    const [released] = await connection.execute(sql`
      UPDATE sim_jobs SET
        status = 'cancelled',
        "ingestedAt" = coalesce("ingestedAt", clock_timestamp()),
        "finishedAt" = coalesce("finishedAt", clock_timestamp()),
        "updatedAt" = clock_timestamp(),
        error = coalesce(error, 'Remote scope closed after terminal evidence; unresolved evidence conflicts retained'),
        ingest_lease_token = NULL,
        ingest_lease_previous_status = NULL,
        ingest_lease_claimed_at = NULL,
        ingest_lease_expires_at = NULL
      WHERE id = ${executionId}::uuid
        AND "ingestedAt" IS NULL
        AND (ingest_lease_token IS NULL OR ingest_lease_expires_at <= clock_timestamp())
      RETURNING id
    `);
    return Boolean(released);
  });
}

export async function enqueueProgressiveWorkerReport(
  db: DB,
  input: {
    executionId: string;
    solverId: string;
    promiseId: string;
    assignmentSignature: string;
    status: ProgressiveRemoteReport["status"];
    result: ProgressiveRemoteReport["result"];
    stopProof: ProgressiveRemoteReport["stopProof"];
  },
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [job] = await connection.execute(sql`
      SELECT job.request_payload FROM sim_jobs job
      JOIN sync_sweep_promises promise ON promise.id::text = job.request_payload->>'syncPromiseId'
      JOIN sync_api_settings settings ON settings.id = 1
      WHERE job.id = ${input.executionId}::uuid AND job.request_payload->>'remoteSolver' = 'true'
        AND settings.remote_solver_registered_id = ${input.solverId}::uuid
        AND promise.id = ${input.promiseId}::uuid AND promise.registered_solver_id = ${input.solverId}::uuid
        AND promise.source_base_url = job.request_payload->>'upstreamBaseUrl'
      FOR UPDATE OF job
    `);
    if (!job)
      throw new Error("Worker report has no owned local remote execution");
    const payload = job.request_payload as Record<string, unknown>;
    const envelope = verifyProgressiveRemoteExecution(
      payload.remoteProgressiveExecution,
      {
        solverId: input.solverId,
        promiseId: input.promiseId,
        executionId: input.executionId,
        contentSignature: input.assignmentSignature,
      },
    );
    if (
      canonicalAnalysisJson(payload.engineRequest) !==
      canonicalAnalysisJson(envelope.request)
    )
      throw new Error(
        "Worker report request differs from its assigned execution",
      );
    const [latest] = await connection.execute(sql`
      SELECT sequence, content_signature, resolve_progressive_report(to_jsonb(progressive_worker_reports.*)) AS report FROM progressive_worker_reports
      WHERE sim_job_id = ${input.executionId}::uuid ORDER BY sequence DESC LIMIT 1
    `);
    if (latest)
      latest.report = await resolveStoredProgressiveReport(connection, "worker", latest, input.executionId);
    const content = normalizeProgressiveRemoteReportJson({
      ...input,
      version: 1 as const,
    });
    if (latest) {
      const previous = latest.report as unknown as ProgressiveRemoteReport;
      const observed = { ...content, sequence: Number(latest.sequence) };
      const unchanged = await isAcknowledgedLiveResult(connection, observed, previous);
      if (unchanged) content.result = null;
      const replay = validateProgressiveRemoteReport(
        { ...content, sequence: observed.sequence }, envelope,
      );
      const previousMeasurement = unchanged ? { ...previous, result: null } : previous;
      if (replay.contentSignature !== latest.content_signature &&
          (previous.status.state === "running" || previous.status.state === "pending") &&
          previous.stopProof === null && replay.report.stopProof === null &&
          isDeepStrictEqual(liveMeasurements(previousMeasurement), liveMeasurements(replay.report))) {
        // A later observation clock by itself carries no new solver measurement.
        // Project the live heartbeat and preserve the prior report's identity.
        await projectRunningWorkerReport(connection,replay.report);
        return {executionId:input.executionId, sequence:previous.sequence,
          contentSignature:String(latest.content_signature),replayed:true};
      }
      if (replay.contentSignature === latest.content_signature) {
        await projectRunningWorkerReport(
          connection,
          latest.report as unknown as ProgressiveRemoteReport,
        );
        await projectMeasuredCancellation(
          connection,
          latest.report as unknown as ProgressiveRemoteReport,
        );
        await projectFinalWorkerReport(
          connection,
          latest.report as unknown as ProgressiveRemoteReport,
        );
        return {
          executionId: input.executionId,
          sequence: Number(latest.sequence),
          contentSignature: replay.contentSignature,
          replayed: true,
        };
      }
    }
    const next = validateProgressiveRemoteReport(
      { ...content, sequence: Number(latest?.sequence ?? 0) + 1 },
      envelope,
    );
    validateProgressiveRemoteReportOrder(
      next.report,
      latest ? (latest.report as unknown as ProgressiveRemoteReport) : null,
    );
    if (
      latest &&
      isFinalProgressiveRemoteReport(
        latest.report as unknown as ProgressiveRemoteReport,
      )
    ) {
      await projectMeasuredCancellation(
        connection,
        latest.report as unknown as ProgressiveRemoteReport,
      );
      await projectFinalWorkerReport(
        connection,
        latest.report as unknown as ProgressiveRemoteReport,
      );
      return {
        executionId: input.executionId,
        sequence: Number(latest.sequence),
        contentSignature: String(latest.content_signature),
        replayed: true,
      };
    }
    await connection.execute(sql`
      INSERT INTO progressive_worker_reports (sim_job_id, sequence, content_signature, report)
      VALUES (${input.executionId}::uuid, ${next.report.sequence}, ${next.contentSignature}, ${JSON.stringify(next.report)}::jsonb)
    `);
    await projectRunningWorkerReport(connection, next.report);
    await projectMeasuredCancellation(connection, next.report);
    await projectFinalWorkerReport(connection, next.report);
    await connection.execute(
      sql`SELECT pg_notify('progressive_worker_report_changed', ${input.executionId})`,
    );
    return {
      executionId: input.executionId,
      sequence: next.report.sequence,
      contentSignature: next.contentSignature,
      replayed: false,
    };
  });
}

export async function readPendingProgressiveWorkerReport(
  db: DB,
  input: { executionId: string; solverId: string },
) {
  const [row] = await db.execute(sql`
    SELECT report.sequence, report.content_signature, resolve_progressive_report(to_jsonb(report.*)) AS report FROM progressive_worker_reports report
    WHERE report.sim_job_id = ${input.executionId}::uuid AND report.report->>'solverId' = ${input.solverId}
      AND report.acknowledged_at IS NULL ORDER BY report.sequence LIMIT 1
  `);
  return row
    ? {
        executionId: input.executionId,
        sequence: Number(row.sequence),
        contentSignature: String(row.content_signature),
        report: await resolveStoredProgressiveReport(db, "worker", row, input.executionId),
      }
    : null;
}

/** Only consecutive envelopes with the same stored result or the same explicit
 * absence of a result may follow this head. Archived headers need normal replay. */
export async function readPendingProgressiveReportUpdates(
  db: DB,
  anchor: ProgressiveRemoteReport,
  contentSignature: string,
): Promise<ProgressiveReportStatusUpdate[]> {
  if (!canRepeatLiveReport(anchor)) return [];
  const statusOnly = anchor.result === null;
  const inlineNullResult = sql`stored.archived_at IS NULL AND stored.result_payload_hash IS NULL
    AND stored.report->'result'='null'::jsonb AND stored.report->'stopProof'='null'::jsonb`;
  const rows = await db.execute(sql`
    WITH source AS (
      SELECT result_payload_hash FROM progressive_worker_reports stored
      WHERE sim_job_id=${anchor.executionId}::uuid AND sequence=${anchor.sequence}
        AND content_signature=${contentSignature}
        AND ${statusOnly ? inlineNullResult : sql`stored.result_payload_hash IS NOT NULL`}
    )
    SELECT w.sequence,w.content_signature,w.report->'status' AS status,
      w.same_result AND w.acknowledged_at IS NULL
      AND w.report->'stopProof'='null'::jsonb
      AND w.report->>'executionId'=${anchor.executionId} AND w.report->>'solverId'=${anchor.solverId}
      AND w.report->>'promiseId'=${anchor.promiseId} AND w.report->>'assignmentSignature'=${anchor.assignmentSignature} AS same_source
    FROM source CROSS JOIN LATERAL (
      SELECT sequence,content_signature,report,acknowledged_at,
        ${statusOnly ? inlineNullResult : sql`stored.result_payload_hash=source.result_payload_hash`} AS same_result
      FROM progressive_worker_reports stored
      WHERE sim_job_id=${anchor.executionId}::uuid AND sequence>${anchor.sequence}
      ORDER BY sequence LIMIT ${MAX_PROGRESSIVE_PUBLICATION_REPORTS - 1}
    ) w ORDER BY w.sequence
  `);
  const updates: ProgressiveReportStatusUpdate[] = [];
  for (const row of rows) {
    const sequence = Number(row.sequence);
    const status = row.status as ProgressiveRemoteReport["status"];
    if (row.same_source !== true || !status || sequence !== anchor.sequence + updates.length + 1 ||
        !sameLiveProgressStatus(anchor.status, status)) break;
    updates.push({ sequence, status, contentSignature: String(row.content_signature) });
  }
  return updates;
}

export async function acknowledgeProgressiveWorkerReport(
  db: DB,
  input: {
    executionId: string;
    solverId: string;
    sequence: number;
    contentSignature: string;
  },
): Promise<void> {
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
    throw new Error("Worker report acknowledgement has an invalid sequence");
  await db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(
      sql`SELECT id FROM sim_jobs WHERE id = ${input.executionId}::uuid FOR UPDATE`,
    );
    const [acknowledged] = await connection.execute(sql`
      UPDATE progressive_worker_reports report SET acknowledged_at = coalesce(acknowledged_at, clock_timestamp())
      WHERE report.sim_job_id = ${input.executionId}::uuid AND report.sequence = ${input.sequence}
        AND report.content_signature = ${input.contentSignature} AND report.report->>'solverId' = ${input.solverId}
        AND NOT EXISTS (SELECT 1 FROM progressive_worker_reports previous
          WHERE previous.sim_job_id = report.sim_job_id AND previous.sequence < report.sequence AND previous.acknowledged_at IS NULL)
      RETURNING sequence
    `);
    if (!acknowledged)
      throw new Error(
        "Worker report acknowledgement does not match the next durable delivery",
      );
    await connection.execute(
      sql`SELECT pg_notify('progressive_worker_evidence_changed', ${input.executionId})`,
    );
  });
}

export async function quarantineProgressiveWorkerReportConflict(
  db: DB,
  input: {
    executionId: string;
    solverId: string;
    sequence: number;
    contentSignature: string;
    reason: string;
  },
): Promise<boolean> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(
      sql`SELECT id FROM sim_jobs WHERE id = ${input.executionId}::uuid FOR UPDATE`,
    );
    const [row] = await connection.execute(sql`
      SELECT resolve_progressive_report(to_jsonb(progressive_worker_reports.*)) AS report, content_signature
      FROM progressive_worker_reports
      WHERE sim_job_id = ${input.executionId}::uuid
        AND sequence = ${input.sequence}
        AND content_signature = ${input.contentSignature}
        AND report->>'solverId' = ${input.solverId}
        AND acknowledged_at IS NULL
    `);
    if (!row) return false;
    const report = await resolveStoredProgressiveReport(connection, "worker", row, input.executionId);
    await connection.execute(sql`
      INSERT INTO progressive_worker_report_conflicts
        (sim_job_id, sequence, content_signature, report, reason)
      VALUES
        (${input.executionId}::uuid, ${input.sequence}, ${input.contentSignature},
         ${JSON.stringify(report)}::jsonb, ${input.reason})
      ON CONFLICT (sim_job_id, sequence) DO NOTHING
    `);
    const [acknowledged] = await connection.execute(sql`
      UPDATE progressive_worker_reports
      SET acknowledged_at = coalesce(acknowledged_at, clock_timestamp())
      WHERE sim_job_id = ${input.executionId}::uuid
        AND sequence = ${input.sequence}
        AND content_signature = ${input.contentSignature}
        AND report->>'solverId' = ${input.solverId}
        AND acknowledged_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM progressive_worker_reports previous
          WHERE previous.sim_job_id = progressive_worker_reports.sim_job_id
            AND previous.sequence < progressive_worker_reports.sequence
            AND previous.acknowledged_at IS NULL
        )
      RETURNING sequence
    `);
    if (!acknowledged) return false;
    await connection.execute(
      sql`SELECT pg_notify('progressive_worker_evidence_changed', ${input.executionId})`,
    );
    return true;
  });
}

export async function quarantineProgressiveWorkerReportConflicts(
  db: DB,
  input: {
    executionId: string;
    solverId: string;
    reason: string;
  },
): Promise<number> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(
      sql`SELECT id FROM sim_jobs WHERE id = ${input.executionId}::uuid FOR UPDATE`,
    );
    const pending = await connection.execute(sql`
      SELECT sequence,content_signature,resolve_progressive_report(to_jsonb(progressive_worker_reports.*)) AS report
      FROM progressive_worker_reports
      WHERE sim_job_id = ${input.executionId}::uuid
        AND report->>'solverId' = ${input.solverId}
        AND acknowledged_at IS NULL
      ORDER BY sequence
      LIMIT ${STALE_REPORT_QUARANTINE_BATCH_SIZE}
    `);
    if (!pending.length) return 0;
    const sequences = sql.join(
      pending.map((row) => sql`${String(row.sequence)}::bigint`),
      sql`, `,
    );
    for (const row of pending) {
      const report = await resolveStoredProgressiveReport(connection, "worker", row, input.executionId);
      await connection.execute(sql`
        INSERT INTO progressive_worker_report_conflicts
          (sim_job_id,sequence,content_signature,report,reason)
        VALUES (${input.executionId}::uuid,${row.sequence},${row.content_signature},${JSON.stringify(report)}::jsonb,${input.reason})
        ON CONFLICT (sim_job_id,sequence) DO NOTHING
      `);
    }
    const acknowledged = await connection.execute(sql`
      UPDATE progressive_worker_reports
      SET acknowledged_at = coalesce(acknowledged_at, clock_timestamp())
      WHERE sim_job_id = ${input.executionId}::uuid
        AND report->>'solverId' = ${input.solverId}
        AND sequence IN (${sequences})
        AND acknowledged_at IS NULL
      RETURNING sequence
    `);
    if (acknowledged.length)
      await connection.execute(
        sql`SELECT pg_notify('progressive_worker_evidence_changed', ${input.executionId})`,
      );
    return acknowledged.length;
  });
}
