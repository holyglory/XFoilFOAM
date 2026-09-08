import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { indexProgressiveRemoteReport } from "./progressive-remote-inventory";
import type { ProgressiveRemoteExecutionEnvelope } from "./progressive-remote-execution";
import {
  validateProgressiveRemoteReport,
  validateProgressiveRemoteReportOrder,
  type ProgressiveRemoteReport,
} from "./progressive-remote-report";

export class ProgressiveRemoteReportConflict extends Error {}

export async function storeProgressiveRemoteReport(
  db: DB,
  input: {
    solverId: string;
    promiseId: string;
    executionId: string;
    report: unknown;
  },
): Promise<{
  executionId: string;
  sequence: number;
  contentSignature: string;
  replayed: boolean;
}> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [dispatch] = await connection.execute(sql`
      SELECT dispatch.envelope FROM progressive_remote_dispatches dispatch
      JOIN registered_remote_solvers solver ON solver.id = dispatch.solver_id
      WHERE dispatch.sim_job_id = ${input.executionId}::uuid
        AND dispatch.solver_id = ${input.solverId}::uuid AND dispatch.promise_id = ${input.promiseId}::uuid
        AND solver.revoked_at IS NULL
      FOR UPDATE OF dispatch
    `);
    if (!dispatch)
      throw new ProgressiveRemoteReportConflict(
        "Remote report sender does not own the immutable dispatch",
      );
    let validated: ReturnType<typeof validateProgressiveRemoteReport>;
    try {
      validated = validateProgressiveRemoteReport(
        input.report,
        dispatch.envelope as unknown as ProgressiveRemoteExecutionEnvelope,
      );
    } catch (error) {
      throw new ProgressiveRemoteReportConflict(
        error instanceof Error
          ? error.message
          : "Malformed remote execution report",
      );
    }
    const { report, contentSignature } = validated;
    const receipt = {
      executionId: input.executionId,
      sequence: report.sequence,
      contentSignature,
    };
    const [existing] = await connection.execute(sql`
      SELECT content_signature FROM progressive_remote_reports
      WHERE sim_job_id = ${input.executionId}::uuid AND sequence = ${report.sequence}
    `);
    if (existing) {
      if (existing.content_signature !== contentSignature)
        throw new ProgressiveRemoteReportConflict(
          "Remote report replay changed immutable content",
        );
      await indexProgressiveRemoteReport(connection, {
        report,
        reportContentSignature: contentSignature,
      });
      return { ...receipt, replayed: true };
    }
    const [latest] = await connection.execute(sql`
      SELECT sequence, report FROM progressive_remote_reports WHERE sim_job_id = ${input.executionId}::uuid
      ORDER BY sequence DESC LIMIT 1
    `);
    try {
      validateProgressiveRemoteReportOrder(
        report,
        latest ? (latest.report as unknown as ProgressiveRemoteReport) : null,
      );
    } catch (error) {
      throw new ProgressiveRemoteReportConflict(
        error instanceof Error ? error.message : "Invalid remote report order",
      );
    }
    await connection.execute(sql`
      INSERT INTO progressive_remote_reports (sim_job_id, sequence, content_signature, report)
      VALUES (${input.executionId}::uuid, ${report.sequence}, ${contentSignature}, ${JSON.stringify(report)}::jsonb)
    `);
    await indexProgressiveRemoteReport(connection, {
      report,
      reportContentSignature: contentSignature,
    });
    await connection.execute(
      sql`SELECT pg_notify('progressive_remote_report_changed', ${input.executionId})`,
    );
    return { ...receipt, replayed: false };
  });
}
