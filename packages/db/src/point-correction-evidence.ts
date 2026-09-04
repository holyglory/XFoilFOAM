import { sql, type SQL } from "drizzle-orm";

import { exactValidSolverManifestSql } from "./evidence-manifest";

export interface PointCorrectionProjection {
  root_revision_id: string;
  root_result_id: string;
  root_result_attempt_id: string;
  airfoil_id: string;
  aoa_deg: number;
  correction_id: string;
  corrected_revision_id: string;
  request_id: string;
  request_state: string;
  job_status: string | null;
  fidelity: "precalc" | "full";
  result_id: string | null;
  result_attempt_id: string | null;
  accepted: boolean;
  error: string | null;
  created_at: Date | string;
}

export function pointCorrectionProjectionSql(sourceScope: SQL): SQL {
  return sql`
    WITH RECURSIVE correction_lineage AS (
      SELECT source.simulation_preset_revision_id AS root_revision_id,
             source.id AS root_result_id, source_attempt.id AS root_result_attempt_id,
             source.airfoil_id,
             source.aoa_deg, correction.id AS correction_id,
             correction.corrected_revision_id, correction.urans_request_id,
             correction.fidelity, correction."createdAt" AS created_at
      FROM point_correction_runs correction
      JOIN results source ON source.id = correction.source_result_id
      JOIN result_attempts source_attempt
        ON source_attempt.id = correction.source_result_attempt_id
       AND source_attempt.result_id = source.id
       AND source_attempt.airfoil_id = source.airfoil_id
       AND source_attempt.simulation_preset_revision_id = source.simulation_preset_revision_id
       AND source_attempt.bc_id = source.bc_id
       AND source_attempt.aoa_deg = source.aoa_deg
      WHERE ${sourceScope}
      UNION
      SELECT previous.root_revision_id, previous.root_result_id,
             previous.root_result_attempt_id, previous.airfoil_id, previous.aoa_deg,
             correction.id, correction.corrected_revision_id,
             correction.urans_request_id, correction.fidelity,
             correction."createdAt"
      FROM correction_lineage previous
      JOIN sim_urans_requests previous_request
        ON previous_request.id = previous.urans_request_id
       AND previous_request.revision_id = previous.corrected_revision_id
       AND previous_request.airfoil_id = previous.airfoil_id
       AND previous_request.aoa_deg = previous.aoa_deg
      JOIN result_attempts source_attempt
        ON source_attempt.sim_job_id = previous_request.sim_job_id
       AND source_attempt.airfoil_id = previous.airfoil_id
       AND source_attempt.simulation_preset_revision_id = previous.corrected_revision_id
       AND source_attempt.aoa_deg = previous.aoa_deg
      JOIN point_correction_runs correction
        ON correction.source_result_attempt_id = source_attempt.id
       AND correction.source_result_id = source_attempt.result_id
    ), candidates AS (
      SELECT lineage.*, request.id AS request_id,
             request.state AS request_state, job.status::text AS job_status, corrected_attempt.result_id,
             corrected_attempt.id AS result_attempt_id, corrected_attempt.error,
             COALESCE(
               job.id IS NOT NULL AND corrected_result.current_result_attempt_id = corrected_attempt.id
               AND corrected_result.status = 'done' AND corrected_result.source = 'solved'
               AND corrected_attempt.status = 'done' AND corrected_attempt.source = 'solved'
               AND corrected_attempt.regime = 'urans'
               AND corrected_attempt.cl IS NOT NULL AND corrected_attempt.cd IS NOT NULL
               AND corrected_attempt.bc_id = corrected_result.bc_id
               AND corrected_result.airfoil_id = lineage.airfoil_id
               AND corrected_result.simulation_preset_revision_id = lineage.corrected_revision_id
               AND corrected_result.aoa_deg = lineage.aoa_deg
               AND corrected_result.fidelity = 'urans_' || lineage.fidelity
               AND corrected_attempt.evidence_payload ->> 'fidelity' = 'urans_' || lineage.fidelity
               AND classification.state = 'accepted'
               AND ${exactValidSolverManifestSql(sql`corrected_result.id`, sql`corrected_attempt.id`)}
               AND NOT EXISTS (
                 SELECT 1 FROM result_review_verdicts exclusion
                 WHERE exclusion.result_id = corrected_result.id
                   AND exclusion.verdict = 'exclude'
                   AND exclusion."revokedAt" IS NULL
               ), false
             ) AS accepted
      FROM correction_lineage lineage
      JOIN sim_urans_requests request
        ON request.id = lineage.urans_request_id
       AND request.airfoil_id = lineage.airfoil_id
       AND request.revision_id = lineage.corrected_revision_id
       AND request.aoa_deg = lineage.aoa_deg
       AND request.fidelity = lineage.fidelity
      LEFT JOIN sim_jobs job
        ON job.id = request.sim_job_id
       AND job.airfoil_id = lineage.airfoil_id
       AND job.simulation_preset_revision_id = lineage.corrected_revision_id
      LEFT JOIN LATERAL (
        SELECT evidence.* FROM result_attempts evidence
        WHERE evidence.sim_job_id = request.sim_job_id
          AND evidence.airfoil_id = lineage.airfoil_id
          AND evidence.simulation_preset_revision_id = lineage.corrected_revision_id
          AND evidence.aoa_deg = lineage.aoa_deg
        ORDER BY evidence."createdAt" DESC, evidence.id DESC
        LIMIT 1
      ) corrected_attempt ON TRUE
      LEFT JOIN results corrected_result ON corrected_result.id = corrected_attempt.result_id
      LEFT JOIN result_classifications classification
        ON classification.result_attempt_id = corrected_attempt.id
       AND classification.airfoil_id = corrected_attempt.airfoil_id
       AND classification.simulation_preset_revision_id = corrected_attempt.simulation_preset_revision_id
       AND classification.aoa_deg = corrected_attempt.aoa_deg
       AND classification.regime IS NOT DISTINCT FROM corrected_attempt.regime
    )
    SELECT DISTINCT ON (root_revision_id, airfoil_id, aoa_deg) *
    FROM candidates
    ORDER BY root_revision_id, airfoil_id, aoa_deg,
             accepted DESC, (accepted AND fidelity = 'full') DESC,
             (request_state IN ('pending', 'running')) DESC,
             created_at DESC, correction_id DESC
  `;
}
