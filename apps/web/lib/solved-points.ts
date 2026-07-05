// Pure logic for the solved-points popover (Solver page redesign, screen 5):
// keyset page merging and prev/next stepping across the loaded row list.
// Kept UI-free so the invariants are unit-testable.

import type { AdminSolvedPoint } from "./admin";

/** Append a fresh keyset page to the already loaded rows, dropping duplicate
 *  resultIds (a row can re-enter a later page if new solves shift the keyset
 *  window between requests). Loaded order is preserved — rows are only added,
 *  never re-sorted, so the open row's index stays stable while stepping. */
export function mergeSolvedPointsPages(prev: AdminSolvedPoint[], next: AdminSolvedPoint[]): AdminSolvedPoint[] {
  if (prev.length === 0) return next;
  const seen = new Set(prev.map((row) => row.resultId));
  const added = next.filter((row) => !seen.has(row.resultId));
  return added.length === 0 ? prev : [...prev, ...added];
}

export type SolvedPointStep =
  /** Move the open modal to items[index]. */
  | { kind: "move"; index: number }
  /** At the loaded end but the server has more rows: fetch the next page first. */
  | { kind: "load-more" }
  /** Hard end (first row for prev / last known row for next) — stay put. */
  | { kind: "none" };

/** Decide what a prev/next click does given the loaded rows and cursor state. */
export function stepSolvedPoint(
  itemCount: number,
  currentIndex: number,
  direction: -1 | 1,
  nextCursor: string | null,
): SolvedPointStep {
  if (itemCount <= 0 || currentIndex < 0 || currentIndex >= itemCount) return { kind: "none" };
  const target = currentIndex + direction;
  if (target < 0) return { kind: "none" };
  if (target >= itemCount) return nextCursor ? { kind: "load-more" } : { kind: "none" };
  return { kind: "move", index: target };
}
