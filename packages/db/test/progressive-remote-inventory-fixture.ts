import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";
import { resultAttempts, results } from "../src/schema";
import { resolveProgressiveRemoteEvidence } from "../src/progressive-remote-evidence";
import { recordProgressiveRemoteEvidenceReceipt } from "../src/progressive-remote-evidence-receipts";
import { progressiveRemotePointProjection } from "../src/progressive-remote-point-projection";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import { readProgressiveRemoteRetention } from "../src/progressive-remote-retention";
import {
  indexProgressiveRemoteReport,
  progressiveRemoteReportInventory,
} from "../src/progressive-remote-inventory";
import {
  applyProgressiveRemoteProgress,
  reconcileProgressiveRemoteProgress,
} from "../../../apps/sweeper/src/progressive-remote-progress";
import { settleProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-settlement";
import { verifyPublicationRecovery } from "./progressive-publication-recovery-fixture";
import { verifyRetainedReports } from "./retained-report-fixture";

export async function verifyProgressiveRemoteReportInventory(
  db: DB,
  terminal: ProgressiveRemoteReport,
) {
  const rollback = new Error(
    "Rollback isolated remote report inventory fixture",
  );
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const executionId = terminal.executionId;
      const [index] =
        await connection.execute(sql`SELECT indisvalid,pg_get_expr(indpred,indrelid) AS predicate
        FROM pg_index WHERE indexrelid='progressive_remote_reports_stop_candidate_idx'::regclass`);
      expect(index.indisvalid).toBe(true);
      expect(index.predicate).toContain("stopProof,execution_stopped");
      const candidateIds =
        await connection.execute(sql`SELECT sim_job_id,sequence FROM progressive_remote_reports
        WHERE sim_job_id=${executionId}::uuid AND report#>>'{stopProof,execution_stopped}'='true' ORDER BY sequence`);
      expect(
        candidateIds.map((row) => ({ ...row, sequence: Number(row.sequence) })),
      ).toEqual([{ sim_job_id: executionId, sequence: terminal.sequence }]);
      const explainRollback = new Error("Restore planner diagnostic flags");
      try {
        await connection.transaction(async (nested) => {
          await nested.execute(sql`SET LOCAL enable_seqscan=off`);
          await nested.execute(sql`SET LOCAL enable_bitmapscan=off`);
          const [plan] =
            await nested.execute(sql`EXPLAIN(FORMAT JSON) SELECT sim_job_id FROM progressive_remote_reports
            WHERE report#>>'{stopProof,execution_stopped}'='true' ORDER BY sim_job_id LIMIT 96`);
          expect(JSON.stringify(plan)).toContain(
            "progressive_remote_reports_stop_candidate_idx",
          );
          throw explainRollback;
        });
      } catch (error) {
        if (error !== explainRollback) throw error;
      }
      const sender = {
        executionId,
        solverId: terminal.solverId,
        promiseId: terminal.promiseId,
      };
      const inventory = progressiveRemoteReportInventory(terminal);
      expect(inventory.sources).toHaveLength(1);
      const readJob = async () => [
        ...(await connection.execute(sql`SELECT status, engine_state, completed_cases, "updatedAt"
        FROM sim_jobs WHERE id = ${executionId}::uuid`)),
      ];
      const before = await readJob();
      const staleProjectionRollback = new Error(
        "Rollback stale remote progress projection fixture",
      );
      await expect(
        connection.transaction(async (raw) => {
          const scoped = raw as unknown as DB;
          const reportsBefore =
            await scoped.execute(sql`SELECT sequence, content_signature
            FROM progressive_remote_reports WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`);
          const inventoriesBefore =
            await scoped.execute(sql`SELECT sequence, report_content_signature, inventory_signature, source_count
            FROM progressive_remote_report_inventories WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`);
          const receiptsBefore =
            await scoped.execute(sql`SELECT sequence, content_signature
            FROM progressive_remote_progress_receipts WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`);
          await scoped.execute(sql`UPDATE sim_jobs SET engine_job_id=NULL, engine_state=NULL,
            status='pending', completed_cases=0 WHERE id=${executionId}::uuid`);
          expect(
            await reconcileProgressiveRemoteProgress(scoped, {
              jobIds: [executionId],
            }),
          ).toMatchObject({ applied: 1, indexed: 0, errors: [] });
          const [projected] =
            await scoped.execute(sql`SELECT engine_job_id, engine_state, completed_cases
            FROM sim_jobs WHERE id=${executionId}::uuid`);
          expect(projected).toMatchObject({
            engine_job_id: executionId,
            engine_state: terminal.status.state,
            completed_cases: terminal.status.completed_cases,
          });
          expect(
            await scoped.execute(sql`SELECT sequence, content_signature
              FROM progressive_remote_reports WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`),
          ).toEqual(reportsBefore);
          expect(
            await scoped.execute(sql`SELECT sequence, report_content_signature, inventory_signature, source_count
              FROM progressive_remote_report_inventories WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`),
          ).toEqual(inventoriesBefore);
          expect(
            await scoped.execute(sql`SELECT sequence, content_signature
              FROM progressive_remote_progress_receipts WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`),
          ).toEqual(receiptsBefore);
          throw staleProjectionRollback;
        }),
      ).rejects.toBe(staleProjectionRollback);
      await connection.execute(
        sql`DELETE FROM progressive_remote_report_inventories WHERE sim_job_id = ${executionId}::uuid AND sequence = 2`,
      );
      expect(
        await applyProgressiveRemoteProgress(connection, executionId),
      ).toEqual({ kind: "indexed", sequence: 2 });
      expect(await readJob()).toEqual(before);
      expect(
        await applyProgressiveRemoteProgress(connection, executionId),
      ).toEqual({ kind: "idle" });

      await expect(
        connection.transaction(async (raw) => {
          await (raw as unknown as DB)
            .execute(sql`UPDATE progressive_remote_report_sources SET aoa_deg = aoa_deg + 0.1
          WHERE sim_job_id = ${executionId}::uuid`);
        }),
      ).rejects.toThrow();
      await expect(
        connection.transaction(async (raw) => {
          await (raw as unknown as DB)
            .execute(sql`UPDATE progressive_remote_report_inventories SET source_count = 0
          WHERE sim_job_id = ${executionId}::uuid AND sequence = 2`);
        }),
      ).rejects.toThrow();
      await expect(
        indexProgressiveRemoteReport(connection, {
          report: terminal,
          reportContentSignature: "0".repeat(64),
        }),
      ).rejects.toThrow("immutable report");

      const stoppedStatus = structuredClone(terminal.status);
      for (const progress of stoppedStatus.solver_budget_progress?.cases ?? [])
        progress.solver_running = false;
      const empty = {
        ...terminal,
        sequence: terminal.sequence,
        status: { ...stoppedStatus, state: "running" as const },
        result: null,
        stopProof: null,
      };
      await connection.execute(sql`DELETE FROM progressive_remote_reports
        WHERE sim_job_id = ${executionId}::uuid AND sequence = ${terminal.sequence}`);
      await storeProgressiveRemoteReport(connection, {
        ...sender,
        report: empty,
      });
      const changed = structuredClone(terminal);
      changed.sequence += 1;
      changed.status = { ...stoppedStatus, state: "running" };
      changed.stopProof = null;
      changed.result!.state = "running";
      changed.result!.polars[0].attempts![0].cl = 0.314159;
      await storeProgressiveRemoteReport(connection, {
        ...sender,
        report: changed,
      });
      expect(
        await storeProgressiveRemoteReport(connection, {
          ...sender,
          report: changed,
        }),
      ).toMatchObject({ replayed: true });
      const final = {
        ...terminal,
        sequence: terminal.sequence + 2,
        status: stoppedStatus,
        result: { ...terminal.result!, polars: [] },
      };
      await storeProgressiveRemoteReport(connection, {
        ...sender,
        report: final,
      });
      expect(
        await readProgressiveRemoteRetention(connection, executionId),
      ).toMatchObject({
        kind: "waiting",
        reason: "raw_evidence",
        sourceCount: 2,
        pendingCount: 2,
      });
      await expect(
        storeProgressiveRemoteReport(connection, {
          ...sender,
          report: {
            ...final,
            sequence: final.sequence + 1,
            result: changed.result,
          },
        }),
      ).rejects.toThrow("Final remote execution evidence cannot change");
      const inventories =
        await connection.execute(sql`SELECT sequence::integer, source_count FROM progressive_remote_report_inventories
        WHERE sim_job_id = ${executionId}::uuid ORDER BY sequence`);
      expect([...inventories]).toEqual([
        { sequence: 1, source_count: 0 },
        { sequence: 2, source_count: 1 },
        { sequence: 3, source_count: 0 },
        { sequence: 4, source_count: 1 },
        { sequence: 5, source_count: 0 },
      ]);
      const sources =
        await connection.execute(sql`SELECT DISTINCT point_content_signature FROM progressive_remote_report_sources
        WHERE sim_job_id = ${executionId}::uuid ORDER BY point_content_signature`);
      expect(sources).toHaveLength(2);
      expect(
        sources.some(
          (source) =>
            source.point_content_signature ===
            inventory.sources[0].point_content_signature,
        ),
      ).toBe(true);
      const [counts] = await connection.execute(sql`SELECT
        (SELECT count(*)::integer FROM progressive_remote_evidence_receipts WHERE sim_job_id = ${executionId}::uuid) AS received,
        (SELECT count(*)::integer FROM result_attempts WHERE sim_job_id = ${executionId}::uuid) AS attempts`);
      expect(counts).toEqual({ received: 0, attempts: 0 });
      await verifyRetainedReports(connection, executionId);
      await connection.execute(sql`CREATE TEMP TABLE progressive_report_retry_source ON COMMIT DROP AS
        SELECT sim_job_id, sequence, content_signature, report, received_at
        FROM progressive_remote_reports
        WHERE sim_job_id=${executionId}::uuid AND sequence=${final.sequence}`);
      await connection.execute(sql`
        CREATE FUNCTION pg_temp.progressive_test_fail_poll() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."polledAt" IS DISTINCT FROM OLD."polledAt"
            AND current_setting('progressive_test.fail_poll', true) = '1' THEN
            RAISE EXCEPTION 'synthetic progress polling failure';
          END IF;
          RETURN NEW;
        END;
        $$`);
      await connection.execute(sql`
        CREATE TRIGGER progressive_test_fail_poll
        BEFORE UPDATE ON sim_jobs
        FOR EACH ROW EXECUTE FUNCTION pg_temp.progressive_test_fail_poll()`);
      await connection.execute(sql`SET LOCAL progressive_test.fail_poll = '1'`);
      await connection.execute(sql`DELETE FROM progressive_remote_reports
        WHERE sim_job_id=${executionId}::uuid AND sequence=${final.sequence}`);
      await connection.execute(sql`
        INSERT INTO progressive_remote_reports
          (sim_job_id, sequence, content_signature, report, received_at)
        SELECT sim_job_id, sequence, repeat('0', 64), report, received_at
        FROM progressive_report_retry_source`);
      const failedDrain = await reconcileProgressiveRemoteProgress(connection, {
        jobIds: [executionId],
      });
      expect(failedDrain).toMatchObject({
        applied: 2,
        indexed: 0,
        stopped: 0,
      });
      expect(failedDrain.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            executionId,
            reason: expect.stringContaining(
              "Remote progress bytes differ from their immutable receipt",
            ),
          }),
          expect.objectContaining({
            executionId,
            reason: expect.stringContaining(
              "synthetic progress polling failure",
            ),
          }),
        ]),
      );
      expect(
        (
          await connection.execute(sql`SELECT sequence FROM progressive_remote_progress_receipts
            WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`)
        ).map((row) => Number(row.sequence)),
      ).toEqual([1, 2, 3, 4]);
      await connection.execute(sql`SET LOCAL progressive_test.fail_poll = '0'`);
      await connection.execute(sql`DELETE FROM progressive_remote_reports
        WHERE sim_job_id=${executionId}::uuid AND sequence=${final.sequence}`);
      await connection.execute(sql`
        INSERT INTO progressive_remote_reports
          (sim_job_id, sequence, content_signature, report, received_at)
        SELECT sim_job_id, sequence, content_signature, report, received_at
        FROM progressive_report_retry_source`);
      const retriedDrain = await reconcileProgressiveRemoteProgress(
        connection,
        {
          jobIds: [executionId],
        },
      );
      expect(retriedDrain).toMatchObject({
        applied: 1,
        indexed: 0,
        stopped: 1,
        errors: [],
      });
      expect(
        (
          await connection.execute(sql`SELECT sequence FROM progressive_remote_progress_receipts
            WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`)
        ).map((row) => Number(row.sequence)),
      ).toEqual([1, 2, 3, 4, 5]);
      await connection.execute(sql`UPDATE sim_campaigns SET status='active'
        WHERE id=(SELECT campaign_id FROM sim_jobs WHERE id=${executionId}::uuid)`);
      for (const status of [
        "active",
        "expired",
        "fulfilled",
        "cancelled",
      ] as const) {
        const restore = new Error("Restore isolated promise settlement state");
        try {
          await connection.transaction(async (nested) => {
            const scoped = nested as unknown as DB;
            await scoped.execute(sql`UPDATE sync_sweep_promises SET status=${status}::sync_promise_status
              WHERE id=${terminal.promiseId}::uuid`);
            const evidenceBefore =
              await scoped.execute(sql`SELECT sequence,content_signature FROM progressive_remote_reports
              WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`);
            if (status === "active" || status === "fulfilled") {
              expect(
                await settleProgressiveRemoteJob(scoped, executionId),
              ).toMatchObject({ kind: "waiting", reason: "raw_evidence" });
            } else {
              const missingStop = new Error("Restore exact physical stop");
              try {
                await scoped.transaction(async (isolated) => {
                  const unstopped = isolated as unknown as DB;
                  await unstopped.execute(sql`DELETE FROM progressive_cfd_execution_stops
                    WHERE sim_job_id=${executionId}::uuid`);
                  expect(
                    await settleProgressiveRemoteJob(unstopped, executionId),
                  ).toMatchObject({ kind: "waiting", reason: "physical_stop" });
                  throw missingStop;
                });
              } catch (error) {
                if (error !== missingStop) throw error;
              }
              await expect(
                scoped.transaction(async (isolated) => {
                  const unowned = isolated as unknown as DB;
                  await unowned.execute(sql`UPDATE progressive_cfd_units SET state='pending',lease_token=NULL,lease_owner=NULL,lease_until=NULL
                  WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
                  await settleProgressiveRemoteJob(unowned, executionId);
                }),
              ).rejects.toThrow("no longer owns");
              for (const delta of [-1, 0, 0.125]) {
                const restoreBudget = new Error(
                  "Restore isolated exhausted budget",
                );
                try {
                  await scoped.transaction(async (isolated) => {
                    const exhausted = isolated as unknown as DB;
                    await exhausted.execute(sql`UPDATE progressive_cfd_units SET state='blocked',lease_token=NULL,lease_owner=NULL,lease_until=NULL,
                      active_seconds=active_budget_seconds+${delta}
                      WHERE id IN (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
                    if (delta < 0)
                      await expect(
                        settleProgressiveRemoteJob(exhausted, executionId),
                      ).rejects.toThrow("no longer owns");
                    else {
                      expect(
                        await settleProgressiveRemoteJob(
                          exhausted,
                          executionId,
                        ),
                      ).toMatchObject({
                        kind: "settled",
                        evidencePending: true,
                        counts: { complete: 0, retry: 0 },
                      });
                      const [retained] = await exhausted.execute(
                        sql`SELECT "ingestedAt" FROM sim_jobs WHERE id=${executionId}::uuid`,
                      );
                      expect(retained.ingestedAt).toBeNull();
                    }
                    throw restoreBudget;
                  });
                } catch (error) {
                  if (error !== restoreBudget) throw error;
                }
              }
              await scoped.execute(sql`UPDATE sim_jobs SET ingest_lease_expires_at=clock_timestamp()+interval '1 minute'
                WHERE id=${executionId}::uuid`);
              expect(
                await settleProgressiveRemoteJob(scoped, executionId),
              ).toMatchObject({ kind: "waiting", reason: "ingestion_owner" });
              await scoped.execute(
                sql`UPDATE sim_jobs SET ingest_lease_expires_at=NULL WHERE id=${executionId}::uuid`,
              );
              expect(
                await settleProgressiveRemoteJob(scoped, executionId),
              ).toMatchObject({
                kind: "settled",
                evidencePending: true,
                counts: { complete: 0, retry: 0, waiting: 0 },
              });
              const [job] = await scoped.execute(
                sql`SELECT status,"ingestedAt" FROM sim_jobs WHERE id=${executionId}::uuid`,
              );
              expect(job).toEqual({ status: "cancelled", ingestedAt: null });
              const attempts =
                await scoped.execute(sql`SELECT attempt.outcome,unit.state,unit.lease_token
                FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
                WHERE attempt.sim_job_id=${executionId}::uuid`);
              expect(attempts.length).toBeGreaterThan(0);
              expect(
                attempts.every(
                  (attempt) =>
                    attempt.outcome === "cancelled" &&
                    attempt.state === "gap" &&
                    attempt.lease_token === null,
                ),
              ).toBe(true);
              expect(
                await settleProgressiveRemoteJob(scoped, executionId),
              ).toMatchObject({
                kind: "settled",
                evidencePending: true,
                counts: {
                  complete: 0,
                  retry: 0,
                  gaps: 0,
                  cancelled: 0,
                  waiting: 0,
                },
              });
              expect(
                await readProgressiveRemoteRetention(scoped, executionId),
              ).toMatchObject({
                kind: "waiting",
                reason: "raw_evidence",
                pendingCount: 2,
              });
              const [rows] = await scoped.execute(
                sql`SELECT count(*)::integer AS count FROM result_attempts WHERE sim_job_id=${executionId}::uuid`,
              );
              expect(rows.count).toBe(0);
              if (status === "cancelled") {
                await verifyPublicationRecovery(scoped, executionId);
                await verifyBoundedRetentionHistory(scoped, changed, final);
              }
            }
            expect(
              await scoped.execute(sql`SELECT sequence,content_signature FROM progressive_remote_reports
              WHERE sim_job_id=${executionId}::uuid ORDER BY sequence`),
            ).toEqual(evidenceBefore);
            throw restore;
          });
        } catch (error) {
          if (error !== restore) throw error;
        }
      }
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function verifyBoundedRetentionHistory(
  db: DB,
  running: ProgressiveRemoteReport,
  final: ProgressiveRemoteReport,
) {
  const rollback = new Error("Restore bounded retention history fixture");
  await expect(
    db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const executionId = final.executionId;
      const [original] =
        await connection.execute(sql`SELECT report FROM progressive_remote_reports
        WHERE sim_job_id=${executionId}::uuid AND sequence=2`);
      const repeated = original.report as ProgressiveRemoteReport;
      let finalSequence = final.sequence;
      const appendHistory = async (history: ProgressiveRemoteReport[]) => {
        await connection.execute(sql`DELETE FROM progressive_remote_reports
          WHERE sim_job_id=${executionId}::uuid AND sequence=${finalSequence}`);
        const rows = [...history, final].map((report, offset) => {
          const stored = { ...report, sequence: finalSequence + offset };
          const inventory = progressiveRemoteReportInventory(stored);
          return { sequence: stored.sequence, report: stored, ...inventory };
        });
        finalSequence += history.length;
        const payload = JSON.stringify(rows);
        await connection.execute(sql`INSERT INTO progressive_remote_reports
          (sim_job_id,sequence,content_signature,report)
          SELECT ${executionId}::uuid,sequence,"reportContentSignature",report
          FROM jsonb_to_recordset(${payload}::jsonb)
            AS item(sequence bigint,"reportContentSignature" text,report jsonb)`);
        await connection.execute(sql`INSERT INTO progressive_remote_report_inventories
          (sim_job_id,sequence,report_content_signature,inventory_signature,source_count)
          SELECT ${executionId}::uuid,sequence,"reportContentSignature","inventorySignature",jsonb_array_length(sources)
          FROM jsonb_to_recordset(${payload}::jsonb)
            AS item(sequence bigint,"reportContentSignature" text,"inventorySignature" text,sources jsonb)`);
        await connection.execute(sql`INSERT INTO progressive_remote_report_sources
          (sim_job_id,sequence,point_content_signature,aoa_deg,case_slug)
          SELECT ${executionId}::uuid,item.sequence,source.point_content_signature,source.aoa_deg,source.case_slug
          FROM jsonb_to_recordset(${payload}::jsonb) AS item(sequence bigint,sources jsonb)
          CROSS JOIN LATERAL jsonb_to_recordset(item.sources)
            AS source(point_content_signature text,aoa_deg double precision,case_slug text)`);
      };
      await appendHistory(Array.from({ length: 2050 }, () => repeated));
      const [history] =
        await connection.execute(sql`SELECT count(*)::integer AS count
        FROM progressive_remote_report_sources WHERE sim_job_id=${executionId}::uuid`);
      expect(history.count).toBe(2052);
      expect(
        await readProgressiveRemoteRetention(connection, executionId),
      ).toMatchObject({
        kind: "waiting",
        reason: "raw_evidence",
        sourceCount: 2,
        pendingCount: 2,
      });
      for (const sequence of [1, 2]) {
        const restore = new Error("Restore missing historical inventory");
        await expect(
          connection.transaction(async (nested) => {
            const scoped = nested as unknown as DB;
            await scoped.execute(sql`DELETE FROM progressive_remote_report_inventories
            WHERE sim_job_id=${executionId}::uuid AND sequence=${sequence}`);
            expect(
              await readProgressiveRemoteRetention(scoped, executionId),
            ).toEqual({
              kind: "waiting",
              reason: "source_inventory",
            });
            throw restore;
          }),
        ).rejects.toBe(restore);
      }
      const missingSource = new Error("Restore incomplete source inventory");
      await expect(
        connection.transaction(async (nested) => {
          const scoped = nested as unknown as DB;
          await scoped.execute(sql`DELETE FROM progressive_remote_report_sources
          WHERE sim_job_id=${executionId}::uuid AND sequence=2`);
          expect(
            await readProgressiveRemoteRetention(scoped, executionId),
          ).toEqual({
            kind: "waiting",
            reason: "source_inventory",
          });
          throw missingSource;
        }),
      ).rejects.toBe(missingSource);
      const originalPoint =
        progressiveRemoteReportInventory(repeated).sources[0];
      for (const identity of [
        { aoa: originalPoint.aoa_deg + 0.125, slug: originalPoint.case_slug },
        { aoa: originalPoint.aoa_deg, slug: "conflicting-retention-case" },
        { aoa: originalPoint.aoa_deg, slug: null },
      ]) {
        const restore = new Error("Restore conflicting source identity");
        await expect(
          connection.transaction(async (nested) => {
            const scoped = nested as unknown as DB;
            await scoped.execute(sql`DELETE FROM progressive_remote_report_sources
            WHERE sim_job_id=${executionId}::uuid AND sequence=${final.sequence}`);
            await scoped.execute(sql`INSERT INTO progressive_remote_report_sources
            (sim_job_id,sequence,point_content_signature,aoa_deg,case_slug)
            VALUES (${executionId}::uuid,${final.sequence},${originalPoint.point_content_signature},${identity.aoa},${identity.slug})`);
            expect(
              await readProgressiveRemoteRetention(scoped, executionId),
            ).toMatchObject({
              kind: "waiting",
              reason: "raw_evidence",
              sourceCount: 3,
              pendingCount: 3,
            });
            throw restore;
          }),
        ).rejects.toBe(restore);
      }

      const receiptRollback = new Error("Restore exact historical receipt");
      await expect(
        connection.transaction(async (nested) => {
          const scoped = nested as unknown as DB;
          const inventory = progressiveRemoteReportInventory(repeated);
          const point = inventory.sources[0];
          const delivery = {
            solverId: final.solverId,
            promiseId: final.promiseId,
            engineJobId: executionId,
            aoaDeg: point.aoa_deg,
            engineCaseSlug: point.case_slug,
            remoteResultId: randomUUID(),
            remoteResultAttemptId: randomUUID(),
            progressiveEvidence: {
              sequence: repeated.sequence,
              reportContentSignature: inventory.reportContentSignature,
              pointContentSignature: point.point_content_signature,
            },
          };
          const source = await resolveProgressiveRemoteEvidence(
            scoped,
            delivery,
          );
          if (!source) throw new Error("Missing historical retention source");
          const projection = progressiveRemotePointProjection(source);
          const [job] =
            await scoped.execute(sql`SELECT airfoil_id,bc_ids,simulation_preset_revision_id
          FROM sim_jobs WHERE id=${executionId}::uuid`);
          const [existing] = await scoped.execute(sql`SELECT id FROM results
          WHERE airfoil_id=${job.airfoil_id}::uuid
            AND simulation_preset_revision_id=${job.simulation_preset_revision_id}::uuid AND aoa_deg=${point.aoa_deg}`);
          const resultId = existing ? String(existing.id) : randomUUID();
          if (!existing)
            await scoped.insert(results).values({
              id: resultId,
              airfoilId: String(job.airfoil_id),
              bcId: (job.bc_ids as string[])[0],
              simulationPresetRevisionId: String(
                job.simulation_preset_revision_id,
              ),
              aoaDeg: point.aoa_deg,
              status: "queued",
              source: "queued",
              simJobId: executionId,
            });
          const attemptId = randomUUID();
          await scoped.insert(resultAttempts).values({
            id: attemptId,
            resultId,
            airfoilId: String(job.airfoil_id),
            bcId: (job.bc_ids as string[])[0],
            simulationPresetRevisionId: String(
              job.simulation_preset_revision_id,
            ),
            simJobId: executionId,
            aoaDeg: projection.aoaDeg,
            status: projection.status,
            source: projection.source,
            regime: projection.regime,
            cl: projection.cl,
            cd: projection.cd,
            cm: projection.cm,
            clCd: projection.clCd,
            clStd: projection.clStd,
            cdStd: projection.cdStd,
            cmStd: projection.cmStd,
            stalled: projection.stalled,
            unsteady: projection.unsteady,
            converged: projection.converged,
            finalResidual: projection.finalResidual,
            iterations: projection.iterations,
            yPlusAvg: projection.yPlusAvg,
            yPlusMax: projection.yPlusMax,
            nCells: projection.nCells,
            firstOrderFallback: projection.firstOrderFallback,
            strouhal: projection.strouhal,
            error: projection.error,
            qualityWarnings: projection.qualityWarnings,
            methodKey: projection.methodKey,
            engineJobId: projection.engineJobId,
            engineCaseSlug: projection.engineCaseSlug,
            evidencePayload: projection.evidencePayload,
            validForPolar: false,
          });
          expect(
            await recordProgressiveRemoteEvidenceReceipt(scoped, {
              ...delivery,
              resultAttemptId: attemptId,
              storageOnly: true,
            }),
          ).toMatchObject({
            sequence: 2,
            resultAttemptId: attemptId,
            storageOnly: true,
          });
          expect(
            await readProgressiveRemoteRetention(scoped, executionId),
          ).toMatchObject({
            kind: "waiting",
            reason: "raw_evidence",
            sourceCount: 2,
            pendingCount: 1,
          });
          await scoped.execute(sql`DELETE FROM progressive_remote_reports
          WHERE sim_job_id=${executionId}::uuid AND sequence=${running.sequence}`);
          expect(
            await readProgressiveRemoteRetention(scoped, executionId),
          ).toMatchObject({
            kind: "waiting",
            reason: "archives",
            sourceCount: 1,
            pendingCount: 1,
          });
          const missingCfd = new Error(
            "Restore missing immutable CFD evidence",
          );
          await expect(
            scoped.transaction(async (isolated) => {
              const corrupted = isolated as unknown as DB;
              await corrupted.execute(sql`DELETE FROM progressive_remote_evidence_receipts
            WHERE sim_job_id=${executionId}::uuid AND point_content_signature=${point.point_content_signature}`);
              await corrupted.execute(sql`INSERT INTO progressive_remote_evidence_receipts
            (sim_job_id,sequence,point_content_signature,result_attempt_id,remote_result_id,remote_result_attempt_id,storage_only)
            VALUES (${executionId}::uuid,${repeated.sequence},${point.point_content_signature},${attemptId}::uuid,
              ${delivery.remoteResultId}::uuid,${delivery.remoteResultAttemptId}::uuid,false)`);
              await expect(
                readProgressiveRemoteRetention(corrupted, executionId),
              ).rejects.toThrow(
                "Remote retention differs from its immutable CFD evidence receipt",
              );
              throw missingCfd;
            }),
          ).rejects.toBe(missingCfd);
          await scoped.execute(
            sql`DELETE FROM result_attempts WHERE id=${attemptId}::uuid`,
          );
          expect(
            await readProgressiveRemoteRetention(scoped, executionId),
          ).toMatchObject({
            kind: "waiting",
            reason: "raw_evidence",
            sourceCount: 1,
            pendingCount: 1,
          });
          throw receiptRollback;
        }),
      ).rejects.toBe(receiptRollback);

      const generations = Array.from({ length: 2047 }, (_, offset) => {
        const report = structuredClone(running);
        report.result!.polars[0].attempts![0].error = `isolated retention generation ${offset}`;
        return report;
      });
      await appendHistory(generations.slice(0, 2046));
      expect(
        await readProgressiveRemoteRetention(connection, executionId),
      ).toMatchObject({
        kind: "waiting",
        reason: "raw_evidence",
        sourceCount: 2048,
        pendingCount: 2048,
      });
      await appendHistory(generations.slice(2046));
      await expect(
        readProgressiveRemoteRetention(connection, executionId),
      ).rejects.toThrow(
        "Remote retention exceeds the bounded source-attempt inventory",
      );
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
