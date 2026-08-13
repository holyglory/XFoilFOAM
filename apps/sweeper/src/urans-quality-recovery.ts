import type { PolarRequest } from "@aerodb/engine-client";

/** Engine v12 is the first contract that starts controller-selected repeated
 * PRECALC work on the conservative numerical rung before pimpleFoam. */
export const MIN_CONSERVATIVE_URANS_RETRY_VERSION = 12;

export type ConservativeUransRetryPlan =
  | { kind: "not_required" }
  | { kind: "required"; recoveryVersion: number }
  | { kind: "deferred"; error: string };

export function conservativeUransRetryPlan(
  required: boolean,
  recoveryVersion: number | null | undefined,
): ConservativeUransRetryPlan {
  if (!required) return { kind: "not_required" };
  if (
    recoveryVersion == null ||
    !Number.isSafeInteger(recoveryVersion) ||
    recoveryVersion < MIN_CONSERVATIVE_URANS_RETRY_VERSION
  ) {
    return {
      kind: "deferred",
      error:
        `repeated preliminary URANS requires engine recovery v${MIN_CONSERVATIVE_URANS_RETRY_VERSION}+; ` +
        `live version is ${recoveryVersion ?? "unavailable"}`,
    };
  }
  return { kind: "required", recoveryVersion };
}

export function applyConservativeUransRetryPlan(
  request: PolarRequest,
  plan: Extract<ConservativeUransRetryPlan, { kind: "required" }>,
): void {
  request.solver = {
    ...request.solver,
    urans_quality_recovery: true,
  };
  request.expected_urans_recovery_version = plan.recoveryVersion;
}
