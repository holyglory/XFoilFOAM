// JSON-only Fastify injection in a short-lived process bound to the paired
// disposable hub database. There is no listening socket or background server.
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { registerSyncRoutes } from "../src/sync-routes";
import { closeDatabasePools } from "../src/db";
import { readFileSync } from "node:fs";
if (process.env.WORKER_STAGING_KEYS_ACCEPTANCE !== "1")
  throw new Error("Expected the staging acceptance graph");
const address = new URL(process.env.DATABASE_URL!);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) ||
  !/^\/staging_key_hub_[a-f0-9]{32}$/.test(address.pathname)
)
  throw new Error("Expected the paired disposable hub database");
const input = JSON.parse(readFileSync(0, "utf8"));
if (
  ![
    "/api/sync/v1/polars",
    "/api/sync/v1/retained-progressive-evidence",
  ].includes(input.path)
)
  throw new Error("Unexpected fixture request");
const app = Fastify({ logger: false });
try {
  await app.register(multipart);
  await registerSyncRoutes(app);
  const response = await app.inject({
    method: "POST",
    url: input.path,
    headers: input.headers,
    payload: input.body,
  });
  process.stdout.write(
    JSON.stringify({ status: response.statusCode, body: response.body }),
  );
} finally {
  await app.close();
  await closeDatabasePools();
}
