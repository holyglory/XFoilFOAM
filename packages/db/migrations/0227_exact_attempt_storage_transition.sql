-- The 0208/0213 projection trigger derived the two exact PG text hashes
-- from the original and its compact projection. Both identities are immutable.
-- Authenticate them once, after comparing every other attempt column with
-- the native row type. This also covers subsequently added attempt columns.
CREATE FUNCTION attempt_evidence_sealed_transition(previous result_attempts,following result_attempts) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE archive_id_ uuid; source jsonb; compact jsonb; source_text text; compact_text text; p jsonb;
  omitted constant jsonb := '{"evidence_payload":null,"evidence_archive_id":null,"evidence_storage_event_id":null}';
BEGIN
  IF previous.evidence_archive_id IS NULL AND following.evidence_archive_id IS NOT NULL THEN
    archive_id_:=following.evidence_archive_id; source:=previous.evidence_payload; compact:=following.evidence_payload;
  ELSIF previous.evidence_archive_id IS NOT NULL AND following.evidence_archive_id IS NULL THEN
    archive_id_:=previous.evidence_archive_id; source:=following.evidence_payload; compact:=previous.evidence_payload;
  ELSE
    RETURN false;
  END IF;
  IF jsonb_populate_record(previous,omitted) IS DISTINCT FROM jsonb_populate_record(following,omitted) THEN RETURN false; END IF;
  SELECT projection INTO p FROM attempt_evidence_history_projections h
    WHERE h.result_attempt_id=previous.id AND h.archive_id=archive_id_;
  IF NOT FOUND THEN RETURN false; END IF;
  source_text:=source::text; compact_text:=compact::text;
  RETURN coalesce((p->>'sourceByteSize')::bigint=octet_length(source_text)
    AND p->>'sourceSha256'=encode(sha256(convert_to(source_text,'UTF8')),'hex')
    AND p->>'compactSha256'=encode(sha256(convert_to(compact_text,'UTF8')),'hex'),false);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_attempt_evidence_storage_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ev attempt_evidence_storage_events%ROWTYPE; path_ record;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.evidence_archive_id IS NOT NULL OR NEW.evidence_storage_event_id IS NOT NULL THEN
      RAISE EXCEPTION 'A new attempt must contain its full inline source';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.evidence_archive_id IS NOT DISTINCT FROM OLD.evidence_archive_id
    AND NEW.evidence_storage_event_id IS NOT DISTINCT FROM OLD.evidence_storage_event_id THEN
    IF NEW.evidence_payload IS NOT DISTINCT FROM OLD.evidence_payload THEN
      IF OLD.evidence_archive_id IS NOT NULL THEN
        IF NEW.evidence_payload::text IS DISTINCT FROM OLD.evidence_payload::text THEN
          RAISE EXCEPTION 'Archived attempt compact PostgreSQL text is immutable';
        END IF;
        -- The payload and both pointer columns have already been checked.
        IF jsonb_populate_record(NEW,'{"evidence_payload":null}') IS DISTINCT FROM jsonb_populate_record(OLD,'{"evidence_payload":null}')
          AND (jsonb_populate_record(NEW,'{"evidence_payload":null,"sim_job_id":null}') IS DISTINCT FROM jsonb_populate_record(OLD,'{"evidence_payload":null,"sim_job_id":null}')
               OR NEW.sim_job_id IS NOT NULL OR EXISTS(SELECT FROM sim_jobs j WHERE j.id=OLD.sim_job_id)) THEN
          RAISE EXCEPTION 'Archived attempt scientific metadata is immutable; restore the exact original first';
        END IF;
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.evidence_archive_id IS NULL THEN
      FOR path_ IN SELECT * FROM attempt_evidence_history_paths() LOOP
        IF jsonb_typeof(OLD.evidence_payload#>path_.path)='array' AND jsonb_typeof(NEW.evidence_payload#>path_.path) IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'Attempt history arrays require exact archive custody before omission';
        END IF;
      END LOOP;
      RETURN NEW;
    END IF;
  END IF;
  SELECT e.* INTO ev FROM attempt_evidence_storage_events e WHERE e.id=NEW.evidence_storage_event_id
    AND e.transaction_id=pg_current_xact_id()::text AND NOT e.completed;
  IF NOT FOUND OR ev.result_attempt_id<>OLD.id OR ev.archive_id IS DISTINCT FROM coalesce(NEW.evidence_archive_id,OLD.evidence_archive_id)
    OR ev.action IS DISTINCT FROM (CASE WHEN NEW.evidence_archive_id IS NULL THEN 'restore' ELSE 'shorten' END) THEN
    RAISE EXCEPTION 'Attempt history transition requires a fresh transaction-bound storage event';
  END IF;
  IF NOT attempt_evidence_sealed_transition(OLD,NEW) THEN
    RAISE EXCEPTION 'Attempt history transition changed scientific values or lacks the exact original';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_progressive_attempt_fit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE scope_ record;
BEGIN
  IF TG_OP='UPDATE' THEN
    -- The BEFORE trigger has already authenticated both PG representations,
    -- their unchanged scientific columns and the unfinished event of this
    -- exact transaction. An ordinary enrichment has no such pointer change.
    IF NEW.evidence_archive_id IS DISTINCT FROM OLD.evidence_archive_id THEN
      IF EXISTS(SELECT FROM attempt_evidence_storage_events e WHERE e.id=NEW.evidence_storage_event_id
        AND e.result_attempt_id=OLD.id AND e.archive_id=coalesce(NEW.evidence_archive_id,OLD.evidence_archive_id)
        AND e.transaction_id=pg_current_xact_id()::text AND NOT e.completed
        AND e.action=CASE WHEN NEW.evidence_archive_id IS NULL THEN 'restore' ELSE 'shorten' END)
      THEN RETURN NULL; END IF;
    ELSIF NEW.evidence_payload IS NOT DISTINCT FROM OLD.evidence_payload THEN
      RETURN NULL;
    END IF;
  END IF;
  FOR scope_ IN SELECT DISTINCT work.target_id,generation.epoch_id FROM progressive_cfd_evidence receipt
    JOIN progressive_cfd_attempts attempt ON attempt.token=receipt.attempt_token
    JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id JOIN progressive_work work ON work.id=unit.work_id
    JOIN progressive_generations generation ON generation.id=work.generation_id
    WHERE receipt.result_attempt_id=OLD.id
  LOOP PERFORM invalidate_progressive_polar_target(scope_.target_id,scope_.epoch_id); END LOOP;
  RETURN OLD;
END;
$$;
