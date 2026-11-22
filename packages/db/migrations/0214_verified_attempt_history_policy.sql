-- Opt in only after the scoped readers and writers have been verified on this hub.
ALTER TABLE attempt_evidence_storage_policy
  DROP CONSTRAINT attempt_evidence_storage_policy_progressive_source_scope_check,
  ADD CONSTRAINT attempt_evidence_storage_policy_progressive_source_scope_check
    CHECK (progressive_source_scope IN ('legacy','stopped-only','receipt-bearing','receipt-urans','verified')),
  ADD CONSTRAINT attempt_evidence_verified_policy_check CHECK (progressive_source_scope <> 'verified' OR
    (shortening_enabled AND consumer_contract_version=1 AND canary_attempt_id IS NULL
     AND stopped_progressive_enabled AND NOT hz_worker_only));
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_verified_hub() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT FROM sync_api_settings WHERE id=1 AND
    (remote_solver_enabled OR remote_solver_registered_id IS NOT NULL))
    AND NOT EXISTS (SELECT FROM attempt_evidence_storage_policy WHERE id=1 AND hz_worker_only)
$$;
--> statement-breakpoint
-- A route is only a choice of the existing proof. The exact cohort limiter is
-- used for preview, application preparation, and again under the 0208 write locks.
CREATE FUNCTION attempt_evidence_verified_route(p_id uuid, p_archive uuid DEFAULT NULL,
  OUT cohort text, OUT limiter text) LANGUAGE plpgsql STABLE AS $$
DECLARE regime_ text; cold boolean; storage_only_ boolean;
BEGIN
  IF NOT attempt_evidence_verified_hub() THEN limiter := 'requires-worker-custody'; RETURN; END IF;
  SELECT a.regime, a.evidence_archive_id IS NOT NULL INTO regime_, cold FROM result_attempts a WHERE a.id=p_id;
  IF NOT FOUND THEN limiter := 'missing-attempt'; RETURN; END IF;
  IF cold THEN limiter := 'already-shortened'; RETURN; END IF;
  IF regime_='urans' THEN
    cohort := 'receipt-urans';
    limiter := attempt_evidence_urans_shortening_limiter(p_id,p_archive);
    RETURN;
  END IF;
  IF regime_ IS DISTINCT FROM 'rans' THEN limiter := 'outside-verified-cohorts'; RETURN; END IF;
  SELECT r.storage_only INTO storage_only_ FROM progressive_remote_evidence_receipts r WHERE r.result_attempt_id=p_id;
  IF storage_only_ THEN
    -- A historical stopped receipt retains its original verifier when it qualifies.
    limiter := attempt_evidence_stopped_shortening_limiter(p_id,p_archive);
    IF limiter IS NULL THEN cohort := 'stopped-only'; RETURN; END IF;
  END IF;
  IF storage_only_ IS NOT NULL OR EXISTS (SELECT FROM progressive_cfd_evidence WHERE result_attempt_id=p_id) THEN
    cohort := 'receipt-bearing';
    limiter := attempt_evidence_receipt_shortening_limiter(p_id,p_archive);
  ELSE
    cohort := 'legacy';
    limiter := attempt_evidence_local_shortening_limiter(p_id,p_archive);
  END IF;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_shortening_limiter(uuid,uuid) RENAME TO attempt_evidence_pre_verified_limiter;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_shortening_limiter(attempt_id uuid,archive_id uuid DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF (SELECT progressive_source_scope FROM attempt_evidence_storage_policy WHERE id=1)='verified' THEN
    RETURN (SELECT r.limiter FROM attempt_evidence_verified_route(attempt_id,archive_id) r);
  END IF;
  RETURN attempt_evidence_pre_verified_limiter(attempt_id,archive_id);
END;
$$;
--> statement-breakpoint
ALTER FUNCTION attempt_evidence_verification_valid(uuid,uuid,jsonb) RENAME TO attempt_evidence_pre_verified_proof;
--> statement-breakpoint
CREATE FUNCTION attempt_evidence_verification_valid(p_id uuid,p_archive_id uuid,p_proof jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE AS $$
DECLARE cohort_ text; verifier text := p_proof#>>'{dependencies,verifier}';
BEGIN
  IF (SELECT progressive_source_scope FROM attempt_evidence_storage_policy WHERE id=1) IS DISTINCT FROM 'verified' THEN
    RETURN attempt_evidence_pre_verified_proof(p_id,p_archive_id,p_proof);
  END IF;
  SELECT r.cohort INTO cohort_ FROM attempt_evidence_verified_route(p_id,p_archive_id) r WHERE r.limiter IS NULL;
  CASE cohort_
    WHEN 'legacy' THEN
      RETURN verifier IS NOT DISTINCT FROM 'server-consumers/local-steady-rans-v1' AND attempt_evidence_pre_verified_proof(p_id,p_archive_id,p_proof);
    WHEN 'stopped-only' THEN
      RETURN verifier IS NOT DISTINCT FROM 'server-consumers/stopped-progressive-rans-v1' AND attempt_evidence_pre_verified_proof(p_id,p_archive_id,p_proof);
    WHEN 'receipt-bearing','receipt-urans' THEN
      RETURN attempt_evidence_original_readbacks_valid(p_id,p_archive_id,p_proof) AND attempt_evidence_bound_receipt_proof(
        attempt_evidence_receipt_scope_for(p_id,cohort_='receipt-urans'),p_proof->'dependencies',
        CASE cohort_ WHEN 'receipt-urans' THEN 'server-consumers/receipt-bearing-urans-v1' ELSE 'server-consumers/receipt-bearing-rans-v1' END);
    ELSE RETURN false;
  END CASE;
END;
$$;
