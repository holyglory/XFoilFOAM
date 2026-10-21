import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";
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
      const retriedDrain = await reconcileProgressiveRemoteProgress(connection, {
        jobIds: [executionId],
      });
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
              if (status === "cancelled")
                await verifyPublicationRecovery(scoped, executionId);
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
