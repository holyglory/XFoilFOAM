import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import {
  validateProgressiveRemoteReport,
  type ProgressiveRemoteReport,
} from "../src/progressive-remote-report";
import type { ProgressiveRemoteExecutionEnvelope } from "../src/progressive-remote-execution";
import type { EngineClient } from "../../engine-client/src";
import { existingProgressiveReportAttempts } from "../../../apps/sweeper/src/progressive-evidence-reuse";
import { stageProgressiveWorkerEvidence } from "../../../apps/sweeper/src/progressive-worker-evidence";
import {
  analysisContentHash,
  progressiveReportedPointSources,
  progressiveRemotePointProjection,
} from "../src/index";

export async function verifyProgressiveEvidenceReuse(
  db: DB,
  executionId: string,
) {
  const rollback = new Error("Rollback isolated repeated-source report");
  await expect(
    db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const [source] =
        await connection.execute(sql`SELECT report.report,job.request_payload,
      (SELECT max(sequence)+1 FROM progressive_worker_reports WHERE sim_job_id=${executionId}::uuid) AS next_sequence
      FROM progressive_worker_reports report JOIN sim_jobs job ON job.id=report.sim_job_id
      JOIN progressive_worker_evidence_receipts receipt ON receipt.sim_job_id=report.sim_job_id AND receipt.sequence=report.sequence
      WHERE report.sim_job_id=${executionId}::uuid ORDER BY report.sequence LIMIT 1`);
      const envelope = (
        source.request_payload as {
          remoteProgressiveExecution: ProgressiveRemoteExecutionEnvelope;
        }
      ).remoteProgressiveExecution;
      const repeated = {
        ...(source.report as unknown as ProgressiveRemoteReport),
        sequence: Number(source.next_sequence),
      };
      const validated = validateProgressiveRemoteReport(repeated, envelope);
      const before = await connection.execute(
        sql`SELECT * FROM result_attempts WHERE sim_job_id=${executionId}::uuid ORDER BY id`,
      );
      const projected = progressiveRemotePointProjection({
        ...progressiveReportedPointSources(repeated.result!)[0],
        report: repeated,
        envelope,
      });
      for (const field of [
        "aoaDeg",
        "status",
        "source",
        "regime",
        "cl",
        "cd",
        "cm",
        "clCd",
        "clStd",
        "cdStd",
        "cmStd",
        "stalled",
        "unsteady",
        "converged",
        "finalResidual",
        "iterations",
        "yPlusAvg",
        "yPlusMax",
        "nCells",
        "firstOrderFallback",
        "strouhal",
        "error",
        "methodKey",
        "engineJobId",
        "engineCaseSlug",
      ] as const) {
        const key = field.replace(
          /[A-Z]/g,
          (letter) => `_${letter.toLowerCase()}`,
        );
        expect(analysisContentHash(before[0][key] ?? null), field).toBe(
          analysisContentHash(projected[field] ?? null),
        );
      }
      const oldReportReceipts = await connection.execute(
        sql`SELECT * FROM progressive_worker_evidence_receipts WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`,
      );
      expect(
        await existingProgressiveReportAttempts(connection, repeated, envelope),
      ).toEqual(before.map((row) => String(row.id)));
      const changed = structuredClone(repeated);
      const changedPoint = progressiveReportedPointSources(changed.result!)[0]
        .point;
      changedPoint.cl = (changedPoint.cl ?? 0) + 0.5;
      expect(
        await existingProgressiveReportAttempts(connection, changed, envelope),
      ).toBeNull();
      expect(
        await existingProgressiveReportAttempts(
          connection,
          { ...repeated, sequence: 0 },
          envelope,
        ),
      ).toBeNull();
      const refused = new Error("Rollback unacknowledged prior source");
      await expect(
        transaction.transaction(async (nested) => {
          await nested.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
          SELECT * FROM public.result_attempts WHERE sim_job_id=${executionId}::uuid`);
          await nested.execute(
            sql`UPDATE result_attempts SET cl=coalesce(cl,0)+0.5`,
          );
          expect(
            await existingProgressiveReportAttempts(
              nested as unknown as DB,
              repeated,
              envelope,
            ),
          ).toBeNull();
          throw refused;
        }),
      ).rejects.toBe(refused);
      await expect(
        transaction.transaction(async (nested) => {
          await nested.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
            SELECT * FROM public.progressive_worker_reports WHERE sim_job_id=${executionId}::uuid`);
          await nested.execute(
            sql`UPDATE progressive_worker_reports SET acknowledged_at=NULL WHERE sim_job_id=${executionId}::uuid`,
          );
          expect(
            await existingProgressiveReportAttempts(
              nested as unknown as DB,
              repeated,
              envelope,
            ),
          ).toBeNull();
          throw refused;
        }),
      ).rejects.toBe(refused);
      await connection.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,acknowledged_at)
      VALUES(${executionId}::uuid,${repeated.sequence},${validated.contentSignature},${JSON.stringify(repeated)}::jsonb,clock_timestamp())`);
      const engine = new Proxy(
        {},
        {
          get() {
            throw new Error(
              "Repeated immutable evidence must not call the engine",
            );
          },
        },
      ) as EngineClient;
      await expect(
        transaction.transaction(async (nested) => {
          await expect(
            stageProgressiveWorkerEvidence(
              nested as unknown as DB,
              engine,
              executionId,
              {
                reportSequence: repeated.sequence,
                afterEvidenceStaged: async () => {
                  await nested.execute(
                    sql`UPDATE sim_jobs SET ingest_lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${executionId}::uuid`,
                  );
                },
              },
            ),
          ).rejects.toThrow();
          const [unpublished] =
            await nested.execute(sql`SELECT count(*)::int AS count FROM progressive_worker_evidence_receipts
          WHERE sim_job_id=${executionId}::uuid AND sequence=${repeated.sequence}`);
          expect(unpublished.count).toBe(0);
          throw refused;
        }),
      ).rejects.toBe(refused);
      const result = await stageProgressiveWorkerEvidence(
        connection,
        engine,
        executionId,
        { reportSequence: repeated.sequence },
      );
      expect(result).toMatchObject({
        kind: "staged",
        sequence: repeated.sequence,
        reusedEvidence: true,
        resultAttemptIds: before.map((row) => row.id),
      });
      expect(
        await connection.execute(
          sql`SELECT * FROM result_attempts WHERE sim_job_id=${executionId}::uuid ORDER BY id`,
        ),
      ).toEqual(before);
      const afterReceipts = await connection.execute(
        sql`SELECT * FROM progressive_worker_evidence_receipts WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`,
      );
      expect(afterReceipts.slice(0, -1)).toEqual(oldReportReceipts);
      expect(afterReceipts).toHaveLength(oldReportReceipts.length + 1);
      const [association] =
        await connection.execute(sql`SELECT result_attempt_id FROM progressive_worker_evidence_attempts
      WHERE sim_job_id=${executionId}::uuid AND sequence=${repeated.sequence}`);
      expect(association.result_attempt_id).toBe(before[0].id);
      expect(
        await stageProgressiveWorkerEvidence(connection, engine, executionId, {
          reportSequence: repeated.sequence,
        }),
      ).toEqual({ kind: "idle" });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
