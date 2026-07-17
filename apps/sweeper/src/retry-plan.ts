// RANS→URANS retry scoping — conditional whole-polar PRECALC (2026-07-12).
//
// A job-local RANS attempt with structured hard_solver provenance in the
// inclusive attached range 0..5° triggers the owner-approved consistency rule
// for a continuous polar: stop the RANS march and route the original immutable
// requested angle list to preliminary URANS. The trigger does not prove every
// surviving RANS value is physically wrong.
// This is deliberately NOT the old broad heuristic: sparse evidence, fewer
// than five valid points, revision-wide history, infrastructure failures and
// deterministic mesh failures cannot widen a retry. Failures outside 0..5°,
// provisional needs_urans evidence, and explicit targeted work remain scoped
// to their own angles.
//
// The decision core is a pure function so the scoping rules are unit-testable
// without a database.

import { isAutomaticRansPrecalcHandoffEvidence } from "@aerodb/core";
import { type DB, resultAttempts, resultClassifications } from "@aerodb/db";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

export type RansFailureDisposition =
  | "none"
  | "hard_solver"
  | "deterministic_mesh"
  | "infrastructure";

export interface RansRetryScope {
  /** Continuous production polar versus explicit correction/refinement work. */
  origin: "continuous-polar" | "explicit-targeted";
  /** Immutable full solver-angle request for this one job condition/revision. */
  requestedAoas: number[];
}

export interface RetryEvidenceRow {
  resultAttemptId?: string;
  aoaDeg: number;
  state: "accepted" | "needs_urans" | "rejected" | "superseded_by_urans";
  reasons?: string[];
  /** Structured engine provenance. Absent legacy attempts may remain eligible
   * for targeted repair when they are coefficient-bearing and error-free, but
   * they can never authorize whole-polar promotion. */
  failureDisposition?: RansFailureDisposition | null;
  error?: string | null;
  status?: string;
  source?: string;
}

export interface RansRetryDecision {
  /** Full requested polar only for the narrow conditional trigger; otherwise
   * the job's own eligible rejected/needs_urans angles. */
  aoas: number[];
  queueCanonicalAoas: number[];
  retryMode:
    | "whole-polar-urans"
    | "needs-urans-confirmation"
    | "invalid-rans-points"
    | "targeted-urans";
  validRansPointCount: number;
  needsUransCount: number;
  hardRejectedCount: number;
  /** Present only for the conditional whole-polar path loaded from exact DB
   * attempt evidence; pure policy tests may omit ids. */
  wholePolarTriggerResultAttemptId?: string;
  wholePolarTriggerAoaDeg?: number;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.filter(Number.isFinite))].sort((a, b) => a - b);
}

export function retryScopeForRequestedPolar(
  requestedAoas: number[],
  opts: { explicitTargeted?: boolean } = {},
): RansRetryScope {
  const normalized = uniqueSorted(requestedAoas);
  return {
    origin:
      opts.explicitTargeted || normalized.length <= 1
        ? "explicit-targeted"
        : "continuous-polar",
    requestedAoas: normalized,
  };
}

export function parseRansRetryScope(
  raw: unknown,
  fallbackAoas: number[],
): RansRetryScope {
  if (raw && typeof raw === "object") {
    const candidate = raw as {
      origin?: unknown;
      requestedAoas?: unknown;
    };
    if (
      (candidate.origin === "continuous-polar" ||
        candidate.origin === "explicit-targeted") &&
      Array.isArray(candidate.requestedAoas)
    ) {
      const requestedAoas = uniqueSorted(
        candidate.requestedAoas.filter(
          (value): value is number =>
            typeof value === "number" && Number.isFinite(value),
        ),
      );
      if (requestedAoas.length) {
        return { origin: candidate.origin, requestedAoas };
      }
    }
  }
  // Pre-contract jobs did not pin semantic request intent or the complete
  // requested polar. Reconstructing "continuous" from the execution subset
  // would let a small claimed batch widen itself. Preserve targeted repair
  // only; whole-polar promotion requires an explicit valid pinned scope.
  return retryScopeForRequestedPolar(fallbackAoas, { explicitTargeted: true });
}

/** Whole-polar promotion requires the new structured provenance. Legacy rows
 * are ambiguous at policy scope even when their stored coefficients make a
 * targeted repair reasonable. */
function isHardSolverRejection(row: RetryEvidenceRow): boolean {
  return row.state === "rejected" && row.failureDisposition === "hard_solver";
}

function isTargetableRansRejection(row: RetryEvidenceRow): boolean {
  if (row.state !== "rejected") return false;
  return isAutomaticRansPrecalcHandoffEvidence({
    classificationState: row.state,
    failureDisposition: row.failureDisposition,
    status: row.status ?? "",
    source: row.source ?? "",
    error: row.error,
  });
}

/**
 * Pure retry-scoping decision. Input rows MUST be exact RANS attempts from this
 * job and physical condition; result shells and revision history are forbidden.
 */
export function decideRansRetry(opts: {
  scope: RansRetryScope;
  jobRows: RetryEvidenceRow[];
}): RansRetryDecision | null {
  const { scope, jobRows } = opts;
  if (!jobRows.length) return null;
  const needsUransAoas = uniqueSorted(
    jobRows.filter((r) => r.state === "needs_urans").map((r) => r.aoaDeg),
  );
  const targetableRejectedAoas = uniqueSorted(
    jobRows.filter(isTargetableRansRejection).map((r) => r.aoaDeg),
  );
  const hardRejectedAoas = uniqueSorted(
    jobRows.filter(isHardSolverRejection).map((r) => r.aoaDeg),
  );
  if (!needsUransAoas.length && !targetableRejectedAoas.length) return null;

  const wholePolar =
    scope.origin === "continuous-polar" &&
    uniqueSorted(scope.requestedAoas).length > 1 &&
    hardRejectedAoas.some((aoa) => aoa >= 0 && aoa <= 5);
  const wholePolarTrigger = wholePolar
    ? jobRows
        .filter(
          (row) =>
            isHardSolverRejection(row) && row.aoaDeg >= 0 && row.aoaDeg <= 5,
        )
        .sort((a, b) => a.aoaDeg - b.aoaDeg)[0]
    : undefined;
  const aoas = wholePolar
    ? uniqueSorted(scope.requestedAoas)
    : uniqueSorted([...needsUransAoas, ...targetableRejectedAoas]);
  if (!aoas.length) return null;
  return {
    aoas,
    queueCanonicalAoas: targetableRejectedAoas,
    retryMode: wholePolar
      ? "whole-polar-urans"
      : scope.origin === "explicit-targeted"
        ? "targeted-urans"
        : needsUransAoas.length
          ? "needs-urans-confirmation"
          : "invalid-rans-points",
    validRansPointCount: jobRows.filter((r) => r.state === "accepted").length,
    needsUransCount: needsUransAoas.length,
    hardRejectedCount: hardRejectedAoas.length,
    ...(wholePolarTrigger?.resultAttemptId
      ? {
          wholePolarTriggerResultAttemptId: wholePolarTrigger.resultAttemptId,
          wholePolarTriggerAoaDeg: wholePolarTrigger.aoaDeg,
        }
      : {}),
  };
}

/** DB wrapper: load only this job's exact RANS attempts, optionally narrowed to
 * one batched condition revision. Unsolved result shells and revision-wide
 * classifications are scheduling state, not physical failure evidence. */
export async function ransRetryPlanForJobScoped(
  db: DB,
  opts: {
    parentJobId: string;
    airfoilId: string;
    revisionId: string;
    scope: RansRetryScope;
    attemptRevisionId?: string;
  },
): Promise<RansRetryDecision | null> {
  const attemptFilters = [
    eq(resultAttempts.simJobId, opts.parentJobId),
    eq(resultAttempts.regime, "rans"),
  ];
  if (opts.attemptRevisionId) {
    attemptFilters.push(
      eq(resultAttempts.simulationPresetRevisionId, opts.attemptRevisionId),
    );
  }
  const attemptRows = await db
    .select({
      resultAttemptId: resultAttempts.id,
      aoaDeg: resultAttempts.aoaDeg,
      state: resultClassifications.state,
      reasons: resultClassifications.reasons,
      error: resultAttempts.error,
      status: resultAttempts.status,
      source: resultAttempts.source,
      failureDisposition: sql<RansFailureDisposition | null>`
        CASE
          WHEN ${resultAttempts.evidencePayload} ->> 'failure_disposition'
            IN ('none', 'hard_solver', 'deterministic_mesh', 'infrastructure')
          THEN ${resultAttempts.evidencePayload} ->> 'failure_disposition'
          ELSE NULL
        END
      `,
    })
    .from(resultAttempts)
    .innerJoin(
      resultClassifications,
      eq(resultClassifications.resultAttemptId, resultAttempts.id),
    )
    .where(and(...attemptFilters));
  if (!attemptRows.length) return null;
  return decideRansRetry({ scope: opts.scope, jobRows: attemptRows });
}
