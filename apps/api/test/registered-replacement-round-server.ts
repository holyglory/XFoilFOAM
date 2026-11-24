// The two-role admission fixture runs this normal registered HTTP surface in
// its own process so that the hub and worker have independent role/DB pools.
import Fastify from "fastify";
import { closeDatabasePools } from "../src/db";
import { registerSyncRoutes } from "../src/sync-routes";

const app = Fastify({ logger: false });
app.addHook("onResponse", async (req, reply) => {
  process.send?.({
    kind: "request",
    method: req.method,
    path: req.url.split("?")[0],
    status: reply.statusCode,
  });
});
await registerSyncRoutes(app);
const url = await app.listen({ host: "127.0.0.1", port: 0 });
process.send?.({ kind: "ready", url: url + "/api/sync/v1" });
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await closeDatabasePools();
  process.disconnect?.();
}
process.once("message", () => {
  void close();
});
process.once("disconnect", () => {
  void close();
});
