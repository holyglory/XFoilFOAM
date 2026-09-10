import {
  RetainedReportReadError,
  retainedSolverReportDownload,
  retainedSolverReports,
} from "@aerodb/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { requireAdmin } from "./admin-auth";
import { db } from "./db";

function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof RetainedReportReadError)
    return reply.code(error.statusCode).send({ error: error.message });
  throw error;
}

export async function registerRetainedReportRoutes(app: FastifyInstance) {
  app.get(
    "/api/admin/retained-reports",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = z
        .object({
          airfoil: z.string().trim().max(120).optional(),
          campaignId: z.string().uuid().optional(),
          cursor: z.string().max(1024).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
          includeDelivered: z.enum(["true", "false"]).optional(),
        })
        .safeParse(req.query);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "Invalid retained-report filters" });
      try {
        return await retainedSolverReports(db, {
          ...parsed.data,
          includeDelivered: parsed.data.includeDelivered === "true",
        });
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
  app.get(
    "/api/admin/retained-reports/:executionId/:sequence",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const params = z
        .object({
          executionId: z.string().uuid(),
          sequence: z.coerce
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER),
        })
        .safeParse(req.params);
      const query = z
        .object({ signature: z.string().regex(/^[a-f0-9]{64}$/) })
        .safeParse(req.query);
      if (!params.success || !query.success)
        return reply
          .code(400)
          .send({ error: "Invalid exact retained-report reference" });
      try {
        const report = await retainedSolverReportDownload(db, {
          ...params.data,
          ...query.data,
        });
        return reply
          .header("cache-control", "private, no-store")
          .header(
            "content-disposition",
            `attachment; filename="${report.filename}"`,
          )
          .header("x-content-sha256", report.signature)
          .type("application/json; charset=utf-8")
          .send(report.content);
      } catch (error) {
        return failure(reply, error);
      }
    },
  );
}
