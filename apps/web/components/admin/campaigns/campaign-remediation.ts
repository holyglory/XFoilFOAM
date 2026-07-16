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
      label: "critical preliminary failure",
      title:
        "Preliminary URANS ended without a publishable result. This is a solver reliability incident, not normal RANS handoff or a review task.",
      detail:
        "Required preliminary results are missing. The system must preserve the evidence, resume with corrected recovery capability, and investigate repeated incidents.",
    };
  }
  if (reasons.size === 1 && reasons.has("mesh_quality")) {
    return {
      label: "critical mesh failure",
      title:
        "Automatic safer-mesh recovery did not produce a usable mesh. This is a system reliability incident, not a review task.",
      detail:
        "Required preliminary results are missing. The system must adjust or repair the mesh path automatically and investigate recurrence.",
    };
  }
  if (reasons.size === 1 && reasons.has("engine_submit_rejected")) {
    return {
      label: "critical engine failure",
      title:
        "The engine did not accept automatic preliminary recovery. This is a system reliability incident, not a review task.",
      detail:
        "Required preliminary results are missing. The system must recover engine admission and investigate repeated submission failures.",
    };
  }
  return {
    label: "critical recovery failure",
    title:
      "Automatic recovery ended without a publishable result. This is a system reliability incident, not a review task.",
    detail:
      "Required results are missing. Automatic recovery and evidence-led investigation are required.",
  };
}
