-- Only force_history sample arrays move. Scalar facts, attempt payloads,
-- steady histories, URANS certificates, and polar acceptance stay inline.
CREATE TABLE solver_history_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_instance text NOT NULL CHECK (source_instance ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  source_kind text NOT NULL CHECK (source_kind = 'force_history'),
  source_id uuid NOT NULL REFERENCES force_history(id) ON DELETE CASCADE,
  result_id uuid NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  result_attempt_id uuid REFERENCES result_attempts(id) ON DELETE CASCADE,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_byte_size bigint NOT NULL CHECK (source_byte_size BETWEEN 1 AND 33554432),
  envelope_sha256 text NOT NULL CHECK (envelope_sha256 ~ '^[a-f0-9]{64}$'),
  envelope_byte_size bigint NOT NULL CHECK (envelope_byte_size BETWEEN 1 AND 67112960),
  stored_sha256 text NOT NULL CHECK (stored_sha256 ~ '^[a-f0-9]{64}$'),
  stored_byte_size bigint NOT NULL CHECK (stored_byte_size BETWEEN 1 AND 67178496),
  bucket text NOT NULL CHECK (btrim(bucket) <> '' AND position('/' in bucket) = 0),
  object_key text NOT NULL CHECK (btrim(object_key) <> '' AND object_key !~ '^/|(^|/)[.]{1,2}(/|$)|//'),
  generation text NOT NULL CHECK (generation ~ '^[1-9][0-9]{0,19}$'),
  crc32c text NOT NULL CHECK (crc32c ~ '^[A-Za-z0-9+/]{6}==$'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT solver_history_archives_source_uq UNIQUE (source_instance, source_kind, source_id, source_sha256),
  CONSTRAINT solver_history_archives_object_uq UNIQUE (bucket, object_key, generation),
  CONSTRAINT solver_history_archives_owner_uq UNIQUE (id, source_id),
  CONSTRAINT solver_history_archives_attempt_owner_fk FOREIGN KEY (result_attempt_id, result_id)
    REFERENCES result_attempts(id, result_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX solver_history_archives_result_idx ON solver_history_archives (result_id, result_attempt_id);
--> statement-breakpoint
ALTER TABLE force_history
  ALTER COLUMN t DROP NOT NULL,
  ALTER COLUMN cl DROP NOT NULL,
  ALTER COLUMN cd DROP NOT NULL,
  ADD COLUMN history_archive_id uuid,
  ADD CONSTRAINT force_history_archive_owner_fk FOREIGN KEY (history_archive_id, id)
    REFERENCES solver_history_archives(id, source_id),
  ADD CONSTRAINT force_history_storage_shape CHECK (
    (t IS NOT NULL AND cl IS NOT NULL AND cd IS NOT NULL AND history_archive_id IS NULL)
    OR (t IS NULL AND cl IS NULL AND cd IS NULL AND cm IS NULL AND history_archive_id IS NOT NULL)
  );
--> statement-breakpoint
CREATE INDEX force_history_inline_backfill_idx ON force_history (id) WHERE history_archive_id IS NULL;
--> statement-breakpoint
CREATE FUNCTION enforce_solver_history_archive_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_text text; owner_result uuid; owner_attempt uuid;
BEGIN
  SELECT jsonb_build_object('t', h.t, 'cl', h.cl, 'cd', h.cd, 'cm', h.cm)::text, h.result_id, h.result_attempt_id
    INTO source_text, owner_result, owner_attempt FROM force_history h WHERE h.id = NEW.source_id AND h.t IS NOT NULL;
  IF source_text IS NULL OR owner_result IS DISTINCT FROM NEW.result_id OR owner_attempt IS DISTINCT FROM NEW.result_attempt_id
     OR octet_length(source_text) <> NEW.source_byte_size
     OR encode(sha256(convert_to(source_text, 'UTF8')), 'hex') <> NEW.source_sha256 THEN
    RAISE EXCEPTION 'solver history archive source changed or ownership differs; preserve inline evidence';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER solver_history_archives_source_guard BEFORE INSERT ON solver_history_archives
  FOR EACH ROW EXECUTE FUNCTION enforce_solver_history_archive_source();
--> statement-breakpoint
CREATE FUNCTION reject_solver_history_archive_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'solver history archive identities and restore receipts are immutable'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER solver_history_archives_immutable BEFORE UPDATE ON solver_history_archives
  FOR EACH ROW EXECUTE FUNCTION reject_solver_history_archive_update();
--> statement-breakpoint
CREATE FUNCTION enforce_force_history_storage_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_text text;
BEGIN
  IF NEW.t IS NOT NULL AND NEW.cl IS NOT NULL AND NEW.cd IS NOT NULL THEN
    -- Normal ingestion/replay restores inline data. Retained archives remain
    -- immutable history; a later pass may archive the new exact generation.
    NEW.history_archive_id := NULL;
  ELSIF TG_OP = 'UPDATE' AND OLD.t IS NOT NULL THEN
    source_text := jsonb_build_object('t', OLD.t, 'cl', OLD.cl, 'cd', OLD.cd, 'cm', OLD.cm)::text;
    IF NOT EXISTS (
      SELECT 1 FROM solver_history_archives a
      WHERE a.id = NEW.history_archive_id AND a.source_id = NEW.id AND a.result_id = NEW.result_id
        AND a.result_attempt_id IS NOT DISTINCT FROM NEW.result_attempt_id
        AND a.source_byte_size = octet_length(source_text)
        AND a.source_sha256 = encode(sha256(convert_to(source_text, 'UTF8')), 'hex')
    ) THEN RAISE EXCEPTION 'cannot remove force history without the exact immutable archive'; END IF;
  ELSIF TG_OP = 'INSERT' OR NEW.history_archive_id IS DISTINCT FROM OLD.history_archive_id
     OR NEW.result_id IS DISTINCT FROM OLD.result_id OR NEW.result_attempt_id IS DISTINCT FROM OLD.result_attempt_id THEN
    RAISE EXCEPTION 'cannot insert or retarget offloaded force history';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER force_history_storage_transition BEFORE INSERT OR UPDATE ON force_history
  FOR EACH ROW EXECUTE FUNCTION enforce_force_history_storage_transition();
