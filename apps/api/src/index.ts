import { env } from "./env";
import { installProgressiveReportArchiveReader } from "@aerodb/db/progressive-report-reader";
import { readProgressiveReportArchive } from "./progressive-report-archive-reader";
import { closeDatabasePools, db } from "./db";
import { buildServer } from "./server";

if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver") {
  const { readStoredWorkerArchiveText } =
    await import("../../sweeper/src/report-archive-broker-client");
  installProgressiveReportArchiveReader({
    read: (identity) => readStoredWorkerArchiveText(db, identity),
  });
} else if (env.evidenceBucket) {
  installProgressiveReportArchiveReader({ read: readProgressiveReportArchive });
}
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
