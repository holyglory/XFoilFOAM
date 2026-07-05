"use client";

// Shared admin polling hook (spec §11): fixed interval, paused while
// document.hidden, immediate refetch on visibility resume.

import { useCallback, useEffect, useRef } from "react";

export function usePoll(fn: () => void | Promise<void>, intervalMs: number, enabled = true): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const tick = useCallback(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    void fnRef.current();
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
