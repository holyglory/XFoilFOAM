-- A verified operator legacy page can contain several worker executions. Each
-- execution retains its own immutable catalog/ownership row for the same object.
DO $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid='public.progressive_report_archive_bundles'::regclass AND con.contype='u'
      AND (SELECT array_agg(attr.attname::text ORDER BY keys.ordinality)
        FROM unnest(con.conkey) WITH ORDINALITY keys(attnum,ordinality)
        JOIN pg_attribute attr ON attr.attrelid=con.conrelid AND attr.attnum=keys.attnum)
        = ARRAY['bucket','object_key','generation']::text[]
  LOOP
    EXECUTE format('ALTER TABLE public.progressive_report_archive_bundles DROP CONSTRAINT %I',item.conname);
  END LOOP;
END;
$$;

ALTER TABLE progressive_report_archive_bundles
  ADD COLUMN legacy_instance_id uuid,
  ADD COLUMN legacy_solver_id uuid,
  ADD COLUMN legacy_scope_sha256 text,
  ADD COLUMN legacy_page_member_count integer,
  ADD COLUMN legacy_read_mode text,
  ADD COLUMN legacy_local_storage_key text,
  ADD COLUMN legacy_local_verified_at timestamptz,
  ADD CONSTRAINT progressive_report_archive_bundles_object_job_uq
    UNIQUE(bucket,object_key,generation,sim_job_id);
CREATE INDEX progressive_report_archive_worker_volume_idx ON progressive_report_archive_bundles(stored_sha256)
  WHERE source_kind='worker';
CREATE UNIQUE INDEX progressive_report_archive_bundles_canonical_object_uq
  ON progressive_report_archive_bundles(bucket,object_key,generation) WHERE archive_format='jsonl';
ALTER TABLE progressive_report_archive_bundles
  DROP CONSTRAINT progressive_report_archive_bundles_archive_format_check;
ALTER TABLE progressive_report_archive_bundles
  ADD CONSTRAINT progressive_report_archive_bundles_archive_format_check
    CHECK (archive_format IN ('jsonl','legacy-jsonl')),
  ADD CONSTRAINT progressive_report_archive_bundles_legacy_check CHECK (
    (archive_format='jsonl' AND legacy_instance_id IS NULL AND legacy_solver_id IS NULL
      AND legacy_scope_sha256 IS NULL AND legacy_page_member_count IS NULL
      AND legacy_read_mode IS NULL AND legacy_local_storage_key IS NULL AND legacy_local_verified_at IS NULL)
    OR (archive_format='legacy-jsonl' AND source_kind='worker' AND mime_type='application/gzip'
      AND legacy_instance_id IS NOT NULL AND legacy_solver_id IS NOT NULL
      AND legacy_scope_sha256 IS NOT NULL AND legacy_scope_sha256 ~ '^[a-f0-9]{64}$'
      AND legacy_page_member_count IS NOT NULL AND legacy_page_member_count BETWEEN member_count AND 128
      AND object_key='legacy-worker-reports/v1/'||legacy_instance_id::text||'/'||legacy_solver_id::text
        ||'/'||legacy_scope_sha256||'/'||stored_sha256||'.jsonl.gz'
      AND legacy_read_mode IS NOT NULL AND (
        (legacy_read_mode='registered-get' AND legacy_local_storage_key IS NULL AND legacy_local_verified_at IS NULL)
        OR (legacy_read_mode='hub-local-reader' AND legacy_local_storage_key IS NOT NULL
          AND legacy_local_storage_key<>'' AND legacy_local_verified_at IS NOT NULL)))
  );
ALTER TABLE progressive_report_archive_members
  ADD COLUMN legacy_row_sha256 text,
  ADD COLUMN legacy_row_byte_size bigint,
  ADD CONSTRAINT progressive_report_archive_members_legacy_row_check CHECK (
    (legacy_row_sha256 IS NULL AND legacy_row_byte_size IS NULL)
    OR (legacy_row_sha256 IS NOT NULL AND legacy_row_sha256 ~ '^[a-f0-9]{64}$'
      AND legacy_row_byte_size IS NOT NULL AND legacy_row_byte_size > 0)
  );

-- SECURITY INVOKER: this is an operator representation change, not a new sync
-- authority. No dispatch, promise, solver evidence, polar, or alias is created.
-- The application constructs this bound payload only after the registered HZ
-- GET reader returned the exact pinned bytes, or fresh pinned hub bytes were
-- reopened through the durable shared-results worker reader. That local key is
-- an immutable retention dependency: this operation never deletes a local copy.
-- These are measured product reads, not assertions of human confirmation.
-- All local gates are checked again.
CREATE FUNCTION register_legacy_report_archive_custody(page jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  settings public.sync_api_settings%ROWTYPE;
  job public.sim_jobs%ROWTYPE;
  source_report public.progressive_worker_reports%ROWTYPE;
  source_conflict public.progressive_worker_report_conflicts%ROWTYPE;
  bundle public.progressive_report_archive_bundles%ROWTYPE;
  existing_member public.progressive_report_archive_members%ROWTYPE;
  owner_id uuid;
  expected record;
  marker record;
  body_text text;
  report_count integer:=0;
  conflict_count integer:=0;
  replay_count integer:=0;
  alias_count integer:=0;
  member_count integer:=0;
  bundle_count integer:=0;
  matched boolean;
  skipped jsonb:='[]'::jsonb;
  changed jsonb:='[]'::jsonb;
BEGIN
  IF page->>'version' IS DISTINCT FROM '1' OR page->>'sourceInstance' IS NULL OR page->>'solverId' IS NULL
    OR page->>'scopeSha256' IS NULL OR page#>>'{object,bucket}' IS NULL
    OR page#>>'{object,generation}' IS NULL OR page#>>'{object,storedSha256}' IS NULL
    OR page#>>'{object,storedByteSize}' IS NULL OR page#>>'{object,crc32c}' IS NULL
    OR page->>'readMode' IS NULL OR page->>'readMode' NOT IN ('registered-get','hub-local-reader')
    OR page->>'readbackStartedAt' IS NULL
    OR (page->>'readbackStartedAt')::timestamptz < clock_timestamp()-interval '5 minutes'
    OR (page->>'readbackAt')::timestamptz < (page->>'readbackStartedAt')::timestamptz
    OR (page->>'readbackAt')::timestamptz > clock_timestamp()+interval '1 minute'
    OR (page->>'readMode'='registered-get' AND (page->>'localStorageKey' IS NOT NULL OR page->>'localVerifiedAt' IS NOT NULL))
    OR (page->>'readMode'='hub-local-reader' AND (
      page->>'localStorageKey' IS NULL OR page->>'localStorageKey'=''
      OR page->>'localStorageKey' !~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'
      OR (page->>'localStorageKey') ~ '(^|/)\.{1,2}(/|$)'
      OR right(page->>'localStorageKey',length(page#>>'{object,storedSha256}')+9)
        IS DISTINCT FROM (page#>>'{object,storedSha256}')||'.jsonl.gz'
      OR page->>'localVerifiedAt' IS NULL
      OR (page->>'localVerifiedAt')::timestamptz < clock_timestamp()-interval '5 minutes'))
    OR page->>'scopeSha256' !~ '^[a-f0-9]{64}$' OR page->>'readbackAt' IS NULL
    OR jsonb_typeof(page->'members') IS DISTINCT FROM 'array'
    OR jsonb_array_length(page->'members') NOT BETWEEN 1 AND 128
    OR (page#>>'{object,archiveFormat}') IS DISTINCT FROM 'legacy-jsonl'
    OR (page#>>'{object,mimeType}') IS DISTINCT FROM 'application/gzip'
    OR (page#>>'{object,compression}') IS DISTINCT FROM 'gzip'
    OR (page#>>'{object,generation}') !~ '^[1-9][0-9]{0,19}$'
    OR (page#>>'{object,storedSha256}') !~ '^[a-f0-9]{64}$'
    OR (page#>>'{object,crc32c}') !~ '^[A-Za-z0-9+/]{6}==$'
    OR (page#>>'{object,storedByteSize}')::bigint NOT BETWEEN 1 AND 2147483648
    OR page#>>'{object,objectKey}' IS DISTINCT FROM
      'legacy-worker-reports/v1/'||(page->>'sourceInstance')||'/'||(page->>'solverId')||'/'
        ||(page->>'scopeSha256')||'/'||(page#>>'{object,storedSha256}')||'.jsonl.gz'
  THEN RAISE EXCEPTION 'Invalid bound legacy archive page'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_to_recordset(page->'members') AS m(
    kind text,"executionId" uuid,sequence bigint,"contentSignature" text,"reportSha256" text,
    "reportByteSize" bigint,"rowSha256" text,"rowByteSize" bigint)
    WHERE m.kind IS NULL OR m.kind NOT IN ('report','conflict') OR m."executionId" IS NULL
      OR m.sequence IS NULL OR m.sequence < 1 OR m."contentSignature" IS NULL OR m."contentSignature" !~ '^[a-f0-9]{64}$'
      OR m."reportSha256" IS NULL OR m."reportSha256" !~ '^[a-f0-9]{64}$'
      OR m."rowSha256" IS NULL OR m."rowSha256" !~ '^[a-f0-9]{64}$'
      OR m."reportByteSize" IS NULL OR m."reportByteSize" NOT BETWEEN 1 AND 268435456
      OR m."rowByteSize" IS NULL OR m."rowByteSize" NOT BETWEEN 1 AND 268435456)
    OR (SELECT sum(m."reportByteSize"+m."rowByteSize") FROM jsonb_to_recordset(page->'members') AS m("reportByteSize" bigint,"rowByteSize" bigint))>268435456
    OR EXISTS (SELECT 1 FROM jsonb_to_recordset(page->'members') AS m(kind text,"executionId" uuid,sequence bigint)
      GROUP BY m.kind,m."executionId",m.sequence HAVING count(*)>1)
  THEN RAISE EXCEPTION 'Invalid or unbounded legacy archive members'; END IF;
  SELECT * INTO settings FROM public.sync_api_settings WHERE id=1 FOR SHARE;
  IF settings.instance_id IS DISTINCT FROM (page->>'sourceInstance')::uuid
    OR settings.remote_solver_registered_id IS DISTINCT FROM (page->>'solverId')::uuid
    OR settings.upstream_base_url IS NULL OR settings.upstream_base_url=''
  THEN RAISE EXCEPTION 'Registered legacy restore does not match the current worker identity'; END IF;

  FOR marker IN SELECT m."executionId" AS execution_id,count(*)::integer AS count,
      min(m.sequence) AS first_sequence,max(m.sequence) AS last_sequence
    FROM jsonb_to_recordset(page->'members') AS m("executionId" uuid,sequence bigint)
    GROUP BY m."executionId" ORDER BY m."executionId"
  LOOP
    SELECT * INTO job FROM public.sim_jobs WHERE id=marker.execution_id FOR UPDATE;
    IF NOT FOUND THEN
      skipped:=skipped||jsonb_build_array(jsonb_build_object('executionId',marker.execution_id,'reason','missing_job'));
      CONTINUE;
    END IF;
    SELECT promise.id INTO owner_id FROM public.sync_sweep_promises promise
    WHERE promise.id::text=job.request_payload->>'syncPromiseId'
      AND promise.registered_solver_id=settings.remote_solver_registered_id
      AND promise.source_base_url=settings.upstream_base_url
      AND promise.status IN ('fulfilled','expired','cancelled') FOR SHARE;
    IF owner_id IS NULL OR job.status NOT IN ('done','failed','cancelled') OR job."ingestedAt" IS NULL
      OR job.request_payload->>'remoteSolver' IS DISTINCT FROM 'true'
      OR job.request_payload->>'upstreamBaseUrl' IS DISTINCT FROM settings.upstream_base_url
      OR job.engine_job_id IS DISTINCT FROM job.id::text
      OR (job.ingest_lease_token IS NOT NULL AND (job.ingest_lease_expires_at IS NULL OR job.ingest_lease_expires_at>clock_timestamp()))
      OR EXISTS (SELECT 1 FROM public.progressive_worker_reports pending WHERE pending.sim_job_id=job.id AND pending.acknowledged_at IS NULL)
      OR EXISTS (SELECT 1 FROM public.progressive_worker_delivery_failures retry WHERE retry.sim_job_id=job.id AND retry.state='retry')
      OR EXISTS (SELECT 1 FROM public.progressive_worker_evidence_delivery_claims claim
        WHERE claim.sim_job_id=job.id AND claim.claim_expires_at>clock_timestamp())
      OR EXISTS (SELECT 1 FROM public.progressive_worker_evidence_attempts source WHERE source.sim_job_id=job.id
        AND NOT EXISTS (SELECT 1 FROM public.progressive_worker_hub_receipts receipt
          WHERE receipt.sim_job_id=source.sim_job_id AND receipt.point_content_signature=source.point_content_signature)
        AND NOT EXISTS (SELECT 1 FROM public.progressive_worker_delivery_failures conflict
          WHERE conflict.sim_job_id=source.sim_job_id AND conflict.point_content_signature=source.point_content_signature AND conflict.state='conflict'))
      OR NOT EXISTS (SELECT 1 FROM (SELECT stopped.report FROM public.progressive_worker_reports stopped
          WHERE stopped.sim_job_id=job.id ORDER BY stopped.sequence DESC LIMIT 1) latest
        WHERE latest.report->>'solverId'=settings.remote_solver_registered_id::text
          AND latest.report->>'promiseId'=owner_id::text AND latest.report->>'executionId'=job.id::text
          AND latest.report#>>'{status,state}' IN ('completed','failed','cancelled')
          AND latest.report#>>'{stopProof,job_id}'=job.engine_job_id
          AND latest.report#>>'{stopProof,version}'='1'
          AND latest.report#>>'{stopProof,execution_stopped}'='true'
          AND latest.report#>>'{stopProof,producer_stopped}'='true'
          AND latest.report#>>'{stopProof,namespace_verified}'='true'
          AND latest.report#>'{stopProof,remaining}'='[]'::jsonb
          AND latest.report#>'{stopProof,error}'='null'::jsonb
          AND latest.report#>>'{stopProof,fence}' IN ('cancel_marker','terminal_result')
          AND (latest.report#>>'{stopProof,ownership_basis}' IS NULL
            OR latest.report#>>'{stopProof,ownership_basis}' IN ('recorded_execution_namespace','never_started_cancellation_fence'))
          AND (latest.report#>>'{stopProof,ownership_basis}' IS DISTINCT FROM 'never_started_cancellation_fence'
            OR latest.report#>>'{stopProof,fence}'='cancel_marker')
          AND (latest.report#>>'{stopProof,observed_at}')::timestamptz IS NOT NULL)
    THEN
      skipped:=skipped||jsonb_build_array(jsonb_build_object('executionId',job.id,'reason','ownership_or_delivery_unsettled'));
      CONTINUE;
    END IF;
    bundle.id:=NULL;
    FOR expected IN SELECT * FROM jsonb_to_recordset(page->'members') AS m(
      kind text,"executionId" uuid,sequence bigint,"contentSignature" text,"reportSha256" text,
      "reportByteSize" bigint,"rowSha256" text,"rowByteSize" bigint)
      WHERE m."executionId"=job.id ORDER BY m.sequence,m.kind DESC
    LOOP
      IF NOT public.progressive_worker_report_evidence_settled(job.id,expected.sequence) THEN
        skipped:=skipped||jsonb_build_array(jsonb_build_object('executionId',job.id,'kind',expected.kind,'sequence',expected.sequence,'reason','evidence_unsettled'));
        CONTINUE;
      END IF;
      IF expected.kind='conflict' THEN
        SELECT * INTO source_conflict FROM public.progressive_worker_report_conflicts
          WHERE sim_job_id=job.id AND sequence=expected.sequence FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Legacy conflict is missing; page rolled back'; END IF;
        IF source_conflict.content_signature IS DISTINCT FROM expected."contentSignature" THEN
          RAISE EXCEPTION 'Legacy conflict signature changed; page rolled back'; END IF;
        IF source_conflict.body_source_sequence IS NOT NULL THEN
          alias_count:=alias_count+1;
          CONTINUE;
        END IF;
        IF source_conflict.archived_at IS NULL THEN body_text:=source_conflict.report::text; ELSE body_text:=NULL; END IF;
      ELSE
        SELECT * INTO source_report FROM public.progressive_worker_reports
          WHERE sim_job_id=job.id AND sequence=expected.sequence FOR UPDATE;
        IF NOT FOUND OR source_report.content_signature IS DISTINCT FROM expected."contentSignature" THEN
          RAISE EXCEPTION 'Legacy report signature changed or row missing; page rolled back'; END IF;
        IF source_report.archived_at IS NULL THEN
          IF NOT (EXISTS (SELECT 1 FROM public.progressive_worker_evidence_receipts staged WHERE staged.sim_job_id=job.id
                AND staged.sequence=expected.sequence AND staged.content_signature=source_report.content_signature)
            OR EXISTS (SELECT 1 FROM public.progressive_worker_report_conflicts conflict WHERE conflict.sim_job_id=job.id
                AND conflict.sequence=expected.sequence AND conflict.content_signature=source_report.content_signature)
            OR (source_report.result_payload_hash IS NULL AND jsonb_typeof(source_report.report->'result') IS DISTINCT FROM 'object')) THEN
            skipped:=skipped||jsonb_build_array(jsonb_build_object('executionId',job.id,'kind',expected.kind,'sequence',expected.sequence,'reason','report_not_staged'));
            CONTINUE;
          END IF;
          body_text:=public.resolve_progressive_report(source_report.report,source_report.result_payload_hash)::text;
        ELSE body_text:=NULL; END IF;
      END IF;
      IF body_text IS NOT NULL AND (octet_length(body_text)<>expected."reportByteSize"
        OR encode(sha256(convert_to(body_text,'UTF8')),'hex')<>expected."reportSha256")
      THEN RAISE EXCEPTION 'Legacy source differs from registered restore; page rolled back'; END IF;
      IF body_text IS NULL THEN
        SELECT * INTO existing_member FROM public.progressive_report_archive_members m
          WHERE m.source_kind='worker' AND m.sim_job_id=job.id AND m.sequence=expected.sequence AND m.member_kind=expected.kind;
        IF NOT FOUND OR existing_member.bundle_id IS DISTINCT FROM
            CASE WHEN expected.kind='report' THEN source_report.archive_bundle_id ELSE source_conflict.archive_bundle_id END
          OR existing_member.content_signature IS DISTINCT FROM expected."contentSignature"
          OR existing_member.report_sha256 IS DISTINCT FROM expected."reportSha256"
          OR existing_member.report_byte_size IS DISTINCT FROM expected."reportByteSize"
        THEN RAISE EXCEPTION 'Previously archived legacy member differs; page rolled back'; END IF;
        replay_count:=replay_count+1;
        CONTINUE;
      END IF;
      IF bundle.id IS NULL THEN
        INSERT INTO public.progressive_report_archive_bundles(source_kind,sim_job_id,bucket,object_key,generation,
          mime_type,compression,archive_format,stored_sha256,stored_byte_size,crc32c,member_count,first_sequence,last_sequence,
          verified_at,legacy_instance_id,legacy_solver_id,legacy_scope_sha256,legacy_page_member_count,
          legacy_read_mode,legacy_local_storage_key,legacy_local_verified_at)
        VALUES ('worker',job.id,page#>>'{object,bucket}',page#>>'{object,objectKey}',page#>>'{object,generation}',
          'application/gzip','gzip','legacy-jsonl',page#>>'{object,storedSha256}',(page#>>'{object,storedByteSize}')::bigint,
          page#>>'{object,crc32c}',marker.count,marker.first_sequence,marker.last_sequence,(page->>'readbackAt')::timestamptz,
          settings.instance_id,settings.remote_solver_registered_id,page->>'scopeSha256',jsonb_array_length(page->'members'),
          page->>'readMode',page->>'localStorageKey',(page->>'localVerifiedAt')::timestamptz)
        ON CONFLICT (bucket,object_key,generation,sim_job_id) DO NOTHING RETURNING * INTO bundle;
        IF FOUND THEN bundle_count:=bundle_count+1;
        ELSE
          SELECT * INTO STRICT bundle FROM public.progressive_report_archive_bundles
            WHERE bucket=page#>>'{object,bucket}' AND object_key=page#>>'{object,objectKey}'
              AND generation=page#>>'{object,generation}' AND sim_job_id=job.id;
          IF bundle.source_kind<>'worker' OR bundle.archive_format<>'legacy-jsonl'
            OR bundle.stored_sha256<>page#>>'{object,storedSha256}' OR bundle.stored_byte_size<>(page#>>'{object,storedByteSize}')::bigint
            OR bundle.crc32c<>page#>>'{object,crc32c}' OR bundle.member_count<>marker.count
            OR bundle.first_sequence<>marker.first_sequence OR bundle.last_sequence<>marker.last_sequence
            OR bundle.legacy_instance_id IS DISTINCT FROM settings.instance_id
            OR bundle.legacy_solver_id IS DISTINCT FROM settings.remote_solver_registered_id
            OR bundle.legacy_scope_sha256 IS DISTINCT FROM page->>'scopeSha256'
            OR bundle.legacy_page_member_count IS DISTINCT FROM jsonb_array_length(page->'members')
            OR bundle.legacy_read_mode IS DISTINCT FROM page->>'readMode'
            OR bundle.legacy_local_storage_key IS DISTINCT FROM page->>'localStorageKey'
          THEN RAISE EXCEPTION 'Legacy bundle metadata differs; page rolled back'; END IF;
        END IF;
      END IF;
      INSERT INTO public.progressive_report_archive_members(bundle_id,source_kind,sim_job_id,sequence,member_kind,
        content_signature,report_sha256,report_byte_size,legacy_row_sha256,legacy_row_byte_size)
      VALUES (bundle.id,'worker',job.id,expected.sequence,expected.kind,expected."contentSignature",expected."reportSha256",
        expected."reportByteSize",expected."rowSha256",expected."rowByteSize")
      ON CONFLICT (source_kind,sim_job_id,member_kind,sequence) DO NOTHING RETURNING true INTO matched;
      IF matched THEN member_count:=member_count+1; END IF;
      SELECT * INTO STRICT existing_member FROM public.progressive_report_archive_members
        WHERE source_kind='worker' AND sim_job_id=job.id AND sequence=expected.sequence AND member_kind=expected.kind;
      IF existing_member.bundle_id<>bundle.id OR existing_member.content_signature<>expected."contentSignature"
        OR existing_member.report_sha256<>expected."reportSha256" OR existing_member.report_byte_size<>expected."reportByteSize"
        OR existing_member.legacy_row_sha256 IS DISTINCT FROM expected."rowSha256"
        OR existing_member.legacy_row_byte_size IS DISTINCT FROM expected."rowByteSize"
      THEN RAISE EXCEPTION 'Legacy member catalog identity differs; page rolled back'; END IF;
      IF expected.kind='report' THEN
        UPDATE public.progressive_worker_reports SET report=public.progressive_report_compact_header(report),
          result_payload_hash=NULL,archive_bundle_id=bundle.id,archived_at=clock_timestamp()
          WHERE sim_job_id=job.id AND sequence=expected.sequence AND content_signature=expected."contentSignature" AND archived_at IS NULL;
        report_count:=report_count+1;
      ELSE
        UPDATE public.progressive_worker_report_conflicts SET report=public.progressive_report_compact_header(report),
          archive_bundle_id=bundle.id,archived_at=clock_timestamp()
          WHERE sim_job_id=job.id AND sequence=expected.sequence AND content_signature=expected."contentSignature"
            AND archived_at IS NULL AND body_source_sequence IS NULL;
        conflict_count:=conflict_count+1;
      END IF;
      changed:=changed||jsonb_build_array(jsonb_build_object('executionId',job.id,'kind',expected.kind,
        'sequence',expected.sequence,'contentSignature',expected."contentSignature",'reportSha256',expected."reportSha256",
        'reportByteSize',expected."reportByteSize",'bundleId',bundle.id));
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('registeredBundles',bundle_count,'registeredMembers',member_count,'compactedReports',report_count,
    'compactedConflicts',conflict_count,'replayedMembers',replay_count,'aliasesRetained',alias_count,'skipped',skipped,'readMode',page->>'readMode',
    'localStorageKey',page->>'localStorageKey','object',page->'object','readMembers',page->'members',
    'changedMembers',changed,'sourceInstance',page->>'sourceInstance','solverId',page->>'solverId',
    'scopeSha256',page->>'scopeSha256','readbackAt',page->>'readbackAt');
END;
$$;
