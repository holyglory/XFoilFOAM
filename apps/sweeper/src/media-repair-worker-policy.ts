import type { ResultMediaRepairBatchOutcome } from "./media-repair";

export const DEFAULT_MEDIA_REPAIR_CONCURRENCY = 2;
export const MAX_MEDIA_REPAIR_CONCURRENCY = 4;
export const MEDIA_REPAIR_ACTIVE_DELAY_MS = 100;
export const MEDIA_REPAIR_IDLE_DELAY_MS = 30_000;

export function configuredMediaRepairConcurrency(
  raw = process.env.AIRFOILFOAM_MEDIA_REPAIR_CONCURRENCY,
): number {
  const text = raw?.trim();
  if (!text) return DEFAULT_MEDIA_REPAIR_CONCURRENCY;
  const value = Number(text);
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_MEDIA_REPAIR_CONCURRENCY
  ) {
    throw new Error(
      `AIRFOILFOAM_MEDIA_REPAIR_CONCURRENCY must be an integer from 1 through ${MAX_MEDIA_REPAIR_CONCURRENCY}`,
    );
  }
  return value;
}

/** Keep draining immediately after real work. Sleep only after a complete
 * bounded batch found no ready owner; retry timestamps and new discoveries
 * are then polled at the ordinary background cadence. */
export function nextMediaRepairDelayMs(
  outcome: Pick<ResultMediaRepairBatchOutcome, "claimedCount">,
): number {
  return outcome.claimedCount > 0
    ? MEDIA_REPAIR_ACTIVE_DELAY_MS
    : MEDIA_REPAIR_IDLE_DELAY_MS;
}
