-- Native HZ report and independent hub catalog record have distinct owners.
-- Stage exact origin metadata before exercising both deployed volume readers.
-- An uncommitted or interrupted stage leaves the native report fully usable.
CREATE TABLE progressive_worker_hub_report_links (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  worker_instance uuid NOT NULL,
  hub_instance uuid NOT NULL CHECK (hub_instance <> worker_instance),
  hub_bundle_id uuid NOT NULL,
  hub_source_kind text NOT NULL DEFAULT 'remote' CHECK (hub_source_kind='remote'),
  registered_solver_id uuid NOT NULL,
  promise_id uuid NOT NULL,
  assignment_signature text NOT NULL CHECK (assignment_signature ~ '^[a-f0-9]{64}$'),
  upstream_base_url text NOT NULL,
  inventory_signature text NOT NULL CHECK (inventory_signature ~ '^[a-f0-9]{64}$'),
  point_anchors jsonb NOT NULL CHECK (jsonb_typeof(point_anchors)='array'
    AND jsonb_array_length(point_anchors) BETWEEN 1 AND 512),
  -- This is the local read identity. The physical JSONL members and GCS
  -- metadata explicitly retain source_kind=remote from the hub catalog.
  read_identity jsonb NOT NULL CHECK (coalesce(jsonb_typeof(read_identity)='object'
    AND read_identity ?& ARRAY['sourceKind','executionId','memberKind','sequence','signature','archiveFormat',
      'objectKey','bucket','generation','storedSha256','storedByteSize','crc32c','compression','mimeType',
      'reportSha256','reportByteSize','memberCount','firstSequence','lastSequence']
    AND read_identity->>'sourceKind'='worker' AND read_identity->>'memberKind'='report'
    AND read_identity->>'archiveFormat'='jsonl' AND read_identity->>'executionId'=sim_job_id::text
    AND (read_identity->>'sequence')::bigint=sequence
    AND read_identity->>'signature' ~ '^[a-f0-9]{64}$' AND read_identity->>'reportSha256' ~ '^[a-f0-9]{64}$'
    AND read_identity->>'storedSha256' ~ '^[a-f0-9]{64}$' AND read_identity->>'generation' ~ '^[1-9][0-9]{0,19}$'
    AND read_identity->>'crc32c' ~ '^[A-Za-z0-9+/]{6}==$' AND read_identity->>'mimeType'='application/gzip'
    AND read_identity->>'compression'='gzip' AND (read_identity->>'storedByteSize')::bigint BETWEEN 1 AND 33554432
    AND (read_identity->>'reportByteSize')::bigint BETWEEN 1 AND 33554432
    AND (read_identity->>'memberCount')::int BETWEEN 1 AND 128
    AND sequence BETWEEN (read_identity->>'firstSequence')::bigint AND (read_identity->>'lastSequence')::bigint
    AND right(read_identity->>'objectKey',length('/remote/'||sim_job_id::text||'/'||(read_identity->>'storedSha256')||'.jsonl.gz'))
      ='/remote/'||sim_job_id::text||'/'||(read_identity->>'storedSha256')||'.jsonl.gz',false)),
  hub_read_at timestamptz NOT NULL,
  volume_verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (sim_job_id,sequence),
  FOREIGN KEY (sim_job_id,sequence) REFERENCES progressive_worker_reports(sim_job_id,sequence) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TRIGGER progressive_worker_hub_report_links_immutable BEFORE UPDATE OR DELETE
  ON progressive_worker_hub_report_links FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
