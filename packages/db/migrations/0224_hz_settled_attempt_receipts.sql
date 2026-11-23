-- Use the immutable receipt for the point and the independently acknowledged
-- stop for the execution. A point may have first arrived before that stop.
ALTER TABLE attempt_evidence_storage_policy ADD COLUMN hz_settled_receipts_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE FUNCTION clear_disabled_hz_settled_receipts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.hz_worker_only OR NOT NEW.hz_retained_enabled OR NOT NEW.shortening_enabled
    THEN NEW.hz_settled_receipts_enabled := false; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hz_settled_receipts_policy_clear BEFORE UPDATE ON attempt_evidence_storage_policy
 FOR EACH ROW EXECUTE FUNCTION clear_disabled_hz_settled_receipts();
--> statement-breakpoint
ALTER TABLE attempt_evidence_storage_policy ADD CONSTRAINT hz_settled_receipt_role
 CHECK (NOT hz_settled_receipts_enabled OR hz_retained_enabled);
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_settled_scope(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET join_collapse_limit=1 AS $$
  SELECT (SELECT jsonb_build_object('contract','settled-receipt-v3','instance',cfg.instance_id,
    'solver',solver.id,'promise',p.id,'job',j.id,'attempt',a.id,'result',r.id,
    'hubAttempt',h.receipt->>'resultAttemptId','hubResult',h.receipt->>'resultId','storageOnly',h.receipt->'storageOnly',
    'assignment',intent.assignment_signature,'sequence',w.sequence,'report',w.content_signature,
    'point',h.point_content_signature,'stopSequence',head.sequence,'stopReport',head.content_signature,
    'archive',ar.id,'selectionSha256',attempt_evidence_hz_selection_sha256(a.id))
  FROM result_attempts a
  JOIN results r ON r.id=a.result_id AND r.airfoil_id=a.airfoil_id AND r.bc_id=a.bc_id AND r.aoa_deg=a.aoa_deg
    AND r.simulation_preset_revision_id=a.simulation_preset_revision_id
  JOIN sim_jobs j ON j.id=a.sim_job_id AND j.engine_job_id=j.id::text AND a.engine_job_id=j.engine_job_id
    AND j.airfoil_id=a.airfoil_id AND j.simulation_preset_revision_id=a.simulation_preset_revision_id AND j.bc_ids ? a.bc_id::text
  JOIN sync_api_settings cfg ON cfg.id=1 AND cfg.remote_solver_enabled AND j.request_payload->>'upstreamBaseUrl'=cfg.upstream_base_url
  JOIN registered_remote_solvers solver ON solver.id=cfg.remote_solver_registered_id AND solver.instance_id=cfg.instance_id::text AND solver.revoked_at IS NULL
  JOIN sync_sweep_promises p ON p.id=CASE WHEN j.request_payload->>'syncPromiseId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN (j.request_payload->>'syncPromiseId')::uuid END
    AND p.registered_solver_id=solver.id AND p.source_base_url=cfg.upstream_base_url
    AND p.airfoil_id=a.airfoil_id AND p.simulation_preset_revision_id=a.simulation_preset_revision_id
    AND p.status IN ('expired','cancelled','fulfilled')
  JOIN progressive_worker_submission_intents intent ON intent.sim_job_id=j.id
    AND intent.authorization @> jsonb_build_object('kind','authorized','executionId',j.id,'contentSignature',intent.assignment_signature)
    AND j.request_payload#>>'{remoteProgressiveExecution,contentSignature}'=intent.assignment_signature
    AND j.request_payload#>>'{remoteProgressiveExecution,scope,executionId}'=j.id::text
    AND j.request_payload#>>'{remoteProgressiveExecution,promiseId}'=p.id::text
    AND j.request_payload#>>'{remoteProgressiveExecution,solverId}'=solver.id::text
    AND j.request_payload->'engineRequest'=j.request_payload#>'{remoteProgressiveExecution,request}'
  JOIN progressive_worker_hub_receipts h ON h.result_attempt_id=a.id AND h.sim_job_id=j.id
    AND h.receipt @> jsonb_build_object('version',1,'kind','retained-progressive-attempt',
      'remoteResultAttemptId',a.id,'remoteResultId',r.id,'executionId',j.id,'sequence',h.sequence,'pointContentSignature',h.point_content_signature)
    AND jsonb_typeof(h.receipt->'storageOnly')='boolean'
    AND h.receipt->>'resultId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
    AND h.receipt->>'resultAttemptId' ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
  JOIN progressive_worker_evidence_attempts ea ON ea.sim_job_id=j.id AND ea.result_attempt_id=a.id
    AND ea.sequence=h.sequence AND ea.point_content_signature=h.point_content_signature
  JOIN progressive_worker_evidence_receipts er ON er.sim_job_id=j.id AND er.sequence=ea.sequence
  JOIN progressive_worker_reports w ON w.sim_job_id=j.id AND w.sequence=ea.sequence AND w.content_signature=er.content_signature
    AND w.assignment_signature=intent.assignment_signature AND w.acknowledged_at IS NOT NULL
  JOIN LATERAL (SELECT z.sequence,z.content_signature,z.assignment_signature,z.acknowledged_at,z.stopped_engine_job_id
    FROM progressive_worker_reports z WHERE z.sim_job_id=j.id ORDER BY z.sequence DESC LIMIT 1) head
    ON head.assignment_signature=w.assignment_signature AND head.acknowledged_at IS NOT NULL AND head.stopped_engine_job_id=j.id::text
  JOIN LATERAL (SELECT g.id FROM attempt_evidence_archives g WHERE g.result_attempt_id=a.id AND g.result_id=r.id AND g.sim_job_id=j.id
    AND g.source_instance=cfg.instance_id::text AND (p_archive IS NULL OR g.id=p_archive)
    AND g.source_byte_size BETWEEN 1 AND 8388608 AND g.stored_byte_size BETWEEN 1 AND 1048576
    AND g.object_key=concat('attempt-evidence/v1/',g.source_instance,'/',a.id,'/',g.source_sha256,'/',g.stored_sha256,'.json.gz')
    AND CASE WHEN a.evidence_archive_id IS NULL THEN g.source_byte_size=octet_length(a.evidence_payload::text)
      AND g.source_sha256=encode(sha256(convert_to(a.evidence_payload::text,'UTF8')),'hex') ELSE g.id=a.evidence_archive_id END
    ORDER BY g.verified_at DESC,g.id LIMIT 1) ar ON true
  WHERE a.id=p_id AND ((a.status='done' AND a.source='solved') OR (a.status='failed' AND a.source='queued'))
    AND j.status IN ('done','failed','cancelled') AND j.engine_state IN ('completed','failed','cancelled') AND j."ingestedAt" IS NOT NULL
    AND j.request_payload->>'remoteSolver'='true' AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=statement_timestamp())
    AND NOT EXISTS(SELECT FROM progressive_worker_report_conflicts q WHERE q.sim_job_id=j.id AND q.sequence IN(w.sequence,head.sequence))
    AND NOT EXISTS(SELECT FROM progressive_worker_evidence_delivery_claims q WHERE q.sim_job_id=j.id AND (q.claim_expires_at IS NULL OR q.claim_expires_at>statement_timestamp()))
    AND NOT EXISTS(SELECT FROM progressive_worker_delivery_failures q WHERE q.sim_job_id=j.id AND q.point_content_signature=h.point_content_signature)
    AND NOT EXISTS(SELECT FROM sync_remote_result_deliveries q WHERE (q.result_attempt_id=a.id OR q.sim_job_id=j.id) AND q.state NOT IN ('delivered','superseded','conflict'))
    -- Repair binds the engine job, case, manifest SHA and inline fidelity. A
    -- blocked render retains those exact inputs and its original disposition.
    AND NOT EXISTS(SELECT FROM result_media_repairs q WHERE q.result_attempt_id=a.id AND q.state='running'
      AND (q.claim_expires_at IS NULL OR q.claim_expires_at>statement_timestamp()))
    AND NOT EXISTS(SELECT FROM progressive_cfd_evidence q WHERE q.result_attempt_id=a.id)
    AND NOT EXISTS(SELECT FROM progressive_cfd_evidence_reuses q WHERE q.source_result_attempt_id=a.id)
    AND NOT EXISTS(SELECT FROM progressive_cfd_budget_extensions q WHERE q.source_result_attempt_id=a.id)
    AND NOT EXISTS(SELECT FROM progressive_cfd_recovery_plans q WHERE q.diagnostic_attempt_id=a.id)
    AND NOT EXISTS(SELECT FROM progressive_polar_model_evidence q WHERE q.result_attempt_id=a.id)
    AND NOT EXISTS(SELECT FROM sim_urans_requests q WHERE q.continue_from_result_attempt_id=a.id)
    AND NOT EXISTS(SELECT FROM sim_urans_verify_queue q WHERE q.precalc_result_attempt_id=a.id OR q.latest_result_attempt_id=a.id)
    AND NOT EXISTS(SELECT FROM sim_precalc_obligation_attempts q WHERE q.result_attempt_id=a.id)
    AND NOT EXISTS(SELECT FROM sim_rans_polar_promotions q WHERE q.trigger_result_attempt_id=a.id));
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_settled_limiter(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE scope jsonb; enough boolean;
BEGIN
  IF EXISTS(SELECT FROM result_attempts WHERE id=p_id AND evidence_archive_id IS NOT NULL) THEN RETURN 'already-shortened'; END IF;
  scope:=attempt_evidence_hz_settled_scope(p_id,p_archive);
  IF scope IS NULL THEN RETURN 'missing-settled-worker-source'; END IF;
  SELECT ar.history_byte_size>=p.min_logical_bytes AND ar.source_byte_size-octet_length(attempt_evidence_compact(a.evidence_payload)::text)>=p.min_logical_bytes
  INTO enough FROM attempt_evidence_archives ar JOIN result_attempts a ON a.id=ar.result_attempt_id
    JOIN attempt_evidence_storage_policy p ON p.id=1 WHERE ar.id=(scope->>'archive')::uuid AND a.id=p_id;
  IF enough IS DISTINCT FROM true THEN RETURN 'insufficient-logical-bulk'; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_hz_scope(uuid) RENAME TO attempt_evidence_hz_pre_settled_scope;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_scope(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE archived uuid; verifier text;
BEGIN
  SELECT a.evidence_archive_id,e.verification#>>'{dependencies,verifier}' INTO archived,verifier FROM result_attempts a
    LEFT JOIN attempt_evidence_storage_events e ON e.id=a.evidence_storage_event_id AND e.archive_id=a.evidence_archive_id WHERE a.id=p_id;
  IF archived IS NOT NULL THEN
    IF verifier='server-consumers/hz-settled-receipt-v3' THEN RETURN attempt_evidence_hz_settled_scope(p_id,archived); END IF;
  ELSIF (SELECT hz_settled_receipts_enabled FROM attempt_evidence_storage_policy WHERE id=1) THEN
    RETURN coalesce(attempt_evidence_hz_settled_scope(p_id),attempt_evidence_hz_pre_settled_scope(p_id));
  END IF;
  RETURN attempt_evidence_hz_pre_settled_scope(p_id);
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_hz_limiter(uuid,uuid) RENAME TO attempt_evidence_hz_pre_settled_limiter;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_supported_limiter(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE reason text;
BEGIN
  reason:=attempt_evidence_hz_settled_limiter(p_id,p_archive);
  IF reason='missing-settled-worker-source' THEN RETURN attempt_evidence_hz_retained_limiter(p_id,p_archive); END IF;
  RETURN reason;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_limiter(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF (SELECT hz_settled_receipts_enabled FROM attempt_evidence_storage_policy WHERE id=1)
    THEN RETURN attempt_evidence_hz_supported_limiter(p_id,p_archive); END IF;
  RETURN attempt_evidence_hz_pre_settled_limiter(p_id,p_archive);
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_verification_valid(uuid,uuid,jsonb) RENAME TO attempt_evidence_pre_settled_worker_verification;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_verification_valid(p_id uuid,p_archive uuid,p_proof jsonb) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE ar attempt_evidence_archives%ROWTYPE; d jsonb:=p_proof->'direct'; app jsonb:=p_proof->'app'; deps jsonb:=p_proof->'dependencies'; scope jsonb;
BEGIN
  IF deps->>'verifier' IS DISTINCT FROM 'server-consumers/hz-settled-receipt-v3' THEN RETURN attempt_evidence_pre_settled_worker_verification(p_id,p_archive,p_proof); END IF;
  IF NOT (SELECT hz_settled_receipts_enabled AND hz_worker_only AND shortening_enabled FROM attempt_evidence_storage_policy WHERE id=1)
    OR octet_length(p_proof::text)>8192 THEN RETURN false; END IF;
  SELECT * INTO ar FROM attempt_evidence_archives WHERE id=p_archive AND result_attempt_id=p_id;
  scope:=attempt_evidence_hz_settled_scope(p_id,p_archive);
  RETURN coalesce(scope IS NOT NULL AND scope->>'archive'=ar.id::text AND deps->'workerScope'=scope
    AND scope->>'selectionSha256' ~ '^[a-f0-9]{64}$' AND deps->>'jobDecisionsSha256' ~ '^[a-f0-9]{64}$'
    AND deps->>'applicationSha256' ~ '^[a-f0-9]{64}$'
    AND d @> jsonb_build_object('attemptId',p_id,'archiveId',ar.id,'bucket',ar.bucket,'objectKey',ar.object_key,'generation',ar.generation,
        'storedSha256',ar.stored_sha256,'storedByteSize',ar.stored_byte_size,'crc32c',ar.crc32c,'sourceSha256',ar.source_sha256,'sourceByteSize',ar.source_byte_size)
    AND (d->>'verifiedAt')::timestamptz BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()+interval '5 seconds'
    AND app @> jsonb_build_object('source','worker-volume','attemptId',p_id,'archiveId',ar.id,'forceArchive',true,'sourceSha256',ar.source_sha256,'sourceByteSize',ar.source_byte_size)
    AND (app->>'verifiedAt')::timestamptz BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()+interval '5 seconds'
    AND deps @> jsonb_build_object('contractVersion',1,'attemptId',p_id,'archiveId',ar.id,'sourceSha256',ar.source_sha256,
      'classificationEquivalent',true,'equalityEquivalent',true,'scientificEquivalent',true,'readDependenciesSatisfied',true),false);
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN RETURN false;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hz_settled_receipt_source_lock BEFORE INSERT ON attempt_evidence_storage_events
 FOR EACH ROW WHEN (NEW.action='shorten' AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/hz-settled-receipt-v3')
 EXECUTE FUNCTION lock_hz_attempt_receipt_source();
--> statement-breakpoint
CREATE TRIGGER hz_settled_receipt_post_readback BEFORE UPDATE OF app_readback_at ON attempt_evidence_storage_events
 FOR EACH ROW WHEN (OLD.app_readback_at IS NULL AND NEW.app_readback_at IS NOT NULL
   AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/hz-settled-receipt-v3')
 EXECUTE FUNCTION require_hz_retained_post_readback();
