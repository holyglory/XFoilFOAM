-- Transport storage only. Report identities, signatures and scientific evidence
-- retain their original ownership. No report history is removed by this migration.
CREATE TABLE progressive_report_storage_policy (
  id integer PRIMARY KEY CHECK (id = 1),
  normalization_enabled boolean NOT NULL DEFAULT false
);
INSERT INTO progressive_report_storage_policy(id) VALUES (1);

CREATE TABLE progressive_report_result_payloads (
  content_hash text PRIMARY KEY CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  byte_size bigint NOT NULL CHECK (byte_size = octet_length(result::text)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (content_hash = encode(sha256(convert_to(result::text, 'UTF8')), 'hex'))
);
CREATE TRIGGER progressive_report_result_payloads_immutable
  BEFORE UPDATE OR DELETE ON progressive_report_result_payloads
  FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();

ALTER TABLE progressive_worker_reports ADD COLUMN result_payload_hash text
  REFERENCES progressive_report_result_payloads(content_hash) ON DELETE RESTRICT;
ALTER TABLE progressive_remote_reports ADD COLUMN result_payload_hash text
  REFERENCES progressive_report_result_payloads(content_hash) ON DELETE RESTRICT;

-- Keep object presence and terminal-state partial indexes meaningful. Never put
-- polars, frames, coefficients or unbounded engine output in the envelope.
CREATE FUNCTION progressive_report_result_header(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN value ? 'state' THEN jsonb_build_object('state', value->'state')
    ELSE '{}'::jsonb END
$$;

CREATE FUNCTION resolve_progressive_report(envelope jsonb, payload_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
DECLARE payload jsonb;
BEGIN
  IF payload_hash IS NULL THEN RETURN envelope; END IF;
  SELECT result INTO payload FROM public.progressive_report_result_payloads WHERE content_hash = payload_hash;
  IF NOT FOUND OR envelope->'result' IS DISTINCT FROM progressive_report_result_header(payload) THEN
    RAISE EXCEPTION 'Missing or inconsistent progressive report result payload';
  END IF;
  RETURN jsonb_set(envelope, '{result}', payload, false);
END;
$$;

-- Full-body fetches only: row conversion also supports older TEMP fixtures
-- without the new nullable column. Scalar selectors never call this overload.
CREATE FUNCTION resolve_progressive_report(storage_row jsonb) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path = pg_catalog, public AS $$
  SELECT resolve_progressive_report(storage_row->'report', storage_row->>'result_payload_hash')
$$;

CREATE FUNCTION store_progressive_report_result(value jsonb) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE payload_hash text; stored jsonb;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Progressive result payload must be an object';
  END IF;
  payload_hash := encode(sha256(convert_to(value::text, 'UTF8')), 'hex');
  INSERT INTO public.progressive_report_result_payloads(content_hash, result, byte_size)
    VALUES (payload_hash, value, octet_length(value::text)) ON CONFLICT (content_hash) DO NOTHING;
  SELECT result INTO stored FROM public.progressive_report_result_payloads WHERE content_hash = payload_hash;
  IF NOT FOUND OR stored IS DISTINCT FROM value THEN
    RAISE EXCEPTION 'Progressive result payload hash collision or missing payload';
  END IF;
  RETURN payload_hash;
END;
$$;

CREATE FUNCTION normalize_progressive_report_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.result_payload_hash IS NOT NULL THEN
    -- Explicit referenced inserts must supply the exact header. This also
    -- rejects missing references before a compact body could escape a reader.
    PERFORM resolve_progressive_report(NEW.report, NEW.result_payload_hash);
  ELSIF jsonb_typeof(NEW.report->'result') = 'object'
    AND (SELECT normalization_enabled FROM public.progressive_report_storage_policy WHERE id = 1) THEN
    NEW.result_payload_hash := store_progressive_report_result(NEW.report->'result');
    NEW.report := jsonb_set(NEW.report, '{result}', progressive_report_result_header(NEW.report->'result'), false);
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER progressive_worker_report_normalize BEFORE INSERT ON progressive_worker_reports
  FOR EACH ROW EXECUTE FUNCTION normalize_progressive_report_insert();
CREATE TRIGGER progressive_remote_report_normalize BEFORE INSERT ON progressive_remote_reports
  FOR EACH ROW EXECUTE FUNCTION normalize_progressive_report_insert();

CREATE FUNCTION progressive_report_representation_transition(old_report jsonb, old_hash text,
  new_report jsonb, new_hash text) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $$
BEGIN
  IF old_hash IS NULL AND new_hash IS NOT NULL AND jsonb_typeof(old_report->'result') = 'object' THEN
    RETURN resolve_progressive_report(new_report, new_hash) = old_report;
  ELSIF old_hash IS NOT NULL AND new_hash IS NULL
    AND NOT (SELECT normalization_enabled FROM public.progressive_report_storage_policy WHERE id = 1) THEN
    -- Recovery only: retain the immutable payload and restore its exact report.
    RETURN new_report = resolve_progressive_report(old_report, old_hash);
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION protect_progressive_worker_report() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.sim_job_id, NEW.sequence, NEW.content_signature, NEW.created_at)
      IS DISTINCT FROM (OLD.sim_job_id, OLD.sequence, OLD.content_signature, OLD.created_at)
    OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
    OR ((NEW.report, NEW.result_payload_hash) IS DISTINCT FROM (OLD.report, OLD.result_payload_hash)
      AND NOT progressive_report_representation_transition(OLD.report, OLD.result_payload_hash, NEW.report, NEW.result_payload_hash)) THEN
    RAISE EXCEPTION 'Progressive worker report content and acknowledgements are immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION protect_progressive_remote_report() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.sim_job_id, NEW.sequence, NEW.content_signature, NEW.received_at)
      IS DISTINCT FROM (OLD.sim_job_id, OLD.sequence, OLD.content_signature, OLD.received_at)
    OR NOT progressive_report_representation_transition(OLD.report, OLD.result_payload_hash, NEW.report, NEW.result_payload_hash) THEN
    RAISE EXCEPTION 'Progressive remote report content is immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER progressive_remote_reports_immutable ON progressive_remote_reports;
CREATE TRIGGER progressive_remote_reports_immutable BEFORE UPDATE ON progressive_remote_reports
  FOR EACH ROW EXECUTE FUNCTION protect_progressive_remote_report();
