-- PostgreSQL does not create an index for the referencing side of a foreign
-- key.  Job deletion otherwise scans the full artifact relation once per job.
CREATE INDEX IF NOT EXISTS "solver_evidence_artifacts_sim_job_idx"
  ON "solver_evidence_artifacts" ("sim_job_id");
