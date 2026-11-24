import { once, EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { ReportArchiveVerifier } from "../src/report-archive-verifier";

export function gatedArchiveVerifier() {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workers: Worker[] = [];
  const events = new EventEmitter();
  class FixtureVerifier extends ReportArchiveVerifier {
    override verify(...args: Parameters<ReportArchiveVerifier["verify"]>) {
      const outcome = super.verify(...args);
      events.emit("staged", args[0].path);
      return outcome;
    }
  }
  const verifier = new FixtureVerifier(() => {
    const worker = new Worker(
      new URL("./fixtures/gated-archive-worker.mjs", import.meta.url),
      {
        env: {},
        execArgv: [],
        workerData: gate.buffer,
      },
    );
    workers.push(worker);
    return worker;
  });
  return {
    verifier,
    workers,
    staged: () => once(events, "staged").then(([path]) => path as string),
    holdNextWorker() {
      Atomics.store(gate, 0, 0);
    },
    release() {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
    },
  };
}
