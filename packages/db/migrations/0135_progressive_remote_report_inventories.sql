CREATE TABLE progressive_remote_report_inventories (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  report_content_signature text NOT NULL CHECK (report_content_signature ~ '^[a-f0-9]{64}$'),
  inventory_signature text NOT NULL CHECK (inventory_signature ~ '^[a-f0-9]{64}$'),
  source_count integer NOT NULL CHECK (source_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id, sequence),
  FOREIGN KEY (sim_job_id, sequence) REFERENCES progressive_remote_reports(sim_job_id, sequence) ON DELETE CASCADE
);
CREATE TRIGGER progressive_remote_report_inventories_immutable BEFORE UPDATE ON progressive_remote_report_inventories
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();

CREATE TABLE progressive_remote_report_sources (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  point_content_signature text NOT NULL CHECK (point_content_signature ~ '^[a-f0-9]{64}$'),
  aoa_deg double precision NOT NULL CHECK (aoa_deg > '-Infinity'::double precision AND aoa_deg < 'Infinity'::double precision),
  case_slug text,
  PRIMARY KEY (sim_job_id, sequence, point_content_signature),
  FOREIGN KEY (sim_job_id, sequence) REFERENCES progressive_remote_report_inventories(sim_job_id, sequence) ON DELETE CASCADE
);
CREATE INDEX progressive_remote_report_sources_point_idx ON progressive_remote_report_sources(sim_job_id, point_content_signature);
CREATE TRIGGER progressive_remote_report_sources_immutable BEFORE UPDATE ON progressive_remote_report_sources
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
