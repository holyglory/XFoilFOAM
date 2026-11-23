import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HistoricalRawOwner } from "./historical-raw-source";

/** Report only the current registered worker's exact dispatch. Historical custody remains read-only. */
export function registerRetentionOwnerRead(
  app: FastifyInstance, db: DB,
  principal: (req: FastifyRequest, reply: FastifyReply) => Promise<HistoricalRawOwner | null>,
) {
  app.get("/api/sync/v1/progressive-executions/:executionId/historical-raw-archives/retention-owner", async (req,reply) => {
    const owner = await principal(req,reply);
    if (!owner) return;
    const params = z.object({executionId:z.string().uuid()}).strict().safeParse(req.params);
    if (!params.success || Object.keys(req.query as object).length)
      return reply.code(400).send({error:"Invalid registered retention owner"});
    const [row] = await db.execute(sql`SELECT d.sim_job_id AS "executionId",d.promise_id AS "promiseId",
      d.solver_id AS "solverId",d.content_signature AS "assignmentSignature",
      EXISTS(SELECT FROM progressive_historical_raw_archives c WHERE c.sim_job_id=d.sim_job_id) AS "historicalRaw"
      FROM progressive_remote_dispatches d JOIN registered_remote_solvers s ON s.id=d.solver_id
      WHERE d.sim_job_id=${params.data.executionId}::uuid AND d.solver_id=${owner.id}::uuid AND s.instance_id=${owner.instanceId}
        AND s.revoked_at IS NULL AND s.auth_token_hash=${owner.authTokenHash}`);
    if (!row) return reply.code(404).send({error:"Registered execution is unavailable"});
    return reply.header("cache-control","private, no-store").send({version:1,...row});
  });
}
