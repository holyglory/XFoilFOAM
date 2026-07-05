// Finished-job-log open state lives in the URL (?flog=1), matching the admin
// console rule that search params are the single source of truth for UI
// state (spec §11). A native <details> element keeps its open state only in
// the DOM, so navigating to an airfoil detail page and pressing back used to
// remount the Solver page with the log collapsed — and scroll restoration
// could not land inside it. Pure module for the node vitest suite.

/** Search-param name for the Solver page "Finished job log" expander. */
export const FINISHED_LOG_PARAM = "flog";

/** True when the given search string (with or without leading "?") marks the
 *  finished-job log as open. Only "1" counts — anything else is closed. */
export function isFinishedLogOpen(search: string): boolean {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get(FINISHED_LOG_PARAM) === "1";
}

/** Returns the search string (including "?" when non-empty) with the
 *  finished-log flag set or removed; every other param is preserved. */
export function withFinishedLogParam(search: string, open: boolean): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (open) params.set(FINISHED_LOG_PARAM, "1");
  else params.delete(FINISHED_LOG_PARAM);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}
