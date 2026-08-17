import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { archiveResultAttemptFrom } from "../src/polar-cache";
import {
  historicalArchiveAuditDecisions,
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

  it("renders physical result_attempts tables inside raw archive joins", () => {
    const dialect = new PgDialect();
    for (const aliasName of [
      "current_archive_selected_attempt",
      "pending_archive_reduction_attempt",
    ] as const) {
      const query = dialect.sqlToQuery(
        archiveResultAttemptFrom(aliasName),
      ).sql;
      expect(query).toBe(`"result_attempts" ${aliasName}`);
    }
  });

  it("keeps historical archive audits append-only receipts, not scheduler handoffs", () => {
    expect(historicalArchiveAuditDecisions.auditRunId.name).toBe("audit_run_id");
    expect(historicalArchiveAuditDecisions.advisoryContinuationAction.name).toBe(
      "advisory_continuation_action",
    );
    expect(historicalArchiveAuditDecisions.advisoryTailPeriods.name).toBe(
      "advisory_tail_periods",
    );
    expect(
      resultInterpretationBackfillItems.historicalAuditDecisionId.name,
    ).toBe("historical_audit_decision_id");
    expect(
      resultInterpretationBackfillItems.historicalAuditReducerState.name,
    ).toBe("historical_audit_reducer_state");
    expect(
      resultInterpretationBackfillItems.historicalAuditInputEvidenceSignature.name,
    ).toBe("historical_audit_input_evidence_signature");

    const decision = historicalArchiveAuditDecisions as unknown as Record<
      string,
      unknown
    >;
    expect(decision).not.toHaveProperty("targetUransRequestId");
    expect(decision).not.toHaveProperty("targetVerifyQueueId");
  });
});
