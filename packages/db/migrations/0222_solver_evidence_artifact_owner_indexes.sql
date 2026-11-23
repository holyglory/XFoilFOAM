-- The normal migrator prepares existing evidence tables concurrently. A fresh
-- database can build empty indexes in the same transaction as its catalog.
DO $owner_indexes$
DECLARE
  owner_column text;
  index_name text;
  definition text;
  index_oid regclass;
BEGIN
  PERFORM pg_advisory_xact_lock(222, 1);
  FOR owner_column, index_name IN VALUES
    ('sim_job_id', 'solver_evidence_artifacts_sim_job_idx'),
    ('engine_job_id', 'solver_evidence_artifacts_engine_job_idx')
  LOOP
    definition := format('CREATE INDEX %I ON public.solver_evidence_artifacts USING btree (%I) WHERE (%I IS NOT NULL)',
                         index_name, owner_column, owner_column);
    index_oid := to_regclass(format('public.%I', index_name));
    IF index_oid IS NULL THEN
      LOCK TABLE public.solver_evidence_artifacts IN SHARE MODE NOWAIT;
      IF EXISTS (SELECT FROM public.solver_evidence_artifacts LIMIT 1) THEN
        RAISE EXCEPTION 'Prepare populated evidence tables with pnpm --filter @aerodb/db migrate --prepare-evidence-owner-indexes before 0222';
      END IF;
      EXECUTE definition;
      index_oid := to_regclass(format('public.%I', index_name));
    END IF;
    IF NOT EXISTS (
      SELECT FROM pg_catalog.pg_index i
      WHERE i.indexrelid = index_oid AND i.indrelid = 'public.solver_evidence_artifacts'::regclass
        AND i.indisvalid AND i.indisready AND i.indislive
        AND NOT (i.indisreplident OR i.indisclustered OR i.indisexclusion)
        AND pg_catalog.pg_get_indexdef(i.indexrelid) = definition
    ) THEN
      RAISE EXCEPTION 'Catalog identity of public.% differs from the required 0222 ownership index', index_name;
    END IF;
  END LOOP;
END;
$owner_indexes$;
