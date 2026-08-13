import type { CampaignRemediationSummary } from "../../../lib/admin";

export interface CampaignRemediationCopy {
  /** Short enough for the campaign header and progress legend. */
  label: string;
  /** Hover/focus explanation for the compact header state. */
  title: string;
  /** Expanded explanation with the system's real next action. */
  detail: string;
}

/**
 * Campaign work has three distinct states: RANS→URANS work still queued,
 * automatic mesh repair currently running, and a terminal preliminary result
 * that did not become usable evidence.  This helper deliberately names only
 * the latter: callers render the queued/repair counters separately.
 */
export function campaignRemediationCopy(
  remediation: CampaignRemediationSummary,
): CampaignRemediationCopy | null {
  if (remediation.blocked <= 0) return null;

  const reasons = new Set(remediation.groups.map((group) => group.reason));
  if (reasons.size === 1 && reasons.has("precalc_attempts_exhausted")) {
    return {
      label: "not published",
      title:
        "Preliminary URANS ended without accepted evidence. Open the exact points to inspect every attempt and choose a point-scoped correction.",
      detail:
        "The campaign continues. These exact points remain unpublished; stored evidence and corrected-run tools are available in Solver › Points.",
    };
  }
  if (reasons.size === 1 && reasons.has("mesh_quality")) {
    return {
      label: "not published",
      title:
        "Automatic mesh attempts did not produce accepted evidence. Open the exact points to inspect mesh diagnostics and create a corrected mesh revision.",
      detail:
        "The campaign continues. These exact points remain unpublished; mesh refinement and manual corrected-run tools are available in Solver › Points.",
    };
  }
  if (reasons.size === 1 && reasons.has("engine_submit_rejected")) {
    return {
      label: "not published",
      title:
        "The engine did not accept the preliminary request. Open the exact points to inspect the stored request and attempt evidence.",
      detail:
        "The campaign continues. These exact points remain unpublished; retry and corrected-run tools are available in Solver › Points.",
    };
  }
  return {
    label: "not published",
    title:
      "Automatic solver attempts ended without accepted evidence. Open the exact points to inspect why and choose a point-scoped action.",
    detail:
      "The campaign continues. These exact points remain unpublished; stored evidence and point-scoped tools are available in Solver › Points.",
  };
}
