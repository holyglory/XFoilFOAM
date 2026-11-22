-- Install with shortening disabled. Deploy contract-v1 readers and verified
-- scientific consumers before enabling the bounded settlement writer.
-- 0206's numeric normalization uses exact PostgreSQL numeric values and
-- preserves JSONB equality across equivalent decimal display scales.
CREATE FUNCTION attempt_evidence_normalized_value(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT result_history_normalized(value)
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_semantic_sha256(value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT encode(sha256(convert_to(attempt_evidence_normalized_value(value)::text,'UTF8')),'hex')
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_history_paths() RETURNS TABLE(ordinal integer,path text[])
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  VALUES
    (1,ARRAY['force_history','t']),(2,ARRAY['force_history','cl']),
    (3,ARRAY['force_history','cd']),(4,ARRAY['force_history','cm']),
    (5,ARRAY['forceHistory','t']),(6,ARRAY['forceHistory','cl']),
    (7,ARRAY['forceHistory','cd']),(8,ARRAY['forceHistory','cm']),
    (9,ARRAY['steady_history','iterations']),(10,ARRAY['steady_history','cl']),
    (11,ARRAY['steady_history','cd']),(12,ARRAY['steady_history','cm']),
    (13,ARRAY['steadyHistory','iterations']),(14,ARRAY['steadyHistory','cl']),
    (15,ARRAY['steadyHistory','cd']),(16,ARRAY['steadyHistory','cm']),
    (17,ARRAY['frame_track','frames']),(18,ARRAY['frameTrack','frames'])
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_source_facts(payload jsonb,path text[],with_hashes boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE value jsonb; result jsonb;
BEGIN
  value := payload #> path;
  result := jsonb_build_object('path',path,'present',value IS NOT NULL,'jsonType',jsonb_typeof(value),
    'length',CASE WHEN jsonb_typeof(value)='array' THEN jsonb_array_length(value) END);
  IF with_hashes THEN
    result := result || jsonb_build_object('byteSize',octet_length(value::text),
      'sourceSha256',encode(sha256(convert_to(value::text,'UTF8')),'hex'),
      'semanticSha256',attempt_evidence_semantic_sha256(value));
  END IF;
  RETURN result;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_compact(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE result jsonb := payload; item record;
BEGIN
  FOR item IN SELECT * FROM attempt_evidence_history_paths() ORDER BY ordinal LOOP
    IF jsonb_typeof(payload #> item.path)='array' THEN result := result #- item.path; END IF;
  END LOOP;
  RETURN result;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_make_projection(payload jsonb,attempt_id uuid,archive_id uuid) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE compact jsonb := attempt_evidence_compact(payload); normalized jsonb := attempt_evidence_normalized_value(payload);
        facts jsonb; removed jsonb;
BEGIN
  -- Normalize the full tree once. Whole, parent and array identities use
  -- the matching subtree, including decimal values outside double precision.
  SELECT jsonb_object_agg(array_to_json(path)::text,attempt_evidence_source_facts(payload,path,false) ||
    jsonb_build_object('byteSize',octet_length((payload#>path)::text),
      'sourceSha256',encode(sha256(convert_to((payload#>path)::text,'UTF8')),'hex'),
      'semanticSha256',encode(sha256(convert_to((normalized#>path)::text,'UTF8')),'hex'))) INTO facts FROM (
    SELECT 0 AS ordinal,ARRAY[]::text[] AS path
    UNION ALL SELECT 100+min(ordinal),ARRAY[path[1]] FROM attempt_evidence_history_paths() GROUP BY path[1]
    UNION ALL SELECT 200+ordinal,path FROM attempt_evidence_history_paths()
  ) paths;
  SELECT coalesce(jsonb_agg(path ORDER BY ordinal),'[]'::jsonb) INTO removed
    FROM attempt_evidence_history_paths() WHERE jsonb_typeof(payload #> path)='array';
  RETURN jsonb_build_object('version',1,'attemptId',attempt_id,'archiveId',archive_id,
    'sourceSha256',facts->'[]'->>'sourceSha256',
    'sourceByteSize',(facts->'[]'->>'byteSize')::integer,'sourceSemanticSha256',facts->'[]'->>'semanticSha256',
    'compactSha256',encode(sha256(convert_to(compact::text,'UTF8')),'hex'),
    'compactSemanticSha256',encode(sha256(convert_to(attempt_evidence_compact(normalized)::text,'UTF8')),'hex'),
    'removedPaths',removed,'removedLogicalBytes',octet_length(payload::text)-octet_length(compact::text),'values',facts);
END;
$$;
--> statement-breakpoint
CREATE TABLE attempt_evidence_storage_policy (
  id integer PRIMARY KEY CHECK(id=1),
  shortening_enabled boolean NOT NULL DEFAULT false,
  canary_attempt_id uuid,
  consumer_contract_version integer NOT NULL DEFAULT 0 CHECK(consumer_contract_version IN (0,1)),
  min_logical_bytes integer NOT NULL DEFAULT 4096 CHECK(min_logical_bytes>=4096),
  min_net_value_bytes integer NOT NULL DEFAULT 1024 CHECK(min_net_value_bytes>=1),
  max_source_bytes integer NOT NULL DEFAULT 262144 CHECK(max_source_bytes BETWEEN 4096 AND 33554432),
  initial_subset text NOT NULL DEFAULT 'unreferenced-rans-steady-v1' CHECK(initial_subset='unreferenced-rans-steady-v1'),
  CHECK(NOT shortening_enabled OR consumer_contract_version=1),
  CHECK(shortening_enabled OR canary_attempt_id IS NULL)
);
INSERT INTO attempt_evidence_storage_policy(id) VALUES(1);
--> statement-breakpoint
CREATE TABLE attempt_evidence_history_projections (
  result_attempt_id uuid NOT NULL REFERENCES result_attempts(id) ON DELETE CASCADE,
  archive_id uuid NOT NULL REFERENCES attempt_evidence_archives(id) ON DELETE CASCADE,
  projection jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(projection->>'version'='1'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(result_attempt_id,archive_id)
);
--> statement-breakpoint
CREATE TABLE attempt_evidence_storage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_attempt_id uuid NOT NULL REFERENCES result_attempts(id) ON DELETE CASCADE,
  archive_id uuid NOT NULL REFERENCES attempt_evidence_archives(id) ON DELETE CASCADE,
  action text NOT NULL CHECK(action IN ('shorten','restore')),
  transaction_id text NOT NULL DEFAULT pg_current_xact_id()::text,
  verification jsonb NOT NULL,
  source_stored_bytes bigint NOT NULL CHECK(source_stored_bytes>0),
  result_stored_bytes bigint,
  projection_value_bytes bigint,
  verification_value_bytes bigint,
  net_value_bytes_saved bigint,
  completed boolean NOT NULL DEFAULT false,
  app_readback_at timestamptz CHECK(app_readback_at IS NULL OR (completed AND action='shorten')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(result_attempt_id,id)
);
--> statement-breakpoint
CREATE INDEX attempt_evidence_pending_readback_idx ON attempt_evidence_storage_events(created_at,id)
  WHERE completed AND action='shorten' AND app_readback_at IS NULL;
--> statement-breakpoint
ALTER TABLE result_attempts ADD COLUMN evidence_archive_id uuid,
  ADD COLUMN evidence_storage_event_id uuid,
  ADD CONSTRAINT result_attempt_evidence_projection_fk FOREIGN KEY(id,evidence_archive_id)
    REFERENCES attempt_evidence_history_projections(result_attempt_id,archive_id),
  ADD CONSTRAINT result_attempt_evidence_event_fk FOREIGN KEY(id,evidence_storage_event_id)
    REFERENCES attempt_evidence_storage_events(result_attempt_id,id),
  ADD CONSTRAINT result_attempt_evidence_pointer_shape CHECK(evidence_archive_id IS NULL OR evidence_storage_event_id IS NOT NULL);
--> statement-breakpoint
CREATE INDEX result_attempts_current_storage_event_idx ON result_attempts(evidence_storage_event_id) WHERE evidence_archive_id IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION enforce_attempt_evidence_projection_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_row result_attempts%ROWTYPE; archive attempt_evidence_archives%ROWTYPE; expected jsonb;
BEGIN
  SELECT * INTO source_row FROM result_attempts WHERE id=NEW.result_attempt_id;
  SELECT * INTO archive FROM attempt_evidence_archives WHERE id=NEW.archive_id;
  IF source_row.id IS NULL OR archive.id IS NULL OR source_row.evidence_archive_id IS NOT NULL
    OR archive.result_attempt_id<>source_row.id OR archive.result_id IS DISTINCT FROM source_row.result_id
    OR (source_row.sim_job_id IS NOT NULL AND archive.sim_job_id IS DISTINCT FROM source_row.sim_job_id)
    OR encode(sha256(convert_to(source_row.evidence_payload::text,'UTF8')),'hex') IS DISTINCT FROM archive.source_sha256
    OR octet_length(source_row.evidence_payload::text) IS DISTINCT FROM archive.source_byte_size THEN
    RAISE EXCEPTION 'Attempt history projection requires the exact full SQL source and archive owner';
  END IF;
  -- Derive all facts from the locked complete source, independently of the
  -- read-only preview. Subsequent scientific SQL reads reuse these values.
  expected := attempt_evidence_make_projection(source_row.evidence_payload,source_row.id,archive.id);
  IF NEW.projection<>'{}'::jsonb AND NEW.projection IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Supplied attempt history facts differ from the full SQL source';
  END IF;
  NEW.projection := expected;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attempt_evidence_projection_source BEFORE INSERT ON attempt_evidence_history_projections
  FOR EACH ROW EXECUTE FUNCTION enforce_attempt_evidence_projection_source();
CREATE TRIGGER attempt_evidence_projection_immutable BEFORE UPDATE ON attempt_evidence_history_projections
  FOR EACH ROW EXECUTE FUNCTION reject_attempt_evidence_archive_update();
--> statement-breakpoint
CREATE FUNCTION reject_compact_attempt_archive_copy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM result_attempts WHERE id=NEW.result_attempt_id AND evidence_archive_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A compact attempt cannot be archived as a new full original';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attempt_evidence_archive_full_original BEFORE INSERT ON attempt_evidence_archives
  FOR EACH ROW EXECUTE FUNCTION reject_compact_attempt_archive_copy();
--> statement-breakpoint
-- Query helpers receive joined metadata and selected values, never whole rows.
-- They do not serialize or hash live attempts during classifier/campaign reads.
CREATE FUNCTION attempt_evidence_projected_value(attempt_id uuid,archive_id uuid,projection jsonb,path text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE facts jsonb; removed jsonb;
BEGIN
  IF archive_id IS NULL THEN RETURN NULL; END IF;
  IF projection IS NULL OR projection->>'version' IS DISTINCT FROM '1'
    OR projection->>'attemptId' IS DISTINCT FROM attempt_id::text
    OR projection->>'archiveId' IS DISTINCT FROM archive_id::text THEN
    RAISE EXCEPTION 'Attempt history projection is missing or belongs to another source';
  END IF;
  facts := projection->'values'->(array_to_json(path)::text);
  IF facts IS NOT NULL THEN RETURN facts; END IF;
  FOR removed IN SELECT * FROM jsonb_array_elements(projection->'removedPaths') LOOP
    IF cardinality(path)>jsonb_array_length(removed)
      AND to_jsonb(path[1:jsonb_array_length(removed)])=removed THEN
      RAISE EXCEPTION 'A removed array descendant requires full attempt read-through';
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_array_facts(attempt_id uuid,archive_id uuid,inline_value jsonb,projection jsonb,path text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE facts jsonb;
BEGIN
  facts := attempt_evidence_projected_value(attempt_id,archive_id,projection,path);
  IF facts IS NOT NULL THEN RETURN facts-ARRAY['byteSize','sourceSha256','semanticSha256']; END IF;
  RETURN jsonb_build_object('path',path,'present',inline_value IS NOT NULL,'jsonType',jsonb_typeof(inline_value),
    'length',CASE WHEN jsonb_typeof(inline_value)='array' THEN jsonb_array_length(inline_value) END);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_value_matches(attempt_id uuid,archive_id uuid,inline_value jsonb,projection jsonb,path text[],candidate jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE facts jsonb;
BEGIN
  facts := attempt_evidence_projected_value(attempt_id,archive_id,projection,path);
  IF facts IS NULL THEN RETURN inline_value IS NOT DISTINCT FROM candidate; END IF;
  IF NOT (facts->>'present')::boolean THEN RETURN candidate IS NULL; END IF;
  IF candidate IS NULL THEN RETURN false; END IF;
  -- Recursive numeric normalization is only for this explicit equality candidate.
  RETURN facts->>'semanticSha256'=attempt_evidence_semantic_sha256(candidate);
END;
$$;
CREATE FUNCTION attempt_evidence_value_equals(attempt_id uuid,archive_id uuid,inline_value jsonb,projection jsonb,path text[],candidate jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE facts jsonb;
BEGIN
  facts := attempt_evidence_projected_value(attempt_id,archive_id,projection,path);
  IF facts IS NULL THEN RETURN inline_value=candidate; END IF;
  IF NOT (facts->>'present')::boolean OR candidate IS NULL THEN RETURN NULL; END IF;
  RETURN facts->>'semanticSha256'=attempt_evidence_semantic_sha256(candidate);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE a result_attempts%ROWTYPE; j sim_jobs%ROWTYPE; archive attempt_evidence_archives%ROWTYPE;
        policy attempt_evidence_storage_policy%ROWTYPE; item record; length_ integer; source_bytes integer;
BEGIN
  SELECT * INTO a FROM result_attempts WHERE id=attempt_id;
  IF NOT FOUND THEN RETURN 'missing-attempt'; END IF;
  IF a.evidence_archive_id IS NOT NULL THEN RETURN 'already-shortened'; END IF;
  IF a.status IS NULL OR a.status NOT IN ('done','failed') THEN RETURN 'attempt-not-terminal'; END IF;
  IF a.regime IS DISTINCT FROM 'rans' THEN RETURN 'outside-initial-rans-subset'; END IF;
  IF a.sim_job_id IS NULL THEN RETURN 'missing-settled-job'; END IF;
  SELECT * INTO j FROM sim_jobs WHERE id=a.sim_job_id;
  IF NOT FOUND OR j.status IS NULL OR j.status NOT IN ('done','failed','cancelled') OR j."ingestedAt" IS NULL
    OR (j.ingest_lease_token IS NOT NULL AND (j.ingest_lease_expires_at IS NULL OR j.ingest_lease_expires_at>clock_timestamp())) THEN
    RETURN 'job-not-settled';
  END IF;
  IF a.unsteady IS DISTINCT FROM false OR a.result_id IS NULL OR a.engine_job_id LIKE 'sync:%'
    OR coalesce(a.evidence_payload->>'fidelity','rans') IS DISTINCT FROM 'rans'
    OR (a.evidence_payload->'mesh_recovery_version') IS DISTINCT FROM '1'::jsonb
    OR j.request_payload IS NULL OR a.simulation_preset_revision_id IS NULL OR a.airfoil_id IS NULL
    OR j.engine_state IN ('pending','queued','submitting','submitted','running','meshing','cancelling','cancel_pending')
    OR coalesce(j.request_payload->>'remoteSolver','false')='true'
    OR j.request_payload ? 'progressive' OR j.request_payload ? 'remoteProgressiveExecution'
    OR j.request_payload ? 'syncPromiseId' OR j.request_payload ? 'progressiveExecutionId' OR j.request_payload ? 'campaignId' THEN
    RETURN 'outside-initial-cold-cohort';
  END IF;
  IF EXISTS(SELECT 1 FROM results WHERE current_result_attempt_id=a.id)
    OR EXISTS(SELECT 1 FROM progressive_remote_dispatches d WHERE d.sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM progressive_cfd_attempts d WHERE d.sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM progressive_cfd_evidence d WHERE d.result_attempt_id=a.id)
    OR EXISTS(SELECT 1 FROM progressive_cfd_evidence_reuses d WHERE d.source_result_attempt_id=a.id)
    OR EXISTS(SELECT 1 FROM progressive_cfd_budget_extensions d WHERE d.source_result_attempt_id=a.id)
    OR EXISTS(SELECT 1 FROM progressive_cfd_recovery_plans d WHERE d.diagnostic_attempt_id=a.id)
    OR EXISTS(SELECT 1 FROM progressive_polar_model_evidence d WHERE d.result_attempt_id=a.id)
    OR EXISTS(SELECT 1 FROM progressive_remote_evidence_receipts d WHERE d.result_attempt_id=a.id OR d.sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM progressive_worker_evidence_attempts d WHERE d.result_attempt_id=a.id OR d.sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM sim_campaign_points d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id)
    OR EXISTS(SELECT 1 FROM sim_precalc_obligations d WHERE d.source_result_attempt_id=a.id OR d.source_result_id=a.result_id OR d.latest_sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM sim_precalc_obligation_attempts d WHERE d.result_attempt_id=a.id OR d.sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM sim_urans_verify_queue d WHERE d.precalc_result_attempt_id=a.id OR d.latest_result_attempt_id=a.id OR d.precalc_result_id=a.result_id OR d.verify_result_id=a.result_id OR d.sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM sim_urans_requests d WHERE d.continue_from_result_attempt_id=a.id OR d.continue_from_result_id=a.result_id OR d.sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM sim_rans_polar_promotions d WHERE d.trigger_result_attempt_id=a.id OR d.parent_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM point_correction_runs d WHERE d.source_result_attempt_id=a.id OR d.source_result_id=a.result_id)
    OR EXISTS(SELECT 1 FROM sim_solver_incidents d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id OR d.sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM result_interpretations d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id)
    OR EXISTS(SELECT 1 FROM result_canonical_selections d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id)
    OR EXISTS(SELECT 1 FROM result_interpretation_backfill_items d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id)
    OR EXISTS(SELECT 1 FROM result_interpretation_recovery_actions d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id)
    OR EXISTS(SELECT 1 FROM legacy_urans_archive_gap_recovery_actions d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id)
    OR EXISTS(SELECT 1 FROM result_media_repairs d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id)
    OR EXISTS(SELECT 1 FROM sync_sweep_promise_points d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id)
    OR EXISTS(SELECT 1 FROM sync_remote_result_deliveries d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id OR d.sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM sync_remote_hub_binding_receipts d WHERE d.result_attempt_id=a.id OR d.result_id=a.result_id OR d.sim_job_id=a.sim_job_id)
    OR EXISTS(SELECT 1 FROM sync_brokered_evidence_uploads d WHERE d.canonical_result_attempt_id=a.id OR d.canonical_result_id=a.result_id OR d.engine_job_id=a.engine_job_id) THEN
    RETURN 'referenced-scientific-source';
  END IF;
  IF jsonb_typeof(a.evidence_payload) IS DISTINCT FROM 'object'
    OR jsonb_typeof(a.evidence_payload->'steady_history') IS DISTINCT FROM 'object' THEN RETURN 'unsupported-steady-shape'; END IF;
  length_ := NULL;
  FOR item IN SELECT * FROM attempt_evidence_history_paths() ORDER BY ordinal LOOP
    IF item.path[1]='steady_history' THEN
      IF jsonb_typeof(a.evidence_payload #> item.path) IS DISTINCT FROM 'array' THEN RETURN 'unsupported-steady-shape'; END IF;
      IF length_ IS NULL THEN length_:=jsonb_array_length(a.evidence_payload #> item.path);
      ELSIF length_<>jsonb_array_length(a.evidence_payload #> item.path) THEN RETURN 'unaligned-steady-series'; END IF;
    ELSIF jsonb_typeof(a.evidence_payload #> item.path)='array' THEN RETURN 'outside-steady-only-subset';
    END IF;
  END LOOP;
  SELECT * INTO policy FROM attempt_evidence_storage_policy WHERE id=1;
  source_bytes:=octet_length(a.evidence_payload::text);
  IF source_bytes>policy.max_source_bytes THEN RETURN 'source-byte-limit'; END IF;
  IF source_bytes-octet_length(attempt_evidence_compact(a.evidence_payload)::text)<policy.min_logical_bytes THEN RETURN 'insufficient-logical-bulk'; END IF;
  IF archive_id IS NOT NULL THEN
    SELECT * INTO archive FROM attempt_evidence_archives WHERE id=archive_id;
    IF NOT FOUND OR archive.result_attempt_id<>a.id OR archive.result_id IS DISTINCT FROM a.result_id
      OR archive.sim_job_id IS DISTINCT FROM a.sim_job_id OR archive.source_byte_size<>source_bytes
      OR archive.source_sha256<>encode(sha256(convert_to(a.evidence_payload::text,'UTF8')),'hex') THEN
      RETURN 'archive-source-mismatch';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_verification_valid(p_id uuid,p_archive_id uuid,p_proof jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_archive attempt_evidence_archives%ROWTYPE;
        v_direct jsonb:=p_proof->'direct'; v_app jsonb:=p_proof->'app'; v_deps jsonb:=p_proof->'dependencies';
BEGIN
  IF p_proof IS NULL OR jsonb_typeof(p_proof)<>'object' OR octet_length(p_proof::text)>8192 THEN RETURN false; END IF;
  SELECT a.* INTO v_archive FROM attempt_evidence_archives a WHERE a.id=p_archive_id AND a.result_attempt_id=p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN coalesce(
    v_direct->>'archiveId'=v_archive.id::text AND v_direct->>'attemptId'=p_id::text
    AND v_direct->>'bucket'=v_archive.bucket AND v_direct->>'objectKey'=v_archive.object_key AND v_direct->>'generation'=v_archive.generation
    AND v_direct->>'storedSha256'=v_archive.stored_sha256 AND (v_direct->>'storedByteSize')::bigint=v_archive.stored_byte_size
    AND v_direct->>'crc32c'=v_archive.crc32c AND v_direct->>'sourceSha256'=v_archive.source_sha256
    AND (v_direct->>'sourceByteSize')::bigint=v_archive.source_byte_size
    AND (v_direct->>'verifiedAt')::timestamptz BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()+interval '5 seconds'
    AND v_app->>'attemptId'=p_id::text AND v_app->>'archiveId'=v_archive.id::text
    AND v_app->>'source'='gcs' AND v_app->>'sourceSha256'=v_archive.source_sha256 AND (v_app->>'sourceByteSize')::bigint=v_archive.source_byte_size
    AND v_app->'forceArchive'='true'::jsonb
    AND (v_app->>'verifiedAt')::timestamptz BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()+interval '5 seconds'
    AND v_deps->'contractVersion'='1'::jsonb AND v_deps->>'attemptId'=p_id::text AND v_deps->>'archiveId'=v_archive.id::text
    AND v_deps->>'sourceSha256'=v_archive.source_sha256 AND v_deps->>'verifier'='server-consumers/local-steady-rans-v1'
    AND v_deps->'classificationEquivalent'='true'::jsonb AND v_deps->'equalityEquivalent'='true'::jsonb
    AND v_deps->'scientificEquivalent'='true'::jsonb AND v_deps->'readDependenciesSatisfied'='true'::jsonb,false);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_representation_transition(old_row jsonb,new_row jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_projection jsonb; v_source jsonb; v_compact jsonb;
BEGIN
  IF (old_row-ARRAY['evidence_payload','evidence_archive_id','evidence_storage_event_id'])
    IS DISTINCT FROM (new_row-ARRAY['evidence_payload','evidence_archive_id','evidence_storage_event_id']) THEN RETURN false; END IF;
  IF old_row->>'evidence_archive_id' IS NULL AND new_row->>'evidence_archive_id' IS NOT NULL THEN
    SELECT p.projection INTO v_projection FROM attempt_evidence_history_projections p
      WHERE p.result_attempt_id=(old_row->>'id')::uuid AND p.archive_id=(new_row->>'evidence_archive_id')::uuid;
    v_source:=old_row->'evidence_payload'; v_compact:=new_row->'evidence_payload';
    RETURN coalesce(v_projection->>'sourceSha256'=encode(sha256(convert_to(v_source::text,'UTF8')),'hex')
      AND (v_projection->>'sourceByteSize')::bigint=octet_length(v_source::text)
      AND v_compact=attempt_evidence_compact(v_source)
      AND v_projection->>'compactSha256'=encode(sha256(convert_to(v_compact::text,'UTF8')),'hex'),false);
  ELSIF old_row->>'evidence_archive_id' IS NOT NULL AND new_row->>'evidence_archive_id' IS NULL THEN
    SELECT p.projection INTO v_projection FROM attempt_evidence_history_projections p
      WHERE p.result_attempt_id=(old_row->>'id')::uuid AND p.archive_id=(old_row->>'evidence_archive_id')::uuid;
    RETURN coalesce(v_projection->>'compactSha256'=encode(sha256(convert_to((old_row->'evidence_payload')::text,'UTF8')),'hex')
      AND v_projection->>'sourceSha256'=encode(sha256(convert_to((new_row->'evidence_payload')::text,'UTF8')),'hex')
      AND (v_projection->>'sourceByteSize')::bigint=octet_length((new_row->'evidence_payload')::text),false);
  END IF;
  RETURN false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_lock_source(p_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_job_id uuid; v_result_id uuid;
BEGIN
  SELECT a.sim_job_id,a.result_id INTO v_job_id,v_result_id FROM result_attempts a WHERE a.id=p_id;
  IF v_job_id IS NOT NULL THEN PERFORM 1 FROM sim_jobs j WHERE j.id=v_job_id FOR UPDATE; END IF;
  IF v_result_id IS NOT NULL THEN PERFORM 1 FROM results r WHERE r.id=v_result_id FOR UPDATE; END IF;
  PERFORM 1 FROM result_attempts a WHERE a.id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Attempt storage source was not found'; END IF;
  IF NOT EXISTS(SELECT 1 FROM result_attempts a WHERE a.id=p_id AND a.sim_job_id IS NOT DISTINCT FROM v_job_id
    AND a.result_id IS NOT DISTINCT FROM v_result_id) THEN RAISE EXCEPTION 'Attempt storage owner changed while locking'; END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION enforce_attempt_evidence_storage_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_attempt result_attempts%ROWTYPE; v_policy attempt_evidence_storage_policy%ROWTYPE;
        v_stored bigint; v_projection_bytes bigint; v_verification_bytes bigint; v_limiter text;
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM attempt_evidence_lock_source(NEW.result_attempt_id);
    SELECT a.* INTO v_attempt FROM result_attempts a WHERE a.id=NEW.result_attempt_id;
    SELECT pg_column_size(a.evidence_payload) INTO v_stored FROM result_attempts a WHERE a.id=NEW.result_attempt_id;
    IF NEW.transaction_id IS DISTINCT FROM pg_current_xact_id()::text OR NEW.completed IS DISTINCT FROM false
      OR NEW.source_stored_bytes IS DISTINCT FROM v_stored THEN RAISE EXCEPTION 'Invalid attempt storage event source'; END IF;
    IF NEW.action='shorten' THEN
      SELECT * INTO v_policy FROM attempt_evidence_storage_policy WHERE id=1 FOR SHARE;
      v_limiter:=attempt_evidence_shortening_limiter(NEW.result_attempt_id,NEW.archive_id);
      IF v_policy.shortening_enabled IS DISTINCT FROM true OR v_policy.consumer_contract_version<>1 OR v_limiter IS NOT NULL
        OR (v_policy.canary_attempt_id IS NOT NULL AND v_policy.canary_attempt_id<>NEW.result_attempt_id)
        OR NOT attempt_evidence_verification_valid(NEW.result_attempt_id,NEW.archive_id,NEW.verification) THEN
        RAISE EXCEPTION 'Attempt storage event lacks eligible source and fresh full readback/consumer proofs: %',coalesce(v_limiter,'verification');
      END IF;
    ELSIF v_attempt.evidence_archive_id IS DISTINCT FROM NEW.archive_id THEN
      RAISE EXCEPTION 'Attempt restore source changed';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.completed AND OLD.action='shorten' AND OLD.app_readback_at IS NULL AND NEW.app_readback_at IS NOT NULL
    AND (to_jsonb(NEW.*)-'app_readback_at')=(to_jsonb(OLD.*)-'app_readback_at')
    AND EXISTS(SELECT 1 FROM result_attempts a WHERE a.id=NEW.result_attempt_id AND a.evidence_archive_id=NEW.archive_id
      AND a.evidence_storage_event_id=NEW.id) THEN
    NEW.app_readback_at:=clock_timestamp();
    RETURN NEW;
  END IF;
  IF OLD.completed OR OLD.transaction_id<>pg_current_xact_id()::text OR NEW.completed IS DISTINCT FROM true
    OR (to_jsonb(OLD.*)-ARRAY['completed','result_stored_bytes','projection_value_bytes','verification_value_bytes','net_value_bytes_saved'])
      IS DISTINCT FROM (to_jsonb(NEW.*)-ARRAY['completed','result_stored_bytes','projection_value_bytes','verification_value_bytes','net_value_bytes_saved']) THEN
    RAISE EXCEPTION 'Completed attempt storage receipts are immutable';
  END IF;
  SELECT a.* INTO v_attempt FROM result_attempts a WHERE a.id=NEW.result_attempt_id;
  IF v_attempt.evidence_storage_event_id IS DISTINCT FROM NEW.id OR
    (NEW.action='shorten' AND v_attempt.evidence_archive_id IS DISTINCT FROM NEW.archive_id) OR
    (NEW.action='restore' AND v_attempt.evidence_archive_id IS NOT NULL) THEN RAISE EXCEPTION 'Attempt storage receipt pointer does not match'; END IF;
  -- Measure stored columns in SQL, not detoasted values copied into a PL/pgSQL row.
  SELECT pg_column_size(a.evidence_payload) INTO v_stored FROM result_attempts a WHERE a.id=NEW.result_attempt_id;
  SELECT pg_column_size(p.projection) INTO v_projection_bytes FROM attempt_evidence_history_projections p
    WHERE p.result_attempt_id=NEW.result_attempt_id AND p.archive_id=NEW.archive_id;
  SELECT pg_column_size(e.verification) INTO v_verification_bytes FROM attempt_evidence_storage_events e WHERE e.id=NEW.id;
  IF v_projection_bytes IS NULL OR v_verification_bytes IS NULL THEN RAISE EXCEPTION 'Attempt storage receipt metadata is missing'; END IF;
  NEW.result_stored_bytes:=v_stored; NEW.projection_value_bytes:=v_projection_bytes; NEW.verification_value_bytes:=v_verification_bytes;
  NEW.net_value_bytes_saved:=NEW.source_stored_bytes-v_stored-v_projection_bytes-v_verification_bytes;
  IF NEW.action='shorten' THEN
    SELECT * INTO v_policy FROM attempt_evidence_storage_policy WHERE id=1;
    IF NEW.net_value_bytes_saved<v_policy.min_net_value_bytes THEN
      RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Attempt shortening has insufficient net online value-byte savings';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attempt_evidence_storage_event_guard BEFORE INSERT OR UPDATE ON attempt_evidence_storage_events
  FOR EACH ROW EXECUTE FUNCTION enforce_attempt_evidence_storage_event();
--> statement-breakpoint
CREATE FUNCTION enforce_attempt_evidence_storage_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_event attempt_evidence_storage_events%ROWTYPE; v_path record;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.evidence_archive_id IS NOT NULL OR NEW.evidence_storage_event_id IS NOT NULL THEN RAISE EXCEPTION 'A new attempt must contain its full inline source'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.evidence_payload IS NOT DISTINCT FROM OLD.evidence_payload AND NEW.evidence_archive_id IS NOT DISTINCT FROM OLD.evidence_archive_id
    AND NEW.evidence_storage_event_id IS NOT DISTINCT FROM OLD.evidence_storage_event_id THEN
    IF OLD.evidence_archive_id IS NOT NULL AND NEW.evidence_payload::text IS DISTINCT FROM OLD.evidence_payload::text THEN
      RAISE EXCEPTION 'Archived attempt compact PostgreSQL text is immutable';
    END IF;
    IF OLD.evidence_archive_id IS NOT NULL AND to_jsonb(NEW.*) IS DISTINCT FROM to_jsonb(OLD.*) THEN
      IF (to_jsonb(NEW.*)-'sim_job_id') IS DISTINCT FROM (to_jsonb(OLD.*)-'sim_job_id') OR NEW.sim_job_id IS NOT NULL
        OR EXISTS(SELECT 1 FROM sim_jobs j WHERE j.id=OLD.sim_job_id) THEN
        RAISE EXCEPTION 'Archived attempt scientific metadata is immutable; restore the exact original first';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.evidence_archive_id IS NULL AND NEW.evidence_archive_id IS NULL
    AND NEW.evidence_storage_event_id IS NOT DISTINCT FROM OLD.evidence_storage_event_id THEN
    FOR v_path IN SELECT * FROM attempt_evidence_history_paths() LOOP
      IF jsonb_typeof(OLD.evidence_payload#>v_path.path)='array' AND jsonb_typeof(NEW.evidence_payload#>v_path.path) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Attempt history arrays require exact archive custody before omission';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;
  IF NOT attempt_evidence_representation_transition(to_jsonb(OLD.*),to_jsonb(NEW.*)) THEN
    RAISE EXCEPTION 'Attempt history transition changed scientific values or lacks the exact original';
  END IF;
  SELECT e.* INTO v_event FROM attempt_evidence_storage_events e WHERE e.id=NEW.evidence_storage_event_id
    AND e.transaction_id=pg_current_xact_id()::text AND NOT e.completed;
  IF NOT FOUND OR v_event.result_attempt_id<>OLD.id OR v_event.archive_id IS DISTINCT FROM coalesce(NEW.evidence_archive_id,OLD.evidence_archive_id)
    OR v_event.action IS DISTINCT FROM (CASE WHEN NEW.evidence_archive_id IS NULL THEN 'restore' ELSE 'shorten' END) THEN
    RAISE EXCEPTION 'Attempt history transition requires a fresh transaction-bound storage event';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attempt_evidence_storage_transition BEFORE INSERT OR UPDATE ON result_attempts
  FOR EACH ROW EXECUTE FUNCTION enforce_attempt_evidence_storage_transition();
--> statement-breakpoint
CREATE FUNCTION require_complete_attempt_storage_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM attempt_evidence_storage_events e WHERE e.id=NEW.id AND e.completed) THEN
    RAISE EXCEPTION 'An unfinished attempt storage event cannot commit';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER attempt_evidence_storage_event_complete AFTER INSERT OR UPDATE ON attempt_evidence_storage_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_attempt_storage_event();
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_shorten(p_id uuid,p_archive_id uuid,p_verification jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_attempt result_attempts%ROWTYPE; v_projection jsonb; v_event attempt_evidence_storage_events%ROWTYPE;
        v_policy attempt_evidence_storage_policy%ROWTYPE; v_limiter text; v_stored bigint;
BEGIN
  SELECT * INTO v_policy FROM attempt_evidence_storage_policy WHERE id=1 FOR SHARE;
  IF v_policy.shortening_enabled IS DISTINCT FROM true OR v_policy.consumer_contract_version<>1 THEN RAISE EXCEPTION 'Attempt shortening consumer contract is disabled'; END IF;
  IF v_policy.canary_attempt_id IS NOT NULL AND p_id<>v_policy.canary_attempt_id THEN RAISE EXCEPTION 'Attempt differs from the configured canary'; END IF;
  PERFORM attempt_evidence_lock_source(p_id);
  SELECT a.* INTO v_attempt FROM result_attempts a WHERE a.id=p_id;
  IF v_attempt.evidence_archive_id IS NOT NULL THEN
    IF v_attempt.evidence_archive_id<>p_archive_id THEN RAISE EXCEPTION 'Attempt shortening replay targets a different archive'; END IF;
    SELECT e.* INTO v_event FROM attempt_evidence_storage_events e WHERE e.id=v_attempt.evidence_storage_event_id AND e.completed AND e.action='shorten';
    IF NOT FOUND THEN RAISE EXCEPTION 'Attempt shortening replay receipt is missing'; END IF;
    RETURN jsonb_build_object('eventId',v_event.id,'attemptId',p_id,'archiveId',p_archive_id,'alreadyShortened',true,
      'payloadBytesReclaimed',0,'netValueBytesReclaimed',0);
  END IF;
  v_limiter:=attempt_evidence_shortening_limiter(p_id,p_archive_id);
  IF v_limiter IS NOT NULL THEN RAISE EXCEPTION 'Attempt shortening limited: %',v_limiter; END IF;
  IF NOT attempt_evidence_verification_valid(p_id,p_archive_id,p_verification) THEN RAISE EXCEPTION 'Attempt shortening lacks fresh pinned GCS and usable app proofs'; END IF;
  INSERT INTO attempt_evidence_history_projections(result_attempt_id,archive_id) VALUES(p_id,p_archive_id) ON CONFLICT DO NOTHING;
  SELECT p.projection INTO v_projection FROM attempt_evidence_history_projections p WHERE p.result_attempt_id=p_id AND p.archive_id=p_archive_id;
  IF v_projection->>'sourceSha256' IS DISTINCT FROM encode(sha256(convert_to(v_attempt.evidence_payload::text,'UTF8')),'hex') OR
    (v_projection->>'sourceByteSize')::bigint IS DISTINCT FROM octet_length(v_attempt.evidence_payload::text) THEN
    RAISE EXCEPTION 'Attempt projection source changed before shortening';
  END IF;
  SELECT pg_column_size(a.evidence_payload) INTO v_stored FROM result_attempts a WHERE a.id=p_id;
  INSERT INTO attempt_evidence_storage_events(result_attempt_id,archive_id,action,verification,source_stored_bytes)
    VALUES(p_id,p_archive_id,'shorten',p_verification,v_stored) RETURNING * INTO v_event;
  UPDATE result_attempts a SET evidence_payload=attempt_evidence_compact(a.evidence_payload),evidence_archive_id=p_archive_id,evidence_storage_event_id=v_event.id WHERE a.id=p_id;
  UPDATE attempt_evidence_storage_events e SET completed=true WHERE e.id=v_event.id RETURNING * INTO v_event;
  RETURN jsonb_build_object('eventId',v_event.id,'attemptId',p_id,'archiveId',p_archive_id,'sourceStoredBytes',v_event.source_stored_bytes,
    'remainingStoredBytes',v_event.result_stored_bytes,'projectionValueBytes',v_event.projection_value_bytes,'verificationValueBytes',v_event.verification_value_bytes,
    'payloadBytesReclaimed',v_event.source_stored_bytes-v_event.result_stored_bytes,'netValueBytesReclaimed',v_event.net_value_bytes_saved,
    'removedLogicalBytes',(v_projection->>'removedLogicalBytes')::bigint);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_restore(p_id uuid,p_archive_id uuid,p_original_text text,p_reason text,p_expected_event_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v_attempt result_attempts%ROWTYPE; v_projection jsonb; v_event attempt_evidence_storage_events%ROWTYPE; v_stored bigint;
BEGIN
  PERFORM attempt_evidence_lock_source(p_id);
  SELECT a.* INTO v_attempt FROM result_attempts a WHERE a.id=p_id;
  SELECT p.projection INTO v_projection FROM attempt_evidence_history_projections p WHERE p.result_attempt_id=p_id AND p.archive_id=p_archive_id;
  IF v_projection IS NULL OR v_projection->>'sourceSha256' IS DISTINCT FROM encode(sha256(convert_to(p_original_text,'UTF8')),'hex')
    OR (v_projection->>'sourceByteSize')::bigint IS DISTINCT FROM octet_length(p_original_text)
    OR (p_original_text::jsonb)::text<>p_original_text THEN RAISE EXCEPTION 'Attempt restore requires the exact retained PostgreSQL original'; END IF;
  IF v_attempt.evidence_archive_id IS NULL THEN
    IF v_attempt.evidence_payload::text<>p_original_text THEN RAISE EXCEPTION 'Inline attempt restore source changed'; END IF;
    RETURN jsonb_build_object('attemptId',p_id,'archiveId',p_archive_id,'alreadyRestored',true,'payloadBytesReclaimed',0,'netValueBytesReclaimed',0);
  END IF;
  IF v_attempt.evidence_archive_id<>p_archive_id THEN RAISE EXCEPTION 'Attempt restore targets another archive'; END IF;
  IF p_expected_event_id IS NOT NULL AND v_attempt.evidence_storage_event_id IS DISTINCT FROM p_expected_event_id THEN
    RAISE EXCEPTION 'Attempt restore targets a superseded storage event';
  END IF;
  IF p_expected_event_id IS NOT NULL AND EXISTS(SELECT 1 FROM attempt_evidence_storage_events e
    WHERE e.id=p_expected_event_id AND e.app_readback_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Another worker already confirmed this attempt storage event';
  END IF;
  SELECT pg_column_size(a.evidence_payload) INTO v_stored FROM result_attempts a WHERE a.id=p_id;
  INSERT INTO attempt_evidence_storage_events(result_attempt_id,archive_id,action,verification,source_stored_bytes)
    VALUES(p_id,p_archive_id,'restore',jsonb_build_object('reason',left(p_reason,250),'sourceSha256',v_projection->>'sourceSha256'),v_stored) RETURNING * INTO v_event;
  UPDATE result_attempts a SET evidence_payload=p_original_text::jsonb,evidence_archive_id=NULL,evidence_storage_event_id=v_event.id WHERE a.id=p_id;
  UPDATE attempt_evidence_storage_events e SET completed=true WHERE e.id=v_event.id RETURNING * INTO v_event;
  RETURN jsonb_build_object('eventId',v_event.id,'attemptId',p_id,'archiveId',p_archive_id,'restoredStoredBytes',v_event.result_stored_bytes,
    'payloadBytesReclaimed',0,'netValueBytesReclaimed',0);
END;
$$;
--> statement-breakpoint
-- Only a proven representation change skips fit invalidation. Other evidence
-- changes and deletions retain the existing scientific behavior.
CREATE OR REPLACE FUNCTION invalidate_progressive_attempt_fit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_scope record;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.evidence_payload IS NOT DISTINCT FROM OLD.evidence_payload THEN RETURN NULL; END IF;
    IF attempt_evidence_representation_transition(to_jsonb(OLD.*),to_jsonb(NEW.*)) THEN RETURN NULL; END IF;
  END IF;
  FOR v_scope IN SELECT DISTINCT work.target_id,generation.epoch_id FROM progressive_cfd_evidence receipt
    JOIN progressive_cfd_attempts attempt ON attempt.token=receipt.attempt_token
    JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id JOIN progressive_work work ON work.id=unit.work_id
    JOIN progressive_generations generation ON generation.id=work.generation_id
    WHERE receipt.result_attempt_id=OLD.id
  LOOP PERFORM invalidate_progressive_polar_target(v_scope.target_id,v_scope.epoch_id); END LOOP;
  RETURN OLD;
END;
$$;
