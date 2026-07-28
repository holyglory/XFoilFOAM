"use client";

// Shared admin polling hook (spec §11): completion-relative interval, paused
// while document.hidden, immediate refetch on visibility resume. A slow
// request is never overlapped by the next timer tick; one pending visibility
// or manual nudge is coalesced and runs immediately after the active request.

import { useCallback, useEffect, useRef } from "react";

export interface SerialPollController {
  start(): void;
  nudge(): void;
  stop(): void;
}

export interface LatestOnlyTaskController {
  request(): void;
  stop(): void;
}

type AbortableTask = (signal: AbortSignal) => void | Promise<void>;

const DEFAULT_POLL_TIMEOUT_MS = 45_000;

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException
      ? error.name === "AbortError"
      : error instanceof Error && error.name === "AbortError"
  );
}

async function runWithAbortBudget(
  run: AbortableTask,
  timeoutMs: number,
  controller: AbortController,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      Promise.resolve(run(controller.signal)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(
            new DOMException(
              `admin polling request exceeded ${timeoutMs} ms`,
              "AbortError",
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

/** Run one task at a time and retain at most one newer request. Useful for
 * downstream refreshes triggered by a poll result: intermediate generations
 * carry no value and must not create parallel network work. */
export function createLatestOnlyTaskController(
  run: AbortableTask,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): LatestOnlyTaskController {
  let stopped = false;
  let inFlight = false;
  let rerunRequested = false;
  let activeController: AbortController | null = null;

  const drain = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      do {
        rerunRequested = false;
        const controller = new AbortController();
        activeController = controller;
        try {
          await runWithAbortBudget(run, timeoutMs, controller);
        } catch (error) {
          if (!isAbortError(error))
            console.error("[admin-poll] refresh failed", error);
        } finally {
          if (activeController === controller) activeController = null;
        }
      } while (!stopped && rerunRequested);
    } finally {
      inFlight = false;
    }
  };

  return {
    request() {
      if (stopped) return;
      if (inFlight) {
        rerunRequested = true;
        return;
      }
      void drain();
    },
    stop() {
      stopped = true;
      rerunRequested = false;
      activeController?.abort();
      activeController = null;
    },
  };
}

/** Testable serial scheduler behind the React hook. Timers are armed only
 * after a poll settles, so an endpoint slower than its nominal interval
 * cannot accumulate browser requests or downstream matrix refreshes. */
export function createSerialPollController(
  run: AbortableTask,
  intervalMs: number,
  isHidden: () => boolean,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): SerialPollController {
  let stopped = true;
  let inFlight = false;
  let rerunRequested = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeController: AbortController | null = null;

  const clearTimer = () => {
    if (timer == null) return;
    clearTimeout(timer);
    timer = null;
  };

  const schedule = () => {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, intervalMs);
  };

  const tick = async () => {
    if (stopped) return;
    if (isHidden()) {
      schedule();
      return;
    }
    if (inFlight) {
      rerunRequested = true;
      return;
    }
    inFlight = true;
    const controller = new AbortController();
    activeController = controller;
    try {
      await runWithAbortBudget(run, timeoutMs, controller);
    } catch (error) {
      if (!isAbortError(error))
        console.error("[admin-poll] request failed", error);
    } finally {
      if (activeController === controller) activeController = null;
      inFlight = false;
      if (stopped) return;
      if (rerunRequested) {
        rerunRequested = false;
        void tick();
      } else {
        schedule();
      }
    }
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      void tick();
    },
    nudge() {
      if (stopped) return;
      clearTimer();
      if (inFlight) {
        rerunRequested = true;
        return;
      }
      void tick();
    },
    stop() {
      stopped = true;
      rerunRequested = false;
      clearTimer();
      activeController?.abort();
      activeController = null;
    },
  };
}

export function usePoll(
  fn: (signal?: AbortSignal) => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const runLatest = useCallback(
    (signal: AbortSignal) => fnRef.current(signal),
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    const controller = createSerialPollController(
      runLatest,
      intervalMs,
      () => document.hidden,
    );
    controller.start();
    const onVisibility = () => {
      if (!document.hidden) controller.nudge();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      controller.stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, runLatest]);
}
