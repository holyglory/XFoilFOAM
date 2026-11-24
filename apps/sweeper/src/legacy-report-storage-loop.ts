import { LegacyStorageOperationError } from "./legacy-report-storage-gcs";
import { legacyBound } from "@aerodb/db/legacy-report-storage";
import { LegacyPeerOccupied } from "./legacy-report-peer-memory";
import { LegacyOperatorPaused } from "./legacy-report-storage-operator";

export async function runLegacyUntilComplete<
  T extends { complete: boolean; next?: unknown },
>(
  pass: (onCheckpointAdvance: () => void) => Promise<T>,
  input: {
    maxPasses?: number;
    maxSeconds?: number;
    yieldMs?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    random?: () => number;
    emit?: (event: Record<string, unknown>) => void;
    signal?: AbortSignal;
  } = {},
) {
  const maxPasses =
    input.maxPasses === undefined
      ? Infinity
      : legacyBound(input.maxPasses, Number.MAX_SAFE_INTEGER, "maximum passes");
  const maxSeconds =
    input.maxSeconds === undefined
      ? Infinity
      : legacyBound(
          input.maxSeconds,
          Number.MAX_SAFE_INTEGER,
          "maximum seconds",
        );
  const yieldMs = legacyBound(
    input.yieldMs ?? 250,
    10000,
    "pass yield milliseconds",
  );
  const now = input.now ?? Date.now,
    sleep =
      input.sleep ??
      ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = input.random ?? Math.random;
  const emit = input.emit ?? (() => undefined),
    started = now(),
    deadline = started + maxSeconds * 1000;
  let attempted = 0,
    completed = 0,
    pauses = 0,
    peerPauses = 0,
    transientRetries = 0,
    last: T | undefined,
    previous: string | undefined,
    stagnant = 0,
    failures = 0;
  // A bounded pass may sync several pages before its next page hits a lock.
  // The next page starts with the initial delay after that durable advance.
  const checkpointAdvanced = () => {
    failures = 0;
  };
  for (; attempted < maxPasses && now() < deadline; ) {
    if (input.signal?.aborted) return finish(false, "signal");
    attempted++;
    try {
      last = await pass(checkpointAdvanced);
      completed++;
      failures = 0;
      emit({
        event: "pass",
        pass: attempted,
        countsScope: "bounded-pass",
        ...last,
      });
      if (last.complete) return finish(true, "scope_complete");
      if (input.signal?.aborted) return finish(false, "signal");
      const cursor = JSON.stringify(last.next);
      if (cursor === undefined)
        throw new Error(
          "Incomplete migration did not report durable cursor progress",
        );
      stagnant = cursor === previous ? stagnant + 1 : 0;
      previous = cursor;
      if (stagnant >= 3)
        throw new Error(
          "Migration cursor made no progress in three consecutive passes; pending material retained",
        );
    } catch (error) {
      if (input.signal?.aborted) return finish(false, "signal");
      let backoff: number;
      if (
        error instanceof LegacyOperatorPaused ||
        error instanceof LegacyPeerOccupied
      ) {
        if (error instanceof LegacyPeerOccupied) peerPauses++;
        else pauses++;
        backoff = Math.max(yieldMs, 5000);
        emit({
          event: "paused",
          pass: attempted,
          reason: error.code,
          retryable: true,
        });
      } else if (
        error instanceof LegacyStorageOperationError &&
        error.retryable
      ) {
        failures++;
        transientRetries++;
        backoff = Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6));
        if (error.details.category.startsWith("database_")) {
          // Repeated lock retries should not synchronize with the same worker
          // heartbeat/ingest cadence. Keep the existing 60s ceiling and retry
          // this durable pending receipt, never advance or recollect the page.
          const jitter = random();
          if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1)
            throw new Error("Invalid database retry jitter");
          backoff = Math.min(
            60000,
            backoff + Math.floor((jitter * backoff) / 2),
          );
        }
        emit({
          event: "retry",
          pass: attempted,
          ...error.details,
          retryable: true,
          consecutiveFailures: failures,
          backoffMs: backoff,
          pendingPageRetry: true,
        });
      } else throw error;
      const remaining = deadline - now();
      if (remaining > 0 && attempted < maxPasses)
        await wait(Math.min(backoff, remaining));
      continue;
    }
    const remaining = deadline - now();
    if (remaining > 0 && attempted < maxPasses)
      await wait(Math.min(yieldMs, remaining));
  }
  return finish(
    false,
    now() >= deadline ? "time_budget_exhausted" : "pass_budget_exhausted",
  );
  async function wait(milliseconds: number) {
    if (input.signal?.aborted) return;
    if (!input.signal) {
      await sleep(milliseconds);
      return;
    }
    let wake: () => void = () => undefined;
    const aborted = new Promise<void>((resolve) => {
      wake = resolve;
      input.signal!.addEventListener("abort", wake, { once: true });
    });
    try {
      await Promise.race([sleep(milliseconds), aborted]);
    } finally {
      input.signal.removeEventListener("abort", wake);
    }
  }
  function finish(complete: boolean, stopReason: string) {
    return {
      event: "finished",
      complete,
      stopReason,
      passesAttempted: attempted,
      passesCompleted: completed,
      deployPauses: pauses,
      peerWorkerPauses: peerPauses,
      transientRetries,
      elapsedSeconds: (now() - started) / 1000,
      next: last?.next ?? null,
    };
  }
}
