import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";

import { registerAdminRoutes } from "./admin-routes";
import { registerCampaignRoutes } from "./campaign-routes";
import { registerRoutes } from "./routes";
import { registerSyncRoutes } from "./sync-routes";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  // credentials:true + reflected origin so the admin session cookie works cross-port in dev.
  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024, files: 512, fields: 16 } });
  await registerRoutes(app);
  await registerSyncRoutes(app);
  await registerAdminRoutes(app);
  await registerCampaignRoutes(app);
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.code(status >= 400 ? status : 500).send({ error: err.message });
  });
  return app;
}
