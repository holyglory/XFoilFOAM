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
      label: "preliminary unavailable",
      title:
        "Automatic preliminary recovery ended without usable evidence. This is not RANS work waiting for URANS and it is not a review task.",
      detail:
        "Automatic preliminary recovery finished without publishable evidence. The campaign continues around these unavailable points; no user action is required.",
    };
  }
  if (reasons.size === 1 && reasons.has("mesh_quality")) {
    return {
      label: "mesh unavailable",
      title:
        "Automatic safer-mesh recovery did not produce a usable mesh. This is not a review task.",
      detail:
        "Automatic mesh recovery finished without a usable mesh. The campaign continues around these unavailable points; no user action is required.",
    };
  }
  if (reasons.size === 1 && reasons.has("engine_submit_rejected")) {
    return {
      label: "engine unavailable",
      title:
        "The engine did not accept the bounded automatic preliminary submission. This is not a review task.",
      detail:
        "The automatic preliminary submission was not accepted after its bounded retry. The campaign continues around these unavailable points; no user action is required.",
    };
  }
  return {
    label: "results unavailable",
    title:
      "Automatic recovery ended without usable evidence. This is not a review task.",
    detail:
      "Automatic recovery finished without publishable evidence. The campaign continues around these unavailable points; no user action is required.",
  };
}
