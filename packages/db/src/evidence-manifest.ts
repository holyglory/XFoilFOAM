import { sql, type SQLWrapper } from "drizzle-orm";

import type { DB } from "./client";

type EvidenceQueryExecutor = Pick<DB, "execute">;

/** Publication-grade evidence requires one and only one exact manifest for
 * the immutable result generation. Multiple manifests are ambiguous; empty or
 * malformed artifact metadata is not durable evidence. Keep this predicate
 * shared by ingest and all later ladder projections. */
export async function hasExactValidSolverManifest(
  tx: EvidenceQueryExecutor,
  resultId: string,
  resultAttemptId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT ${exactValidSolverManifestSql(resultId, resultAttemptId)} AS valid
  `)) as unknown as Array<{ valid: boolean }>;
  return rows[0]?.valid === true;
}

export function exactValidSolverManifestSql(
  resultId: string | SQLWrapper,
  resultAttemptId: string | SQLWrapper,
) {
  return sql`EXISTS (
    SELECT 1
    FROM (
      SELECT count(manifest.id)::int AS count,
           COALESCE(bool_and(
             manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
             AND manifest.byte_size > 0
             AND length(trim(manifest.storage_key)) > 0
             AND length(trim(manifest.mime_type)) > 0
             AND manifest.airfoil_id = attempt.airfoil_id
             AND manifest.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
             AND manifest.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
             AND manifest.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
             AND manifest.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
           ), false) AS valid
    FROM result_attempts attempt
    JOIN results result
      ON result.id = attempt.result_id
     AND result.airfoil_id = attempt.airfoil_id
     AND result.bc_id = attempt.bc_id
     AND result.simulation_preset_revision_id IS NOT DISTINCT FROM
       attempt.simulation_preset_revision_id
     AND result.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
    LEFT JOIN solver_evidence_artifacts manifest
      ON manifest.result_id = result.id
     AND manifest.result_attempt_id = attempt.id
     AND manifest.kind = 'manifest'
      WHERE result.id = ${resultId}
        AND attempt.id = ${resultAttemptId}
      GROUP BY result.id, attempt.id
    ) exact_manifest
    WHERE exact_manifest.count = 1
      AND exact_manifest.valid
  )`;
}

/** A same-case continuation is allowed only when the exact immutable
 * generation can be restored independently of mutable engine-local paths.
 * This proves one current, verified tar+zstd archive owns the exact result
 * attempt and contains the manifest plus every OpenFOAM restart primitive.
 *
 * Callers must still apply their stage-specific semantic gates (solved
 * PRECALC/FULL, rejected classification, restart marker, target cell, and
 * implementation identity). This helper owns only durable archive identity
 * and restart completeness. */
export function exactVerifiedRestartableEvidenceArchiveSql(
  resultId: string | SQLWrapper,
  resultAttemptId: string | SQLWrapper,
) {
  return sql`EXISTS (
      SELECT 1
      FROM result_attempts attempt
      JOIN results result
        ON result.id = attempt.result_id
       AND result.airfoil_id = attempt.airfoil_id
       AND result.bc_id = attempt.bc_id
       AND result.simulation_preset_revision_id IS NOT DISTINCT FROM
         attempt.simulation_preset_revision_id
       AND result.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
      JOIN solver_implementations implementation
        ON implementation.id = attempt.solver_implementation_id
      JOIN solver_evidence_archives archive
        ON archive.result_id = result.id
       AND archive.result_attempt_id = attempt.id
       AND archive.state = 'current'
      JOIN solver_evidence_blobs blob
        ON blob.id = archive.blob_id
       AND blob.backend = 'gcs'
       AND blob.compression = 'zstd'
       AND btrim(blob.bucket) <> ''
       AND btrim(blob.object_key) <> ''
       AND btrim(blob.generation) <> ''
       AND blob."verifiedAt" IS NOT NULL
       AND blob.sha256 ~ '^[0-9a-fA-F]{64}$'
       AND blob.byte_size > 0
       AND blob.uncompressed_tar_sha256 ~ '^[0-9a-fA-F]{64}$'
       AND blob.uncompressed_tar_byte_size > 0
      JOIN solver_evidence_artifacts source
        ON source.id = archive.source_artifact_id
       AND source.result_id = result.id
       AND source.result_attempt_id = attempt.id
       AND source.kind IN ('engine_bundle', 'openfoam_bundle')
       AND source.airfoil_id = attempt.airfoil_id
       AND source.sim_job_id IS NOT DISTINCT FROM attempt.sim_job_id
       AND source.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
       AND source.engine_case_slug IS NOT DISTINCT FROM
         attempt.engine_case_slug
       AND source.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
      WHERE result.id = ${resultId}
        AND attempt.id = ${resultAttemptId}
        AND EXISTS (
          SELECT 1
          FROM solver_evidence_artifact_members manifest_member
          JOIN solver_evidence_artifacts manifest
            ON manifest.id = manifest_member.artifact_id
           AND manifest.result_id = result.id
           AND manifest.result_attempt_id = attempt.id
           AND manifest.kind = 'manifest'
          WHERE manifest_member.archive_id = archive.id
            AND manifest_member.member_path = 'evidence_manifest.json'
        )
        AND EXISTS (
          SELECT 1
          FROM solver_evidence_artifact_members restart_marker
          WHERE restart_marker.archive_id = archive.id
            AND restart_marker.member_path =
              'openfoam/transient/transient_start.json'
        )
        AND NOT EXISTS (
          SELECT required.path
          FROM (VALUES
            ('openfoam/transient/system/controlDict'),
            ('openfoam/transient/system/fvSchemes'),
            ('openfoam/transient/system/fvSolution'),
            ('openfoam/transient/constant/polyMesh/points'),
            ('openfoam/transient/constant/polyMesh/faces'),
            ('openfoam/transient/constant/polyMesh/owner'),
            ('openfoam/transient/constant/polyMesh/neighbour'),
            ('openfoam/transient/constant/polyMesh/boundary')
          ) required(path)
          WHERE NOT EXISTS (
            SELECT 1
            FROM solver_evidence_artifact_members required_member
            WHERE required_member.archive_id = archive.id
              AND required_member.member_path = required.path
          )
        )
        AND (
          (
            implementation.distribution IN ('opencfd', 'legacy')
            AND NOT EXISTS (
              SELECT required.path
              FROM (VALUES
                ('openfoam/transient/constant/transportProperties'),
                ('openfoam/transient/constant/turbulenceProperties')
              ) required(path)
              WHERE NOT EXISTS (
                SELECT 1
                FROM solver_evidence_artifact_members required_member
                WHERE required_member.archive_id = archive.id
                  AND required_member.member_path = required.path
              )
            )
          )
          OR (
            implementation.distribution = 'foundation'
            AND NOT EXISTS (
              SELECT required.path
              FROM (VALUES
                ('openfoam/transient/constant/physicalProperties'),
                ('openfoam/transient/constant/momentumTransport')
              ) required(path)
              WHERE NOT EXISTS (
                SELECT 1
                FROM solver_evidence_artifact_members required_member
                WHERE required_member.archive_id = archive.id
                  AND required_member.member_path = required.path
              )
            )
          )
        )
        AND EXISTS (
          SELECT 1
          FROM solver_evidence_artifact_members velocity
          WHERE velocity.archive_id = archive.id
            AND velocity.member_path ~
              '^time_directories/[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?/U$'
            AND split_part(velocity.member_path, '/', 2)::float8 > 0
            AND NOT EXISTS (
              SELECT required_field.name
              FROM (VALUES ('p'), ('k'), ('omega'), ('nut'), ('phi'))
                required_field(name)
              WHERE NOT EXISTS (
                SELECT 1
                FROM solver_evidence_artifact_members field_member
                WHERE field_member.archive_id = archive.id
                  AND field_member.member_path =
                    regexp_replace(velocity.member_path, '/U$', '') ||
                    '/' || required_field.name
              )
            )
        )
        AND EXISTS (
          SELECT 1
          FROM solver_evidence_artifact_members coefficients
          WHERE coefficients.archive_id = archive.id
            AND coefficients.member_path ~
              '^openfoam/postProcessing/forceCoeffs[^/]*/[^/]+/coefficient[.]dat$'
        )
    )`;
}

export async function hasExactVerifiedRestartableEvidenceArchive(
  tx: EvidenceQueryExecutor,
  resultId: string,
  resultAttemptId: string,
): Promise<boolean> {
  const rows = (await tx.execute(sql`
    SELECT ${exactVerifiedRestartableEvidenceArchiveSql(
      resultId,
      resultAttemptId,
    )} AS valid
  `)) as unknown as Array<{ valid: boolean }>;
  return rows[0]?.valid === true;
}
