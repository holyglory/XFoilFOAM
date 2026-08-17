import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  resolve(here, "../migrations/0120_urans_period_roundoff_reconciliation.sql"),
  "utf8",
);

describe("0120 URANS period-roundoff reconciliation contract", () => {
  it("pins the exact v12/FAST/certified/archive-backed roundoff-only source", () => {
    expect(migration).toContain("urans-recovery-2026-08-02-v12");
    expect(migration).toContain("fidelity-ladder-v7");
    expect(migration).toContain("ARRAY['insufficient-periods']::text[]");
    expect(migration).toContain("'clean-cycle-v3'");
    expect(migration).toContain("'urans_precalc'");
    // At threshold 3, one true binary64 ULP is EPSILON * 2^floor(log2(3))
    // = EPSILON * 2. The migration admits exactly the same four-ULP fence.
    expect(migration).toContain("4.0 * 2.0 * 2.220446049250313e-16");
    expect(migration).toContain('blob."verifiedAt" IS NOT NULL');
    expect(migration).toContain("'result-interpretation-v2'");
    expect(migration).toContain("'clean-cycle-v5'");
    expect(migration).toContain("'clean-cycle-v6'");
    expect(migration).toContain('"periodBoundaryUlps":4');
    expect(migration).toContain(
      "782075da76b45b55e7ec98c6bb653a4c52cc3fc9931d3dc0cf1d8a18adc3e92d",
    );
  });

  it("preserves v5 history, creates a v6 reduction receipt, and resolves only its false incident without publishing or rewriting evidence", () => {
    expect(migration).toContain('INSERT INTO "result_reducer_versions"');
    expect(migration).toContain('INSERT INTO "result_archive_reduction_queue"');
    expect(migration).toContain("'pending'");
    expect(migration).toContain(
      'ON CONFLICT (\n    "result_attempt_id", "source_archive_id", "reducer_version_id"\n  ) DO NOTHING',
    );
    expect(migration).toContain('UPDATE "sim_solver_incidents" incident');
    expect(migration).toContain("\"status\" = 'resolved'");
    expect(migration).not.toMatch(/UPDATE\s+"result_archive_reduction_queue"/i);
    expect(migration).not.toMatch(
      /UPDATE\s+"?(result_attempts|results|result_classifications|sim_precalc_obligations)"?/i,
    );
    expect(migration).not.toMatch(
      /INSERT\s+INTO\s+"?(result_interpretations|result_canonical_selections)"?/i,
    );
  });

  it("MUST-CATCH: replaying 0120 resolves only an exact runnable or reduced-accepted v6 receipt without inserting a duplicate", () => {
    expect(migration).toContain("usable_v6_receipts AS MATERIALIZED");
    expect(migration).toContain('receipt."result_id" = eligible.result_id');
    expect(migration).toContain(
      'receipt."result_attempt_id" = eligible.result_attempt_id',
    );
    expect(migration).toContain(
      'receipt."source_archive_id" = eligible.source_archive_id',
    );
    expect(migration).toContain(
      'receipt."reducer_version_id" = eligible.target_reducer_version_id',
    );
    expect(migration).toContain(
      `WHERE receipt."state" IN ('pending', 'hydrating')
    OR (
      receipt."state" = 'reduced'
      AND accepted_interpretation."id" IS NOT NULL
    )`,
    );
    expect(migration).toContain(
      `accepted_interpretation."source" = 'archive_backfill'
    AND accepted_interpretation."state" = 'accepted'`,
    );
    expect(migration).toContain(
      'AND interpretation."reducer_version_id"\n          <> target_reducer."id"',
    );
    expect(migration).toContain("FROM usable_v6_receipts receipt");
    // There is no terminal/failed-state fallback: conflict replays retain
    // those receipts as immutable history and leave the incident open.
    expect(migration).not.toMatch(
      /receipt\."state"\s+IN\s*\([^)]*'failed'[^)]*\)/i,
    );
    expect(migration).not.toMatch(
      /receipt\."state"\s+IN\s*\([^)]*'terminal_failure'[^)]*\)/i,
    );
  });
});
