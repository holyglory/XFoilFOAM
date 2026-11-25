-- The worker owns its local catalog row. The existing immutable hub manifest
-- identifies the scientific generation retained alongside it on the worker volume.
ALTER TABLE progressive_worker_hub_report_links ADD COLUMN shared_result_object jsonb;
--> statement-breakpoint
ALTER TABLE progressive_worker_hub_report_links DROP CONSTRAINT progressive_worker_hub_report_links_check1,
  ADD CONSTRAINT progressive_worker_hub_report_link_read_identity CHECK (coalesce(jsonb_typeof(read_identity)='object'
    AND read_identity ?& ARRAY['sourceKind','executionId','memberKind','sequence','signature','archiveFormat',
      'objectKey','bucket','generation','storedSha256','storedByteSize','crc32c','compression','mimeType',
      'reportSha256','reportByteSize','memberCount','firstSequence','lastSequence']
    AND read_identity->>'sourceKind'='worker' AND read_identity->>'memberKind'='report'
    AND read_identity->>'executionId'=sim_job_id::text
    AND (read_identity->>'sequence')::bigint=sequence
    AND read_identity->>'signature' ~ '^[a-f0-9]{64}$' AND read_identity->>'reportSha256' ~ '^[a-f0-9]{64}$'
    AND read_identity->>'storedSha256' ~ '^[a-f0-9]{64}$' AND read_identity->>'generation' ~ '^[1-9][0-9]{0,19}$'
    AND read_identity->>'crc32c' ~ '^[A-Za-z0-9+/]{6}==$' AND read_identity->>'mimeType'='application/gzip'
    AND read_identity->>'compression'='gzip' AND (read_identity->>'storedByteSize')::bigint BETWEEN 1 AND 33554432
    AND (read_identity->>'reportByteSize')::bigint BETWEEN 1 AND 33554432
    AND (read_identity->>'memberCount')::int BETWEEN 1 AND 128
    AND sequence BETWEEN (read_identity->>'firstSequence')::bigint AND (read_identity->>'lastSequence')::bigint
    AND ((read_identity->>'archiveFormat'='jsonl' AND shared_result_object IS NULL
        AND right(read_identity->>'objectKey',length('/remote/'||sim_job_id::text||'/'||(read_identity->>'storedSha256')||'.jsonl.gz'))
        ='/remote/'||sim_job_id::text||'/'||(read_identity->>'storedSha256')||'.jsonl.gz')
      OR (read_identity->>'archiveFormat'='shared-result-v1' AND jsonb_typeof(shared_result_object)='object'
        AND right(read_identity->>'objectKey',length('/shared-result-v1/remote/'||sim_job_id::text||'/'||(read_identity->>'storedSha256')||'.json.gz'))
        ='/shared-result-v1/remote/'||sim_job_id::text||'/'||(read_identity->>'storedSha256')||'.json.gz'
        AND shared_result_object->>'hash' ~ '^[a-f0-9]{64}$'
        AND (shared_result_object->>'rawSize')::bigint BETWEEN 1 AND (read_identity->>'reportByteSize')::bigint
        AND shared_result_object#>>'{pin,sha256}' ~ '^[a-f0-9]{64}$'
        AND shared_result_object#>>'{pin,generation}' ~ '^[1-9][0-9]{0,19}$'
        AND shared_result_object#>>'{pin,crc32c}' ~ '^[A-Za-z0-9+/]{6}==$'
        AND (shared_result_object#>>'{pin,size}')::bigint BETWEEN 1 AND 33619968
        AND shared_result_object#>>'{pin,key}' =
          left(read_identity->>'objectKey',-length('/remote/'||sim_job_id::text||'/'||(read_identity->>'storedSha256')||'.json.gz'))
          ||'/results/'||left(shared_result_object->>'hash',2)||'/'||(shared_result_object->>'hash')||'.json.gz'
      )),false));
--> statement-breakpoint
CREATE INDEX progressive_worker_hub_shared_volume_files_idx
  ON progressive_worker_hub_report_links USING gin ((ARRAY[read_identity->>'storedSha256',shared_result_object#>>'{pin,sha256}']))
  WHERE shared_result_object IS NOT NULL;
--> statement-breakpoint
ALTER TABLE progressive_report_archive_bundles DROP CONSTRAINT progressive_report_archive_bundles_legacy_check,
  ADD CONSTRAINT progressive_report_archive_bundles_legacy_check CHECK (
    ((archive_format='jsonl' OR (archive_format='worker-result-ref-v1' AND source_kind='worker' AND mime_type='application/gzip'
      AND member_count BETWEEN 1 AND 8 AND right(object_key,length('/worker/'||sim_job_id::text||'/'||stored_sha256||'.jsonl.gz'))
        ='/worker/'||sim_job_id::text||'/'||stored_sha256||'.jsonl.gz') OR (archive_format='shared-result-v1' AND mime_type='application/gzip'
      AND (source_kind='remote' OR (source_kind='worker' AND member_count BETWEEN 1 AND 128
        AND right(object_key,length('/shared-result-v1/remote/'||sim_job_id::text||'/'||stored_sha256||'.json.gz'))
          ='/shared-result-v1/remote/'||sim_job_id::text||'/'||stored_sha256||'.json.gz'))))
      AND legacy_instance_id IS NULL AND legacy_solver_id IS NULL
      AND legacy_scope_sha256 IS NULL AND legacy_page_member_count IS NULL
      AND legacy_read_mode IS NULL AND legacy_local_storage_key IS NULL AND legacy_local_verified_at IS NULL)
    OR (archive_format='legacy-jsonl' AND source_kind='worker' AND mime_type='application/gzip'
      AND legacy_instance_id IS NOT NULL AND legacy_solver_id IS NOT NULL
      AND legacy_scope_sha256 IS NOT NULL AND legacy_scope_sha256 ~ '^[a-f0-9]{64}$'
      AND legacy_page_member_count IS NOT NULL AND legacy_page_member_count BETWEEN member_count AND 128
      AND object_key='legacy-worker-reports/v1/'||legacy_instance_id::text||'/'||legacy_solver_id::text
        ||'/'||legacy_scope_sha256||'/'||stored_sha256||'.jsonl.gz'
      AND legacy_read_mode IS NOT NULL AND (
        (legacy_read_mode='registered-get' AND legacy_local_storage_key IS NULL AND legacy_local_verified_at IS NULL)
        OR (legacy_read_mode='hub-local-reader' AND legacy_local_storage_key IS NOT NULL
          AND legacy_local_storage_key<>'' AND legacy_local_verified_at IS NOT NULL)))
  );
--> statement-breakpoint
CREATE FUNCTION require_registered_shared_hub_report_bundle() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM public.progressive_worker_hub_report_links l
    WHERE l.sim_job_id=NEW.sim_job_id AND l.sequence BETWEEN NEW.first_sequence AND NEW.last_sequence
      AND l.hub_source_kind='remote' AND l.hub_bundle_id<>NEW.id AND l.shared_result_object IS NOT NULL
      AND l.read_identity->>'archiveFormat'=NEW.archive_format AND l.read_identity->>'bucket'=NEW.bucket
      AND l.read_identity->>'objectKey'=NEW.object_key AND l.read_identity->>'generation'=NEW.generation
      AND l.read_identity->>'storedSha256'=NEW.stored_sha256 AND (l.read_identity->>'storedByteSize')::bigint=NEW.stored_byte_size
      AND l.read_identity->>'crc32c'=NEW.crc32c AND (l.read_identity->>'memberCount')::int=NEW.member_count
      AND (l.read_identity->>'firstSequence')::bigint=NEW.first_sequence AND (l.read_identity->>'lastSequence')::bigint=NEW.last_sequence
  ) THEN RAISE EXCEPTION 'Worker shared report bundle lacks its exact staged hub original'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER registered_shared_hub_report_bundle BEFORE INSERT ON progressive_report_archive_bundles
FOR EACH ROW WHEN (NEW.source_kind='worker' AND NEW.archive_format='shared-result-v1')
EXECUTE FUNCTION require_registered_shared_hub_report_bundle();
