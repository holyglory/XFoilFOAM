import { env } from "./env";
import { closeDatabasePools } from "./db";
import { buildServer } from "./server";

const app = await buildServer();
try {
  await app.listen({ port: env.port, host: env.host });
} catch (err) {
  app.log.error(err);
  await closeDatabasePools();
  process.exit(1);
}

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } finally {
    await closeDatabasePools();
  }
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
