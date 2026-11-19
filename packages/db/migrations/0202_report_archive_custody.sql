-- The worker outbox also acknowledges locally rejected reports. Only an
-- independently verified copy of this exact body allows it to leave SQL.
DROP INDEX IF EXISTS progressive_worker_reports_compaction_order_idx;
CREATE OR REPLACE FUNCTION progressive_worker_report_evidence_settled(
  p_sim_job_id uuid,
  p_sequence bigint
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sim_jobs job
    WHERE job.id = p_sim_job_id
      AND job.status IN ('done', 'failed', 'cancelled')
      AND job."ingestedAt" IS NOT NULL
      AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
      AND NOT EXISTS (
        SELECT 1 FROM public.progressive_worker_reports pending
        WHERE pending.sim_job_id = p_sim_job_id
          AND pending.acknowledged_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.progressive_worker_evidence_attempts source
        WHERE source.sim_job_id = p_sim_job_id
          AND source.sequence = p_sequence
          AND NOT EXISTS (
            SELECT 1 FROM public.progressive_worker_hub_receipts receipt
            WHERE receipt.sim_job_id = source.sim_job_id
              AND receipt.point_content_signature = source.point_content_signature
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.progressive_worker_delivery_failures failure
            WHERE failure.sim_job_id = source.sim_job_id
              AND failure.point_content_signature = source.point_content_signature
              AND failure.state = 'conflict'
          )
      )
  )
$$;

-- Older writers cannot prove GCS custody. This constant also lets PostgreSQL
-- discard their historical full-table compaction query during a rolling update.
CREATE OR REPLACE FUNCTION progressive_worker_report_compaction_safe(p_sim_job_id uuid,p_sequence bigint)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS 'SELECT false';
ALTER TABLE progressive_report_archive_bundles
  DROP CONSTRAINT IF EXISTS progressive_report_archive_bundles_source_kind_sim_job_id_key;
CREATE INDEX progressive_report_archive_bundles_execution_idx
  ON progressive_report_archive_bundles(source_kind,sim_job_id,first_sequence);
CREATE INDEX IF NOT EXISTS progressive_worker_reports_waiting_archive_idx
  ON progressive_worker_reports(sim_job_id,sequence) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS progressive_remote_reports_waiting_archive_idx
  ON progressive_remote_reports(sim_job_id,sequence) WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION progressive_report_compact_header(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN jsonb_typeof(value->'result')='object'
    THEN jsonb_set(header,'{result}',progressive_report_result_header(value->'result'),false)
    ELSE header END || jsonb_build_object('archivedReport',true)
  FROM (SELECT CASE WHEN jsonb_typeof(value->'status')='object'
    THEN jsonb_set(value,'{status}',(value->'status')-'solver_budget_progress'-'scheduling',false)
    ELSE value END AS header) base
$$;

CREATE OR REPLACE FUNCTION require_progressive_report_archive_custody() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE full_text text;
BEGIN
  IF (OLD.archived_at,OLD.archive_bundle_id) IS NOT DISTINCT FROM
     (NEW.archived_at,NEW.archive_bundle_id) THEN RETURN NEW; END IF;
  IF OLD.archived_at IS NOT NULL OR OLD.archive_bundle_id IS NOT NULL OR
     NEW.archive_bundle_id IS NULL OR NEW.archived_at IS NULL OR
     NEW.report IS DISTINCT FROM progressive_report_compact_header(OLD.report) THEN
    RAISE EXCEPTION 'Full report requires verified exact archive custody before compaction';
  END IF;
  IF TG_ARGV[1]='conflict' THEN
    full_text := OLD.report::text;
  ELSE
    IF NEW.result_payload_hash IS NOT NULL THEN RAISE EXCEPTION 'Archived report still references inline payload'; END IF;
    full_text := resolve_progressive_report(OLD.report,OLD.result_payload_hash)::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.progressive_report_archive_members m
    JOIN public.progressive_report_archive_bundles b ON b.id=m.bundle_id
      AND b.source_kind=m.source_kind AND b.sim_job_id=m.sim_job_id
    WHERE m.bundle_id=NEW.archive_bundle_id AND m.source_kind=TG_ARGV[0] AND m.member_kind=TG_ARGV[1]
      AND m.sim_job_id=OLD.sim_job_id AND m.sequence=OLD.sequence AND m.content_signature=OLD.content_signature
      AND m.report_sha256=encode(sha256(convert_to(full_text,'UTF8')),'hex')
      AND m.report_byte_size=octet_length(full_text)
  ) THEN RAISE EXCEPTION 'Exact report bytes differ from verified archive member'; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER require_worker_report_archive
  BEFORE UPDATE OF archived_at,archive_bundle_id ON progressive_worker_reports
  FOR EACH ROW EXECUTE FUNCTION require_progressive_report_archive_custody('worker','report');
CREATE OR REPLACE TRIGGER require_worker_conflict_archive
  BEFORE UPDATE OF archived_at,archive_bundle_id ON progressive_worker_report_conflicts
  FOR EACH ROW EXECUTE FUNCTION require_progressive_report_archive_custody('worker','conflict');
CREATE OR REPLACE TRIGGER require_remote_report_archive
  BEFORE UPDATE OF archived_at,archive_bundle_id ON progressive_remote_reports
  FOR EACH ROW EXECUTE FUNCTION require_progressive_report_archive_custody('remote','report');

-- Payload normalization may only rewrite a source body still held in SQL.
CREATE FUNCTION protect_archived_progressive_remote_body() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND (NEW.report,NEW.result_payload_hash)
      IS DISTINCT FROM (OLD.report,OLD.result_payload_hash) THEN
    RAISE EXCEPTION 'Archived remote report and its content signature are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_archived_progressive_remote_body BEFORE UPDATE OF report,result_payload_hash
  ON progressive_remote_reports FOR EACH ROW EXECUTE FUNCTION protect_archived_progressive_remote_body();

CREATE OR REPLACE FUNCTION protect_progressive_worker_report() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.sim_job_id, NEW.sequence, NEW.content_signature, NEW.created_at)
    IS DISTINCT FROM (OLD.sim_job_id, OLD.sequence, OLD.content_signature, OLD.created_at)
    OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
  THEN RAISE EXCEPTION 'Progressive worker report content, custody and acknowledgements are immutable'; END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND OLD.acknowledged_at IS NOT NULL
    AND NEW.archive_bundle_id IS NOT NULL AND NEW.result_payload_hash IS NULL
    AND NEW.report=progressive_report_compact_header(OLD.report)
    AND progressive_report_archive_member_exists('worker',OLD.sim_job_id,OLD.sequence,'report',OLD.content_signature,NEW.archive_bundle_id)
    AND progressive_worker_report_evidence_settled(OLD.sim_job_id,OLD.sequence)
  THEN RETURN NEW; END IF;
  IF (NEW.archived_at,NEW.archive_bundle_id) IS DISTINCT FROM (OLD.archived_at,OLD.archive_bundle_id)
    OR ((NEW.report,NEW.result_payload_hash) IS DISTINCT FROM (OLD.report,OLD.result_payload_hash)
      AND (OLD.archived_at IS NOT NULL OR NOT progressive_report_representation_transition(
        OLD.report,OLD.result_payload_hash,NEW.report,NEW.result_payload_hash)))
  THEN RAISE EXCEPTION 'Progressive worker report content, custody and acknowledgements are immutable'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_progressive_worker_report_conflict() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.sim_job_id,NEW.sequence,NEW.content_signature,NEW.reason,NEW.created_at)
    IS DISTINCT FROM (OLD.sim_job_id,OLD.sequence,OLD.content_signature,OLD.reason,OLD.created_at)
  THEN RAISE EXCEPTION 'Progressive report conflict identity is immutable'; END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND NEW.archive_bundle_id IS NOT NULL
    AND NEW.report=progressive_report_compact_header(OLD.report)
    AND progressive_report_archive_member_exists('worker',OLD.sim_job_id,OLD.sequence,'conflict',OLD.content_signature,NEW.archive_bundle_id)
  THEN RETURN NEW; END IF;
  IF (NEW.archived_at,NEW.archive_bundle_id,NEW.report) IS DISTINCT FROM (OLD.archived_at,OLD.archive_bundle_id,OLD.report)
  THEN RAISE EXCEPTION 'Progressive report conflict identity is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER progressive_report_archive_bundles_immutable BEFORE UPDATE OR DELETE ON progressive_report_archive_bundles
  FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
CREATE TRIGGER progressive_report_archive_members_immutable BEFORE UPDATE OR DELETE ON progressive_report_archive_members
  FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
