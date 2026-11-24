-- A running status can report completed assignment angles without owning their
-- scientific results. Count distinct angles from real earlier sources under
-- their immutable delivery receipts. Repeated reports of one angle count once.
CREATE FUNCTION progressive_status_completed_angles_receipted(
  p_kind text,p_job uuid,p_seq bigint,p_header jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE
  completed numeric:=(p_header#>>'{status,completed_cases}')::numeric;
  assignment jsonb;
  units jsonb;
  covered bigint;
BEGIN
  -- The caller has already checked the numeric values and the 0235 owner/stop
  -- guards. Zero completed cases require no point receipts.
  IF completed=0 THEN RETURN true; END IF;
  IF p_kind='remote' THEN
    SELECT d.envelope INTO assignment FROM public.progressive_remote_dispatches d WHERE d.sim_job_id=p_job;
  ELSIF p_kind='worker' THEN
    SELECT j.request_payload->'remoteProgressiveExecution' INTO assignment FROM public.sim_jobs j WHERE j.id=p_job;
  ELSE RETURN false; END IF;
  units:=assignment#>'{scope,units}';
  IF assignment->>'contentSignature' IS DISTINCT FROM p_header->>'assignmentSignature'
    OR assignment->>'promiseId' IS DISTINCT FROM p_header->>'promiseId'
    OR assignment->>'solverId' IS DISTINCT FROM p_header->>'solverId'
    OR assignment#>>'{scope,executionId}' IS DISTINCT FROM p_job::text
    OR jsonb_typeof(units) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(units)<>(p_header#>>'{status,total_cases}')::numeric THEN RETURN false; END IF;

  IF p_kind='worker' THEN
    SELECT count(DISTINCT u->'alpha') INTO covered
    FROM public.progressive_worker_hub_receipts ack
    JOIN public.result_attempts a ON a.id=ack.result_attempt_id AND a.sim_job_id=ack.sim_job_id AND a.engine_job_id=p_job::text
    JOIN LATERAL jsonb_array_elements(units) u ON u->'alpha'=to_jsonb(a.aoa_deg)
    WHERE ack.sim_job_id=p_job AND ack.receipt->>'executionId'=p_job::text
      AND ack.receipt->>'pointContentSignature'=ack.point_content_signature
      AND jsonb_typeof(ack.receipt->'receivedAt')='string' AND jsonb_typeof(ack.receipt->'sequence')='number'
      AND (
        (ack.receipt->>'kind'='retained-progressive-attempt' AND ack.receipt->>'version'='1'
         AND ack.receipt->>'remoteResultAttemptId'=a.id::text AND ack.receipt->>'remoteResultId'=a.result_id::text)
        OR (ack.receipt->>'kind'='retained-progressive-diagnostic'
          AND (ack.receipt->>'version'='1' OR (ack.receipt->>'version'='2' AND ack.receipt->>'failureKind' IN ('infrastructure','hard_solver'))
            OR (ack.receipt->>'version'='3' AND ack.receipt->>'custody'='terminal_history'
              AND ack.receipt->>'failureKind'='infrastructure' AND ack.receipt->>'attemptToken'=u->>'token'))
          AND EXISTS (SELECT FROM public.progressive_worker_reports anchor WHERE anchor.sim_job_id=p_job
            AND anchor.sequence::text=ack.receipt->>'sequence' AND anchor.content_signature=ack.receipt->>'reportContentSignature'))
      )
      AND EXISTS (SELECT FROM public.progressive_worker_evidence_attempts s
        JOIN public.progressive_worker_evidence_receipts staged USING (sim_job_id,sequence)
        JOIN public.progressive_worker_reports w ON w.sim_job_id=s.sim_job_id AND w.sequence=s.sequence
          AND w.content_signature=staged.content_signature
        WHERE s.sim_job_id=p_job AND s.result_attempt_id=a.id AND s.point_content_signature=ack.point_content_signature
          AND s.sequence<p_seq AND w.acknowledged_at IS NOT NULL AND w.assignment_signature=p_header->>'assignmentSignature'
          AND w.report->>'promiseId'=p_header->>'promiseId' AND w.report->>'solverId'=p_header->>'solverId'
          AND jsonb_typeof(w.report->'result')='object');
  ELSE
    WITH receipted AS (
      SELECT e.point_content_signature,a.aoa_deg,NULL::text AS attempt_token
      FROM public.progressive_remote_evidence_receipts e
      JOIN public.result_attempts a ON a.id=e.result_attempt_id AND a.sim_job_id=e.sim_job_id AND a.engine_job_id=p_job::text
      WHERE e.sim_job_id=p_job
      UNION ALL
      SELECT e.point_content_signature,s.aoa_deg,e.receipt->>'attemptToken'
      FROM public.progressive_remote_diagnostic_receipts e
      JOIN public.progressive_remote_report_sources s USING (sim_job_id,sequence,point_content_signature)
      JOIN public.progressive_remote_reports anchor ON anchor.sim_job_id=e.sim_job_id AND anchor.sequence=e.sequence
      WHERE e.sim_job_id=p_job AND e.receipt->>'kind'='retained-progressive-diagnostic'
        AND e.receipt->>'executionId'=p_job::text AND jsonb_typeof(e.receipt->'receivedAt')='string'
        AND e.receipt->>'sequence'=e.sequence::text AND e.receipt->>'reportContentSignature'=anchor.content_signature
        AND e.receipt->>'pointContentSignature'=e.point_content_signature
        AND (e.receipt->>'version'='1' OR (e.receipt->>'version'='2' AND e.receipt->>'failureKind' IN ('infrastructure','hard_solver'))
          OR (e.receipt->>'version'='3' AND e.receipt->>'custody'='terminal_history'
            AND e.receipt->>'failureKind'='infrastructure' AND e.receipt->>'attemptToken' IS NOT NULL))
    )
    SELECT count(DISTINCT u->'alpha') INTO covered FROM receipted e
    JOIN LATERAL jsonb_array_elements(units) u ON u->'alpha'=to_jsonb(e.aoa_deg)
      AND (e.attempt_token IS NULL OR e.attempt_token=u->>'token')
    WHERE EXISTS (SELECT FROM public.progressive_remote_report_sources s
      JOIN public.progressive_remote_report_inventories i USING (sim_job_id,sequence)
      JOIN public.progressive_remote_reports w ON w.sim_job_id=s.sim_job_id AND w.sequence=s.sequence
        AND i.report_content_signature=w.content_signature
      WHERE s.sim_job_id=p_job AND s.point_content_signature=e.point_content_signature AND s.aoa_deg=e.aoa_deg
        AND s.sequence<p_seq AND i.source_count>0 AND w.report->>'assignmentSignature'=p_header->>'assignmentSignature'
        AND w.report->>'promiseId'=p_header->>'promiseId' AND w.report->>'solverId'=p_header->>'solverId'
        AND jsonb_typeof(w.report->'result')='object');
  END IF;
  RETURN covered>=completed;
END;
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION progressive_settled_status_header(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog,public AS $$
  SELECT CASE WHEN
    value @> '{"version":1,"archivedReport":true,"result":null,"stopProof":null,"status":{"state":"running"}}'::jsonb
    AND value->>'promiseId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND value->>'solverId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND value->>'assignmentSignature' ~ '^[0-9a-f]{64}$'
    AND s->>'job_id'=value->>'executionId'
    AND CASE WHEN jsonb_typeof(s->'completed_cases')='number' AND jsonb_typeof(s->'total_cases')='number'
      THEN (s->>'completed_cases')::numeric=trunc((s->>'completed_cases')::numeric)
        AND (s->>'total_cases')::numeric=trunc((s->>'total_cases')::numeric)
        AND (s->>'completed_cases')::numeric BETWEEN 0 AND (s->>'total_cases')::numeric
        AND (s->>'total_cases')::numeric<=9007199254740991
      ELSE false END
    AND s->>'phase' IN ('waiting_cpu','meshing','solving_rans','solving_urans','postprocessing','ingesting')
    -- The engine's ordinary progress message is the phase with spaces. Keep
    -- arbitrary messages, failure classifications and unknown diagnostic fields.
    AND (s->>'message' IS NULL OR s->>'message'=replace(s->>'phase','_',' '))
    AND s->>'failure_disposition' IS NULL AND s->>'continuation_failure_kind' IS NULL
    AND s->>'solver_budget_error' IS NULL
    AND (s->'requested_engine' IS NULL OR s->'requested_engine'='null'::jsonb OR (s->'engine') @> (s->'requested_engine'))
    AND (s->>'requested_execution_pool' IS NULL OR s->>'execution_pool'=s->>'requested_execution_pool')
    AND value-ARRAY['version','solverId','promiseId','executionId','assignmentSignature',
                    'sequence','status','result','stopProof','archivedReport']='{}'::jsonb
    AND s-ARRAY['job_id','state','phase','total_cases','completed_cases','message','task_id','queued_at',
                'started_at','updated_at','phase_started_at','last_progress_at','active_solver','active_case_slug',
                'active_aoa_deg','active_pids','cpu_tokens_waiting','cpu_tokens_held','mesh_recovery_version',
                'failure_disposition','continuation_failure_kind','solver_budget_error','engine','requested_engine',
                'requested_execution_pool','execution_pool']='{}'::jsonb
  THEN jsonb_set(value,'{status}',jsonb_build_object('job_id',s->'job_id','state',s->'state',
                          'total_cases',s->'total_cases','completed_cases',s->'completed_cases'),false)
  END FROM (SELECT value->'status' AS s) h
$$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION progressive_status_header_settled(
  p_kind text, p_job uuid, p_seq bigint, p_signature text, p_header jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_header->>'executionId' IS DISTINCT FROM p_job::text OR p_header->>'sequence' IS DISTINCT FROM p_seq::text
    OR public.progressive_settled_status_header(p_header) IS NULL THEN RETURN false; END IF;
  IF NOT public.progressive_status_completed_angles_receipted(p_kind,p_job,p_seq,p_header) THEN RETURN false; END IF;
  IF p_kind='remote' THEN
    RETURN EXISTS (
      SELECT FROM public.progressive_remote_dispatches d
      JOIN public.sim_jobs j ON j.id=d.sim_job_id
      JOIN public.registered_remote_solvers reg ON reg.id=d.solver_id AND reg.revoked_at IS NULL
      JOIN public.sync_sweep_promises p ON p.id=d.promise_id AND p.registered_solver_id=d.solver_id
      JOIN public.progressive_remote_report_inventories i ON i.sim_job_id=j.id AND i.sequence=p_seq
        AND i.report_content_signature=p_signature AND i.source_count=0
      JOIN public.progressive_remote_progress_receipts applied ON applied.sim_job_id=j.id AND applied.sequence=p_seq AND applied.content_signature=p_signature
      WHERE j.id=p_job AND j.status IN ('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL
        AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=clock_timestamp())
        AND p.status IN ('expired','cancelled','fulfilled') AND d.solver_id::text=p_header->>'solverId'
        AND d.promise_id::text=p_header->>'promiseId' AND d.content_signature=p_header->>'assignmentSignature'
        AND NOT EXISTS (SELECT FROM public.sync_sweep_promise_points op WHERE op.promise_id=p.id AND op.status='active')
        AND EXISTS (SELECT FROM public.progressive_cfd_execution_stops stop WHERE stop.sim_job_id=j.id AND stop.engine_job_id=j.engine_job_id)
        AND EXISTS (SELECT FROM public.progressive_remote_reports later WHERE later.sim_job_id=j.id AND later.sequence>p_seq)
        AND NOT EXISTS (SELECT FROM public.progressive_remote_report_sources s WHERE s.sim_job_id=j.id AND s.sequence=p_seq)
        AND NOT EXISTS (SELECT FROM public.progressive_remote_evidence_receipts e WHERE e.sim_job_id=j.id AND e.sequence=p_seq)
        AND NOT EXISTS (SELECT FROM public.progressive_remote_diagnostic_receipts e WHERE e.sim_job_id=j.id AND e.sequence=p_seq)
    );
  ELSIF p_kind='worker' THEN
    RETURN EXISTS (
      SELECT FROM public.sim_jobs j JOIN public.sync_api_settings cfg ON cfg.id=1
      JOIN public.sync_sweep_promises p ON p.id=(p_header->>'promiseId')::uuid AND p.registered_solver_id=cfg.remote_solver_registered_id
      JOIN public.progressive_worker_reports w ON w.sim_job_id=j.id AND w.sequence=p_seq
        AND w.content_signature=p_signature AND w.acknowledged_at IS NOT NULL
      CROSS JOIN LATERAL (SELECT h.sequence,h.report,h.stopped_engine_job_id FROM public.progressive_worker_reports h
         WHERE h.sim_job_id=j.id ORDER BY h.sequence DESC LIMIT 1) last
      WHERE j.id=p_job AND j.engine_job_id=j.id::text AND j.request_payload->>'remoteSolver'='true'
        AND cfg.remote_solver_registered_id::text=p_header->>'solverId' AND p.source_base_url=cfg.upstream_base_url
        AND j.request_payload->>'upstreamBaseUrl'=cfg.upstream_base_url AND j.request_payload->>'syncPromiseId'=p.id::text
        AND j.request_payload#>>'{remoteProgressiveExecution,contentSignature}'=p_header->>'assignmentSignature'
        AND p.status IN ('expired','cancelled','fulfilled')
        AND NOT EXISTS (SELECT FROM public.sync_sweep_promise_points op WHERE op.promise_id=p.id AND op.status='active')
        AND public.progressive_worker_report_evidence_settled(p_job,p_seq)
        AND NOT EXISTS (SELECT FROM (SELECT DISTINCT point_content_signature FROM public.progressive_worker_evidence_attempts a WHERE a.sim_job_id=j.id) owner_source
          WHERE NOT EXISTS (SELECT FROM public.progressive_worker_hub_receipts ack WHERE ack.sim_job_id=j.id AND ack.point_content_signature=owner_source.point_content_signature)
          AND NOT EXISTS (SELECT FROM public.progressive_worker_delivery_failures f WHERE f.sim_job_id=j.id AND f.point_content_signature=owner_source.point_content_signature AND f.state='conflict'))
        AND last.sequence>p_seq AND last.stopped_engine_job_id=j.engine_job_id
        AND last.report->>'executionId'=j.id::text AND last.report->>'solverId'=p_header->>'solverId'
        AND last.report->>'promiseId'=p.id::text AND last.report->>'assignmentSignature'=p_header->>'assignmentSignature'
        AND last.report#>>'{status,state}' IN ('completed','failed','cancelled')
        AND last.report#>>'{stopProof,version}'='1' AND last.report#>>'{stopProof,job_id}'=j.engine_job_id
        AND last.report#>>'{stopProof,execution_stopped}'='true' AND last.report#>>'{stopProof,producer_stopped}'='true'
        AND last.report#>>'{stopProof,namespace_verified}'='true' AND last.report#>'{stopProof,remaining}'='[]'::jsonb
        AND last.report#>'{stopProof,error}'='null'::jsonb AND last.report#>>'{stopProof,observed_at}' IS NOT NULL
        AND last.report#>>'{stopProof,fence}' IN ('cancel_marker','terminal_result')
        AND (last.report#>>'{stopProof,ownership_basis}' IS NULL OR last.report#>>'{stopProof,ownership_basis}'='recorded_execution_namespace'
          OR (last.report#>>'{stopProof,ownership_basis}'='never_started_cancellation_fence' AND last.report#>>'{stopProof,fence}'='cancel_marker'))
        AND NOT EXISTS (SELECT FROM public.progressive_worker_evidence_delivery_claims c WHERE c.sim_job_id=j.id AND c.claim_expires_at>clock_timestamp())
        AND NOT EXISTS (SELECT FROM public.progressive_worker_delivery_failures f WHERE f.sim_job_id=j.id AND (f.state='retry' OR f.sequence=p_seq))
        AND NOT EXISTS (SELECT FROM public.progressive_worker_evidence_attempts e WHERE e.sim_job_id=j.id AND e.sequence=p_seq)
        AND NOT EXISTS (SELECT FROM public.progressive_worker_evidence_receipts e WHERE e.sim_job_id=j.id AND e.sequence=p_seq)
        AND NOT EXISTS (SELECT FROM public.progressive_worker_staging_failures e WHERE e.sim_job_id=j.id AND e.sequence=p_seq)
        -- 0203 enforces body_source_sequence=sequence for every alias. The PK covers both conflict forms.
        AND NOT EXISTS (SELECT FROM public.progressive_worker_report_conflicts c WHERE c.sim_job_id=j.id AND c.sequence=p_seq)
        AND NOT EXISTS (SELECT FROM public.progressive_worker_staging_copies s WHERE s.sim_job_id=j.id AND (s.sequence=p_seq OR s.source_sequence=p_seq))
        AND NOT EXISTS (SELECT FROM public.progressive_worker_report_science_proofs s WHERE s.sim_job_id=j.id AND s.sequence=p_seq)
        AND NOT EXISTS (SELECT FROM public.progressive_worker_hub_report_links l WHERE l.sim_job_id=j.id AND l.sequence=p_seq)
        AND NOT EXISTS (SELECT FROM public.progressive_worker_report_result_anchors x WHERE x.sim_job_id=j.id AND (x.sequence=p_seq OR x.witness_sequence=p_seq))
    );
  END IF;
  RETURN false;
END;
$$;
