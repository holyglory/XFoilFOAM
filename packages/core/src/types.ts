import type { ViscosityModelName } from "./viscosity";

// ============================ geometry ============================
export interface Point {
  x: number;
  y: number;
}

/** NACA 4-digit parameters, all as fractions of chord. */
export interface NacaParams {
  t: number; // max thickness
  m: number; // max camber
  p: number; // position of max camber
}

export interface AirfoilGeometry {
  contour: Point[]; // closed loop, upper TE→LE then lower LE→TE (Selig order)
  camber: Point[]; // camber line LE→TE
  thicknessPct: number;
  thicknessXPct: number;
  camberPct: number;
  camberXPct: number;
  leRadiusPct: number;
  teThicknessPct: number;
  areaProfile: number;
  areaUpper: number;
  areaLower: number;
  areaCamber: number;
  areaUpperPositive: number;
  areaUpperNegative: number;
  areaLowerPositive: number;
  areaLowerNegative: number;
  areaCamberPositive: number;
  areaCamberNegative: number;
}

// ============================ polars ============================
export type DataSource = "queued" | "solved";
export type ResultRegime = "rans" | "urans";
export type ResultClassificationState = "accepted" | "needs_urans" | "superseded_by_urans" | "rejected";
export type ResultClassificationRegion = "attached" | "near_stall" | "post_stall" | "unknown";
export type PolarFitStatus = "final" | "provisional" | "insufficient";

export interface PolarFitPoint {
  a: number;
  cl: number;
  cd: number;
  cm: number;
  ld: number;
}

export interface PolarFitMetrics {
  ldmax: number;
  aLd: number;
  cdmin: number;
  clCd: number;
  cd0: number;
  clmax: number;
  aStall: number;
  cm0: number;
  /** Refinement fine target (spec §8): LOWESS-evaluated L/D argmax, 0.01°. */
  alphaLdmaxFine: number;
  /** Refinement fine target (spec §8): LOWESS-evaluated Cl root, 0.01°; null
   *  when Cl never crosses zero in the evidence range. */
  alphaClZeroFine: number | null;
}

export interface PolarFit {
  status: PolarFitStatus;
  confidence: number;
  metrics: PolarFitMetrics | null;
  points: PolarFitPoint[];
  acceptedPointCount: number;
  provisionalPointCount: number;
  rejectedPointCount: number;
  evidenceSignature?: string;
}

/** A single polar point. Superset of the design's {a,cl,cd,cm,ld,stalled} plus
 *  real-CFD provenance carried on assembled API polars. */
export interface PolarPointData {
  a: number; // angle of attack [deg]
  cl: number;
  cd: number;
  cm: number;
  ld: number; // cl/cd
  stalled: boolean; // post-stall → URANS (drives the red point outline)
  source?: DataSource;
  unsteady?: boolean;
  converged?: boolean;
  clStd?: number | null;
  cdStd?: number | null;
  cmStd?: number | null;
  resultId?: string | null;
  classificationState?: ResultClassificationState;
  classificationRegion?: ResultClassificationRegion;
  classificationReasons?: string[];
  classificationConfidence?: number | null;
}

export interface Polar {
  re: number;
  mach?: number;
  color: string;
  source: DataSource;
  points: PolarPointData[];
  fit?: PolarFit | null;
}

export interface PolarMetrics {
  ldmax: number;
  aLd: number;
  cdmin: number;
  clCd: number;
  cd0: number;
  clmax: number;
  aStall: number;
  cm0: number;
}

// ============================ chart projection ============================
export type ChartType = "cla" | "clcd" | "lda" | "cma";

export interface ChartTick {
  /** pixel position along the relevant axis */
  pos: number;
  /** baseline for y labels (pos + 3); equals pos for x */
  labelPos: number;
  label: string;
}

export interface ChartCurve {
  re: number;
  color: string;
  dash: string;
  width: number;
  opacity: number;
  points: string; // SVG polyline points
  label: string;
  kind?: "measured" | "fit";
}

export interface ChartPointVM {
  cx: number;
  cy: number;
  r: number;
  fill: string;
  stroke: string;
  sw: number;
  re: number;
  label: string;
  stalled: boolean;
  key: string;
  point: PolarPointData;
}

export interface ChartProjection {
  curves: ChartCurve[];
  points: ChartPointVM[];
  xTicks: ChartTick[];
  yTicks: ChartTick[];
  xTitle: string;
  yTitle: string;
  domain: { xMin: number; xMax: number; yMin: number; yMax: number };
}

// ============================ API payloads ============================
export interface Breadcrumb {
  db: string;
  family: string;
  name: string;
}

export interface AirfoilSummary {
  id: string;
  slug: string;
  name: string;
  categoryId: string;
  categorySlug: string;
  categoryPath: string;
  family: string;
  tags: string[];
  hashtags: HashtagDTO[];
  points: Point[]; // contour, for the row glyph

  thicknessPct: number;
  areaProfile: number;
  areaUpper: number;
  areaLower: number;
  areaCamber: number;
  areaUpperPositive: number;
  areaUpperNegative: number;
  areaLowerPositive: number;
  areaLowerNegative: number;
  areaCamberPositive: number;
  areaCamberNegative: number;
  camberPct: number;
  camberPosPct: number;
  reMin: number;
  reMax: number;
  polarCount: number;
  ldmax: number | null;
  clmax: number | null;
  cdmin: number | null;
  metricsSource: DataSource;
  fitStatus?: PolarFitStatus | null;
  fitConfidence?: number | null;
}

export interface AirfoilDetailPayload {
  id: string;
  slug: string;
  name: string;
  categoryId: string;
  categorySlug: string;
  categoryPath: string;
  family: string;
  subtitle: string;
  tags: string[];
  hashtags: HashtagDTO[];
  breadcrumb: Breadcrumb;
  geometry: AirfoilGeometry;
  mach: number;
  reList: number[];
  polars: Polar[]; // one per Re in reList; Detail carries solved CFD points only
  simulationWorks: SimulationWorkItem[];
  downloads: Record<string, string | null>;
}

export interface CategoryNode {
  id: string;
  slug: string;
  name: string;
  path: string;
  depth: number;
  directAirfoilCount: number;
  airfoilCount: number;
  children: CategoryNode[];
}

export interface HashtagDTO {
  id: string;
  slug: string;
  name: string;
}

export interface ViscosityTablePointDTO {
  temperatureK: number;
  dynamicViscosity: number;
  sortOrder: number;
}

export interface MediumDTO {
  id: string;
  slug: string;
  name: string;
  phase: "gas" | "liquid";
  density: number;
  refTemperatureK: number;
  refPressurePa: number;
  viscosityModel: ViscosityModelName;
  constantDynamicViscosity: number | null;
  sutherlandMuRef: number | null;
  sutherlandTRef: number | null;
  sutherlandS: number | null;
  viscosityTable: ViscosityTablePointDTO[];
  dynamicViscosity: number;
  kinematicViscosity: number;
  speedOfSound: number | null;
  notes: string | null;
  isSeeded: boolean;
}

export type CpuSchedulingPolicy = "auto" | "airfoil_parallel" | "case_parallel" | "exclusive";

export interface BoundaryConditionDTO {
  id: string;
  slug: string;
  name: string;
  mediumId: string;
  mediumSlug: string;
  mediumName: string;
  temperatureK: number;
  pressurePa: number;
  speedMps: number;
  reynolds: number;
  referenceChordM: number;
  density: number;
  dynamicViscosity: number;
  kinematicViscosity: number;
  turbulenceModel: string;
  turbulenceIntensity: number;
  viscosityRatio: number;
  mach: number | null;
  aoaStart: number;
  aoaStop: number;
  aoaStep: number;
  aoaList: number[] | null;
  schedulingPolicy: CpuSchedulingPolicy;
  cpuBudget: number | null;
  caseConcurrency: number | null;
  solverProcesses: number | null;
  enabled: boolean;
}

// ============================ simulation modal ============================
export type SimStatus = "solved" | "queued" | "running";
export type SimRegime = "attached" | "stalled";
export type FieldId =
  | "velocity_magnitude"
  | "velocity_x"
  | "velocity_y"
  | "pressure"
  | "pressure_coefficient"
  | "vorticity"
  | "turbulent_kinetic_energy"
  | "turbulent_viscosity";

export interface SimulationWorkItem {
  id: string;
  kind: "rans-sweep" | "urans-retry";
  status: string;
  wave: number;
  engineState: string | null;
  engineJobId: string | null;
  retryMode: string | null;
  setupName: string | null;
  aoas: number[];
  aoaMin: number | null;
  aoaMax: number | null;
  totalCases: number;
  completedCases: number;
  solvedCount: number;
  pendingCount: number;
  failedCount: number;
  acceptedRansCount: number;
  rejectedRansCount: number;
  uransAttemptCount: number;
  reynolds: number | null;
  mach: number | null;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

export interface FieldMedia {
  kind: "image" | "video";
  url: string;
  meanUrl?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  field?: FieldId;
  scale?: {
    mode: "track";
    vmin: number;
    vmax: number;
    policy: string;
    version: number;
    status?: "active" | "rebalancing" | "failed" | null;
  } | null;
}

export interface EvidenceArtifactDTO {
  id: string;
  kind: string;
  field?: string | null;
  role?: string | null;
  url: string;
  downloadUrl: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  metadata: Record<string, unknown>;
}

export interface FieldTrackPoint {
  resultId: string;
  aoa: number;
  re: number;
  mach: number | null;
  regime: "rans" | "urans" | null;
  fields: FieldId[];
}

export interface ForceHistory {
  t: number[];
  cl: number[];
  cd: number[];
}

export interface SimulationDetail {
  status: SimStatus;
  regime: SimRegime;
  airfoilName: string;
  alpha: number;
  re: number;
  mach: number;
  cl: number;
  cd: number;
  cm: number;
  ld: number;
  clStd?: number | null;
  cdStd?: number | null;
  strouhal?: number | null;
  media: Partial<Record<FieldId, FieldMedia>> | null;
  availableFields: FieldId[];
  evidenceArtifacts?: EvidenceArtifactDTO[];
  history: ForceHistory | null;
  condition?: {
    boundaryConditionName: string;
    mediumName: string;
    speedMps: number;
    referenceChordM: number;
    temperatureK: number;
    pressurePa: number;
    density?: number;
    dynamicViscosity?: number;
    kinematicViscosity?: number;
    turbulenceModel: string;
    turbulenceIntensity: number;
    viscosityRatio: number;
    mesh?: {
      mesher: string;
      farfieldRadiusChords: number;
      wakeLengthChords: number;
      nSurface: number;
      nRadial: number;
      nWake: number;
      targetYPlus: number;
      spanChords: number;
      nCells?: number | null;
      yPlusAvg?: number | null;
      yPlusMax?: number | null;
      iterations?: number | null;
      finalResidual?: number | null;
    } | null;
  } | null;
  jobId?: string | null;
  progress?: { done: number; total: number } | null;
}
