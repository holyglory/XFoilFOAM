-- Native PostgreSQL 16 action for this one table and its owned TOAST/indexes.
-- No data deletion, table rewrite, extension install, or service control.
-- TRUNCATE TRUE may briefly acquire ACCESS EXCLUSIVE for an empty file tail.
-- lock_timeout limits acquisition waits, NOT the duration of a granted lock.
-- Use TRUNCATE FALSE instead when only internal reuse without tail locks is wanted.
-- Do not use psql --single-transaction: VACUUM cannot run in a transaction.
\set ON_ERROR_STOP on
SET lock_timeout='1s';
SET statement_timeout='5min';
SET application_name='xfoilfoam_worker_report_native_vacuum';
SELECT clock_timestamp() AS measured_at,pg_table_size('public.progressive_worker_reports') AS table_bytes,
  pg_indexes_size('public.progressive_worker_reports') AS index_bytes,
  pg_total_relation_size('public.progressive_worker_reports') AS total_bytes;
VACUUM (TRUNCATE TRUE, INDEX_CLEANUP AUTO, PARALLEL 0, BUFFER_USAGE_LIMIT '1MB') public.progressive_worker_reports;
SELECT clock_timestamp() AS measured_at,pg_table_size('public.progressive_worker_reports') AS table_bytes,
  pg_indexes_size('public.progressive_worker_reports') AS index_bytes,
  pg_total_relation_size('public.progressive_worker_reports') AS total_bytes;
