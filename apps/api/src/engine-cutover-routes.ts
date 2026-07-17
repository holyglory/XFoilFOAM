import {
  CampaignError,
  completeOpenCfd2606Cutover,
  finalizeOpenCfd2606Cutover,
  inspectOpenCfd2606Continuation,
  inspectOpenCfd2606CutoverReadiness,
  prepareOpenCfd2606Cutover,
} from "@aerodb/db";
import { EngineError } from "@aerodb/engine-client";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { requireAdmin, sessionEmail } from "./admin-auth";
import { db } from "./db";
import { makeEngineClient } from "./engine-client";
import {
  assertLiveOpenCfd2606Attestation,
  attestOpenCfd2606CanaryReceipt,
} from "./openfoam-2606-attestation";

// Retiring an executable container/queue is global. A campaign subset would
// strand unselected 2406/legacy work, so the production API deliberately has
// no selection field even though lower-level DB helpers can scope test setup.
const globalBody = z.object({}).strict();

const prepareBody = globalBody.extend({
  reason: z.string().trim().min(1).max(1_000).optional(),
});

const attestationBody = z.object({ receipt: z.unknown() }).strict();

// The producer-shaped OpenCFD 2606 receipt contains the immutable artifact
// inventory for all three canaries. The first production receipt was
// 2,313,736 bytes, so Fastify's default 1 MiB JSON limit rejected it before
// the authoritative receipt schema could run. Keep the exception bounded and
// attached only to the authenticated, exact-origin attestation endpoint;
// sibling maintenance and public routes retain Fastify's default limit.
export const OPENCFD_2606_ATTESTATION_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

const linkedAttestationBody = z
  .object({ canaryAttestationId: z.string().uuid() })
  .strict();

async function requireSameOriginMaintenance(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const origin = String(req.headers.origin ?? "").replace(/\/+$/g, "");
  const fetchSite = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
  const configuredOrigin = String(
    process.env.ADMIN_PUBLIC_ORIGIN ?? process.env.PUBLIC_ORIGIN ?? "",
  ).replace(/\/+$/g, "");
  // A localhost maintenance script sends neither browser header. Browser
  // requests must be exact-origin: SameSite cookies are still sent by a
  // compromised sibling subdomain, so "same-site" is intentionally rejected.
  if (
    (origin && (!configuredOrigin || origin !== configuredOrigin)) ||
    (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
  ) {
    await reply.code(403).send({
      error: "solver maintenance requires an exact-origin admin request",
    });
  }
}

const maintenancePreHandlers = [requireAdmin, requireSameOriginMaintenance];

function sendCutoverError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof z.ZodError) {
    return reply.code(422).send({
      error: "invalid OpenCFD v2606 cutover request",
      code: "validation",
      details: error.flatten(),
    });
  }
  if (error instanceof CampaignError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "validation"
          ? 422
          : 409;
    return reply.code(status).send({
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof EngineError) {
    return reply.code(409).send({
      error: error.message,
      code: error.code ?? "engine_validation",
    });
  }
  throw error;
}

/**
 * Guarded, idempotent maintenance endpoints for the one-way executable
 * OpenCFD v2406 -> v2606 cutover. The database functions own campaign and
 * evidence invariants; these routes only provide the authenticated operator
 * boundary used by scripts/deploy/rebuild-engine.sh.
 */
export async function registerEngineCutoverRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/api/admin/solver-engine-cutovers/opencfd-2606/prepare",
    { preHandler: maintenancePreHandlers },
    async (req, reply) => {
      try {
        const body = prepareBody.parse(req.body ?? {});
        return await prepareOpenCfd2606Cutover(db, {
          actor: sessionEmail(req),
          reason:
            body.reason ??
            "guarded executable solver cutover from OpenCFD v2406 to v2606",
        });
      } catch (error) {
        return sendCutoverError(reply, error);
      }
    },
  );

  app.post(
    "/api/admin/solver-engine-cutovers/opencfd-2606/readiness",
    { preHandler: maintenancePreHandlers },
    async (req, reply) => {
      try {
        globalBody.parse(req.body ?? {});
        return await inspectOpenCfd2606CutoverReadiness(db);
      } catch (error) {
        return sendCutoverError(reply, error);
      }
    },
  );

  app.post(
    "/api/admin/solver-engine-cutovers/opencfd-2606/attest",
    {
      bodyLimit: OPENCFD_2606_ATTESTATION_BODY_LIMIT_BYTES,
      preHandler: maintenancePreHandlers,
    },
    async (req, reply) => {
      try {
        const body = attestationBody.parse(req.body ?? {});
        const attestation = await attestOpenCfd2606CanaryReceipt(
          db,
          makeEngineClient(),
          body.receipt,
          sessionEmail(req),
        );
        return {
          status: "attested" as const,
          canaryAttestationId: attestation.id,
          solverRuntimeBuildId: attestation.solverRuntimeBuildId,
          receiptSha256: attestation.receiptSha256,
          replayed: attestation.replayed,
          createdAt: attestation.createdAt.toISOString(),
        };
      } catch (error) {
        return sendCutoverError(reply, error);
      }
    },
  );

  app.post(
    "/api/admin/solver-engine-cutovers/opencfd-2606/finalize",
    { preHandler: maintenancePreHandlers },
    async (req, reply) => {
      try {
        const body = linkedAttestationBody.parse(req.body ?? {});
        await assertLiveOpenCfd2606Attestation(
          db,
          makeEngineClient(),
          body.canaryAttestationId,
        );
        return await finalizeOpenCfd2606Cutover(db, {
          actor: sessionEmail(req),
          canaryAttestationId: body.canaryAttestationId,
        });
      } catch (error) {
        return sendCutoverError(reply, error);
      }
    },
  );

  app.post(
    "/api/admin/solver-engine-cutovers/opencfd-2606/complete",
    { preHandler: maintenancePreHandlers },
    async (req, reply) => {
      try {
        const body = linkedAttestationBody.parse(req.body ?? {});
        await assertLiveOpenCfd2606Attestation(
          db,
          makeEngineClient(),
          body.canaryAttestationId,
        );
        return await completeOpenCfd2606Cutover(db, {
          actor: sessionEmail(req),
          canaryAttestationId: body.canaryAttestationId,
        });
      } catch (error) {
        return sendCutoverError(reply, error);
      }
    },
  );

  app.post(
    "/api/admin/solver-engine-cutovers/opencfd-2606/continuation",
    { preHandler: maintenancePreHandlers },
    async (req, reply) => {
      try {
        const body = linkedAttestationBody.parse(req.body ?? {});
        // Continuation may be certified long after the maintenance rebuild
        // when an intentionally stopped scheduler is restarted. Re-play the
        // live worker/runtime binding here as well as at finalize/complete so
        // a drifted pool cannot satisfy a durable historical attestation.
        await assertLiveOpenCfd2606Attestation(
          db,
          makeEngineClient(),
          body.canaryAttestationId,
        );
        return await inspectOpenCfd2606Continuation(
          db,
          body.canaryAttestationId,
        );
      } catch (error) {
        return sendCutoverError(reply, error);
      }
    },
  );
}
