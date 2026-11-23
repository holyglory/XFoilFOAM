-- Preserve 0209's exact scientific witnesses while sharing immutable result
-- text across staged rows of the same verified group. The independent custody
-- registration and its row-level archive trigger still check every full body.
CREATE OR REPLACE FUNCTION verified_worker_report_science_sources(p_job uuid,p_page jsonb)
RETURNS TABLE(sequence bigint,report_content_signature text,report_sha256 text,report_byte_size bigint,
 result_sha256 text,result_byte_size bigint,envelope jsonb,point_signatures jsonb)
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE
 setup public.sim_jobs%ROWTYPE;
 science jsonb;
 source record;
 source_object jsonb;
 full_text text;
 result_text text;
 result_value jsonb;
 checked_payload boolean;
 result_header jsonb;
BEGIN
 IF jsonb_typeof(p_page->'scientificResults') IS DISTINCT FROM 'array' THEN RETURN; END IF;
 IF jsonb_array_length(p_page->'scientificResults')>128 THEN RAISE EXCEPTION 'Unbounded scientific source page'; END IF;
 SELECT * INTO STRICT setup FROM public.sim_jobs WHERE id=p_job;
 IF setup.request_payload#>>'{remoteProgressiveExecution,scope,executionId}' IS DISTINCT FROM p_job::text
   OR setup.request_payload#>>'{remoteProgressiveExecution,contentSignature}' IS NULL
   OR jsonb_typeof(setup.request_payload->'engineRequest') IS DISTINCT FROM 'object'
   OR (setup.request_payload->'engineRequest')::text COLLATE "C" IS DISTINCT FROM
      (setup.request_payload#>'{remoteProgressiveExecution,request}')::text COLLATE "C"
 THEN RETURN; END IF;
 FOR science IN SELECT item FROM jsonb_array_elements(p_page->'scientificResults') AS groups(item)
 LOOP
   IF science->>'executionId' IS DISTINCT FROM p_job::text THEN CONTINUE; END IF;
   result_text:=science->>'resultText';
   result_value:=result_text::jsonb;
   IF jsonb_typeof(result_value) IS DISTINCT FROM 'object'
     OR octet_length(result_text) IS DISTINCT FROM (science->>'resultByteSize')::bigint
     OR encode(sha256(convert_to(result_text,'UTF8')),'hex') IS DISTINCT FROM science->>'resultSha256'
     OR result_text COLLATE "C" IS DISTINCT FROM result_value::text COLLATE "C"
     OR result_value->>'job_id' IS DISTINCT FROM p_job::text
     OR jsonb_typeof(result_value->'polars') IS DISTINCT FROM 'array'
     OR jsonb_typeof(science->'reports') IS DISTINCT FROM 'array'
     OR jsonb_array_length(science->'reports') NOT BETWEEN 1 AND 128
   THEN RAISE EXCEPTION 'Invalid exact scientific result source'; END IF;
   checked_payload:=false;
   result_header:=public.progressive_report_result_header(result_value);
   FOR source IN
     SELECT r.sequence AS source_sequence,r.content_signature AS signature,r.report AS current_report,
       r.result_payload_hash,r.archived_at,r.archive_bundle_id,proof."envelopeText" AS envelope_text,
       expected."reportSha256" AS expected_sha,expected."reportByteSize" AS expected_bytes,
       member.report_sha256 AS archived_sha,member.report_byte_size AS archived_bytes
     FROM jsonb_to_recordset(science->'reports') proof(sequence bigint,"contentSignature" text,"envelopeText" text)
     JOIN public.progressive_worker_reports r ON r.sim_job_id=p_job AND r.sequence=proof.sequence
       AND r.content_signature=proof."contentSignature" AND r.acknowledged_at IS NOT NULL
     JOIN public.progressive_worker_evidence_receipts staged ON staged.sim_job_id=r.sim_job_id
       AND staged.sequence=r.sequence AND staged.content_signature=r.content_signature
     JOIN jsonb_to_recordset(p_page->'members') expected(kind text,"executionId" uuid,sequence bigint,
       "contentSignature" text,"reportSha256" text,"reportByteSize" bigint)
       ON expected.kind='report' AND expected."executionId"=r.sim_job_id AND expected.sequence=r.sequence
         AND expected."contentSignature"=r.content_signature
     LEFT JOIN public.progressive_report_archive_members member ON member.bundle_id=r.archive_bundle_id
       AND member.source_kind='worker' AND member.member_kind='report' AND member.sim_job_id=r.sim_job_id
       AND member.sequence=r.sequence AND member.content_signature=r.content_signature
     WHERE public.worker_report_science_evidence_matches(p_job,r.sequence,science->'pointSignatures')
     ORDER BY r.sequence LIMIT 128
   LOOP
     source_object:=source.envelope_text::jsonb;
     IF jsonb_typeof(source_object)='object' AND source_object ? 'result' THEN
       -- Each group already carries the exact canonical PostgreSQL result text.
       -- jsonb_each emits the envelope keys in JSONB order. PostgreSQL still
       -- quotes each key and formats every other value, including numeric scale.
       SELECT '{'||string_agg(to_jsonb(k)::text||': '||
          CASE WHEN k='result' THEN result_text ELSE v::text END, ', ' ORDER BY ord)||'}'
         INTO STRICT full_text FROM jsonb_each(source_object) WITH ORDINALITY AS item(k,v,ord);
     ELSE
       source_object:=jsonb_set(source_object,'{result}',result_value,false);
       full_text:=source_object::text;
     END IF;
     IF octet_length(full_text) IS DISTINCT FROM source.expected_bytes
        OR encode(sha256(convert_to(full_text,'UTF8')),'hex') IS DISTINCT FROM source.expected_sha
     THEN RAISE EXCEPTION 'Scientific source differs from exact staged report'; END IF;
     IF source_object->>'archivedReport'='true' OR source_object->>'executionId' IS DISTINCT FROM p_job::text
       OR source_object->>'sequence' IS DISTINCT FROM source.source_sequence::text OR source_object->>'version' IS DISTINCT FROM '1'
       OR source_object#>>'{status,job_id}' IS DISTINCT FROM p_job::text
       OR (source_object->'stopProof'<>'null'::jsonb AND source_object#>>'{stopProof,job_id}' IS DISTINCT FROM p_job::text)
       OR source_object->>'assignmentSignature' IS DISTINCT FROM setup.request_payload#>>'{remoteProgressiveExecution,contentSignature}'
       OR source_object->>'solverId' IS DISTINCT FROM setup.request_payload#>>'{remoteProgressiveExecution,solverId}'
       OR source_object->>'promiseId' IS DISTINCT FROM setup.request_payload->>'syncPromiseId'
       OR (source_object-ARRAY['sequence','status','result','stopProof','archivedReport'])::text COLLATE "C" IS DISTINCT FROM
          (source.current_report-ARRAY['sequence','status','result','stopProof','archivedReport'])::text COLLATE "C"
     THEN CONTINUE; END IF;
     IF source.archived_at IS NOT NULL THEN
       IF source.archive_bundle_id IS NULL OR source.archived_sha IS DISTINCT FROM source.expected_sha
         OR source.archived_bytes IS DISTINCT FROM source.expected_bytes
       THEN RAISE EXCEPTION 'Cold scientific source lacks exact archived original'; END IF;
     ELSIF source.result_payload_hash=science->>'resultSha256'
         AND jsonb_typeof(source_object)='object' AND source_object ? 'result' THEN
       -- 0198 makes this payload immutable. Compare its actual PostgreSQL text
       -- to the authenticated group once. Check every row's result header and
       -- every other field byte-for-byte before returning its scientific proof.
       IF NOT checked_payload THEN
         SELECT payload.byte_size=octet_length(result_text)
             AND payload.result::text COLLATE "C"=result_text COLLATE "C"
           INTO checked_payload FROM public.progressive_report_result_payloads payload
           WHERE payload.content_hash=source.result_payload_hash;
         IF checked_payload IS DISTINCT FROM true THEN
           RAISE EXCEPTION 'Warm scientific source differs from staged body';
         END IF;
       END IF;
       IF source.current_report->'result' IS DISTINCT FROM result_header
          OR (source.current_report-'result')::text COLLATE "C" IS DISTINCT FROM
             (source_object-'result')::text COLLATE "C"
       THEN RAISE EXCEPTION 'Warm scientific source differs from staged body'; END IF;
     ELSIF full_text COLLATE "C" IS DISTINCT FROM
       public.resolve_progressive_report(source.current_report,source.result_payload_hash)::text COLLATE "C"
     THEN RAISE EXCEPTION 'Warm scientific source differs from staged body'; END IF;
     sequence:=source.source_sequence; report_content_signature:=source.signature;
     report_sha256:=source.expected_sha; report_byte_size:=source.expected_bytes;
     result_sha256:=science->>'resultSha256'; result_byte_size:=(science->>'resultByteSize')::bigint;
     envelope:=source_object-ARRAY['sequence','status','result','stopProof','archivedReport'];
     point_signatures:=science->'pointSignatures';
     RETURN NEXT;
   END LOOP;
 END LOOP;
END;
$$;
