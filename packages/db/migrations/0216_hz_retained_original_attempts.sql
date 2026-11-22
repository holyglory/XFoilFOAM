-- Archive-only registration uses the native 0207 immutable owner and needs
-- no policy switch. This gate is only for releasing SQL arrays on the worker.
ALTER TABLE attempt_evidence_storage_policy ADD COLUMN hz_retained_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE FUNCTION clear_disabled_hz_retained_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT NEW.hz_worker_only OR NOT NEW.shortening_enabled THEN NEW.hz_retained_enabled:=false; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hz_retained_policy_clear BEFORE UPDATE ON attempt_evidence_storage_policy
 FOR EACH ROW WHEN (NEW.hz_retained_enabled AND (NOT NEW.hz_worker_only OR NOT NEW.shortening_enabled))
 EXECUTE FUNCTION clear_disabled_hz_retained_policy();
--> statement-breakpoint
ALTER TABLE attempt_evidence_storage_policy ADD CONSTRAINT hz_retained_policy_exclusive
 CHECK (NOT hz_retained_enabled OR (hz_worker_only AND shortening_enabled AND consumer_contract_version=1 AND progressive_source_scope='legacy'));
--> statement-breakpoint
CREATE INDEX hz_retained_attempt_scan_idx ON progressive_worker_hub_receipts(result_attempt_id)
 WHERE receipt->>'kind'='retained-progressive-attempt' AND receipt->'storageOnly' IN ('true'::jsonb,'false'::jsonb);
--> statement-breakpoint
-- Bind the selected point, its published coefficients and this attempt's
-- immutable interpretation/classification records across the transition.
CREATE FUNCTION attempt_evidence_hz_selection_sha256(p_id uuid) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('result',r.id,'selected',r.current_result_attempt_id,
   'values',jsonb_build_array(r.aoa_deg,r.cl,r.cd,r.cm,r.converged,r.status,r.source,r.simulation_preset_revision_id),
   'classifications',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id),'[]') FROM result_classifications c WHERE c.result_attempt_id=a.id),
   'interpretations',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.id),'[]') FROM result_interpretations i WHERE i.result_attempt_id=a.id))::text,'UTF8')),'hex')
 FROM result_attempts a JOIN results r ON r.id=a.result_id WHERE a.id=p_id
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_scope_for(p_id uuid,extended boolean) RETURNS jsonb LANGUAGE sql STABLE SET join_collapse_limit=1 AS $$
 SELECT (SELECT jsonb_build_object('instance',s.instance_id,'solver',s.remote_solver_registered_id,'promise',p.id,
   'job',j.id,'attempt',a.id,'result',r.id,'hubAttempt',h.receipt->>'resultAttemptId','hubResult',h.receipt->>'resultId',
   'sequence',h.sequence,'point',h.point_content_signature,'report',e.content_signature,'bundle',b.id,
   'generation',b.generation,'assignment',wr.assignment_signature) ||
 CASE WHEN extended THEN jsonb_build_object('contract','retained-original-v2','storageOnly',h.receipt->'storageOnly',
  'selectionSha256',attempt_evidence_hz_selection_sha256(a.id)) ELSE '{}'::jsonb END
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
        AND (h.receipt->'storageOnly'='true'::jsonb OR (extended AND h.receipt->'storageOnly'='false'::jsonb)) AND h.receipt->>'sequence'=h.sequence::text
      JOIN progressive_worker_evidence_attempts w ON w.result_attempt_id=a.id AND w.sim_job_id=j.id
        AND w.sequence=h.sequence AND w.point_content_signature=h.point_content_signature
      JOIN progressive_worker_evidence_receipts e ON e.sim_job_id=w.sim_job_id AND e.sequence=w.sequence
      JOIN progressive_worker_reports wr ON wr.sim_job_id=w.sim_job_id AND wr.sequence=w.sequence
        AND wr.content_signature=e.content_signature AND wr.acknowledged_at IS NOT NULL AND wr.archived_at IS NOT NULL
      JOIN progressive_report_archive_members m ON m.bundle_id=wr.archive_bundle_id AND m.sim_job_id=w.sim_job_id
        AND m.sequence=w.sequence AND m.content_signature=e.content_signature AND m.source_kind='worker' AND m.member_kind='report'
      JOIN progressive_report_archive_bundles b ON b.id=m.bundle_id AND b.sim_job_id=j.id AND b.source_kind=m.source_kind
      WHERE a.id=p_id AND ((a.status='done' AND a.source='solved' AND (extended OR (a.regime='rans' AND NOT a.unsteady)))
          OR (extended AND a.status='failed' AND a.source='queued')) AND r.current_result_attempt_id IS DISTINCT FROM a.id AND (j.status='cancelled' OR (extended AND j.status IN ('done','failed'))) AND j."ingestedAt" IS NOT NULL
        AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=statement_timestamp())
        AND j.request_payload->>'remoteSolver'='true' AND (p.status IN ('cancelled','expired') OR (extended AND p.status='fulfilled'))

        AND wr.stopped_engine_job_id=j.id::text AND NOT EXISTS (SELECT FROM progressive_worker_reports later WHERE later.sim_job_id=j.id AND later.sequence>wr.sequence)
        AND b.verified_at IS NOT NULL AND w.sequence BETWEEN b.first_sequence AND b.last_sequence
        AND b.object_key='progressive-reports/v1/worker/'||j.id::text||'/'||b.stored_sha256||'.jsonl.gz'
        AND b.member_count BETWEEN 1 AND 128 AND b.archive_format='jsonl' AND b.compression='gzip' AND b.mime_type='application/gzip'
        AND b.stored_byte_size BETWEEN 1 AND 16777216 AND m.report_byte_size BETWEEN 1 AND 4194304
        AND NOT EXISTS (SELECT FROM progressive_worker_report_conflicts c WHERE c.sim_job_id=w.sim_job_id AND c.sequence=w.sequence)

 AND (NOT extended OR (s.remote_solver_enabled AND j.airfoil_id=a.airfoil_id AND j.simulation_preset_revision_id=a.simulation_preset_revision_id
   AND j.bc_ids ? a.bc_id::text AND p.airfoil_id=a.airfoil_id AND p.simulation_preset_revision_id=a.simulation_preset_revision_id
   AND j.request_payload->'engineRequest'=j.request_payload#>'{remoteProgressiveExecution,request}'
   AND EXISTS(SELECT FROM registered_remote_solvers local_worker JOIN progressive_worker_submission_intents intent ON intent.sim_job_id=j.id
      WHERE local_worker.id=s.remote_solver_registered_id AND local_worker.instance_id=s.instance_id::text AND local_worker.revoked_at IS NULL
      AND intent.authorization->>'kind'='authorized' AND intent.authorization->>'executionId'=j.id::text
      AND intent.authorization->>'contentSignature'=intent.assignment_signature AND intent.assignment_signature=wr.assignment_signature)))
 AND j.engine_state IN ('completed','cancelled','failed')
 AND p.id::text=j.request_payload#>>'{remoteProgressiveExecution,promiseId}'
 AND s.remote_solver_registered_id::text=j.request_payload#>>'{remoteProgressiveExecution,solverId}'
 AND wr.assignment_signature=j.request_payload#>>'{remoteProgressiveExecution,contentSignature}'
 AND j.id::text=j.request_payload#>>'{remoteProgressiveExecution,scope,executionId}'
 AND h.receipt->>'resultAttemptId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' AND h.receipt->>'resultId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
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
CREATE OR REPLACE FUNCTION attempt_evidence_hz_scope(p_id uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT attempt_evidence_hz_scope_for(p_id,
  (SELECT hz_retained_enabled FROM attempt_evidence_storage_policy WHERE id=1)
  AND NOT EXISTS(SELECT FROM result_attempts a JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id
    WHERE a.id=p_id AND a.evidence_archive_id=e.archive_id AND e.verification#>>'{dependencies,verifier}'='server-consumers/hz-worker-steady-rans-v1'))
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_hz_limiter(uuid,uuid) RENAME TO attempt_evidence_hz_legacy_limiter;
--> statement-breakpoint
-- Data bounds and named consumers determine eligibility. A method label,
-- numeric equality of local/upstream UUIDs or absent hub-local dispatch cannot
-- substitute for the worker source, verified API, replay and scientific proof.
CREATE FUNCTION attempt_evidence_hz_retained_limiter(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE a result_attempts%ROWTYPE; ar attempt_evidence_archives%ROWTYPE; policy attempt_evidence_storage_policy%ROWTYPE;
 orig text; scope jsonb; inventory jsonb;
BEGIN
 SELECT * INTO a FROM result_attempts WHERE id=p_id;
 IF a.id IS NULL OR a.evidence_archive_id IS NOT NULL THEN RETURN 'absent-or-shortened'; END IF;
 SELECT * INTO policy FROM attempt_evidence_storage_policy WHERE id=1;
 IF pg_column_size(a.evidence_payload)>least(262144,policy.max_source_bytes) THEN RETURN 'worker-shortening-source-byte-limit'; END IF;
 orig:=a.evidence_payload::text;
 IF octet_length(orig)>least(262144,policy.max_source_bytes) THEN RETURN 'worker-shortening-source-byte-limit'; END IF;
 inventory:=attempt_evidence_series_inventory(a.evidence_payload);
 IF jsonb_array_length(inventory)<1 OR octet_length(orig)-octet_length(attempt_evidence_compact(a.evidence_payload)::text)<policy.min_logical_bytes THEN RETURN 'insufficient-logical-bulk'; END IF;
 scope:=attempt_evidence_hz_scope_for(p_id,true);
 IF scope IS NULL THEN RETURN 'worker-source-or-dependencies'; END IF;
 IF p_archive IS NOT NULL THEN
  SELECT * INTO ar FROM attempt_evidence_archives WHERE id=p_archive;
  IF ar.id IS NULL OR ar.result_attempt_id<>p_id OR ar.result_id IS DISTINCT FROM a.result_id OR ar.sim_job_id IS DISTINCT FROM a.sim_job_id
    OR ar.source_instance IS DISTINCT FROM scope->>'instance' OR ar.source_byte_size IS DISTINCT FROM octet_length(orig)
    OR ar.source_sha256 IS DISTINCT FROM encode(sha256(convert_to(orig,'UTF8')),'hex') OR ar.history_series IS DISTINCT FROM inventory
    OR ar.object_key<>concat('attempt-evidence/v1/',ar.source_instance,'/',p_id,'/',ar.source_sha256,'/',ar.stored_sha256,'.json.gz') THEN RETURN 'archive-source-mismatch'; END IF;
 END IF;
 RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_limiter(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF (SELECT hz_retained_enabled FROM attempt_evidence_storage_policy WHERE id=1) THEN RETURN attempt_evidence_hz_retained_limiter(p_id,p_archive); END IF;
 RETURN attempt_evidence_hz_legacy_limiter(p_id,p_archive);
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_verification_valid(uuid,uuid,jsonb) RENAME TO attempt_evidence_pre_retained_hz_verification;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_verification_valid(p_id uuid,p_archive uuid,p_proof jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE ar attempt_evidence_archives%ROWTYPE; d jsonb:=p_proof->'direct'; app jsonb:=p_proof->'app'; deps jsonb:=p_proof->'dependencies'; scope jsonb;
BEGIN
 IF NOT (SELECT hz_retained_enabled FROM attempt_evidence_storage_policy WHERE id=1) THEN
   RETURN attempt_evidence_pre_retained_hz_verification(p_id,p_archive,p_proof);
 END IF;
 IF p_proof IS NULL OR octet_length(p_proof::text)>8192 THEN RETURN false; END IF;
 SELECT * INTO ar FROM attempt_evidence_archives WHERE id=p_archive AND result_attempt_id=p_id;
 IF NOT FOUND THEN RETURN false; END IF;
 scope:=attempt_evidence_hz_scope(p_id);
 RETURN coalesce(scope->>'contract'='retained-original-v2' AND scope->>'selectionSha256' ~ '^[a-f0-9]{64}$' AND deps->>'jobDecisionsSha256' ~ '^[a-f0-9]{64}$' AND ar.source_instance=scope->>'instance'
   AND d @> jsonb_build_object('attemptId',p_id,'archiveId',ar.id,'bucket',ar.bucket,'objectKey',ar.object_key,'generation',ar.generation,
     'storedSha256',ar.stored_sha256,'storedByteSize',ar.stored_byte_size,'crc32c',ar.crc32c,'sourceSha256',ar.source_sha256,'sourceByteSize',ar.source_byte_size)
   AND (d->>'verifiedAt')::timestamptz BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()+interval '5 seconds'
   AND app @> jsonb_build_object('source','worker-volume','attemptId',p_id,'archiveId',ar.id,'forceArchive',true,'sourceSha256',ar.source_sha256,'sourceByteSize',ar.source_byte_size)
   AND (app->>'verifiedAt')::timestamptz BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()+interval '5 seconds'
   AND deps @> jsonb_build_object('contractVersion',1,'attemptId',p_id,'archiveId',ar.id,'sourceSha256',ar.source_sha256,
     'verifier','server-consumers/hz-retained-original-v2','classificationEquivalent',true,'equalityEquivalent',true,'scientificEquivalent',true,'readDependenciesSatisfied',true)
   AND deps->>'applicationSha256' ~ '^[0-9a-f]{64}$' AND deps->'workerScope'=scope,false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN false;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hz_retained_original_source_lock BEFORE INSERT ON attempt_evidence_storage_events
 FOR EACH ROW WHEN (NEW.action='shorten' AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/hz-retained-original-v2')
 EXECUTE FUNCTION lock_hz_attempt_receipt_source();

--> statement-breakpoint
-- An older sweeper can restore a pending original, but cannot mark a broader
-- event complete with its legacy app-only confirmation. In one transaction
-- the new consumer binds its fresh post-publication decisions to that event.
CREATE FUNCTION require_hz_retained_post_readback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE checked jsonb; expected jsonb:=NEW.verification->'dependencies';
BEGIN
 checked:=nullif(current_setting('airfoilfoam.hz_retained_post_readback',true),'')::jsonb;
 IF checked IS NULL OR checked->>'event' IS DISTINCT FROM NEW.id::text
  OR checked->>'source' IS DISTINCT FROM expected->>'sourceSha256'
  OR checked->>'decisions' IS DISTINCT FROM expected->>'jobDecisionsSha256'
  OR checked->>'selection' IS DISTINCT FROM expected#>>'{workerScope,selectionSha256}'
  OR checked->>'selection' IS DISTINCT FROM attempt_evidence_hz_selection_sha256(NEW.result_attempt_id)
 THEN RAISE EXCEPTION 'Retained worker event requires post-transition application and scientific equality'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hz_retained_post_readback BEFORE UPDATE OF app_readback_at ON attempt_evidence_storage_events
 FOR EACH ROW WHEN (OLD.app_readback_at IS NULL AND NEW.app_readback_at IS NOT NULL
   AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/hz-retained-original-v2')
 EXECUTE FUNCTION require_hz_retained_post_readback();

--> statement-breakpoint
CREATE FUNCTION lock_hz_retained_producer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope jsonb:=NEW.verification#>'{dependencies,workerScope}';
BEGIN
 PERFORM 1 FROM registered_remote_solvers w WHERE w.id=(scope->>'solver')::uuid AND w.instance_id=scope->>'instance' AND w.revoked_at IS NULL FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Worker registration changed during custody'; END IF;
 PERFORM 1 FROM progressive_worker_submission_intents i WHERE i.sim_job_id=(scope->>'job')::uuid AND i.assignment_signature=scope->>'assignment' FOR SHARE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original worker submission changed during custody'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hz_retained_producer_lock BEFORE INSERT ON attempt_evidence_storage_events
 FOR EACH ROW WHEN (NEW.action='shorten' AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/hz-retained-original-v2')
 EXECUTE FUNCTION lock_hz_retained_producer();
