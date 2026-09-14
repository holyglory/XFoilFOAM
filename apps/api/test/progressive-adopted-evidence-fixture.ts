import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "@aerodb/db";
import { assembleSim } from "../src/services/sim";

export async function verifyAdoptedEvidenceAccess(
  db: DB,
  source: {
    executionId: string;
    slug: string;
    resultId: string;
    attemptId: string;
  },
  setConnection: (connection: DB) => void,
) {
  const rollback = new Error("Restore isolated adopted evidence fixture");
  try {
    await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      setConnection(connection);
      const read = () =>
        assembleSim(
          source.slug,
          undefined,
          undefined,
          source.resultId,
          source.attemptId,
        );
      const [scope] =
        await connection.execute(sql`SELECT DISTINCT work.generation_id,work.target_id
        FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        JOIN progressive_work work ON work.id=unit.work_id WHERE attempt.sim_job_id=${source.executionId}::uuid`);
      const before = await read();
      expect(before).not.toBeNull();
      const successor = randomUUID();
      await connection.execute(sql`INSERT INTO progressive_generations(id,epoch_id,campaign_id,plan_revision_id,scope_key,scope_signature,stage,status)
        SELECT ${successor}::uuid,epoch_id,campaign_id,plan_revision_id,${successor},scope_signature,stage,'active'
        FROM progressive_generations WHERE id=${scope.generation_id}::uuid`);
      await connection.execute(sql`INSERT INTO progressive_generation_targets(generation_id,target_id,revision_id,angles,recipes)
        SELECT ${successor}::uuid,target_id,revision_id,angles,recipes FROM progressive_generation_targets
        WHERE generation_id=${scope.generation_id}::uuid AND target_id=${scope.target_id}`);
      await connection.execute(
        sql`UPDATE progressive_generations SET status='cancelled' WHERE id=${scope.generation_id}::uuid`,
      );
      expect(await read()).toBeNull();
      await connection.execute(sql`INSERT INTO progressive_recipe_adoptions(epoch_id,campaign_id,plan_revision_id,policy,previous_generation_ids,generation_id)
        SELECT epoch_id,campaign_id,plan_revision_id,${successor},ARRAY[id],${successor}::uuid
        FROM progressive_generations WHERE id=${scope.generation_id}::uuid`);
      expect(await read()).toEqual(before);
      for (const status of ["active", "attention", "complete", "cancelled"]) {
        await connection.execute(
          sql`UPDATE progressive_generations SET status=${status} WHERE id=${successor}::uuid`,
        );
        expect(await read()).toEqual(status === "cancelled" ? null : before);
      }
      await connection.execute(
        sql`UPDATE progressive_generations SET status='active' WHERE id=${successor}::uuid`,
      );
      await connection.execute(
        sql`DELETE FROM progressive_generation_targets WHERE generation_id=${successor}::uuid`,
      );
      expect(await read()).toBeNull();
      await connection.execute(sql`INSERT INTO progressive_generation_targets(generation_id,target_id,revision_id,angles,recipes)
        SELECT ${successor}::uuid,target_id,revision_id,angles,recipes FROM progressive_generation_targets
        WHERE generation_id=${scope.generation_id}::uuid AND target_id=${scope.target_id}`);
      await connection.execute(sql`UPDATE sim_campaigns SET status='cancelled'
        WHERE id=(SELECT campaign_id FROM progressive_generations WHERE id=${successor}::uuid)`);
      expect(await read()).toBeNull();
      const modelId = createHash("sha256").update(randomUUID()).digest("hex");
      const predictionId = createHash("sha256")
        .update(randomUUID())
        .digest("hex");
      const revisedPlanId = randomUUID();
      await connection.execute(sql`INSERT INTO sim_campaign_plan_revisions(id,campaign_id,revision_number,kind,plan,summary)
        SELECT ${revisedPlanId}::uuid,plan.campaign_id,
          (SELECT max(revision_number)+1 FROM sim_campaign_plan_revisions WHERE campaign_id=plan.campaign_id),
          'edit',plan.plan,'{}'::jsonb
        FROM sim_campaign_plan_revisions plan JOIN progressive_generations generation ON generation.plan_revision_id=plan.id
        WHERE generation.id=${scope.generation_id}::uuid`);
      await connection.execute(sql`UPDATE sim_campaigns SET status='active',current_plan_revision_id=${revisedPlanId}::uuid
        WHERE id=(SELECT campaign_id FROM progressive_generations WHERE id=${scope.generation_id}::uuid)`);
      expect(await read()).toBeNull();
      await connection.execute(sql`INSERT INTO neuralfoil_predictions(id,epoch_id,target_id,payload)
        SELECT ${predictionId},epoch_id,${scope.target_id},'{"kind":"prediction","method":"neuralfoil","cfd_evidence":false}'::jsonb
        FROM progressive_generations WHERE id=${scope.generation_id}::uuid`);
      const response = {
        estimate: {
          contributors: [
            { result_id: source.resultId, attempt_id: source.attemptId },
          ],
        },
      };
      await connection.execute(sql`INSERT INTO progressive_polar_models(id,prediction_id,source_signature,request,response)
        VALUES(${modelId},${predictionId},${modelId},'{}'::jsonb,${JSON.stringify(response)}::jsonb)`);
      await connection.execute(sql`INSERT INTO progressive_polar_model_evidence(model_id,attempt_token,result_attempt_id)
        SELECT ${modelId},attempt_token,result_attempt_id FROM progressive_cfd_evidence
        WHERE result_attempt_id=${source.attemptId}::uuid LIMIT 1`);
      await connection.execute(sql`INSERT INTO progressive_polar_fit_work(prediction_id,state,model_id)
        VALUES(${predictionId},'ready',${modelId})
        ON CONFLICT (prediction_id) DO UPDATE SET state='ready',model_id=EXCLUDED.model_id`);
      expect(await read()).toEqual(before);
      for (const state of ["pending", "leased", "gap"]) {
        await connection.execute(
          sql`UPDATE progressive_polar_fit_work SET state=${state},
            lease_token=CASE WHEN ${state}='leased' THEN ${randomUUID()}::uuid ELSE NULL END,
            lease_owner=CASE WHEN ${state}='leased' THEN 'fixture' ELSE NULL END,
            lease_until=CASE WHEN ${state}='leased' THEN clock_timestamp()+interval '1 minute' ELSE NULL END
            WHERE prediction_id=${predictionId}`,
        );
        expect(await read()).toBeNull();
      }
      await connection.execute(
        sql`UPDATE progressive_polar_fit_work SET state='ready' WHERE prediction_id=${predictionId}`,
      );
      const excludedModelId = createHash("sha256")
        .update(randomUUID())
        .digest("hex");
      await connection.execute(sql`INSERT INTO progressive_polar_models(id,prediction_id,source_signature,request,response)
        VALUES(${excludedModelId},${predictionId},${excludedModelId},'{}'::jsonb,'{}'::jsonb)`);
      await connection.execute(sql`INSERT INTO progressive_polar_model_evidence(model_id,attempt_token,result_attempt_id)
        SELECT ${excludedModelId},attempt_token,result_attempt_id FROM progressive_polar_model_evidence WHERE model_id=${modelId}`);
      await connection.execute(
        sql`UPDATE progressive_polar_fit_work SET model_id=${excludedModelId} WHERE prediction_id=${predictionId}`,
      );
      expect(await read()).toBeNull();
      await connection.execute(
        sql`UPDATE progressive_polar_fit_work SET model_id=${modelId} WHERE prediction_id=${predictionId}`,
      );
      expect(await read()).toEqual(before);
      await connection.execute(sql`UPDATE calculation_epochs SET current=false
        WHERE id=(SELECT epoch_id FROM progressive_generations WHERE id=${scope.generation_id}::uuid)`);
      expect(await read()).toBeNull();
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    setConnection(db);
  }
}
