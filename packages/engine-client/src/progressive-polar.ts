export type ProgressiveCoefficientVector = [number, number, number];
export type ProgressiveCfdMethod = "openfoam_fast" | "openfoam_precise";

export interface ProgressivePolarPrior {
  target_signature: string;
  prediction_id: string;
  branch: string;
  alpha: number[];
  coefficients: ProgressiveCoefficientVector[];
  standard_deviation: ProgressiveCoefficientVector[];
  provenance: Record<string, unknown>;
}

export interface ProgressivePolarObservation {
  observation_id: string;
  result_id: string;
  attempt_id: string;
  lineage_id: string;
  target_signature: string;
  branch: string;
  method: ProgressiveCfdMethod;
  alpha: number;
  coefficients: ProgressiveCoefficientVector | null;
  standard_error: ProgressiveCoefficientVector | null;
  eligible: boolean;
  numerical_convergence: string;
  statistical_certification: string;
  exclusion_reason?: string | null;
  window?: [number, number] | null;
}

export interface ProgressivePolarHistory {
  observation: ProgressivePolarObservation;
  artifact_sha256: string;
  coordinate_kind: "physical_time" | "iteration";
  coordinate: number[];
  coefficients: ProgressiveCoefficientVector[];
  informative_start: number;
  correlation_time: number | null;
  correlation_evidence_id: string | null;
}

export interface ProgressivePolarModelPolicy {
  policy_id: string;
  fast_discrepancy_std: ProgressiveCoefficientVector;
  precise_discrepancy_std: ProgressiveCoefficientVector;
  slope_std: ProgressiveCoefficientVector;
  local_std: ProgressiveCoefficientVector;
  fast_noise_floor: ProgressiveCoefficientVector;
  precise_noise_floor: ProgressiveCoefficientVector;
  correlation_length_deg: number;
  lineage_correlation: number;
  calibration_status: "unvalidated" | "validated";
  validation_id?: string | null;
}

export interface ProgressivePolarFitRequest {
  epoch_id: string;
  lease_token: string;
  prior: ProgressivePolarPrior;
  observations: ProgressivePolarObservation[];
  histories: ProgressivePolarHistory[];
  history_policy: {
    block_duration: number;
    minimum_samples: number;
    maximum_blocks?: number;
    noise_floor: ProgressiveCoefficientVector;
  } | null;
  policy: ProgressivePolarModelPolicy;
}

export interface ProgressivePolarEstimate {
  version: string;
  signature: string;
  kind: "estimate";
  target_signature: string;
  branch: string;
  alpha: number[];
  prior_prediction_id: string;
  policy_id: string;
  calibration_status: "unvalidated" | "validated";
  validation_id: string | null;
  interval: {
    probability: number;
    interpretation: "conditional_model_uncertainty";
  };
  curves: Partial<Record<ProgressiveCfdMethod, ProgressivePolarCurve>> & {
    composite: ProgressivePolarCurve;
  };
  best_method: "neuralfoil" | ProgressiveCfdMethod;
  contributors: Array<
    Pick<
      ProgressivePolarObservation,
      | "observation_id"
      | "result_id"
      | "attempt_id"
      | "method"
      | "window"
      | "numerical_convergence"
      | "statistical_certification"
    >
  >;
  excluded: Array<{ observation_id: string; reason: string }>;
  diagnostics: Array<{
    coefficient: string;
    disagreement_variance_multiplier: number;
  }>;
  acquisition: {
    version: "fixed-posterior-coverage-v1";
    method: "openfoam_fast";
    status: "available" | "no_eligible_cfd";
    noise_assumption: "policy_floor_or_median_fast_observation";
    prospective_noise_std: ProgressiveCoefficientVector | null;
    candidates: Array<{
      alpha: number;
      integrated_variance_reduction_fraction: number;
      covariance_reduction_fraction: ProgressiveCoefficientVector;
      coverage_reduction_fraction: ProgressiveCoefficientVector;
    }>;
  };
}

export interface ProgressivePolarCurve {
  coefficients: ProgressiveCoefficientVector[];
  lower: ProgressiveCoefficientVector[];
  upper: ProgressiveCoefficientVector[];
}

export interface ProgressivePolarFitResponse {
  epoch_id: string;
  lease_token: string;
  request_signature: string;
  estimate: ProgressivePolarEstimate;
}
