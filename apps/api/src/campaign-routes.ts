// Simulation-campaign admin API (spec docs/simulation-campaigns-spec.md §10).
// Every route is admin-only; errors are {error} with 404/409/422 mapping and
// 409 carries refreshed diffs / drift details for the exactly-once dialogs.

import {
  addCampaignAirfoils,
  applyPlanEdit,
  archiveCampaign,
  CAMPAIGN_ERROR_CLASSES,
  CampaignError,
  type CampaignObjectiveKey,
  campaignAirfoilRows,
  campaignDuplicatePrefill,
  campaignFailures,
  campaignLaneDetail,
  campaignLanes,
  campaignRate,
  campaignRejected,
  campaignSummary,
  cancelCampaign,
  classifyPlanChange,
  closeCampaignWithFailures,
  continueLane,
  forceReleaseCondition,
  listCampaigns,
  materializeCampaignLaunch,
  pauseCampaign,
  previewAddCampaignAirfoils,
  previewCampaignReuse,
  requeueCampaignFailed,
  restoreCondition,
  resumeCampaign,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { getCachedEngineHealth } from "./admin-routes";
import { requireAdmin, sessionEmail } from "./admin-auth";
import { db } from "./db";
import { makeEngineClient } from "./engine-client";
import { readSweeperState } from "./services/sweeper-state";

const numberLike = z.union([z.number(), z.string().trim().min(1)]);

/** Normalize Date/pg-timestamptz-string values to strict ISO 8601 (the pinned
 *  payload contract); unparseable strings pass through rather than invent. */
const isoOrNull = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const parsed = new Date(v);
  return Number.isNaN(parsed.getTime()) ? v : parsed.toISOString();
};

const objectiveBody = z.object({
  enabled: z.boolean(),
  toleranceDeg: numberLike.default(0.1),
  maxRounds: z.coerce.number().int().min(1).max(50).default(8),
});

const planBody = z.object({
  mediumId: z.string().uuid(),
  ambients: z
    .array(z.tuple([numberLike, numberLike]))
    .min(1)
    .max(25),
  speedsMps: z.array(numberLike).min(1).max(25),
  chordsM: z.array(numberLike).min(1).max(25),
  spanM: numberLike,
  areaMode: z.enum(["derived", "explicit"]).default("derived"),
  areaM2: numberLike.nullable().optional(),
  excludedConditions: z
    .array(z.tuple([numberLike, numberLike, numberLike, numberLike]))
    .max(2000)
    .default([]),
  baseSweep: z.object({
    fromDeg: numberLike.nullable().optional(),
    toDeg: numberLike.nullable().optional(),
    stepDeg: numberLike.nullable().optional(),
    listDeg: z.array(numberLike).nullable().optional(),
  }),
  // clMax joined the plan shape later — defaulted-disabled so pre-clMax
  // payloads (idempotent replays, scripted launches) keep validating;
  // normalizeCampaignPlan applies the same disabled default when absent.
  objectives: z.object({
    ldMax: objectiveBody,
    clZero: objectiveBody,
    clMax: objectiveBody.default({
      enabled: false,
      toleranceDeg: 0.1,
      maxRounds: 8,
    }),
  }),
  numerics: z.object({
    boundaryProfileId: z.string().uuid(),
    meshProfileId: z.string().uuid(),
    uransMeshProfileId: z.string().uuid().nullable().optional(),
    uransPrecalcMeshProfileId: z.string().uuid().nullable().optional(),
    solverProfileId: z.string().uuid(),
    outputProfileId: z.string().uuid(),
  }),
});

const launchBody = z.object({
  name: z.string().trim().min(1).max(200),
  notes: z.string().nullable().optional(),
  priority: z.coerce.number().int().min(0).max(9).default(5),
  idempotencyKey: z.string().trim().min(8).max(128),
  airfoilIds: z.array(z.string().uuid()).min(1).max(5000),
  plan: planBody,
  markStaleAndResolve: z.boolean().default(false),
});

const objectiveKeyParam = z.enum(["ld_max", "cl_zero", "cl_max"]);

function sendCampaignError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof CampaignError) {
    const status =
      e.code === "not_found" ? 404 : e.code === "validation" ? 422 : 409; // conflict | invalid_state | drift
    return reply.code(status).send({
      error: e.message,
      code: e.code,
      ...(e.details ? { details: e.details } : {}),
    });
  }
  throw e;
}

export async function registerCampaignRoutes(
  app: FastifyInstance,
): Promise<void> {
  // ---- launch + hub list ----
  app.post(
    "/api/admin/campaigns",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = launchBody.parse(req.body);
      try {
        const result = await materializeCampaignLaunch(db, {
          name: b.name,
          notes: b.notes ?? null,
          priority: b.priority,
          idempotencyKey: b.idempotencyKey,
          airfoilIds: b.airfoilIds,
          plan: b.plan,
          markStaleAndResolve: b.markStaleAndResolve,
          createdBy: sessionEmail(req),
        });
        // Idempotent replay returns the existing campaign with 200 (spec §5.2).
        return reply.code(result.replayed ? 200 : 201).send({
          campaign: {
            id: result.campaign.id,
            slug: result.campaign.slug,
            name: result.campaign.name,
            status: result.campaign.status,
            priority: result.campaign.priority,
          },
          replayed: result.replayed,
          totals: result.totals,
          conditionCount: result.conditionCount,
          presetsCreated: result.presetsCreated,
          linkedSolver: result.linkedSolver,
          linkedDerived: result.linkedDerived,
          staleMarked: result.staleMarked,
        });
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  app.get("/api/admin/campaigns", { preHandler: requireAdmin }, async (req) => {
    const q = z
      .object({
        status: z
          .string()
          .optional()
          .transform((v) =>
            v
              ?.split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const listing = await listCampaigns(db, {
      statuses: q.status,
      limit: q.limit,
      offset: q.offset,
    });
    // Cheap solver-state block (pinned contract): sweeper_state row + active
    // sim_jobs count + the SAME cached engine-health probe the queue endpoint
    // uses — no new probe paths.
    const sweeper = await readSweeperState();
    const { health, error: engineError } =
      await getCachedEngineHealth(makeEngineClient());
    const [jobsRow] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM sim_jobs WHERE status IN ('submitted', 'running', 'ingesting')
    `)) as unknown as Array<{ n: number }>;
    return {
      ...listing,
      solverState: {
        heartbeatAt: isoOrNull(sweeper?.heartbeatAt),
        enabled: Boolean(sweeper?.enabled),
        engineUnreachableSince: isoOrNull(sweeper?.engineUnreachableSince),
        engineHealthy: Boolean(health) && !engineError,
        activeJobCount: Number(jobsRow?.n ?? 0),
        // Tick-progress pair (liveness/progress split, migration 0033) —
        // lets every solverState consumer derive the amber tick_stalled
        // state instead of a false red while a tick crawls on a slow engine.
        lastTickStartedAt: isoOrNull(sweeper?.lastTickStartedAt),
        lastTickCompletedAt: isoOrNull(sweeper?.lastTickCompletedAt),
        diskAdmissionBlocked: Boolean(sweeper?.diskAdmissionBlocked),
        diskAdmissionReason: sweeper?.diskAdmissionReason ?? null,
        diskUsedPct: sweeper?.diskUsedPct ?? null,
        diskFreeBytes: sweeper?.diskFreeBytes ?? null,
        diskRequiredFreeBytes: sweeper?.diskRequiredFreeBytes ?? null,
        diskCheckedAt: isoOrNull(sweeper?.diskCheckedAt),
      },
    };
  });

  // ---- wizard reuse preview (§5.4; read-only, POST body) ----
  app.post(
    "/api/admin/campaigns/preview",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = z
        .object({
          plan: planBody,
          airfoilIds: z.array(z.string().uuid()).min(1).max(5000),
        })
        .parse(req.body);
      try {
        return await previewCampaignReuse(db, {
          plan: b.plan,
          airfoilIds: b.airfoilIds,
        });
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  // ---- bounded summary (10 s poll) ----
  app.get(
    "/api/admin/campaigns/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      try {
        const summary = await campaignSummary(db, id);
        const sweeper = await readSweeperState();
        const engine = makeEngineClient();
        const { health, error: engineError } =
          await getCachedEngineHealth(engine);
        const [jobsRow] = (await db.execute(sql`
        SELECT count(*)::int AS n FROM sim_jobs WHERE campaign_id = ${id} AND status IN ('submitted', 'running', 'ingesting')
      `)) as unknown as Array<{ n: number }>;
        // engineUnreachableSince lands with the sweeper phase (migration 0026);
        // readSweeperState() reads it defensively while the column may be absent.
        const engineUnreachableSince = sweeper?.engineUnreachableSince ?? null;
        const rate =
          summary.campaign.status === "active"
            ? await campaignRate(
                db,
                id,
                summary.campaign.rateBaselineAt,
                summary.totals.remaining,
              )
            : null;
        return {
          ...summary,
          scheduler: {
            sweeperEnabled: Boolean(sweeper?.enabled),
            cpuSlots: sweeper?.cpuSlots ?? 0,
            heartbeatAt: isoOrNull(sweeper?.heartbeatAt),
            engineHealthy: Boolean(health) && !engineError,
            engineCheckedAt: new Date().toISOString(),
            engineError: engineError ?? null,
            engineUnreachableSince: isoOrNull(engineUnreachableSince),
            campaignJobsRunning: Number(jobsRow?.n ?? 0),
            // Tick-progress pair (liveness/progress split, migration 0033).
            lastTickStartedAt: isoOrNull(sweeper?.lastTickStartedAt),
            lastTickCompletedAt: isoOrNull(sweeper?.lastTickCompletedAt),
            diskAdmissionBlocked: Boolean(sweeper?.diskAdmissionBlocked),
            diskAdmissionReason: sweeper?.diskAdmissionReason ?? null,
            diskUsedPct: sweeper?.diskUsedPct ?? null,
            diskFreeBytes: sweeper?.diskFreeBytes ?? null,
            diskRequiredFreeBytes: sweeper?.diskRequiredFreeBytes ?? null,
            diskCheckedAt: isoOrNull(sweeper?.diskCheckedAt),
          },
          rate,
        };
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  // ---- matrix rows (keyset by slug) ----
  app.get(
    "/api/admin/campaigns/:id/airfoils",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const q = z
        .object({
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(req.query);
      try {
        return await campaignAirfoilRows(db, id, {
          cursor: q.cursor ?? null,
          limit: q.limit,
        });
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  // ---- failures + rejected (requeue dialog data) ----
  app.get(
    "/api/admin/campaigns/:id/failures",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const q = z
        .object({
          conditionId: z.string().uuid().optional(),
          airfoilId: z.string().uuid().optional(),
          groupBy: z.enum(["errorClass"]).default("errorClass"),
        })
        .parse(req.query);
      try {
        const scope = { conditionId: q.conditionId, airfoilId: q.airfoilId };
        const failures = await campaignFailures(db, id, scope);
        const rejected = await campaignRejected(db, id, scope);
        return { ...failures, rejected };
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  // ---- lanes board + lane detail ----
  app.get(
    "/api/admin/campaigns/:id/lanes",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const q = z
        .object({
          objective: objectiveKeyParam.optional(),
          state: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        })
        .parse(req.query);
      try {
        return await campaignLanes(db, id, {
          objective: q.objective,
          state: q.state,
          cursor: q.cursor ?? null,
          limit: q.limit,
        });
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  app.get(
    "/api/admin/campaigns/:id/lanes/:airfoilId/:conditionId/:objective",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const p = z
        .object({
          id: z.string().uuid(),
          airfoilId: z.string().uuid(),
          conditionId: z.string().uuid(),
          objective: objectiveKeyParam,
        })
        .parse(req.params);
      try {
        return await campaignLaneDetail(db, p.id, {
          airfoilId: p.airfoilId,
          conditionId: p.conditionId,
          objective: p.objective,
        });
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  // ---- plan editing (§6.1 preview → acknowledge) ----
  app.post(
    "/api/admin/campaigns/:id/plan/preview",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z
        .object({
          plan: planBody,
          basePlanRevisionNumber: z.coerce.number().int().min(1),
        })
        .parse(req.body);
      try {
        const { currentRevisionNumber, classification } =
          await classifyPlanChange(db, id, b.plan);
        if (currentRevisionNumber !== b.basePlanRevisionNumber) {
          return reply.code(409).send({
            error:
              "the plan changed while you were editing — reload and try again",
            code: "conflict",
            currentPlanRevisionNumber: currentRevisionNumber,
          });
        }
        const { internal: _internal, ...diff } = classification;
        return diff;
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  app.post(
    "/api/admin/campaigns/:id/plan/apply",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z
        .object({
          plan: planBody,
          basePlanRevisionNumber: z.coerce.number().int().min(1),
          diffHash: z.string().min(16),
        })
        .parse(req.body);
      try {
        const result = await applyPlanEdit(db, {
          campaignId: id,
          basePlanRevisionNumber: b.basePlanRevisionNumber,
          diffHash: b.diffHash,
          newPlan: b.plan,
          createdBy: sessionEmail(req),
        });
        if (result.status === "conflict") {
          return reply.code(409).send({
            error:
              "another plan edit landed first — review the current plan and try again",
            code: "conflict",
            currentPlanRevisionNumber: result.currentPlanRevisionNumber,
          });
        }
        if (result.status === "stale_diff") {
          const { internal: _internal, ...diff } = result.diff;
          return reply.code(409).send({
            error:
              "Results landed while you were reviewing; the numbers changed. Review again.",
            code: "stale_diff",
            diff,
          });
        }
        return result;
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  // ---- add airfoils (preview + apply, same protocol) ----
  app.post(
    "/api/admin/campaigns/:id/airfoils",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z
        .object({
          airfoilIds: z.array(z.string().uuid()).min(1).max(5000),
          mode: z.enum(["preview", "apply"]).default("preview"),
          diffHash: z.string().min(16).optional(),
        })
        .parse(req.body);
      try {
        if (b.mode === "preview")
          return await previewAddCampaignAirfoils(db, id, b.airfoilIds);
        if (!b.diffHash)
          return reply.code(422).send({
            error: "diffHash is required to apply",
            code: "validation",
          });
        const result = await addCampaignAirfoils(
          db,
          id,
          b.airfoilIds,
          b.diffHash,
        );
        if (result.status === "stale_diff") {
          return reply.code(409).send({
            error:
              "the campaign changed while you were reviewing — review the itemized list again",
            code: "stale_diff",
            preview: result.preview,
          });
        }
        return result;
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  // ---- lifecycle verbs (§6.4) ----
  app.post(
    "/api/admin/campaigns/:id/pause",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ reason: z.string().trim().max(500).nullable().optional() })
        .parse(req.body ?? {});
      try {
        return await pauseCampaign(db, id, {
          actor: sessionEmail(req),
          reason: body.reason ?? null,
        });
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  app.post(
    "/api/admin/campaigns/:id/resume",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = z
        .object({ reason: z.string().trim().max(500).nullable().optional() })
        .parse(req.body ?? {});
      try {
        return {
          campaign: await resumeCampaign(db, id, {
            actor: sessionEmail(req),
            reason: body.reason ?? null,
          }),
        };
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  app.post(
    "/api/admin/campaigns/:id/cancel",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      try {
        return await cancelCampaign(db, id);
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  app.post(
    "/api/admin/campaigns/:id/close-with-failures",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      try {
        return await closeCampaignWithFailures(db, id);
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  app.post(
    "/api/admin/campaigns/:id/archive",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z
        .object({ unarchive: z.boolean().default(false) })
        .parse(req.body ?? {});
      try {
        return await archiveCampaign(db, id, b.unarchive);
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  app.post(
    "/api/admin/campaigns/:id/duplicate",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      try {
        // Wizard prefill payload; creates nothing (spec §10).
        return await campaignDuplicatePrefill(db, id);
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  // ---- condition verbs ----
  app.post(
    "/api/admin/campaigns/:id/conditions/:conditionId/force-release",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const p = z
        .object({ id: z.string().uuid(), conditionId: z.string().uuid() })
        .parse(req.params);
      const b = z
        .object({
          expectedCancelledPoints: z.coerce.number().int().min(0).optional(),
        })
        .parse(req.body ?? {});
      try {
        return await forceReleaseCondition(
          db,
          p.id,
          p.conditionId,
          b.expectedCancelledPoints,
        );
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  app.post(
    "/api/admin/campaigns/:id/conditions/:conditionId/restore",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const p = z
        .object({ id: z.string().uuid(), conditionId: z.string().uuid() })
        .parse(req.params);
      try {
        return await restoreCondition(
          db,
          p.id,
          p.conditionId,
          sessionEmail(req),
        );
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  // ---- scoped requeue with server-verified count (409 on drift) ----
  app.post(
    "/api/admin/campaigns/:id/requeue-failed",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const b = z
        .object({
          errorClasses: z.array(z.enum(CAMPAIGN_ERROR_CLASSES)).optional(),
          conditionId: z.string().uuid().optional(),
          airfoilId: z.string().uuid().optional(),
          expectedCount: z.coerce.number().int().min(0),
          // Rejected bucket opt-in: expectedRejectedCount defaults to 0 in the
          // DB layer, so includeRejected without a count 409s on drift instead
          // of silently requeueing unconfirmed points.
          includeRejected: z.boolean().optional(),
          expectedRejectedCount: z.coerce.number().int().min(0).optional(),
        })
        .parse(req.body);
      try {
        return await requeueCampaignFailed(db, id, b);
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );

  // ---- lane continue (+N rounds) ----
  app.post(
    "/api/admin/campaigns/:id/lanes/:airfoilId/:conditionId/:objective/continue",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const p = z
        .object({
          id: z.string().uuid(),
          airfoilId: z.string().uuid(),
          conditionId: z.string().uuid(),
          objective: objectiveKeyParam,
        })
        .parse(req.params);
      const b = z
        .object({
          extraRounds: z.coerce.number().int().min(1).max(50).default(1),
        })
        .parse(req.body ?? {});
      try {
        const lane = await continueLane(
          db,
          p.id,
          {
            airfoilId: p.airfoilId,
            conditionId: p.conditionId,
            objective: p.objective as CampaignObjectiveKey,
          },
          b.extraRounds,
        );
        return { lane };
      } catch (e) {
        return sendCampaignError(reply, e);
      }
    },
  );
}
