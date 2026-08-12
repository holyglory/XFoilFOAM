import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  resultInterpretationBackfillItems,
  resultInterpretationBackfillRuns,
} from "../src/schema";

describe("result interpretation backfill schema contract", () => {
  it("maps lifecycle timestamps to migration 0096 snake-case columns", () => {
    const columns = getTableColumns(resultInterpretationBackfillRuns);

    expect(columns.startedAt.name).toBe("started_at");
    expect(columns.completedAt.name).toBe("completed_at");

    const itemColumns = getTableColumns(resultInterpretationBackfillItems);
    expect(itemColumns.claimExpiresAt.name).toBe("claim_expires_at");
    expect(itemColumns.nextAttemptAt.name).toBe("next_attempt_at");
  });
});
