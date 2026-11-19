-- Canonical result histories have their own immutable source identity. Neither
-- attempt payloads, force_history, coefficients nor polar classifications move.
CREATE FUNCTION result_history_compact(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE compact jsonb;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'array' THEN
      IF octet_length(value::text) > 1024 THEN
        RETURN jsonb_build_object('archivedResultHistoryArray', true, 'length', jsonb_array_length(value));
      END IF;
      SELECT coalesce(jsonb_agg(result_history_compact(item) ORDER BY ordinal), '[]'::jsonb)
        INTO compact FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item, ordinal);
      RETURN compact;
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(key, result_history_compact(item)), '{}'::jsonb)
        INTO compact FROM jsonb_each(value) AS items(key, item);
      RETURN compact;
    ELSE RETURN value;
  END CASE;
END;
$$;
--> statement-breakpoint
-- JSONB equality ignores numeric display scale (1.0 equals 1). This separate
-- value identity preserves replay semantics without weakening exact PG text
-- hashes used to archive, restore or remove the original source bytes.
CREATE FUNCTION result_history_normalized(value jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE normalized jsonb;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'number' THEN RETURN to_jsonb(trim_scale((value #>> '{}')::numeric));
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(result_history_normalized(item) ORDER BY ordinal), '[]'::jsonb)
        INTO normalized FROM jsonb_array_elements(value) WITH ORDINALITY AS items(item, ordinal);
      RETURN normalized;
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(key, result_history_normalized(item)), '{}'::jsonb)
        INTO normalized FROM jsonb_each(value) AS items(key, item);
      RETURN normalized;
    ELSE RETURN value;
  END CASE;
END;
$$;
--> statement-breakpoint
CREATE TABLE result_history_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_instance text NOT NULL CHECK (source_instance ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('steady_history', 'frame_track')),
  result_id uuid NOT NULL REFERENCES results(id) ON DELETE CASCADE,
  result_attempt_id uuid,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  value_sha256 text NOT NULL CHECK (value_sha256 ~ '^[a-f0-9]{64}$'),
  source_byte_size bigint NOT NULL CHECK (source_byte_size BETWEEN 1 AND 33554432),
  inline_metadata jsonb NOT NULL,
  envelope_sha256 text NOT NULL CHECK (envelope_sha256 ~ '^[a-f0-9]{64}$'),
  envelope_byte_size bigint NOT NULL CHECK (envelope_byte_size BETWEEN 1 AND 67112960),
  stored_sha256 text NOT NULL CHECK (stored_sha256 ~ '^[a-f0-9]{64}$'),
  stored_byte_size bigint NOT NULL CHECK (stored_byte_size BETWEEN 1 AND 67178496),
  bucket text NOT NULL CHECK (btrim(bucket) <> '' AND position('/' in bucket) = 0),
  object_key text NOT NULL CHECK (btrim(object_key) <> '' AND object_key !~ '^/|(^|/)[.]{1,2}(/|$)|//'),
  generation text NOT NULL CHECK (generation ~ '^[1-9][0-9]{0,19}$'),
  crc32c text NOT NULL CHECK (crc32c ~ '^[A-Za-z0-9+/]{6}==$'),
  verified_at timestamptz NOT NULL,
  CONSTRAINT result_history_archives_owner_uq UNIQUE (id, result_id),
  CONSTRAINT result_history_archives_object_uq UNIQUE (bucket, object_key, generation),
  CONSTRAINT result_history_archives_attempt_owner_fk FOREIGN KEY (result_attempt_id, result_id)
    REFERENCES result_attempts(id, result_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX result_history_archives_source_uq ON result_history_archives
  (source_instance, source_kind, result_id, coalesce(result_attempt_id::text, 'legacy'), source_sha256);
--> statement-breakpoint
ALTER TABLE results
  ADD COLUMN steady_history_archive_id uuid,
  ADD COLUMN frame_track_archive_id uuid,
  ADD CONSTRAINT result_steady_history_archive_owner_fk FOREIGN KEY (steady_history_archive_id, id)
    REFERENCES result_history_archives(id, result_id),
  ADD CONSTRAINT result_frame_track_archive_owner_fk FOREIGN KEY (frame_track_archive_id, id)
    REFERENCES result_history_archives(id, result_id);
--> statement-breakpoint
CREATE INDEX result_history_inline_scan_idx ON results(id)
  WHERE (steady_history IS NOT NULL AND steady_history_archive_id IS NULL)
     OR (frame_track IS NOT NULL AND frame_track_archive_id IS NULL);
--> statement-breakpoint
CREATE FUNCTION enforce_result_history_archive_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_row jsonb; source_value jsonb; source_text text;
BEGIN
  SELECT to_jsonb(result) INTO owner_row FROM results result WHERE result.id = NEW.result_id;
  source_value := owner_row -> NEW.source_kind;
  source_text := source_value::text;
  IF owner_row IS NULL OR source_value IS NULL OR source_value = 'null'::jsonb
     OR (owner_row->>'current_result_attempt_id')::uuid IS DISTINCT FROM NEW.result_attempt_id
     OR owner_row->>(NEW.source_kind || '_archive_id') IS NOT NULL
     OR octet_length(source_text) <> NEW.source_byte_size
     OR encode(sha256(convert_to(source_text, 'UTF8')), 'hex') <> NEW.source_sha256
     OR encode(sha256(convert_to(result_history_normalized(source_value)::text, 'UTF8')), 'hex') <> NEW.value_sha256
     OR result_history_compact(source_value) IS DISTINCT FROM NEW.inline_metadata THEN
    RAISE EXCEPTION 'result history source or exact owner changed; keep the original inline';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER result_history_archive_source_guard BEFORE INSERT ON result_history_archives
  FOR EACH ROW EXECUTE FUNCTION enforce_result_history_archive_source();
--> statement-breakpoint
CREATE FUNCTION reject_result_history_archive_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'result history archive identities and verification receipts are immutable'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER result_history_archives_immutable BEFORE UPDATE ON result_history_archives
  FOR EACH ROW EXECUTE FUNCTION reject_result_history_archive_update();
--> statement-breakpoint
CREATE FUNCTION enforce_result_history_storage_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text; old_row jsonb; new_row jsonb; old_value jsonb; new_value jsonb;
        old_archive uuid; new_archive uuid;
BEGIN
  new_row := to_jsonb(NEW);
  IF TG_OP = 'UPDATE' THEN old_row := to_jsonb(OLD); END IF;
  FOREACH kind IN ARRAY ARRAY['steady_history', 'frame_track'] LOOP
    new_value := new_row->kind;
    new_archive := (new_row->>(kind || '_archive_id'))::uuid;
    old_value := old_row->kind;
    old_archive := (old_row->>(kind || '_archive_id'))::uuid;
    IF new_archive IS NULL THEN
      IF old_archive IS NOT NULL AND new_value IS NOT DISTINCT FROM old_value THEN
        RAISE EXCEPTION 'cannot detach a result history archive while retaining only its compact metadata';
      END IF;
      IF TG_OP = 'UPDATE' AND old_value IS DISTINCT FROM new_value
         AND result_history_compact(old_value) IS NOT DISTINCT FROM new_value THEN
        RAISE EXCEPTION 'cannot compact result history without its exact immutable archive';
      END IF;
      CONTINUE;
    END IF;
    IF TG_OP = 'UPDATE' AND new_archive = old_archive THEN
      IF new_value IS DISTINCT FROM old_value THEN
        -- Normal ingestion restores an inline value. The historical archive
        -- keeps its original owner; it is never retargeted to the new solve.
        NEW := jsonb_populate_record(NEW, jsonb_build_object(kind || '_archive_id', NULL));
      END IF;
      CONTINUE;
    END IF;
    IF TG_OP = 'INSERT' OR old_archive IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM result_history_archives archive
      WHERE archive.id = new_archive AND archive.result_id = NEW.id AND archive.source_kind = kind
        AND archive.result_attempt_id IS NOT DISTINCT FROM NEW.current_result_attempt_id
        AND archive.source_byte_size = octet_length(old_value::text)
        AND archive.source_sha256 = encode(sha256(convert_to(old_value::text, 'UTF8')), 'hex')
        AND archive.inline_metadata = new_value
        AND result_history_compact(old_value) = new_value
    ) THEN
      RAISE EXCEPTION 'cannot remove or retarget result history without its exact immutable archive';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER result_history_storage_transition BEFORE INSERT OR UPDATE OF
  steady_history, frame_track, steady_history_archive_id, frame_track_archive_id ON results
  FOR EACH ROW EXECUTE FUNCTION enforce_result_history_storage_transition();
--> statement-breakpoint
-- SQL equality needs no GCS request: compare an incoming full history against
-- the archived value identity. Compact metadata alone is not equality.
CREATE FUNCTION result_history_matches(owner_row jsonb, kind text, candidate jsonb) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN kind NOT IN ('steady_history', 'frame_track') THEN false
    WHEN owner_row->>(kind || '_archive_id') IS NULL
      THEN coalesce(owner_row->kind, 'null'::jsonb) = coalesce(candidate, 'null'::jsonb)
    ELSE EXISTS (
      SELECT 1 FROM result_history_archives archive
      WHERE archive.id = (owner_row->>(kind || '_archive_id'))::uuid
        AND archive.result_id = (owner_row->>'id')::uuid AND archive.source_kind = kind
        AND archive.inline_metadata = owner_row->kind
        AND archive.value_sha256 = encode(sha256(convert_to(result_history_normalized(candidate)::text, 'UTF8')), 'hex')
    ) END
$$;
