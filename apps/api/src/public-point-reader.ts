import { Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import type { assembleSim } from "./services/sim";
import type { timePointRead } from "./public-point-timing";

export const PUBLIC_POINT_WORKER = "xfoilfoam-public-point";
export const PUBLIC_POINT_CONNECTIONS = 1;
export type PointArguments = Parameters<typeof assembleSim>;
type Detail = Awaited<ReturnType<typeof assembleSim>>;
export type PointReply = Awaited<ReturnType<typeof timePointRead<Detail>>>;
export interface PointTiming {
  queueMs: number;
  assemblyMs: number;
  handoffMs: number;
  stagesMs: PointReply["trace"]["stagesMs"];
  storage: PointReply["trace"]["storage"];
}
interface PendingRead {
  id: number;
  args: PointArguments;
  queuedAt: number;
  sentAt: number;
  releaseQueueWait?: () => void;
  resolve: (v: { detail: Detail; timing: PointTiming }) => void;
  reject: (e: Error) => void;
}
const unavailable = () =>
  Object.assign(new Error("Public point reader unavailable"), {
    statusCode: 503,
  });

/** One active assembly owns its read-only DB slot. Queued entries contain only
 * selectors; a stalled worker cannot accumulate full point bodies or starve
 * the remaining interactive connections. */
export class PublicPointReader {
  private worker?: Worker;
  private ready = false;
  private closed = false;
  private sequence = 0;
  private pending: PendingRead[] = [];
  private current?: PendingRead;
  private timer?: NodeJS.Timeout;

  start(): void {
    if (this.closed || this.worker) return;
    const worker = new Worker(
      new URL("./public-point-worker.mjs", import.meta.url),
      {
        workerData: { service: PUBLIC_POINT_WORKER },
        execArgv: [],
      },
    );
    this.worker = worker;
    this.timer = setTimeout(() => this.failed(worker), 30_000);
    this.timer.unref();
    worker.on("message", (message) => {
      if (this.worker !== worker) return;
      if (message.ready === true) {
        clearTimeout(this.timer);
        this.ready = true;
        this.dispatch();
        return;
      }
      const task = this.current;
      if (!task || task.id !== message.id) {
        this.failed(worker);
        return;
      }
      this.current = undefined;
      clearTimeout(this.timer);
      if (message.error) {
        task.reject(
          Object.assign(new Error("Stored point detail could not be read"), {
            statusCode: message.error,
          }),
        );
      } else {
        const elapsed = performance.now() - task.sentAt;
        task.resolve({
          detail: message.value,
          timing: {
            ...message.trace,
            queueMs: Math.round(task.sentAt - task.queuedAt),
            assemblyMs: message.assemblyMs,
            handoffMs: Math.max(0, Math.round(elapsed - message.assemblyMs)),
          },
        });
      }
      this.dispatch();
    });
    worker.once("error", () => this.failed(worker));
    worker.once("exit", () => this.failed(worker));
  }

  read(args: PointArguments, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(unavailable());
    if (this.closed || this.pending.length >= 32)
      return Promise.reject(unavailable());
    this.start();
    return new Promise<{ detail: Detail; timing: PointTiming }>(
      (resolve, reject) => {
        const task: PendingRead = {
          id: ++this.sequence,
          args,
          queuedAt: performance.now(),
          sentAt: 0,
          resolve,
          reject,
        };
        const expire = () => {
          const i = this.pending.indexOf(task);
          if (i < 0) return;
          this.pending.splice(i, 1);
          task.releaseQueueWait?.();
          reject(unavailable());
        };
        const deadline = setTimeout(expire, 30_000);
        deadline.unref();
        signal?.addEventListener("abort", expire, { once: true });
        task.releaseQueueWait = () => {
          clearTimeout(deadline);
          signal?.removeEventListener("abort", expire);
        };
        this.pending.push(task);
        this.dispatch();
      },
    );
  }

  private dispatch(): void {
    if (this.current || !this.worker || !this.ready) return;
    const task = this.pending.shift();
    if (!task) return;
    task.releaseQueueWait?.();
    this.current = task;
    task.sentAt = performance.now();
    const worker = this.worker;
    this.timer = setTimeout(() => this.failed(worker), 120_000);
    this.timer.unref();
    try {
      worker.postMessage({ id: task.id, args: task.args });
    } catch {
      this.failed(worker);
    }
  }

  private failed(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    this.ready = false;
    clearTimeout(this.timer);
    this.current?.reject(unavailable());
    this.current = undefined;
    for (const task of this.pending.splice(0)) {
      task.releaseQueueWait?.();
      task.reject(unavailable());
    }
    void worker.terminate().catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (!worker) return;
    this.worker = undefined;
    clearTimeout(this.timer);
    this.current?.reject(unavailable());
    this.current = undefined;
    for (const task of this.pending.splice(0)) {
      task.releaseQueueWait?.();
      task.reject(unavailable());
    }
    await worker.terminate();
  }
}
