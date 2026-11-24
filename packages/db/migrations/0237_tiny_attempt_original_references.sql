-- A registered original remains the source of the full attempt and the array
-- hashes. Only opted-in, genuinely nonempty small histories may trade metadata
-- bytes for removing the last inline arrays. Ordinary safety and economics
-- continue to apply to every other transition.
ALTER TABLE attempt_evidence_storage_policy
  ADD COLUMN tiny_histories_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN tiny_history_canary_attempt_id uuid,
  ADD CONSTRAINT tiny_attempt_history_policy CHECK(tiny_histories_enabled OR tiny_history_canary_attempt_id IS NULL);
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_tiny_selected(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT FROM attempt_evidence_storage_policy p
   JOIN attempt_evidence_archives g ON g.result_attempt_id=p_id AND (p_archive IS NULL OR g.id=p_archive)
   WHERE p.id=1 AND p.shortening_enabled AND p.consumer_contract_version=1 AND p.tiny_histories_enabled
     AND (p.tiny_history_canary_attempt_id IS NULL OR p.tiny_history_canary_attempt_id=p_id)
     AND (p.canary_attempt_id IS NULL OR p.canary_attempt_id=p_id)
     AND g.history_byte_size<4096 AND EXISTS(SELECT FROM jsonb_array_elements(g.history_series) leaf
       WHERE (leaf->>'byteSize')::bigint>2))
$$;
--> statement-breakpoint
-- Use the existing indexed archive/attempt owner and 0233 projection. Do not
-- copy either the complete working JSON or another set of its array digests.
ALTER FUNCTION attempt_evidence_short_proof_selected(uuid,uuid) RENAME TO attempt_evidence_0233_short_proof_selected;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_short_proof_selected(p_id uuid,p_archive uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT coalesce(attempt_evidence_0233_short_proof_selected(p_id,p_archive),false)
   OR attempt_evidence_tiny_selected(p_id,p_archive)
$$;
--> statement-breakpoint
-- The numeric timestamps encode the actual two independently observed
-- readbacks. A point and its terminal report can be the same signed source.
-- Encode the second identity by reference only when the fields really match.
ALTER FUNCTION attempt_evidence_expand_receipt(jsonb,attempt_evidence_archives) RENAME TO attempt_evidence_expand_0233_receipt;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_pack_tiny_receipt(v jsonb,ar attempt_evidence_archives) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE packed jsonb:=attempt_evidence_pack_receipt(v,ar); s jsonb:=packed->'shortReceipt';
        direct_time text:=s#>>'{times,0}'; app_time text:=s#>>'{times,1}'; t bigint; delta bigint;
        ws jsonb:=v#>'{dependencies,workerScope}'; flags integer:=0; scope jsonb; rest jsonb;
BEGIN
  IF s IS NULL OR direct_time IS NULL OR app_time IS NULL OR direct_time !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$'
    OR app_time !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' THEN RETURN packed; END IF;
  t:=(extract(epoch FROM direct_time::timestamptz)*1000)::bigint;
  delta:=(extract(epoch FROM app_time::timestamptz)*1000)::bigint-t;
  IF delta NOT BETWEEN -2147483648 AND 2147483647 THEN RETURN packed; END IF;
  IF ws IS NOT NULL THEN
    flags:=4;
    IF ws?'sequence' AND ws->'sequence'=ws->'stopSequence' THEN flags:=flags|1; ws:=ws-'stopSequence'; END IF;
    IF ws?'report' AND ws->'report'=ws->'stopReport' THEN flags:=flags|2; ws:=ws-'stopReport'; END IF;
    scope:=attempt_evidence_pack_scope(ws,attempt_evidence_scope_defaults(ar,ws->'selectionSha256'),true);
  ELSE scope:=s->'remote'; END IF;
  rest:=s-ARRAY['id','times','worker','remote'];
  -- The existing event FK pins this archive. Retain its binary UUID as well:
  -- even a direct decoder must reject a different owner with identical bytes.
  RETURN jsonb_set(packed,'{shortReceipt}',jsonb_build_array(
    encode(uuid_send(ar.id)||int8send(t)||int4send(delta::integer),'base64'),flags,scope,rest));
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_expand_receipt(v jsonb,ar attempt_evidence_archives) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE refs jsonb:=v->'shortReceipt'; header bytea; s jsonb; flags integer; t bigint; delta integer; result jsonb; ws jsonb;
BEGIN
  IF jsonb_typeof(refs) IS DISTINCT FROM 'array' THEN RETURN attempt_evidence_expand_0233_receipt(v,ar); END IF;
  header:=decode(refs->>0,'base64');
  IF octet_length(header) IS DISTINCT FROM 28 OR substring(header FROM 1 FOR 16) IS DISTINCT FROM uuid_send(ar.id)
    OR jsonb_array_length(refs)<>4 THEN
    RAISE EXCEPTION 'Tiny attempt receipt names another original'; END IF;
  t:=('x'||encode(substring(header FROM 17 FOR 8),'hex'))::bit(64)::bigint;
  delta:=('x'||encode(substring(header FROM 25 FOR 4),'hex'))::bit(32)::integer;
  flags:=(refs->>1)::integer;
  s:=(refs->3)||jsonb_build_object('id',ar.id,'times',jsonb_build_array(
    to_char(to_timestamp(t/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    to_char(to_timestamp((t+delta)/1000.0) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  IF (flags&4)<>0 THEN s:=s||jsonb_build_object('worker',refs->2);
  ELSIF refs->2<>'null'::jsonb THEN s:=s||jsonb_build_object('remote',refs->2); END IF;
  result:=attempt_evidence_expand_0233_receipt(jsonb_set(v,'{shortReceipt}',s),ar);
  IF (flags&3)<>0 THEN
    ws:=result#>'{dependencies,workerScope}';
    IF (flags&1)<>0 THEN ws:=ws||jsonb_build_object('stopSequence',ws->'sequence'); END IF;
    IF (flags&2)<>0 THEN ws:=ws||jsonb_build_object('stopReport',ws->'report'); END IF;
    result:=jsonb_set(result,'{dependencies,workerScope}',ws);
  END IF;
  RETURN result;
END;
$$;
--> statement-breakpoint
-- Views bind function OIDs. Rebind the existing public contract to the new
-- decoder, including all previously issued full and short receipts.
CREATE OR REPLACE VIEW attempt_evidence_read_events WITH (security_invoker=true) AS
 SELECT e.id,e.result_attempt_id,e.archive_id,e.action,e.transaction_id,attempt_evidence_expand_receipt(e.verification,ar) verification,
 e.source_stored_bytes,e.result_stored_bytes,e.projection_value_bytes,e.verification_value_bytes,e.net_value_bytes_saved,e.completed,e.app_readback_at,e.created_at
 FROM attempt_evidence_storage_events e JOIN attempt_evidence_archives ar ON ar.id=e.archive_id AND ar.result_attempt_id=e.result_attempt_id;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION store_short_attempt_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ar attempt_evidence_archives%ROWTYPE; packed jsonb; regular jsonb;
BEGIN
  IF NEW.verification?'shortReceipt' THEN RAISE EXCEPTION 'Submit full native readbacks for a short attempt receipt'; END IF;
  IF NEW.action<>'shorten' OR attempt_evidence_short_proof_selected(NEW.result_attempt_id,NEW.archive_id) IS NOT TRUE THEN RETURN NEW; END IF;
  SELECT * INTO STRICT ar FROM attempt_evidence_archives WHERE id=NEW.archive_id AND result_attempt_id=NEW.result_attempt_id;
  regular:=attempt_evidence_pack_receipt(NEW.verification,ar);
  IF ar.history_byte_size<4096 AND attempt_evidence_tiny_selected(NEW.result_attempt_id,ar.id) THEN
    packed:=attempt_evidence_pack_tiny_receipt(NEW.verification,ar);
    IF pg_column_size(packed)<pg_column_size(regular) AND attempt_evidence_expand_receipt(packed,ar)::text=NEW.verification::text THEN
      NEW.verification:=packed; RETURN NEW;
    END IF;
  END IF;
  IF attempt_evidence_expand_receipt(regular,ar)::text=NEW.verification::text THEN NEW.verification:=regular; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- The current route predicates below retain their original signed ownership,
-- scientific shape, maximum size and source-hash checks. Only the economic
-- minimum changes for an explicitly selected small registered source.
CREATE OR REPLACE FUNCTION attempt_evidence_receipt_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE a result_attempts%ROWTYPE; ar attempt_evidence_archives%ROWTYPE; policy attempt_evidence_storage_policy%ROWTYPE;
        src text; n integer;
BEGIN
  SELECT * INTO a FROM result_attempts WHERE id=attempt_id;
  IF NOT FOUND THEN RETURN 'missing-attempt'; END IF;
  IF a.evidence_archive_id IS NOT NULL THEN RETURN 'already-shortened'; END IF;
  IF attempt_evidence_receipt_scope(attempt_id) IS NULL THEN RETURN 'missing-exact-settled-progressive-receipt'; END IF;
  SELECT * INTO policy FROM attempt_evidence_storage_policy WHERE id=1;
  IF policy.tiny_histories_enabled AND attempt_evidence_tiny_selected(attempt_id,archive_id) THEN policy.min_logical_bytes:=1; END IF;
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
CREATE OR REPLACE FUNCTION attempt_evidence_urans_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE a result_attempts%ROWTYPE; ar attempt_evidence_archives%ROWTYPE; policy attempt_evidence_storage_policy%ROWTYPE;
        src text;
BEGIN
  SELECT * INTO a FROM result_attempts WHERE id=attempt_id;
  IF NOT FOUND THEN RETURN 'missing-attempt'; END IF;
  IF a.evidence_archive_id IS NOT NULL THEN RETURN 'already-shortened'; END IF;
  IF attempt_evidence_receipt_scope_for(attempt_id,true) IS NULL THEN RETURN 'missing-exact-settled-progressive-receipt'; END IF;
  SELECT * INTO policy FROM attempt_evidence_storage_policy WHERE id=1;
  IF policy.tiny_histories_enabled AND attempt_evidence_tiny_selected(attempt_id,archive_id) THEN policy.min_logical_bytes:=1; END IF;
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
CREATE OR REPLACE FUNCTION attempt_evidence_hz_settled_limiter(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE AS $$
DECLARE scope jsonb; enough boolean;
BEGIN
  IF EXISTS(SELECT FROM result_attempts WHERE id=p_id AND evidence_archive_id IS NOT NULL) THEN RETURN 'already-shortened'; END IF;
  scope:=attempt_evidence_hz_settled_scope(p_id,p_archive);
  IF scope IS NULL THEN RETURN 'missing-settled-worker-source'; END IF;
  SELECT (ar.history_byte_size>=p.min_logical_bytes AND ar.source_byte_size-octet_length(attempt_evidence_compact(a.evidence_payload)::text)>=p.min_logical_bytes)
    OR (p.tiny_histories_enabled AND attempt_evidence_tiny_selected(a.id,ar.id)
      AND ar.source_byte_size>octet_length(attempt_evidence_compact(a.evidence_payload)::text))
  INTO enough FROM attempt_evidence_archives ar JOIN result_attempts a ON a.id=ar.result_attempt_id
    JOIN attempt_evidence_storage_policy p ON p.id=1 WHERE ar.id=(scope->>'archive')::uuid AND a.id=p_id;
  IF enough IS DISTINCT FROM true THEN RETURN 'insufficient-logical-bulk'; END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_attempt_evidence_storage_event() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF NEW.net_value_bytes_saved<v_policy.min_net_value_bytes AND NOT coalesce((
      v_policy.tiny_histories_enabled AND attempt_evidence_tiny_selected(NEW.result_attempt_id,NEW.archive_id)
      AND NEW.verification?'shortReceipt' AND NOT (NEW.verification?'direct') AND NEW.verification#>>'{dependencies,verifier}' IN (
        'server-consumers/receipt-bearing-rans-v1','server-consumers/receipt-bearing-urans-v1',
        'server-consumers/hz-settled-receipt-v3','server-consumers/hz-closed-undelivered-v1')),false) THEN
      RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='Attempt shortening has insufficient net online value-byte savings';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- The exact staged point in an acknowledged stopped report can also have a
-- real, closed failed delivery. This proof keeps that failure and never supplies
-- a hub result, receipt, or publication. Use all existing owner and active-work guards.
CREATE FUNCTION attempt_evidence_hz_closed_failure_scope(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET join_collapse_limit=1 AS $$
  SELECT (SELECT jsonb_build_object('contract','closed-undelivered-v1','instance',cfg.instance_id,
    'solver',solver.id,'promise',p.id,'job',j.id,'attempt',a.id,'result',r.id,
    'failureHttp',h.last_http_status,'failureSha256',encode(sha256(convert_to(h.last_error,'UTF8')),'hex'),
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
  JOIN progressive_worker_delivery_failures h ON h.result_attempt_id=a.id AND h.sim_job_id=j.id
    AND h.state='conflict' AND h.last_http_status=409 AND h.remote_conflict_ids='[]'::jsonb
    AND h.last_error ~* '^(Progressive evidence|Stopped progressive storage) delivery failed \(409\): progressive_scope_closed( |$)'
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
    AND g.history_byte_size<4096 AND EXISTS(SELECT FROM jsonb_array_elements(g.history_series) leaf WHERE (leaf->>'byteSize')::bigint>2)
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
    AND NOT EXISTS(SELECT FROM progressive_worker_hub_receipts q WHERE q.sim_job_id=j.id AND
      (q.result_attempt_id=a.id OR q.point_content_signature=h.point_content_signature))
    AND EXISTS(SELECT FROM progressive_worker_evidence_attempts last_point WHERE last_point.sim_job_id=j.id
      AND last_point.sequence=head.sequence AND last_point.result_attempt_id=a.id AND last_point.point_content_signature=h.point_content_signature)
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
ALTER FUNCTION attempt_evidence_hz_supported_limiter(uuid,uuid) RENAME TO attempt_evidence_0224_hz_supported_limiter;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_supported_limiter(p_id uuid,p_archive uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE reason text;
BEGIN
  reason:=attempt_evidence_0224_hz_supported_limiter(p_id,p_archive);
  IF reason IS NOT NULL AND reason<>'already-shortened' AND attempt_evidence_tiny_selected(p_id,p_archive)
    AND EXISTS(SELECT FROM progressive_worker_delivery_failures f WHERE f.result_attempt_id=p_id AND f.state='conflict')
    AND attempt_evidence_hz_closed_failure_scope(p_id,p_archive) IS NOT NULL THEN RETURN NULL; END IF;
  RETURN reason;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_hz_scope(uuid) RENAME TO attempt_evidence_0224_hz_scope;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_hz_scope(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE normal jsonb:=attempt_evidence_0224_hz_scope(p_id);
BEGIN
  IF normal IS NOT NULL THEN RETURN normal; END IF;
  IF attempt_evidence_tiny_selected(p_id) THEN RETURN attempt_evidence_hz_closed_failure_scope(p_id); END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_verification_valid(uuid,uuid,jsonb) RENAME TO attempt_evidence_0224_verification_valid;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_verification_valid(p_id uuid,p_archive uuid,p_proof jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE ar attempt_evidence_archives%ROWTYPE; d jsonb:=p_proof->'direct'; app jsonb:=p_proof->'app';
        deps jsonb:=p_proof->'dependencies'; scope jsonb;
BEGIN
  IF deps->>'verifier' IS DISTINCT FROM 'server-consumers/hz-closed-undelivered-v1' THEN
    RETURN attempt_evidence_0224_verification_valid(p_id,p_archive,p_proof);
  END IF;
  IF NOT attempt_evidence_tiny_selected(p_id,p_archive) OR NOT EXISTS(SELECT FROM attempt_evidence_storage_policy
    WHERE id=1 AND hz_settled_receipts_enabled AND hz_worker_only AND shortening_enabled) THEN RETURN false; END IF;
  SELECT * INTO ar FROM attempt_evidence_archives WHERE id=p_archive AND result_attempt_id=p_id;
  scope:=attempt_evidence_hz_closed_failure_scope(p_id,p_archive);
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
CREATE FUNCTION lock_tiny_worker_failed_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sc jsonb;
BEGIN
  IF TG_OP='INSERT' THEN
    sc:=NEW.verification#>'{dependencies,workerScope}';
  ELSE
    SELECT v.verification#>'{dependencies,workerScope}' INTO STRICT sc FROM attempt_evidence_read_events v
      WHERE v.id=NEW.id AND v.result_attempt_id=NEW.result_attempt_id AND v.archive_id=NEW.archive_id;
  END IF;
  PERFORM FROM progressive_worker_delivery_failures f WHERE (f.sim_job_id,f.point_content_signature,f.result_attempt_id)
    =((sc->>'job')::uuid,sc->>'point',NEW.result_attempt_id) AND f.sequence=(sc->>'sequence')::bigint AND f.state='conflict'
    AND f.last_http_status=(sc->>'failureHttp')::integer AND f.remote_conflict_ids='[]'::jsonb
    AND encode(sha256(convert_to(f.last_error,'UTF8')),'hex')=sc->>'failureSha256' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Closed worker delivery changed before storage'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER tiny_undelivered_producer_lock BEFORE INSERT ON attempt_evidence_storage_events FOR EACH ROW
 WHEN (NEW.action='shorten' AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/hz-closed-undelivered-v1')
 EXECUTE FUNCTION lock_hz_retained_producer();
--> statement-breakpoint
CREATE TRIGGER tiny_undelivered_disposition_lock BEFORE INSERT ON attempt_evidence_storage_events FOR EACH ROW
 WHEN (NEW.action='shorten' AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/hz-closed-undelivered-v1')
 EXECUTE FUNCTION lock_tiny_worker_failed_delivery();
--> statement-breakpoint
CREATE TRIGGER tiny_undelivered_disposition_at_confirmation BEFORE UPDATE OF app_readback_at ON attempt_evidence_storage_events FOR EACH ROW
 WHEN (OLD.app_readback_at IS NULL AND NEW.app_readback_at IS NOT NULL
       AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/hz-closed-undelivered-v1')
 EXECUTE FUNCTION lock_tiny_worker_failed_delivery();
--> statement-breakpoint
CREATE TRIGGER tiny_undelivered_post_readback BEFORE UPDATE OF app_readback_at ON attempt_evidence_storage_events FOR EACH ROW
 WHEN (OLD.app_readback_at IS NULL AND NEW.app_readback_at IS NOT NULL
       AND NEW.verification#>>'{dependencies,verifier}'='server-consumers/hz-closed-undelivered-v1')
 EXECUTE FUNCTION require_hz_retained_post_readback();
