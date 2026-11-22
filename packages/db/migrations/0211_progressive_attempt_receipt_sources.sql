-- The broad reader contract is dormant until the integrated hub enables it.
ALTER TABLE attempt_evidence_storage_policy ADD COLUMN progressive_source_scope text NOT NULL DEFAULT 'legacy'
  CHECK(progressive_source_scope IN ('legacy','stopped-only','receipt-bearing'));
--> statement-breakpoint
-- Preserve old policy clients' ability to disable or return to the local class.
CREATE FUNCTION clear_disabled_progressive_source_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.progressive_source_scope := 'legacy';
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER clear_disabled_progressive_source_scope BEFORE UPDATE ON attempt_evidence_storage_policy
FOR EACH ROW WHEN (NEW.progressive_source_scope<>'legacy' AND
  (NOT NEW.shortening_enabled OR (NEW.progressive_source_scope='stopped-only' AND NOT NEW.stopped_progressive_enabled)))
EXECUTE FUNCTION clear_disabled_progressive_source_scope();
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_receipt_scope(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH owner AS MATERIALIZED (
  SELECT a.id,a.result_id,a.sim_job_id,a.engine_job_id,a.engine_case_slug,a.aoa_deg,
    cf.attempt_token,cf.evidence_signature,rr.sim_job_id AS remote_job,rr.sequence,rr.point_content_signature,
    rr.remote_result_id,rr.remote_result_attempt_id,rr.storage_only
  FROM result_attempts a JOIN results r ON r.id=a.result_id AND r.airfoil_id=a.airfoil_id AND r.aoa_deg=a.aoa_deg
    AND r.simulation_preset_revision_id=a.simulation_preset_revision_id
  JOIN sim_jobs j ON j.id=a.sim_job_id AND j.engine_job_id=a.engine_job_id
  LEFT JOIN progressive_cfd_evidence cf ON cf.result_attempt_id=a.id
  LEFT JOIN progressive_remote_evidence_receipts rr ON rr.result_attempt_id=a.id
  WHERE a.id=p_id AND a.regime='rans' AND a.unsteady=false AND a.status IN ('done','failed')
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
CREATE FUNCTION attempt_evidence_archived_application_sha256(p_id uuid,p_archive uuid,p_event uuid) RETURNS text
LANGUAGE sql STABLE STRICT AS $$
  SELECT e.verification#>>'{dependencies,applicationSha256}'
  FROM result_attempts a JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id AND e.result_attempt_id=a.id
    AND e.archive_id=a.evidence_archive_id AND e.completed AND e.action='shorten'
  JOIN attempt_evidence_archives ar ON ar.id=e.archive_id AND ar.result_attempt_id=a.id
    AND ar.result_id IS NOT DISTINCT FROM a.result_id AND (a.sim_job_id IS NULL OR ar.sim_job_id=a.sim_job_id)
  JOIN attempt_evidence_history_projections p ON p.result_attempt_id=a.id AND p.archive_id=ar.id
  WHERE a.id=p_id AND ar.id=p_archive AND e.id=p_event
    AND e.verification#>>'{dependencies,verifier}' IN ('server-consumers/stopped-progressive-rans-v1','server-consumers/receipt-bearing-rans-v1')
    AND e.verification#>>'{dependencies,sourceSha256}'=ar.source_sha256
    AND p.projection->>'sourceSha256'=ar.source_sha256 AND (p.projection->>'sourceByteSize')::bigint=ar.source_byte_size
    AND e.verification#>>'{dependencies,applicationSha256}' ~ '^[a-f0-9]{64}$'
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_payload_for_publication(attempt_id uuid,expected_archive_id uuid,original_text text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_sha text; v_size bigint; v_payload jsonb;
BEGIN
  SELECT ar.source_sha256,ar.source_byte_size INTO v_sha,v_size
  FROM result_attempts a JOIN attempt_evidence_archives ar ON ar.id=a.evidence_archive_id AND ar.result_attempt_id=a.id
    AND ar.result_id IS NOT DISTINCT FROM a.result_id AND (a.sim_job_id IS NULL OR ar.sim_job_id=a.sim_job_id)
  JOIN attempt_evidence_history_projections p ON p.result_attempt_id=a.id AND p.archive_id=ar.id
  JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id AND e.result_attempt_id=a.id
    AND e.archive_id=ar.id AND e.completed AND e.action='shorten'
  WHERE a.id=attempt_id AND ar.id=expected_archive_id AND p.projection->>'sourceSha256'=ar.source_sha256
    AND (p.projection->>'sourceByteSize')::bigint=ar.source_byte_size FOR SHARE OF a;
  IF NOT FOUND OR original_text IS NULL OR octet_length(original_text)<>v_size OR
    encode(sha256(convert_to(original_text,'UTF8')),'hex')<>v_sha THEN
    RAISE EXCEPTION 'Publication requires the current archive and exact original PostgreSQL bytes';
  END IF;
  v_payload:=original_text::jsonb;
  IF v_payload::text<>original_text THEN RAISE EXCEPTION 'Publication source is not the original PostgreSQL representation'; END IF;
  RETURN v_payload;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_receipt_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE a result_attempts%ROWTYPE; ar attempt_evidence_archives%ROWTYPE; policy attempt_evidence_storage_policy%ROWTYPE;
        src text; n integer;
BEGIN
  SELECT * INTO a FROM result_attempts WHERE id=attempt_id;
  IF NOT FOUND THEN RETURN 'missing-attempt'; END IF;
  IF a.evidence_archive_id IS NOT NULL THEN RETURN 'already-shortened'; END IF;
  IF attempt_evidence_receipt_scope(attempt_id) IS NULL THEN RETURN 'missing-exact-settled-progressive-receipt'; END IF;
  SELECT * INTO policy FROM attempt_evidence_storage_policy WHERE id=1;
  IF NOT EXISTS (SELECT FROM attempt_evidence_archives ar0 WHERE ar0.result_attempt_id=a.id AND ar0.result_id=a.result_id
    AND ar0.sim_job_id=a.sim_job_id AND (archive_id IS NULL OR ar0.id=archive_id)
    AND ar0.source_byte_size<=policy.max_source_bytes AND ar0.history_byte_size>=policy.min_logical_bytes)
    THEN RETURN 'missing-bounded-source-archive'; END IF;
  src:=a.evidence_payload::text;
  IF octet_length(src)>policy.max_source_bytes THEN RETURN 'source-byte-limit'; END IF;
  SELECT ar0.* INTO ar FROM attempt_evidence_archives ar0 WHERE ar0.result_attempt_id=a.id
    AND ar0.result_id=a.result_id AND ar0.sim_job_id=a.sim_job_id AND (archive_id IS NULL OR ar0.id=archive_id)
    AND ar0.source_byte_size=octet_length(src) AND ar0.source_sha256=encode(sha256(convert_to(src,'UTF8')),'hex')
    ORDER BY ar0.verified_at DESC,ar0.id LIMIT 1;
  IF NOT FOUND THEN RETURN 'archive-source-mismatch'; END IF;
  IF jsonb_array_length(ar.history_series)<>4 OR EXISTS (SELECT FROM jsonb_array_elements(ar.history_series) v
      WHERE v#>>'{path,0}' IS DISTINCT FROM 'steady_history') THEN RETURN 'outside-steady-only-subset'; END IF;
  n:=jsonb_array_length(a.evidence_payload#>'{steady_history,iterations}');
  IF n IS NULL OR n<1 OR EXISTS (SELECT FROM unnest(ARRAY['cl','cd','cm']) channel
      WHERE jsonb_array_length(a.evidence_payload#>ARRAY['steady_history',channel]) IS DISTINCT FROM n)
    THEN RETURN 'unaligned-steady-series'; END IF;
  IF octet_length(src)-octet_length(attempt_evidence_compact(a.evidence_payload)::text)<policy.min_logical_bytes
    THEN RETURN 'insufficient-logical-bulk'; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_shortening_limiter(uuid,uuid) RENAME TO attempt_evidence_0210_shortening_limiter;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE mode_ text;
BEGIN
  SELECT progressive_source_scope INTO mode_ FROM attempt_evidence_storage_policy WHERE id=1;
  IF mode_='receipt-bearing' THEN RETURN attempt_evidence_receipt_shortening_limiter(attempt_id,archive_id); END IF;
  IF mode_='stopped-only' AND NOT EXISTS (SELECT FROM progressive_remote_evidence_receipts rr WHERE rr.result_attempt_id=attempt_id AND rr.storage_only)
    THEN RETURN 'outside-stopped-progressive-only'; END IF;
  RETURN attempt_evidence_0210_shortening_limiter(attempt_id,archive_id);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attempt_evidence_verification_valid(p_id uuid,p_archive_id uuid,p_proof jsonb) RETURNS boolean
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
    AND CASE WHEN (SELECT progressive_source_scope FROM attempt_evidence_storage_policy WHERE id=1)='receipt-bearing' THEN
      v_deps->>'verifier'='server-consumers/receipt-bearing-rans-v1'
      AND v_deps->'progressiveScope'=attempt_evidence_receipt_scope(p_id)
      AND v_deps->>'applicationSha256' ~ '^[a-f0-9]{64}$'
      AND (v_deps#>'{progressiveScope,scientific}'='null'::jsonb OR
        v_deps#>>'{progressiveScope,scientific,applicationSha256}'=v_deps->>'applicationSha256')
      AND (v_deps#>'{progressiveScope,remote}'='null'::jsonb OR
        v_deps->>'reportedApplicationSha256'=v_deps->>'applicationSha256')
    ELSE CASE v_deps->>'verifier'
      WHEN 'server-consumers/local-steady-rans-v1' THEN NOT EXISTS (
        SELECT FROM progressive_remote_evidence_receipts rr WHERE rr.result_attempt_id=p_id AND rr.storage_only)
      WHEN 'server-consumers/stopped-progressive-rans-v1' THEN
        v_deps->>'applicationSha256' ~ '^[0-9a-f]{64}$'
        AND v_deps->'progressiveScope'=attempt_evidence_stopped_scope(p_id)
        AND (SELECT stopped_progressive_enabled FROM attempt_evidence_storage_policy WHERE id=1)
      ELSE false END END
    AND v_deps->'classificationEquivalent'='true'::jsonb AND v_deps->'equalityEquivalent'='true'::jsonb
    AND v_deps->'scientificEquivalent'='true'::jsonb AND v_deps->'readDependenciesSatisfied'='true'::jsonb,false);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
  RETURN false;
END;
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
    AND e.verification#>>'{dependencies,verifier}'='server-consumers/receipt-bearing-rans-v1'
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
-- The 0208 event guard has already locked job, result, attempt and policy.
-- Fence changes to the observed receipt/lease rows through this transition.
-- NOWAIT makes a contended actor a retry without reversing its lock order.
CREATE FUNCTION lock_attempt_receipt_storage_source() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF recorded IS NULL OR recorded IS DISTINCT FROM attempt_evidence_receipt_scope(NEW.result_attempt_id)
    THEN RAISE EXCEPTION 'Progressive scientific source changed before storage transition'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attempt_receipt_storage_lock BEFORE INSERT ON attempt_evidence_storage_events
FOR EACH ROW WHEN (NEW.action='shorten' AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/receipt-bearing-rans-v1')
EXECUTE FUNCTION lock_attempt_receipt_storage_source();
