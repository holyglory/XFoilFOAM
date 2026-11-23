\set ON_ERROR_STOP on
-- Physical fixed-width TOAST index insertion. Populate disjoint value IDs in
-- an adversarial order; each value supplies its real, monotonically increasing
-- chunk sequence. Include tiny values and long runs crossing many leaves.
CREATE TEMP TABLE parking_chunk_fixture (value_id oid NOT NULL, chunk_seq int NOT NULL, PRIMARY KEY(value_id,chunk_seq));
INSERT INTO parking_chunk_fixture
SELECT (g::bigint*7919%10009)::oid, s
FROM generate_series(1,10000) g
CROSS JOIN LATERAL generate_series(0, CASE WHEN g%10=0 THEN 2000 WHEN g%3=0 THEN 1 ELSE g%180 END) s
ORDER BY g, s;
CREATE TEMP TABLE parking_chunk_counts AS
SELECT count(*) AS values, sum(n) AS chunks, sum(least(n,2)) AS edge_leaves FROM (
 SELECT value_id,count(*) AS n FROM parking_chunk_fixture GROUP BY value_id
) c;
DO $$
DECLARE actual bigint; allowance bigint;
BEGIN
 SELECT pg_relation_size('parking_chunk_fixture_pkey') INTO actual;
 SELECT ceil((edge_leaves + ceil((chunks-edge_leaves)/128.0)) * 8192.0 * 128/127) + 8192*16
   INTO allowance FROM parking_chunk_counts;
 IF actual > allowance THEN RAISE EXCEPTION 'Observed index % exceeds charge %',actual,allowance; END IF;
 RAISE NOTICE 'Inserted TOAST-shaped index bytes %; conservative allowance %',actual,allowance;
END $$;

CREATE TEMP TABLE parking_report_fixture
 (id bigint PRIMARY KEY, original_signature text NOT NULL, report jsonb NOT NULL, stopped_id text, received_at timestamptz);
-- Use real JSONB, varied storage lengths, repeated updates and heterogeneous btree keys.
CREATE INDEX ON parking_report_fixture (original_signature,stopped_id) WHERE stopped_id IS NOT NULL;
CREATE INDEX ON parking_report_fixture ((report->>'owner'),id) WHERE received_at IS NULL;
WITH inputs AS MATERIALIZED (
 SELECT g,string_agg(md5(g::text||'/'||i::text),'' ORDER BY i) AS payload
 FROM generate_series(1,1800) g CROSS JOIN LATERAL generate_series(1,3+(g*191)%1600) i GROUP BY g)
INSERT INTO parking_report_fixture SELECT g,md5(g::text)||md5((g+2)::text),
 jsonb_build_object('owner', g::text, 'generation',1,'data',payload), CASE WHEN g%2=0 THEN g::text END,
 CASE WHEN g%4=0 THEN '2026-01-01'::timestamptz END FROM inputs;
UPDATE parking_report_fixture SET report=jsonb_set(report,'{generation}','2') WHERE id%2=0;
DELETE FROM parking_report_fixture WHERE id%7=0;
CREATE TEMP TABLE parking_frozen AS SELECT id,sha256(record_send(t)) digest FROM parking_report_fixture t;
CREATE TEMP TABLE parking_sizes AS SELECT count(*) n,
 sum(CASE WHEN pg_column_size(report)>1500 THEN (pg_column_size(report)+7983)/7984 ELSE 0 END) toast_pages
 FROM parking_report_fixture;
VACUUM FULL parking_report_fixture;
DO $$
DECLARE physical bigint; allowed bigint; missing integer;
BEGIN
 SELECT count(*) INTO missing FROM parking_report_fixture t FULL JOIN parking_frozen f USING(id)
  WHERE f.digest IS DISTINCT FROM sha256(record_send(t));
 IF missing<>0 THEN RAISE EXCEPTION 'Scientific or metadata identity changed'; END IF;
 SELECT pg_relation_size(c.oid)+coalesce(pg_relation_size(nullif(c.reltoastrelid,0)),0)
  INTO physical FROM pg_class c WHERE c.oid='parking_report_fixture'::regclass;
 SELECT (toast_pages+ceil(n/4.0))*8192 INTO allowed FROM parking_sizes;
 IF physical>allowed THEN RAISE EXCEPTION 'Rebuilt heap/TOAST % exceeds %',physical,allowed; END IF;
 RAISE NOTICE 'Actual rebuilt heap plus TOAST %; visible bound %; all original row fingerprints identical',physical,allowed;
END $$;
