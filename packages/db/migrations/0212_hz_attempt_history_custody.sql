-- HZ stores its own 0207 envelope. The immutable worker and hub IDs in the
-- signed delivery are provenance; the archive FK always uses the HZ owner.
ALTER TABLE attempt_evidence_storage_policy ADD COLUMN hz_worker_only boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE attempt_evidence_storage_policy ADD CONSTRAINT hz_attempt_policy_exclusive CHECK
  (NOT hz_worker_only OR (progressive_source_scope='legacy' AND NOT stopped_progressive_enabled));
--> statement-breakpoint
CREATE INDEX hz_attempt_stored_ack_idx ON progressive_worker_hub_receipts(result_attempt_id)
 WHERE receipt->'storageOnly'='true'::jsonb;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_scope(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE SET join_collapse_limit=1 AS $$
 SELECT (SELECT jsonb_build_object('instance',s.instance_id,'solver',s.remote_solver_registered_id,'promise',p.id,
   'job',j.id,'attempt',a.id,'result',r.id,'hubAttempt',h.receipt->>'resultAttemptId','hubResult',h.receipt->>'resultId',
   'sequence',h.sequence,'point',h.point_content_signature,'report',e.content_signature,'bundle',b.id,
   'generation',b.generation,'assignment',wr.assignment_signature)
 FROM result_attempts a JOIN results r ON r.id=a.result_id AND r.airfoil_id=a.airfoil_id AND r.aoa_deg=a.aoa_deg
        AND r.simulation_preset_revision_id=a.simulation_preset_revision_id
      JOIN sim_jobs j ON j.id=a.sim_job_id AND a.engine_job_id=j.id::text AND j.engine_job_id=j.id::text
      JOIN sync_api_settings s ON s.id=1 AND j.request_payload->>'upstreamBaseUrl'=s.upstream_base_url
      JOIN sync_sweep_promises p ON p.id::text=j.request_payload->>'syncPromiseId'
        AND p.registered_solver_id=s.remote_solver_registered_id AND p.source_base_url=s.upstream_base_url
      JOIN progressive_worker_hub_receipts h ON h.result_attempt_id=a.id AND h.sim_job_id=j.id
        AND h.receipt->>'remoteResultAttemptId'=a.id::text AND h.receipt->>'remoteResultId'=r.id::text
        AND h.receipt->>'pointContentSignature'=h.point_content_signature AND h.receipt->>'executionId'=j.id::text
        AND h.receipt->>'kind'='retained-progressive-attempt' AND h.receipt->>'version'='1'
        AND h.receipt->'storageOnly'='true'::jsonb AND h.receipt->>'sequence'=h.sequence::text
      JOIN progressive_worker_evidence_attempts w ON w.result_attempt_id=a.id AND w.sim_job_id=j.id
        AND w.sequence=h.sequence AND w.point_content_signature=h.point_content_signature
      JOIN progressive_worker_evidence_receipts e ON e.sim_job_id=w.sim_job_id AND e.sequence=w.sequence
      JOIN progressive_worker_reports wr ON wr.sim_job_id=w.sim_job_id AND wr.sequence=w.sequence
        AND wr.content_signature=e.content_signature AND wr.acknowledged_at IS NOT NULL AND wr.archived_at IS NOT NULL
      JOIN progressive_report_archive_members m ON m.bundle_id=wr.archive_bundle_id AND m.sim_job_id=w.sim_job_id
        AND m.sequence=w.sequence AND m.content_signature=e.content_signature AND m.source_kind='worker' AND m.member_kind='report'
      JOIN progressive_report_archive_bundles b ON b.id=m.bundle_id AND b.sim_job_id=j.id AND b.source_kind=m.source_kind
      WHERE a.id=p_id AND a.status='done' AND a.source='solved' AND a.regime='rans'
        AND NOT a.unsteady AND r.current_result_attempt_id IS DISTINCT FROM a.id AND j.status='cancelled' AND j."ingestedAt" IS NOT NULL
        AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=statement_timestamp())
        AND j.request_payload->>'remoteSolver'='true' AND p.status IN ('cancelled','expired')

        AND wr.stopped_engine_job_id=j.id::text AND NOT EXISTS (SELECT FROM progressive_worker_reports later WHERE later.sim_job_id=j.id AND later.sequence>wr.sequence)
        AND b.verified_at IS NOT NULL AND w.sequence BETWEEN b.first_sequence AND b.last_sequence
        AND b.object_key='progressive-reports/v1/worker/'||j.id::text||'/'||b.stored_sha256||'.jsonl.gz'
        AND b.member_count BETWEEN 1 AND 128 AND b.archive_format='jsonl' AND b.compression='gzip' AND b.mime_type='application/gzip'
        AND b.stored_byte_size BETWEEN 1 AND 16777216 AND m.report_byte_size BETWEEN 1 AND 4194304
        AND NOT EXISTS (SELECT FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=w.sim_job_id AND c.sequence=w.sequence)

 AND j.engine_state IN ('completed','cancelled','failed')
 AND p.id::text=j.request_payload#>>'{remoteProgressiveExecution,promiseId}'
 AND s.remote_solver_registered_id::text=j.request_payload#>>'{remoteProgressiveExecution,solverId}'
 AND wr.assignment_signature=j.request_payload#>>'{remoteProgressiveExecution,contentSignature}'
 AND j.id::text=j.request_payload#>>'{remoteProgressiveExecution,scope,executionId}'
 AND h.receipt->>'resultAttemptId' ~ '^[a-f0-9-]{36}$' AND h.receipt->>'resultId' ~ '^[a-f0-9-]{36}$'
 AND NOT EXISTS(SELECT FROM progressive_worker_evidence_delivery_claims q WHERE q.sim_job_id=j.id AND (q.claim_expires_at IS NULL OR q.claim_expires_at>statement_timestamp()))
 AND NOT EXISTS(SELECT FROM progressive_worker_delivery_failures q WHERE q.sim_job_id=j.id AND q.point_content_signature=h.point_content_signature)
 AND NOT EXISTS(SELECT FROM progressive_cfd_evidence q WHERE q.result_attempt_id=a.id)
 AND NOT EXISTS(SELECT FROM progressive_cfd_evidence_reuses q WHERE q.source_result_attempt_id=a.id)
 AND NOT EXISTS(SELECT FROM progressive_cfd_budget_extensions q WHERE q.source_result_attempt_id=a.id)
 AND NOT EXISTS(SELECT FROM progressive_cfd_recovery_plans q WHERE q.diagnostic_attempt_id=a.id)
 AND NOT EXISTS(SELECT FROM progressive_polar_model_evidence q WHERE q.result_attempt_id=a.id)
 AND NOT EXISTS(SELECT FROM sim_urans_requests q WHERE q.continue_from_result_attempt_id=a.id)
 AND NOT EXISTS(SELECT FROM sim_urans_verify_queue q WHERE q.precalc_result_attempt_id=a.id OR q.latest_result_attempt_id=a.id)
 AND NOT EXISTS(SELECT FROM sim_precalc_obligation_attempts q WHERE q.result_attempt_id=a.id)
 AND NOT EXISTS(SELECT FROM sim_rans_polar_promotions q WHERE q.trigger_result_attempt_id=a.id)
 AND NOT EXISTS(SELECT FROM result_canonical_selections q WHERE q.result_attempt_id=a.id)
 AND NOT EXISTS(SELECT FROM result_media_repairs q WHERE q.result_attempt_id=a.id AND q.state <> 'done')
 AND NOT EXISTS(SELECT FROM sync_remote_result_deliveries q WHERE (q.result_attempt_id=a.id OR q.sim_job_id=j.id)
   AND q.state NOT IN ('delivered','superseded','conflict')))
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_limiter(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE a result_attempts%ROWTYPE; ar attempt_evidence_archives%ROWTYPE; p attempt_evidence_storage_policy%ROWTYPE;
  scope jsonb; n int; original text;
BEGIN
  SELECT * INTO a FROM result_attempts WHERE id=p_id;
  IF a.id IS NULL OR a.evidence_archive_id IS NOT NULL THEN RETURN 'absent-or-shortened'; END IF;
  SELECT * INTO p FROM attempt_evidence_storage_policy WHERE id=1;
  IF pg_column_size(a.evidence_payload)>p.max_source_bytes THEN RETURN 'source-byte-limit'; END IF;
  original:=a.evidence_payload::text;
  IF octet_length(original)>least(p.max_source_bytes,262144) THEN RETURN 'source-byte-limit'; END IF;
  IF a.evidence_payload->>'fidelity' IS DISTINCT FROM 'rans' OR a.evidence_payload->'mesh_recovery_version' IS DISTINCT FROM '3'::jsonb
     OR jsonb_array_length(attempt_evidence_series_inventory(a.evidence_payload))<>4 THEN RETURN 'outside-worker-steady-cohort'; END IF;
  IF EXISTS(SELECT FROM unnest(ARRAY['iterations','cl','cd','cm']) k WHERE jsonb_typeof(a.evidence_payload#>ARRAY['steady_history',k]) IS DISTINCT FROM 'array')
     THEN RETURN 'unsupported-steady-shape'; END IF;
  n:=jsonb_array_length(a.evidence_payload#>'{steady_history,iterations}');
  IF n NOT BETWEEN 1 AND 2000 OR EXISTS (SELECT FROM unnest(ARRAY['cl','cd','cm']) k WHERE jsonb_array_length(a.evidence_payload#>ARRAY['steady_history',k])<>n)
     THEN RETURN 'unaligned-steady-series'; END IF;
  IF octet_length(original)-octet_length(attempt_evidence_compact(a.evidence_payload)::text)<p.min_logical_bytes THEN RETURN 'insufficient-logical-bulk'; END IF;
  scope:=attempt_evidence_hz_scope(p_id);
  IF scope IS NULL THEN RETURN 'worker-source-or-dependencies'; END IF;
  IF p_archive IS NOT NULL THEN
    SELECT * INTO ar FROM attempt_evidence_archives WHERE id=p_archive;
    IF ar.id IS NULL OR ar.result_attempt_id<>p_id OR ar.result_id IS DISTINCT FROM a.result_id OR ar.sim_job_id IS DISTINCT FROM a.sim_job_id
       OR ar.source_instance<>scope->>'instance' OR ar.source_byte_size<>octet_length(original)
       OR ar.source_sha256<>encode(sha256(convert_to(original,'UTF8')),'hex')
       OR ar.object_key<>concat('attempt-evidence/v1/',ar.source_instance,'/',a.id,'/',ar.source_sha256,'/',ar.stored_sha256,'.json.gz')
       THEN RETURN 'archive-source-mismatch'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_shortening_limiter(uuid,uuid) RENAME TO attempt_evidence_pre_hz_limiter;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF (SELECT hz_worker_only FROM attempt_evidence_storage_policy WHERE id=1) THEN
   RETURN attempt_evidence_hz_limiter(attempt_id,archive_id);
 END IF;
 RETURN attempt_evidence_pre_hz_limiter(attempt_id,archive_id);
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_verification_valid(uuid,uuid,jsonb) RENAME TO attempt_evidence_pre_hz_verification;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_verification_valid(p_id uuid,p_archive uuid,p_proof jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE ar attempt_evidence_archives%ROWTYPE; d jsonb:=p_proof->'direct'; app jsonb:=p_proof->'app'; deps jsonb:=p_proof->'dependencies'; scope jsonb;
BEGIN
 IF NOT (SELECT hz_worker_only FROM attempt_evidence_storage_policy WHERE id=1) THEN
   RETURN attempt_evidence_pre_hz_verification(p_id,p_archive,p_proof);
 END IF;
 IF p_proof IS NULL OR octet_length(p_proof::text)>8192 THEN RETURN false; END IF;
 SELECT * INTO ar FROM attempt_evidence_archives WHERE id=p_archive AND result_attempt_id=p_id;
 IF NOT FOUND THEN RETURN false; END IF;
 scope:=attempt_evidence_hz_scope(p_id);
 RETURN coalesce(scope IS NOT NULL AND ar.source_instance=scope->>'instance'
   AND d @> jsonb_build_object('attemptId',p_id,'archiveId',ar.id,'bucket',ar.bucket,'objectKey',ar.object_key,'generation',ar.generation,
     'storedSha256',ar.stored_sha256,'storedByteSize',ar.stored_byte_size,'crc32c',ar.crc32c,'sourceSha256',ar.source_sha256,'sourceByteSize',ar.source_byte_size)
   AND (d->>'verifiedAt')::timestamptz BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()+interval '5 seconds'
   AND app @> jsonb_build_object('source','worker-volume','attemptId',p_id,'archiveId',ar.id,'forceArchive',true,'sourceSha256',ar.source_sha256,'sourceByteSize',ar.source_byte_size)
   AND (app->>'verifiedAt')::timestamptz BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()+interval '5 seconds'
   AND deps @> jsonb_build_object('contractVersion',1,'attemptId',p_id,'archiveId',ar.id,'sourceSha256',ar.source_sha256,
     'verifier','server-consumers/hz-worker-steady-rans-v1','classificationEquivalent',true,'equalityEquivalent',true,'scientificEquivalent',true,'readDependenciesSatisfied',true)
   AND deps->>'applicationSha256' ~ '^[0-9a-f]{64}$' AND deps->'workerScope'=scope,false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

--> statement-breakpoint
-- 0208 has already locked job, result and attempt. Preserve the actual
-- worker registration and closed promise through the event transaction.
CREATE FUNCTION lock_hz_attempt_receipt_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope jsonb:=NEW.verification#>'{dependencies,workerScope}';
BEGIN
 PERFORM 1 FROM sync_api_settings WHERE id=1 FOR SHARE NOWAIT;
 PERFORM 1 FROM sync_sweep_promises WHERE id=(scope->>'promise')::uuid FOR SHARE NOWAIT;
 PERFORM 1 FROM progressive_worker_hub_receipts WHERE sim_job_id=(scope->>'job')::uuid
    AND point_content_signature=scope->>'point' FOR SHARE NOWAIT;
 IF scope IS NULL OR scope IS DISTINCT FROM attempt_evidence_hz_scope(NEW.result_attempt_id)
   THEN RAISE EXCEPTION 'HZ worker acknowledgment or closed assignment changed'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hz_attempt_receipt_source_lock BEFORE INSERT ON attempt_evidence_storage_events
 FOR EACH ROW WHEN (NEW.action='shorten' AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/hz-worker-steady-rans-v1')
 EXECUTE FUNCTION lock_hz_attempt_receipt_source();
