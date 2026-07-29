import { describe, expect, it } from "vitest";

import {
  legacyUransArchiveGapRecoveryActions,
  resultArchiveReductionQueue,
  resultInterpretationBackfillItems,
  resultInterpretationBackfillRuns,
  resultInterpretationRecoveryActions,
} from "../src/schema";

describe("result interpretation scheduler schema", () => {
  it("uses the physical column names created by the clean-cycle migrations", () => {
    // Keep this structural guard independent of a live development database:
    // the scheduler must never start against the valid 0098 migration and
    // emit quoted TypeScript property names instead of its snake_case lease
    // fields.
    expect(resultArchiveReductionQueue.claimExpiresAt.name).toBe(
      "claim_expires_at",
    );
    expect(resultArchiveReductionQueue.nextAttemptAt.name).toBe(
      "next_attempt_at",
    );
    expect(resultInterpretationBackfillRuns.startedAt.name).toBe("started_at");
    expect(resultInterpretationBackfillRuns.completedAt.name).toBe(
      "completed_at",
    );

    for (const queue of [
      resultInterpretationBackfillItems,
      resultArchiveReductionQueue,
      resultInterpretationRecoveryActions,
      legacyUransArchiveGapRecoveryActions,
    ]) {
      expect(queue.claimExpiresAt.name).toBe("claim_expires_at");
      expect(queue.nextAttemptAt.name).toBe("next_attempt_at");
    }
  });
});
