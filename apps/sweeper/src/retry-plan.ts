// RANS→URANS retry scoping (docs/simulation-campaigns-spec.md §7): the
// "<5 valid points / longest-run <5 → whole polar" heuristics are evaluated
// against the REVISION-WIDE evidence set for the airfoil, never the job's own
// points, so a single-angle targeted job on a healthy polar can no longer
// trigger a whole-polar URANS re-run. `targeted` jobs escalate only their own
// rejected/needs_urans angles (targeted URANS). The 0..5° whole-polar rule is
// applied at revision scope (sweep jobs). The decision core is a pure
// function so the scoping rules are unit-testable without a database.

import { type DB, resultAttempts, resultClassifications, results } from "@aerodb/db";
import { and, eq, isNotNull } from "drizzle-orm";

export interface RetryEvidenceRow {
  aoaDeg: number;
  state: "accepted" | "needs_urans" | "rejected" | "superseded_by_urans";
}

export interface RansRetryDecision {
  aoas: number[];
  queueCanonicalAoas: number[];
  retryMode: "whole-polar-urans" | "needs-urans-confirmation" | "invalid-rans-points" | "targeted-urans";
  fullUrans: boolean;
  validRansPointCount: number;
  needsUransCount: number;
  hardRejectedCount: number;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** Whole-polar promotion heuristics over REVISION-WIDE evidence: rejected in
 *  0..5°, fewer than 5 valid points, or no contiguous valid run of ≥5 points.
 *  The run step is the MEDIAN positive spacing (not the minimum) so mixed
 *  grids — base sweep + fractional refinement angles — do not shatter runs. */
function wholePolarAtRevisionScope(rows: RetryEvidenceRow[]): boolean {
  if (rows.some((r) => r.aoaDeg >= 0 && r.aoaDeg <= 5 && r.state === "rejected")) return true;
  if (!rows.some((r) => r.state === "rejected")) return false;
  const validAoas = uniqueSorted(rows.filter((r) => r.state === "accepted" || r.state === "needs_urans").map((r) => r.aoaDeg));
  if (validAoas.length < 5) return true;
  const diffs = validAoas
    .slice(1)
    .map((x, i) => x - validAoas[i])
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const step = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 1;
  let longest = validAoas.length ? 1 : 0;
  let current = longest;
  for (let i = 1; i < validAoas.length; i++) {
    if (validAoas[i] - validAoas[i - 1] <= step * 1.5 + 1e-9) {
      current += 1;
    } else {
      longest = Math.max(longest, current);
      current = 1;
    }
  }
  longest = Math.max(longest, current);
  return longest < 5;
}

/** Merge job-local attempt evidence into the revision-wide view: revision-level
 *  rows win per angle; job-only angles (attempt-only rejections that never made
 *  a results row) are appended so their failures still count. */
function mergeEvidence(revisionRows: RetryEvidenceRow[], jobRows: RetryEvidenceRow[]): RetryEvidenceRow[] {
  const byAoa = new Map<number, RetryEvidenceRow>();
  for (const row of jobRows) byAoa.set(row.aoaDeg, row);
  for (const row of revisionRows) byAoa.set(row.aoaDeg, row);
  return [...byAoa.values()];
}

/**
 * Pure retry-scoping decision. Inputs: this job's RANS attempt classifications
 * (jobRows), the revision-wide result-level classification summary
 * (revisionRows), and the job kind. A job with zero rejected/needs_urans
 * points never retries, regardless of revision health.
 */
export function decideRansRetry(opts: {
  jobKind: string;
  jobRows: RetryEvidenceRow[];
  revisionRows: RetryEvidenceRow[];
}): RansRetryDecision | null {
  const { jobKind, jobRows, revisionRows } = opts;
  if (!jobRows.length) return null;
  const needsUransAoas = uniqueSorted(jobRows.filter((r) => r.state === "needs_urans").map((r) => r.aoaDeg));
  const hardRejectedAoas = uniqueSorted(jobRows.filter((r) => r.state === "rejected").map((r) => r.aoaDeg));
  if (!needsUransAoas.length && !hardRejectedAoas.length) return null;

  const targeted = jobKind === "targeted";
  const fullUrans = !targeted && wholePolarAtRevisionScope(mergeEvidence(revisionRows, jobRows));
  const ownAoas = uniqueSorted([...needsUransAoas, ...hardRejectedAoas]);
  const aoas = fullUrans ? uniqueSorted(jobRows.map((r) => r.aoaDeg)) : ownAoas;
  return {
    aoas,
    queueCanonicalAoas: fullUrans ? aoas : hardRejectedAoas,
    retryMode: fullUrans
      ? "whole-polar-urans"
      : targeted
        ? "targeted-urans"
        : needsUransAoas.length
          ? "needs-urans-confirmation"
          : "invalid-rans-points",
    fullUrans,
    validRansPointCount: jobRows.filter((r) => r.state === "accepted").length,
    needsUransCount: needsUransAoas.length,
    hardRejectedCount: hardRejectedAoas.length,
  };
}

/** DB wrapper: load the job's RANS attempt classifications and the
 *  revision-wide result-level classifications, then decide.
 *
 *  Batched campaign parents (`attemptRevisionId` set) need the job-local
 *  evidence scoped to ONE conditionMap entry's revision. result_attempts rows
 *  collapse onto one row per (job, engine job, aoa, regime) across the bundled
 *  speeds (unique index), so per-entry evidence is reconstructed from the
 *  job's OWN claimed/solved results rows at that revision via their
 *  result-level classifications (an unsolved claimed row classifies
 *  `rejected`), unioned with any attempt rows stored at that revision;
 *  result-level rows win per angle. Single-revision jobs pass nothing and keep
 *  the original attempts-only behavior. */
export async function ransRetryPlanForJobScoped(
  db: DB,
  opts: { parentJobId: string; airfoilId: string; revisionId: string; jobKind: string; attemptRevisionId?: string },
): Promise<RansRetryDecision | null> {
  const attemptFilters = [eq(resultAttempts.simJobId, opts.parentJobId), eq(resultAttempts.regime, "rans")];
  if (opts.attemptRevisionId) {
    attemptFilters.push(eq(resultAttempts.simulationPresetRevisionId, opts.attemptRevisionId));
  }
  const attemptRows = await db
    .select({ aoaDeg: resultAttempts.aoaDeg, state: resultClassifications.state })
    .from(resultAttempts)
    .innerJoin(resultClassifications, eq(resultClassifications.resultAttemptId, resultAttempts.id))
    .where(and(...attemptFilters));
  let jobRows = attemptRows;
  if (opts.attemptRevisionId) {
    const ownResultRows = await db
      .select({ aoaDeg: resultClassifications.aoaDeg, state: resultClassifications.state })
      .from(results)
      .innerJoin(resultClassifications, eq(resultClassifications.resultId, results.id))
      .where(
        and(
          eq(results.simJobId, opts.parentJobId),
          eq(results.simulationPresetRevisionId, opts.attemptRevisionId),
          eq(results.airfoilId, opts.airfoilId),
        ),
      );
    const byAoa = new Map<number, (typeof attemptRows)[number]>();
    for (const row of attemptRows) byAoa.set(row.aoaDeg, row);
    for (const row of ownResultRows) byAoa.set(row.aoaDeg, row);
    jobRows = [...byAoa.values()];
  }
  if (!jobRows.length) return null;
  const revisionRows = await db
    .select({ aoaDeg: resultClassifications.aoaDeg, state: resultClassifications.state })
    .from(resultClassifications)
    .where(
      and(
        eq(resultClassifications.airfoilId, opts.airfoilId),
        eq(resultClassifications.simulationPresetRevisionId, opts.revisionId),
        isNotNull(resultClassifications.resultId),
      ),
    );
  return decideRansRetry({ jobKind: opts.jobKind, jobRows, revisionRows });
}
