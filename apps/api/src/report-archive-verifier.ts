import { Worker } from "node:worker_threads";
import {
  WorkerReportMemberMismatch,
  type ProgressiveReportArchiveLimits,
  type ProgressiveReportArchiveStoredIdentity,
  type visitVerifiedWorkerReportArchive,
} from "@aerodb/db/progressive-report-archive";
import { WORKER_REPORT_TRANSFER_TIMEOUT_MS } from "@aerodb/core/registered-archive-read";
import { SYNC_NON_REPORT_LIMIT } from "./sync-admission";

interface StagedArchive {
  path: string;
  identity: ProgressiveReportArchiveStoredIdentity;
  owner: Parameters<typeof visitVerifiedWorkerReportArchive>[2];
  limits: ProgressiveReportArchiveLimits;
}
interface Job {
  id: number;
  archive: StagedArchive;
  settle(error?: Error): void;
}

interface VerifierThread {
  worker: Worker;
  exited: Promise<void>;
  failure?: Error;
}

export class ArchiveVerifierUnavailable extends Error {
  constructor() {
    super("Worker report archive verifier unavailable");
  }
}

function spawnVerifier(): Worker {
  return new Worker(
    new URL("./report-archive-verifier-worker.mjs", import.meta.url),
    {
      name: "report-archive-verifier",
      env: {},
      execArgv: [],
    },
  );
}

/** One live CPU verifier. Only server-staged paths and small pins wait here.
 * Production requests keep their original sync permit through EOF and cleanup. */
export class ReportArchiveVerifier {
  private thread?: VerifierThread;
  private active?: Job;
  private waiting: Job[] = [];
  private sequence = 0;

  constructor(private readonly spawn: () => Worker = spawnVerifier) {}

  verify(archive: StagedArchive, caller?: AbortSignal): Promise<void> {
    if (caller?.aborted) return Promise.reject(caller.reason);
    if (
      this.waiting.length + Number(Boolean(this.active)) >=
      SYNC_NON_REPORT_LIMIT
    )
      return Promise.reject(new ArchiveVerifierUnavailable());
    const deadline = AbortSignal.timeout(WORKER_REPORT_TRANSFER_TIMEOUT_MS);
    const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
    return new Promise<void>((resolve, reject) => {
      const job: Job = {
        id: ++this.sequence,
        archive,
        settle: (error) => {
          signal.removeEventListener("abort", abort);
          if (error) reject(error);
          else resolve();
        },
      };
      const abort = () => {
        const reason = caller?.aborted
          ? caller.reason instanceof Error
            ? caller.reason
            : new Error("Archive verification was aborted")
          : new ArchiveVerifierUnavailable();
        const index = this.waiting.indexOf(job);
        if (index >= 0) {
          this.waiting.splice(index, 1);
          job.settle(reason);
        } else if (this.active === job && this.thread) {
          this.stop(this.thread, reason);
        }
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(job);
      this.dispatch();
    });
  }

  private start(): VerifierThread {
    const worker = this.spawn();
    const thread: VerifierThread = {
      worker,
      exited: new Promise<void>((resolve) => {
        worker.once("exit", () => {
          // The staged file and the admission slot stay owned until the
          // worker's file descriptor is closed, even on an unexpected exit.
          this.thread = undefined;
          this.active?.settle(
            thread.failure ?? new ArchiveVerifierUnavailable(),
          );
          this.active = undefined;
          resolve();
          this.dispatch();
        });
      }),
    };
    this.thread = thread;
    const failed = () => this.stop(thread, new ArchiveVerifierUnavailable());
    worker.on("error", failed);
    worker.on("messageerror", failed);
    worker.on("message", (reply) => {
      if (thread !== this.thread || thread.failure) return;
      const job = this.active;
      if (!job || reply?.id !== job.id) return failed();
      switch (reply.status) {
        case "verified":
          job.settle();
          break;
        case "mismatch":
          job.settle(
            new WorkerReportMemberMismatch("Signed archive member changed"),
          );
          break;
        case "invalid":
          job.settle(new Error("Worker report archive verification failed"));
          break;
        default:
          return failed();
      }
      this.active = undefined;
      this.dispatch();
    });
    return thread;
  }

  private dispatch(): void {
    if (this.active || this.thread?.failure) return;
    const job = this.waiting.shift();
    if (!job) {
      this.thread?.worker.unref();
      return;
    }
    this.active = job;
    try {
      const { worker } = this.thread ?? this.start();
      worker.ref();
      worker.postMessage({ id: job.id, ...job.archive });
    } catch {
      const error = new ArchiveVerifierUnavailable();
      if (this.thread) this.stop(this.thread, error);
      else {
        this.active = undefined;
        job.settle(error);
        this.dispatch();
      }
    }
  }

  private stop(thread: VerifierThread, reason: Error): void {
    if (thread !== this.thread || thread.failure) return;
    thread.failure = reason;
    void thread.worker.terminate();
  }

  /** A server closing must not cancel another server's active, admitted work. */
  async closeIdle(): Promise<void> {
    const thread = this.thread;
    if (!thread) return;
    if (!this.active) this.stop(thread, new ArchiveVerifierUnavailable());
    if (thread.failure) await thread.exited;
  }
}
