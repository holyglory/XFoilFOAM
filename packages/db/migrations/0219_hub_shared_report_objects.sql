-- Each remote member retains its original PG text SHA, byte count and source signature.
ALTER TABLE progressive_report_archive_bundles
  DROP CONSTRAINT progressive_report_archive_bundles_archive_format_check,
  DROP CONSTRAINT progressive_report_archive_bundles_legacy_check;
ALTER TABLE progressive_report_archive_bundles
  ADD CONSTRAINT progressive_report_archive_bundles_archive_format_check
    CHECK (archive_format IN ('jsonl','legacy-jsonl','shared-result-v1')),
  ADD CONSTRAINT progressive_report_archive_bundles_legacy_check CHECK (
    ((archive_format='jsonl' OR (archive_format='shared-result-v1' AND source_kind='remote' AND mime_type='application/gzip'))
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
