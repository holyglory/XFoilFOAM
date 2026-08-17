import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const migration = readFileSync(
  resolve(
    here,
    "../migrations/0122_solver_evidence_artifacts_sim_job_index.sql",
  ),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(here, "../migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };
const schema = readFileSync(resolve(here, "../src/schema.ts"), "utf8");
const reset = readFileSync(
  resolve(here, "../../../scripts/ops/reset-solver-domain.sql"),
  "utf8",
);

describe("0122 solver-evidence sim-job index migration", () => {
  it("indexes the referencing side of the artifact job foreign key", () => {
    expect(migration).toContain(
      'CREATE INDEX IF NOT EXISTS "solver_evidence_artifacts_sim_job_idx"',
    );
    expect(migration).toContain(
      'ON "solver_evidence_artifacts" ("sim_job_id")',
    );
    expect(schema).toContain(
      'simJobIdx: index("solver_evidence_artifacts_sim_job_idx").on(t.simJobId)',
    );
  });

  it("keeps the destructive reset guarded against per-job full-table scans", () => {
    expect(reset).toContain(
      "CREATE INDEX IF NOT EXISTS solver_evidence_artifacts_sim_job_idx",
    );
    expect(reset.indexOf("solver_evidence_artifacts_sim_job_idx")).toBeLessThan(
      reset.indexOf("DELETE FROM sim_jobs"),
    );
  });

  it("is registered as the next migration", () => {
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 122,
      tag: "0122_solver_evidence_artifacts_sim_job_index",
    });
  });
});
