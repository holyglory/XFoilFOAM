import { open, readFile, mkdir, rename, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  emptyHistoryCursor,
  type HistoryCursor,
  type HistorySelection,
} from "@aerodb/db/hz-point-history-storage";
import {
  POINT_HISTORY_KINDS,
  type PointHistoryKind,
} from "@aerodb/core/point-history-working-copy";
import {
  HzHistoryConnections,
  migrateHzHistory,
  type HZRelayOptions,
  type HistoryRelayReceipt,
} from "./hz-point-history-relay";
import { HistoryOperationError } from "@aerodb/core/point-history-protocol";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export async function atomicJson(path: string, value: unknown, immutable = false) {
  const bytes = JSON.stringify(value) + "\n",
    temporary = join(path, "..", `.history-${randomUUID()}.tmp`),
    fd = await open(temporary, "wx", 0o600);
  try {
    await fd.writeFile(bytes);
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    if (immutable) {
      try {
        await link(temporary, path);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "EEXIST" ||
          (await readFile(path, "utf8")) !== bytes
        )
          throw error;
      }
    } else await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const directory = await open(join(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function lockDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const child = spawn(
    "flock",
    [
      "-n",
      join(directory, "operator.lock"),
      "sh",
      "-c",
      "printf 'locked\\n'; cat >/dev/null",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.on("error", () => undefined);
  child.stderr.on("data", () => undefined);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new HistoryOperationError("operator_lock", "local_io"));
    }, 5000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new HistoryOperationError("operator_lock", "local_io"));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new HistoryOperationError("operator_lock", "denied"));
    });
    child.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return async () => {
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.end();
    });
  };
}
interface Progress {
  version: 1;
  binding: string;
  instance: string;
  high: HistoryCursor;
  after: HistoryCursor;
  done: Record<PointHistoryKind, boolean>;
  queue: HistorySelection[];
  pending: string | null;
  cycle: number;
  processed: number;
  offloaded: number;
  retained: number;
  sourceBytes: number;
  oversized: number;
}
export interface HzOperatorOptions {
  directory: string;
  mode: "pass" | "migrate" | "watch";
  selection?: HistorySelection;
  signal?: AbortSignal;
  maxPasses?: number;
  emit?: (event: unknown) => void;
}
/** Only metadata/receipts are durable on the controller. Objects remain on hub
 * and HZ; a stopped or disconnected operator cannot strand deleted source data. */
export async function runHzPointHistoryOperator(
  options: HZRelayOptions,
  run: HzOperatorOptions,
) {
  const release = await lockDirectory(run.directory),
    checkpoint = join(run.directory, "checkpoint.json");
  const binding = sha(
    JSON.stringify({
      options: { ...options, limit: undefined, maxBytes: undefined },
      selection: run.selection ?? null,
    }),
  );
  const kinds =
    options.kind === "all" ? [...POINT_HISTORY_KINDS] : [options.kind];
  const emit = run.emit ?? (() => undefined);
  let state: Progress | undefined,
    passes = 0,
    failures = 0;
  try {
    try {
      state = JSON.parse(await readFile(checkpoint, "utf8"));
      if (state?.version !== 1 || state.binding !== binding)
        throw new HistoryOperationError("checkpoint_binding", "integrity");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    while (
      !run.signal?.aborted &&
      (run.maxPasses === undefined || passes < run.maxPasses)
    ) {
      let connections: HzHistoryConnections | undefined;
      try {
        passes++;
        connections = new HzHistoryConnections(options);
        const hello = await connections.hello();
        if (!state) {
          state = {
            version: 1,
            binding,
            instance: hello.instance,
            high: hello.high,
            after: emptyHistoryCursor(),
            done: {
              force_history: false,
              steady_history: false,
              frame_track: false,
            },
            queue: run.selection ? [run.selection] : [],
            pending: null,
            cycle: 1,
            processed: 0,
            offloaded: 0,
            retained: 0,
            sourceBytes: 0,
            oversized: 0,
          };
          if (run.selection)
            state.done = {
              force_history: true,
              steady_history: true,
              frame_track: true,
            };
          await atomicJson(checkpoint, state);
        }
        if (state.instance !== hello.instance)
          throw new HistoryOperationError("instance_drift", "integrity");
        if (
          run.mode === "watch" &&
          !state.queue.length &&
          !state.pending &&
          kinds.every((kind) => state!.done[kind])
        ) {
          state.cycle++;
          state.high = hello.high;
          state.queue = run.selection ? [run.selection] : [];
          state.after = emptyHistoryCursor();
          state.done = {
            force_history: !!run.selection,
            steady_history: !!run.selection,
            frame_track: !!run.selection,
          };
          await atomicJson(checkpoint, state);
        }
        let completedThisPass = 0;
        for (const kind of kinds) {
          if (state.queue.length || state.pending || state.done[kind]) continue;
          const page = await connections.scan({
            kind,
            after: state.after[kind],
            high: state.high[kind],
            limit: options.limit,
            maxBytes: options.maxBytes,
          });
          state.queue = page.items;
          state.after[kind] = page.after;
          state.done[kind] = page.done;
          state.oversized += page.oversized;
          await atomicJson(checkpoint, state);
          if (state.queue.length) break;
        }
        const services = connections.services();
        while (
          state.queue.length &&
          completedThisPass < options.limit &&
          !run.signal?.aborted
        ) {
          const selection = state.queue[0];
          let pending: HistoryRelayReceipt | undefined;
          if (state.pending) {
            if (!/^[a-f0-9]{64}\.archive\.json$/.test(state.pending))
              throw new HistoryOperationError("pending_receipt", "integrity");
            const text = await readFile(
              join(run.directory, state.pending),
              "utf8",
            );
            if (sha(text) !== state.pending.split(".")[0])
              throw new HistoryOperationError("pending_receipt", "integrity");
            pending = JSON.parse(text);
          }
          const result = await migrateHzHistory(
            selection,
            state.instance,
            services,
            async (receipt) => {
              const text = JSON.stringify(receipt) + "\n",
                name = `${sha(text)}.archive.json`;
              await atomicJson(join(run.directory, name), receipt, true);
              state!.pending = name;
              await atomicJson(checkpoint, state);
            },
            pending,
          );
          const committed = { archiveReceipt: state.pending, result };
          await atomicJson(
            join(
              run.directory,
              `${sha(JSON.stringify(committed))}.custody.json`,
            ),
            committed,
            true,
          );
          state.processed++;
          state.offloaded += Number(result.offloaded);
          state.retained += Number(result.inlineRetained);
          state.sourceBytes += result.sourceBytes;
          state.queue.shift();
          state.pending = null;
          completedThisPass++;
          await atomicJson(checkpoint, state);
          emit({
            event: "history",
            kind: result.kind,
            id: result.id,
            offloaded: result.offloaded,
            replayed: result.replayed,
            inlineRetained: result.inlineRetained,
            reason: result.reason,
            sourceBytes: result.sourceBytes,
          });
        }
        failures = 0;
        const complete =
          !state.queue.length &&
          !state.pending &&
          kinds.every((kind) => state!.done[kind]);
        emit({
          event: "pass",
          pass: passes,
          complete,
          cycle: state.cycle,
          processed: state.processed,
          offloaded: state.offloaded,
          inlineRetained: state.retained,
          sourceBytes: state.sourceBytes,
          oversized: state.oversized,
        });
        if (complete && run.mode !== "watch")
          return { complete: true, ...totals(state) };
        await connections.close();
        connections = undefined;
        if (run.mode === "pass") return { complete, ...totals(state) };
        if (run.maxPasses !== undefined && passes >= run.maxPasses) break;
        await delay(complete ? 30000 : 250, undefined, {
          signal: run.signal,
        }).catch(() => undefined);
      } catch (error) {
        if (run.signal?.aborted) break;
        if (
          !(error instanceof HistoryOperationError) ||
          !error.retryable ||
          run.mode === "pass"
        )
          throw error;
        failures++;
        emit({
          event: "retry",
          operation: error.operation,
          category: error.category,
          checkpointRetained: true,
        });
        await connections?.close();
        connections = undefined;
        if (run.maxPasses !== undefined && passes >= run.maxPasses) break;
        await delay(
          Math.min(60000, 1000 * 2 ** Math.min(failures, 6)),
          undefined,
          { signal: run.signal },
        ).catch(() => undefined);
      } finally {
        await connections?.close();
      }
    }
    return {
      complete: false,
      stopped: run.signal?.aborted ? "signal" : "pass_limit",
      ...(state ? totals(state) : {}),
    };
  } finally {
    await release();
  }
}
function totals(state: Progress) {
  return {
    cycle: state.cycle,
    processed: state.processed,
    offloaded: state.offloaded,
    inlineRetained: state.retained,
    sourceBytes: state.sourceBytes,
    oversized: state.oversized,
  };
}
