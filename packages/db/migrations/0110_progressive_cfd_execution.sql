CREATE TABLE progressive_cfd_execution_recipes (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  source_revision_id uuid NOT NULL REFERENCES simulation_preset_revisions(id) ON DELETE CASCADE,
  recipe jsonb NOT NULL CHECK (jsonb_typeof(recipe) = 'object'),
  execution_revision_id uuid NOT NULL REFERENCES simulation_preset_revisions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER progressive_cfd_execution_recipes_immutable BEFORE UPDATE ON progressive_cfd_execution_recipes
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
ALTER TABLE progressive_cfd_attempts ADD COLUMN execution_recipe_id text REFERENCES progressive_cfd_execution_recipes(id);
ALTER TABLE progressive_cfd_attempts ADD COLUMN sim_job_id uuid REFERENCES sim_jobs(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX progressive_cfd_attempts_job_unit_uq ON progressive_cfd_attempts (sim_job_id, unit_id) WHERE sim_job_id IS NOT NULL;
