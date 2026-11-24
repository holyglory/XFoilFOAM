-- A canonical field may be byte-identical to an immutable attempt without that
-- attempt being selected. Store its storage source separately from selection.
ALTER TABLE attempt_evidence_storage_policy
  ADD COLUMN canonical_history_subtrees_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN canonical_history_canary_result_id uuid,
  ADD CONSTRAINT canonical_history_canary_policy CHECK(canonical_history_subtrees_enabled OR canonical_history_canary_result_id IS NULL);
--> statement-breakpoint
CREATE TABLE result_history_subtree_refs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  result_id uuid NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK(source_kind IN ('steady_history','frame_track')),
  source_attempt_id uuid NOT NULL,
  source_archive_id uuid NOT NULL,
  selected_attempt_at_bind uuid,
  original_value_bytes integer NOT NULL CHECK(original_value_bytes>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  app_readback_at timestamptz,
  CONSTRAINT result_subtree_attempt_owner_fk FOREIGN KEY(source_attempt_id,result_id) REFERENCES result_attempts(id,result_id) ON DELETE CASCADE,
  CONSTRAINT result_subtree_projection_fk FOREIGN KEY(source_attempt_id,source_archive_id) REFERENCES attempt_evidence_history_projections(result_attempt_id,archive_id) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE results
  ADD COLUMN steady_history_subtree_id uuid REFERENCES result_history_subtree_refs(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN frame_track_subtree_id uuid REFERENCES result_history_subtree_refs(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT canonical_steady_single_source CHECK(steady_history_archive_id IS NULL OR steady_history_subtree_id IS NULL),
  ADD CONSTRAINT canonical_frames_single_source CHECK(frame_track_archive_id IS NULL OR frame_track_subtree_id IS NULL);
--> statement-breakpoint
CREATE FUNCTION result_history_subtree_compact(doc jsonb,kind text,reference uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE k text; keys text[]; v jsonb; marker jsonb; result jsonb:=doc;
BEGIN
  IF kind='steady_history' THEN keys:=ARRAY['iterations','cl','cd','cm'];
  ELSIF kind='frame_track' THEN keys:=ARRAY['frames'];
  ELSE RAISE EXCEPTION 'Unknown canonical history field'; END IF;
  IF jsonb_typeof(doc)<>'object' THEN RETURN doc; END IF;
  FOREACH k IN ARRAY keys LOOP
    v:=doc->k;
    IF jsonb_typeof(v)='array' AND v<>'[]'::jsonb THEN
      marker:=jsonb_build_object('archivedResultHistoryArray',true,'length',jsonb_array_length(v));
      -- Some callers only selected the JSON field. Pin that snapshot once so
      -- two data generations with identical array lengths cannot be confused.
      IF reference IS NOT NULL THEN
        marker:=marker||jsonb_build_object('subtreeRef',reference);
        reference:=NULL;
      END IF;
      result:=jsonb_set(result,ARRAY[k],marker);
    END IF;
  END LOOP;
  RETURN result;
END;
$$;
--> statement-breakpoint
-- The bounded search starts with a real attempt PK and one canonical result.
-- For cold owners use the original parent's sealed PG digest; compact JSON can
-- never serve as proof that the original field was equal.
CREATE FUNCTION result_history_subtree_candidates(p_attempt uuid,p_kind text DEFAULT NULL)
RETURNS TABLE(result_id uuid,kind text,archive uuid,generation text,selected uuid,field_sha text,field_bytes int,existing_ref uuid)
LANGUAGE plpgsql STABLE AS $$
DECLARE cfg attempt_evidence_storage_policy%ROWTYPE;
BEGIN
  SELECT * INTO cfg FROM attempt_evidence_storage_policy WHERE id=1;
  -- Pending application reads survive policy changes, a controller restart and
  -- a later selection change that did not replace the stored canonical field.
  RETURN QUERY SELECT b.result_id,b.source_kind,ar.id,ar.generation,r.current_result_attempt_id,
    facts.v->>'sourceSha256',(facts.v->>'byteSize')::int,b.id
   FROM result_attempts owner JOIN results r ON r.id=owner.result_id
   CROSS JOIN LATERAL (VALUES('steady_history',r.steady_history_subtree_id),('frame_track',r.frame_track_subtree_id)) ptr(k,id)
   JOIN result_history_subtree_refs b ON b.id=ptr.id AND b.result_id=r.id AND b.source_kind=ptr.k AND b.source_attempt_id=owner.id
   JOIN attempt_evidence_archives ar ON ar.id=b.source_archive_id AND ar.result_id=b.result_id AND ar.result_attempt_id=b.source_attempt_id
   JOIN attempt_evidence_history_projections p ON p.result_attempt_id=b.source_attempt_id AND p.archive_id=ar.id
   CROSS JOIN LATERAL(SELECT attempt_evidence_stored_fact(b.source_attempt_id,ar.id,p.projection,ARRAY[b.source_kind],true) v)facts
   WHERE owner.id=p_attempt AND b.app_readback_at IS NULL AND (p_kind IS NULL OR b.source_kind=p_kind);
  IF cfg.canonical_history_subtrees_enabled IS NOT TRUE OR cfg.shortening_enabled IS NOT TRUE
    OR cfg.consumer_contract_version<>1 THEN RETURN; END IF;
  RETURN QUERY
  WITH owner AS MATERIALIZED (
    SELECT a.id attempt,r.id rid,j.id job,r.current_result_attempt_id sel,a.evidence_archive_id cold,
      a.evidence_storage_event_id event,r.steady_history,r.frame_track,r.steady_history_archive_id,
      r.frame_track_archive_id,r.steady_history_subtree_id,r.frame_track_subtree_id
    FROM result_attempts a JOIN results r ON r.id=a.result_id AND r.sim_job_id=a.sim_job_id AND r.airfoil_id=a.airfoil_id
      AND r.simulation_preset_revision_id=a.simulation_preset_revision_id AND r.bc_id=a.bc_id AND r.aoa_deg=a.aoa_deg
    JOIN sim_jobs j ON j.id=a.sim_job_id
    WHERE a.id=p_attempt AND a.status IN ('done','failed') AND j.status IN ('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL
      AND (j.ingest_lease_token IS NULL OR j.ingest_lease_expires_at<=statement_timestamp())
  ), field AS MATERIALIZED (
    SELECT o.attempt,o.rid,o.job,o.sel,o.cold,o.event,f.k,f.v,f.ref FROM owner o
    CROSS JOIN LATERAL(VALUES ('steady_history',o.steady_history,o.steady_history_archive_id,o.steady_history_subtree_id),
      ('frame_track',o.frame_track,o.frame_track_archive_id,o.frame_track_subtree_id)) f(k,v,standalone,ref)
    WHERE f.standalone IS NULL AND f.ref IS NULL AND (p_kind IS NULL OR p_kind=f.k) AND f.v IS NOT NULL
      AND (cfg.canonical_history_canary_result_id IS NULL OR cfg.canonical_history_canary_result_id=o.rid)
      AND (o.sel IS NULL OR o.sel=o.attempt) AND pg_column_size(f.v)<=4096
  ), small AS MATERIALIZED (
    SELECT f.*,f.v::text orig,encode(sha256(convert_to(f.v::text,'UTF8')),'hex') digest
    FROM field f WHERE octet_length(f.v::text)<4096 AND result_history_subtree_compact(f.v,f.k) IS DISTINCT FROM f.v
  )
  SELECT s.rid,s.k,c.id,c.generation,s.sel,c.digest,c.bytes,s.ref
  FROM small s JOIN LATERAL (
    SELECT ar.id,ar.generation,s.digest,octet_length(s.orig) bytes
    FROM attempt_evidence_archives ar
    LEFT JOIN attempt_evidence_history_projections p ON p.result_attempt_id=ar.result_attempt_id AND p.archive_id=ar.id
    LEFT JOIN LATERAL(SELECT CASE WHEN p.archive_id IS NOT NULL THEN
      attempt_evidence_stored_fact(s.attempt,ar.id,p.projection,ARRAY[s.k],true) END AS value) fact ON true
    WHERE ar.result_attempt_id=s.attempt AND ar.result_id=s.rid AND ar.sim_job_id=s.job
      AND (CASE WHEN s.cold IS NOT NULL THEN s.cold=ar.id AND fact.value->>'sourceSha256'=s.digest
                    AND (fact.value->>'byteSize')::int=octet_length(s.orig) AND EXISTS(
                      SELECT FROM attempt_evidence_storage_events e WHERE e.id=s.event AND e.archive_id=ar.id
                      AND e.result_attempt_id=s.attempt AND e.completed AND e.app_readback_at IS NOT NULL)
                  ELSE EXISTS(SELECT FROM result_attempts warm WHERE warm.id=s.attempt AND warm.evidence_archive_id IS NULL
                    AND (warm.evidence_payload->s.k)::text=s.orig AND octet_length(warm.evidence_payload::text)=ar.source_byte_size
                    AND encode(sha256(convert_to(warm.evidence_payload::text,'UTF8')),'hex')=ar.source_sha256) END)
    ORDER BY ar.verified_at DESC,ar.id LIMIT 1
  ) c ON true;
END;
$$;
--> statement-breakpoint
-- Reading a historical binding is independent of the current canonical
-- selection, job or attempt pointer. The original projection remains pinned.
CREATE FUNCTION result_history_subtree_binding(p_result uuid,p_kind text,p_ref uuid)
RETURNS TABLE(source_attempt_id uuid,source_archive_id uuid,source_sha text,source_bytes int,
 semantic_sha text,source_kind text,source_instance text,generation text,confirmed timestamptz)
LANGUAGE sql STABLE STRICT AS $$
 SELECT ref.source_attempt_id,ar.id,f.v->>'sourceSha256',(f.v->>'byteSize')::integer,f.v->>'semanticSha256',
 ref.source_kind,ar.source_instance,ar.generation,ref.app_readback_at
 FROM result_history_subtree_refs ref JOIN attempt_evidence_archives ar ON ar.id=ref.source_archive_id
   AND ar.result_attempt_id=ref.source_attempt_id AND ar.result_id=ref.result_id
 JOIN attempt_evidence_history_projections p ON p.result_attempt_id=ref.source_attempt_id AND p.archive_id=ar.id
 CROSS JOIN LATERAL(SELECT attempt_evidence_stored_fact(ref.source_attempt_id,ar.id,p.projection,ARRAY[ref.source_kind],true) AS v)f
 WHERE ref.id=p_ref AND ref.result_id=p_result AND ref.source_kind=p_kind AND f.v->>'present'='true' AND f.v->>'jsonType'='object'
$$;
--> statement-breakpoint
CREATE FUNCTION guard_result_history_subtree_ref() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (OLD.app_readback_at IS NOT NULL OR NEW.app_readback_at IS NULL
    OR nullif(current_setting('airfoilfoam.canonical_subtree_confirmation',true),'') IS DISTINCT FROM NEW.id::text
    OR (to_jsonb(OLD)-'app_readback_at') IS DISTINCT FROM (to_jsonb(NEW)-'app_readback_at')) THEN
    RAISE EXCEPTION 'Canonical history source bindings are immutable'; END IF;
  IF TG_OP='INSERT' AND (NEW.app_readback_at IS NOT NULL OR nullif(current_setting('airfoilfoam.canonical_subtree_ref',true),'') IS DISTINCT FROM NEW.id::text OR NOT EXISTS(SELECT FROM
    result_history_subtree_candidates(NEW.source_attempt_id,NEW.source_kind) c WHERE c.archive=NEW.source_archive_id
    AND c.result_id=NEW.result_id AND c.selected IS NOT DISTINCT FROM NEW.selected_attempt_at_bind AND c.existing_ref IS NULL))
    THEN RAISE EXCEPTION 'Canonical field and exact attempt source must match'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT CASE NEW.source_kind WHEN 'steady_history' THEN pg_column_size(r.steady_history) ELSE pg_column_size(r.frame_track) END
     INTO STRICT NEW.original_value_bytes FROM results r WHERE r.id=NEW.result_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_result_history_subtree_ref BEFORE INSERT OR UPDATE ON result_history_subtree_refs
 FOR EACH ROW EXECUTE FUNCTION guard_result_history_subtree_ref();
--> statement-breakpoint
CREATE FUNCTION result_history_has_subtree_markers(doc jsonb,kind text,require_binding boolean DEFAULT false) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT EXISTS(SELECT FROM unnest(CASE kind WHEN 'steady_history' THEN ARRAY['iterations','cl','cd','cm']
   WHEN 'frame_track' THEN ARRAY['frames'] ELSE ARRAY[]::text[] END) k WHERE doc->k->'archivedResultHistoryArray'='true'::jsonb
     AND (NOT require_binding OR doc->k?'subtreeRef'))
$$;
--> statement-breakpoint
CREATE FUNCTION enforce_result_subtree_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; old_ref uuid; new_ref uuid; old_value jsonb; new_value jsonb; s record; omitted jsonb;
BEGIN
 FOREACH kind IN ARRAY ARRAY['steady_history','frame_track'] LOOP
  IF kind='steady_history' THEN
   old_ref:=CASE WHEN TG_OP='UPDATE' THEN OLD.steady_history_subtree_id END; new_ref:=NEW.steady_history_subtree_id;
   old_value:=CASE WHEN TG_OP='UPDATE' THEN OLD.steady_history END;new_value:=NEW.steady_history;
  ELSE
   old_ref:=CASE WHEN TG_OP='UPDATE' THEN OLD.frame_track_subtree_id END;new_ref:=NEW.frame_track_subtree_id;
   old_value:=CASE WHEN TG_OP='UPDATE' THEN OLD.frame_track END;new_value:=NEW.frame_track;
  END IF;
  IF old_ref IS NOT NULL AND new_ref=old_ref THEN
   IF new_value::text IS DISTINCT FROM old_value::text THEN
    IF result_history_has_subtree_markers(new_value,kind) THEN RAISE EXCEPTION 'Cannot publish a replacement from compact canonical metadata'; END IF;
    -- Normal publication of an actual replacement owns its new inline field.
    IF kind='steady_history' THEN NEW.steady_history_subtree_id:=NULL; ELSE NEW.frame_track_subtree_id:=NULL; END IF;
   END IF;
  ELSIF new_ref IS NOT NULL THEN
   IF TG_OP<>'UPDATE' OR old_ref IS NOT NULL OR NEW.sim_job_id IS DISTINCT FROM OLD.sim_job_id
     OR NEW.current_result_attempt_id IS DISTINCT FROM OLD.current_result_attempt_id
     OR nullif(current_setting('airfoilfoam.canonical_subtree_ref',true),'') IS DISTINCT FROM new_ref::text
     THEN RAISE EXCEPTION 'Canonical subtree replacement needs an exact source binding'; END IF;
   omitted:=jsonb_build_object(kind,NULL,kind||'_subtree_id',NULL);
   IF jsonb_populate_record(OLD,omitted) IS DISTINCT FROM jsonb_populate_record(NEW,omitted) THEN
     RAISE EXCEPTION 'Canonical history retirement cannot edit other result data'; END IF;
   SELECT b.*,ref.selected_attempt_at_bind,g.sim_job_id INTO s FROM result_history_subtree_binding(NEW.id,kind,new_ref)b
     JOIN result_history_subtree_refs ref ON ref.id=new_ref JOIN attempt_evidence_archives g ON g.id=b.source_archive_id;
   IF NOT FOUND OR s.selected_attempt_at_bind IS DISTINCT FROM NEW.current_result_attempt_id OR s.sim_job_id IS DISTINCT FROM NEW.sim_job_id
     OR s.source_bytes IS DISTINCT FROM octet_length(old_value::text)
     OR s.source_sha IS DISTINCT FROM encode(sha256(convert_to(old_value::text,'UTF8')),'hex')
     OR new_value::text IS DISTINCT FROM result_history_subtree_compact(old_value,kind,new_ref)::text
     THEN RAISE EXCEPTION 'Canonical subtree does not match the original field'; END IF;
  ELSIF old_ref IS NOT NULL AND result_history_has_subtree_markers(new_value,kind) THEN
   RAISE EXCEPTION 'Cannot detach a canonical subtree while retaining its compact metadata';
  ELSIF new_ref IS NULL AND result_history_has_subtree_markers(new_value,kind,true) THEN
   RAISE EXCEPTION 'Canonical history metadata names an unattached source';
  ELSIF TG_OP='UPDATE' AND old_value IS DISTINCT FROM new_value AND old_value IS NOT NULL
    AND result_history_has_subtree_markers(new_value,kind) AND octet_length(old_value::text)<4096 AND new_value=result_history_subtree_compact(old_value,kind)
    AND (CASE kind WHEN 'steady_history' THEN NEW.steady_history_archive_id IS NULL ELSE NEW.frame_track_archive_id IS NULL END) THEN
   RAISE EXCEPTION 'Cannot compact a canonical field without a verified subtree';
  END IF;
 END LOOP;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER canonical_subtree_transition BEFORE INSERT OR UPDATE OF steady_history,frame_track,steady_history_subtree_id,frame_track_subtree_id,steady_history_archive_id,frame_track_archive_id
 ON results FOR EACH ROW EXECUTE FUNCTION enforce_result_subtree_transition();
--> statement-breakpoint
CREATE FUNCTION bind_canonical_history_subtree(p_result uuid,p_kind text,p_attempt uuid,p_archive uuid,p_generation text,
 p_expected_selection uuid,p_original text,p_verified_at timestamptz) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE ar attempt_evidence_archives%ROWTYPE; cand record; field jsonb; digest text; ref uuid;
BEGIN
 IF p_kind NOT IN ('steady_history','frame_track') OR p_original IS NULL OR p_verified_at IS NULL OR
    p_verified_at NOT BETWEEN clock_timestamp()-interval '120 seconds' AND clock_timestamp()+interval '5 seconds' THEN
    RAISE EXCEPTION 'Canonical history requires a fresh immutable original readback'; END IF;
 SELECT * INTO STRICT ar FROM attempt_evidence_archives WHERE id=p_archive AND result_attempt_id=p_attempt AND result_id=p_result;
 IF p_generation IS DISTINCT FROM ar.generation OR octet_length(p_original)<>ar.source_byte_size
    OR encode(sha256(convert_to(p_original,'UTF8')),'hex')<>ar.source_sha256 THEN RAISE EXCEPTION 'Canonical original generation or bytes changed'; END IF;
 field:=p_original::jsonb->p_kind;digest:=encode(sha256(convert_to(field::text,'UTF8')),'hex');
 -- Recheck the native row and projection under their ordinary job/result/attempt
 -- lock order. The input object was restored before the SQL transaction began.
 PERFORM FROM attempt_evidence_storage_policy WHERE id=1 FOR SHARE;
 PERFORM attempt_evidence_lock_source(p_attempt);
 SELECT c.* INTO cand FROM result_history_subtree_candidates(p_attempt,p_kind)c WHERE c.result_id=p_result AND c.archive=p_archive;
 IF NOT FOUND OR cand.selected IS DISTINCT FROM p_expected_selection THEN RETURN NULL; END IF;
 IF cand.generation<>p_generation OR cand.field_sha IS DISTINCT FROM digest OR cand.field_bytes IS DISTINCT FROM octet_length(field::text)
    THEN RAISE EXCEPTION 'Canonical field or producing source changed'; END IF;
 IF cand.existing_ref IS NOT NULL THEN RETURN cand.existing_ref; END IF;
 IF NOT EXISTS(SELECT FROM attempt_evidence_history_projections WHERE result_attempt_id=p_attempt AND archive_id=p_archive) THEN
   -- The existing native trigger derives these immutable facts from the actual
   -- full inline attempt. It refuses a foreign owner or different source bytes.
   INSERT INTO attempt_evidence_history_projections(result_attempt_id,archive_id) VALUES(p_attempt,p_archive);
 END IF;
 ref:=gen_random_uuid();
 PERFORM set_config('airfoilfoam.canonical_subtree_ref',ref::text,true);
 INSERT INTO result_history_subtree_refs(id,result_id,source_kind,source_attempt_id,source_archive_id,selected_attempt_at_bind)
   VALUES(ref,p_result,p_kind,p_attempt,p_archive,p_expected_selection);
 EXECUTE format('UPDATE results SET %I=$1,%I=$2 WHERE id=$3',p_kind,p_kind||'_subtree_id')
   USING result_history_subtree_compact(field,p_kind,ref),ref,p_result;
 RETURN ref;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION confirm_canonical_history_subtree(p_result uuid,p_kind text,p_ref uuid,p_field text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE current_ref uuid; b record;
BEGIN
 IF p_kind NOT IN ('steady_history','frame_track') THEN RAISE EXCEPTION 'Unknown canonical history field'; END IF;
 EXECUTE format('SELECT %I FROM results WHERE id=$1 FOR SHARE',p_kind||'_subtree_id') INTO current_ref USING p_result;
 IF current_ref IS DISTINCT FROM p_ref OR current_ref IS NULL THEN RETURN false; END IF;
 SELECT * INTO STRICT b FROM result_history_subtree_binding(p_result,p_kind,p_ref);
 IF octet_length(p_field) IS DISTINCT FROM b.source_bytes OR encode(sha256(convert_to(p_field,'UTF8')),'hex') IS DISTINCT FROM b.source_sha
   THEN RAISE EXCEPTION 'Canonical history normal readback differs'; END IF;
 PERFORM set_config('airfoilfoam.canonical_subtree_confirmation',p_ref::text,true);
 UPDATE result_history_subtree_refs SET app_readback_at=clock_timestamp() WHERE id=p_ref AND app_readback_at IS NULL;
 RETURN true;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION restore_canonical_history_subtree(p_result uuid,p_kind text,p_ref uuid,p_field text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE b record; affected int;
BEGIN
 IF p_kind NOT IN ('steady_history','frame_track') THEN RAISE EXCEPTION 'Unknown canonical history field'; END IF;
 SELECT * INTO STRICT b FROM result_history_subtree_binding(p_result,p_kind,p_ref);
 IF p_field IS NULL OR p_field::jsonb::text<>p_field OR octet_length(p_field)<>b.source_bytes
  OR encode(sha256(convert_to(p_field,'UTF8')),'hex')<>b.source_sha THEN RAISE EXCEPTION 'Canonical restore requires exact original field bytes'; END IF;
 -- A genuine replacement installed while a restore was underway wins the CAS.
 EXECUTE format('UPDATE results SET %I=$1::jsonb,%I=NULL WHERE id=$2 AND %I=$3',
   p_kind,p_kind||'_subtree_id',p_kind||'_subtree_id') USING p_field,p_result,p_ref;
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN affected=1;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION result_history_matches(jsonb,text,jsonb) RENAME TO result_history_0206_matches;
--> statement-breakpoint
CREATE FUNCTION result_history_matches(owner_row jsonb,kind text,candidate jsonb) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF kind NOT IN ('steady_history','frame_track') THEN RETURN false; END IF;
 IF owner_row->>(kind||'_subtree_id') IS NULL THEN
   -- Keep the original inline equality path free of table lookups. Prepare
   -- the reference query only for a result that actually carries a binding.
   IF owner_row->>(kind||'_archive_id') IS NULL THEN
     RETURN coalesce(owner_row->kind,'null'::jsonb)=coalesce(candidate,'null'::jsonb);
   END IF;
   RETURN result_history_0206_matches(owner_row,kind,candidate);
 END IF;
 RETURN EXISTS(SELECT FROM results r CROSS JOIN LATERAL result_history_subtree_binding(r.id,kind,(owner_row->>(kind||'_subtree_id'))::uuid)b
     WHERE r.id=(owner_row->>'id')::uuid AND (CASE kind WHEN 'steady_history' THEN r.steady_history_subtree_id ELSE r.frame_track_subtree_id END)
       =(owner_row->>(kind||'_subtree_id'))::uuid AND (CASE kind WHEN 'steady_history' THEN r.steady_history ELSE r.frame_track END)=owner_row->kind
       AND b.semantic_sha=encode(sha256(convert_to(result_history_normalized(candidate)::text,'UTF8')),'hex'));
END;
$$;
