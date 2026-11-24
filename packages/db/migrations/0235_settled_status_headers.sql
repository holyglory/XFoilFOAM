-- The report row remains the delivery identity. Its immutable archive member
-- still owns the original PostgreSQL text and original content signature.
CREATE FUNCTION progressive_settled_status_header(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path=pg_catalog,public AS $$
  SELECT CASE WHEN
    value @> '{"version":1,"archivedReport":true,"result":null,"stopProof":null,"status":{"state":"running","completed_cases":0}}'::jsonb
    AND value->>'promiseId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND value->>'solverId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND value->>'assignmentSignature' ~ '^[0-9a-f]{64}$'
    AND s->>'job_id'=value->>'executionId' AND jsonb_typeof(s->'total_cases')='number'
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
CREATE TABLE progressive_status_header_cursors (
  source_kind text PRIMARY KEY CHECK (source_kind IN ('worker','remote')),
  sim_job_id uuid,
  sequence bigint,
  CHECK ((sim_job_id IS NULL)=(sequence IS NULL)),
  CHECK (sequence IS NULL OR sequence>0)
);
INSERT INTO progressive_status_header_cursors(source_kind) VALUES ('worker'),('remote');
--> statement-breakpoint
-- Rows and archive/catalog identities are never deleted. Check the original owner
-- again when a phase changes between cold storage I/O and the short update.
CREATE FUNCTION progressive_status_header_settled(
  p_kind text, p_job uuid, p_seq bigint, p_signature text, p_header jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_header->>'executionId' IS DISTINCT FROM p_job::text OR p_header->>'sequence' IS DISTINCT FROM p_seq::text
    OR public.progressive_settled_status_header(p_header) IS NULL THEN RETURN false; END IF;
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

--> statement-breakpoint
-- Intermediate UPDATE input is the exact PostgreSQL original obtained from the
-- normal role-aware reader. A bare compact header can never authorize this write.
-- Normalization, archive registration, conflict aliases and acknowledgments keep
-- their original guards. The input envelope cannot satisfy either report table's
-- version/execution/sequence CHECK constraint if this trigger is unavailable.
CREATE FUNCTION authenticate_progressive_status_header() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  who text:=TG_ARGV[0];
  target jsonb;
  original text;
  status_budget jsonb;
  scheduling jsonb;
  pin record;
BEGIN
  target:=public.progressive_settled_status_header(OLD.report);
  IF target IS NOT NULL AND NEW.report=target THEN
    RAISE EXCEPTION 'Archived status is immutable without its exact original';
  END IF;
  IF NOT (NEW.report ? 'statusHeaderOriginalText') THEN RETURN NEW; END IF;
  IF target IS NULL OR jsonb_typeof(NEW.report->'statusHeaderOriginalText') IS DISTINCT FROM 'string'
    OR NEW.report-ARRAY['statusHeaderOriginalText','generation','storedSha256']<>'{}'::jsonb
    OR NEW.archived_at IS DISTINCT FROM OLD.archived_at OR NEW.archive_bundle_id IS DISTINCT FROM OLD.archive_bundle_id
    OR OLD.result_payload_hash IS NOT NULL OR NEW.result_payload_hash IS NOT NULL
    OR (NEW.sim_job_id,NEW.sequence,NEW.content_signature) IS DISTINCT FROM (OLD.sim_job_id,OLD.sequence,OLD.content_signature)
  THEN RAISE EXCEPTION 'Invalid archived status transition'; END IF;
  original:=NEW.report->>'statusHeaderOriginalText';
  SELECT m.report_sha256,m.report_byte_size INTO pin FROM public.progressive_report_archive_members m
    JOIN public.progressive_report_archive_bundles b ON b.id=m.bundle_id AND b.sim_job_id=m.sim_job_id AND b.source_kind=m.source_kind
    WHERE m.bundle_id=OLD.archive_bundle_id AND m.source_kind=who AND m.sim_job_id=OLD.sim_job_id
      AND m.member_kind='report' AND m.sequence=OLD.sequence AND m.content_signature=OLD.content_signature
      AND b.verified_at IS NOT NULL AND b.generation=NEW.report->>'generation' AND b.stored_sha256=NEW.report->>'storedSha256'
      AND OLD.sequence BETWEEN b.first_sequence AND b.last_sequence;
  IF NOT FOUND OR pin.report_byte_size<>octet_length(original)
    OR pin.report_sha256<>encode(sha256(convert_to(original,'UTF8')),'hex')
    OR public.progressive_report_compact_header(original::jsonb) IS DISTINCT FROM OLD.report
    OR (original::jsonb ? 'archivedReport')
  THEN RAISE EXCEPTION 'Archived status original or generation differs'; END IF;
  -- 0202 removed these two fields from the cold header. Inspect the exact
  -- original so new scheduling diagnostics or an exhausted case stay protected.
  scheduling:=original::jsonb#>'{status,scheduling}';
  IF scheduling IS NOT NULL AND scheduling<>'null'::jsonb THEN
    IF jsonb_typeof(scheduling)<>'object' THEN RETURN NULL; END IF;
    IF scheduling-ARRAY['requested_policy','resolved_policy','worker_cpu_budget','resolved_cpu_budget',
      'resolved_case_concurrency','solver_processes','mesh_build_count','aoa_case_count','mesh_reuse_mode','queue_depth']<>'{}'::jsonb
      OR EXISTS (SELECT FROM jsonb_each(scheduling) e WHERE jsonb_typeof(e.value) NOT IN ('string','number','null'))
      THEN RETURN NULL; END IF;
  END IF;
  status_budget:=original::jsonb#>'{status,solver_budget_progress}';
  IF status_budget IS NOT NULL AND status_budget<>'null'::jsonb THEN
    IF jsonb_typeof(status_budget) IS DISTINCT FROM 'object' OR status_budget->>'version' IS DISTINCT FROM '1'
      OR status_budget->>'job_id' IS DISTINCT FROM OLD.sim_job_id::text
      OR jsonb_typeof(status_budget->'observed_at') IS DISTINCT FROM 'string'
      OR jsonb_typeof(status_budget->'cases') IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
    IF status_budget-ARRAY['version','job_id','observed_at','cases']<>'{}'::jsonb THEN RETURN NULL; END IF;
    IF EXISTS (SELECT FROM jsonb_array_elements(status_budget->'cases') v
      WHERE CASE WHEN jsonb_typeof(v->'solver_active_seconds')='number' AND jsonb_typeof(v->'limit_seconds')='number'
        AND jsonb_typeof(v->'chord')='number' AND jsonb_typeof(v->'speed')='number' AND jsonb_typeof(v->'aoa_deg')='number'
        AND jsonb_typeof(v->'solver_running')='boolean'
        THEN v-ARRAY['chord','speed','aoa_deg','solver_active_seconds','limit_seconds','solver_running']<>'{}'::jsonb
          OR (v->>'solver_active_seconds')::numeric<0 OR (v->>'solver_active_seconds')::numeric>=(v->>'limit_seconds')::numeric
        ELSE true END) THEN RETURN NULL; END IF;
  END IF;
  IF pg_column_size(target) >= pg_column_size(OLD.report) THEN RETURN NULL; END IF;
  -- Publication locks the hub dispatch or worker job before ordering new rows.
  -- Never wait for a publisher or an ingester while holding the historical row.
  BEGIN
    IF who='remote' THEN
      PERFORM 1 FROM public.progressive_remote_dispatches d JOIN public.sim_jobs j ON j.id=d.sim_job_id
        JOIN public.sync_sweep_promises p ON p.id=d.promise_id JOIN public.registered_remote_solvers reg ON reg.id=d.solver_id
        WHERE d.sim_job_id=OLD.sim_job_id FOR SHARE OF d,j,p,reg NOWAIT;
    ELSE
      PERFORM 1 FROM public.sim_jobs j JOIN public.sync_api_settings cfg ON cfg.id=1
        JOIN public.sync_sweep_promises p ON p.id=(OLD.report->>'promiseId')::uuid
        WHERE j.id=OLD.sim_job_id FOR SHARE OF cfg,j,p NOWAIT;
    END IF;
    IF NOT FOUND OR NOT public.progressive_status_header_settled(who,OLD.sim_job_id,OLD.sequence,OLD.content_signature,OLD.report)
    THEN RETURN NULL; END IF;
  EXCEPTION WHEN lock_not_available THEN RETURN NULL;
  END;
  NEW.report:=target;
  RETURN NEW;
END;
$$;

--> statement-breakpoint
CREATE TRIGGER authenticate_archived_status_header BEFORE UPDATE ON progressive_remote_reports
FOR EACH ROW WHEN (OLD.archived_at IS NOT NULL AND NEW.report IS DISTINCT FROM OLD.report)
EXECUTE FUNCTION authenticate_progressive_status_header('remote');
--> statement-breakpoint
CREATE TRIGGER authenticate_archived_status_header BEFORE UPDATE ON progressive_worker_reports
FOR EACH ROW WHEN (OLD.archived_at IS NOT NULL AND NEW.report IS DISTINCT FROM OLD.report)
EXECUTE FUNCTION authenticate_progressive_status_header('worker');

--> statement-breakpoint
-- WHEN is evaluated after the preceding authenticator. Skip the original body
-- mutation guard only for its deterministic projection, never for an identity,
-- pointer, receiver timestamp, acknowledgement, or dictionary change.
CREATE FUNCTION progressive_verified_status_transition(
  old_report jsonb,new_report jsonb,old_bundle uuid,new_bundle uuid,
  old_at timestamptz,new_at timestamptz,old_hash text,new_hash text
) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,public AS $$
  SELECT CASE WHEN old_at IS NOT NULL AND old_at IS NOT DISTINCT FROM new_at
    AND old_bundle IS NOT NULL AND old_bundle IS NOT DISTINCT FROM new_bundle
    AND old_hash IS NULL AND new_hash IS NULL AND old_report IS DISTINCT FROM new_report
    THEN coalesce(new_report=public.progressive_settled_status_header(old_report),false) ELSE false END
$$;

--> statement-breakpoint
CREATE OR REPLACE TRIGGER progressive_worker_report_immutable BEFORE UPDATE ON progressive_worker_reports
FOR EACH ROW WHEN (NOT (
  (OLD.sim_job_id,OLD.sequence,OLD.content_signature,OLD.created_at,OLD.acknowledged_at)
    IS NOT DISTINCT FROM (NEW.sim_job_id,NEW.sequence,NEW.content_signature,NEW.created_at,NEW.acknowledged_at)
  AND progressive_verified_status_transition(OLD.report,NEW.report,OLD.archive_bundle_id,NEW.archive_bundle_id,
       OLD.archived_at,NEW.archived_at,OLD.result_payload_hash,NEW.result_payload_hash)))
EXECUTE FUNCTION protect_progressive_worker_report();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER progressive_remote_reports_immutable BEFORE UPDATE ON progressive_remote_reports
FOR EACH ROW WHEN (NOT (
  (OLD.sim_job_id,OLD.sequence,OLD.content_signature,OLD.received_at)
    IS NOT DISTINCT FROM (NEW.sim_job_id,NEW.sequence,NEW.content_signature,NEW.received_at)
  AND progressive_verified_status_transition(OLD.report,NEW.report,OLD.archive_bundle_id,NEW.archive_bundle_id,
       OLD.archived_at,NEW.archived_at,OLD.result_payload_hash,NEW.result_payload_hash)))
EXECUTE FUNCTION protect_progressive_remote_report();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER protect_archived_progressive_remote_body BEFORE UPDATE OF report,result_payload_hash ON progressive_remote_reports
FOR EACH ROW WHEN (NOT progressive_verified_status_transition(OLD.report,NEW.report,OLD.archive_bundle_id,NEW.archive_bundle_id,
       OLD.archived_at,NEW.archived_at,OLD.result_payload_hash,NEW.result_payload_hash))
EXECUTE FUNCTION protect_archived_progressive_remote_body();
