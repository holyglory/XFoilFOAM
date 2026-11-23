-- Membership describes the stored report header at this (job, sequence).
-- Ownership, conflicts, retries, signed bodies and all evidence receipts remain
-- with their original tables. Initially the view uses the original predicate.
CREATE TABLE progressive_worker_staging_keys (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  created_at timestamptz NOT NULL,
  stopped_engine_job_id text,
  PRIMARY KEY (sim_job_id, sequence),
  CONSTRAINT worker_staging_keys_report_fk FOREIGN KEY (sim_job_id, sequence)
    REFERENCES progressive_worker_reports(sim_job_id, sequence) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX progressive_worker_staging_keys_order_idx ON progressive_worker_staging_keys
  (created_at, sim_job_id, sequence);
--> statement-breakpoint
CREATE INDEX progressive_worker_staging_keys_job_order_idx ON progressive_worker_staging_keys
  (sim_job_id, created_at, sequence);
--> statement-breakpoint
CREATE INDEX progressive_worker_staging_keys_terminal_order_idx ON progressive_worker_staging_keys
  (created_at, sim_job_id, sequence) WHERE stopped_engine_job_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE progressive_worker_staging_key_backfill (
  singleton boolean PRIMARY KEY CONSTRAINT worker_staging_key_singleton_check CHECK (singleton),
  tracking_instance_id uuid NOT NULL,
  after_job uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  after_sequence bigint NOT NULL DEFAULT 0,
  complete boolean NOT NULL DEFAULT false,
  reads_enabled boolean NOT NULL DEFAULT false CONSTRAINT worker_staging_key_reads_check CHECK (NOT reads_enabled OR complete),
  index_phase text NOT NULL DEFAULT 'present' CONSTRAINT worker_staging_key_phase_check CHECK (index_phase IN ('present','retiring','retired','restoring')),
  parity_checked_at timestamptz,
  parity_count bigint,
  tracking_signature text CONSTRAINT worker_staging_key_trigger_hash_check CHECK (tracking_signature IS NULL OR tracking_signature ~ '^[0-9a-f]{64}$'),
  retirement_revision text CONSTRAINT worker_staging_key_revision_check CHECK (retirement_revision IS NULL OR retirement_revision ~ '^[0-9a-f]{40}$'),
  CONSTRAINT worker_staging_key_active_phase_check CHECK (index_phase='present' OR reads_enabled)
);
--> statement-breakpoint
-- Both triggers are initially disabled. Tracking is opt-in per registered
-- database instance, before its first backfill page. Hub installations never
-- execute the functions or populate a progress row on first deployment.
CREATE FUNCTION maintain_progressive_worker_staging_key() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public SET enable_seqscan=off AS $$
BEGIN
  -- A verified 0198 reference always has an object-shaped stored result header.
  -- Otherwise use the exact existing partial index, or the source PK after
  -- retirement. Only the first acknowledgement needs this membership lookup.
  IF NEW.result_payload_hash IS NULL THEN
    PERFORM 1 FROM public.progressive_worker_reports r
      WHERE (r.sim_job_id,r.sequence,r.created_at)=(NEW.sim_job_id,NEW.sequence,NEW.created_at)
        AND r.acknowledged_at IS NOT NULL AND jsonb_typeof(r.report->'result')='object';
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  INSERT INTO public.progressive_worker_staging_keys AS k
    (sim_job_id,sequence,created_at,stopped_engine_job_id)
    VALUES (NEW.sim_job_id,NEW.sequence,NEW.created_at,NEW.stopped_engine_job_id)
  ON CONFLICT (sim_job_id,sequence) DO UPDATE
    SET created_at=EXCLUDED.created_at,stopped_engine_job_id=EXCLUDED.stopped_engine_job_id
    WHERE (k.created_at,k.stopped_engine_job_id)
      IS DISTINCT FROM (EXCLUDED.created_at,EXCLUDED.stopped_engine_job_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER progressive_worker_staging_key_insert
  AFTER INSERT ON progressive_worker_reports FOR EACH ROW
  WHEN (NEW.acknowledged_at IS NOT NULL) EXECUTE FUNCTION maintain_progressive_worker_staging_key();
--> statement-breakpoint
CREATE TRIGGER progressive_worker_staging_key_ack
  AFTER UPDATE OF acknowledged_at ON progressive_worker_reports FOR EACH ROW
  WHEN (OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL)
  EXECUTE FUNCTION maintain_progressive_worker_staging_key();
--> statement-breakpoint
ALTER TABLE progressive_worker_reports DISABLE TRIGGER progressive_worker_staging_key_insert,
  DISABLE TRIGGER progressive_worker_staging_key_ack;
--> statement-breakpoint
CREATE FUNCTION progressive_worker_staging_key_tracking_enabled() RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
 SELECT count(*)=2 FROM pg_trigger t WHERE t.tgrelid='public.progressive_worker_reports'::regclass
   AND t.tgfoid='public.maintain_progressive_worker_staging_key()'::regprocedure AND t.tgenabled IN ('O','A')
   AND NOT t.tgisinternal AND t.tgqual IS NOT NULL AND
     ((t.tgname='progressive_worker_staging_key_insert' AND t.tgtype=5) OR
      (t.tgname='progressive_worker_staging_key_ack' AND t.tgtype=17))
$$;
--> statement-breakpoint
-- 0202's immutable source guard enforces immutable creation time, sequence
-- and an existing acknowledgement. 0198 normalization/exact inline restore
-- and 0202/0209 compaction preserve both result-object membership and stop ID.
-- Consequently body-only writes, pointer-only writes and ACK replays require
-- no tracking event. Actual source deletion cascades via the composite FK.
CREATE FUNCTION start_progressive_worker_staging_key_tracking(expected_instance uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE tracked uuid;
BEGIN
  IF NOT pg_try_advisory_xact_lock(218,1) THEN
    RAISE EXCEPTION 'Worker staging key maintenance is busy' USING ERRCODE='55P03';
  END IF;
  SELECT tracking_instance_id INTO tracked FROM public.progressive_worker_staging_key_backfill WHERE singleton;
  IF FOUND THEN
    IF tracked IS DISTINCT FROM expected_instance OR NOT EXISTS (SELECT FROM public.sync_api_settings
        WHERE id=1 AND instance_id=expected_instance AND remote_solver_enabled AND remote_solver_registered_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Expected the exact registered worker instance';
    END IF;
    IF NOT public.progressive_worker_staging_key_tracking_enabled() THEN
      RAISE EXCEPTION 'Worker staging key tracking triggers are disabled or missing';
    END IF;
    RETURN;
  END IF;
  -- Only initial activation locks the settings tuple and source relation.
  PERFORM 1 FROM public.sync_api_settings WHERE id=1 AND instance_id=expected_instance
    AND remote_solver_enabled AND remote_solver_registered_id IS NOT NULL FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expected the exact registered worker instance'; END IF;
  LOCK TABLE public.progressive_worker_reports IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  ALTER TABLE public.progressive_worker_reports ENABLE TRIGGER progressive_worker_staging_key_insert,
    ENABLE TRIGGER progressive_worker_staging_key_ack;
  INSERT INTO public.progressive_worker_staging_key_backfill(singleton,tracking_instance_id) VALUES(true,expected_instance);
END $$;
--> statement-breakpoint
CREATE FUNCTION stop_progressive_worker_staging_key_tracking(expected_instance uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE state public.progressive_worker_staging_key_backfill%ROWTYPE;
BEGIN
  IF NOT pg_try_advisory_xact_lock(218,1) THEN
    RAISE EXCEPTION 'Worker staging key maintenance is busy' USING ERRCODE='55P03';
  END IF;
  SELECT * INTO state FROM public.progressive_worker_staging_key_backfill WHERE singleton FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RETURN; END IF;
  IF expected_instance IS DISTINCT FROM state.tracking_instance_id OR NOT EXISTS
       (SELECT FROM public.sync_api_settings WHERE id=1 AND instance_id=expected_instance) THEN
    RAISE EXCEPTION 'Expected the exact tracking instance';
  END IF;
  IF state.reads_enabled OR state.index_phase<>'present' OR EXISTS (
      SELECT FROM pg_rewrite r JOIN pg_depend d ON d.classid='pg_rewrite'::regclass AND d.objid=r.oid
      WHERE r.ev_class='public.progressive_worker_staging_candidates'::regclass AND d.refclassid='pg_class'::regclass
        AND d.refobjid='public.progressive_worker_staging_keys'::regclass) THEN
    RAISE EXCEPTION 'Restore source indexes and source-backed reads before stopping tracking';
  END IF;
  LOCK TABLE public.progressive_worker_reports IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  LOCK TABLE public.progressive_worker_staging_keys IN ACCESS EXCLUSIVE MODE NOWAIT;
  ALTER TABLE public.progressive_worker_reports DISABLE TRIGGER progressive_worker_staging_key_insert,
    DISABLE TRIGGER progressive_worker_staging_key_ack;
  TRUNCATE public.progressive_worker_staging_keys;
  DELETE FROM public.progressive_worker_staging_key_backfill WHERE singleton;
END $$;
--> statement-breakpoint
CREATE VIEW progressive_worker_staging_candidates WITH (security_invoker=true) AS
  SELECT sim_job_id, sequence, created_at, stopped_engine_job_id
  FROM public.progressive_worker_reports
  WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object';
--> statement-breakpoint
-- Bootstrap and independent parity verification both walk the existing covering
-- partial index. An unanticipated plan must not silently detoast whole reports.
CREATE FUNCTION progressive_worker_staging_key_page(after_job uuid, after_sequence bigint, page_size integer)
RETURNS TABLE (sim_job_id uuid, sequence bigint, created_at timestamptz)
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public SET enable_seqscan=off AS $$
DECLARE
  plan jsonb;
  query CONSTANT text := $query$
    SELECT r.sim_job_id,r.sequence,r.created_at FROM public.progressive_worker_reports r
    WHERE r.acknowledged_at IS NOT NULL AND jsonb_typeof(r.report->'result')='object'
      AND (r.sim_job_id,r.sequence)>($1,$2)
    ORDER BY r.sim_job_id,r.sequence,r.created_at LIMIT $3
  $query$;
BEGIN
  IF page_size IS NULL OR page_size NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'Staging key page size must be between 1 and 512';
  END IF;
  EXECUTE 'EXPLAIN (FORMAT JSON, COSTS OFF) ' || query INTO plan
    USING after_job,after_sequence,page_size;
  IF plan#>>'{0,Plan,Node Type}' IS DISTINCT FROM 'Limit'
    OR plan#>>'{0,Plan,Plans,0,Node Type}' IS DISTINCT FROM 'Index Only Scan'
    OR plan#>>'{0,Plan,Plans,0,Index Name}' IS DISTINCT FROM 'progressive_worker_reports_staging_candidate_idx'
    OR plan#>'{0,Plan,Plans,0,Filter}' IS NOT NULL
    OR plan#>'{0,Plan,Plans,0,Recheck Cond}' IS NOT NULL THEN
    RAISE EXCEPTION 'Staging key backfill needs the covering staging_candidate index plan';
  END IF;
  RETURN QUERY EXECUTE query USING after_job,after_sequence,page_size;
END $$;
--> statement-breakpoint
-- Run a single bounded call per repeatable-read transaction. A source change
-- since the snapshot raises 40001. A busy source or another backfiller raises
-- 55P03. In either case roll back the transaction and retry the same cursor.
CREATE FUNCTION backfill_progressive_worker_staging_keys(page_size integer)
RETURNS TABLE (visited integer, changed integer, complete boolean)
LANGUAGE plpgsql SET search_path=pg_catalog,public SET enable_seqscan=off AS $$
DECLARE
  cursor_state public.progressive_worker_staging_key_backfill%ROWTYPE;
  page jsonb;
  last_job uuid;
  last_sequence bigint;
BEGIN
  IF page_size IS NULL OR page_size NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'Staging key page size must be between 1 and 512';
  END IF;
  IF current_setting('transaction_isolation') NOT IN ('repeatable read','serializable') THEN
    RAISE EXCEPTION 'Staging key backfill requires a repeatable-read transaction';
  END IF;
  SELECT s.* INTO cursor_state FROM public.progressive_worker_staging_key_backfill s
    WHERE s.singleton FOR UPDATE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Start staging key tracking on this worker before backfill'; END IF;
  IF cursor_state.complete THEN
    RETURN QUERY SELECT 0,0,true;
    RETURN;
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(k)),'[]'::jsonb) INTO page
    FROM public.progressive_worker_staging_key_page(cursor_state.after_job,cursor_state.after_sequence,page_size) k;

  WITH candidates AS MATERIALIZED (
    SELECT * FROM jsonb_to_recordset(page) AS c(sim_job_id uuid, sequence bigint, created_at timestamptz)
  ), locked AS MATERIALIZED (
    -- Lock source tuples before touching their keys, in the same order as
    -- writers. Read only stored scalars here. A skipped row would lose history.
    SELECT c.sim_job_id,c.sequence,c.created_at,src.stopped_engine_job_id FROM candidates c
    CROSS JOIN LATERAL (
      SELECT r.stopped_engine_job_id FROM public.progressive_worker_reports r
      WHERE (r.sim_job_id,r.sequence)=(c.sim_job_id,c.sequence) FOR SHARE OF r NOWAIT
    ) src
  ), inserted AS (
    INSERT INTO public.progressive_worker_staging_keys AS k
      (sim_job_id,sequence,created_at,stopped_engine_job_id)
    SELECT l.sim_job_id,l.sequence,l.created_at,l.stopped_engine_job_id FROM locked l
    ORDER BY l.sim_job_id,l.sequence
    ON CONFLICT (sim_job_id,sequence) DO UPDATE
      SET created_at=EXCLUDED.created_at,stopped_engine_job_id=EXCLUDED.stopped_engine_job_id
      WHERE (k.created_at,k.stopped_engine_job_id)
        IS DISTINCT FROM (EXCLUDED.created_at,EXCLUDED.stopped_engine_job_id)
    RETURNING 1
  )
  SELECT (SELECT count(*)::integer FROM locked),(SELECT count(*)::integer FROM inserted),
    tail.sim_job_id,tail.sequence INTO visited,changed,last_job,last_sequence
  FROM (VALUES(1)) seed(n) LEFT JOIN LATERAL (
    SELECT c.sim_job_id,c.sequence FROM candidates c ORDER BY c.sim_job_id DESC,c.sequence DESC LIMIT 1
  ) tail ON true;
  IF visited<>jsonb_array_length(page) THEN
    RAISE EXCEPTION 'A candidate changed during staging key backfill' USING ERRCODE='40001';
  END IF;
  complete := visited=0;
  UPDATE public.progressive_worker_staging_key_backfill AS s
    SET after_job=coalesce(last_job,s.after_job),after_sequence=coalesce(last_sequence,s.after_sequence),
        complete=(last_job IS NULL)
    WHERE s.singleton;
  RETURN NEXT;
END $$;
--> statement-breakpoint
-- Explicit cutover after parity and consumer-plan verification. View replacement
-- invalidates prepared plans transactionally. Source reads also remain available
-- as the rollback path. This function is invoker-only and never drops an index.
CREATE FUNCTION set_progressive_worker_staging_key_reads(use_keys boolean) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  state public.progressive_worker_staging_key_backfill%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(218, 1);
  SELECT s.* INTO state FROM public.progressive_worker_staging_key_backfill s WHERE s.singleton FOR UPDATE;
  IF NOT FOUND AND use_keys IS FALSE THEN RETURN; END IF;
  IF use_keys IS NULL OR (use_keys AND NOT coalesce(state.complete,false)) THEN
    RAISE EXCEPTION 'Complete the staging key backfill before enabling key reads';
  END IF;
  IF use_keys AND NOT public.progressive_worker_staging_key_tracking_enabled() THEN
    RAISE EXCEPTION 'Worker staging key tracking triggers are disabled or missing';
  END IF;
  IF use_keys AND state.parity_checked_at IS NULL THEN
    RAISE EXCEPTION 'Verify staging key membership before enabling key reads';
  END IF;
  IF NOT use_keys AND state.index_phase<>'present' THEN
    RAISE EXCEPTION 'Restore the source staging indexes before switching back to source reads';
  END IF;
  IF state.reads_enabled=use_keys THEN RETURN; END IF;
  IF use_keys THEN
    CREATE OR REPLACE VIEW public.progressive_worker_staging_candidates WITH (security_invoker=true) AS
      SELECT sim_job_id,sequence,created_at,stopped_engine_job_id FROM public.progressive_worker_staging_keys;
  ELSE
    CREATE OR REPLACE VIEW public.progressive_worker_staging_candidates WITH (security_invoker=true) AS
      SELECT sim_job_id,sequence,created_at,stopped_engine_job_id FROM public.progressive_worker_reports
      WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object';
  END IF;
  UPDATE public.progressive_worker_staging_key_backfill SET reads_enabled=use_keys WHERE singleton;
END $$;
