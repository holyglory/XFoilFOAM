// Point History Explorer API (Solver ▸ Points tab, approved 2026-07-06).
// Admin-gated endpoints over the packages/db point-history read/action model:
//   GET  /api/admin/point-history            — filterable, keyset-paged table
//   GET  /api/admin/point-history/:id/story  — one point's full attempt story
//   POST /api/admin/point-history/:id/requeue — single-point requeue (failed
//        via the requeue-failed semantics, rejected via the PR #1
//        requeue-rejected semantics; anything else 409s).
//   POST /api/admin/point-history/:id/corrected-run — exact-generation,
//        immutable mesh/solver correction plus one targeted URANS request.
import {
  CAMPAIGN_ERROR_CLASSES,
  CampaignError,
  createPointCorrection,
  parsePointHistoryCursor,
  POINT_HISTORY_BUCKETS,
  POINT_VERIFY_FILTERS,
  pointHistoryPage,
  pointStory,
  requeueSinglePoint,
} from "@aerodb/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireAdmin, sessionEmail } from "./admin-auth";
import { db } from "./db";
import { assembleAdminSim } from "./services/sim";

const listQuerySchema = z.object({
  status: z.enum(POINT_HISTORY_BUCKETS).optional(),
  airfoil: z.string().trim().min(1).max(120).optional(),
  campaignId: z.string().uuid().optional(),
  regime: z.enum(["rans", "urans"]).optional(),
  errorClass: z.enum(CAMPAIGN_ERROR_CLASSES).optional(),
  reynolds: z.coerce.number().int().positive().optional(),
  verify: z.enum(POINT_VERIFY_FILTERS).optional(),
  cursor: z.string().min(3).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  // NOT z.coerce.boolean(): that coerces ANY non-empty string ("false", "0")
  // to true. Explicit literal set so facets=false actually means false.
  facets: z.enum(["true", "false", "1", "0"]).optional(),
});

const correctionBodySchema = z.object({
  resultAttemptId: z.string().uuid(),
  fidelity: z.enum(["precalc", "full"]),
  // Deliberately absent from the normal request-URANS endpoint. This narrow
  // operator experiment stays bound to an immutable point-correction row,
  // and the sweeper revalidates that provenance before engine submission.
  freshBudgetOverrideS: z
    .number()
    .int()
    .min(4 * 60 * 60)
    .max(24 * 60 * 60)
    .optional(),
  mesh: z.object({
    mesher: z.string().trim().min(1).max(80),
    farfieldRadiusChords: z.number().finite().positive().max(500),
    wakeLengthChords: z.number().finite().positive().max(500),
    nSurface: z.number().int().min(20).max(10_000),
    nRadial: z.number().int().min(10).max(5_000),
    nWake: z.number().int().min(10).max(5_000),
    targetYPlus: z.number().finite().positive().max(1_000),
    spanChords: z.number().finite().positive().max(100),
  }),
  solver: z.object({
    turbulenceModel: z.string().trim().min(1).max(80),
    nIterations: z.number().int().min(100).max(1_000_000),
    uransInitializationIterations: z
      .number()
      .int()
      .min(50)
      .max(20_000)
      .nullable()
      .optional(),
    convergenceTolerance: z.number().finite().positive().max(1),
    momentumScheme: z.string().trim().min(1).max(80),
    transientCycles: z.number().finite().positive().max(10_000),
    transientDiscardFraction: z.number().finite().min(0).max(0.95),
    transientMaxCourant: z.number().finite().positive().max(100),
  }),
});

function sendPointError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof CampaignError) {
    const status =
      e.code === "not_found" ? 404 : e.code === "validation" ? 422 : 409;
    return reply.code(status).send({
      error: e.message,
      code: e.code,
      ...(e.details ? { details: e.details } : {}),
    });
  }
  throw e;
}

export async function registerPointHistoryRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/admin/point-history",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = listQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          error: "invalid query — see point-history filter contract",
          details: parsed.error.flatten(),
        });
      }
      const q = parsed.data;
      const cursor =
        q.cursor == null ? null : parsePointHistoryCursor(q.cursor);
      if (q.cursor != null && cursor == null) {
        return reply.code(400).send({
          error:
            "invalid cursor — expected `<lastActivity ISO>|<row key>` from a previous page",
        });
      }
      return pointHistoryPage(
        db,
        {
          bucket: q.status,
          airfoilQuery: q.airfoil,
          campaignId: q.campaignId,
          regime: q.regime,
          errorClass: q.errorClass,
          reynolds: q.reynolds,
          verify: q.verify,
        },
        {
          cursor,
          limit: q.limit,
          includeFacets: q.facets === "true" || q.facets === "1",
        },
      );
    },
  );

  app.get(
    "/api/admin/point-history/:id/story",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid point id" });
      try {
        return await pointStory(db, params.data.id);
      } catch (e) {
        return sendPointError(reply, e);
      }
    },
  );

  app.get(
    "/api/admin/point-history/:id/sim",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid point id" });
      const query = z
        .object({ resultAttemptId: z.string().uuid() })
        .safeParse(req.query);
      if (!query.success)
        return reply
          .code(400)
          .send({ error: "an exact resultAttemptId is required" });
      const sim = await assembleAdminSim(
        params.data.id,
        query.data.resultAttemptId,
      );
      if (!sim)
        return reply.code(404).send({
          error:
            "the exact stored attempt has no complete coefficient evidence",
        });
      return sim;
    },
  );

  app.post(
    "/api/admin/point-history/:id/requeue",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid point id" });
      try {
        return await requeueSinglePoint(db, params.data.id);
      } catch (e) {
        return sendPointError(reply, e);
      }
    },
  );

  app.post(
    "/api/admin/point-history/:id/corrected-run",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
      if (!params.success)
        return reply.code(400).send({ error: "invalid point id" });
      const body = correctionBodySchema.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({
          error:
            body.error.issues[0]?.message ?? "invalid corrected-run settings",
          details: body.error.flatten(),
        });
      }
      try {
        const outcome = await createPointCorrection(db, {
          resultId: params.data.id,
          ...body.data,
          requestedBy: sessionEmail(req),
        });
        return reply.code(outcome.created ? 201 : 200).send(outcome);
      } catch (e) {
        return sendPointError(reply, e);
      }
    },
  );
}
