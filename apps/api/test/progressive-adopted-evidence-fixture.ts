import { randomUUID } from "node:crypto";
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
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    setConnection(db);
  }
}
