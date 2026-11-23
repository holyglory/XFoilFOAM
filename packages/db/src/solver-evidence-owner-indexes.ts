import type { Sql } from "./client";
import { prepareNonNullIndexes } from "./online-partial-indexes";

export function prepareSolverEvidenceOwnerIndexes(sql: Sql) {
  return prepareNonNullIndexes(sql, 222, [
    {
      table: "solver_evidence_artifacts",
      column: "sim_job_id",
      name: "solver_evidence_artifacts_sim_job_idx",
    },
    {
      table: "solver_evidence_artifacts",
      column: "engine_job_id",
      name: "solver_evidence_artifacts_engine_job_idx",
    },
  ]);
}
