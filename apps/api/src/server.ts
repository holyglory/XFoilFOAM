import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";

import { registerAdminRoutes } from "./admin-routes";
import { registerCampaignRoutes } from "./campaign-routes";
import { registerEngineCutoverRoutes } from "./engine-cutover-routes";
import { registerPointHistoryRoutes } from "./point-history-routes";
import { db } from "./db";
import { createBrokeredEvidenceUploadReconciler } from "./remote-evidence-broker";
import { registerRoutes } from "./routes";
import { registerSolvedPointsRoutes } from "./solved-points-routes";
import { registerSyncRoutes } from "./sync-routes";
import {
  SYNC_POLAR_MULTIPART_MAX_FIELDS,
  SYNC_POLAR_MULTIPART_MAX_FILES,
  SYNC_POLAR_MULTIPART_MAX_FILE_BYTES,
  SYNC_POLAR_MULTIPART_MAX_PARTS,
  SYNC_POLAR_MULTIPART_MANIFEST_PARSER_BYTES,
} from "./sync-upload-limits";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const evidenceUploadReconciler = createBrokeredEvidenceUploadReconciler(db, {
    onError: (error) =>
      app.log.error({ err: error }, "brokered evidence upload reconciliation failed"),
  });
  app.addHook("onReady", async () => evidenceUploadReconciler.start());
  app.addHook("onClose", async () => evidenceUploadReconciler.stop());
  // credentials:true + reflected origin so the admin session cookie works cross-port in dev.
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: SYNC_POLAR_MULTIPART_MAX_FILE_BYTES,
      files: SYNC_POLAR_MULTIPART_MAX_FILES,
      fields: SYNC_POLAR_MULTIPART_MAX_FIELDS,
      parts: SYNC_POLAR_MULTIPART_MAX_PARTS,
      fieldSize: SYNC_POLAR_MULTIPART_MANIFEST_PARSER_BYTES,
    },
  });
  await registerRoutes(app);
  await registerSyncRoutes(app);
  await registerAdminRoutes(app);
  await registerSolvedPointsRoutes(app);
  await registerPointHistoryRoutes(app);
  await registerCampaignRoutes(app);
  await registerEngineCutoverRoutes(app);
  app.setErrorHandler(
    (err: Error & { code?: string; statusCode?: number }, _req, reply) => {
      const multipartLimit =
        err.code === "FST_FILES_LIMIT" ||
        err.code === "FST_FIELDS_LIMIT" ||
        err.code === "FST_PARTS_LIMIT" ||
        err.code === "FST_REQ_FILE_TOO_LARGE";
      const status = multipartLimit ? 413 : (err.statusCode ?? 500);
      if (status >= 500) app.log.error(err);
      reply.code(status >= 400 ? status : 500).send({ error: err.message });
    },
  );
  return app;
}
