import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  resultInterpretationBackfillItems,
  resultInterpretationBackfillRuns,
} from "../src/schema";

const here = dirname(fileURLToPath(import.meta.url));

describe("result interpretation backfill schema contract", () => {
  it("maps lifecycle timestamps to migration 0096 snake-case columns", () => {
    const columns = getTableColumns(resultInterpretationBackfillRuns);

    expect(columns.startedAt.name).toBe("started_at");
    expect(columns.completedAt.name).toBe("completed_at");

    const itemColumns = getTableColumns(resultInterpretationBackfillItems);
    expect(itemColumns.claimExpiresAt.name).toBe("claim_expires_at");
    expect(itemColumns.nextAttemptAt.name).toBe("next_attempt_at");
  });

  it("MUST-CATCH: migration 0099 gives cancelled preservation work a distinct terminal receipt", () => {
    const migration = readFileSync(
      resolve(here, "../migrations/0099_archive_backfill_abandonment.sql"),
      "utf8",
    );
    expect(migration).toContain(
      'DROP CONSTRAINT "result_interpretation_backfill_items_state_check"',
    );
    expect(migration).toMatch(/'failed',\s*'abandoned'/);
  });
});
