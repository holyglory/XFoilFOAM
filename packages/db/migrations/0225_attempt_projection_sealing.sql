-- The native event trigger rechecks the policy, scientific dependencies,
-- original identity and fresh readbacks under the source locks on every
-- insert. Building the immutable projection can occupy a separate bounded
-- statement in that same transaction for multi-megabyte originals.
CREATE FUNCTION attempt_evidence_seal_projection(p_id uuid,p_archive_id uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE policy attempt_evidence_storage_policy%ROWTYPE; current_archive uuid;
BEGIN
  SELECT * INTO policy FROM attempt_evidence_storage_policy WHERE id=1 FOR SHARE;
  IF policy.shortening_enabled IS DISTINCT FROM true OR policy.consumer_contract_version<>1 THEN
    RAISE EXCEPTION 'Attempt shortening consumer contract is disabled';
  END IF;
  IF policy.canary_attempt_id IS NOT NULL AND policy.canary_attempt_id<>p_id THEN
    RAISE EXCEPTION 'Attempt differs from the configured canary';
  END IF;
  PERFORM attempt_evidence_lock_source(p_id);
  SELECT evidence_archive_id INTO current_archive FROM result_attempts WHERE id=p_id;
  IF current_archive IS NOT NULL THEN
    IF current_archive<>p_archive_id THEN RAISE EXCEPTION 'Attempt shortening replay targets a different archive'; END IF;
    RETURN;
  END IF;
  -- A BEFORE INSERT trigger runs even on an ON CONFLICT no-op. Its complete
  -- source proof already exists for this exact immutable pair after a restore.
  INSERT INTO attempt_evidence_history_projections(result_attempt_id,archive_id)
    SELECT p_id,p_archive_id WHERE NOT EXISTS(SELECT FROM attempt_evidence_history_projections
      WHERE result_attempt_id=p_id AND archive_id=p_archive_id)
    ON CONFLICT DO NOTHING;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attempt_evidence_shorten(p_id uuid,p_archive_id uuid,p_verification jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE a result_attempts%ROWTYPE; projection jsonb; ev attempt_evidence_storage_events%ROWTYPE;
        policy attempt_evidence_storage_policy%ROWTYPE; stored_bytes bigint; original_text text;
        guard_message text; guard_prefix constant text:='Attempt storage event lacks eligible source and fresh full readback/consumer proofs: ';
BEGIN
  SELECT * INTO policy FROM attempt_evidence_storage_policy WHERE id=1 FOR SHARE;
  IF policy.shortening_enabled IS DISTINCT FROM true OR policy.consumer_contract_version<>1 THEN
    RAISE EXCEPTION 'Attempt shortening consumer contract is disabled';
  END IF;
  IF policy.canary_attempt_id IS NOT NULL AND policy.canary_attempt_id<>p_id THEN RAISE EXCEPTION 'Attempt differs from the configured canary'; END IF;
  PERFORM attempt_evidence_lock_source(p_id);
  SELECT r.* INTO a FROM result_attempts r WHERE r.id=p_id;
  IF a.evidence_archive_id IS NOT NULL THEN
    IF a.evidence_archive_id<>p_archive_id THEN RAISE EXCEPTION 'Attempt shortening replay targets a different archive'; END IF;
    SELECT * INTO ev FROM attempt_evidence_storage_events WHERE id=a.evidence_storage_event_id AND completed AND action='shorten';
    IF NOT FOUND THEN RAISE EXCEPTION 'Attempt shortening replay receipt is missing'; END IF;
    RETURN jsonb_build_object('eventId',ev.id,'attemptId',p_id,'archiveId',p_archive_id,'alreadyShortened',true,
      'payloadBytesReclaimed',0,'netValueBytesReclaimed',0);
  END IF;
  SELECT pg_column_size(r.evidence_payload) INTO stored_bytes FROM result_attempts r WHERE r.id=p_id;
  BEGIN
    INSERT INTO attempt_evidence_storage_events(result_attempt_id,archive_id,action,verification,source_stored_bytes)
      VALUES(p_id,p_archive_id,'shorten',p_verification,stored_bytes) RETURNING * INTO ev;
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS guard_message=MESSAGE_TEXT;
    -- Preserve the native writer's existing error contract. Other trigger
    -- failures retain their original message and SQLSTATE.
    IF guard_message=guard_prefix||'verification' THEN RAISE EXCEPTION 'Attempt shortening lacks fresh pinned GCS and usable app proofs'; END IF;
    IF starts_with(guard_message,guard_prefix) THEN RAISE EXCEPTION 'Attempt shortening limited: %',substr(guard_message,length(guard_prefix)+1); END IF;
    RAISE;
  END;
  SELECT p.projection INTO projection FROM attempt_evidence_history_projections p WHERE p.result_attempt_id=p_id AND p.archive_id=p_archive_id;
  IF NOT FOUND THEN
    -- Direct SQL clients can still complete the original single-statement operation.
    PERFORM attempt_evidence_seal_projection(p_id,p_archive_id);
    SELECT p.projection INTO projection FROM attempt_evidence_history_projections p WHERE p.result_attempt_id=p_id AND p.archive_id=p_archive_id;
  END IF;
  original_text:=a.evidence_payload::text;
  IF projection->>'sourceSha256' IS DISTINCT FROM encode(sha256(convert_to(original_text,'UTF8')),'hex') OR
    (projection->>'sourceByteSize')::bigint IS DISTINCT FROM octet_length(original_text) THEN
    RAISE EXCEPTION 'Attempt projection source changed before shortening';
  END IF;
  UPDATE result_attempts r SET evidence_payload=attempt_evidence_compact(r.evidence_payload),
    evidence_archive_id=p_archive_id,evidence_storage_event_id=ev.id WHERE r.id=p_id;
  UPDATE attempt_evidence_storage_events e SET completed=true WHERE e.id=ev.id RETURNING * INTO ev;
  RETURN jsonb_build_object('eventId',ev.id,'attemptId',p_id,'archiveId',p_archive_id,'sourceStoredBytes',ev.source_stored_bytes,
    'remainingStoredBytes',ev.result_stored_bytes,'projectionValueBytes',ev.projection_value_bytes,'verificationValueBytes',ev.verification_value_bytes,
    'payloadBytesReclaimed',ev.source_stored_bytes-ev.result_stored_bytes,'netValueBytesReclaimed',ev.net_value_bytes_saved,
    'removedLogicalBytes',(projection->>'removedLogicalBytes')::bigint);
END;
$$;
