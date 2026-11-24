-- The worker dictionary is a registered, self-contained original from the same execution.
ALTER TABLE progressive_report_archive_bundles
  DROP CONSTRAINT progressive_report_archive_bundles_archive_format_check,
  DROP CONSTRAINT progressive_report_archive_bundles_legacy_check;
ALTER TABLE progressive_report_archive_bundles
  ADD CONSTRAINT progressive_report_archive_bundles_archive_format_check
    CHECK (archive_format IN ('jsonl','legacy-jsonl','shared-result-v1','worker-result-ref-v1')),
  ADD CONSTRAINT progressive_report_archive_bundles_legacy_check CHECK (
    ((archive_format='jsonl' OR (archive_format='worker-result-ref-v1' AND source_kind='worker' AND mime_type='application/gzip'
      AND member_count BETWEEN 1 AND 8 AND right(object_key,length('/worker/'||sim_job_id::text||'/'||stored_sha256||'.jsonl.gz'))
        ='/worker/'||sim_job_id::text||'/'||stored_sha256||'.jsonl.gz') OR (archive_format='shared-result-v1' AND source_kind='remote' AND mime_type='application/gzip'))
      AND legacy_instance_id IS NULL AND legacy_solver_id IS NULL
      AND legacy_scope_sha256 IS NULL AND legacy_page_member_count IS NULL
      AND legacy_read_mode IS NULL AND legacy_local_storage_key IS NULL AND legacy_local_verified_at IS NULL)
    OR (archive_format='legacy-jsonl' AND source_kind='worker' AND mime_type='application/gzip'
      AND legacy_instance_id IS NOT NULL AND legacy_solver_id IS NOT NULL
      AND legacy_scope_sha256 IS NOT NULL AND legacy_scope_sha256 ~ '^[a-f0-9]{64}$'
      AND legacy_page_member_count IS NOT NULL AND legacy_page_member_count BETWEEN member_count AND 128
      AND object_key='legacy-worker-reports/v1/'||legacy_instance_id::text||'/'||legacy_solver_id::text
        ||'/'||legacy_scope_sha256||'/'||stored_sha256||'.jsonl.gz'
      AND legacy_read_mode IS NOT NULL AND (
        (legacy_read_mode='registered-get' AND legacy_local_storage_key IS NULL AND legacy_local_verified_at IS NULL)
        OR (legacy_read_mode='hub-local-reader' AND legacy_local_storage_key IS NOT NULL
          AND legacy_local_storage_key<>'' AND legacy_local_verified_at IS NOT NULL)))
  );

CREATE TABLE progressive_worker_report_result_anchors (
  sim_job_id uuid NOT NULL,
  result_sha256 text NOT NULL CHECK (result_sha256 ~ '^[a-f0-9]{64}$'),
  result_byte_size integer NOT NULL CHECK (result_byte_size BETWEEN 1 AND 33554432),
  sequence bigint NOT NULL,
  witness_sequence bigint NOT NULL,
  source_kind text NOT NULL DEFAULT 'worker' CHECK (source_kind='worker'),
  member_kind text NOT NULL DEFAULT 'report' CHECK (member_kind='report'),
  PRIMARY KEY (sim_job_id, result_sha256),
  FOREIGN KEY (source_kind,sim_job_id,member_kind,sequence)
    REFERENCES progressive_report_archive_members(source_kind,sim_job_id,member_kind,sequence) ON DELETE RESTRICT,
  FOREIGN KEY (source_kind,sim_job_id,member_kind,witness_sequence)
    REFERENCES progressive_report_archive_members(source_kind,sim_job_id,member_kind,sequence) ON DELETE RESTRICT
);

ALTER TABLE progressive_report_archive_bundles
  ADD COLUMN worker_result_sha256 text,
  ADD CONSTRAINT progressive_report_worker_result_shape CHECK (
    (archive_format='worker-result-ref-v1')=(worker_result_sha256 IS NOT NULL)),
  ADD CONSTRAINT progressive_report_worker_result_fk FOREIGN KEY (sim_job_id,worker_result_sha256)
    REFERENCES progressive_worker_report_result_anchors(sim_job_id,result_sha256)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- Called while the source is still locked and readable in the shortening transaction.
-- Both the immutable member and the real source must agree before becoming a dictionary.
CREATE FUNCTION require_worker_result_anchor() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$
DECLARE token text;
BEGIN
  SELECT (public.resolve_progressive_report(w.report,w.result_payload_hash)->'result')::text INTO STRICT token
  FROM public.progressive_worker_reports r
  JOIN public.progressive_report_archive_members m ON m.sim_job_id=r.sim_job_id AND m.sequence=r.sequence
    AND m.content_signature=r.content_signature AND m.source_kind='worker' AND m.member_kind='report'
  JOIN public.progressive_report_archive_bundles b ON b.id=m.bundle_id AND b.source_kind=m.source_kind
    AND b.sim_job_id=r.sim_job_id AND b.archive_format='jsonl' AND b.member_count BETWEEN 1 AND 8
    AND right(b.object_key,length('/worker/'||r.sim_job_id::text||'/'||b.stored_sha256||'.jsonl.gz'))
        ='/worker/'||r.sim_job_id::text||'/'||b.stored_sha256||'.jsonl.gz'
  JOIN public.progressive_worker_reports w ON w.sim_job_id=r.sim_job_id AND w.sequence=NEW.witness_sequence
    AND w.assignment_signature=r.assignment_signature
  JOIN public.progressive_report_archive_members wm ON wm.sim_job_id=w.sim_job_id AND wm.sequence=w.sequence
    AND wm.source_kind='worker' AND wm.member_kind='report' AND wm.content_signature=w.content_signature
  JOIN public.progressive_report_archive_bundles wb ON wb.id=wm.bundle_id AND wb.sim_job_id=w.sim_job_id
    AND wb.source_kind='worker'
  WHERE r.sim_job_id=NEW.sim_job_id AND r.sequence=NEW.sequence AND w.archive_bundle_id IS NULL AND w.archived_at IS NULL
    AND ((r.sequence=w.sequence AND wb.id=b.id)
      OR (r.archive_bundle_id=b.id AND r.archived_at IS NOT NULL AND wb.archive_format='worker-result-ref-v1'
        AND wb.worker_result_sha256=NEW.result_sha256))
  FOR UPDATE OF w;
  IF left(token,1) IS DISTINCT FROM '{' OR octet_length(token) IS DISTINCT FROM NEW.result_byte_size
    OR encode(sha256(convert_to(token,'UTF8')),'hex') IS DISTINCT FROM NEW.result_sha256 THEN
    RAISE EXCEPTION 'Worker result anchor differs from exact native scientific bytes';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER check_worker_result_anchor BEFORE INSERT ON progressive_worker_report_result_anchors
  FOR EACH ROW EXECUTE FUNCTION require_worker_result_anchor();
CREATE TRIGGER worker_result_anchor_immutable BEFORE UPDATE OR DELETE ON progressive_worker_report_result_anchors
  FOR EACH ROW EXECUTE FUNCTION reject_progressive_artifact_update();
