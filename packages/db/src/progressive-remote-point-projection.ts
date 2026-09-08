import type { resolveProgressiveRemoteEvidence } from "./progressive-remote-evidence";
import {
  failedForPoint,
  fidelityForPoint,
  frameTrackForPoint,
  qualityWarningsForPoint,
  solverRegimeForPoint,
  solverPointEvidencePayload,
  stalledForPoint,
  steadyHistoryForPoint,
} from "../../engine-client/src";

export function progressiveRemotePointProjection(
  source: NonNullable<
    Awaited<ReturnType<typeof resolveProgressiveRemoteEvidence>>
  >,
) {
  const { point, polar, report, envelope } = source;
  const context = `progressive remote ${report.executionId}/${point.case_slug ?? "unidentified-case"}/${point.aoa_deg}`;
  const transient =
    typeof envelope.request.solver?.force_transient === "boolean"
      ? envelope.request.solver.force_transient
      : ["pimpleFoam", "rhoPimpleFoam", "rhoCentralFoam"].includes(
          envelope.request.solver?.flow_solver_family ?? "",
        );
  const fidelity = fidelityForPoint(
    point,
    transient ? envelope.request.solver?.urans_fidelity : undefined,
    context,
  );
  const frameTrack = frameTrackForPoint(point, context);
  const steadyHistory = steadyHistoryForPoint(point, context);
  const qualityWarnings = qualityWarningsForPoint(point);
  const failed = failedForPoint(point);
  const rawHistory = point.force_history;
  return {
    aoaDeg: point.aoa_deg,
    status: failed ? ("failed" as const) : ("done" as const),
    source: failed ? ("queued" as const) : ("solved" as const),
    regime: solverRegimeForPoint(point, fidelity, context),
    fidelity,
    reynolds: polar.reynolds,
    speed: polar.speed,
    chord: polar.chord,
    mach: polar.mach ?? null,
    cl: point.cl ?? null,
    cd: point.cd ?? null,
    cm: point.cm ?? null,
    clCd: point.cl_cd ?? null,
    clStd: point.cl_std ?? null,
    cdStd: point.cd_std ?? null,
    cmStd: point.cm_std ?? null,
    stalled: stalledForPoint(point),
    unsteady: point.unsteady,
    converged: point.converged,
    finalResidual: point.final_residual ?? null,
    iterations: point.iterations ?? null,
    yPlusAvg: point.y_plus_avg ?? null,
    yPlusMax: point.y_plus_max ?? null,
    nCells: point.n_cells ?? null,
    firstOrderFallback: point.first_order_fallback,
    strouhal: point.strouhal ?? null,
    error: point.error ?? null,
    qualityWarnings,
    frameTrack: frameTrack as Record<string, unknown> | null,
    steadyHistory: steadyHistory as Record<string, unknown> | null,
    methodKey: point.method_key ?? null,
    engine: point.engine ?? report.result!.engine ?? null,
    engineJobId: report.executionId,
    engineCaseSlug: point.case_slug ?? null,
    evidencePayload: solverPointEvidencePayload(point, {
      fidelity,
      frameTrack,
      steadyHistory,
      meshRecoveryVersion: report.result!.mesh_recovery_version,
    }),
    forceHistory: rawHistory
      ? {
          t: rawHistory.t,
          cl: rawHistory.cl,
          cd: rawHistory.cd,
          cm: rawHistory.cm ?? null,
          clMean: point.cl ?? null,
          clRms: point.cl_std ?? null,
          cdMean: point.cd ?? null,
          cdRms: point.cd_std ?? null,
          strouhal: point.strouhal ?? null,
          sheddingFreqHz: rawHistory.shedding_freq_hz ?? null,
          sampleCount: rawHistory.samples ?? null,
        }
      : undefined,
  };
}
