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
import { applyProgressiveRemoteProgress } from "../../../apps/sweeper/src/progressive-remote-progress";
import { settleProgressiveRemoteJob } from "../../../apps/sweeper/src/progressive-remote-settlement";

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
      for (let sequence = 3; sequence <= final.sequence; sequence += 1)
        expect(
          await applyProgressiveRemoteProgress(connection, executionId),
        ).toMatchObject({ kind: "applied", sequence });
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
            if (status !== "cancelled") {
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
