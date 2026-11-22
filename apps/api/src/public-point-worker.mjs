// A private worker port, with the same TypeScript loader as the service.
// There is no listener and no alternate route to the stored point.
import { parentPort } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { assembleSim } = await import("./services/sim.ts");
const { observePointStorage, timePointRead } =
  await import("./public-point-timing.ts");
const { installApiReportArchiveReader } =
  await import("./progressive-report-archive-reader.ts");
await installApiReportArchiveReader();
const { sql } = await import("./db.ts");
const [session] = await sql.unsafe(
  "SELECT current_setting('transaction_read_only') AS readonly",
);
if (session?.readonly !== "on")
  throw new Error("Public point reader requires its read-only connection");
observePointStorage();
parentPort.on("message", async ({ id, args }) => {
  try {
    parentPort.postMessage({
      id,
      ...(await timePointRead(() => assembleSim(...args))),
    });
  } catch (error) {
    const status = error?.statusCode;
    parentPort.postMessage({
      id,
      error:
        Number.isInteger(status) && status >= 400 && status <= 599
          ? status
          : 500,
    });
  }
});
parentPort.postMessage({ ready: true });
