-- Support the exact equality probe used by both 0198 ON DELETE RESTRICT FKs.
-- The normal migrator prepares existing tables concurrently. Inside the
-- journal transaction only empty tables may build a missing index.
DO $payload_indexes$
DECLARE
  table_name text;
  index_name text;
  target regclass;
  index_oid regclass;
  definition text;
  populated boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(223, 1);
  FOREACH table_name IN ARRAY ARRAY['progressive_worker_reports','progressive_remote_reports']
  LOOP
    target := format('public.%I',table_name)::regclass;
    index_name := table_name || '_result_payload_hash_idx';
    definition := format('CREATE INDEX %I ON public.%I USING btree (result_payload_hash) WHERE (result_payload_hash IS NOT NULL)',index_name,table_name);
    index_oid := to_regclass(format('public.%I',index_name));
    IF index_oid IS NULL THEN
      EXECUTE format('LOCK TABLE public.%I IN SHARE MODE NOWAIT',table_name);
      EXECUTE format('SELECT EXISTS(SELECT FROM public.%I LIMIT 1)',table_name) INTO populated;
      IF populated THEN
        RAISE EXCEPTION 'Prepare populated report tables with pnpm --filter @aerodb/db migrate --prepare-report-payload-indexes before 0223';
      END IF;
      EXECUTE definition;
      index_oid := to_regclass(format('public.%I',index_name));
    END IF;
    IF NOT EXISTS(SELECT FROM pg_catalog.pg_index i WHERE i.indexrelid=index_oid AND i.indrelid=target
      AND i.indisvalid AND i.indisready AND i.indislive
      AND NOT(i.indisreplident OR i.indisclustered OR i.indisexclusion)
      AND pg_catalog.pg_get_indexdef(i.indexrelid)=definition) THEN
      RAISE EXCEPTION 'Catalog identity of public.% differs from required 0223 report payload index',index_name;
    END IF;
  END LOOP;
END;
$payload_indexes$;
