-- The new population is off until the hub has the stopped-receipt reader.
-- The original policy, net-value floor, fresh direct/app reads and restore
-- protocol continue to apply to both populations.
ALTER TABLE attempt_evidence_storage_policy
  ADD COLUMN stopped_progressive_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- A missing diagnostic reference otherwise scans the full recovery recipe
-- table for every candidate and every locked recheck.
-- The diagnostic UUIDs are unordered. A small Bloom summary per 16 pages
-- avoids a full secondary B-tree for this overwhelmingly negative lookup.
CREATE INDEX progressive_recovery_diagnostic_attempt_idx ON progressive_cfd_recovery_plans
  USING brin(diagnostic_attempt_id uuid_bloom_ops(n_distinct_per_range=128,false_positive_rate=0.001))
  WITH (pages_per_range=16,autosummarize=on)
  WHERE diagnostic_attempt_id IS NOT NULL;
--> statement-breakpoint
-- The candidate check probes a single UUID. Random UUID correlation can make
-- the planner prefer a full heap scan even for a negative Bloom lookup.
CREATE FUNCTION attempt_evidence_has_recovery_plan(p_id uuid) RETURNS boolean
LANGUAGE sql STRICT STABLE SET enable_seqscan=off AS $$
  SELECT EXISTS(SELECT FROM public.progressive_cfd_recovery_plans WHERE diagnostic_attempt_id=p_id)
$$;
--> statement-breakpoint
-- A storage-only receipt does not make an attempt a progressive fit source.
-- The model membership FK requires a CFD receipt. Recovery of a stage-2
-- source requires the last token on its unit. This cohort proves both a
-- different stage and a later token, independently of mutable unit state.
CREATE FUNCTION attempt_evidence_stopped_scope(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SET join_collapse_limit=1 AS $$
WITH owner AS MATERIALIZED (
  SELECT a.id,a.result_id,a.aoa_deg,a.engine_case_slug,j.id AS job_id,j.campaign_id,
    rr.sequence,rr.point_content_signature,rr.remote_result_id,rr.remote_result_attempt_id,
    d.solver_id,d.promise_id,d.content_signature AS assignment_signature,d.envelope->'scope' AS dispatch
  FROM result_attempts a
  JOIN results r ON r.id=a.result_id AND r.airfoil_id=a.airfoil_id AND r.aoa_deg=a.aoa_deg
    AND r.simulation_preset_revision_id=a.simulation_preset_revision_id
  JOIN sim_jobs j ON j.id=a.sim_job_id AND j.engine_job_id=j.id::text AND a.engine_job_id=j.id::text
    AND j.airfoil_id=a.airfoil_id AND j.simulation_preset_revision_id=a.simulation_preset_revision_id
  JOIN progressive_remote_evidence_receipts rr ON rr.result_attempt_id=a.id AND rr.sim_job_id=j.id AND rr.storage_only
  JOIN progressive_remote_dispatches d ON d.sim_job_id=j.id
  WHERE a.id=p_id AND a.status='done' AND a.source='solved' AND a.regime='rans' AND a.unsteady=false
    AND r.current_result_attempt_id IS DISTINCT FROM a.id AND j.status='cancelled' AND j."ingestedAt" IS NOT NULL
    AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=statement_timestamp())
), custody AS MATERIALIZED (
  SELECT o.*, report.content_signature AS report_signature,upload.id AS upload_id
  FROM owner o JOIN registered_remote_solvers solver ON solver.id=o.solver_id AND solver.revoked_at IS NULL
  JOIN sync_sweep_promises promise ON promise.id=o.promise_id AND promise.registered_solver_id=o.solver_id AND promise.status='cancelled'
  JOIN progressive_remote_reports report ON report.sim_job_id=o.job_id AND report.sequence=o.sequence
  JOIN progressive_remote_report_inventories inventory ON inventory.sim_job_id=o.job_id AND inventory.sequence=o.sequence
    AND inventory.report_content_signature=report.content_signature
  JOIN progressive_remote_report_sources member ON member.sim_job_id=o.job_id AND member.sequence=o.sequence
    AND member.point_content_signature=o.point_content_signature AND member.aoa_deg=o.aoa_deg AND member.case_slug=o.engine_case_slug
  JOIN sync_brokered_evidence_uploads upload ON upload.promise_id=o.promise_id AND upload.solver_id=o.solver_id
    AND upload.remote_result_id=o.remote_result_id AND upload.remote_result_attempt_id=o.remote_result_attempt_id
    AND upload.canonical_result_attempt_id=o.id AND upload.canonical_result_id=o.result_id
    AND upload.engine_job_id=o.job_id::text AND upload.state='bound'
), finished AS MATERIALIZED (
  SELECT o.*,pa.token,u.id AS unit_id,stop.proof_signature
  FROM custody o JOIN progressive_cfd_execution_stops stop ON stop.sim_job_id=o.job_id AND stop.engine_job_id=o.job_id::text
    AND stop.proof->>'ownership_basis'='recorded_execution_namespace' AND stop.proof->>'job_id'=o.job_id::text
    AND stop.proof->'execution_stopped'='true'::jsonb
  JOIN progressive_cfd_attempts pa ON pa.sim_job_id=o.job_id AND (o.dispatch->'tokens') ? pa.token::text
    AND pa.execution_recipe_id=o.dispatch->>'recipeId'
  JOIN progressive_cfd_units u ON u.id=pa.unit_id AND u.aoa_deg=o.aoa_deg
    AND (o.dispatch->'units') @> jsonb_build_array(jsonb_build_object('unitId',u.id,'token',pa.token,'alpha',u.aoa_deg))
  JOIN progressive_work w ON w.id=u.work_id AND w.target_id=o.dispatch->>'targetId' AND w.stage=3
  JOIN progressive_generations g ON g.id=w.generation_id AND g.id::text=o.dispatch->>'generationId'
    AND g.campaign_id=o.campaign_id AND g.epoch_id=stop.epoch_id AND g.epoch_id::text=o.dispatch->>'epochId'
  WHERE o.dispatch->'stage'='3'::jsonb AND pa.outcome IN ('failed','cancelled') AND pa.finished_at IS NOT NULL
    AND EXISTS (SELECT FROM progressive_cfd_attempts newer WHERE newer.unit_id=u.id
      AND (newer.started_at,newer.token)>(pa.started_at,pa.token))
)
SELECT (
  SELECT jsonb_build_object(
    'executionId',o.job_id,'solverId',o.solver_id,'promiseId',o.promise_id,
    'remoteResultId',o.remote_result_id,'remoteResultAttemptId',o.remote_result_attempt_id,
    'sequence',o.sequence,'reportContentSignature',o.report_signature,
    'pointContentSignature',o.point_content_signature,'assignmentSignature',o.assignment_signature,
    'stopSignature',o.proof_signature,'attemptToken',o.token,'unitId',o.unit_id,
    'brokerUploadId',o.upload_id,'aoaDeg',o.aoa_deg,'caseSlug',o.engine_case_slug)
  FROM finished o
  WHERE NOT EXISTS (SELECT FROM progressive_cfd_attempts live WHERE live.sim_job_id=o.job_id AND live.outcome='running')
    AND NOT EXISTS (SELECT FROM progressive_cfd_evidence e WHERE e.result_attempt_id=o.id)
    AND NOT EXISTS (SELECT FROM progressive_cfd_budget_extensions q WHERE q.source_result_attempt_id=o.id)
    AND NOT EXISTS (SELECT FROM progressive_cfd_evidence_reuses q WHERE q.source_result_attempt_id=o.id)
    AND NOT attempt_evidence_has_recovery_plan(o.id)
    AND NOT EXISTS (SELECT FROM sim_urans_requests q WHERE q.continue_from_result_attempt_id=o.id OR q.continue_from_result_id=o.result_id OR q.sim_job_id=o.job_id)
    AND NOT EXISTS (SELECT FROM sim_precalc_obligations q WHERE q.source_result_attempt_id=o.id OR q.source_result_id=o.result_id OR q.latest_sim_job_id=o.job_id)
    AND NOT EXISTS (SELECT FROM point_correction_runs q WHERE q.source_result_attempt_id=o.id)
    AND NOT EXISTS (SELECT FROM result_media_repairs q WHERE q.result_attempt_id=o.id)
    AND NOT EXISTS (SELECT FROM result_interpretations q WHERE q.result_attempt_id=o.id)
    AND NOT EXISTS (SELECT FROM sim_urans_verify_queue q WHERE q.precalc_result_attempt_id=o.id OR q.latest_result_attempt_id=o.id)
    AND NOT EXISTS (SELECT FROM sim_precalc_obligation_attempts q WHERE q.result_attempt_id=o.id)
    AND NOT EXISTS (SELECT FROM sim_rans_polar_promotions q WHERE q.trigger_result_attempt_id=o.id)
    AND NOT EXISTS (SELECT FROM sim_campaign_points q WHERE q.result_attempt_id=o.id)
    AND NOT EXISTS (SELECT FROM sync_remote_result_deliveries q WHERE q.result_attempt_id=o.id)
)
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_shortening_limiter(uuid,uuid) RENAME TO attempt_evidence_local_shortening_limiter;
--> statement-breakpoint
-- Read-only preview works before enabling the writer.
CREATE FUNCTION attempt_evidence_stopped_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE a result_attempts%ROWTYPE; ar attempt_evidence_archives%ROWTYPE; policy attempt_evidence_storage_policy%ROWTYPE;
        source_bytes integer; n integer;
BEGIN
  SELECT * INTO policy FROM attempt_evidence_storage_policy WHERE id=1;
  SELECT * INTO a FROM result_attempts WHERE id=attempt_id;
  IF NOT FOUND OR a.status IS DISTINCT FROM 'done' OR a.source IS DISTINCT FROM 'solved' OR a.regime IS DISTINCT FROM 'rans'
    THEN RETURN 'outside-stopped-progressive-cohort'; END IF;
  IF a.evidence_archive_id IS NOT NULL THEN RETURN 'already-shortened'; END IF;
  IF EXISTS (SELECT FROM attempt_evidence_storage_events e WHERE e.id=a.evidence_storage_event_id
    AND e.result_attempt_id=a.id AND e.action='restore' AND e.completed
    AND e.verification->>'reason'='original required for result publication') THEN RETURN 'returned-to-publication'; END IF;
  -- Reject on indexed catalog metadata before reading source arrays.
  IF NOT EXISTS (SELECT FROM attempt_evidence_archives ar0 WHERE ar0.result_attempt_id=attempt_id
    AND ar0.result_id=a.result_id AND ar0.sim_job_id=a.sim_job_id
    AND (archive_id IS NULL OR ar0.id=archive_id)
    AND ar0.source_byte_size<=policy.max_source_bytes AND ar0.history_byte_size>=policy.min_logical_bytes)
    THEN RETURN 'missing-bounded-source-archive'; END IF;
  IF attempt_evidence_stopped_scope(attempt_id) IS NULL THEN RETURN 'outside-stopped-progressive-cohort'; END IF;
  source_bytes:=octet_length(a.evidence_payload::text);
  IF source_bytes>policy.max_source_bytes THEN RETURN 'source-byte-limit'; END IF;
  SELECT ar0.* INTO ar FROM attempt_evidence_archives ar0 WHERE ar0.result_attempt_id=attempt_id
    AND ar0.result_id=a.result_id AND ar0.sim_job_id=a.sim_job_id AND (archive_id IS NULL OR ar0.id=archive_id)
    AND ar0.source_byte_size=source_bytes AND ar0.source_sha256=encode(sha256(convert_to(a.evidence_payload::text,'UTF8')),'hex')
    ORDER BY ar0.verified_at DESC,ar0.id LIMIT 1;
  IF NOT FOUND THEN RETURN 'archive-source-mismatch'; END IF;
  IF a.evidence_payload->'mesh_recovery_version' IS DISTINCT FROM '3'::jsonb
    OR a.evidence_payload->>'fidelity' IS DISTINCT FROM 'rans'
    OR jsonb_array_length(ar.history_series)<>4 OR EXISTS (
      SELECT FROM jsonb_array_elements(ar.history_series) s
      WHERE s#>>'{path,0}' IS DISTINCT FROM 'steady_history'
        OR jsonb_typeof(a.evidence_payload #> ARRAY['steady_history',s#>>'{path,1}']) IS DISTINCT FROM 'array'
    ) THEN RETURN 'unsupported-steady-shape'; END IF;
  n:=jsonb_array_length(a.evidence_payload#>'{steady_history,iterations}');
  IF n IS NULL OR n<1 OR EXISTS (SELECT FROM unnest(ARRAY['cl','cd','cm']) k
      WHERE jsonb_array_length(a.evidence_payload#>ARRAY['steady_history',k]) IS DISTINCT FROM n)
    THEN RETURN 'unaligned-steady-series'; END IF;
  IF source_bytes-octet_length(attempt_evidence_compact(a.evidence_payload)::text)<policy.min_logical_bytes
    THEN RETURN 'insufficient-logical-bulk'; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF (SELECT stopped_progressive_enabled FROM attempt_evidence_storage_policy WHERE id=1) AND EXISTS (
    SELECT FROM progressive_remote_evidence_receipts rr WHERE rr.result_attempt_id=attempt_id AND rr.storage_only
  ) THEN RETURN attempt_evidence_stopped_shortening_limiter(attempt_id,archive_id); END IF;
  RETURN attempt_evidence_local_shortening_limiter(attempt_id,archive_id);
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
    AND CASE v_deps->>'verifier'
      WHEN 'server-consumers/local-steady-rans-v1' THEN NOT EXISTS (
        SELECT FROM progressive_remote_evidence_receipts rr WHERE rr.result_attempt_id=p_id AND rr.storage_only)
      WHEN 'server-consumers/stopped-progressive-rans-v1' THEN
        v_deps->>'applicationSha256' ~ '^[0-9a-f]{64}$'
        AND v_deps->'progressiveScope'=attempt_evidence_stopped_scope(p_id)
        AND (SELECT stopped_progressive_enabled FROM attempt_evidence_storage_policy WHERE id=1)
      ELSE false END
    AND v_deps->'classificationEquivalent'='true'::jsonb AND v_deps->'equalityEquivalent'='true'::jsonb
    AND v_deps->'scientificEquivalent'='true'::jsonb AND v_deps->'readDependenciesSatisfied'='true'::jsonb,false);
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
  RETURN false;
END;
$$;
--> statement-breakpoint
-- A new numerical receipt must always be issued from the whole attempt. The
-- report recovery path restores its already authenticated original first.
CREATE FUNCTION require_inline_attempt_for_progressive_fit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT a.evidence_archive_id FROM result_attempts a WHERE a.id=NEW.result_attempt_id FOR SHARE) IS NOT NULL THEN
    RAISE EXCEPTION 'Restore the exact archived attempt before linking progressive CFD evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER progressive_cfd_evidence_full_source BEFORE INSERT ON progressive_cfd_evidence
  FOR EACH ROW EXECUTE FUNCTION require_inline_attempt_for_progressive_fit();
