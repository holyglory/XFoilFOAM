"use client";

// Shared admin polling hook (spec §11): fixed interval, paused while
// document.hidden, immediate refetch on visibility resume.

import { useCallback, useEffect, useRef } from "react";

export function usePoll(
  fn: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  const fnRef = useRef(fn);
  const inFlightRef = useRef<Promise<void> | null>(null);
  fnRef.current = fn;

  const tick = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    if (inFlightRef.current) return;
    const run = Promise.resolve()
      .then(() => fnRef.current())
      .then(
        () => undefined,
        () => undefined,
      );
    inFlightRef.current = run;
    void run.finally(() => {
      if (inFlightRef.current === run) inFlightRef.current = null;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    tick();
    const timer = window.setInterval(tick, intervalMs);
    const onVisibility = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalMs, tick]);
}
