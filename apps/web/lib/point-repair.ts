import { isDeterministicMeshBlockerError } from "@aerodb/core";

import type { PointStoryPayload } from "./point-history";

export interface PointRepairEligibility {
  retryEligible: boolean;
  continueEligible: boolean;
  requeueRejectedEligible: boolean;
  requeueEligible: boolean;
  correctionEligible: boolean;
}

/** Keep every point-management surface aligned with the server-owned story.
 * Continuation remains server-certified; the client never infers a checkpoint
 * from filenames, statuses, or a campaign aggregate. */
export function pointRepairEligibility(
  story: PointStoryPayload | null,
): PointRepairEligibility {
  const retryEligible =
    story != null &&
    story.point.status === "failed" &&
    story.point.regime !== "urans" &&
    !(story.point.fidelity ?? "").startsWith("urans") &&
    story.point.workDisposition == null &&
    !isDeterministicMeshBlockerError(story.point.error);
  const continueEligible =
    story != null &&
    story.point.continuable &&
    story.point.continuationResultAttemptId != null;
  const requeueRejectedEligible =
    story != null &&
    !continueEligible &&
    story.point.status === "done" &&
    story.point.classification?.state === "rejected" &&
    story.point.reviewBucket === "needs_review";
  const correctionEligible =
    story != null &&
    story.point.resultAttemptId != null &&
    story.point.correctionSetup != null &&
    story.point.workDisposition !== "scheduled" &&
    (story.point.status === "failed" ||
      story.point.classification?.state === "rejected");

  return {
    retryEligible,
    continueEligible,
    requeueRejectedEligible,
    requeueEligible: retryEligible || requeueRejectedEligible,
    correctionEligible,
  };
}
