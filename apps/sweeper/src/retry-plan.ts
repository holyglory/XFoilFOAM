// RANS→URANS retry scoping — TARGETED-ONLY (fidelity ladder R2, 2026-07-07).
//
// History: the original heuristics ("rejected in 0..5°", "<5 valid points",
// "no contiguous valid run of ≥5") could promote a background sweep to a
// WHOLE-POLAR URANS re-run. On the first production campaign that escalation
// burned hours of URANS on angles whose RANS evidence was already accepted
// (tiny-polar heuristic tripping on sparse early evidence). Targeted jobs were
// already exempt; the ladder kills the whole-polar path for background sweeps
// too: every retry re-solves ONLY the job's own rejected/needs_urans angles,
// at 'precalc' fidelity, and the verify queue (contract 4) is what buys back
// confidence at full fidelity afterwards. A whole-polar URANS pass is now an
// explicit ADMIN action (POST /api/admin/urans-requests without aoaDeg) —
// never an automatic escalation. MUST-CATCH: campaign-scheduling.test.ts pins
// that the old promotion inputs (rejected at low AoA, sparse valid evidence)
// still produce targeted-only plans.
//
// The decision core is a pure function so the scoping rules are unit-testable
// without a database.

import { type DB, resultAttempts, resultClassifications, results } from "@aerodb/db";
import { and, eq } from "drizzle-orm";

export interface RetryEvidenceRow {
  aoaDeg: number;
  state: "accepted" | "needs_urans" | "rejected" | "superseded_by_urans";
}

export interface RansRetryDecision {
  /** The job's OWN rejected/needs_urans angles — never anything wider. */
  aoas: number[];
  queueCanonicalAoas: number[];
  retryMode: "needs-urans-confirmation" | "invalid-rans-points" | "targeted-urans";
  validRansPointCount: number;
  needsUransCount: number;
  hardRejectedCount: number;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Pure retry-scoping decision. Input: this job's RANS classifications
 * (jobRows). A job with zero rejected/needs_urans points never retries. The
 * retry is ALWAYS scoped to the job's own bad angles (R2: no whole-polar
 * escalation on any background path).
 */
export function decideRansRetry(opts: { jobKind: string; jobRows: RetryEvidenceRow[] }): RansRetryDecision | null {
  const { jobKind, jobRows } = opts;
  if (!jobRows.length) return null;
  const needsUransAoas = uniqueSorted(jobRows.filter((r) => r.state === "needs_urans").map((r) => r.aoaDeg));
  const hardRejectedAoas = uniqueSorted(jobRows.filter((r) => r.state === "rejected").map((r) => r.aoaDeg));
  if (!needsUransAoas.length && !hardRejectedAoas.length) return null;

  const aoas = uniqueSorted([...needsUransAoas, ...hardRejectedAoas]);
  return {
    aoas,
    queueCanonicalAoas: hardRejectedAoas,
    retryMode:
      jobKind === "targeted" ? "targeted-urans" : needsUransAoas.length ? "needs-urans-confirmation" : "invalid-rans-points",
    validRansPointCount: jobRows.filter((r) => r.state === "accepted").length,
    needsUransCount: needsUransAoas.length,
    hardRejectedCount: hardRejectedAoas.length,
  };
}

/** DB wrapper: load the job's RANS attempt classifications, then decide.
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
  return decideRansRetry({ jobKind: opts.jobKind, jobRows });
}
