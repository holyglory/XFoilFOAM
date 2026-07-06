// Point History Explorer API (Solver ▸ Points tab, approved 2026-07-06).
// Three admin-gated endpoints over the packages/db point-history read model:
//   GET  /api/admin/point-history            — filterable, keyset-paged table
//   GET  /api/admin/point-history/:id/story  — one point's full attempt story
//   POST /api/admin/point-history/:id/requeue — single-point requeue (failed
//        via the requeue-failed semantics, rejected via the PR #1
//        requeue-rejected semantics; anything else 409s).
import {
  CAMPAIGN_ERROR_CLASSES,
  CampaignError,
  parsePointHistoryCursor,
  POINT_HISTORY_BUCKETS,
  pointHistoryPage,
  pointStory,
  requeueSinglePoint,
} from "@aerodb/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireAdmin } from "./admin-auth";
import { db } from "./db";

const listQuerySchema = z.object({
  status: z.enum(POINT_HISTORY_BUCKETS).optional(),
  airfoil: z.string().trim().min(1).max(120).optional(),
  campaignId: z.string().uuid().optional(),
  regime: z.enum(["rans", "urans"]).optional(),
  errorClass: z.enum(CAMPAIGN_ERROR_CLASSES).optional(),
  reynolds: z.coerce.number().int().positive().optional(),
  cursor: z.string().min(3).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
  // NOT z.coerce.boolean(): that coerces ANY non-empty string ("false", "0")
  // to true. Explicit literal set so facets=false actually means false.
  facets: z.enum(["true", "false", "1", "0"]).optional(),
});

function sendPointError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof CampaignError) {
    const status = e.code === "not_found" ? 404 : e.code === "validation" ? 422 : 409;
    return reply.code(status).send({ error: e.message, code: e.code, ...(e.details ? { details: e.details } : {}) });
  }
  throw e;
}

export async function registerPointHistoryRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/point-history", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid query — see point-history filter contract", details: parsed.error.flatten() });
    }
    const q = parsed.data;
    const cursor = q.cursor == null ? null : parsePointHistoryCursor(q.cursor);
    if (q.cursor != null && cursor == null) {
      return reply.code(400).send({ error: "invalid cursor — expected `<lastActivity ISO>|<row key>` from a previous page" });
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
      },
      { cursor, limit: q.limit, includeFacets: q.facets === "true" || q.facets === "1" },
    );
  });

  app.get("/api/admin/point-history/:id/story", { preHandler: requireAdmin }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid point id" });
    try {
      return await pointStory(db, params.data.id);
    } catch (e) {
      return sendPointError(reply, e);
    }
  });

  app.post("/api/admin/point-history/:id/requeue", { preHandler: requireAdmin }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: "invalid point id" });
    try {
      return await requeueSinglePoint(db, params.data.id);
    } catch (e) {
      return sendPointError(reply, e);
    }
  });
}
