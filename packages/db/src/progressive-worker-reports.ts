import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { canonicalAnalysisJson } from "./analysis-target";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import {
  isFinalProgressiveRemoteReport,
  validateProgressiveRemoteReport,
  validateProgressiveRemoteReportOrder,
  type ProgressiveRemoteReport,
} from "./progressive-remote-report";

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
      SELECT sequence, content_signature, report FROM progressive_worker_reports
      WHERE sim_job_id = ${input.executionId}::uuid ORDER BY sequence DESC LIMIT 1
    `);
    const content = { ...input, version: 1 as const };
    if (latest) {
      const replay = validateProgressiveRemoteReport(
        { ...content, sequence: Number(latest.sequence) },
        envelope,
      );
      if (replay.contentSignature === latest.content_signature)
        return {
          executionId: input.executionId,
          sequence: Number(latest.sequence),
          contentSignature: replay.contentSignature,
          replayed: true,
        };
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
    )
      return {
        executionId: input.executionId,
        sequence: Number(latest.sequence),
        contentSignature: String(latest.content_signature),
        replayed: true,
      };
    await connection.execute(sql`
      INSERT INTO progressive_worker_reports (sim_job_id, sequence, content_signature, report)
      VALUES (${input.executionId}::uuid, ${next.report.sequence}, ${next.contentSignature}, ${JSON.stringify(next.report)}::jsonb)
    `);
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
    SELECT report.sequence, report.content_signature, report.report FROM progressive_worker_reports report
    WHERE report.sim_job_id = ${input.executionId}::uuid AND report.report->>'solverId' = ${input.solverId}
      AND report.acknowledged_at IS NULL ORDER BY report.sequence LIMIT 1
  `);
  return row
    ? {
        executionId: input.executionId,
        sequence: Number(row.sequence),
        contentSignature: String(row.content_signature),
        report: row.report as unknown as ProgressiveRemoteReport,
      }
    : null;
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
  });
}
