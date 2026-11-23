-- Physical custody of a signed raw bundle is independent of scientific delivery.
CREATE TABLE progressive_historical_raw_archives (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  point_content_signature text NOT NULL,
  report_signature text NOT NULL CHECK (report_signature ~ '^[a-f0-9]{64}$'),
  solver_id uuid NOT NULL REFERENCES registered_remote_solvers(id),
  source_instance_id text NOT NULL,
  promise_id uuid NOT NULL REFERENCES sync_sweep_promises(id),
  assignment_signature text NOT NULL CHECK (assignment_signature ~ '^[a-f0-9]{64}$'),
  stop_signature text NOT NULL CHECK (stop_signature ~ '^[a-f0-9]{64}$'),
  stored_sha256 text NOT NULL CHECK (stored_sha256 ~ '^[a-f0-9]{64}$'),
  stored_bytes bigint NOT NULL CHECK (stored_bytes > 0),
  tar_sha256 text NOT NULL CHECK (tar_sha256 ~ '^[a-f0-9]{64}$'),
  tar_bytes bigint NOT NULL CHECK (tar_bytes > 0),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_bytes integer NOT NULL CHECK (manifest_bytes > 0),
  manifest_set_sha256 text NOT NULL CHECK (manifest_set_sha256 ~ '^[a-f0-9]{64}$'),
  bundled_file_count integer NOT NULL CHECK (bundled_file_count > 0),
  zstd_level integer NOT NULL CHECK (zstd_level BETWEEN 1 AND 22),
  bucket text NOT NULL CHECK (bucket <> ''),
  object_key text NOT NULL CHECK (object_key='solver-evidence/v1/sha256/'||left(stored_sha256,2)||'/'||stored_sha256||'.tar.zst'),
  generation text NOT NULL CHECK (generation ~ '^[1-9][0-9]{0,19}$' AND generation::numeric <= 18446744073709551615),
  crc32c text NOT NULL CHECK (crc32c ~ '^[A-Za-z0-9+/]{6}==$'),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id,point_content_signature),
  FOREIGN KEY (sim_job_id,sequence,point_content_signature)
    REFERENCES progressive_remote_report_sources(sim_job_id,sequence,point_content_signature)
);
--> statement-breakpoint
CREATE TRIGGER historical_raw_archive_immutable BEFORE UPDATE OR DELETE ON progressive_historical_raw_archives
FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
