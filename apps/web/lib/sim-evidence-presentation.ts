import type { PointFidelityTier, SimRegime } from "@aerodb/core";

export interface SimEvidencePresentationInput {
  fidelity: PointFidelityTier | null | undefined;
  regime: SimRegime | null | undefined;
  turbulenceModel?: string | null;
  transportActive?: boolean;
  hasRecordedFrames?: boolean;
}

export interface SimEvidencePresentation {
  method: "RANS" | "URANS";
  methodChip: string;
  mediaTag: string;
  provenance: string;
  historyTitle: string;
  historyText: string;
}

/** Keep numerical method independent from the measured physical outcome. */
export function simEvidencePresentation({
  fidelity,
  regime,
  turbulenceModel,
  transportActive = false,
  hasRecordedFrames = false,
}: SimEvidencePresentationInput): SimEvidencePresentation {
  const method: "RANS" | "URANS" =
    fidelity === "urans_precalc" ||
    fidelity === "urans_full" ||
    (fidelity == null && regime === "stalled")
      ? "URANS"
      : "RANS";
  const shedding = regime === "stalled";
  const tier =
    fidelity === "urans_precalc"
      ? "URANS fast"
      : fidelity === "urans_full"
        ? "URANS final"
        : method;
  const model = turbulenceModel?.trim() || "solver";

  if (method === "RANS") {
    return {
      method,
      methodChip: shedding ? "RANS · stalled" : "RANS · steady",
      mediaTag: shedding ? "RANS · stalled static" : "RANS · steady static",
      provenance: shedding
        ? `RANS ${model} · stalled-flow screening evidence · stored media/evidence only`
        : `RANS ${model} · steady result evidence · stored media/evidence only`,
      historyTitle: shedding
        ? "Stalled-flow coefficients recorded"
        : "Final coefficients recorded",
      historyText: shedding
        ? "This stalled-flow RANS screening solve records its final coefficients and convergence summary, not an iteration-by-iteration coefficient series."
        : "This pointwise-converged RANS solve records its final coefficients and convergence summary, not an iteration-by-iteration coefficient series.",
    };
  }

  return {
    method,
    methodChip: shedding
      ? "URANS · vortex shedding"
      : "URANS · steady (no shedding)",
    mediaTag: transportActive
      ? `RECORDED FRAMES · ${tier}`
      : shedding
        ? `${tier} · mean static`
        : `${tier} · steady static`,
    provenance: shedding
      ? `${tier} ${model} · ${
          hasRecordedFrames
            ? "engine-recorded period-locked frame evidence"
            : "periodic result evidence · recorded frames unavailable"
        } · stored media/evidence only`
      : `${tier} ${model} · steady/no-shedding result evidence · stored media/evidence only`,
    historyTitle: shedding
      ? "Recorded frame series unavailable"
      : "Steady/no-shedding coefficients recorded",
    historyText: shedding
      ? `This ${tier} solve records final coefficients, but its period-locked frame series is unavailable.`
      : `This ${tier} solve certified a steady, no-shedding outcome and records its final coefficients and convergence summary, not an iteration-by-iteration coefficient series.`,
  };
}
