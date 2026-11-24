import { createReadStream } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { parentPort } from "node:worker_threads";
import { register } from "tsx/esm/api";

register();
const { visitVerifiedWorkerReportArchive, WorkerReportMemberMismatch } =
  await import("@aerodb/db/progressive-report-archive");

parentPort.on("message", async ({ id, path, identity, owner, limits }) => {
  let status;
  try {
    await visitVerifiedWorkerReportArchive(
      createReadStream(path),
      identity,
      owner,
      () => setImmediate(),
      limits,
    );
    status = "verified";
  } catch (error) {
    status =
      error instanceof WorkerReportMemberMismatch ? "mismatch" : "invalid";
  }
  // A result is sent only after the verifier checks every member and EOF.
  // The port carries no decoded reports, GCS client, credentials or DB handles.
  parentPort.postMessage({ id, status });
});
