import { env } from "./env";
import { buildServer } from "./server";

const app = await buildServer();
try {
  await app.listen({ port: env.port, host: env.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
