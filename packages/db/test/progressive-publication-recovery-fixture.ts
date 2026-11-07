import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";
import { analysisContentHash, createAnalysisTarget } from "../src/analysis-target";
import type { SimulationSetupSnapshot } from "../src/simulation-setup";
import { recoverProgressivePublicationLosses } from "../src/progressive-publication-recovery";
import { claimProgressiveCfdUnit } from "../src/progressive-cfd";
import { composeProgressiveCfdJob } from "../../../apps/sweeper/src/progressive-cfd-jobs";
import { progressiveCfdOrdinaryAttemptCountSql } from "../src/progressive-attempt-budget";
import { claimSimJobCancellation } from "../src/job-lifecycle";
import {
  acknowledgeProgressiveCfdExecutionStop,
  settleProgressiveCfdExecution,
} from "../src/progressive-cfd-settlement";

export async function withRepairedPreciseMediaFixture(
  db: DB,
  resultAttemptIds: string[],
  verify: (
    connection: DB,
    scope: {
      campaignId: string;
      planRevisionId: string;
      generationId: string;
      epochId: string;
      units: Array<{
        id: string;
        token: string;
        resultAttemptId: string;
        workId: string;
      }>;
    },
  ) => Promise<void>,
) {
  const restore = new Error("Restore repaired precise media fixture");
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const campaignId = randomUUID();
      const planRevisionId = randomUUID();
      const generationId = randomUUID();
      const [epoch] = await connection.execute(
        sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
      );
      if (!epoch)
        throw new Error("Media recovery fixture requires a current epoch");
      await connection.execute(sql`INSERT INTO sim_campaigns(id,slug,name,idempotency_key,status)
        VALUES (${campaignId}::uuid,${campaignId},'Exact repaired precise media',${campaignId},'active')`);
      await connection.execute(sql`INSERT INTO sim_campaign_plan_revisions(id,campaign_id,revision_number,kind,plan,summary)
        VALUES (${planRevisionId}::uuid,${campaignId}::uuid,1,'initial','{}','{}')`);
      await connection.execute(
        sql`UPDATE sim_campaigns SET current_plan_revision_id=${planRevisionId}::uuid WHERE id=${campaignId}::uuid`,
      );
      await connection.execute(sql`INSERT INTO progressive_generations(id,epoch_id,campaign_id,plan_revision_id,scope_key,scope_signature,stage,status)
        VALUES (${generationId}::uuid,${epoch.id}::uuid,${campaignId}::uuid,${planRevisionId}::uuid,${generationId},${"a".repeat(64)},3,'active')`);
      const rawRows =
        await connection.execute(sql`SELECT id,result_id,airfoil_id,aoa_deg,simulation_preset_revision_id,
        sim_job_id,engine_job_id,evidence_payload FROM result_attempts
        WHERE id IN (${sql.join(
          resultAttemptIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) ORDER BY aoa_deg,id`);
      expect(rawRows).toHaveLength(resultAttemptIds.length);
      const works = new Map<
        string,
        { workId: string; targetId: string; recipeId: string }
      >();
      const jobs = new Map<
        string,
        { tokens: string[]; targetId: string; recipeId: string }
      >();
      const units: Array<{
        id: string;
        token: string;
        resultAttemptId: string;
        workId: string;
      }> = [];
      const recipe = {
        selection: { solver: "pimpleFoam", regime: "urans" },
        fidelity: "urans_full",
      };
      for (const raw of rawRows) {
        expect(raw.sim_job_id).toBe(raw.engine_job_id);
        const key = `${raw.airfoil_id}:${raw.simulation_preset_revision_id}`;
        let work = works.get(key);
        if (!work) {
          const [geometry] = await connection.execute(
            sql`SELECT points FROM airfoils WHERE id=${raw.airfoil_id}::uuid`,
          );
          const [revision] =
            await connection.execute(sql`SELECT snapshot FROM simulation_preset_revisions
            WHERE id=${raw.simulation_preset_revision_id}::uuid`);
          const snapshot = revision.snapshot as SimulationSetupSnapshot;
          if (!snapshot.material)
            throw new Error(
              "Precise media fixture requires the immutable material",
            );
          const target = createAnalysisTarget({
            airfoilId: String(raw.airfoil_id),
            points: geometry.points as Array<{ x: number; y: number }>,
            snapshot,
            material: {
              ...snapshot.material,
              speedOfSound: snapshot.material.speedOfSound ?? null,
            },
            transition: {
              model: "fully_turbulent",
              nCrit: 9,
              upper: 0,
              lower: 0,
            },
            branch: "increasing",
          });
          const physical = target.physical;
          const targetId = target.signature;
          const recipeId = analysisContentHash({
            sourceRevisionId: raw.simulation_preset_revision_id,
            recipe,
          });
          const workId = randomUUID();
          work = { workId, targetId, recipeId };
          works.set(key, work);
          await connection.execute(sql`INSERT INTO polar_analysis_targets(id,airfoil_id,physical)
            VALUES (${targetId},${raw.airfoil_id}::uuid,${JSON.stringify(physical)}::jsonb)`);
          await connection.execute(sql`INSERT INTO progressive_generation_targets(generation_id,target_id,revision_id,angles,recipes)
          VALUES (${generationId}::uuid,${targetId},${raw.simulation_preset_revision_id}::uuid,
            ARRAY[${sql.join(
              rawRows
                .filter(
                  (entry) =>
                    entry.airfoil_id === raw.airfoil_id &&
                    entry.simulation_preset_revision_id ===
                      raw.simulation_preset_revision_id,
                )
                .map((entry) => sql`${entry.aoa_deg}`),
              sql`, `,
            )}]::double precision[],
            ${JSON.stringify({ precise: recipe })}::jsonb)`);
          await connection.execute(sql`INSERT INTO progressive_work(id,generation_id,target_id,stage,state)
            VALUES (${workId}::uuid,${generationId}::uuid,${targetId},3,'pending')`);
          await connection.execute(sql`INSERT INTO progressive_cfd_execution_recipes(id,source_revision_id,recipe,execution_revision_id)
            VALUES (${recipeId},${raw.simulation_preset_revision_id}::uuid,${JSON.stringify(recipe)}::jsonb,${raw.simulation_preset_revision_id}::uuid)
            ON CONFLICT (id) DO NOTHING`);
        }
        const unitId = randomUUID();
        const token = randomUUID();
        await connection.execute(sql`INSERT INTO progressive_cfd_units(id,work_id,aoa_deg,ordinal,purpose,recipe,reason,policy_version,
          active_budget_seconds,active_seconds,state,attempts,error)
          VALUES (${unitId}::uuid,${work.workId}::uuid,${raw.aoa_deg},${units.length},'precise',${JSON.stringify(recipe)}::jsonb,
          'original precise calculation','media-repair-fixture',32400,25200,'gap',1,'precise evidence remains unresolved')`);
        await connection.execute(sql`INSERT INTO progressive_cfd_attempts(token,unit_id,owner,execution_recipe_id,sim_job_id,
          started_at,lease_until,outcome,active_seconds,finished_at,error)
          VALUES (${token}::uuid,${unitId}::uuid,'original precise owner',${work.recipeId},${raw.sim_job_id}::uuid,
          clock_timestamp()-interval '9 hours',clock_timestamp()-interval '1 hour','failed',25200,
          clock_timestamp()-interval '30 minutes','precise evidence remains unresolved')`);
        await connection.execute(sql`INSERT INTO progressive_cfd_evidence(attempt_token,result_attempt_id,evidence_signature,solver_active_seconds)
          VALUES (${token}::uuid,${raw.id}::uuid,${analysisContentHash(raw.evidence_payload)},25200)`);
        units.push({
          id: unitId,
          token,
          resultAttemptId: String(raw.id),
          workId: work.workId,
        });
        const jobId = String(raw.sim_job_id);
        const job = jobs.get(jobId) ?? {
          tokens: [],
          targetId: work.targetId,
          recipeId: work.recipeId,
        };
        job.tokens.push(token);
        jobs.set(jobId, job);
      }
      for (const [jobId, job] of jobs) {
        const request = {
          progressive: {
            executionId: jobId,
            epochId: epoch.id,
            generationId,
            targetId: job.targetId,
            stage: 3,
            recipeId: job.recipeId,
            tokens: job.tokens,
          },
          engineRequest: { execution_id: jobId },
        };
        await connection.execute(sql`UPDATE sim_jobs SET campaign_id=${campaignId}::uuid,status='done',"ingestedAt"=clock_timestamp(),
          request_payload=${JSON.stringify(request)}::jsonb WHERE id=${jobId}::uuid`);
        const proof = {
          version: 1,
          job_id: jobId,
          execution_stopped: true,
          producer_stopped: true,
          namespace_verified: true,
          remaining: [],
          error: null,
          fence: "terminal_result",
          observed_at: new Date().toISOString(),
        };
        await connection.execute(sql`INSERT INTO progressive_cfd_execution_stops(sim_job_id,engine_job_id,epoch_id,proof,proof_signature,observed_at)
          VALUES (${jobId}::uuid,${jobId},${epoch.id}::uuid,${JSON.stringify(proof)}::jsonb,${analysisContentHash(proof)},clock_timestamp())`);
      }
      await verify(connection, {
        campaignId,
        planRevisionId,
        generationId,
        epochId: String(epoch.id),
        units,
      });
      throw restore;
    });
  } catch (error) {
    if (error !== restore) throw error;
  }
}

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
      const savedGrants = await connection.execute(sql`
        SELECT * FROM progressive_publication_recovery_claims WHERE unit_id IN
          (SELECT unit_id FROM progressive_publication_recoveries WHERE sim_job_id=${executionId}::uuid)
        ORDER BY unit_id
      `);
      async function cancelBeforeStarting(jobId: string) {
        expect(
          await claimSimJobCancellation(
            connection,
            jobId,
            "isolated corrective maintenance stop",
          ),
        ).toMatchObject({ kind: "cancelled" });
        await connection.execute(sql`UPDATE sim_jobs SET engine_job_id=id::text,"ingestedAt"=clock_timestamp()
          WHERE id=${jobId}::uuid`);
        await acknowledgeProgressiveCfdExecutionStop(connection, {
          simJobId: jobId,
          proof: {
            version: 1,
            job_id: jobId,
            execution_stopped: true,
            producer_stopped: true,
            namespace_verified: true,
            remaining: [],
            observed_at: new Date().toISOString(),
            error: null,
            fence: "cancel_marker",
            ownership_basis: "never_started_cancellation_fence",
          },
        });
        return settleProgressiveCfdExecution(connection, jobId);
      }
      expect(await cancelBeforeStarting(composed.jobId)).toMatchObject({
        retry: original.length,
        gaps: 0,
      });
      const retried = [];
      for (const previous of leases) {
        const next = await claimProgressiveCfdUnit(connection, {
          owner: "isolated-corrective-retry",
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
        expect(next).not.toBeNull();
        expect(next!.remainingActiveSeconds).toBe(
          previous.remainingActiveSeconds,
        );
        retried.push(next!);
      }
      const counts = await connection.execute(sql`
        SELECT unit.attempts,${progressiveCfdOrdinaryAttemptCountSql()} AS ordinary
        FROM progressive_cfd_units unit JOIN progressive_publication_recoveries recovery ON recovery.unit_id=unit.id
        WHERE recovery.sim_job_id=${executionId}::uuid
      `);
      expect(
        counts.every((unit) => unit.attempts === 4 && unit.ordinary === 2),
      ).toBe(true);
      expect(
        await connection.execute(sql`
        SELECT * FROM progressive_publication_recovery_claims WHERE unit_id IN
          (SELECT unit_id FROM progressive_publication_recoveries WHERE sim_job_id=${executionId}::uuid)
        ORDER BY unit_id
      `),
      ).toEqual(savedGrants);
      const retryJob = await composeProgressiveCfdJob(connection, retried, {
        cpuSlots: 1,
        meshRecoveryVersion: 1,
        solverBudgetVersion: 2,
      });
      expect(await cancelBeforeStarting(retryJob.jobId)).toMatchObject({
        retry: 0,
        gaps: original.length,
      });
      expect(
        await claimProgressiveCfdUnit(connection, {
          owner: "no-third-zero-work-claim",
          leaseSeconds: 120,
          solverBudgetVersion: 2,
          sameTarget: {
            generationId: String(scope.generation_id),
            targetId: String(scope.target_id),
            recipe: scope.recipe as Record<string, unknown>,
            remainingActiveSeconds: Number(scope.remaining),
            recoveryParentJobId: null,
          },
        }),
      ).toBeNull();
      throw restore;
    });
  } catch (error) {
    if (error !== restore) throw error;
  }
}
