/**
 * Durable missing-default-media work queue.
 *
 * The queue is mutable execution/output metadata. Solver coefficients,
 * attempts, manifests, and raw field artifacts remain untouched. Discovery is
 * idempotent per canonical result/evidence signature; claims use one atomic
 * SKIP LOCKED transition so multiple sweepers cannot render the same result.
 */

import { sql } from "drizzle-orm";

import type { DB } from "./client";
import { acquireResultEvidenceLock } from "./result-evidence-lock";
import { resultMediaRepairs } from "./schema";

export const MAX_RESULT_MEDIA_REPAIR_ATTEMPTS = 3;
export const RESULT_MEDIA_REPAIR_LEASE_MS = 10 * 60_000;
export const RESULT_MEDIA_REPAIR_BACKOFF_MS = [30_000, 2 * 60_000] as const;

export type ResultMediaRepair = typeof resultMediaRepairs.$inferSelect;

export interface SatisfiedResultMediaRepair extends ResultMediaRepair {
  airfoilId: string;
  revisionId: string;
  aoaDeg: number;
  status: string;
  regime: string | null;
  fidelity: string | null;
}

/** Exact-attempt completeness proof shared by crash recovery and settlement.
 * The surrounding query must alias result_media_repairs as `repair`. */
const exactAttemptMediaComplete = sql`
  EXISTS (
    SELECT 1
    FROM results r
    JOIN result_attempts attempt
      ON attempt.id = repair.result_attempt_id
     AND attempt.result_id = r.id
    JOIN LATERAL (
      SELECT min(artifact.sha256) AS sha256
      FROM solver_evidence_artifacts artifact
      WHERE artifact.result_id = r.id
        AND artifact.result_attempt_id = attempt.id
        AND artifact.kind = 'manifest'
        AND artifact.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
        AND artifact.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
        AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
        AND artifact.byte_size > 0
        AND length(trim(artifact.storage_key)) > 0
        AND length(trim(artifact.mime_type)) > 0
      HAVING count(*) = 1
    ) manifest ON true
    WHERE r.id = repair.result_id
      AND attempt.status = 'done'
      AND attempt.source = 'solved'
      AND r.simulation_preset_revision_id IS NOT NULL
      AND repair.evidence_signature = concat_ws(':',
        COALESCE(attempt.engine_job_id, ''),
        COALESCE(attempt.engine_case_slug, ''),
        COALESCE(manifest.sha256, '')
      )
      AND EXISTS (
        SELECT 1 FROM result_field_extents extent
        WHERE extent.result_id = r.id
          AND extent.result_attempt_id = attempt.id
          AND extent.render_profile_key = 'default:v1:zoom2'
          AND extent.evidence_sha256 = manifest.sha256
      )
      AND NOT EXISTS (
        SELECT 1
        FROM result_field_extents extent
        WHERE extent.result_id = r.id
          AND extent.result_attempt_id = attempt.id
          AND extent.render_profile_key = 'default:v1:zoom2'
          AND extent.evidence_sha256 = manifest.sha256
          AND (
            NOT EXISTS (
              SELECT 1 FROM result_media media
              WHERE media.result_id = r.id
                AND media.result_attempt_id = attempt.id
                AND media.field = extent.field
                AND media.kind = 'image'
                AND media.role = 'instantaneous'
                AND media.render_profile_key = 'default:v1:zoom2'
                AND media.evidence_sha256 = manifest.sha256
                AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
                AND media.byte_size > 0
                AND media.color_scale_id = (
                  SELECT scale.id FROM field_color_scales scale
                  WHERE scale.airfoil_id = extent.airfoil_id
                    AND scale.simulation_preset_revision_id = extent.simulation_preset_revision_id
                    AND scale.field = extent.field
                    AND scale.render_profile_key = extent.render_profile_key
                    AND scale.active = true
                  LIMIT 1
                )
                AND media.storage_key <> ''
                AND media.mime_type LIKE 'image/%'
            )
            OR (
              (attempt.unsteady = true OR attempt.evidence_payload ->> 'fidelity' = 'urans_precalc')
              AND (
                NOT EXISTS (
                  SELECT 1 FROM result_media media
                  WHERE media.result_id = r.id
                    AND media.result_attempt_id = attempt.id
                    AND media.field = extent.field
                    AND media.kind = 'image'
                    AND media.role = 'mean'
                    AND media.render_profile_key = 'default:v1:zoom2'
                    AND media.evidence_sha256 = manifest.sha256
                    AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
                    AND media.byte_size > 0
                    AND media.color_scale_id = (
                      SELECT scale.id FROM field_color_scales scale
                      WHERE scale.airfoil_id = extent.airfoil_id
                        AND scale.simulation_preset_revision_id = extent.simulation_preset_revision_id
                        AND scale.field = extent.field
                        AND scale.render_profile_key = extent.render_profile_key
                        AND scale.active = true
                      LIMIT 1
                    )
                    AND media.storage_key <> ''
                    AND media.mime_type LIKE 'image/%'
                )
                OR NOT EXISTS (
                  SELECT 1 FROM result_media media
                  WHERE media.result_id = r.id
                    AND media.result_attempt_id = attempt.id
                    AND media.field = extent.field
                    AND media.kind = 'video'
                    AND media.role = 'instantaneous'
                    AND media.render_profile_key = 'default:v1:zoom2'
                    AND media.evidence_sha256 = manifest.sha256
                    AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
                    AND media.byte_size > 0
                    AND media.color_scale_id = (
                      SELECT scale.id FROM field_color_scales scale
                      WHERE scale.airfoil_id = extent.airfoil_id
                        AND scale.simulation_preset_revision_id = extent.simulation_preset_revision_id
                        AND scale.field = extent.field
                        AND scale.render_profile_key = extent.render_profile_key
                        AND scale.active = true
                      LIMIT 1
                    )
                    AND media.storage_key <> ''
                    AND media.mime_type LIKE 'video/%'
                )
              )
            )
          )
      )
  )
`;

/**
 * Discover coefficient-complete preliminary/unsteady results whose default
 * media is not complete for every evidence-backed field. Existing extents are
 * the evidence-backed field inventory; no extents is itself incomplete and
 * forces a fresh extent computation.
 *
 * Repeated scans do nothing. A changed engine job/case/manifest signature
 * reopens the obligation with a fresh bounded attempt budget; a completed row
 * whose media was later removed also reopens. A blocked row with unchanged
 * evidence stays blocked instead of forming an infinite retry loop.
 */
export async function discoverMissingResultMediaRepairs(
  db: DB,
  opts: {
    limit?: number;
    now?: Date;
    resultId?: string;
    airfoilId?: string;
  } = {},
): Promise<number> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1_000));
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const rows = (await db.execute(sql`
    WITH repair_source AS (
      SELECT
        r.id AS result_id,
        candidate.id AS result_attempt_id,
        COALESCE(candidate."solvedAt", candidate."createdAt") AS evidence_at,
        CASE
          WHEN producing_job.id IS NULL THEN true
          WHEN producing_job.campaign_id IS NOT NULL THEN false
          WHEN producing_job.request_payload ? 'verifyQueueItemId' THEN COALESCE((
            SELECT verify_item.background_owner
            FROM sim_urans_verify_queue verify_item
            WHERE verify_item.id::text = producing_job.request_payload ->> 'verifyQueueItemId'
          ), false)
          WHEN producing_job.request_payload ? 'uransRequestId' THEN COALESCE((
            SELECT request_item.background_owner
            FROM sim_urans_requests request_item
            WHERE request_item.id::text = producing_job.request_payload ->> 'uransRequestId'
          ), false)
          ELSE true
        END AS background_owner,
        concat_ws(':',
          COALESCE(candidate.engine_job_id, ''),
          COALESCE(candidate.engine_case_slug, ''),
          manifest.sha256
        ) AS evidence_signature
      FROM results r
      JOIN LATERAL (
        SELECT attempt.*
        FROM result_attempts attempt
        LEFT JOIN result_classifications classification
          ON classification.result_attempt_id = attempt.id
        WHERE attempt.result_id = r.id
          AND attempt.status = 'done'
          AND attempt.source = 'solved'
          AND (
            attempt.id = r.current_result_attempt_id
            OR (
              r.current_result_attempt_id IS NULL
              AND classification.state = 'rejected'
              AND classification.reasons = ARRAY['missing-urans-video']::text[]
            )
          )
        ORDER BY
          (attempt.id = r.current_result_attempt_id) DESC,
          CASE attempt.evidence_payload ->> 'fidelity'
            WHEN 'urans_full' THEN 3
            WHEN 'urans_precalc' THEN 2
            WHEN 'rans' THEN 1
            ELSE 0
          END DESC,
          COALESCE(attempt."solvedAt", attempt."createdAt") DESC,
          attempt.id DESC
        LIMIT 1
      ) candidate ON true
      JOIN LATERAL (
        SELECT min(artifact.sha256) AS sha256
        FROM solver_evidence_artifacts artifact
        WHERE artifact.result_id = r.id
          AND artifact.result_attempt_id = candidate.id
          AND artifact.kind = 'manifest'
          AND artifact.engine_job_id IS NOT DISTINCT FROM candidate.engine_job_id
          AND artifact.engine_case_slug IS NOT DISTINCT FROM candidate.engine_case_slug
          AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
          AND artifact.byte_size > 0
          AND length(trim(artifact.storage_key)) > 0
          AND length(trim(artifact.mime_type)) > 0
        HAVING count(*) = 1
      ) manifest ON true
      LEFT JOIN sim_jobs producing_job ON producing_job.id = candidate.sim_job_id
      WHERE r.simulation_preset_revision_id IS NOT NULL
        AND (${opts.resultId ?? null}::uuid IS NULL OR r.id = ${opts.resultId ?? null}::uuid)
        AND (${opts.airfoilId ?? null}::uuid IS NULL OR r.airfoil_id = ${opts.airfoilId ?? null}::uuid)
        AND (
          NOT EXISTS (
            SELECT 1 FROM result_field_extents extent
            WHERE extent.result_id = r.id
              AND extent.result_attempt_id = candidate.id
              AND extent.render_profile_key = 'default:v1:zoom2'
              AND extent.evidence_sha256 = manifest.sha256
          )
          OR EXISTS (
            SELECT 1
            FROM result_field_extents extent
            WHERE extent.result_id = r.id
              AND extent.result_attempt_id = candidate.id
              AND extent.render_profile_key = 'default:v1:zoom2'
              AND extent.evidence_sha256 = manifest.sha256
              AND (
                NOT EXISTS (
                  SELECT 1 FROM result_media media
                  WHERE media.result_id = r.id
                    AND media.result_attempt_id = candidate.id
                    AND media.field = extent.field
                    AND media.kind = 'image'
                    AND media.role = 'instantaneous'
                    AND media.render_profile_key = 'default:v1:zoom2'
                    AND media.evidence_sha256 = manifest.sha256
                    AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
                    AND media.byte_size > 0
                    AND media.color_scale_id = (
                      SELECT scale.id FROM field_color_scales scale
                      WHERE scale.airfoil_id = extent.airfoil_id
                        AND scale.simulation_preset_revision_id = extent.simulation_preset_revision_id
                        AND scale.field = extent.field
                        AND scale.render_profile_key = extent.render_profile_key
                        AND scale.active = true
                      LIMIT 1
                    )
                    AND media.storage_key <> ''
                    AND media.mime_type LIKE 'image/%'
                )
                OR (
                  (candidate.unsteady = true OR candidate.evidence_payload ->> 'fidelity' = 'urans_precalc')
                  AND (
                    NOT EXISTS (
                      SELECT 1 FROM result_media media
                      WHERE media.result_id = r.id
                        AND media.result_attempt_id = candidate.id
                        AND media.field = extent.field
                        AND media.kind = 'image'
                        AND media.role = 'mean'
                        AND media.render_profile_key = 'default:v1:zoom2'
                        AND media.evidence_sha256 = manifest.sha256
                        AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
                        AND media.byte_size > 0
                        AND media.color_scale_id = (
                          SELECT scale.id FROM field_color_scales scale
                          WHERE scale.airfoil_id = extent.airfoil_id
                            AND scale.simulation_preset_revision_id = extent.simulation_preset_revision_id
                            AND scale.field = extent.field
                            AND scale.render_profile_key = extent.render_profile_key
                            AND scale.active = true
                          LIMIT 1
                        )
                        AND media.storage_key <> ''
                        AND media.mime_type LIKE 'image/%'
                    )
                    OR NOT EXISTS (
                      SELECT 1 FROM result_media media
                      WHERE media.result_id = r.id
                        AND media.result_attempt_id = candidate.id
                        AND media.field = extent.field
                        AND media.kind = 'video'
                        AND media.role = 'instantaneous'
                        AND media.render_profile_key = 'default:v1:zoom2'
                        AND media.evidence_sha256 = manifest.sha256
                        AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
                        AND media.byte_size > 0
                        AND media.color_scale_id = (
                          SELECT scale.id FROM field_color_scales scale
                          WHERE scale.airfoil_id = extent.airfoil_id
                            AND scale.simulation_preset_revision_id = extent.simulation_preset_revision_id
                            AND scale.field = extent.field
                            AND scale.render_profile_key = extent.render_profile_key
                            AND scale.active = true
                          LIMIT 1
                        )
                        AND media.storage_key <> ''
                        AND media.mime_type LIKE 'video/%'
                    )
                  )
                )
              )
          )
        )
    ), candidate AS (
      SELECT repair_source.*
      FROM repair_source
      LEFT JOIN result_media_repairs existing
        ON existing.result_id = repair_source.result_id
      WHERE existing.id IS NULL
         OR existing.result_attempt_id IS DISTINCT FROM repair_source.result_attempt_id
         OR existing.evidence_signature IS DISTINCT FROM repair_source.evidence_signature
         OR existing.state = 'done'
         OR (existing.background_owner = false AND repair_source.background_owner)
      ORDER BY repair_source.evidence_at, repair_source.result_id
      LIMIT ${limit}
    )
    INSERT INTO result_media_repairs (
      result_id, result_attempt_id, state, evidence_signature, background_owner, attempt_count, max_attempts,
      next_attempt_at, last_error, claim_token, claimed_at, claim_expires_at, completed_at,
      downstream_finalized_at, "updatedAt"
    )
    SELECT candidate.result_id, candidate.result_attempt_id, 'pending', candidate.evidence_signature,
           candidate.background_owner, 0, ${MAX_RESULT_MEDIA_REPAIR_ATTEMPTS}, ${nowIso}::timestamptz, NULL, NULL, NULL, NULL,
           NULL, NULL, ${nowIso}::timestamptz
    FROM candidate
    ON CONFLICT (result_id) DO UPDATE SET
      result_attempt_id = EXCLUDED.result_attempt_id,
      state = CASE WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
                         OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
                         OR result_media_repairs.state = 'done'
                   THEN 'pending' ELSE result_media_repairs.state END,
      evidence_signature = EXCLUDED.evidence_signature,
      background_owner = result_media_repairs.background_owner OR EXCLUDED.background_owner,
      attempt_count = CASE WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
                                OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
                                OR result_media_repairs.state = 'done'
                           THEN 0 ELSE result_media_repairs.attempt_count END,
      max_attempts = CASE WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
                               OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
                               OR result_media_repairs.state = 'done'
                          THEN ${MAX_RESULT_MEDIA_REPAIR_ATTEMPTS} ELSE result_media_repairs.max_attempts END,
      claim_token = CASE WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
                              OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
                              OR result_media_repairs.state = 'done'
                         THEN NULL ELSE result_media_repairs.claim_token END,
      claimed_at = CASE WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
                             OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
                             OR result_media_repairs.state = 'done'
                        THEN NULL ELSE result_media_repairs.claimed_at END,
      claim_expires_at = CASE WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
                                   OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
                                   OR result_media_repairs.state = 'done'
                              THEN NULL ELSE result_media_repairs.claim_expires_at END,
      next_attempt_at = CASE WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
                                  OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
                                  OR result_media_repairs.state = 'done'
                             THEN ${nowIso}::timestamptz ELSE result_media_repairs.next_attempt_at END,
      last_error = CASE WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
                             OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
                             OR result_media_repairs.state = 'done'
                        THEN NULL ELSE result_media_repairs.last_error END,
      completed_at = CASE WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
                               OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
                               OR result_media_repairs.state = 'done'
                          THEN NULL ELSE result_media_repairs.completed_at END,
      downstream_finalized_at = CASE WHEN result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
                                          OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
                                          OR result_media_repairs.state = 'done'
                                     THEN NULL ELSE result_media_repairs.downstream_finalized_at END,
      "updatedAt" = ${nowIso}::timestamptz
    WHERE result_media_repairs.result_attempt_id IS DISTINCT FROM EXCLUDED.result_attempt_id
       OR result_media_repairs.evidence_signature IS DISTINCT FROM EXCLUDED.evidence_signature
       OR result_media_repairs.state = 'done'
       OR (result_media_repairs.background_owner = false AND EXCLUDED.background_owner)
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length;
}

/** One atomic claim; safe across multiple sweeper instances. */
export async function claimNextResultMediaRepair(
  db: DB,
  opts: { now?: Date; leaseMs?: number; resultId?: string } = {},
): Promise<ResultMediaRepair | null> {
  const now = opts.now ?? new Date();
  const leaseMs = Math.max(
    30_000,
    opts.leaseMs ?? RESULT_MEDIA_REPAIR_LEASE_MS,
  );
  const expires = new Date(now.getTime() + leaseMs);
  const nowIso = now.toISOString();
  const expiresIso = expires.toISOString();
  const rows = (await db.execute(sql`
    WITH candidate AS (
      SELECT repair.id
      FROM result_media_repairs repair
      WHERE repair.state IN ('pending', 'retry_wait')
        AND (${opts.resultId ?? null}::uuid IS NULL OR repair.result_id = ${opts.resultId ?? null}::uuid)
        AND repair.next_attempt_at <= ${nowIso}::timestamptz
        AND repair.attempt_count < repair.max_attempts
      ORDER BY repair.next_attempt_at, repair."createdAt", repair.id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE result_media_repairs repair
    SET state = 'running',
        attempt_count = repair.attempt_count + 1,
        claim_token = gen_random_uuid(),
        claimed_at = ${nowIso}::timestamptz,
        claim_expires_at = ${expiresIso}::timestamptz,
        last_error = NULL,
        "updatedAt" = ${nowIso}::timestamptz
    FROM candidate
    WHERE repair.id = candidate.id
    RETURNING
      repair.id,
      repair.result_id AS "resultId",
      repair.result_attempt_id AS "resultAttemptId",
      repair.state,
      repair.evidence_signature AS "evidenceSignature",
      repair.background_owner AS "backgroundOwner",
      repair.attempt_count AS "attemptCount",
      repair.max_attempts AS "maxAttempts",
      repair.claim_token AS "claimToken",
      repair.claimed_at AS "claimedAt",
      repair.claim_expires_at AS "claimExpiresAt",
      repair.next_attempt_at AS "nextAttemptAt",
      repair.last_error AS "lastError",
      repair.completed_at AS "completedAt",
      repair."createdAt",
      repair."updatedAt"
  `)) as unknown as ResultMediaRepair[];
  return rows[0] ?? null;
}

/**
 * Return expired renderer leases to retry_wait, or block them when the crash
 * consumed the final bounded attempt. A completed-media scan must run before
 * this healer: media can commit immediately before a process dies.
 */
export async function healExpiredResultMediaRepairClaims(
  db: DB,
  opts: { now?: Date } = {},
): Promise<{ retrying: number; blocked: number }> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const rows = (await db.execute(sql`
    UPDATE result_media_repairs repair
    SET state = CASE
          WHEN repair.attempt_count >= repair.max_attempts THEN 'blocked'
          ELSE 'retry_wait'
        END,
        claim_token = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        next_attempt_at = ${nowIso}::timestamptz,
        last_error = CASE
          WHEN repair.attempt_count >= repair.max_attempts
            THEN 'automatic media repair exhausted after renderer claim expired'
          ELSE 'renderer claim expired before completion; retry scheduled'
        END,
        "updatedAt" = ${nowIso}::timestamptz
    WHERE repair.state = 'running'
      AND repair.claim_expires_at IS NOT NULL
      AND repair.claim_expires_at <= ${nowIso}::timestamptz
    RETURNING state
  `)) as unknown as Array<{ state: string }>;
  return {
    retrying: rows.filter((row) => row.state === "retry_wait").length,
    blocked: rows.filter((row) => row.state === "blocked").length,
  };
}

/** Token-fenced lease renewal for long multi-field render passes. */
export async function renewResultMediaRepairClaim(
  db: DB,
  repair: Pick<ResultMediaRepair, "id" | "claimToken">,
  opts: { now?: Date; leaseMs?: number } = {},
): Promise<boolean> {
  if (!repair.claimToken) return false;
  const now = opts.now ?? new Date();
  const leaseMs = Math.max(
    30_000,
    opts.leaseMs ?? RESULT_MEDIA_REPAIR_LEASE_MS,
  );
  const expires = new Date(now.getTime() + leaseMs);
  const nowIso = now.toISOString();
  const expiresIso = expires.toISOString();
  const rows = (await db.execute(sql`
    UPDATE result_media_repairs
    SET claim_expires_at = ${expiresIso}::timestamptz, "updatedAt" = ${nowIso}::timestamptz
    WHERE id = ${repair.id}
      AND state = 'running'
      AND claim_token = ${repair.claimToken}::uuid
      AND claim_expires_at > ${nowIso}::timestamptz
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

function backoffForAttempt(attemptCount: number): number {
  return (
    RESULT_MEDIA_REPAIR_BACKOFF_MS[
      Math.min(
        Math.max(attemptCount - 1, 0),
        RESULT_MEDIA_REPAIR_BACKOFF_MS.length - 1,
      )
    ] ?? 2 * 60_000
  );
}

export async function failClaimedResultMediaRepair(
  db: DB,
  repair: Pick<
    ResultMediaRepair,
    "id" | "attemptCount" | "maxAttempts" | "claimToken"
  >,
  error: string,
  opts: { now?: Date; backoffMs?: number } = {},
): Promise<"retry_wait" | "blocked" | null> {
  if (!repair.claimToken) return null;
  const now = opts.now ?? new Date();
  const exhausted = repair.attemptCount >= repair.maxAttempts;
  const next = new Date(
    now.getTime() + (opts.backoffMs ?? backoffForAttempt(repair.attemptCount)),
  );
  const nowIso = now.toISOString();
  const nextIso = next.toISOString();
  const reason =
    error.trim().slice(0, 2_000) ||
    "automatic media repair failed without an error message";
  const rows = (await db.execute(sql`
    UPDATE result_media_repairs
    SET state = ${exhausted ? "blocked" : "retry_wait"},
        claim_token = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        next_attempt_at = ${exhausted ? nowIso : nextIso}::timestamptz,
        last_error = ${reason},
        "updatedAt" = ${nowIso}::timestamptz
    WHERE id = ${repair.id}
      AND state = 'running'
      AND claim_token = ${repair.claimToken}::uuid
    RETURNING state
  `)) as unknown as Array<{ state: "retry_wait" | "blocked" }>;
  return rows[0]?.state ?? null;
}

/**
 * Media-complete obligations, including running/blocked rows. This is the
 * crash-after-commit recovery scan and also lets a later trusted media import
 * heal a previously exhausted obligation without another renderer attempt.
 */
export async function satisfiedResultMediaRepairs(
  db: DB,
  opts: { limit?: number; resultId?: string } = {},
): Promise<SatisfiedResultMediaRepair[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 1_000));
  return (await db.execute(sql`
    SELECT repair.id,
           repair.result_id AS "resultId",
           repair.result_attempt_id AS "resultAttemptId",
           repair.state,
           repair.evidence_signature AS "evidenceSignature",
           repair.background_owner AS "backgroundOwner",
           repair.attempt_count AS "attemptCount",
           repair.max_attempts AS "maxAttempts",
           repair.claim_token AS "claimToken",
           repair.claimed_at AS "claimedAt",
           repair.claim_expires_at AS "claimExpiresAt",
           repair.next_attempt_at AS "nextAttemptAt",
           repair.last_error AS "lastError",
           repair.completed_at AS "completedAt",
           repair.downstream_finalized_at AS "downstreamFinalizedAt",
           repair."createdAt",
           repair."updatedAt",
           r.airfoil_id AS "airfoilId",
           r.simulation_preset_revision_id AS "revisionId",
           r.aoa_deg AS "aoaDeg",
           attempt.status::text AS status,
           attempt.regime::text AS regime,
           attempt.evidence_payload ->> 'fidelity' AS fidelity
    FROM result_media_repairs repair
    JOIN results r ON r.id = repair.result_id
    JOIN result_attempts attempt
      ON attempt.id = repair.result_attempt_id
     AND attempt.result_id = r.id
    WHERE (repair.state <> 'done' OR repair.downstream_finalized_at IS NULL)
      AND (${opts.resultId ?? null}::uuid IS NULL OR repair.result_id = ${opts.resultId ?? null}::uuid)
      AND ${exactAttemptMediaComplete}
    ORDER BY repair."updatedAt", repair.id
    LIMIT ${limit}
  `)) as unknown as SatisfiedResultMediaRepair[];
}

/** Fenced completion for an active renderer claim. */
export async function completeClaimedResultMediaRepair(
  db: DB,
  repair: Pick<ResultMediaRepair, "id" | "claimToken">,
  opts: { now?: Date } = {},
): Promise<boolean> {
  if (!repair.claimToken) return false;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const rows = (await db.execute(sql`
    UPDATE result_media_repairs
    SET state = 'done', claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL,
        next_attempt_at = ${nowIso}::timestamptz, last_error = NULL, completed_at = ${nowIso}::timestamptz,
        "updatedAt" = ${nowIso}::timestamptz
    WHERE id = ${repair.id}
      AND state = 'running'
      AND claim_token = ${repair.claimToken}::uuid
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Evidence-derived completion used only after `satisfiedResultMediaRepairs`
 * proved all required media rows exist. It intentionally does not rely on a
 * renderer lease, so a process crash after media commit can self-heal. It can
 * never record an error or overwrite a newer renderer's output.
 */
export async function completeSatisfiedResultMediaRepair(
  db: DB,
  repairId: string,
  resultAttemptId: string,
  evidenceSignature: string,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [repair] = await tx
      .select({ resultId: resultMediaRepairs.resultId })
      .from(resultMediaRepairs)
      .where(sql`${resultMediaRepairs.id} = ${repairId}`)
      .limit(1);
    if (!repair) return false;
    // Manifest producers use this same transaction lock. The completeness
    // proof and state transition therefore observe one immutable current
    // evidence identity, rather than racing a newly attached manifest.
    await acquireResultEvidenceLock(tx, repair.resultId);
    const rows = (await tx.execute(sql`
      UPDATE result_media_repairs repair
      SET state = 'done', claim_token = NULL, claimed_at = NULL,
          claim_expires_at = NULL,
          next_attempt_at = ${nowIso}::timestamptz,
          last_error = NULL,
          completed_at = COALESCE(repair.completed_at, ${nowIso}::timestamptz),
          "updatedAt" = ${nowIso}::timestamptz
      WHERE repair.id = ${repairId}
        AND repair.result_attempt_id = ${resultAttemptId}
        AND repair.evidence_signature = ${evidenceSignature}
        AND ${exactAttemptMediaComplete}
      RETURNING repair.id
    `)) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  });
}

/** Final idempotency marker after every downstream evidence-derived hook has
 * completed. A process crash before this write leaves a resumable done row. */
export async function completeResultMediaRepairFinalization(
  db: DB,
  repairId: string,
  resultAttemptId: string,
  evidenceSignature: string,
  opts: { now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const rows = (await db.execute(sql`
    UPDATE result_media_repairs
    SET downstream_finalized_at = ${nowIso}::timestamptz,
        "updatedAt" = ${nowIso}::timestamptz
    WHERE id = ${repairId}
      AND result_attempt_id = ${resultAttemptId}
      AND state = 'done'
      AND evidence_signature = ${evidenceSignature}
      AND downstream_finalized_at IS NULL
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length > 0;
}

/** A DB-complete row whose shared-volume bytes are missing/corrupt is not
 * complete evidence. Reopen it under the existing bounded attempt budget;
 * the verifier removes the bad presentation row before calling this helper. */
export async function invalidateSatisfiedResultMediaRepair(
  db: DB,
  repairId: string,
  resultAttemptId: string,
  evidenceSignature: string,
  error: string,
  opts: { now?: Date } = {},
): Promise<"retry_wait" | "blocked" | null> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const reason =
    error.trim().slice(0, 2_000) || "stored media byte verification failed";
  const rows = (await db.execute(sql`
    UPDATE result_media_repairs
    SET state = CASE WHEN attempt_count >= max_attempts THEN 'blocked' ELSE 'retry_wait' END,
        claim_token = NULL,
        claimed_at = NULL,
        claim_expires_at = NULL,
        next_attempt_at = ${nowIso}::timestamptz,
        last_error = ${reason},
        completed_at = NULL,
        downstream_finalized_at = NULL,
        "updatedAt" = ${nowIso}::timestamptz
    WHERE id = ${repairId}
      AND result_attempt_id = ${resultAttemptId}
      AND evidence_signature = ${evidenceSignature}
      AND downstream_finalized_at IS NULL
    RETURNING state
  `)) as unknown as Array<{ state: "retry_wait" | "blocked" }>;
  return rows[0]?.state ?? null;
}
