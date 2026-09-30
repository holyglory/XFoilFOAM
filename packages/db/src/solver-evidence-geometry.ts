import { sql } from "drizzle-orm";
import type { Point } from "@aerodb/core";
import type { DB } from "./client";
import {
  geometryRequiresPreservation,
  progressiveEvidencePreservesGeometry,
} from "./progressive-evidence-geometry";
import type { AnalysisPhysical } from "./analysis-target";

export interface SolverGeometryEvidence {
  attemptId: string;
  source: string;
  meshRecoveryVersion: unknown;
}

export async function solverGeometryCompatibility(
  db: DB,
  airfoilId: string,
  points: readonly Point[],
  evidence: readonly SolverGeometryEvidence[],
): Promise<Map<string, boolean>> {
  let geometry: AnalysisPhysical["geometry"];
  let finiteEdge: boolean;
  try {
    geometry = points.map((point) => [point.x, point.y]);
    finiteEdge = geometryRequiresPreservation(geometry);
  } catch {
    return new Map(evidence.map((item) => [item.attemptId, false]));
  }
  const compatibility = new Map<string, boolean>();
  const contractCompatibility = new Map<unknown, boolean>();
  const unresolved = new Map<string, SolverGeometryEvidence>();
  for (const item of evidence) {
    try {
      if (!contractCompatibility.has(item.meshRecoveryVersion))
        contractCompatibility.set(
          item.meshRecoveryVersion,
          progressiveEvidencePreservesGeometry(
            { geometry },
            { mesh_recovery_version: item.meshRecoveryVersion },
          ),
        );
      const compatible =
        item.source !== "solved" ||
        contractCompatibility.get(item.meshRecoveryVersion) === true;
      compatibility.set(item.attemptId, compatible);
      if (item.source === "solved" && compatible && !finiteEdge)
        unresolved.set(item.attemptId, item);
    } catch {
      compatibility.set(item.attemptId, false);
    }
  }
  if (!unresolved.size) return compatibility;
  const attemptIds = [...unresolved.keys()];
  const targets = await db.execute(sql`
    SELECT DISTINCT receipt.result_attempt_id, target.airfoil_id, target.physical->'geometry' AS geometry
    FROM progressive_cfd_evidence receipt
    JOIN progressive_cfd_attempts dispatch ON dispatch.token = receipt.attempt_token
    JOIN progressive_cfd_units unit ON unit.id = dispatch.unit_id
    JOIN progressive_work work ON work.id = unit.work_id
    JOIN polar_analysis_targets target ON target.id = work.target_id
    WHERE receipt.result_attempt_id IN (${sql.join(
      attemptIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
  `);
  for (const target of targets) {
    const attemptId = String(target.result_attempt_id);
    const item = unresolved.get(attemptId);
    if (!item) continue;
    try {
      const compatible =
        target.airfoil_id === airfoilId &&
        progressiveEvidencePreservesGeometry(
          { geometry: target.geometry as AnalysisPhysical["geometry"] },
          { mesh_recovery_version: item.meshRecoveryVersion },
        );
      if (!compatible) compatibility.set(attemptId, false);
    } catch {
      compatibility.set(attemptId, false);
    }
  }
  return compatibility;
}
