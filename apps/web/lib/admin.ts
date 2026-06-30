import type {
  BoundaryConditionDTO,
  CategoryNode,
  HashtagDTO,
  MediumDTO,
  ViscosityModelName,
  ViscosityTablePointDTO,
} from "@aerodb/core";

const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

async function aj<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(BASE + path, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error || `request failed (${res.status})`);
  }
  return res.json();
}

export interface AdminMe {
  authed: boolean;
  mode: "dev" | "prod";
  email: string | null;
  provider?: "password" | "google" | null;
  providers?: {
    google: boolean;
    password: boolean;
  };
  google?: {
    enabled: boolean;
    allowedDomain: string;
    loginUrl: string;
  };
}
export interface SweeperState {
  enabled: boolean;
  maxConcurrentJobs: number;
  pollIntervalMs: number;
  submitIntervalMs: number;
  heartbeatAt: string | null;
}
export interface AdminJob {
  id: string;
  status: string;
  wave: number;
  kind: "sweep-rans" | "point-rans" | "point-urans";
  engineJobId: string | null;
  engineState: string | null;
  totalCases: number;
  completedCases: number;
  airfoilName: string | null;
  airfoilSlug: string | null;
  bcName: string | null;
  bcSlug: string | null;
  mediumName: string | null;
  mediumSlug: string | null;
  reynolds: number | null;
  mach: number | null;
  speedMps: number | null;
  referenceChordM: number | null;
  temperatureK: number | null;
  pressurePa: number | null;
  turbulenceModel: string | null;
  turbulenceIntensity: number | null;
  viscosityRatio: number | null;
  schedulingPolicy: string;
  cpuBudget: number | null;
  caseConcurrency: number | null;
  solverProcesses: number | null;
  workerCpuBudget: number | null;
  meshBuildCount: number | null;
  aoaCaseCount: number | null;
  error: string | null;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
  pendingAgeSec: number;
  stale: boolean;
  engineQueueMatch: boolean;
  runtimeState: string;
  staleReason: string | null;
  processCount: number;
  resultReady: boolean;
  statusReadError: string | null;
  resultReadError: string | null;
  processes: {
    pid: number;
    command?: string | null;
    cwd?: string | null;
    case_slug?: string | null;
    solver_mode?: string | null;
    elapsed_sec?: number | null;
  }[];
  activePids: number[];
  phase: string | null;
  phaseStartedAt: string | null;
  lastProgressAt: string | null;
  activeSolver: string | null;
  activeCaseSlug: string | null;
  activeAoaDeg: number | null;
  cpuTokensWaiting: number | null;
  cpuTokensHeld: number | null;
  resultCount: number;
  solvedCount: number;
  failedCount: number;
  aoaMin: number | null;
  aoaMax: number | null;
  clMax: number | null;
  cdMin: number | null;
  ldMax: number | null;
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

export interface AdminPendingSweep {
  airfoilId: string;
  airfoilSlug: string;
  airfoilName: string;
  categoryName: string;
  categoryPath: string;
  bcId: string;
  bcSlug: string;
  bcName: string;
  mediumSlug: string;
  mediumName: string;
  reynolds: number;
  mach: number | null;
  speedMps: number;
  referenceChordM: number;
  temperatureK: number;
  pressurePa: number;
  turbulenceModel: string;
  turbulenceIntensity: number;
  viscosityRatio: number;
  schedulingPolicy: string;
  cpuBudget: number | null;
  caseConcurrency: number | null;
  solverProcesses: number | null;
  aoaCount: number;
  aoaMin: number;
  aoaMax: number;
  aoas: number[];
  status: string;
  priority: number;
  kind: "sweep-rans" | "point-rans" | "point-urans";
  requestedAt: string | null;
}
export interface AdminExternalPromise {
  id: string;
  sourceInstanceId: string | null;
  sourceInstanceName: string | null;
  status: string;
  expiresAt: string | null;
  createdAt: string | null;
  airfoilSlug: string;
  airfoilName: string;
  reynolds: number;
  mach: number | null;
  aoaCount: number;
  aoaMin: number;
  aoaMax: number;
}
export interface AdminQueue {
  mode: "dev" | "prod";
  engineUrl: string;
  sweeper: SweeperState;
  backlog: number;
  inFlight: number;
  results: Record<string, number>;
  pendingPointsTotal: number;
  pendingSweepsTotal: number;
  pendingSweeps: AdminPendingSweep[];
  externalPromises: AdminExternalPromise[];
  engineQueue: EngineQueueState | null;
  engineQueueError: string | null;
  engineHealth: {
    status: string;
    version: string;
    build_id?: string | null;
    package_file?: string | null;
  } | null;
  engineHealthError: string | null;
  engineExpectedBuildId: string | null;
  engineBuildMismatch: boolean;
  activeJobs: AdminJob[];
  finishedJobs: AdminJob[];
  jobs: AdminJob[];
}

export type SyncDataType =
  | "sweeps"
  | "airfoils"
  | "catalog_metadata"
  | "mediums"
  | "simulation_setup"
  | "polars"
  | "evidence_artifacts"
  | "result_media";
export interface AdminSyncPermission {
  dataType: SyncDataType;
  canFetch: boolean;
  canPush: boolean;
}
export interface AdminSyncConflict {
  id: string;
  dataType: SyncDataType;
  naturalKey: string;
  sourceInstanceId: string | null;
  sourceInstanceName: string | null;
  incomingPayload: Record<string, unknown>;
  localSnapshot: Record<string, unknown> | null;
  artifactManifest: Record<string, unknown> | null;
  createdAt: string | null;
}
export interface AdminRegisteredSolver {
  id: string;
  instanceId: string;
  instanceName: string;
  publicEndpoint: string | null;
  localEndpoint: string | null;
  cpuCapacity: number;
  cpuBudget: number;
  buildVersion: string | null;
  status: string;
  lastHeartbeatAt: string | null;
  activePromiseCount: number;
  activeAoaCount: number;
  solvedCount: number;
  pushedCount: number;
  recentError: string | null;
  updatedAt: string | null;
}
export interface AdminSyncState {
  settings: {
    enabled: boolean;
    instanceId: string;
    instanceName: string;
    publicEndpointOverride: string | null;
    publicEndpoint: string;
    secret: string;
    defaultPromiseTtlHours: number;
    upstreamBaseUrl: string | null;
    upstreamSecret: string | null;
    syncMode: "full" | "db_only_remote_assets";
    remoteSolverEnabled: boolean;
    remoteSolverCpuBudget: number;
    remoteSolverClaimSize: number;
    remoteSolverHeartbeatIntervalSeconds: number;
    remoteSolverRegisteredId: string | null;
    remoteSolverLastSyncAt: string | null;
    remoteSolverLastPromiseAt: string | null;
    remoteSolverLastPushAt: string | null;
    remoteSolverLastStatus: string;
    remoteSolverLastError: string | null;
  };
  permissions: AdminSyncPermission[];
  promises: {
    byStatus: Record<string, number>;
    pointsByStatus: Record<string, number>;
  };
  registeredSolvers: AdminRegisteredSolver[];
  remoteAssets: {
    byAvailability: Record<string, number>;
  };
  conflicts: AdminSyncConflict[];
}

export const adminMe = () => aj<AdminMe>("/api/admin/me");
export const adminLogin = (email: string, password: string) =>
  aj<{ ok: boolean }>("/api/admin/login", { method: "POST", body: JSON.stringify({ email, password }) });
export const adminGoogleLoginUrl = (returnTo = "/admin") =>
  `${BASE}/api/admin/oauth/google?returnTo=${encodeURIComponent(returnTo)}`;
export const adminLogout = () => aj<{ ok: boolean }>("/api/admin/logout", { method: "POST" });
export const getAdminQueue = () => aj<AdminQueue>("/api/admin/queue");
export const getAdminSync = () => aj<AdminSyncState>("/api/admin/sync");
export const patchAdminSync = (body: Partial<AdminSyncState["settings"]> & { permissions?: AdminSyncPermission[] }) =>
  aj<AdminSyncState>("/api/admin/sync", { method: "PATCH", body: JSON.stringify(body) });
export const runUpstreamSync = (body: { mode?: "full" | "db_only_remote_assets"; types?: SyncDataType[]; limit?: number }) =>
  aj<AdminSyncState & { lastRun?: { imported: number; conflicts: string[]; mode: string; sourceInstanceId: string } }>("/api/admin/sync/upstream/run", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const archiveSyncConflict = (id: string) =>
  aj<AdminSyncState>(`/api/admin/sync/conflicts/${encodeURIComponent(id)}/archive`, { method: "POST", body: JSON.stringify({}) });
export const promoteSyncConflict = (id: string) =>
  aj<AdminSyncState>(`/api/admin/sync/conflicts/${encodeURIComponent(id)}/promote`, { method: "POST", body: JSON.stringify({}) });
export const patchSweeper = (b: Partial<Pick<SweeperState, "enabled" | "maxConcurrentJobs" | "pollIntervalMs" | "submitIntervalMs">>) =>
  aj<SweeperState>("/api/admin/sweeper", { method: "PATCH", body: JSON.stringify(b) });
export const requeueFailed = () => aj<{ requeued: number }>("/api/admin/results/requeue-failed", { method: "POST", body: JSON.stringify({}) });
export const recoverStaleJobs = (olderThanMinutes = 30) =>
  aj<{ recovered: number; requeuedResults: number; requeued: number; keptRunning: number; markedIngesting: number; unchanged: number }>("/api/admin/jobs/recover-stale", {
    method: "POST",
    body: JSON.stringify({ olderThanMinutes }),
  });
export const purgeTestArtifacts = (prefix: string) =>
  aj<{ purged: Record<string, number> }>("/api/admin/test-artifacts/purge", {
    method: "POST",
    body: JSON.stringify({ prefix }),
  });
export const cancelJob = (id: string) => aj<{ cancelled: boolean }>(`/api/admin/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });

export interface MediumInput {
  slug?: string;
  name: string;
  phase: "gas" | "liquid";
  density: number;
  refTemperatureK: number;
  refPressurePa: number;
  viscosityModel: ViscosityModelName;
  constantDynamicViscosity?: number | null;
  sutherlandMuRef?: number | null;
  sutherlandTRef?: number | null;
  sutherlandS?: number | null;
  viscosityTable?: ViscosityTablePointDTO[];
  speedOfSound?: number | null;
  notes?: string | null;
}

export interface AdminBoundaryCondition extends BoundaryConditionDTO {
  sandGrainHeight: number;
  roughnessConstant: number;
  mesher: string;
  farfieldRadiusChords: number;
  wakeLengthChords: number;
  nSurface: number;
  nRadial: number;
  nWake: number;
  targetYPlus: number;
  spanChords: number;
  nIterations: number;
  convergenceTolerance: number;
  momentumScheme: string;
  transientCycles: number;
  transientDiscardFraction: number;
  transientMaxCourant: number;
  writeImages: string[];
  imageZoomChords: number;
  createdAt: string;
  updatedAt: string;
}

export type BoundaryConditionInput = Omit<AdminBoundaryCondition, "id" | "slug" | "mediumSlug" | "mediumName" | "reynolds" | "mach" | "density" | "dynamicViscosity" | "kinematicViscosity" | "createdAt" | "updatedAt"> & {
  slug?: string;
};

export const getAdminMediums = () => aj<{ items: MediumDTO[] }>("/api/admin/mediums");
export const createAdminMedium = (body: MediumInput) =>
  aj<MediumDTO>("/api/admin/mediums", { method: "POST", body: JSON.stringify(body) });
export const updateAdminMedium = (id: string, body: Partial<MediumInput>) =>
  aj<MediumDTO>(`/api/admin/mediums/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const getAdminBoundaryConditions = () => aj<{ items: AdminBoundaryCondition[] }>("/api/admin/boundary-conditions");
export const createAdminBoundaryCondition = (body: BoundaryConditionInput) =>
  aj<AdminBoundaryCondition>("/api/admin/boundary-conditions", { method: "POST", body: JSON.stringify(body) });
export const updateAdminBoundaryCondition = (id: string, body: Partial<BoundaryConditionInput>) =>
  aj<AdminBoundaryCondition>(`/api/admin/boundary-conditions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });

export interface AdminFlowCondition {
  id: string;
  slug: string;
  name: string;
  mediumId: string;
  mediumSlug: string;
  mediumName: string;
  temperatureK: number;
  pressurePa: number;
  speedMps: number;
  density: number;
  dynamicViscosity: number;
  kinematicViscosity: number;
  mach: number | null;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminReferenceGeometryProfile {
  id: string;
  slug: string;
  name: string;
  geometryType: string;
  referenceLengthKind: string;
  referenceLengthM: number;
  spanM: number | null;
  referenceAreaM2: number | null;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminBoundaryProfile {
  id: string;
  slug: string;
  name: string;
  turbulenceIntensity: number;
  viscosityRatio: number;
  sandGrainHeight: number;
  roughnessConstant: number;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminMeshProfile {
  id: string;
  slug: string;
  name: string;
  mesher: string;
  farfieldRadiusChords: number;
  wakeLengthChords: number;
  nSurface: number;
  nRadial: number;
  nWake: number;
  targetYPlus: number;
  spanChords: number;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSolverProfile {
  id: string;
  slug: string;
  name: string;
  turbulenceModel: string;
  nIterations: number;
  convergenceTolerance: number;
  momentumScheme: string;
  transientCycles: number;
  transientDiscardFraction: number;
  transientMaxCourant: number;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSchedulingProfile {
  id: string;
  slug: string;
  name: string;
  schedulingPolicy: "auto" | "airfoil_parallel" | "case_parallel" | "exclusive";
  cpuBudget: number | null;
  caseConcurrency: number | null;
  solverProcesses: number | null;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminOutputProfile {
  id: string;
  slug: string;
  name: string;
  writeImages: string[];
  imageZoomChords: number;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSweepDefinition {
  id: string;
  slug: string;
  name: string;
  aoaStart: number;
  aoaStop: number;
  aoaStep: number;
  aoaList: number[] | null;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSimulationPreset {
  id: string;
  slug: string;
  name: string;
  flowConditionId: string;
  referenceGeometryProfileId: string;
  boundaryProfileId: string;
  meshProfileId: string;
  solverProfileId: string;
  schedulingProfileId: string;
  outputProfileId: string;
  sweepDefinitionId: string;
  legacyBoundaryConditionId: string | null;
  currentRevisionId: string | null;
  currentRevisionNumber: number | null;
  signatureHash: string | null;
  targetScope: "all" | "airfoils";
  targetAirfoilIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAirfoilOption {
  id: string;
  slug: string;
  name: string;
}

export interface AdminSimulationSetup {
  flowConditions: AdminFlowCondition[];
  referenceGeometryProfiles: AdminReferenceGeometryProfile[];
  boundaryProfiles: AdminBoundaryProfile[];
  meshProfiles: AdminMeshProfile[];
  solverProfiles: AdminSolverProfile[];
  schedulingProfiles: AdminSchedulingProfile[];
  outputProfiles: AdminOutputProfile[];
  sweepDefinitions: AdminSweepDefinition[];
  airfoilOptions: AdminAirfoilOption[];
  simulationPresets: AdminSimulationPreset[];
}

export type FlowConditionInput = Pick<
  AdminFlowCondition,
  "name" | "mediumId" | "temperatureK" | "pressurePa" | "speedMps"
> & { slug?: string };
export type ReferenceGeometryProfileInput = Pick<
  AdminReferenceGeometryProfile,
  "name" | "geometryType" | "referenceLengthKind" | "referenceLengthM" | "spanM" | "referenceAreaM2"
> & { slug?: string };
export type BoundaryProfileInput = Pick<
  AdminBoundaryProfile,
  "name" | "turbulenceIntensity" | "viscosityRatio" | "sandGrainHeight" | "roughnessConstant"
> & { slug?: string };
export type MeshProfileInput = Pick<
  AdminMeshProfile,
  "name" | "mesher" | "farfieldRadiusChords" | "wakeLengthChords" | "nSurface" | "nRadial" | "nWake" | "targetYPlus" | "spanChords"
> & { slug?: string };
export type SolverProfileInput = Pick<
  AdminSolverProfile,
  "name" | "turbulenceModel" | "nIterations" | "convergenceTolerance" | "momentumScheme" | "transientCycles" | "transientDiscardFraction" | "transientMaxCourant"
> & { slug?: string };
export type SchedulingProfileInput = Pick<
  AdminSchedulingProfile,
  "name" | "schedulingPolicy" | "cpuBudget" | "caseConcurrency" | "solverProcesses"
> & { slug?: string };
export type OutputProfileInput = Pick<AdminOutputProfile, "name" | "writeImages" | "imageZoomChords"> & { slug?: string };
export type SweepDefinitionInput = Pick<AdminSweepDefinition, "name" | "aoaStart" | "aoaStop" | "aoaStep" | "aoaList"> & {
  slug?: string;
};
export type SimulationPresetInput = Pick<
  AdminSimulationPreset,
  "name" | "flowConditionId" | "referenceGeometryProfileId" | "boundaryProfileId" | "meshProfileId" | "solverProfileId" | "schedulingProfileId" | "outputProfileId" | "sweepDefinitionId" | "targetScope" | "targetAirfoilIds" | "enabled"
> & { slug?: string };

export const getAdminSimulationSetup = () => aj<AdminSimulationSetup>("/api/admin/simulation-setup");
export const createFlowCondition = (body: FlowConditionInput) =>
  aj<AdminFlowCondition>("/api/admin/flow-conditions", { method: "POST", body: JSON.stringify(body) });
export const updateFlowCondition = (id: string, body: Partial<FlowConditionInput>) =>
  aj<AdminFlowCondition>(`/api/admin/flow-conditions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const createReferenceGeometryProfile = (body: ReferenceGeometryProfileInput) =>
  aj<AdminReferenceGeometryProfile>("/api/admin/reference-geometry-profiles", { method: "POST", body: JSON.stringify(body) });
export const updateReferenceGeometryProfile = (id: string, body: Partial<ReferenceGeometryProfileInput>) =>
  aj<AdminReferenceGeometryProfile>(`/api/admin/reference-geometry-profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const createBoundaryProfile = (body: BoundaryProfileInput) =>
  aj<AdminBoundaryProfile>("/api/admin/boundary-profiles", { method: "POST", body: JSON.stringify(body) });
export const updateBoundaryProfile = (id: string, body: Partial<BoundaryProfileInput>) =>
  aj<AdminBoundaryProfile>(`/api/admin/boundary-profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const createMeshProfile = (body: MeshProfileInput) =>
  aj<AdminMeshProfile>("/api/admin/mesh-profiles", { method: "POST", body: JSON.stringify(body) });
export const updateMeshProfile = (id: string, body: Partial<MeshProfileInput>) =>
  aj<AdminMeshProfile>(`/api/admin/mesh-profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const createSolverProfile = (body: SolverProfileInput) =>
  aj<AdminSolverProfile>("/api/admin/solver-profiles", { method: "POST", body: JSON.stringify(body) });
export const updateSolverProfile = (id: string, body: Partial<SolverProfileInput>) =>
  aj<AdminSolverProfile>(`/api/admin/solver-profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const createSchedulingProfile = (body: SchedulingProfileInput) =>
  aj<AdminSchedulingProfile>("/api/admin/scheduling-profiles", { method: "POST", body: JSON.stringify(body) });
export const updateSchedulingProfile = (id: string, body: Partial<SchedulingProfileInput>) =>
  aj<AdminSchedulingProfile>(`/api/admin/scheduling-profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const createOutputProfile = (body: OutputProfileInput) =>
  aj<AdminOutputProfile>("/api/admin/output-profiles", { method: "POST", body: JSON.stringify(body) });
export const updateOutputProfile = (id: string, body: Partial<OutputProfileInput>) =>
  aj<AdminOutputProfile>(`/api/admin/output-profiles/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const createSweepDefinition = (body: SweepDefinitionInput) =>
  aj<AdminSweepDefinition>("/api/admin/sweep-definitions", { method: "POST", body: JSON.stringify(body) });
export const updateSweepDefinition = (id: string, body: Partial<SweepDefinitionInput>) =>
  aj<AdminSweepDefinition>(`/api/admin/sweep-definitions/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
export const createSimulationPreset = (body: SimulationPresetInput) =>
  aj<AdminSimulationPreset>("/api/admin/simulation-presets", { method: "POST", body: JSON.stringify(body) });
export const updateSimulationPreset = (id: string, body: Partial<SimulationPresetInput>) =>
  aj<AdminSimulationPreset>(`/api/admin/simulation-presets/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });

export interface AdminCategoryInput {
  name: string;
  parentId?: string | null;
  description?: string | null;
  sortOrder?: number;
}

export interface AdminCategoryRow {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  path: string;
  depth: number;
  sortOrder: number;
  description: string | null;
}

export const getAdminCategoryTree = () => aj<CategoryNode[]>("/api/admin/categories/tree");
export const createAdminCategory = (body: AdminCategoryInput) =>
  aj<AdminCategoryRow>("/api/admin/categories", { method: "POST", body: JSON.stringify(body) });
export const updateAdminCategory = (id: string, body: Partial<AdminCategoryInput>) =>
  aj<AdminCategoryRow>(`/api/admin/categories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
export const reorderAdminCategory = (body: { draggedId: string; targetId: string; position: "before" | "inside" | "after" }) =>
  aj<CategoryNode[]>("/api/admin/categories/reorder", { method: "POST", body: JSON.stringify(body) });
export const deleteAdminCategory = (id: string) =>
  fetch(`${BASE}/api/admin/categories/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  }).then(async (res) => {
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error || `delete failed (${res.status})`);
    }
  });

export const getAdminHashtags = () => aj<{ items: HashtagDTO[] }>("/api/admin/hashtags");
export const createAdminHashtag = (name: string) =>
  aj<HashtagDTO>("/api/admin/hashtags", { method: "POST", body: JSON.stringify({ name }) });
export const updateAdminHashtag = (id: string, name: string) =>
  aj<HashtagDTO>(`/api/admin/hashtags/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
export const deleteAdminHashtag = (id: string) =>
  fetch(`${BASE}/api/admin/hashtags/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  }).then(async (res) => {
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error || `delete failed (${res.status})`);
    }
  });

export type BulkAirfoilAction = "move" | "archive" | "remove" | "restore" | "assignHashtags" | "removeHashtags";
export const bulkAirfoils = (body: {
  ids: string[];
  action: BulkAirfoilAction;
  categoryId?: string;
  hashtagIds?: string[];
}) => aj<{ ok: boolean; updated: number }>("/api/admin/airfoils/bulk", { method: "POST", body: JSON.stringify(body) });
