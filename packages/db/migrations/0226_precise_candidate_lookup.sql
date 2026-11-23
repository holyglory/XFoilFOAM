-- Keep the attempt and its owner available to coverage queries without reading
-- a full URANS history to identify its fidelity.
CREATE INDEX IF NOT EXISTS result_attempts_precise_candidate_idx
  ON public.result_attempts (id, result_id, sim_job_id)
  WHERE status = 'done' AND valid_for_polar
    AND (regime = 'rans' OR evidence_payload->>'fidelity' = 'urans_full');
