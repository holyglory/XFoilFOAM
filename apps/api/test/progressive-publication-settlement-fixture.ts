import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { expect } from "vitest";
import { resultAttempts, resultClassifications, type DB } from "@aerodb/db";
import {
  promoteRetainedProgressiveAttempts,
  settleProgressiveRemoteJob,
} from "../../sweeper/src/progressive-remote-settlement";
import { refreshPolarCacheForRevision } from "@aerodb/db/polar-cache";
import { claimProgressivePolarFit } from "@aerodb/db/progressive-polar-cache";

export async function verifyProgressivePublicationPrecedence(
  db: DB,
  executionId: string,
  resultAttemptId: string,
) {
  const [attempt] = await db
    .select()
    .from(resultAttempts)
    .where(eq(resultAttempts.id, resultAttemptId));
  let [classification] = await db
    .select()
    .from(resultClassifications)
    .where(eq(resultClassifications.resultAttemptId, resultAttemptId));
  if (!classification) {
    await refreshPolarCacheForRevision(
      db,
      String(attempt.airfoilId),
      String(attempt.simulationPresetRevisionId),
    );
    [classification] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultAttemptId, resultAttemptId));
  }
  expect(attempt.regime).toBe("rans");
  expect(classification.state).toBe("accepted");
  const [owner] = await db.execute(sql`SELECT generation.id AS generation_id,
    generation.campaign_id,generation.epoch_id,generation.plan_revision_id,
    work.id AS work_id,work.target_id,work.stage,unit.id AS unit_id,
    source.token,prediction.id AS prediction_id
    FROM progressive_cfd_attempts source
    JOIN progressive_cfd_units unit ON unit.id=source.unit_id
    JOIN progressive_work work ON work.id=unit.work_id
    JOIN progressive_generations generation ON generation.id=work.generation_id
    JOIN neuralfoil_predictions prediction ON prediction.target_id=work.target_id
      AND prediction.epoch_id=generation.epoch_id
    WHERE source.sim_job_id=${executionId}::uuid AND unit.aoa_deg=${attempt.aoaDeg}
    LIMIT 1`);
  expect(owner.stage).toBe(2);
  for (const mode of ["ordinary", "null", "other", "generation", "recipe", "precise"] as const) {
    const rollback = new Error(`Restore benchmark publication ${mode}`);
    await expect(db.transaction(async raw => {
      const connection = raw as unknown as DB;
      for (const table of ["progressive_generations", "progressive_generation_targets", "progressive_work",
        "progressive_cfd_units", "progressive_cfd_evidence_reuses"])
        if (table === "progressive_generations")
          await connection.execute(sql`CREATE TEMP TABLE progressive_generations ON COMMIT DROP AS
            SELECT * FROM public.progressive_generations WHERE id=${owner.generation_id}::uuid`);
        else
          await connection.execute(sql.raw(`CREATE TEMP TABLE ${table} ON COMMIT DROP AS SELECT * FROM public.${table}`));
      await connection.execute(sql`UPDATE progressive_generations SET benchmark_only=${mode === "generation"}
        WHERE id=${owner.generation_id}::uuid`);
      const publication = mode === "null" ? { publication: null }
        : mode === "other" ? { publication: "public" }
        : mode === "recipe" || mode === "precise" ? { publication: "benchmark_only" } : {};
      await connection.execute(sql`UPDATE progressive_generation_targets
        SET recipes=jsonb_set(recipes,'{fast}',(coalesce(recipes->'fast','{}'::jsonb)-'publication') || ${JSON.stringify(publication)}::jsonb)
        WHERE generation_id=${owner.generation_id}::uuid AND target_id=${owner.target_id}`);
      await connection.execute(sql`UPDATE progressive_work SET stage=${mode === "precise" ? 3 : 2}
        WHERE id=${owner.work_id}::uuid`);
      const eligible = mode !== "generation" && mode !== "recipe";
      const acquire = async (cfdOnly: boolean) => {
        await connection.execute(sql`UPDATE progressive_polar_fit_work SET state='pending',attempts=0,
          lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE prediction_id=${owner.prediction_id}`);
        return claimProgressivePolarFit(connection, {
          predictionId: String(owner.prediction_id), owner: "benchmark-isolation-fixture", leaseSeconds: 120,
          requireCfdEvidence: cfdOnly, currentCampaignEvidenceOnly: cfdOnly,
        });
      };
      expect(Boolean(await acquire(true)), `${mode} direct CFD lane`).toBe(eligible);
      const fit = await acquire(false);
      expect(fit).not.toBeNull();
      expect(fit!.source.evidence.some(source => source.resultAttemptId === resultAttemptId),
        `${mode} immutable fit input`).toBe(eligible);
      const successorGenerationId = randomUUID();
      const successorWorkId = randomUUID();
      const successorUnitId = randomUUID();
      await connection.execute(sql`INSERT INTO progressive_generations(id,campaign_id,epoch_id,plan_revision_id,status,benchmark_only)
        VALUES(${successorGenerationId}::uuid,${owner.campaign_id}::uuid,${owner.epoch_id}::uuid,${owner.plan_revision_id}::uuid,'active',false)`);
      await connection.execute(sql`INSERT INTO progressive_work(id,generation_id,target_id,stage)
        VALUES(${successorWorkId}::uuid,${successorGenerationId}::uuid,${owner.target_id},2)`);
      await connection.execute(sql`INSERT INTO progressive_cfd_units(id,work_id,aoa_deg)
        VALUES(${successorUnitId}::uuid,${successorWorkId}::uuid,${attempt.aoaDeg})`);
      await connection.execute(sql`INSERT INTO progressive_cfd_evidence_reuses(successor_unit_id,source_attempt_token)
        VALUES(${successorUnitId}::uuid,${owner.token}::uuid)`);
      await connection.execute(sql`UPDATE progressive_generations SET status='cancelled' WHERE id=${owner.generation_id}::uuid`);
      expect(Boolean(await acquire(true)), `${mode} reused CFD lane`).toBe(eligible);
      await connection.execute(sql`UPDATE progressive_generations SET benchmark_only=true WHERE id=${successorGenerationId}::uuid`);
      expect(await acquire(true), `${mode} benchmark successor`).toBeNull();
      await connection.execute(sql`UPDATE progressive_generations SET status='active' WHERE id=${owner.generation_id}::uuid`);
      if (!eligible) {
        const before = await connection.select().from(resultAttempts).where(eq(resultAttempts.id,resultAttemptId));
        const classifications = await connection.select().from(resultClassifications).where(eq(resultClassifications.resultAttemptId,resultAttemptId));
        expect(await promoteRetainedProgressiveAttempts(connection, {
          executionId, airfoilId: attempt.airfoilId,
          simulationPresetRevisionId: attempt.simulationPresetRevisionId!, attemptIds: [resultAttemptId],
        })).toBe(false);
        expect(await settleProgressiveRemoteJob(connection,executionId)).toMatchObject({ kind: "settled" });
        expect(await connection.execute(sql`SELECT current_result_attempt_id FROM results WHERE id=${attempt.resultId}::uuid`))
          .toEqual([{ current_result_attempt_id: null }]);
        expect(await connection.select().from(resultAttempts).where(eq(resultAttempts.id,resultAttemptId))).toEqual(before);
        expect(await connection.select().from(resultClassifications).where(eq(resultClassifications.resultAttemptId,resultAttemptId))).toEqual(classifications);
      }
      throw rollback;
    })).rejects.toBe(rollback);
  }
  const expectedCache = async (connection: DB, count: number) => {
    expect(
      await connection.execute(sql`SELECT accepted_point_count FROM polar_fit_sets
      WHERE airfoil_id = ${attempt.airfoilId}::uuid
        AND simulation_preset_revision_id = ${attempt.simulationPresetRevisionId}::uuid
        AND is_current`),
    ).toEqual([{ accepted_point_count: count }]);
  };
  for (const scenario of [
    "same-rank",
    "provisional",
    "higher-accepted",
  ] as const) {
    const rollback = new Error(
      `Rollback isolated publication precedence ${scenario}`,
    );
    const restored = await db.transaction(async (raw) => {
        const connection = raw as unknown as DB;
        const selectedId = randomUUID();
        const regime = scenario === "same-rank" ? "rans" : "urans";
        await connection.insert(resultAttempts).values({
          ...attempt,
          id: selectedId,
          simJobId: null,
          engineJobId: `isolated-precedence-${selectedId}`,
          regime,
          unsteady: regime === "urans",
          evidencePayload: {
            ...(attempt.evidencePayload as Record<string, unknown>),
            fidelity: regime === "urans" ? "urans_full" : "rans",
          },
        });
        await connection.insert(resultClassifications).values({
          ...classification,
          id: randomUUID(),
          resultId: null,
          resultAttemptId: selectedId,
          regime,
          state: scenario === "provisional" ? "needs_urans" : "accepted",
        });
        await connection.execute(sql`UPDATE results SET current_result_attempt_id = ${selectedId}::uuid
        WHERE id = ${attempt.resultId}::uuid`);
        const evidenceBefore = await connection.select().from(resultAttempts)
          .where(inArray(resultAttempts.id,[resultAttemptId,selectedId])).orderBy(resultAttempts.id);
        const acceptedBefore = (await connection.select().from(resultClassifications)
          .where(inArray(resultClassifications.resultAttemptId,[resultAttemptId,selectedId]))
          .orderBy(resultClassifications.id)).filter(row => row.state === "accepted")
          .map(({ updatedAt: _updatedAt, ...facts }) => facts);
        const settlement = await settleProgressiveRemoteJob(
          connection,
          executionId,
        );
        const [publication] = await connection.execute(sql`SELECT result.current_result_attempt_id,
          incoming.state AS incoming_state,selected.state AS selected_state,job."ingestedAt"
          FROM results result
          JOIN sim_jobs job ON job.id=${executionId}::uuid
          LEFT JOIN result_classifications incoming ON incoming.result_attempt_id=${resultAttemptId}::uuid
          LEFT JOIN result_classifications selected ON selected.result_attempt_id=result.current_result_attempt_id
          WHERE result.id=${attempt.resultId}::uuid`);
        expect(settlement, JSON.stringify({ scenario, incomingAttemptId: resultAttemptId, selectedAttemptId: selectedId, publication })).toMatchObject(
          { kind: "settled", counts: { complete: 1, waiting: 0 } },
        );
        const [selected] = await connection.execute(
          sql`SELECT current_result_attempt_id FROM results WHERE id = ${attempt.resultId}::uuid`,
        );
        expect(selected.current_result_attempt_id).toBe(scenario === "higher-accepted" ? selectedId : resultAttemptId);
        expect(publication.incoming_state).toBe("accepted");
        expect(await connection.select().from(resultAttempts)
          .where(inArray(resultAttempts.id,[resultAttemptId,selectedId])).orderBy(resultAttempts.id)).toEqual(evidenceBefore);
        expect(await connection.select().from(resultClassifications)
          .where(inArray(resultClassifications.id,acceptedBefore.map(row => row.id)))
          .orderBy(resultClassifications.id).then(rows => rows.map(({ updatedAt: _updatedAt, ...facts }) => facts))).toEqual(acceptedBefore);
        throw rollback;
      }).catch(error => {
      if (error !== rollback) throw error;
      return rollback;
    });
    expect(restored).toBe(rollback);
  }
  const unclassifiedRollback = new Error(
    "Rollback unclassified progressive publication",
  );
  await expect(
    db.transaction(async (raw) => {
      const connection = raw as unknown as DB;
      const selectedId = randomUUID();
      await connection.insert(resultAttempts).values({
        ...attempt,
        id: selectedId,
        simJobId: null,
        engineJobId: `isolated-unclassified-publication-${selectedId}`,
      });
      await connection.insert(resultClassifications).values({
        ...classification,
        id: randomUUID(),
        resultId: null,
        resultAttemptId: selectedId,
        state: "accepted",
      });
      await connection.execute(sql`UPDATE results
        SET current_result_attempt_id = ${selectedId}::uuid
        WHERE id = ${attempt.resultId}::uuid`);
      await connection.execute(sql`DELETE FROM result_classifications
        WHERE result_attempt_id = ${resultAttemptId}::uuid`);
      const evidenceBefore = await connection.select().from(resultAttempts)
        .where(inArray(resultAttempts.id,[resultAttemptId,selectedId])).orderBy(resultAttempts.id);
      expect(
        await settleProgressiveRemoteJob(connection, executionId),
      ).toMatchObject({
        kind: "settled",
        counts: { complete: 1, waiting: 0 },
      });
      const [published] = await connection.execute(sql`
        SELECT result.current_result_attempt_id, classification.state
        FROM results result
        JOIN result_classifications classification
          ON classification.result_attempt_id = ${resultAttemptId}::uuid
        WHERE result.id = ${attempt.resultId}::uuid
      `);
      expect(published).toEqual({
        current_result_attempt_id: resultAttemptId,
        state: "accepted",
      });
      expect(await connection.select().from(resultAttempts)
        .where(inArray(resultAttempts.id,[resultAttemptId,selectedId])).orderBy(resultAttempts.id)).toEqual(evidenceBefore);
      throw unclassifiedRollback;
    }),
  ).rejects.toBe(unclassifiedRollback);
  for (const ingested of [false, true]) {
    const rollback = new Error("Rollback exact accepted publication");
    const restored = await db.transaction(async (raw) => {
        const connection = raw as unknown as DB;
        await connection.execute(sql`UPDATE results
        SET current_result_attempt_id = ${ingested ? resultAttemptId : null}::uuid
        WHERE id = ${attempt.resultId}::uuid`);
        if (ingested) {
          await connection.execute(sql`UPDATE sim_jobs
          SET status = 'done', engine_state = 'completed',
            "ingestedAt" = clock_timestamp(), "finishedAt" = clock_timestamp()
          WHERE id = ${executionId}::uuid`);
          await connection.execute(sql`UPDATE sync_sweep_promises SET status = 'expired'
          WHERE id = (SELECT promise_id FROM progressive_remote_dispatches
            WHERE sim_job_id = ${executionId}::uuid)`);
        }
        await refreshPolarCacheForRevision(
          connection,
          attempt.airfoilId,
          attempt.simulationPresetRevisionId!,
        );
        await expectedCache(connection, ingested ? 1 : 0);
        const original = await connection
          .select()
          .from(resultAttempts)
          .where(eq(resultAttempts.id, resultAttemptId));
        expect(
          await settleProgressiveRemoteJob(connection, executionId),
        ).toMatchObject({ kind: "settled" });
        expect(
          await connection.execute(
            sql`SELECT current_result_attempt_id FROM results WHERE id = ${attempt.resultId}::uuid`,
          ),
          `exact accepted publication after ingested=${ingested}`,
        ).toEqual([{ current_result_attempt_id: resultAttemptId }]);
        await expectedCache(connection, 1);
        expect(
          await settleProgressiveRemoteJob(connection, executionId),
        ).toMatchObject({ kind: "settled" });
        await expectedCache(connection, 1);
        expect(
          await connection
            .select()
            .from(resultAttempts)
            .where(eq(resultAttempts.id, resultAttemptId)),
        ).toEqual(original);
        if (ingested) {
          await connection.execute(sql`UPDATE results SET current_result_attempt_id=NULL
            WHERE id=${attempt.resultId}::uuid`);
          await refreshPolarCacheForRevision(connection,attempt.airfoilId,attempt.simulationPresetRevisionId!);
          await expectedCache(connection,0);
          expect(await settleProgressiveRemoteJob(connection,executionId)).toMatchObject({ kind: "settled" });
          expect(await connection.execute(sql`SELECT current_result_attempt_id FROM results
            WHERE id=${attempt.resultId}::uuid`)).toEqual([{ current_result_attempt_id: null }]);
          await expectedCache(connection,0);
          expect(await connection.select().from(resultAttempts).where(eq(resultAttempts.id,resultAttemptId))).toEqual(original);
        }
        throw rollback;
      }).catch(error => {
        if (error !== rollback) throw error;
        return rollback;
      });
    expect(restored).toBe(rollback);
  }
  for (const unavailable of ["archive", "excluded", "deferred"] as const) {
    const rollback = new Error(
      `Rollback unavailable publication ${unavailable}`,
    );
    await expect(
      db.transaction(async (raw) => {
        const connection = raw as unknown as DB;
        if (unavailable === "archive")
          await connection.execute(sql`DELETE FROM solver_evidence_archives
          WHERE result_attempt_id = ${resultAttemptId}::uuid`);
        else
          await connection.execute(sql`INSERT INTO result_review_verdicts(result_id, verdict, note, reviewer)
          VALUES (${attempt.resultId}::uuid, ${unavailable === "excluded" ? "exclude" : "defer"},
            'isolated publication guard', 'fixture')`);
        await settleProgressiveRemoteJob(connection, executionId);
        expect(
          await connection.execute(
            sql`SELECT current_result_attempt_id FROM results WHERE id = ${attempt.resultId}::uuid`,
          ),
        ).toEqual([{ current_result_attempt_id: null }]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  }
  const rollback = new Error("Rollback cancelled remote publication gap");
  await expect(
    db.transaction(async (raw) => {
      const connection = raw as unknown as DB;
      const selectedId = randomUUID();
      await connection.insert(resultAttempts).values({
        ...attempt,
        id: selectedId,
        simJobId: null,
        engineJobId: `isolated-cancelled-publication-${selectedId}`,
      });
      await connection.insert(resultClassifications).values({
        ...classification,
        id: randomUUID(),
        resultId: null,
        resultAttemptId: selectedId,
        state: "accepted",
      });
      await connection.execute(sql`UPDATE results
        SET current_result_attempt_id = ${selectedId}::uuid
        WHERE id = ${attempt.resultId}::uuid`);
      await connection.execute(sql`UPDATE sync_sweep_promises
        SET status = 'cancelled', response_payload = jsonb_build_object('authoritativeLeaseLoss', true)
        WHERE id = (SELECT promise_id FROM progressive_remote_dispatches
          WHERE sim_job_id = ${executionId}::uuid)`);
      await connection.execute(sql`UPDATE sim_jobs SET status='cancelled' WHERE id=${executionId}::uuid`);
      const evidenceBefore = await connection.select().from(resultAttempts)
        .where(inArray(resultAttempts.id,[resultAttemptId,selectedId])).orderBy(resultAttempts.id);
      expect(
        await settleProgressiveRemoteJob(connection, executionId),
      ).toMatchObject({ kind: "settled" });
      expect(
        await connection.execute(
          sql`SELECT current_result_attempt_id FROM results WHERE id = ${attempt.resultId}::uuid`,
        ),
      ).toEqual([{ current_result_attempt_id: selectedId }]);
      expect(await connection.select().from(resultAttempts)
        .where(inArray(resultAttempts.id,[resultAttemptId,selectedId])).orderBy(resultAttempts.id)).toEqual(evidenceBefore);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
