// Request/response shapes for the Python CFD solver API, ported from
// src/airfoilfoam/models.py. JSON uses snake_case — keep these field names exact.

import type { PointFidelity, SteadyHistory, UransFidelity } from "./fidelity";
import type { FrameTrack } from "./frame-track";

export type AirfoilFormat = "auto" | "selig" | "lednicer";

export interface AirfoilInput {
  name?: string;
  format?: AirfoilFormat;
  coordinates?: string;
  points?: [number, number][];
}

export interface FluidProperties {
  density?: number;
  dynamic_viscosity?: number;
  kinematic_viscosity?: number;
}

export interface RoughnessParams {
  sand_grain_height?: number;
  roughness_constant?: number;
}

export type TurbulenceModelName =
  | "kOmega"
  | "kOmegaSST"
  | "kOmegaSSTLM"
  | "kEpsilon"
  | "SpalartAllmaras";

export interface TurbulenceParams {
  model?: TurbulenceModelName;
  intensity?: number;
  viscosity_ratio?: number;
}

export interface MeshParams {
  mesher?: string;
  farfield_radius_chords?: number;
  wake_length_chords?: number;
  n_surface?: number;
  n_radial?: number;
  n_wake?: number;
  target_y_plus?: number;
  first_cell_height_chords?: number;
  span_chords?: number;
}

export type ImageFieldName =
  | "velocity_magnitude"
  | "velocity_x"
  | "velocity_y"
  | "pressure"
  | "pressure_coefficient"
  | "vorticity"
  | "turbulent_kinetic_energy"
  | "turbulent_viscosity";

export const ALL_IMAGE_FIELDS: ImageFieldName[] = [
  "velocity_magnitude",
  "velocity_x",
  "velocity_y",
  "pressure",
  "pressure_coefficient",
  "vorticity",
  "turbulent_kinetic_energy",
  "turbulent_viscosity",
];

export interface SolverParams {
  turbulence?: TurbulenceParams;
  n_iterations?: number;
  convergence_tolerance?: number;
  momentum_scheme?: string;
  transient_fallback?: boolean;
  rans_failure_policy?: RansFailurePolicy;
  force_transient?: boolean;
  warm_start?: boolean;
  transient_cycles?: number;
  transient_discard_fraction?: number;
  transient_max_courant?: number;
  transient_auto_refine?: boolean;
  /** URANS fidelity ladder (pinned contract 1, see fidelity.ts): the engine
   *  derives min periods / solver budget / mesh scale from this literal.
   *  Absent = engine defaults (legacy full-fidelity behavior). */
  urans_fidelity?: UransFidelity;
  write_images?: ImageFieldName[];
  image_zoom_chords?: number;
}

export type RansFailurePolicy =
  | "continue"
  | "abort_for_precalc"
  | "replace_precalc";

export interface AoASpec {
  angles?: number[];
  start?: number;
  stop?: number;
  step?: number;
}

export type ResourcePolicy =
  | "auto"
  | "airfoil_parallel"
  | "case_parallel"
  | "exclusive";

export interface ResourceParams {
  cpu_budget?: number | null;
  case_concurrency?: number | null;
  solver_processes?: number | null;
  queue_pressure?: number | null;
  policy?: ResourcePolicy;
}

/** Continuation source (amendment C, 2026-07-08): a prior URANS solve stopped
 *  by the engine's wall-clock budget guard left its case directory saved on
 *  the volume. The engine copies/links that case into the new job and RESUMES
 *  the transient from latestTime (the existing chunk-restart mechanics across
 *  jobs), merging coefficient history via the restart-segment machinery. */
export interface ContinueFrom {
  engine_job_id: string;
  case_slug: string;
}

export interface PolarRequest {
  airfoil: AirfoilInput;
  chord_lengths?: number[];
  speeds?: number[];
  aoa: AoASpec;
  fluid?: FluidProperties;
  roughness?: RoughnessParams;
  mesh?: MeshParams;
  urans_mesh?: MeshParams;
  urans_precalc_mesh?: MeshParams;
  solver?: SolverParams;
  resources?: ResourceParams;
  /** Amendment C: resume from a saved case state instead of a fresh solve. */
  continue_from?: ContinueFrom | null;
  /** Amendment C: increased wall-clock solver budget [s] for the continuation
   *  (+2h/+6h UI choices); replaces the fidelity-derived tier budget. */
  budget_override_s?: number | null;
  /** Required worker mesh-repair strategy for this submission. PRECALC callers
   * set it from a live capability probe; API and worker reject mismatches. */
  expected_mesh_recovery_version?: number | null;
}

export type JobState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Engine worker-boot orphan reconciliation message — pinned byte-for-byte to
 *  `ORPHAN_MESSAGE` in src/airfoilfoam/storage.py. A failed job status/result
 *  carrying exactly this message means "the worker container restarted
 *  mid-solve and the celery task died": an infrastructure interruption, NOT
 *  solver failure evidence. The sweeper matches on this literal to release the
 *  job's unsolved claims for a re-solve instead of terminal-failing them
 *  (incident 2026-07-04: 12 campaign points +3 symmetry mirrors were
 *  terminal-failed with empty error text by a worker restart).
 *  Drift is a test failure on BOTH sides:
 *  - node:   apps/sweeper/test/orphan-message-pin.test.ts
 *  - python: tests/test_orphan_reconcile.py::test_orphan_message_is_pinned_for_node_clients */
export const WORKER_RESTART_ORPHAN_MESSAGE =
  "worker restarted mid-solve; task lost";

export type JobPhase =
  | "pending"
  | "waiting_cpu"
  | "meshing"
  | "solving_rans"
  | "solving_urans"
  | "postprocessing"
  | "ingesting"
  | "completed"
  | "failed"
  | "cancelled";

export interface SchedulingMetadata {
  requested_policy: ResourcePolicy;
  resolved_policy: ResourcePolicy;
  worker_cpu_budget: number;
  resolved_cpu_budget: number;
  resolved_case_concurrency: number;
  solver_processes: number;
  mesh_build_count: number;
  aoa_case_count: number;
  mesh_reuse_mode: "symlink" | "copy";
  queue_depth?: number | null;
}

export interface JobStatus {
  job_id: string;
  state: JobState;
  phase?: JobPhase;
  total_cases: number;
  completed_cases: number;
  message?: string | null;
  task_id?: string | null;
  queued_at?: string | null;
  started_at?: string | null;
  updated_at?: string | null;
  phase_started_at?: string | null;
  last_progress_at?: string | null;
  active_solver?: string | null;
  active_case_slug?: string | null;
  active_aoa_deg?: number | null;
  active_pids?: number[];
  cpu_tokens_waiting?: number;
  cpu_tokens_held?: number;
  scheduling?: SchedulingMetadata | null;
  /** Capability acknowledged by the worker executing this job; absent/null
   * while only queued by the API or when produced by a legacy worker. */
  mesh_recovery_version?: number | null;
  /** Typed terminal failure when execution ended before per-angle attempt
   * evidence existed. Null/absent on non-terminal and legacy jobs. */
  failure_disposition?: FailureDisposition | null;
}

export interface EngineHealth {
  status: string;
  version: string;
  build_id?: string | null;
  package_file?: string | null;
  /** Monotonic engine-side automatic PRECALC mesh-repair strategy. Missing
   * means the legacy strategy (0); malformed/unreachable health is unknown
   * and must never authorize reopening deterministic blockers. */
  mesh_recovery_version?: number;
}

/** GET /cache/stats — disk truth about the engine mesh/seed cache. */
export interface EngineCacheStats {
  mesh_entries: number;
  seed_entries: number;
  total_bytes: number;
  cap_bytes: number;
  oldest_last_used: string | null;
}

export interface EngineStripJobRequest {
  keep_case_state?: boolean;
}

export interface EngineStripJobResponse {
  bytes_freed: number;
  files_removed: number;
  kept_case_state: boolean;
}

export interface EngineDeleteJobResponse {
  bytes_freed: number;
}

export interface EngineMaintenanceJobItem {
  job_id: string;
  mtime_epoch: number;
  bytes: number | null;
}

export interface EngineMaintenanceJobsResponse {
  items: EngineMaintenanceJobItem[];
}

export interface EngineMaintenanceDiskResponse {
  total_bytes: number;
  free_bytes: number;
  used_pct: number;
}

export interface EngineTaskSummary {
  worker: string;
  task_id: string | null;
  name: string | null;
  job_id: string | null;
  redelivered: boolean;
  time_start?: number | null;
}

export interface EngineQueueState {
  queue_depth: number | null;
  active: EngineTaskSummary[];
  reserved: EngineTaskSummary[];
  scheduled: EngineTaskSummary[];
  active_count: number;
  reserved_count: number;
  scheduled_count: number;
  job_ids: string[];
  duplicates: Record<string, number>;
  redelivered: EngineTaskSummary[];
}

export interface JobRuntimeSummary {
  job_id: string;
  exists: boolean;
  cancelled: boolean;
  process_count: number;
  processes?: {
    pid: number;
    command?: string | null;
    cwd?: string | null;
    case_slug?: string | null;
    solver_mode?: string | null;
    elapsed_sec?: number | null;
  }[];
  active_pids?: number[];
  direct_process_count?: number | null;
  heartbeat_process_count?: number | null;
  runtime_heartbeat_at?: string | null;
  runtime_heartbeat_age_sec?: number | null;
  runtime_error?: string | null;
  worker_pid?: number | null;
  runtime_phase?: JobPhase | null;
  runtime_active_solver?: string | null;
  runtime_active_case_slug?: string | null;
  runtime_active_aoa_deg?: number | null;
  runtime_cpu_tokens_waiting?: number | null;
  runtime_cpu_tokens_held?: number | null;
  runtime_current_case?: string | null;
  runtime_last_progress_at?: string | null;
  status_readable: boolean;
  status_error?: string | null;
  status_state?: JobState | null;
  status_phase?: JobPhase | null;
  status_message?: string | null;
  status_total_cases?: number | null;
  status_completed_cases?: number | null;
  status_task_id?: string | null;
  status_queued_at?: string | null;
  status_started_at?: string | null;
  status_updated_at?: string | null;
  status_phase_started_at?: string | null;
  status_last_progress_at?: string | null;
  status_active_solver?: string | null;
  status_active_case_slug?: string | null;
  status_active_aoa_deg?: number | null;
  status_cpu_tokens_waiting?: number | null;
  status_cpu_tokens_held?: number | null;
  result_readable: boolean;
  result_error?: string | null;
  has_result: boolean;
  result_state?: JobState | null;
  result_message?: string | null;
}

export interface JobRuntimeResponse {
  jobs: JobRuntimeSummary[];
}

export interface PolarPoint {
  case_slug?: string | null;
  aoa_deg: number;
  cl?: number | null;
  cd?: number | null;
  cm?: number | null;
  cl_cd?: number | null;
  cl_std?: number | null;
  cd_std?: number | null;
  cm_std?: number | null;
  unsteady: boolean;
  converged: boolean;
  final_residual?: number | null;
  iterations?: number | null;
  y_plus_avg?: number | null;
  y_plus_max?: number | null;
  n_cells?: number | null;
  first_order_fallback: boolean;
  images: Record<string, string>;
  strouhal?: number | null;
  video?: Record<string, string>;
  mean_images?: Record<string, string>;
  force_history?: EngineForceHistory | null;
  /** URANS recording contract (task #23/#24): period-locked frame track with
   *  time-weighted stats. `null` on steady/no-shedding points; absent on
   *  legacy engine versions that predate the contract. */
  frame_track?: FrameTrack | null;
  /** Fidelity ladder echo (pinned contract 1): the tier this point was solved
   *  at. Absent on legacy engine versions that predate the ladder. */
  fidelity?: PointFidelity | null;
  /** Oscillating-averaged steady solve evidence (pinned contract 2): shipped
   *  whenever the steady solve used oscillating-averaging; null for classic
   *  pointwise convergence; absent on legacy engine versions. */
  steady_history?: SteadyHistory | null;
  quality_warnings?: string[];
  evidence_artifacts?: EngineEvidenceArtifact[];
  /** Machine-readable rejection provenance. Only `hard_solver` represents
   * aerodynamic/numerical evidence eligible for conditional whole-polar URANS;
   * mesh and infrastructure failures remain repair/retry work. Optional for
   * compatibility with stored results from pre-contract engine builds. */
  failure_disposition?: FailureDisposition;
  error?: string | null;
}

export type FailureDisposition =
  | "none"
  | "hard_solver"
  | "deterministic_mesh"
  | "infrastructure";

export interface EngineEvidenceArtifact {
  kind: string;
  path: string;
  url?: string | null;
  mime_type: string;
  sha256: string;
  byte_size: number;
  role?: string | null;
  field?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RenderFieldRequest {
  case_slug: string;
  evidence_base: string;
  airfoil_points: [number, number][];
  chord: number;
  speed: number;
  field: ImageFieldName;
  role: "instantaneous" | "mean";
  zoom_chords?: number;
  colormap?: string | null;
  levels?: number;
  vmin?: number | null;
  vmax?: number | null;
  frame_index?: number | null;
  width_px?: number;
  height_px?: number;
  params_hash?: string | null;
}

export interface FieldExtentsRequest {
  case_slug: string;
  evidence_base: string;
  airfoil_points: [number, number][];
  chord: number;
  speed: number;
  fields?: ImageFieldName[];
  zoom_chords?: number;
  max_frames?: number | null;
}

export interface FieldExtent {
  min: number;
  max: number;
  finite_count: number;
}

export interface FieldExtentsResponse {
  fields: Partial<Record<ImageFieldName, FieldExtent>>;
  window_start?: number | null;
  window_end?: number | null;
}

export interface FieldScaleRequest {
  vmin: number;
  vmax: number;
}

export interface RenderDefaultMediaRequest {
  case_slug: string;
  evidence_base: string;
  airfoil_points: [number, number][];
  chord: number;
  speed: number;
  fields?: ImageFieldName[];
  scales: Partial<Record<ImageFieldName, FieldScaleRequest>>;
  unsteady?: boolean;
  zoom_chords?: number;
  scale_version?: number;
  render_profile_key?: string;
}

export interface RenderedDefaultMedia {
  kind: "image" | "video";
  field: ImageFieldName;
  role: "instantaneous" | "mean";
  path: string;
  url: string;
  mime_type: string;
  sha256: string;
  byte_size: number;
}

export interface RenderDefaultMediaResponse {
  images: RenderedDefaultMedia[];
  mean_images: RenderedDefaultMedia[];
  videos: RenderedDefaultMedia[];
  window_start?: number | null;
  window_end?: number | null;
  scale_version: number;
  render_profile_key: string;
}

export interface RenderFieldResponse {
  kind: "image";
  field: ImageFieldName;
  role: "instantaneous" | "mean";
  path: string;
  url: string;
  mime_type: string;
  sha256: string;
  byte_size: number;
  params_hash: string;
}

export interface EngineForceHistory {
  t: number[];
  cl: number[];
  cd: number[];
  cm: number[];
  shedding_freq_hz?: number | null;
  samples?: number | null;
  period_s?: number | null;
  retained_cycles?: number | null;
  window_start?: number | null;
  window_end?: number | null;
}

export interface Polar {
  speed: number;
  chord: number;
  reynolds: number;
  mach?: number | null;
  points: PolarPoint[];
  attempts?: PolarPoint[];
  rans_precalc_promotion?: RansPrecalcPromotion | null;
}

export interface RansPrecalcPromotion {
  trigger_aoa_deg: number;
  failure_disposition: "hard_solver";
  attempted_aoas: number[];
  intentionally_omitted_aoas: number[];
}

export interface JobResult {
  job_id: string;
  state: JobState;
  polars: Polar[];
  message?: string | null;
  scheduling?: SchedulingMetadata | null;
  /** Capability acknowledged by the worker that produced this result. */
  mesh_recovery_version?: number | null;
  /** Typed terminal failure when execution ended before per-angle attempt
   * evidence existed. Null/absent on non-terminal and legacy results. */
  failure_disposition?: FailureDisposition | null;
}
