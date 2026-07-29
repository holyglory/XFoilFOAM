-- Release candidates before this migration declared the archive-scoped
-- uniqueness index with a 65-byte identifier. PostgreSQL stored that index
-- under its deterministic 63-byte truncation, while the schema/preflight
-- referred to the intended name. Reconcile that exact, known shape forward;
-- never drop an arbitrary index merely because its name collides.
DO $$
DECLARE
  legacy_index_oid oid;
  canonical_index_oid oid;
BEGIN
  SELECT index_row.indexrelid
  INTO legacy_index_oid
  FROM pg_index index_row
  JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
  WHERE index_class.relname =
    'result_interpretations_archive_attempt_reducer_source_evidence_'
    AND index_class.relnamespace = 'public'::regnamespace
    AND index_row.indrelid = 'public.result_interpretations'::regclass;

  IF legacy_index_oid IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_index index_row
      WHERE index_row.indexrelid = legacy_index_oid
        AND index_row.indrelid = 'public.result_interpretations'::regclass
        AND index_row.indisunique
        AND index_row.indnkeyatts = 4
        AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
        AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
        AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'source_archive_id'
        AND pg_get_indexdef(index_row.indexrelid, 4, true) = 'input_evidence_signature'
        AND pg_get_expr(index_row.indpred, index_row.indrelid)
          = '(source = ''archive_backfill''::text)'
    ) THEN
      RAISE EXCEPTION
        'refusing to reconcile unexpected legacy interpretation index shape';
    END IF;

    EXECUTE
      'DROP INDEX "result_interpretations_archive_attempt_reducer_source_evidence_"';
  END IF;

  SELECT index_row.indexrelid
  INTO canonical_index_oid
  FROM pg_index index_row
  JOIN pg_class index_class ON index_class.oid = index_row.indexrelid
  WHERE index_class.relname =
    'result_interpretations_archive_attempt_reducer_src_evidence_uq'
    AND index_class.relnamespace = 'public'::regnamespace
    AND index_row.indrelid = 'public.result_interpretations'::regclass;

  IF canonical_index_oid IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_index index_row
    WHERE index_row.indexrelid = canonical_index_oid
      AND index_row.indrelid = 'public.result_interpretations'::regclass
      AND index_row.indisunique
      AND index_row.indnkeyatts = 4
      AND pg_get_indexdef(index_row.indexrelid, 1, true) = 'result_attempt_id'
      AND pg_get_indexdef(index_row.indexrelid, 2, true) = 'reducer_version_id'
      AND pg_get_indexdef(index_row.indexrelid, 3, true) = 'source_archive_id'
      AND pg_get_indexdef(index_row.indexrelid, 4, true) = 'input_evidence_signature'
      AND pg_get_expr(index_row.indpred, index_row.indrelid)
        = '(source = ''archive_backfill''::text)'
  ) THEN
    RAISE EXCEPTION
      'refusing to use unexpected canonical interpretation index shape';
  END IF;

  IF canonical_index_oid IS NULL THEN
    EXECUTE '
      CREATE UNIQUE INDEX "result_interpretations_archive_attempt_reducer_src_evidence_uq"
        ON "result_interpretations" (
          "result_attempt_id", "reducer_version_id", "source_archive_id", "input_evidence_signature"
        )
        WHERE "source" = ''archive_backfill''
    ';
  END IF;
END $$;
