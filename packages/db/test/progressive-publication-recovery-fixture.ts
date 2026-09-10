import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import { recoverProgressivePublicationLosses } from "../src/progressive-publication-recovery";
import { claimProgressiveCfdUnit } from "../src/progressive-cfd";
import { composeProgressiveCfdJob } from "../../../apps/sweeper/src/progressive-cfd-jobs";
import { progressiveCfdOrdinaryAttemptCountSql } from "../src/progressive-attempt-budget";

export async function verifyPublicationRecovery(db: DB, executionId: string) {
  const restore = new Error("Restore isolated publication recovery fixture");
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const [scope] =
        await connection.execute(sql`SELECT job.campaign_id,dispatch.promise_id,work.generation_id,work.target_id,
        unit.recipe,unit.active_budget_seconds-unit.active_seconds AS remaining
        FROM sim_jobs job JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
        JOIN progressive_cfd_attempts attempt ON attempt.sim_job_id=job.id JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        JOIN progressive_work work ON work.id=unit.work_id WHERE job.id=${executionId}::uuid LIMIT 1`);
      const recover = (target = connection) =>
        recoverProgressivePublicationLosses(target, String(scope.campaign_id));
      const original =
        await connection.execute(sql`SELECT token,outcome,active_seconds FROM progressive_cfd_attempts
        WHERE sim_job_id=${executionId}::uuid ORDER BY token`);
      expect(original.length).toBeGreaterThan(0);
      expect((await recover()).queuedUnits).toBe(0);
      await connection.execute(sql`UPDATE sync_sweep_promises SET response_payload=jsonb_build_object('remoteCancellation',
        jsonb_build_object('disposition','terminal_local_state','reason','remote job completed without canonical result evidence',
          'receivedAt',clock_timestamp())) WHERE id=${scope.promise_id}::uuid`);
      for (const blocked of ["paused", "cancelled", "archived"]) {
        await expect(
          connection.transaction(async (nested) => {
            const candidate = nested as unknown as DB;
            await candidate.execute(
              sql`UPDATE sim_campaigns SET status=${blocked} WHERE id=${scope.campaign_id}::uuid`,
            );
            await recover(candidate);
          }),
        ).rejects.toThrow("active campaign");
      }
      for (const mutation of [
        sql`UPDATE progressive_generations SET stage=3 WHERE id=${scope.generation_id}::uuid`,
        sql`UPDATE progressive_generations SET status='cancelled' WHERE id=${scope.generation_id}::uuid`,
        sql`UPDATE progressive_cfd_units SET active_seconds=active_budget_seconds WHERE id IN
          (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`,
        sql`DELETE FROM progressive_cfd_execution_stops WHERE sim_job_id=${executionId}::uuid`,
        sql`UPDATE sync_sweep_promises SET response_payload=jsonb_build_object('remoteCancellation',
          jsonb_build_object('disposition','operator_release','reason','remote job completed without canonical result evidence'))
          WHERE id=${scope.promise_id}::uuid`,
      ]) {
        const rollback = new Error("Restore rejected recovery scenario");
        try {
          await connection.transaction(async (nested) => {
            const candidate = nested as unknown as DB;
            await candidate.execute(mutation);
            expect((await recover(candidate)).queuedUnits).toBe(0);
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        }
      }
      const dryRun = new Error("Publication recovery dry run");
      try {
        await connection.transaction(async (nested) => {
          expect((await recover(nested as unknown as DB)).queuedUnits).toBe(
            original.length,
          );
          const temporary = nested as unknown as DB;
          const first = await claimProgressiveCfdUnit(temporary, {
            owner: "isolated-corrective-budget",
            leaseSeconds: 120,
            solverBudgetVersion: 2,
            sameTarget: {
              generationId: String(scope.generation_id),
              targetId: String(scope.target_id),
              recipe: scope.recipe as Record<string, unknown>,
              remainingActiveSeconds: Number(scope.remaining),
              recoveryParentJobId: null,
            },
          });
          expect(first).not.toBeNull();
          const [budget] =
            await temporary.execute(sql`SELECT unit.attempts,${progressiveCfdOrdinaryAttemptCountSql()} AS ordinary
            FROM progressive_cfd_units unit WHERE unit.id=${first!.id}::uuid`);
          expect(budget).toEqual({ attempts: 2, ordinary: 1 });
          throw dryRun;
        });
      } catch (error) {
        if (error !== dryRun) throw error;
      }
      const [notRecorded] = await connection.execute(
        sql`SELECT count(*)::integer AS count FROM progressive_publication_recoveries WHERE sim_job_id=${executionId}::uuid`,
      );
      expect(notRecorded.count).toBe(0);
      await connection.execute(sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,lease_until,started_at,outcome,finished_at)
        SELECT gen_random_uuid(),unit.id,'isolated-expired-claim',clock_timestamp()-interval '1 hour',attempt.started_at-interval '1 hour','expired',clock_timestamp()
        FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id WHERE attempt.sim_job_id=${executionId}::uuid`);
      await connection.execute(sql`UPDATE progressive_cfd_units SET attempts=2 WHERE id IN
        (SELECT unit_id FROM progressive_cfd_attempts WHERE sim_job_id=${executionId}::uuid)`);
      const before =
        await connection.execute(sql`SELECT unit.id,unit.active_seconds,unit.active_budget_seconds,unit.attempts,unit.recipe
        FROM progressive_cfd_units unit JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id
        WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY unit.id`);
      expect((await recover()).queuedUnits).toBe(original.length);
      expect((await recover()).queuedUnits).toBe(0);
      expect(
        await connection.execute(sql`SELECT unit.id,unit.active_seconds,unit.active_budget_seconds,unit.attempts,unit.recipe
        FROM progressive_cfd_units unit JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id
        WHERE attempt.sim_job_id=${executionId}::uuid ORDER BY unit.id`),
      ).toEqual(before);
      await expect(
        connection.transaction(async (nested) => {
          await nested.execute(
            sql`UPDATE progressive_publication_recoveries SET attempts_before=1 WHERE sim_job_id=${executionId}::uuid`,
          );
        }),
      ).rejects.toThrow();
      const leases = [];
      for (let index = 0; index < original.length; index += 1) {
        const lease = await claimProgressiveCfdUnit(connection, {
          owner: `publication-recovery-${randomUUID()}`,
          leaseSeconds: 120,
          solverBudgetVersion: 2,
          sameTarget: {
            generationId: String(scope.generation_id),
            targetId: String(scope.target_id),
            recipe: scope.recipe as Record<string, unknown>,
            remainingActiveSeconds: Number(scope.remaining),
            recoveryParentJobId: null,
          },
        });
        expect(lease).not.toBeNull();
        expect(original.some((attempt) => attempt.token === lease!.token)).toBe(
          false,
        );
        const prior = before.find((unit) => unit.id === lease!.id)!;
        expect(lease!.remainingActiveSeconds).toBe(
          Number(prior.active_budget_seconds) - Number(prior.active_seconds),
        );
        leases.push(lease!);
      }
      const composed = await composeProgressiveCfdJob(connection, leases, {
        cpuSlots: 1,
        meshRecoveryVersion: 1,
        solverBudgetVersion: 2,
      });
      expect(composed.jobId).not.toBe(executionId);
      expect(composed.request.execution_id).toBe(composed.jobId);
      const [claims] =
        await connection.execute(sql`SELECT count(*)::integer AS count FROM progressive_publication_recovery_claims claim
        JOIN progressive_publication_recoveries recovery ON recovery.unit_id=claim.unit_id WHERE recovery.sim_job_id=${executionId}::uuid`);
      expect(claims.count).toBe(original.length);
      const charged =
        await connection.execute(sql`SELECT unit.attempts,${progressiveCfdOrdinaryAttemptCountSql()} AS ordinary
        FROM progressive_cfd_units unit JOIN progressive_publication_recoveries recovery ON recovery.unit_id=unit.id
        WHERE recovery.sim_job_id=${executionId}::uuid`);
      expect(
        charged.every((unit) => unit.attempts === 3 && unit.ordinary === 2),
      ).toBe(true);
      expect(
        await connection.execute(sql`SELECT token,outcome,active_seconds FROM progressive_cfd_attempts
        WHERE sim_job_id=${executionId}::uuid ORDER BY token`),
      ).toEqual(original);
      const [promise] = await connection.execute(
        sql`SELECT status FROM sync_sweep_promises WHERE id=${scope.promise_id}::uuid`,
      );
      expect(promise.status).toBe("cancelled");
      const [result] = await connection.execute(
        sql`SELECT count(*)::integer AS count FROM result_attempts WHERE sim_job_id=${composed.jobId}::uuid`,
      );
      expect(result.count).toBe(0);
      expect((await recover()).queuedUnits).toBe(0);
      throw restore;
    });
  } catch (error) {
    if (error !== restore) throw error;
  }
}
