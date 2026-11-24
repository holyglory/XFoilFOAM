-- Store a smaller, reversible proof only when the ordinary shortening was
-- refused at its actual online value-byte floor. The existing archive, source
-- locks, verification triggers, post-readback and per-row floor still apply.
ALTER TABLE attempt_evidence_storage_policy
  ADD COLUMN short_proofs_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN short_proof_canary_attempt_id uuid,
  ADD CONSTRAINT short_attempt_proof_policy CHECK (short_proofs_enabled OR short_proof_canary_attempt_id IS NULL);
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_proof_owner(attempt_id uuid,archive_id uuid) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT encode(uuid_send(attempt_id)||uuid_send(archive_id),'base64') $$;
--> statement-breakpoint
-- These positions describe the v1 projection grammar. Absent and JSON null
-- are different. Array order is the original immutable 0207 inventory order.
CREATE FUNCTION attempt_evidence_fact_paths_v1() RETURNS TABLE(fact_index integer,path text[])
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  WITH family(parent,parent_index,first_leaf,children) AS (VALUES
    ('force_history',1,7,ARRAY['t','cl','cd','cm']),('forceHistory',2,11,ARRAY['t','cl','cd','cm']),
    ('steady_history',3,15,ARRAY['iterations','cl','cd','cm']),('steadyHistory',4,19,ARRAY['iterations','cl','cd','cm']),
    ('frame_track',5,23,ARRAY['frames']),('frameTrack',6,24,ARRAY['frames']))
  SELECT 0,ARRAY[]::text[]
  UNION ALL SELECT parent_index,ARRAY[parent] FROM family
  UNION ALL SELECT first_leaf+i::integer-1,ARRAY[parent,child] FROM family CROSS JOIN LATERAL unnest(children) WITH ORDINALITY v(child,i)
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_short_path_indexes() RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_object_agg(array_to_json(path)::text,fact_index) FROM attempt_evidence_fact_paths_v1()
$$;
CREATE FUNCTION attempt_evidence_pack_sha(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT encode(decode(value,'hex'),'base64') $$;
CREATE FUNCTION attempt_evidence_unpack_sha(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$ SELECT encode(decode(value,'base64'),'hex') $$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_pack_projection(p jsonb, ar attempt_evidence_archives) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE sizes jsonb; normalized_leaves jsonb; other_facts jsonb; null_mask bigint; removed_mask bigint;
BEGIN
  WITH leaves AS (
    SELECT i,(p->'values'->(array_to_json(ARRAY(SELECT jsonb_array_elements_text(s->'path')))::text)) AS fact
    FROM jsonb_array_elements(ar.history_series) WITH ORDINALITY series(s,i))
  SELECT CASE WHEN min((fact->>'length')::int)=max((fact->>'length')::int) THEN to_jsonb(min((fact->>'length')::int))
              ELSE jsonb_agg(fact->'length' ORDER BY i) END,
    jsonb_object_agg((i-1)::text,attempt_evidence_pack_sha(fact->>'semanticSha256'))
      FILTER(WHERE fact->>'semanticSha256'<>fact->>'sourceSha256')
    INTO sizes,normalized_leaves FROM leaves;
  WITH facts AS (
    SELECT f.fact_index,f.path,p->'values'->(array_to_json(f.path)::text) AS fact,
      (cardinality(f.path)=2 AND EXISTS(SELECT FROM jsonb_array_elements(p->'removedPaths') x WHERE x=to_jsonb(f.path))) AS removed
    FROM attempt_evidence_fact_paths_v1() f WHERE f.fact_index>0)
  SELECT coalesce(bit_or(1::bigint<<fact_index) FILTER(WHERE fact->>'jsonType'='null'),0),
    coalesce(bit_or(1::bigint<<fact_index) FILTER(WHERE removed),0),
    jsonb_agg(jsonb_build_array(fact_index,fact->'jsonType',fact->'length',fact->'byteSize',attempt_evidence_pack_sha(fact->>'sourceSha256'))
      || CASE WHEN fact->>'sourceSha256'<>fact->>'semanticSha256' THEN jsonb_build_array(attempt_evidence_pack_sha(fact->>'semanticSha256')) ELSE '[]'::jsonb END ORDER BY fact_index)
      FILTER(WHERE (fact->>'present')::boolean AND fact->>'jsonType'<>'null' AND NOT removed)
    INTO null_mask,removed_mask,other_facts FROM facts;
  -- Tuple: native array lengths, other present facts, explicit nulls, removed
  -- paths, exceptional root/compact normalized hashes, exceptional leaf hashes.
  RETURN (p-ARRAY['attemptId','archiveId','values','removedPaths','sourceSemanticSha256','compactSemanticSha256']) || jsonb_build_object('owner',attempt_evidence_proof_owner(ar.result_attempt_id,ar.id),'shortFacts',
    jsonb_build_array(sizes,other_facts,null_mask,removed_mask,
      attempt_evidence_pack_sha(nullif(p->>'sourceSemanticSha256',p->>'sourceSha256')),
      attempt_evidence_pack_sha(nullif(p->>'compactSemanticSha256',p->>'compactSha256')),normalized_leaves));
END;
$$;
--> statement-breakpoint
-- Compute exactly one fact; lengths/types on the classifier path need only the
-- small sealed row. Full digests of removed arrays come from the native catalog.
CREATE FUNCTION attempt_evidence_short_fact(p jsonb, series jsonb, pos integer, path text[], hashes boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE facts jsonb:=p->'shortFacts'; removed bigint:=(facts->>3)::bigint; present boolean:=true;
  fact_type text; n integer; bytes bigint; source_sha text; semantic text; item jsonb; leaf jsonb; ordinal integer;
BEGIN
  IF pos=0 THEN
    fact_type:='object'; bytes:=(p->>'sourceByteSize')::bigint; source_sha:=p->>'sourceSha256';
    semantic:=coalesce(attempt_evidence_unpack_sha(facts->>4),source_sha);
  ELSIF (removed & (1::bigint<<pos))<>0 THEN
    ordinal:=bit_count((removed & ((1::bigint<<pos)-1))::bit(64))::integer;
    fact_type:='array'; n:=CASE WHEN jsonb_typeof(facts->0)='number' THEN (facts->>0)::integer ELSE (facts->0->>ordinal)::integer END;
    IF hashes THEN
      leaf:=series->ordinal;
      IF leaf->'path' IS DISTINCT FROM to_jsonb(path) THEN RAISE EXCEPTION 'Short attempt array differs from its sealed inventory'; END IF;
      bytes:=(leaf->>'byteSize')::bigint; source_sha:=leaf->>'sha256';
      semantic:=coalesce(attempt_evidence_unpack_sha(facts->6->>(ordinal::text)),source_sha);
    END IF;
  ELSIF ((facts->>2)::bigint & (1::bigint<<pos))<>0 THEN
    fact_type:='null'; bytes:=4; source_sha:=encode(sha256('null'::bytea),'hex'); semantic:=source_sha;
  ELSE
    SELECT v INTO item FROM jsonb_array_elements(nullif(facts->1,'null'::jsonb)) v WHERE (v->>0)::integer=pos;
    IF item IS NULL THEN present:=false;
    ELSE
      fact_type:=item->>1; n:=(item->>2)::integer; bytes:=(item->>3)::bigint;
      IF hashes THEN source_sha:=attempt_evidence_unpack_sha(item->>4); semantic:=coalesce(attempt_evidence_unpack_sha(item->>5),source_sha); END IF;
    END IF;
  END IF;
  item:=jsonb_build_object('path',path,'present',present,'jsonType',fact_type,'length',n);
  IF hashes THEN item:=item||jsonb_build_object('byteSize',bytes,'sourceSha256',source_sha,'semanticSha256',semantic); END IF;
  RETURN item;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_expand_projection(p jsonb, ar attempt_evidence_archives) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE vals jsonb; paths jsonb;
BEGIN
  IF NOT (p?'shortFacts') THEN RETURN p; END IF;
  IF p->>'owner' IS DISTINCT FROM attempt_evidence_proof_owner(ar.result_attempt_id,ar.id)
    OR p->>'sourceSha256' IS DISTINCT FROM ar.source_sha256 OR (p->>'sourceByteSize')::bigint IS DISTINCT FROM ar.source_byte_size THEN
    RAISE EXCEPTION 'Short attempt projection belongs to another original';
  END IF;
  SELECT jsonb_object_agg(array_to_json(f.path)::text,attempt_evidence_short_fact(p,ar.history_series,f.fact_index,f.path,true)),
    coalesce(jsonb_agg(f.path ORDER BY f.fact_index) FILTER(WHERE ((p#>>'{shortFacts,3}')::bigint & (1::bigint<<f.fact_index))<>0),'[]'::jsonb)
    INTO vals,paths FROM attempt_evidence_fact_paths_v1() f;
  RETURN (p-ARRAY['shortFacts','owner']) || jsonb_build_object('attemptId',ar.result_attempt_id,'archiveId',ar.id,'values',vals,'removedPaths',paths,
    'sourceSemanticSha256',coalesce(attempt_evidence_unpack_sha(p#>>'{shortFacts,4}'),ar.source_sha256),
    'compactSemanticSha256',coalesce(attempt_evidence_unpack_sha(p#>>'{shortFacts,5}'),p->>'compactSha256'));
END;
$$;
--> statement-breakpoint
-- A scope keeps optional members precisely. The two masks describe presence and
-- fields copied from the immutable owner. The ordered literals include all
-- other recorded values. An unrecognised property stays in the residual object.
CREATE FUNCTION attempt_evidence_scope_keys(worker boolean) RETURNS text[]
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN worker THEN ARRAY['job','result','attempt','archive','instance','contract','solver','promise','assignment','sequence',
    'report','point','hubResult','hubAttempt','storageOnly','stopSequence','stopReport','selectionSha256']
  ELSE ARRAY['solverId','promiseId','executionId','sequence','assignmentSignature','reportContentSignature','pointContentSignature',
    'remoteResultId','remoteResultAttemptId','storageOnly','aoaDeg','caseSlug'] END
$$;
CREATE FUNCTION attempt_evidence_scope_digest_key(k text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT k=ANY(ARRAY['assignment','report','point','stopReport','selectionSha256','assignmentSignature','reportContentSignature','pointContentSignature'])
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_pack_scope(doc jsonb,defaults jsonb,worker boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE keys text[]:=attempt_evidence_scope_keys(worker); k text; v jsonb; vals jsonb:='[]'; extras jsonb;
  present bigint:=0; inherited bigint:=0; bit_ bigint;
BEGIN
  IF doc='null'::jsonb THEN RETURN doc; END IF;
  FOR i IN 1..cardinality(keys) LOOP
    k:=keys[i]; IF NOT (doc?k) THEN CONTINUE; END IF;
    bit_:=1::bigint<<(i-1); present:=present|bit_; v:=doc->k;
    IF defaults?k AND v::text=(defaults->k)::text THEN inherited:=inherited|bit_; CONTINUE; END IF;
    IF attempt_evidence_scope_digest_key(k) AND jsonb_typeof(v)='string' THEN
      v:=CASE WHEN doc->>k ~ '^[0-9a-f]{64}$' THEN to_jsonb(attempt_evidence_pack_sha(doc->>k)) ELSE jsonb_build_array(v) END;
    END IF;
    vals:=vals||jsonb_build_array(v);
  END LOOP;
  extras:=doc-keys;
  RETURN jsonb_build_array(present,inherited,vals) || CASE WHEN extras='{}' THEN '[]'::jsonb ELSE jsonb_build_array(extras) END;
END;
$$;
CREATE FUNCTION attempt_evidence_unpack_scope(p jsonb,defaults jsonb,worker boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE keys text[]:=attempt_evidence_scope_keys(worker); k text; v jsonb; doc jsonb:=coalesce(p->3,'{}');
  present bigint:=(p->>0)::bigint; inherited bigint:=(p->>1)::bigint; slot integer:=0; bit_ bigint;
BEGIN
  IF p='null'::jsonb THEN RETURN p; END IF;
  FOR i IN 1..cardinality(keys) LOOP
    bit_:=1::bigint<<(i-1); IF (present&bit_)=0 THEN CONTINUE; END IF;
    k:=keys[i];
    IF (inherited&bit_)<>0 THEN v:=defaults->k;
    ELSE
      v:=p->2->slot; slot:=slot+1;
      IF attempt_evidence_scope_digest_key(k) THEN
        IF jsonb_typeof(v)='string' THEN v:=to_jsonb(attempt_evidence_unpack_sha(v#>>'{}'));
        ELSIF jsonb_typeof(v)='array' THEN v:=v->0; END IF;
      END IF;
    END IF;
    doc:=doc||jsonb_build_object(k,v);
  END LOOP;
  RETURN doc;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_scope_defaults(ar attempt_evidence_archives,selection_hash jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_object('attempt',ar.result_attempt_id,'result',ar.result_id,'job',ar.sim_job_id,'executionId',ar.sim_job_id,
    'archive',ar.id,'instance',ar.source_instance,'selectionSha256',selection_hash)
$$;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_pack_receipt(v jsonb,ar attempt_evidence_archives) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE d jsonb:=v->'dependencies'; scope jsonb; h jsonb; short jsonb; sel jsonb;
BEGIN
  IF NOT (d?'progressiveScope' OR d?'workerScope') OR v?'shortReceipt' THEN RETURN v; END IF;
  -- Keep metadata-only signatures and post-confirmation identities available
  -- without rehydrating a point or expanding its scientific verification.
  h:=d-ARRAY['attemptId','archiveId','contractVersion','classificationEquivalent','equalityEquivalent','scientificEquivalent',
    'readDependenciesSatisfied','progressiveScope','workerScope','reportedApplicationSha256'];
  short:=jsonb_build_object('id',ar.id,'times',jsonb_build_array(v#>'{direct,verifiedAt}',v#>'{app,verifiedAt}'));
  IF d?'reportedApplicationSha256' THEN
    short:=short||jsonb_build_object('reported',CASE WHEN d->>'reportedApplicationSha256'=d->>'applicationSha256' THEN 'true'::jsonb
                                     ELSE to_jsonb(attempt_evidence_pack_sha(d->>'reportedApplicationSha256')) END);
  END IF;
  IF d?'progressiveScope' THEN
    scope:=d->'progressiveScope';
    IF jsonb_typeof(scope->'scientific')='object' THEN h:=h||jsonb_build_object('progressiveScope',jsonb_build_object('scientific',scope->'scientific')); END IF;
    IF (scope->'remote') IS DISTINCT FROM 'null'::jsonb THEN
      short:=short||jsonb_build_object('remote',attempt_evidence_pack_scope(scope->'remote',attempt_evidence_scope_defaults(ar,NULL),false));
    END IF;
    IF scope->>'engineJobId' IS DISTINCT FROM ar.sim_job_id::text THEN short:=short||jsonb_build_object('engine',scope->'engineJobId'); END IF;
  ELSIF d?'workerScope' THEN
    scope:=d->'workerScope';sel:=scope->'selectionSha256';
    IF sel IS NOT NULL THEN h:=h||jsonb_build_object('workerScope',jsonb_build_object('selectionSha256',sel)); END IF;
    short:=short||jsonb_build_object('worker',attempt_evidence_pack_scope(scope,attempt_evidence_scope_defaults(ar,sel),true));
  END IF;
  RETURN jsonb_build_object('app',jsonb_build_object('source',v#>'{app,source}'),'dependencies',h,'shortReceipt',short);
END;
$$;
CREATE FUNCTION attempt_evidence_expand_receipt(v jsonb,ar attempt_evidence_archives) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE s jsonb:=v->'shortReceipt'; d jsonb:=v->'dependencies'; owner jsonb; common jsonb; scope jsonb;
BEGIN
  IF s IS NULL OR v?'direct' THEN RETURN v; END IF;
  IF s->>'id' IS DISTINCT FROM ar.id::text OR d->>'sourceSha256' IS DISTINCT FROM ar.source_sha256 THEN
    RAISE EXCEPTION 'Short attempt verification belongs to another original';
  END IF;
  owner:=jsonb_build_object('attemptId',ar.result_attempt_id,'archiveId',ar.id,'sourceSha256',ar.source_sha256);
  common:=owner||jsonb_build_object('sourceByteSize',ar.source_byte_size);
  d:=owner||d||jsonb_build_object('contractVersion',1,'classificationEquivalent',true,'equalityEquivalent',true,
    'scientificEquivalent',true,'readDependenciesSatisfied',true);
  IF s?'worker' THEN
    scope:=attempt_evidence_unpack_scope(s->'worker',attempt_evidence_scope_defaults(ar,d#>'{workerScope,selectionSha256}'),true);
    d:=d||jsonb_build_object('workerScope',scope);
  ELSE
    scope:=jsonb_build_object('attemptId',ar.result_attempt_id,'resultId',ar.result_id,'simJobId',ar.sim_job_id,
      'engineJobId',coalesce(s->'engine',to_jsonb(ar.sim_job_id)),'remote',attempt_evidence_unpack_scope(s->'remote',attempt_evidence_scope_defaults(ar,NULL),false),
      'scientific',d#>'{progressiveScope,scientific}');
    d:=d||jsonb_build_object('progressiveScope',scope);
  END IF;
  IF s?'reported' THEN d:=d||jsonb_build_object('reportedApplicationSha256',
    CASE WHEN s->'reported'='true' THEN d->>'applicationSha256' ELSE attempt_evidence_unpack_sha(s->>'reported') END); END IF;
  RETURN jsonb_build_object('direct',common||jsonb_build_object('bucket',ar.bucket,'objectKey',ar.object_key,'generation',ar.generation,
    'crc32c',ar.crc32c,'storedSha256',ar.stored_sha256,'storedByteSize',ar.stored_byte_size,'verifiedAt',s#>'{times,0}'),
    'app',common||jsonb_build_object('source',v#>'{app,source}','forceArchive',true,'verifiedAt',s#>'{times,1}'),'dependencies',d);
END;
$$;
--> statement-breakpoint
-- Activation is independent of existing cohorts and can be limited to one
-- genuine owner for rollout. The session selection is scoped to this pair.
CREATE FUNCTION attempt_evidence_begin_short_proof(p_id uuid,p_archive uuid,proof jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE enabled boolean; verifier text:=proof#>>'{dependencies,verifier}';
BEGIN
  SELECT short_proofs_enabled AND shortening_enabled AND consumer_contract_version=1
    AND (short_proof_canary_attempt_id IS NULL OR short_proof_canary_attempt_id=p_id)
    INTO enabled FROM attempt_evidence_storage_policy WHERE id=1 FOR SHARE;
  IF enabled IS DISTINCT FROM true OR verifier IS NULL OR verifier NOT IN (
    'server-consumers/receipt-bearing-rans-v1','server-consumers/receipt-bearing-urans-v1',
    'server-consumers/hz-retained-original-v2','server-consumers/hz-settled-receipt-v3','server-consumers/hz-worker-steady-rans-v1')
    THEN RETURN false; END IF;
  PERFORM set_config('airfoilfoam.short_attempt_proof',attempt_evidence_proof_owner(p_id,p_archive),true);
  RETURN true;
END;
$$;
CREATE FUNCTION attempt_evidence_short_proof_selected(p_id uuid,p_archive uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('airfoilfoam.short_attempt_proof',true)=attempt_evidence_proof_owner(p_id,p_archive)
    AND EXISTS(SELECT FROM attempt_evidence_storage_policy WHERE id=1 AND short_proofs_enabled AND shortening_enabled
      AND (short_proof_canary_attempt_id IS NULL OR short_proof_canary_attempt_id=p_id))
$$;
--> statement-breakpoint
CREATE FUNCTION store_short_attempt_projection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ar attempt_evidence_archives%ROWTYPE; packed jsonb;
BEGIN
  IF attempt_evidence_short_proof_selected(NEW.result_attempt_id,NEW.archive_id) IS NOT TRUE THEN RETURN NEW; END IF;
  SELECT * INTO STRICT ar FROM attempt_evidence_archives WHERE id=NEW.archive_id AND result_attempt_id=NEW.result_attempt_id;
  packed:=attempt_evidence_pack_projection(NEW.projection,ar);
  IF attempt_evidence_expand_projection(packed,ar)::text=NEW.projection::text THEN NEW.projection:=packed; END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION store_short_attempt_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ar attempt_evidence_archives%ROWTYPE; packed jsonb;
BEGIN
  IF NEW.verification?'shortReceipt' AND NOT (NEW.verification?'direct') THEN RAISE EXCEPTION 'Submit full native readbacks for a short attempt receipt'; END IF;
  IF NEW.action<>'shorten' OR attempt_evidence_short_proof_selected(NEW.result_attempt_id,NEW.archive_id) IS NOT TRUE THEN RETURN NEW; END IF;
  SELECT * INTO STRICT ar FROM attempt_evidence_archives WHERE id=NEW.archive_id AND result_attempt_id=NEW.result_attempt_id;
  packed:=attempt_evidence_pack_receipt(NEW.verification,ar);
  IF attempt_evidence_expand_receipt(packed,ar)::text=NEW.verification::text THEN NEW.verification:=packed; END IF;
  RETURN NEW;
END;
$$;
-- PostgreSQL executes these AFTER the existing native BEFORE INSERT triggers,
-- which must see and authenticate the full source facts and unmodified proofs.
CREATE TRIGGER zz_store_short_attempt_projection BEFORE INSERT ON attempt_evidence_history_projections
  FOR EACH ROW EXECUTE FUNCTION store_short_attempt_projection();
CREATE TRIGGER zz_store_short_attempt_receipt BEFORE INSERT ON attempt_evidence_storage_events
  FOR EACH ROW EXECUTE FUNCTION store_short_attempt_receipt();
--> statement-breakpoint
CREATE VIEW attempt_evidence_read_projections WITH (security_invoker=true) AS
 SELECT p.result_attempt_id,p.archive_id,attempt_evidence_expand_projection(p.projection,ar) projection,p.created_at
 FROM attempt_evidence_history_projections p JOIN attempt_evidence_archives ar ON ar.id=p.archive_id AND ar.result_attempt_id=p.result_attempt_id;
CREATE VIEW attempt_evidence_read_events WITH (security_invoker=true) AS
 SELECT e.id,e.result_attempt_id,e.archive_id,e.action,e.transaction_id,attempt_evidence_expand_receipt(e.verification,ar) verification,
 e.source_stored_bytes,e.result_stored_bytes,e.projection_value_bytes,e.verification_value_bytes,e.net_value_bytes_saved,e.completed,e.app_readback_at,e.created_at
 FROM attempt_evidence_storage_events e JOIN attempt_evidence_archives ar ON ar.id=e.archive_id AND ar.result_attempt_id=e.result_attempt_id;
--> statement-breakpoint
-- Classifier calls obtain presence/type/count from one small document. Only
-- equality for a removed leaf needs its recorded 0207 digest. The binary UUID
-- pair binds a short document to its attempt and archive without touching the
-- original evidence row. Existing v1 proofs retain their direct key lookup.
CREATE FUNCTION attempt_evidence_stored_fact(attempt_id uuid,archive_id uuid,projection jsonb,path text[],hashes boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE facts jsonb; removed jsonb; idx integer; mask bigint; series jsonb; ordinary_owner text;
BEGIN
  IF archive_id IS NULL THEN RETURN NULL; END IF;
  IF projection IS NULL OR projection->>'version' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Attempt history projection is missing or belongs to another source';
  END IF;
  ordinary_owner:=projection->>'attemptId';
  IF ordinary_owner IS NOT NULL THEN
    IF ordinary_owner IS DISTINCT FROM attempt_id::text OR projection->>'archiveId' IS DISTINCT FROM archive_id::text THEN
      RAISE EXCEPTION 'Attempt history projection is missing or belongs to another source';
    END IF;
    facts:=projection->'values'->(array_to_json(path)::text);
    IF facts IS NOT NULL THEN
      RETURN CASE WHEN hashes THEN facts ELSE facts-ARRAY['byteSize','sourceSha256','semanticSha256'] END;
    END IF;
    FOR removed IN SELECT * FROM jsonb_array_elements(projection->'removedPaths') LOOP
      IF cardinality(path)>jsonb_array_length(removed) AND to_jsonb(path[1:jsonb_array_length(removed)])=removed THEN
        RAISE EXCEPTION 'A removed array descendant requires full attempt read-through';
      END IF;
    END LOOP;
    RETURN NULL;
  END IF;
  IF NOT (projection?'shortFacts') OR projection->>'owner' IS DISTINCT FROM attempt_evidence_proof_owner(attempt_id,archive_id) THEN
    RAISE EXCEPTION 'Attempt history projection is missing or belongs to another source';
  END IF;
  mask:=(projection#>>'{shortFacts,3}')::bigint;
  idx:=(attempt_evidence_short_path_indexes()->>(array_to_json(path)::text))::integer;
  IF idx IS NOT NULL THEN
    IF hashes AND (mask & (1::bigint<<idx))<>0 THEN
      SELECT ar.history_series INTO series FROM attempt_evidence_archives ar WHERE ar.id=$2 AND ar.result_attempt_id=$1
        AND ar.source_sha256=projection->>'sourceSha256' AND ar.source_byte_size=(projection->>'sourceByteSize')::bigint;
      IF NOT FOUND THEN RAISE EXCEPTION 'Short attempt projection belongs to another original'; END IF;
    END IF;
    RETURN attempt_evidence_short_fact(projection,series,idx,path,hashes);
  END IF;
  IF cardinality(path)>2 THEN
    idx:=(attempt_evidence_short_path_indexes()->>(array_to_json(path[1:2])::text))::integer;
    IF idx IS NOT NULL AND (mask & (1::bigint<<idx))<>0 THEN
      RAISE EXCEPTION 'A removed array descendant requires full attempt read-through';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION attempt_evidence_projected_value(attempt_id uuid,archive_id uuid,projection jsonb,path text[]) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT attempt_evidence_stored_fact($1,$2,$3,$4,true) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION attempt_evidence_array_facts(attempt_id uuid,archive_id uuid,inline_value jsonb,projection jsonb,path text[]) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE facts jsonb;
BEGIN
  IF archive_id IS NOT NULL THEN
    facts:=attempt_evidence_stored_fact(attempt_id,archive_id,projection,path,false);
    IF facts IS NOT NULL THEN RETURN facts; END IF;
  END IF;
  RETURN jsonb_build_object('path',path,'present',inline_value IS NOT NULL,'jsonType',jsonb_typeof(inline_value),
    'length',CASE WHEN jsonb_typeof(inline_value)='array' THEN jsonb_array_length(inline_value) END);
END;
$$;
ALTER FUNCTION attempt_evidence_value_matches(uuid,uuid,jsonb,jsonb,text[],jsonb) STABLE;
ALTER FUNCTION attempt_evidence_value_equals(uuid,uuid,jsonb,jsonb,text[],jsonb) STABLE;
