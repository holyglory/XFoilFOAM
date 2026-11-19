-- A rejected outbox entry is often an exact duplicate of a worker report.
-- Keep its independent rejection reason and identity, with only one full body.
ALTER TABLE progressive_worker_report_conflicts
  ADD COLUMN IF NOT EXISTS body_source_sequence bigint CHECK (body_source_sequence = sequence);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='progressive_worker_report_conflicts'::regclass
    AND conname='progressive_worker_conflict_body_fk') THEN
    ALTER TABLE progressive_worker_report_conflicts ADD CONSTRAINT progressive_worker_conflict_body_fk
      FOREIGN KEY (sim_job_id,body_source_sequence) REFERENCES progressive_worker_reports(sim_job_id,sequence)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION progressive_worker_conflict_body_matches(job uuid, seq bigint, signature text, body jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT EXISTS (SELECT FROM public.progressive_worker_reports w
    LEFT JOIN public.progressive_report_archive_members m ON m.bundle_id=w.archive_bundle_id
      AND m.source_kind='worker' AND m.member_kind='report'
      AND m.sim_job_id=w.sim_job_id AND m.sequence=w.sequence AND m.content_signature=w.content_signature
    WHERE w.sim_job_id=job AND w.sequence=seq AND w.content_signature=signature
      AND CASE WHEN w.archived_at IS NULL THEN
        CASE WHEN pg_catalog.record_image_eq(
          ROW(public.resolve_progressive_report(w.report,w.result_payload_hash)),ROW(body))
          THEN true ELSE
          public.resolve_progressive_report(w.report,w.result_payload_hash)::text COLLATE "C" = body::text COLLATE "C"
        END
      ELSE m.report_byte_size=octet_length(body::text)
        AND m.report_sha256=encode(sha256(convert_to(body::text,'UTF8')),'hex') END)
$$;

CREATE OR REPLACE FUNCTION protect_progressive_worker_report_conflict() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.body_source_sequence IS NOT NULL OR NEW.archive_bundle_id IS NOT NULL OR NEW.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Conflict insertion requires full original report bytes';
    END IF;
    IF progressive_worker_conflict_body_matches(NEW.sim_job_id,NEW.sequence,NEW.content_signature,NEW.report) THEN
      NEW.body_source_sequence := NEW.sequence;
      NEW.report := progressive_report_compact_header(NEW.report);
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.sim_job_id,NEW.sequence,NEW.content_signature,NEW.reason,NEW.created_at)
    IS DISTINCT FROM (OLD.sim_job_id,OLD.sequence,OLD.content_signature,OLD.reason,OLD.created_at)
  THEN RAISE EXCEPTION 'Progressive report conflict identity is immutable'; END IF;
  IF OLD.body_source_sequence IS NULL AND NEW.body_source_sequence=OLD.sequence
    AND OLD.archived_at IS NULL AND NEW.archived_at IS NULL AND NEW.archive_bundle_id IS NULL
    AND NEW.report=OLD.report THEN
    IF NOT progressive_worker_conflict_body_matches(OLD.sim_job_id,OLD.sequence,OLD.content_signature,OLD.report)
    THEN RETURN NULL; END IF;
    NEW.report := progressive_report_compact_header(OLD.report);
    RETURN NEW;
  END IF;
  IF NEW.body_source_sequence IS DISTINCT FROM OLD.body_source_sequence THEN
    RAISE EXCEPTION 'Conflict body source must hold the identical report';
  END IF;
  IF OLD.body_source_sequence IS NULL AND OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
    AND NEW.archive_bundle_id IS NOT NULL AND NEW.report=progressive_report_compact_header(OLD.report)
    AND progressive_report_archive_member_exists('worker',OLD.sim_job_id,OLD.sequence,'conflict',OLD.content_signature,NEW.archive_bundle_id)
  THEN RETURN NEW; END IF;
  IF (NEW.archived_at,NEW.archive_bundle_id,NEW.report) IS DISTINCT FROM (OLD.archived_at,OLD.archive_bundle_id,OLD.report)
  THEN RAISE EXCEPTION 'Progressive report conflict identity is immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER progressive_worker_report_conflict_immutable
  BEFORE INSERT OR UPDATE ON progressive_worker_report_conflicts
  FOR EACH ROW EXECUTE FUNCTION protect_progressive_worker_report_conflict();

-- Resolve metadata and the exact source row together, including after that
-- source itself moves to GCS. Consumers can then use the common archive reader.
CREATE OR REPLACE VIEW progressive_worker_conflict_storage AS
  SELECT c.sim_job_id,c.sequence,c.content_signature,c.reason,c.created_at,
    CASE WHEN c.body_source_sequence IS NULL THEN c.report ELSE w.report END AS report,
    CASE WHEN c.body_source_sequence IS NOT NULL THEN w.result_payload_hash END AS result_payload_hash,
    CASE WHEN c.body_source_sequence IS NULL THEN c.archive_bundle_id ELSE w.archive_bundle_id END AS archive_bundle_id,
    CASE WHEN c.body_source_sequence IS NULL THEN 'conflict' ELSE 'report' END AS member_kind
  FROM progressive_worker_report_conflicts c LEFT JOIN progressive_worker_reports w
    ON w.sim_job_id=c.sim_job_id AND w.sequence=c.body_source_sequence AND w.content_signature=c.content_signature;
