-- Full progressive report bodies live in immutable, generation-pinned object
-- bundles. PostgreSQL keeps identities, custody metadata and compact headers.
CREATE TABLE progressive_report_archive_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN ('remote', 'worker')),
  sim_job_id uuid NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  generation text NOT NULL CHECK (generation ~ '^[1-9][0-9]{0,19}$'),
  mime_type text NOT NULL DEFAULT 'application/gzip',
  compression text NOT NULL DEFAULT 'gzip' CHECK (compression = 'gzip'),
  archive_format text NOT NULL DEFAULT 'jsonl' CHECK (archive_format = 'jsonl'),
  stored_sha256 text NOT NULL CHECK (stored_sha256 ~ '^[a-f0-9]{64}$'),
  stored_byte_size bigint NOT NULL CHECK (stored_byte_size > 0),
  crc32c text NOT NULL CHECK (crc32c ~ '^[A-Za-z0-9+/]{6}==$'),
  member_count integer NOT NULL CHECK (member_count > 0),
  first_sequence bigint NOT NULL CHECK (first_sequence > 0),
  last_sequence bigint NOT NULL CHECK (last_sequence >= first_sequence),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_kind, sim_job_id),
  UNIQUE (bucket, object_key, generation)
);

CREATE TABLE progressive_report_archive_members (
  bundle_id uuid NOT NULL REFERENCES progressive_report_archive_bundles(id) ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind IN ('remote', 'worker')),
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  member_kind text NOT NULL CHECK (member_kind IN ('report', 'conflict')),
  content_signature text NOT NULL CHECK (content_signature ~ '^[a-f0-9]{64}$'),
  report_sha256 text NOT NULL CHECK (report_sha256 ~ '^[a-f0-9]{64}$'),
  report_byte_size bigint NOT NULL CHECK (report_byte_size > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_kind, sim_job_id, member_kind, sequence),
  UNIQUE (source_kind, sim_job_id, member_kind, content_signature)
);
CREATE INDEX progressive_report_archive_members_bundle_idx
  ON progressive_report_archive_members(bundle_id, sequence);

ALTER TABLE progressive_remote_reports
  ADD COLUMN archive_bundle_id uuid REFERENCES progressive_report_archive_bundles(id) ON DELETE RESTRICT,
  ADD COLUMN archived_at timestamptz;
ALTER TABLE progressive_worker_reports
  ADD COLUMN archive_bundle_id uuid REFERENCES progressive_report_archive_bundles(id) ON DELETE RESTRICT,
  ADD COLUMN archived_at timestamptz;
ALTER TABLE progressive_worker_report_conflicts
  ADD COLUMN archive_bundle_id uuid REFERENCES progressive_report_archive_bundles(id) ON DELETE RESTRICT,
  ADD COLUMN archived_at timestamptz;

CREATE INDEX progressive_remote_reports_archive_idx
  ON progressive_remote_reports(sim_job_id, sequence)
  WHERE archive_bundle_id IS NOT NULL;
CREATE INDEX progressive_worker_reports_archive_idx
  ON progressive_worker_reports(sim_job_id, sequence)
  WHERE archived_at IS NOT NULL;
CREATE INDEX progressive_worker_report_conflicts_archive_idx
  ON progressive_worker_report_conflicts(sim_job_id, sequence)
  WHERE archived_at IS NOT NULL;

CREATE FUNCTION progressive_report_compact_header(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'version', value->'version',
    'solverId', value->'solverId',
    'promiseId', value->'promiseId',
    'executionId', value->'executionId',
    'sequence', value->'sequence',
    'assignmentSignature', value->'assignmentSignature',
    'status', jsonb_strip_nulls(jsonb_build_object(
      'job_id', value#>'{status,job_id}',
      'state', value#>'{status,state}',
      'total_cases', value#>'{status,total_cases}',
      'completed_cases', value#>'{status,completed_cases}',
      'updated_at', value#>'{status,updated_at}',
      'message', value#>'{status,message}'
    )),
    'result', CASE WHEN value ? 'result' AND jsonb_typeof(value->'result') = 'object'
      THEN CASE WHEN value->'result' ? 'state'
        THEN jsonb_build_object('state', value#>'{result,state}')
        ELSE '{}'::jsonb END
      ELSE value->'result' END,
    'stopProof', value->'stopProof'
  ))
$$;

CREATE FUNCTION progressive_report_archive_member_exists(
  p_source_kind text,
  p_sim_job_id uuid,
  p_sequence bigint,
  p_member_kind text,
  p_signature text,
  p_bundle_id uuid
) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.progressive_report_archive_members member
    WHERE member.source_kind = p_source_kind
      AND member.sim_job_id = p_sim_job_id
      AND member.sequence = p_sequence
      AND member.member_kind = p_member_kind
      AND member.content_signature = p_signature
      AND member.bundle_id = p_bundle_id
  )
$$;

CREATE FUNCTION progressive_worker_report_compaction_safe(
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

CREATE OR REPLACE FUNCTION protect_progressive_worker_report() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE compacting boolean;
BEGIN
  compacting :=
    OLD.archive_bundle_id IS NULL
    AND NEW.archive_bundle_id IS NULL
    AND OLD.archived_at IS NULL
    AND NEW.archived_at IS NOT NULL
    AND NEW.result_payload_hash IS NULL
    AND NEW.report = progressive_report_compact_header(OLD.report)
    AND progressive_worker_report_compaction_safe(OLD.sim_job_id, OLD.sequence);
  IF (NEW.sim_job_id, NEW.sequence, NEW.content_signature, NEW.created_at)
      IS DISTINCT FROM (OLD.sim_job_id, OLD.sequence, OLD.content_signature, OLD.created_at)
    OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
    OR (NEW.archive_bundle_id IS DISTINCT FROM OLD.archive_bundle_id AND NOT compacting)
    OR (NEW.archived_at IS DISTINCT FROM OLD.archived_at AND NOT compacting)
    OR ((NEW.report, NEW.result_payload_hash) IS DISTINCT FROM (OLD.report, OLD.result_payload_hash)
      AND NOT compacting
      AND NOT progressive_report_representation_transition(OLD.report, OLD.result_payload_hash, NEW.report, NEW.result_payload_hash)) THEN
    RAISE EXCEPTION 'Progressive worker report content, custody and acknowledgements are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION protect_progressive_remote_report() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE compacting boolean;
BEGIN
  compacting :=
    OLD.archive_bundle_id IS NULL
    AND NEW.archive_bundle_id IS NOT NULL
    AND OLD.archived_at IS NULL
    AND NEW.archived_at IS NOT NULL
    AND NEW.result_payload_hash IS NULL
    AND NEW.report = progressive_report_compact_header(OLD.report)
    AND progressive_report_archive_member_exists(
      'remote', OLD.sim_job_id, OLD.sequence, 'report', OLD.content_signature, NEW.archive_bundle_id
    );
  IF (NEW.sim_job_id, NEW.sequence, NEW.content_signature, NEW.received_at)
      IS DISTINCT FROM (OLD.sim_job_id, OLD.sequence, OLD.content_signature, OLD.received_at)
    OR (NEW.archive_bundle_id IS DISTINCT FROM OLD.archive_bundle_id AND NOT compacting)
    OR (NEW.archived_at IS DISTINCT FROM OLD.archived_at AND NOT compacting)
    OR ((NEW.report, NEW.result_payload_hash) IS DISTINCT FROM (OLD.report, OLD.result_payload_hash)
      AND NOT compacting
      AND NOT progressive_report_representation_transition(OLD.report, OLD.result_payload_hash, NEW.report, NEW.result_payload_hash)) THEN
    RAISE EXCEPTION 'Progressive remote report content and custody are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_progressive_worker_report_conflict() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE compacting boolean;
BEGIN
  compacting :=
    OLD.archive_bundle_id IS NULL
    AND NEW.archive_bundle_id IS NULL
    AND OLD.archived_at IS NULL
    AND NEW.archived_at IS NOT NULL
    AND NEW.report = progressive_report_compact_header(OLD.report);
  IF (NEW.sim_job_id, NEW.sequence, NEW.content_signature, NEW.reason, NEW.created_at)
      IS DISTINCT FROM (OLD.sim_job_id, OLD.sequence, OLD.content_signature, OLD.reason, OLD.created_at)
    OR (NEW.archive_bundle_id IS DISTINCT FROM OLD.archive_bundle_id AND NOT compacting)
    OR (NEW.archived_at IS DISTINCT FROM OLD.archived_at AND NOT compacting)
    OR (NEW.report IS DISTINCT FROM OLD.report AND NOT compacting) THEN
    RAISE EXCEPTION 'Progressive report conflict identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS progressive_worker_report_conflict_immutable ON progressive_worker_report_conflicts;
CREATE TRIGGER progressive_worker_report_conflict_immutable
  BEFORE UPDATE ON progressive_worker_report_conflicts
  FOR EACH ROW EXECUTE FUNCTION protect_progressive_worker_report_conflict();

CREATE OR REPLACE FUNCTION protect_progressive_report_result_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.progressive_worker_reports WHERE result_payload_hash = OLD.content_hash)
      OR EXISTS (SELECT 1 FROM public.progressive_remote_reports WHERE result_payload_hash = OLD.content_hash) THEN
      RAISE EXCEPTION 'Progressive report result payload is still referenced';
    END IF;
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Progressive report result payload is immutable';
END;
$$;
DROP TRIGGER IF EXISTS progressive_report_result_payloads_immutable ON progressive_report_result_payloads;
CREATE TRIGGER progressive_report_result_payloads_immutable
  BEFORE UPDATE OR DELETE ON progressive_report_result_payloads
  FOR EACH ROW EXECUTE FUNCTION protect_progressive_report_result_payload();
