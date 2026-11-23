-- Scheduling proof only. A covered transport sequence has no staging receipt,
-- attempt association, delivery, polar or archive state created on its behalf.
CREATE TABLE progressive_worker_staging_copies (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  source_sequence bigint NOT NULL,
  report_signature text NOT NULL,
  source_signature text NOT NULL,
  result_sha256 text NOT NULL,
  result_byte_size bigint NOT NULL,
  point_signatures jsonb NOT NULL,
  promise_id uuid NOT NULL,
  solver_id uuid NOT NULL,
  PRIMARY KEY (sim_job_id,sequence),
  CONSTRAINT worker_staging_copy_identity_check CHECK (source_sequence<>sequence AND result_byte_size>0),
  CONSTRAINT worker_staging_copy_hash_check CHECK (report_signature ~ '^[0-9a-f]{64}$' AND source_signature ~ '^[0-9a-f]{64}$' AND result_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT worker_staging_copy_points_check CHECK (jsonb_typeof(point_signatures)='array' AND jsonb_array_length(point_signatures) BETWEEN 1 AND 512),
  CONSTRAINT worker_staging_copy_target_fk FOREIGN KEY(sim_job_id,sequence)
    REFERENCES progressive_worker_reports(sim_job_id,sequence) ON DELETE CASCADE,
  CONSTRAINT worker_staging_copy_source_fk FOREIGN KEY(sim_job_id,source_sequence)
    REFERENCES progressive_worker_evidence_receipts(sim_job_id,sequence) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX worker_staging_copy_source_idx ON progressive_worker_staging_copies(sim_job_id,source_sequence);
--> statement-breakpoint
-- Point ownership is verified at insertion. Invalidate on source changes so the
-- hot selectors need only the indexed key. A cache miss uses ordinary staging.
CREATE FUNCTION invalidate_worker_staging_copies() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='progressive_worker_evidence_attempts' THEN
    IF TG_OP='DELETE' THEN
      DELETE FROM public.progressive_worker_staging_copies WHERE sim_job_id=OLD.sim_job_id AND source_sequence=OLD.sequence;
    ELSE
      IF EXISTS (SELECT 1 FROM public.progressive_worker_hub_receipts h WHERE h.sim_job_id=NEW.sim_job_id
          AND h.point_content_signature=NEW.point_content_signature AND h.result_attempt_id<>NEW.result_attempt_id) THEN
        -- A second, different attempt is now claiming the same signed point.
        PERFORM 1 FROM public.sim_jobs WHERE id=NEW.sim_job_id FOR UPDATE;
        DELETE FROM public.progressive_worker_staging_copies WHERE sim_job_id=NEW.sim_job_id AND point_signatures ? NEW.point_content_signature;
      END IF;
      DELETE FROM public.progressive_worker_staging_copies WHERE sim_job_id=NEW.sim_job_id AND source_sequence=NEW.sequence;
    END IF;
  ELSIF TG_TABLE_NAME='progressive_worker_hub_receipts' THEN
    DELETE FROM public.progressive_worker_staging_copies WHERE sim_job_id=OLD.sim_job_id AND point_signatures ? OLD.point_content_signature;
  ELSIF TG_TABLE_NAME='progressive_worker_report_conflicts' THEN
    DELETE FROM public.progressive_worker_staging_copies WHERE sim_job_id=NEW.sim_job_id AND (source_sequence=NEW.sequence OR sequence=NEW.sequence);
  ELSIF TG_TABLE_NAME='result_attempts' THEN
    IF EXISTS(SELECT 1 FROM public.progressive_worker_staging_copies WHERE sim_job_id=OLD.sim_job_id) THEN
      DELETE FROM public.progressive_worker_staging_copies c WHERE c.sim_job_id=OLD.sim_job_id AND EXISTS (
        SELECT 1 FROM public.progressive_worker_evidence_attempts a WHERE a.sim_job_id=c.sim_job_id AND a.sequence=c.source_sequence AND a.result_attempt_id=OLD.id);
    END IF;
  ELSE
    DELETE FROM public.progressive_worker_staging_copies WHERE sim_job_id=OLD.id;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER worker_staging_copy_association_changed AFTER INSERT OR DELETE ON progressive_worker_evidence_attempts
FOR EACH ROW EXECUTE FUNCTION invalidate_worker_staging_copies();
--> statement-breakpoint
CREATE TRIGGER worker_staging_copy_delivery_removed AFTER DELETE ON progressive_worker_hub_receipts
FOR EACH ROW EXECUTE FUNCTION invalidate_worker_staging_copies();
--> statement-breakpoint
CREATE TRIGGER worker_staging_copy_conflict AFTER INSERT ON progressive_worker_report_conflicts
FOR EACH ROW EXECUTE FUNCTION invalidate_worker_staging_copies();
--> statement-breakpoint
CREATE TRIGGER worker_staging_copy_attempt_changed AFTER UPDATE ON result_attempts
FOR EACH ROW EXECUTE FUNCTION invalidate_worker_staging_copies();
--> statement-breakpoint
CREATE TRIGGER worker_staging_copy_setup_changed AFTER UPDATE OF request_payload,bc_ids,simulation_preset_revision_id,airfoil_id ON sim_jobs
FOR EACH ROW WHEN ((OLD.request_payload,OLD.bc_ids,OLD.simulation_preset_revision_id,OLD.airfoil_id)
 IS DISTINCT FROM (NEW.request_payload,NEW.bc_ids,NEW.simulation_preset_revision_id,NEW.airfoil_id))
EXECUTE FUNCTION invalidate_worker_staging_copies();
--> statement-breakpoint
CREATE VIEW progressive_worker_closed_staging_copies AS
SELECT c.sim_job_id,c.sequence FROM progressive_worker_staging_copies c
JOIN progressive_worker_reports target ON target.sim_job_id=c.sim_job_id AND target.sequence=c.sequence AND target.content_signature=c.report_signature
JOIN progressive_worker_evidence_receipts staged ON staged.sim_job_id=c.sim_job_id AND staged.sequence=c.source_sequence AND staged.content_signature=c.source_signature
JOIN sim_jobs j ON j.id=c.sim_job_id AND j.engine_job_id=j.id::text JOIN sync_sweep_promises p ON p.id=c.promise_id AND p.registered_solver_id=c.solver_id
JOIN sync_api_settings cfg ON cfg.id=1 AND cfg.remote_solver_registered_id=c.solver_id AND cfg.upstream_base_url=p.source_base_url
WHERE j.status IN ('done','failed','cancelled') AND j."ingestedAt" IS NOT NULL AND p.status IN ('fulfilled','expired','cancelled');
