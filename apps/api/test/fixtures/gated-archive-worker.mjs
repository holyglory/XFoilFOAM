// Hold a real verifier thread at startup so disconnects and exits are
// reproducible even with a tiny complete archive.
import { workerData } from "node:worker_threads";
Atomics.wait(new Int32Array(workerData), 0, 0);
await import("../../src/report-archive-verifier-worker.mjs");
