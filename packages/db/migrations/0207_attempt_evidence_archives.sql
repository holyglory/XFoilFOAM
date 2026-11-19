-- Verified full-point copies retain the original PG text outside PostgreSQL.
-- The live evidence_payload and all SQL classification/equality inputs stay intact.
CREATE FUNCTION attempt_evidence_series_inventory(payload jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('path', path,
    'byteSize', octet_length((payload #> path)::text),
    'sha256', encode(sha256(convert_to((payload #> path)::text, 'UTF8')), 'hex')) ORDER BY ordinal), '[]'::jsonb)
  FROM (VALUES
    (1,ARRAY['force_history','t']), (2,ARRAY['force_history','cl']),
    (3,ARRAY['force_history','cd']), (4,ARRAY['force_history','cm']),
    (5,ARRAY['forceHistory','t']), (6,ARRAY['forceHistory','cl']),
    (7,ARRAY['forceHistory','cd']), (8,ARRAY['forceHistory','cm']),
    (9,ARRAY['steady_history','iterations']), (10,ARRAY['steady_history','cl']),
    (11,ARRAY['steady_history','cd']), (12,ARRAY['steady_history','cm']),
    (13,ARRAY['steadyHistory','iterations']), (14,ARRAY['steadyHistory','cl']),
    (15,ARRAY['steadyHistory','cd']), (16,ARRAY['steadyHistory','cm']),
    (17,ARRAY['frame_track','frames']), (18,ARRAY['frameTrack','frames'])
  ) series(ordinal,path)
  WHERE jsonb_typeof(payload #> path)='array'
$$;
--> statement-breakpoint
CREATE TABLE attempt_evidence_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_instance text NOT NULL CHECK (source_instance ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  result_attempt_id uuid NOT NULL REFERENCES result_attempts(id) ON DELETE CASCADE,
  result_id uuid,
  sim_job_id uuid,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_byte_size bigint NOT NULL CHECK (source_byte_size BETWEEN 1 AND 33554432),
  history_series jsonb NOT NULL CHECK (jsonb_typeof(history_series)='array' AND jsonb_array_length(history_series)>0),
  history_byte_size bigint NOT NULL CHECK (history_byte_size > 0 AND history_byte_size <= source_byte_size),
  envelope_sha256 text NOT NULL CHECK (envelope_sha256 ~ '^[a-f0-9]{64}$'),
  envelope_byte_size bigint NOT NULL CHECK (envelope_byte_size BETWEEN 1 AND 67174400),
  stored_sha256 text NOT NULL CHECK (stored_sha256 ~ '^[a-f0-9]{64}$'),
  stored_byte_size bigint NOT NULL CHECK (stored_byte_size BETWEEN 1 AND 67305472),
  bucket text NOT NULL CHECK (btrim(bucket)<>'' AND position('/' in bucket)=0),
  object_key text NOT NULL CHECK (btrim(object_key)<>'' AND object_key !~ '^/|(^|/)[.]{1,2}(/|$)|//'),
  generation text NOT NULL CHECK (generation ~ '^[1-9][0-9]{0,19}$' AND generation::numeric <= 18446744073709551615),
  crc32c text NOT NULL CHECK (crc32c ~ '^[A-Za-z0-9+/]{6}==$'),
  verified_at timestamptz NOT NULL,
  CONSTRAINT attempt_evidence_archives_object_uq UNIQUE(bucket,object_key,generation),
  CONSTRAINT attempt_evidence_archives_source_uq UNIQUE(source_instance,result_attempt_id,envelope_sha256),
  CONSTRAINT attempt_evidence_archives_owner_fk FOREIGN KEY (result_attempt_id,result_id)
    REFERENCES result_attempts(id,result_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX attempt_evidence_archives_attempt_source_idx ON attempt_evidence_archives
  (result_attempt_id,source_sha256,source_byte_size);
--> statement-breakpoint
CREATE FUNCTION enforce_attempt_evidence_archive_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE attempt_row result_attempts%ROWTYPE; job_row sim_jobs%ROWTYPE; original_job_id uuid;
        source_text text; inventory jsonb; history_bytes bigint;
BEGIN
  -- Match ingestion's job-then-attempt lock order. No network operation runs
  -- while these short registration locks are held.
  SELECT sim_job_id INTO original_job_id FROM result_attempts WHERE id=NEW.result_attempt_id;
  IF original_job_id IS NOT NULL THEN
    SELECT * INTO job_row FROM sim_jobs WHERE id=original_job_id FOR SHARE;
    IF NOT FOUND OR job_row.status IS NULL OR job_row.status NOT IN ('done','failed','cancelled') OR job_row."ingestedAt" IS NULL
      OR (job_row.ingest_lease_token IS NOT NULL AND (job_row.ingest_lease_expires_at IS NULL OR job_row.ingest_lease_expires_at > clock_timestamp())) THEN
      RAISE EXCEPTION 'Attempt evidence archive source still has an active writer';
    END IF;
  END IF;
  SELECT * INTO attempt_row FROM result_attempts WHERE id=NEW.result_attempt_id FOR SHARE;
  IF NOT FOUND OR attempt_row.status IS NULL OR attempt_row.status NOT IN ('done','failed')
    OR attempt_row.result_id IS DISTINCT FROM NEW.result_id
    OR attempt_row.sim_job_id IS DISTINCT FROM NEW.sim_job_id
    OR attempt_row.sim_job_id IS DISTINCT FROM original_job_id
    OR jsonb_typeof(attempt_row.evidence_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Attempt evidence archive requires its exact terminal source owner';
  END IF;
  source_text := attempt_row.evidence_payload::text;
  inventory := attempt_evidence_series_inventory(attempt_row.evidence_payload);
  SELECT coalesce(sum((entry->>'byteSize')::bigint),0) INTO history_bytes FROM jsonb_array_elements(inventory) entry;
  IF octet_length(source_text) <> NEW.source_byte_size
    OR encode(sha256(convert_to(source_text,'UTF8')),'hex') <> NEW.source_sha256
    OR inventory <> NEW.history_series OR history_bytes <> NEW.history_byte_size THEN
    RAISE EXCEPTION 'Attempt evidence archive differs from its exact PG source or history inventory';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER attempt_evidence_archive_source_guard BEFORE INSERT ON attempt_evidence_archives
  FOR EACH ROW EXECUTE FUNCTION enforce_attempt_evidence_archive_source();
--> statement-breakpoint
CREATE FUNCTION reject_attempt_evidence_archive_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Attempt evidence archive identities and receipts are immutable'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER attempt_evidence_archives_immutable BEFORE UPDATE ON attempt_evidence_archives
  FOR EACH ROW EXECUTE FUNCTION reject_attempt_evidence_archive_update();
