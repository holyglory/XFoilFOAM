import { canonicalSubtreeCandidateSql } from "./result-history-subtrees";
import { sql } from "drizzle-orm";
import type { DB } from "./client";

export const VERIFIED_HUB_ATTEMPT_COHORTS = [
  "legacy",
  "stopped-only",
  "receipt-bearing",
  "receipt-urans",
] as const;
export type VerifiedHubAttemptCohort =
  (typeof VERIFIED_HUB_ATTEMPT_COHORTS)[number];

export function hasConfiguredAttemptHubRole(): boolean {
  return process.env.AIRFOILFOAM_DEPLOYMENT_ROLE?.trim() === "hub";
}

export function requireConfiguredAttemptHubRole() {
  if (!hasConfiguredAttemptHubRole())
    throw new Error(
      "Verified attempts require an explicit hub deployment role. Worker attempts require the HZ custody relay",
    );
}

export async function requireVerifiedAttemptHub(db: DB) {
  requireConfiguredAttemptHubRole();
  const [installed] = await db.execute(
    sql`SELECT to_regprocedure('attempt_evidence_verified_route(uuid,uuid)') IS NOT NULL AS ready`,
  );
  if (!installed?.ready)
    throw new Error("Verified attempt policy requires forward migration 0214");
  const [role] = await db.execute(
    sql`SELECT attempt_evidence_verified_hub() AS hub`,
  );
  if (!role?.hub)
    throw new Error("Worker attempts require the HZ custody relay");
}

export async function enableVerifiedAttemptPolicy(db: DB) {
  await requireVerifiedAttemptHub(db);
  const updated = await db.execute(sql`UPDATE attempt_evidence_storage_policy
    SET shortening_enabled=true,consumer_contract_version=1,canary_attempt_id=NULL,
      stopped_progressive_enabled=true,progressive_source_scope='verified'
    WHERE id=1 AND NOT hz_worker_only AND attempt_evidence_verified_hub() RETURNING id`);
  if (!updated.length)
    throw new Error("Verified attempt policy requires a hub policy row");
}

/** An application preflight. The SQL writer independently selects and validates the
 * same proof against the live row, its exact archive and the locked policy. */
export async function verifiedAttemptProofScope(
  db: DB,
  attemptId: string,
  archiveId: string,
): Promise<VerifiedHubAttemptCohort> {
  const [route] = await db.execute(
    sql`SELECT cohort,limiter FROM attempt_evidence_verified_route(${attemptId}::uuid,${archiveId}::uuid)`,
  );
  if (
    route?.limiter !== null ||
    !VERIFIED_HUB_ATTEMPT_COHORTS.some((cohort) => cohort === route.cohort)
  )
    throw new Error(
      `Attempt has no eligible verified cohort: ${String(route?.limiter ?? "unknown cohort")}`,
    );
  return route.cohort as VerifiedHubAttemptCohort;
}

/** Examine at most one stable attempt-ID page. Multiple archive generations can exist
 * for one attempt. Only the exact archive that passed its own limiter can be offered. */
export function verifiedAttemptCandidatesSql(after: string | null, canonicalFields = false) {
  return sql`WITH ids AS MATERIALIZED (
    SELECT DISTINCT ar.result_attempt_id AS id FROM attempt_evidence_archives ar
    ${after ? sql`WHERE ar.result_attempt_id > ${after}::uuid` : sql``} ORDER BY ar.result_attempt_id LIMIT 32
  )
  SELECT a.id, ${canonicalSubtreeCandidateSql(sql`a`,canonicalFields)} AS canonical_fields,
    CASE WHEN a.evidence_archive_id IS NOT NULL THEN 'already-shortened' ELSE picked.limiter END AS limiter,
    CASE WHEN picked.limiter IS NULL THEN picked.archive_id END AS archive_id, picked.cohort
  FROM ids JOIN result_attempts a USING (id)
  LEFT JOIN LATERAL (
    SELECT ar.id AS archive_id,route.cohort,route.limiter FROM attempt_evidence_archives ar
    CROSS JOIN LATERAL attempt_evidence_verified_route(ar.result_attempt_id,ar.id) route
    WHERE ar.result_attempt_id=a.id AND a.evidence_archive_id IS NULL
    ORDER BY (route.limiter IS NULL) DESC, ar.verified_at DESC, ar.id LIMIT 1
  ) picked ON true ORDER BY a.id`;
}
