import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL(".", import.meta.url));
const reset = readFileSync(
  resolve(here, "../../../scripts/ops/reset-solver-domain.sql"),
  "utf8",
);

describe("fresh solver-domain reset contract", () => {
  it("clears every old aerodynamic result and its execution/evidence graph", () => {
    for (const statement of [
      "DELETE FROM solver_evidence_archives;",
      "DELETE FROM solver_evidence_artifacts;",
      "DELETE FROM solver_evidence_blobs;",
      "DELETE FROM results;",
      "DELETE FROM result_attempts;",
      "DELETE FROM sim_jobs;",
    ]) {
      expect(reset).toContain(statement);
    }
  });

  it("returns current campaign points to the ordinary unowned queue", () => {
    expect(reset).toContain("state = 'requested'");
    expect(reset).toContain("result_id = NULL");
    expect(reset).toContain("result_attempt_id = NULL");
    expect(reset).toContain("WHERE state <> 'released'");
    expect(reset).toContain(
      "state <> 'requested' OR result_id IS NOT NULL OR result_attempt_id IS NOT NULL",
    );
  });

  it("does not delete catalog, setup, campaign definitions, or canaries", () => {
    for (const protectedTable of [
      "airfoils",
      "airfoil_coordinates",
      "simulation_presets",
      "sim_campaigns",
      "solver_engine_canary_attestations",
      "solver_operational_canary_evidence_objects",
    ]) {
      expect(reset).not.toMatch(
        new RegExp(
          `(?:DELETE\\s+FROM|TRUNCATE\\s+(?:TABLE\\s+)?)${protectedTable}\\b`,
          "i",
        ),
      );
    }
  });

  it("commits only with the explicit destructive-operation flag", () => {
    expect(reset).toContain("\\if :commit_reset");
    expect(reset).toContain("COMMIT;");
    expect(reset).toContain("\\else\nROLLBACK;");
  });
});
