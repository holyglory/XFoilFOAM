-- The picker needs distinct pending signed points, their possible local attempts, and
-- the original order of their report aliases. These keys confer no delivery authority.
-- A point row serializes staging with receipt insertion/removal, including late aliases.
LOCK TABLE public.result_attempts, public.progressive_worker_evidence_attempts, public.progressive_worker_hub_receipts
  IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE public.progressive_worker_delivery_points (
  sim_job_id uuid NOT NULL REFERENCES public.sim_jobs(id) ON DELETE CASCADE,
  point_content_signature text NOT NULL,
  attempt_ids uuid[] NOT NULL,
  received boolean NOT NULL,
  PRIMARY KEY (sim_job_id,point_content_signature)
);
--> statement-breakpoint
CREATE INDEX progressive_worker_delivery_pending_point_idx ON public.progressive_worker_delivery_points
  (sim_job_id,point_content_signature) WHERE NOT received AND cardinality(attempt_ids)>0;
--> statement-breakpoint
-- The report guard makes created_at immutable. Acknowledgement, conflict and attempt eligibility remain live.
CREATE TABLE public.progressive_worker_delivery_order (
  sim_job_id uuid NOT NULL,
  sequence bigint NOT NULL,
  result_attempt_id uuid NOT NULL,
  point_content_signature text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (sim_job_id,sequence,result_attempt_id),
  CONSTRAINT worker_delivery_order_source_fk FOREIGN KEY (sim_job_id,sequence,result_attempt_id)
    REFERENCES public.progressive_worker_evidence_attempts(sim_job_id,sequence,result_attempt_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX progressive_worker_delivery_binding_order_idx ON public.progressive_worker_delivery_order
  (sim_job_id,point_content_signature,result_attempt_id,created_at,sequence);
--> statement-breakpoint
-- Source scalar, never a diagnostic receipt. An unindexed older attempt still uses its actual
-- payload. A positive value still requires every original diagnostic and delivery predicate.
CREATE TABLE public.progressive_worker_delivery_diagnostics (
  result_attempt_id uuid PRIMARY KEY REFERENCES public.result_attempts(id) ON DELETE CASCADE,
  material_domain boolean NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION public.track_worker_delivery_disposition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS (SELECT FROM public.progressive_worker_delivery_diagnostics d WHERE d.result_attempt_id=NEW.id)
     AND NOT EXISTS (SELECT FROM public.sim_jobs j WHERE j.id=NEW.sim_job_id AND j.request_payload->>'remoteSolver'='true') THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.progressive_worker_delivery_diagnostics AS d(result_attempt_id,material_domain)
  VALUES(NEW.id,(NEW.evidence_payload->>'failure_disposition'='material_domain') IS TRUE)
  ON CONFLICT (result_attempt_id) DO UPDATE SET material_domain=EXCLUDED.material_domain
    WHERE d.material_domain IS DISTINCT FROM EXCLUDED.material_domain;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER worker_delivery_disposition_written AFTER INSERT OR UPDATE OF evidence_payload,sim_job_id,engine_job_id
ON public.result_attempts FOR EACH ROW
WHEN (NEW.sim_job_id IS NOT NULL AND NEW.engine_job_id=NEW.sim_job_id::text)
EXECUTE FUNCTION public.track_worker_delivery_disposition();
--> statement-breakpoint
-- Seed all known bindings once; keep only keys of unreceived aliases in the order index.
INSERT INTO public.progressive_worker_delivery_points(sim_job_id,point_content_signature,attempt_ids,received)
SELECT b.sim_job_id,b.point_content_signature,b.attempt_ids,h.sim_job_id IS NOT NULL
FROM (SELECT s.sim_job_id,s.point_content_signature,array_agg(DISTINCT s.result_attempt_id ORDER BY s.result_attempt_id) AS attempt_ids
      FROM public.progressive_worker_evidence_attempts s GROUP BY 1,2) b
LEFT JOIN public.progressive_worker_hub_receipts h USING (sim_job_id,point_content_signature);
--> statement-breakpoint
INSERT INTO public.progressive_worker_delivery_points(sim_job_id,point_content_signature,attempt_ids,received)
SELECT sim_job_id,point_content_signature,'{}'::uuid[],true FROM public.progressive_worker_hub_receipts
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO public.progressive_worker_delivery_diagnostics(result_attempt_id,material_domain)
SELECT a.id,(a.evidence_payload->>'failure_disposition'='material_domain') IS TRUE
FROM (SELECT DISTINCT unnest(p.attempt_ids) AS id FROM public.progressive_worker_delivery_points p
      WHERE NOT p.received) b JOIN public.result_attempts a ON a.id=b.id;
--> statement-breakpoint
CREATE FUNCTION public.restore_progressive_worker_delivery_order(p_job uuid,p_point text,p_attempts uuid[])
RETURNS void LANGUAGE sql SET search_path=pg_catalog,public SET enable_seqscan=off SET jit=off AS $$
  INSERT INTO public.progressive_worker_delivery_order(sim_job_id,sequence,result_attempt_id,point_content_signature,created_at)
  SELECT s.sim_job_id,s.sequence,s.result_attempt_id,s.point_content_signature,r.created_at
  FROM unnest(p_attempts) a(id)
  JOIN public.progressive_worker_evidence_attempts s ON s.result_attempt_id=a.id
    AND s.sim_job_id=p_job AND s.point_content_signature=p_point
  JOIN public.progressive_worker_reports r ON (r.sim_job_id,r.sequence)=(s.sim_job_id,s.sequence)
  ON CONFLICT DO NOTHING
$$;
--> statement-breakpoint
SELECT public.restore_progressive_worker_delivery_order(sim_job_id,point_content_signature,attempt_ids)
FROM public.progressive_worker_delivery_points WHERE NOT received AND cardinality(attempt_ids)>0;
--> statement-breakpoint
CREATE FUNCTION public.stage_progressive_worker_delivery_sources() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public SET enable_seqscan=off SET jit=off AS $$
BEGIN
  -- One point-row version per distinct input key, even for an identical binding:
  -- a concurrent receipt removal must see the newly committed alias or serialize/retry.
  INSERT INTO public.progressive_worker_delivery_points AS p(sim_job_id,point_content_signature,attempt_ids,received)
  SELECT sim_job_id,point_content_signature,array_agg(DISTINCT result_attempt_id ORDER BY result_attempt_id),false
  FROM new_sources GROUP BY 1,2 ORDER BY 1,2
  ON CONFLICT (sim_job_id,point_content_signature) DO UPDATE SET attempt_ids=
    CASE WHEN EXCLUDED.attempt_ids <@ p.attempt_ids THEN p.attempt_ids
         ELSE ARRAY(SELECT DISTINCT id FROM unnest(p.attempt_ids||EXCLUDED.attempt_ids) a(id) ORDER BY id) END;

  -- Read the locked, indexed point records. Joining the INSERT's unindexed RETURNING
  -- tuplestore to a large COPY/restore transition table can make the write quadratic.
  INSERT INTO public.progressive_worker_delivery_order(sim_job_id,sequence,result_attempt_id,point_content_signature,created_at)
  SELECT s.sim_job_id,s.sequence,s.result_attempt_id,s.point_content_signature,r.created_at
  FROM new_sources s
  JOIN LATERAL (SELECT p.received FROM public.progressive_worker_delivery_points p
    WHERE (p.sim_job_id,p.point_content_signature)=(s.sim_job_id,s.point_content_signature) OFFSET 0) g ON NOT g.received
  JOIN LATERAL (SELECT r.created_at FROM public.progressive_worker_reports r
    WHERE (r.sim_job_id,r.sequence)=(s.sim_job_id,s.sequence) OFFSET 0) r ON true;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER worker_delivery_source_staged AFTER INSERT ON public.progressive_worker_evidence_attempts
REFERENCING NEW TABLE AS new_sources FOR EACH STATEMENT EXECUTE FUNCTION public.stage_progressive_worker_delivery_sources();
--> statement-breakpoint
CREATE FUNCTION public.forget_progressive_worker_delivery_sources() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  key record;
BEGIN
  -- The source FK removes its alias. Retain an attempt key if a different sequence
  -- still proves the same binding, including when a receipt is removed by cascade.
  FOR key IN SELECT DISTINCT sim_job_id,point_content_signature,result_attempt_id FROM old_sources ORDER BY 1,2,3 LOOP
    PERFORM 1 FROM public.progressive_worker_delivery_points p
      WHERE (p.sim_job_id,p.point_content_signature)=(key.sim_job_id,key.point_content_signature) FOR UPDATE;
    UPDATE public.progressive_worker_delivery_points p SET attempt_ids=array_remove(p.attempt_ids,key.result_attempt_id)
    WHERE (p.sim_job_id,p.point_content_signature)=(key.sim_job_id,key.point_content_signature)
      AND key.result_attempt_id=ANY(p.attempt_ids)
      AND NOT EXISTS (SELECT FROM public.progressive_worker_evidence_attempts s
        WHERE (s.result_attempt_id,s.sim_job_id,s.point_content_signature)=(key.result_attempt_id,key.sim_job_id,key.point_content_signature));
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER worker_delivery_source_removed AFTER DELETE ON public.progressive_worker_evidence_attempts
REFERENCING OLD TABLE AS old_sources FOR EACH STATEMENT EXECUTE FUNCTION public.forget_progressive_worker_delivery_sources();
--> statement-breakpoint
CREATE FUNCTION public.mark_progressive_worker_deliveries_received() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  INSERT INTO public.progressive_worker_delivery_points(sim_job_id,point_content_signature,attempt_ids,received)
  SELECT sim_job_id,point_content_signature,'{}'::uuid[],true FROM new_receipts ORDER BY 1,2
  ON CONFLICT (sim_job_id,point_content_signature) DO UPDATE SET received=true;
  DELETE FROM public.progressive_worker_delivery_order o USING new_receipts h
    WHERE (o.sim_job_id,o.point_content_signature)=(h.sim_job_id,h.point_content_signature);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER worker_delivery_receipt_added AFTER INSERT ON public.progressive_worker_hub_receipts
REFERENCING NEW TABLE AS new_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.mark_progressive_worker_deliveries_received();
--> statement-breakpoint
CREATE FUNCTION public.reopen_progressive_worker_deliveries() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  key record;
BEGIN
  FOR key IN SELECT sim_job_id,point_content_signature FROM removed_receipts ORDER BY 1,2 LOOP
    UPDATE public.progressive_worker_delivery_points p SET received=false
      WHERE (p.sim_job_id,p.point_content_signature)=(key.sim_job_id,key.point_content_signature);
    PERFORM public.restore_progressive_worker_delivery_order(p.sim_job_id,p.point_content_signature,p.attempt_ids)
      FROM public.progressive_worker_delivery_points p
      WHERE (p.sim_job_id,p.point_content_signature)=(key.sim_job_id,key.point_content_signature) AND NOT p.received;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER worker_delivery_receipt_removed AFTER DELETE ON public.progressive_worker_hub_receipts
REFERENCING OLD TABLE AS removed_receipts FOR EACH STATEMENT EXECUTE FUNCTION public.reopen_progressive_worker_deliveries();
--> statement-breakpoint
CREATE FUNCTION public.reset_progressive_worker_delivery_index() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_TABLE_NAME='progressive_worker_evidence_attempts' THEN
    DELETE FROM public.progressive_worker_delivery_points;
  ELSE
    UPDATE public.progressive_worker_delivery_points SET received=false WHERE received;
    PERFORM public.restore_progressive_worker_delivery_order(p.sim_job_id,p.point_content_signature,p.attempt_ids)
    FROM public.progressive_worker_delivery_points p WHERE NOT p.received AND cardinality(p.attempt_ids)>0;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER worker_delivery_sources_truncated AFTER TRUNCATE ON public.progressive_worker_evidence_attempts
FOR EACH STATEMENT EXECUTE FUNCTION public.reset_progressive_worker_delivery_index();
--> statement-breakpoint
CREATE TRIGGER worker_delivery_receipts_truncated AFTER TRUNCATE ON public.progressive_worker_hub_receipts
FOR EACH STATEMENT EXECUTE FUNCTION public.reset_progressive_worker_delivery_index();
