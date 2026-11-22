-- URANS custody is explicit and stays disabled on migration. The hub uses
-- the existing per-attempt archive and exact generation. Scientific state,
-- cycles, force table, stored media and result selections retain their owners.
ALTER TABLE attempt_evidence_storage_policy ADD COLUMN urans_max_source_bytes integer
  CHECK(urans_max_source_bytes BETWEEN 4096 AND 8388608);
--> statement-breakpoint
-- Numeric display scale is the only change made by result_history_normalized.
-- PostgreSQL prints jsonb numerics in decimal form. A fractional trailing zero
-- must precede a delimiter or the end of the value. A string resembling such
-- a token only causes extra work. No text substitution is performed.
CREATE OR REPLACE FUNCTION attempt_evidence_normalized_value(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE normalized jsonb;
BEGIN
  IF pg_column_size(value)<32768 THEN RETURN result_history_normalized(value); END IF;
  IF value::text COLLATE "C" !~ '[.][0-9]*0([[:space:]]*[]},]|[eE]|$)' THEN RETURN value; END IF;
  CASE jsonb_typeof(value)
    WHEN 'object' THEN SELECT coalesce(jsonb_object_agg(key,attempt_evidence_normalized_value(item)),'{}'::jsonb)
      INTO normalized FROM jsonb_each(value) e(key,item);
    WHEN 'array' THEN SELECT coalesce(jsonb_agg(attempt_evidence_normalized_value(item) ORDER BY ordinal),'[]'::jsonb)
      INTO normalized FROM jsonb_array_elements(value) WITH ORDINALITY e(item,ordinal);
    ELSE RETURN result_history_normalized(value);
  END CASE;
  RETURN normalized;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attempt_evidence_compact(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE source_doc jsonb; changes jsonb;
BEGIN
  IF jsonb_typeof(payload)<>'object' THEN RETURN payload; END IF;
  source_doc:=CASE WHEN pg_column_size(payload)>=32768 THEN payload||'{}'::jsonb ELSE payload END;
  -- Delete array children on the small history parents. Merge the changed
  -- parents once, preserving the exact other fields and numeric display scale.
  WITH parents AS MATERIALIZED (
    SELECT h.path[1] AS key,source_doc->h.path[1] AS object,
      array_agg(h.path[2]) FILTER(WHERE jsonb_typeof(source_doc#>h.path)='array') AS removed
    FROM attempt_evidence_history_paths() h GROUP BY h.path[1])
  SELECT jsonb_object_agg(key,object-removed) INTO changes FROM parents WHERE removed IS NOT NULL;
  IF changes IS NULL THEN RETURN payload; END IF;
  RETURN source_doc||changes;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attempt_evidence_make_projection(payload jsonb,attempt_id uuid,archive_id uuid) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE
  -- Preserve every token but expand a large external TOAST value once. Path
  -- checks across one source must not reread its entire artifact inventory.
  source_doc jsonb := CASE WHEN jsonb_typeof(payload)='object' AND pg_column_size(payload)>=32768
    THEN payload||'{}'::jsonb ELSE payload END;
  compact jsonb := attempt_evidence_compact(source_doc);
  normalized jsonb := attempt_evidence_normalized_value(source_doc);
        facts jsonb; removed jsonb;
BEGIN
  -- Normalize the full tree once. Whole, parent and array identities use
  -- the matching subtree, including decimal values outside double precision.
  SELECT jsonb_object_agg(array_to_json(path)::text,attempt_evidence_source_facts(source_doc,path,false) ||
    jsonb_build_object('byteSize',octet_length((source_doc#>path)::text),
      'sourceSha256',encode(sha256(convert_to((source_doc#>path)::text,'UTF8')),'hex'),
      'semanticSha256',encode(sha256(convert_to((normalized#>path)::text,'UTF8')),'hex'))) INTO facts FROM (
    SELECT 0 AS ordinal,ARRAY[]::text[] AS path
    UNION ALL SELECT 100+min(ordinal),ARRAY[path[1]] FROM attempt_evidence_history_paths() GROUP BY path[1]
    UNION ALL SELECT 200+ordinal,path FROM attempt_evidence_history_paths()
  ) paths;
  SELECT coalesce(jsonb_agg(path ORDER BY ordinal),'[]'::jsonb) INTO removed
    FROM attempt_evidence_history_paths() WHERE jsonb_typeof(source_doc #> path)='array';
  RETURN jsonb_build_object('version',1,'attemptId',attempt_id,'archiveId',archive_id,
    'sourceSha256',facts->'[]'->>'sourceSha256',
    'sourceByteSize',(facts->'[]'->>'byteSize')::integer,'sourceSemanticSha256',facts->'[]'->>'semanticSha256',
    'compactSha256',encode(sha256(convert_to(compact::text,'UTF8')),'hex'),
    'compactSemanticSha256',encode(sha256(convert_to(attempt_evidence_compact(normalized)::text,'UTF8')),'hex'),
    'removedPaths',removed,'removedLogicalBytes',octet_length(source_doc::text)-octet_length(compact::text),'values',facts);
END;
$$;
--> statement-breakpoint
ALTER TABLE attempt_evidence_storage_policy DROP CONSTRAINT attempt_evidence_storage_policy_progressive_source_scope_check,
  ADD CONSTRAINT attempt_evidence_storage_policy_progressive_source_scope_check CHECK(progressive_source_scope IN
   ('legacy','stopped-only','receipt-bearing','receipt-urans'));
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_receipt_scope_for(p_id uuid,is_urans boolean) RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH owner AS MATERIALIZED (
  SELECT a.id,a.result_id,a.sim_job_id,a.engine_job_id,a.engine_case_slug,a.aoa_deg,
    cf.attempt_token,cf.evidence_signature,rr.sim_job_id AS remote_job,rr.sequence,rr.point_content_signature,
    rr.remote_result_id,rr.remote_result_attempt_id,rr.storage_only
  FROM result_attempts a JOIN results r ON r.id=a.result_id AND r.airfoil_id=a.airfoil_id AND r.aoa_deg=a.aoa_deg
    AND r.simulation_preset_revision_id=a.simulation_preset_revision_id
  JOIN sim_jobs j ON j.id=a.sim_job_id AND j.engine_job_id=a.engine_job_id
  LEFT JOIN progressive_cfd_evidence cf ON cf.result_attempt_id=a.id
  LEFT JOIN progressive_remote_evidence_receipts rr ON rr.result_attempt_id=a.id
  WHERE a.id=p_id AND ((is_urans AND a.regime='urans') OR (NOT is_urans AND a.regime='rans' AND a.unsteady=false)) AND a.status IN ('done','failed')
    AND j.status IN ('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL
    AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=statement_timestamp())
    AND NOT EXISTS (SELECT FROM progressive_cfd_attempts live JOIN progressive_cfd_units u0 ON u0.id=live.unit_id
      WHERE live.sim_job_id=j.id AND ((live.outcome='running' AND live.lease_until>statement_timestamp()) OR
        (u0.lease_token=live.token AND (u0.lease_until IS NULL OR u0.lease_until>statement_timestamp()))))
    AND NOT EXISTS (SELECT FROM sync_remote_result_deliveries delivery WHERE delivery.sim_job_id=j.id
      AND (delivery.result_attempt_id IS NULL OR delivery.result_attempt_id=a.id) AND delivery.claim_token IS NOT NULL
      AND (delivery.claim_expires_at IS NULL OR delivery.claim_expires_at>statement_timestamp()))
    AND (cf.result_attempt_id IS NOT NULL OR rr.result_attempt_id IS NOT NULL)
)
SELECT jsonb_build_object('attemptId',o.id,'resultId',o.result_id,'simJobId',o.sim_job_id,'engineJobId',o.engine_job_id,
  'scientific',CASE WHEN o.attempt_token IS NOT NULL THEN jsonb_build_object('attemptToken',o.attempt_token,
    'applicationSha256',o.evidence_signature,'unitId',u.id) END,
  'remote',CASE WHEN o.remote_job IS NOT NULL THEN jsonb_build_object('solverId',d.solver_id,'promiseId',d.promise_id,
    'executionId',o.remote_job,'sequence',o.sequence,'assignmentSignature',d.content_signature,
    'reportContentSignature',report.content_signature,'pointContentSignature',o.point_content_signature,
    'remoteResultId',o.remote_result_id,'remoteResultAttemptId',o.remote_result_attempt_id,'storageOnly',o.storage_only,
    'aoaDeg',o.aoa_deg,'caseSlug',o.engine_case_slug) END)
FROM owner o LEFT JOIN progressive_cfd_attempts pa ON pa.token=o.attempt_token AND pa.sim_job_id=o.sim_job_id
LEFT JOIN progressive_cfd_units u ON u.id=pa.unit_id AND u.aoa_deg=o.aoa_deg
LEFT JOIN progressive_remote_dispatches d ON d.sim_job_id=o.remote_job AND d.sim_job_id=o.sim_job_id
LEFT JOIN progressive_remote_reports report ON report.sim_job_id=d.sim_job_id AND report.sequence=o.sequence
WHERE (o.attempt_token IS NULL OR u.id IS NOT NULL) AND
  (o.remote_job IS NULL OR (d.sim_job_id IS NOT NULL AND d.sim_job_id::text=o.engine_job_id AND report.content_signature IS NOT NULL))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attempt_evidence_receipt_scope(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT attempt_evidence_receipt_scope_for(p_id,false)
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_urans_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE a result_attempts%ROWTYPE; ar attempt_evidence_archives%ROWTYPE; policy attempt_evidence_storage_policy%ROWTYPE;
        src text;
BEGIN
  SELECT * INTO a FROM result_attempts WHERE id=attempt_id;
  IF NOT FOUND THEN RETURN 'missing-attempt'; END IF;
  IF a.evidence_archive_id IS NOT NULL THEN RETURN 'already-shortened'; END IF;
  IF attempt_evidence_receipt_scope_for(attempt_id,true) IS NULL THEN RETURN 'missing-exact-settled-progressive-receipt'; END IF;
  SELECT * INTO policy FROM attempt_evidence_storage_policy WHERE id=1;
  IF NOT EXISTS (SELECT FROM attempt_evidence_archives ar0 WHERE ar0.result_attempt_id=a.id AND ar0.result_id=a.result_id
    AND ar0.sim_job_id=a.sim_job_id AND (archive_id IS NULL OR ar0.id=archive_id)) THEN RETURN 'missing-archive'; END IF;
  IF NOT EXISTS (SELECT FROM attempt_evidence_archives ar0 WHERE ar0.result_attempt_id=a.id AND ar0.result_id=a.result_id
    AND ar0.sim_job_id=a.sim_job_id AND (archive_id IS NULL OR ar0.id=archive_id)
    AND ar0.source_byte_size<=coalesce(policy.urans_max_source_bytes,policy.max_source_bytes)) THEN RETURN 'source-byte-limit'; END IF;
  src:=a.evidence_payload::text;
  IF octet_length(src)>coalesce(policy.urans_max_source_bytes,policy.max_source_bytes) THEN RETURN 'source-byte-limit'; END IF;
  SELECT ar0.* INTO ar FROM attempt_evidence_archives ar0 WHERE ar0.result_attempt_id=a.id
    AND ar0.result_id=a.result_id AND ar0.sim_job_id=a.sim_job_id AND (archive_id IS NULL OR ar0.id=archive_id)
    AND ar0.source_byte_size=octet_length(src) AND ar0.source_sha256=encode(sha256(convert_to(src,'UTF8')),'hex')
    ORDER BY ar0.verified_at DESC,ar0.id LIMIT 1;
  IF NOT FOUND THEN RETURN 'archive-source-mismatch'; END IF;
  IF ar.history_byte_size<policy.min_logical_bytes THEN RETURN 'insufficient-logical-bulk'; END IF;
  -- Admission moves the existing inventoried leaves. A missing channel or
  -- certificate is scientific evidence of absence. Its shape stays exact.
  IF jsonb_array_length(ar.history_series)=0 OR EXISTS (
    SELECT FROM jsonb_array_elements(ar.history_series) entry
    WHERE NOT EXISTS (SELECT FROM attempt_evidence_history_paths() h
      WHERE to_jsonb(h.path)=entry->'path' AND jsonb_typeof(a.evidence_payload#>h.path)='array')
  ) THEN RETURN 'unverified-history-leaf'; END IF;
  IF octet_length(src)-octet_length(attempt_evidence_compact(a.evidence_payload)::text)<policy.min_logical_bytes
    THEN RETURN 'insufficient-logical-bulk'; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_shortening_limiter(uuid,uuid) RENAME TO attempt_evidence_pre_urans_limiter;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF (SELECT progressive_source_scope FROM attempt_evidence_storage_policy WHERE id=1)='receipt-urans' THEN
    RETURN attempt_evidence_urans_shortening_limiter(attempt_id,archive_id);
  END IF;
  RETURN attempt_evidence_pre_urans_limiter(attempt_id,archive_id);
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_original_readbacks_valid(p_id uuid,p_archive_id uuid,p_proof jsonb) RETURNS boolean
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
    AND v_deps->>'sourceSha256'=v_archive.source_sha256
    AND v_deps->'classificationEquivalent'='true'::jsonb AND v_deps->'equalityEquivalent'='true'::jsonb
    AND v_deps->'scientificEquivalent'='true'::jsonb AND v_deps->'readDependenciesSatisfied'='true'::jsonb,false);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_bound_receipt_proof(scope_ jsonb,deps jsonb,verifier text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(scope_ IS NOT NULL AND deps->>'verifier'=verifier AND deps->'progressiveScope'=scope_
   AND deps->>'applicationSha256' ~ '^[a-f0-9]{64}$'
   AND (scope_->'scientific'<>'null'::jsonb OR scope_->'remote'<>'null'::jsonb)
   AND (scope_->'scientific'='null'::jsonb OR scope_#>>'{scientific,applicationSha256}'=deps->>'applicationSha256')
   AND (scope_->'remote'='null'::jsonb OR deps->>'reportedApplicationSha256'=deps->>'applicationSha256'),false)
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_verification_valid(uuid,uuid,jsonb) RENAME TO attempt_evidence_pre_urans_verification;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_verification_valid(p_id uuid,p_archive_id uuid,p_proof jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF (SELECT progressive_source_scope FROM attempt_evidence_storage_policy WHERE id=1)='receipt-urans' THEN
    RETURN attempt_evidence_original_readbacks_valid(p_id,p_archive_id,p_proof) AND attempt_evidence_bound_receipt_proof(
      attempt_evidence_receipt_scope_for(p_id,true),p_proof->'dependencies','server-consumers/receipt-bearing-urans-v1');
  END IF;
  RETURN attempt_evidence_pre_urans_verification(p_id,p_archive_id,p_proof);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attempt_evidence_archived_application_sha256(p_id uuid,p_archive uuid,p_event uuid) RETURNS text
LANGUAGE sql STABLE STRICT AS $$
  SELECT e.verification#>>'{dependencies,applicationSha256}'
  FROM result_attempts a JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id AND e.result_attempt_id=a.id
    AND e.archive_id=a.evidence_archive_id AND e.completed AND e.action='shorten'
  JOIN attempt_evidence_archives ar ON ar.id=e.archive_id AND ar.result_attempt_id=a.id
    AND ar.result_id IS NOT DISTINCT FROM a.result_id AND (a.sim_job_id IS NULL OR ar.sim_job_id=a.sim_job_id)
  JOIN attempt_evidence_history_projections p ON p.result_attempt_id=a.id AND p.archive_id=ar.id
  WHERE a.id=p_id AND ar.id=p_archive AND e.id=p_event
    AND e.verification#>>'{dependencies,verifier}' IN ('server-consumers/stopped-progressive-rans-v1','server-consumers/receipt-bearing-rans-v1','server-consumers/receipt-bearing-urans-v1')
    AND e.verification#>>'{dependencies,sourceSha256}'=ar.source_sha256
    AND p.projection->>'sourceSha256'=ar.source_sha256 AND (p.projection->>'sourceByteSize')::bigint=ar.source_byte_size
    AND e.verification#>>'{dependencies,applicationSha256}' ~ '^[a-f0-9]{64}$'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION require_inline_attempt_for_progressive_fit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a record; original_hash text;
BEGIN
  SELECT id,sim_job_id,aoa_deg,evidence_archive_id,evidence_storage_event_id INTO a
    FROM result_attempts WHERE id=NEW.result_attempt_id FOR SHARE;
  IF a.evidence_archive_id IS NULL THEN RETURN NEW; END IF;
  SELECT attempt_evidence_archived_application_sha256(a.id,a.evidence_archive_id,a.evidence_storage_event_id) INTO original_hash
  FROM attempt_evidence_storage_events e WHERE e.id=a.evidence_storage_event_id
    AND e.verification#>>'{dependencies,verifier}' IN ('server-consumers/receipt-bearing-rans-v1','server-consumers/receipt-bearing-urans-v1')
    AND (e.verification#>>'{dependencies,progressiveScope,scientific,attemptToken}' IS NULL OR
      e.verification#>>'{dependencies,progressiveScope,scientific,attemptToken}'=NEW.attempt_token::text);
  IF original_hash IS NULL OR NEW.evidence_signature IS DISTINCT FROM original_hash OR NOT EXISTS (
     SELECT FROM progressive_cfd_attempts pa JOIN progressive_cfd_units u ON u.id=pa.unit_id
     WHERE pa.token=NEW.attempt_token AND pa.sim_job_id=a.sim_job_id AND u.aoa_deg=a.aoa_deg)
    OR NOT EXISTS (SELECT FROM result_attempts src WHERE src.id=a.id
      AND jsonb_typeof(src.evidence_payload->'solver_active_seconds')='number'
      AND (src.evidence_payload->>'solver_active_seconds')::double precision=NEW.solver_active_seconds
      AND coalesce(src.evidence_payload#>'{solver_budget,exhausted}','false'::jsonb)=to_jsonb(NEW.budget_guard_exhausted))
    THEN RAISE EXCEPTION 'Restore the exact archived attempt before linking progressive CFD evidence'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION lock_attempt_receipt_storage_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j uuid; recorded jsonb:=NEW.verification#>'{dependencies,progressiveScope}';
BEGIN
  j:=(recorded->>'simJobId')::uuid;
  PERFORM 1 FROM progressive_cfd_attempts pa JOIN progressive_cfd_units u ON u.id=pa.unit_id
    WHERE pa.sim_job_id=j ORDER BY pa.token FOR SHARE OF pa,u NOWAIT;
  PERFORM 1 FROM sync_remote_result_deliveries delivery WHERE delivery.sim_job_id=j
    AND (delivery.result_attempt_id IS NULL OR delivery.result_attempt_id=NEW.result_attempt_id)
    ORDER BY delivery.id FOR SHARE NOWAIT;
  PERFORM 1 FROM progressive_cfd_evidence cf WHERE cf.result_attempt_id=NEW.result_attempt_id FOR SHARE NOWAIT;
  PERFORM 1 FROM progressive_remote_evidence_receipts rr WHERE rr.result_attempt_id=NEW.result_attempt_id FOR SHARE NOWAIT;
  IF recorded IS NULL OR recorded IS DISTINCT FROM attempt_evidence_receipt_scope_for(NEW.result_attempt_id,NEW.verification#>>'{dependencies,verifier}'='server-consumers/receipt-bearing-urans-v1')
    THEN RAISE EXCEPTION 'Progressive scientific source changed before storage transition'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attempt_urans_receipt_storage_lock BEFORE INSERT ON attempt_evidence_storage_events
FOR EACH ROW WHEN (NEW.action='shorten' AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/receipt-bearing-urans-v1')
EXECUTE FUNCTION lock_attempt_receipt_storage_source();
