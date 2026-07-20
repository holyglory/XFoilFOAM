import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  type DB,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  referenceGeometryProfiles,
  remoteAssetReferences,
  resultAttempts,
  resultClassifications,
  resultFieldExtents,
  resultMedia,
  results,
  schedulingProfiles,
  simJobs,
  simPrecalcObligations,
  simRansPolarPromotions,
  simResultSubmitRetries,
  simulationPresetRevisions,
  simulationPresets,
  solverEvidenceArtifacts,
  solverImplementations,
  solverProfiles,
  solverRuntimeBuilds,
  syncApiSettings,
  syncRemoteHubBindingReceipts,
  syncRemotePromiseCancellations,
  syncRemoteResultDeliveries,
  syncSweepPromisePoints,
  syncSweepPromises,
  sweepDefinitions,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  METHOD_COMPATIBILITY_HASH_VERSION,
} from "@aerodb/db";
import {
  canonicalRemoteHubBaseUrl,
  isGcsResumableUploadUrl,
} from "@aerodb/core";
import {
  methodCompatibilityHashForSnapshot,
  physicsHashForSnapshot,
  simulationSetupSignature,
  type SimulationSetupSnapshot,
} from "@aerodb/db/simulation-setup";
import type { EngineClient } from "@aerodb/engine-client";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";

import {
  buildPolarRequest,
  solverImplementationIdForSetup,
} from "./build-request";
import { claimAoas } from "./claim";
import {
  assertRemoteSolverNodeEvidenceContract,
  assertRemoteSolverHubUrlContract,
  configuredControlPlaneToken,
  configuredEngineIdentity,
} from "./config";
import {
  clearEngineUnreachable,
  engineBackoffActive,
  recordEngineUnreachable,
} from "./engine-backoff";
import { requireExecutionPoolForSetup } from "./engine-pool";
import { touchHeartbeat } from "./heartbeat";
import { parsedMeshRecoveryVersion } from "./engine-capabilities";
import { retryScopeForRequestedPolar } from "./retry-plan";
import { submitPendingJobWithLifecycleGuard } from "./submit-lifecycle";

const MEDIA_DIR = process.env.MEDIA_DIR ?? "/data/airfoilfoam";

// Remote-hub HTTP calls run INSIDE the sweeper tick — a hung fetch here would
// stall tick progress exactly like a hung engine call (2026-07-06 incident
// class), so every call carries an AbortSignal timeout. Aborts surface through
// the existing failure handling (remoteSolverTick's catch → setStatus error).
const REMOTE_POLL_TIMEOUT_MS = 15_000;
const REMOTE_PUSH_STALL_TIMEOUT_MS = Number(
  process.env.REMOTE_PUSH_STALL_TIMEOUT_MS ?? 120_000,
);
const REMOTE_PUSH_ABSOLUTE_TIMEOUT_MS = Number(
  process.env.REMOTE_PUSH_ABSOLUTE_TIMEOUT_MS ?? 6 * 60 * 60_000,
);
const DELIVERY_CLAIM_MS = Number(
  process.env.REMOTE_DELIVERY_CLAIM_MS ?? 30 * 60_000,
);
const DELIVERY_CLAIM_RENEW_INTERVAL_MS = Number(
  process.env.REMOTE_DELIVERY_CLAIM_RENEW_INTERVAL_MS ??
    Math.min(5 * 60_000, Math.max(1_000, DELIVERY_CLAIM_MS / 3)),
);
const REMOTE_TRANSFER_PROMISE_TTL_HOURS = 1;
const REMOTE_TRANSFER_PROMISE_RENEW_INTERVAL_MS = Math.min(
  20 * 60_000,
  Math.max(
    1_000,
    Number(
      process.env.REMOTE_TRANSFER_PROMISE_RENEW_INTERVAL_MS ?? 15 * 60_000,
    ),
  ),
);
const REMOTE_RECLAIM_CLAIM_MS = 10 * 60_000;
const REMOTE_RECLAIM_CLAIM_RENEW_INTERVAL_MS = Math.min(
  2 * 60_000,
  Math.max(
    1_000,
    Number(process.env.REMOTE_RECLAIM_CLAIM_RENEW_INTERVAL_MS ?? 2 * 60_000),
  ),
);
const HUB_BINDING_RECEIPT_HMAC_DOMAIN =
  "xfoilfoam-hub-canonical-evidence-binding-v1\n";
const BROKER_UPLOAD_IDEMPOTENCY_DOMAIN = "xfoilfoam:broker-upload:v1\0";

export function brokeredEvidenceIdempotencyKey(
  promiseId: string,
  resultAttemptId: string,
): string {
  const bytes = createHash("sha256")
    .update(BROKER_UPLOAD_IDEMPOTENCY_DOMAIN)
    .update(promiseId)
    .update("\0")
    .update(resultAttemptId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type Settings = typeof syncApiSettings.$inferSelect;

interface HubBindingReceipt {
  schemaVersion: 1;
  kind: "hub-canonical-evidence-binding";
  promiseId: string;
  aoaDeg: number;
  remoteResultId: string;
  remoteResultAttemptId: string;
  engineJobId: string;
  engineCaseSlug: string | null;
  brokeredUploadId: string;
  bindingState: "bound";
  promisePointState: "fulfilled";
  remote: {
    bucket: string;
    objectKey: string;
    generation: string;
    crc32c: string;
    storedSha256: string;
    storedByteSize: number;
    tarSha256: string;
    tarByteSize: number;
    manifestSha256: string;
    manifestByteSize: number;
    zstdLevel: number;
    bundledFileCount: number;
  };
  canonical: {
    resultId: string;
    resultAttemptId: string;
    artifactId: string;
  };
  boundAt: string;
  fulfilledAt: string;
}

interface SignedHubBindingReceipt {
  receipt: HubBindingReceipt;
  receiptHmac: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

interface RemoteClaimResponse {
  promise: null | {
    id: string;
    expiresAt: string;
    airfoil: {
      slug: string;
      name: string;
      source: string | null;
      pointFormat: string;
      points: unknown[];
    };
    setupRevision: {
      signatureHash: string;
      snapshot: SimulationSetupSnapshot;
    };
    aoas: number[];
  };
}

interface RemotePromiseWorkState {
  dueAoas: number[];
  requestedAoas: number[];
  waitingUntil: Date | null;
  busy: boolean;
  completed: boolean;
  terminal: boolean;
  activePointCount: number;
}

type RemotePromiseSubmitResult =
  | { kind: "submitted" | "busy" | "waiting" }
  | { kind: "terminal"; error: string }
  | { kind: "stopped"; error: string };

export type RemoteEngineAdmissionHoldReason =
  | "storage_pressure"
  | "safety_stop"
  | "mesh_capability_unknown"
  | "higher_priority_fast_urans"
  | "shared_capacity_full"
  | "engine_unavailable";

/** A remote promise is reconciled independently from admitting new local
 * OpenFOAM work. The allow branch carries the exact live mesh-recovery
 * capability that the engine request and durable job payload must pin. */
export type RemoteEngineAdmissionDecision =
  | { kind: "allow"; meshRecoveryVersion: number }
  | { kind: "hold"; reason: RemoteEngineAdmissionHoldReason };

function syncBase(settings: Settings): string {
  if (!settings.upstreamBaseUrl)
    throw new Error("up-tier endpoint is not configured");
  return canonicalRemoteHubBaseUrl(settings.upstreamBaseUrl);
}

function headers(settings: Settings) {
  if (!settings.remoteSolverAuthToken)
    throw new Error("remote solver credential is not registered");
  return {
    "content-type": "application/json",
    "x-xfoilfoam-solver-token": settings.remoteSolverAuthToken,
  };
}

function bootstrapHeaders(settings: Settings) {
  return {
    "content-type": "application/json",
    ...(settings.remoteSolverAuthToken
      ? { "x-xfoilfoam-solver-token": settings.remoteSolverAuthToken }
      : { "x-xfoilfoam-sync-secret": settings.upstreamSecret ?? "" }),
  };
}

function exactSignedHubBindingReceipt(
  value: unknown,
  input: {
    settings: Settings;
    promiseId: string;
    resultId: string;
    resultAttemptId: string;
    aoaDeg: number;
    engineJobId: string;
    engineCaseSlug: string | null;
    brokeredUploadId: string;
    brokerRequest: {
      storedSha256: string;
      storedByteSize: number;
      tarSha256: string;
      tarByteSize: number;
      manifestSha256: string;
      manifestByteSize: number;
      zstdLevel: number;
      bundledFileCount: number;
    };
    remotePointer: Record<string, unknown>;
  },
): SignedHubBindingReceipt {
  if (!input.settings.remoteSolverAuthToken)
    throw new Error(
      "remote solver credential is unavailable for receipt verification",
    );
  if (!value || typeof value !== "object")
    throw new Error("remote hub omitted its signed canonical binding receipt");
  const wrapper = value as Record<string, unknown>;
  if (
    !wrapper.receipt ||
    typeof wrapper.receipt !== "object" ||
    typeof wrapper.receiptHmac !== "string" ||
    !/^[0-9a-f]{64}$/.test(wrapper.receiptHmac)
  )
    throw new Error("remote hub returned an invalid binding receipt envelope");
  const receipt = wrapper.receipt as unknown as HubBindingReceipt;
  const expectedHmac = createHmac(
    "sha256",
    input.settings.remoteSolverAuthToken,
  )
    .update(HUB_BINDING_RECEIPT_HMAC_DOMAIN)
    .update(canonicalJson(receipt))
    .digest("hex");
  const supplied = Buffer.from(wrapper.receiptHmac, "hex");
  const expected = Buffer.from(expectedHmac, "hex");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    throw new Error("remote hub binding receipt authentication failed");
  const remote = receipt.remote;
  const canonical = receipt.canonical;
  const exact =
    receipt.schemaVersion === 1 &&
    receipt.kind === "hub-canonical-evidence-binding" &&
    receipt.promiseId === input.promiseId &&
    receipt.aoaDeg === input.aoaDeg &&
    receipt.remoteResultId === input.resultId &&
    receipt.remoteResultAttemptId === input.resultAttemptId &&
    receipt.engineJobId === input.engineJobId &&
    receipt.engineCaseSlug === input.engineCaseSlug &&
    receipt.brokeredUploadId === input.brokeredUploadId &&
    receipt.bindingState === "bound" &&
    receipt.promisePointState === "fulfilled" &&
    remote?.bucket === input.remotePointer.bucket &&
    remote?.objectKey === input.remotePointer.objectKey &&
    remote?.generation === input.remotePointer.generation &&
    remote?.crc32c === input.remotePointer.crc32c &&
    remote?.storedSha256 === input.brokerRequest.storedSha256 &&
    remote?.storedByteSize === input.brokerRequest.storedByteSize &&
    remote?.tarSha256 === input.brokerRequest.tarSha256 &&
    remote?.tarByteSize === input.brokerRequest.tarByteSize &&
    remote?.manifestSha256 === input.brokerRequest.manifestSha256 &&
    remote?.manifestByteSize === input.brokerRequest.manifestByteSize &&
    remote?.zstdLevel === input.brokerRequest.zstdLevel &&
    remote?.bundledFileCount === input.brokerRequest.bundledFileCount &&
    canonical &&
    typeof canonical.resultId === "string" &&
    /^[0-9a-f-]{36}$/i.test(canonical.resultId) &&
    typeof canonical.resultAttemptId === "string" &&
    /^[0-9a-f-]{36}$/i.test(canonical.resultAttemptId) &&
    typeof canonical.artifactId === "string" &&
    /^[0-9a-f-]{36}$/i.test(canonical.artifactId) &&
    typeof receipt.boundAt === "string" &&
    Number.isFinite(Date.parse(receipt.boundAt)) &&
    typeof receipt.fulfilledAt === "string" &&
    Number.isFinite(Date.parse(receipt.fulfilledAt));
  if (!exact)
    throw new Error(
      "remote hub binding receipt does not match the exact delivered generation",
    );
  return {
    receipt,
    receiptHmac: wrapper.receiptHmac,
  };
}

export interface ProgressAwareAbort {
  signal: AbortSignal;
  progress: () => void;
  dispose: () => void;
}

export function createProgressAwareAbort(
  options: {
    stallTimeoutMs?: number;
    absoluteTimeoutMs?: number;
  } = {},
): ProgressAwareAbort {
  const stallTimeoutMs = options.stallTimeoutMs ?? REMOTE_PUSH_STALL_TIMEOUT_MS;
  const absoluteTimeoutMs =
    options.absoluteTimeoutMs ?? REMOTE_PUSH_ABSOLUTE_TIMEOUT_MS;
  const controller = new AbortController();
  let stallTimer: ReturnType<typeof setTimeout>;
  const abort = (message: string) => {
    if (!controller.signal.aborted) controller.abort(new Error(message));
  };
  const resetStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(
      () => abort("remote polar push stalled without stream progress"),
      stallTimeoutMs,
    );
    stallTimer.unref?.();
  };
  resetStall();
  const absoluteTimer = setTimeout(
    () => abort("remote polar push exceeded its absolute safety deadline"),
    absoluteTimeoutMs,
  );
  absoluteTimer.unref?.();
  return {
    signal: controller.signal,
    progress: resetStall,
    dispose: () => {
      clearTimeout(stallTimer);
      clearTimeout(absoluteTimer);
    },
  };
}

function slugPart(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && value.trim() ? value : fallback;
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

async function setStatus(
  db: DB,
  status: Settings["remoteSolverLastStatus"],
  error: string | null = null,
  patch: Partial<typeof syncApiSettings.$inferInsert> = {},
) {
  await db
    .update(syncApiSettings)
    .set({
      remoteSolverLastStatus: status,
      remoteSolverLastError: error,
      ...patch,
      updatedAt: new Date(),
    })
    .where(eq(syncApiSettings.id, 1));
}

async function ensureRemoteAirfoil(
  db: DB,
  claim: NonNullable<RemoteClaimResponse["promise"]>,
) {
  const [category] = await db
    .insert(categories)
    .values({
      slug: "remote-sync",
      name: "Remote sync",
      path: "remote-sync",
      depth: 0,
      sortOrder: 9999,
    })
    .onConflictDoUpdate({
      target: categories.slug,
      set: { name: "Remote sync", updatedAt: new Date() },
    })
    .returning({ id: categories.id });
  const [row] = await db
    .insert(airfoils)
    .values({
      slug: claim.airfoil.slug,
      name: claim.airfoil.name,
      categoryId: category.id,
      source: claim.airfoil.source ?? "remote-sync",
      points: claim.airfoil.points as never[],
      pointFormat: claim.airfoil.pointFormat,
    })
    .onConflictDoUpdate({
      target: airfoils.slug,
      set: {
        name: claim.airfoil.name,
        points: claim.airfoil.points as never[],
        pointFormat: claim.airfoil.pointFormat,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row;
}

async function ensureRemoteRevision(
  db: DB,
  claim: NonNullable<RemoteClaimResponse["promise"]>,
  settings: Settings,
) {
  const snapshot = claim.setupRevision.snapshot;
  const [solverImplementation] = await db
    .select()
    .from(solverImplementations)
    .where(
      snapshot.engine
        ? eq(solverImplementations.key, snapshot.engine.key)
        : eq(solverImplementations.id, OPENCFD_2406_SOLVER_IMPLEMENTATION_ID),
    )
    .limit(1);
  if (
    !solverImplementation ||
    (snapshot.engine &&
      (solverImplementation.family !== snapshot.engine.family ||
        solverImplementation.distribution !== snapshot.engine.distribution ||
        solverImplementation.releaseVersion !==
          snapshot.engine.releaseVersion ||
        solverImplementation.numericsRevision !==
          snapshot.engine.numericsRevision ||
        solverImplementation.adapterContractVersion !==
          snapshot.engine.adapterContractVersion))
  ) {
    throw new Error(
      `remote setup references an unknown or conflicting solver implementation ${snapshot.engine?.key ?? "legacy OpenCFD 2406"}`,
    );
  }
  const signatureHash =
    claim.setupRevision.signatureHash || simulationSetupSignature(snapshot);
  const prefix = `remote-${slugPart(settings.instanceId, "local")}-${signatureHash.slice(0, 12)}`;
  const mediumSlug = snapshot.flowState.mediumSlug || "remote-medium";
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: mediumSlug,
      name: snapshot.flowState.mediumName || mediumSlug,
      phase: "gas",
      density: snapshot.flowState.density,
      refTemperatureK: snapshot.flowState.temperatureK,
      refPressurePa: snapshot.flowState.pressurePa,
      viscosityModel: "constant",
      constantDynamicViscosity: snapshot.flowState.dynamicViscosity,
      dynamicViscosity: snapshot.flowState.dynamicViscosity,
      kinematicViscosity: snapshot.flowState.kinematicViscosity,
      speedOfSound:
        snapshot.flowState.mach && snapshot.flowState.mach > 0
          ? snapshot.flowState.speedMps / snapshot.flowState.mach
          : null,
    })
    .onConflictDoUpdate({
      target: mediums.slug,
      set: {
        density: snapshot.flowState.density,
        dynamicViscosity: snapshot.flowState.dynamicViscosity,
        kinematicViscosity: snapshot.flowState.kinematicViscosity,
        updatedAt: new Date(),
      },
    })
    .returning({ id: mediums.id });
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${prefix}-flow`,
      name: `Remote flow ${signatureHash.slice(0, 8)}`,
      mediumId: medium.id,
      temperatureK: snapshot.flowState.temperatureK,
      pressurePa: snapshot.flowState.pressurePa,
      speedMps: snapshot.flowState.speedMps,
      density: snapshot.flowState.density,
      dynamicViscosity: snapshot.flowState.dynamicViscosity,
      kinematicViscosity: snapshot.flowState.kinematicViscosity,
      mach: snapshot.flowState.mach,
    })
    .onConflictDoUpdate({
      target: flowConditions.slug,
      set: { updatedAt: new Date() },
    })
    .returning({ id: flowConditions.id });
  const [reference] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${prefix}-reference`,
      name: `Remote reference ${signatureHash.slice(0, 8)}`,
      geometryType: snapshot.referenceGeometry.geometryType,
      referenceLengthKind: snapshot.referenceGeometry.referenceLengthKind,
      referenceLengthM: snapshot.referenceGeometry.referenceLengthM,
      spanM: snapshot.referenceGeometry.spanM,
      referenceAreaM2: snapshot.referenceGeometry.referenceAreaM2,
    })
    .onConflictDoUpdate({
      target: referenceGeometryProfiles.slug,
      set: { updatedAt: new Date() },
    })
    .returning({ id: referenceGeometryProfiles.id });
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({
      slug: `${prefix}-boundary`,
      name: `Remote boundary ${signatureHash.slice(0, 8)}`,
      turbulenceIntensity: snapshot.boundary.turbulenceIntensity,
      viscosityRatio: snapshot.boundary.viscosityRatio,
      sandGrainHeight: snapshot.boundary.sandGrainHeight,
      roughnessConstant: snapshot.boundary.roughnessConstant,
    })
    .onConflictDoUpdate({
      target: boundaryProfiles.slug,
      set: { updatedAt: new Date() },
    })
    .returning({ id: boundaryProfiles.id });
  const [mesh] = await db
    .insert(meshProfiles)
    .values({
      slug: `${prefix}-mesh`,
      name: `Remote mesh ${signatureHash.slice(0, 8)}`,
      mesher: snapshot.mesh.mesher,
      farfieldRadiusChords: snapshot.mesh.farfieldRadiusChords,
      wakeLengthChords: snapshot.mesh.wakeLengthChords,
      nSurface: snapshot.mesh.nSurface,
      nRadial: snapshot.mesh.nRadial,
      nWake: snapshot.mesh.nWake,
      targetYPlus: snapshot.mesh.targetYPlus,
      spanChords: snapshot.mesh.spanChords,
    })
    .onConflictDoUpdate({
      target: meshProfiles.slug,
      set: { updatedAt: new Date() },
    })
    .returning({ id: meshProfiles.id });
  const [solver] = await db
    .insert(solverProfiles)
    .values({
      slug: `${prefix}-solver`,
      name: `Remote solver ${signatureHash.slice(0, 8)}`,
      solverImplementationId: solverImplementation.id,
      turbulenceModel: snapshot.solver.turbulenceModel,
      nIterations: snapshot.solver.nIterations,
      convergenceTolerance: snapshot.solver.convergenceTolerance,
      momentumScheme: snapshot.solver.momentumScheme,
      transientCycles: snapshot.solver.transientCycles,
      transientDiscardFraction: snapshot.solver.transientDiscardFraction,
      transientMaxCourant: snapshot.solver.transientMaxCourant,
    })
    .onConflictDoUpdate({
      target: solverProfiles.slug,
      set: {
        solverImplementationId: solverImplementation.id,
        updatedAt: new Date(),
      },
    })
    .returning({ id: solverProfiles.id });
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({
      slug: `${prefix}-scheduling`,
      name: `Remote scheduling ${signatureHash.slice(0, 8)}`,
      schedulingPolicy: snapshot.scheduling.schedulingPolicy,
      caseConcurrency: snapshot.scheduling.caseConcurrency,
      solverProcesses: snapshot.scheduling.solverProcesses,
      cpuBudget:
        settings.remoteSolverCpuBudget || snapshot.scheduling.cpuBudget,
    })
    .onConflictDoUpdate({
      target: schedulingProfiles.slug,
      set: { updatedAt: new Date() },
    })
    .returning({ id: schedulingProfiles.id });
  const [output] = await db
    .insert(outputProfiles)
    .values({
      slug: `${prefix}-output`,
      name: `Remote output ${signatureHash.slice(0, 8)}`,
      writeImages: snapshot.output.writeImages,
      imageZoomChords: snapshot.output.imageZoomChords,
    })
    .onConflictDoUpdate({
      target: outputProfiles.slug,
      set: { updatedAt: new Date() },
    })
    .returning({ id: outputProfiles.id });
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${prefix}-sweep`,
      name: `Remote sweep ${signatureHash.slice(0, 8)}`,
      aoaStart: snapshot.sweep.aoaStart,
      aoaStop: snapshot.sweep.aoaStop,
      aoaStep: snapshot.sweep.aoaStep,
      aoaList: snapshot.sweep.aoaList,
    })
    .onConflictDoUpdate({
      target: sweepDefinitions.slug,
      set: { updatedAt: new Date() },
    })
    .returning({ id: sweepDefinitions.id });
  const [legacy] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${prefix}-legacy-bc`,
      name: `Remote compatibility setup ${signatureHash.slice(0, 8)}`,
      mediumId: medium.id,
      reynolds: Math.round(snapshot.derived.reynolds),
      referenceChordM: snapshot.referenceGeometry.referenceLengthM,
      temperatureK: snapshot.flowState.temperatureK,
      pressurePa: snapshot.flowState.pressurePa,
      speedMps: snapshot.flowState.speedMps,
      density: snapshot.flowState.density,
      dynamicViscosity: snapshot.flowState.dynamicViscosity,
      kinematicViscosity: snapshot.flowState.kinematicViscosity,
      mach: snapshot.flowState.mach,
      turbulenceModel: snapshot.solver.turbulenceModel,
      turbulenceIntensity: snapshot.boundary.turbulenceIntensity,
      viscosityRatio: snapshot.boundary.viscosityRatio,
      sandGrainHeight: snapshot.boundary.sandGrainHeight,
      roughnessConstant: snapshot.boundary.roughnessConstant,
      mesher: snapshot.mesh.mesher,
      farfieldRadiusChords: snapshot.mesh.farfieldRadiusChords,
      wakeLengthChords: snapshot.mesh.wakeLengthChords,
      nSurface: snapshot.mesh.nSurface,
      nRadial: snapshot.mesh.nRadial,
      nWake: snapshot.mesh.nWake,
      targetYPlus: snapshot.mesh.targetYPlus,
      spanChords: snapshot.mesh.spanChords,
      nIterations: snapshot.solver.nIterations,
      convergenceTolerance: snapshot.solver.convergenceTolerance,
      momentumScheme: snapshot.solver.momentumScheme,
      transientCycles: snapshot.solver.transientCycles,
      transientDiscardFraction: snapshot.solver.transientDiscardFraction,
      transientMaxCourant: snapshot.solver.transientMaxCourant,
      writeImages: snapshot.output.writeImages,
      imageZoomChords: snapshot.output.imageZoomChords,
      schedulingPolicy: snapshot.scheduling.schedulingPolicy,
      cpuBudget:
        settings.remoteSolverCpuBudget || snapshot.scheduling.cpuBudget,
      caseConcurrency: snapshot.scheduling.caseConcurrency,
      solverProcesses: snapshot.scheduling.solverProcesses,
      aoaStart: snapshot.sweep.aoaStart,
      aoaStop: snapshot.sweep.aoaStop,
      aoaStep: snapshot.sweep.aoaStep,
      aoaList: snapshot.sweep.aoaList,
      enabled: false,
    })
    .onConflictDoUpdate({
      target: boundaryConditions.slug,
      set: { updatedAt: new Date() },
    })
    .returning({ id: boundaryConditions.id });
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${prefix}-preset`,
      name:
        snapshot.preset.name || `Remote preset ${signatureHash.slice(0, 8)}`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: reference.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: legacy.id,
      targetScope: "all",
      enabled: false,
    })
    .onConflictDoUpdate({
      target: simulationPresets.slug,
      set: { updatedAt: new Date() },
    })
    .returning({ id: simulationPresets.id });
  const localSnapshot: SimulationSetupSnapshot = {
    ...snapshot,
    preset: {
      ...snapshot.preset,
      id: preset.id,
      slug: `${prefix}-preset`,
      legacyBoundaryConditionId: legacy.id,
      enabled: false,
    },
    flowState: { ...snapshot.flowState, mediumId: medium.id },
    scheduling: {
      ...snapshot.scheduling,
      cpuBudget:
        settings.remoteSolverCpuBudget || snapshot.scheduling.cpuBudget,
    },
  };
  const physicsHash = physicsHashForSnapshot(localSnapshot);
  const methodCompatibilityHash =
    methodCompatibilityHashForSnapshot(localSnapshot);
  const [revision] = await db
    .insert(simulationPresetRevisions)
    .values({
      presetId: preset.id,
      revisionNumber: 1,
      signatureHash,
      reynolds: Math.round(snapshot.derived.reynolds),
      mach: snapshot.derived.mach,
      referenceLengthM: snapshot.referenceGeometry.referenceLengthM,
      snapshot: localSnapshot as unknown as Record<string, unknown>,
      physicsHash,
      solverImplementationId: solverImplementation.id,
      methodCompatibilityHashVersion: METHOD_COMPATIBILITY_HASH_VERSION,
      methodCompatibilityHash,
    })
    .onConflictDoNothing({
      target: [
        simulationPresetRevisions.presetId,
        simulationPresetRevisions.signatureHash,
      ],
    })
    .returning();
  let row =
    revision ??
    (
      await db
        .select()
        .from(simulationPresetRevisions)
        .where(
          and(
            eq(simulationPresetRevisions.presetId, preset.id),
            eq(simulationPresetRevisions.signatureHash, signatureHash),
          ),
        )
        .limit(1)
    )[0];
  if (
    row &&
    (!row.physicsHash || (localSnapshot.engine && !row.methodCompatibilityHash))
  ) {
    const storedSnapshot = row.snapshot as unknown as SimulationSetupSnapshot;
    const storedMethodHash = storedSnapshot.engine
      ? methodCompatibilityHashForSnapshot(storedSnapshot)
      : null;
    const [withCompatibilityHash] = await db
      .update(simulationPresetRevisions)
      .set({
        physicsHash: physicsHashForSnapshot(storedSnapshot),
        ...(storedMethodHash
          ? {
              solverImplementationId: solverImplementation.id,
              methodCompatibilityHashVersion: METHOD_COMPATIBILITY_HASH_VERSION,
              methodCompatibilityHash: storedMethodHash,
            }
          : {}),
      })
      .where(eq(simulationPresetRevisions.id, row.id))
      .returning();
    row = withCompatibilityHash ?? row;
  }
  return { revision: row, snapshot: localSnapshot, bcId: legacy.id };
}

async function registerSolver(db: DB, settings: Settings): Promise<string> {
  const res = await fetch(`${syncBase(settings)}/solvers/register`, {
    method: "POST",
    signal: AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
    headers: bootstrapHeaders(settings),
    body: JSON.stringify({
      instanceId: settings.instanceId,
      instanceName: settings.instanceName,
      publicEndpoint: settings.publicEndpointOverride,
      cpuCapacity: settings.remoteSolverCpuBudget,
      cpuBudget: settings.remoteSolverCpuBudget,
      buildVersion:
        process.env.AIRFOILFOAM_BUILD_ID ??
        process.env.npm_package_version ??
        null,
      metadata: { engine: configuredEngineIdentity() },
    }),
  });
  const payload = (await res.json().catch(() => null)) as {
    authToken?: string;
    solver?: { id?: string };
  } | null;
  if (!res.ok || !payload?.solver?.id || !payload.authToken)
    throw new Error(`remote solver registration failed (${res.status})`);
  await db
    .update(syncApiSettings)
    .set({
      remoteSolverRegisteredId: payload.solver.id,
      remoteSolverAuthToken: payload.authToken,
      remoteSolverLastStatus: "idle",
      remoteSolverLastError: null,
      updatedAt: new Date(),
    })
    .where(eq(syncApiSettings.id, 1));
  settings.remoteSolverRegisteredId = payload.solver.id;
  settings.remoteSolverAuthToken = payload.authToken;
  return payload.solver.id;
}

async function heartbeat(
  settings: Settings,
  status: Settings["remoteSolverLastStatus"],
  activePromiseCount: number,
  activeAoaCount: number,
) {
  if (!settings.remoteSolverRegisteredId) return;
  await fetch(
    `${syncBase(settings)}/solvers/${settings.remoteSolverRegisteredId}/heartbeat`,
    {
      method: "POST",
      signal: AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
      headers: headers(settings),
      body: JSON.stringify({
        status,
        activePromiseCount,
        activeAoaCount,
        cpuCapacity: settings.remoteSolverCpuBudget,
        cpuBudget: settings.remoteSolverCpuBudget,
      }),
    },
  ).catch(() => undefined);
}

async function activeRemoteJobs(db: DB) {
  const jobs = await db
    .select()
    .from(simJobs)
    .where(
      or(
        inArray(simJobs.status, [
          "pending",
          "submitted",
          "running",
          "ingesting",
        ]),
        and(
          eq(simJobs.status, "cancelled"),
          inArray(simJobs.engineState, ["cancelling", "cancel_pending"]),
        ),
      ),
    );
  return jobs.filter((job) =>
    Boolean(
      (job.requestPayload as { syncPromiseId?: string } | null)?.syncPromiseId,
    ),
  );
}

async function remotePromiseWorkState(
  db: DB,
  promiseId: string,
): Promise<RemotePromiseWorkState> {
  const rows = await db
    .select({
      aoaDeg: syncSweepPromisePoints.aoaDeg,
      pointStatus: syncSweepPromisePoints.status,
      resultId: results.id,
      resultStatus: results.status,
      retryState: simResultSubmitRetries.state,
      retryAt: simResultSubmitRetries.nextAttemptAt,
      precalcState: simPrecalcObligations.state,
      precalcNextSubmitAt: simPrecalcObligations.nextSubmitAt,
    })
    .from(syncSweepPromisePoints)
    .leftJoin(
      results,
      and(
        eq(results.airfoilId, syncSweepPromisePoints.airfoilId),
        eq(
          results.simulationPresetRevisionId,
          syncSweepPromisePoints.simulationPresetRevisionId,
        ),
        eq(results.aoaDeg, syncSweepPromisePoints.aoaDeg),
      ),
    )
    .leftJoin(
      simResultSubmitRetries,
      eq(simResultSubmitRetries.resultId, results.id),
    )
    .leftJoin(
      simPrecalcObligations,
      and(
        eq(simPrecalcObligations.airfoilId, syncSweepPromisePoints.airfoilId),
        eq(
          simPrecalcObligations.revisionId,
          syncSweepPromisePoints.simulationPresetRevisionId,
        ),
        eq(simPrecalcObligations.aoaDeg, syncSweepPromisePoints.aoaDeg),
      ),
    )
    .where(eq(syncSweepPromisePoints.promiseId, promiseId));

  const now = Date.now();
  const activeRows = rows.filter((row) => row.pointStatus === "active");
  const dueAoas: number[] = [];
  let waitingUntil: Date | null = null;
  let busy = false;
  let completed = false;
  let terminal = false;
  for (const row of activeRows) {
    // A physical preliminary obligation is the scheduling authority for this
    // natural cell. Never downgrade it back into a mirrored wave-1 RANS shell;
    // the FAST lane either submits it now or keeps the promise waiting.
    if (row.precalcState === "pending") {
      if (row.precalcNextSubmitAt && row.precalcNextSubmitAt.getTime() > now) {
        if (
          !waitingUntil ||
          row.precalcNextSubmitAt.getTime() < waitingUntil.getTime()
        )
          waitingUntil = row.precalcNextSubmitAt;
      } else {
        busy = true;
      }
      continue;
    }
    if (row.precalcState === "running") {
      busy = true;
      continue;
    }
    if (row.precalcState === "blocked") {
      terminal = true;
      continue;
    }
    if (row.precalcState === "satisfied") {
      completed = true;
      continue;
    }
    if (!row.resultId) {
      dueAoas.push(Number(row.aoaDeg));
      continue;
    }
    if (["pending", "stale"].includes(row.resultStatus ?? "")) {
      if (row.retryState === "blocked") {
        terminal = true;
        continue;
      }
      if (
        row.retryState === "retry_wait" &&
        row.retryAt &&
        row.retryAt.getTime() > now
      ) {
        if (!waitingUntil || row.retryAt < waitingUntil)
          waitingUntil = row.retryAt;
        continue;
      }
      dueAoas.push(Number(row.aoaDeg));
      continue;
    }
    if (["queued", "running"].includes(row.resultStatus ?? "")) {
      busy = true;
      continue;
    }
    if (row.resultStatus === "done") {
      completed = true;
      continue;
    }
    terminal = true;
  }
  return {
    dueAoas: [...new Set(dueAoas)].sort((a, b) => a - b),
    requestedAoas: [...new Set(rows.map((row) => Number(row.aoaDeg)))].sort(
      (a, b) => a - b,
    ),
    waitingUntil,
    busy,
    completed,
    terminal,
    activePointCount: activeRows.length,
  };
}

async function expireMirroredRemotePromises(
  db: DB,
  settings: Settings,
): Promise<void> {
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const expired = await tx
      .update(syncSweepPromises)
      .set({
        status: "expired",
        expiredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncSweepPromises.status, "active"),
          eq(syncSweepPromises.sourceBaseUrl, syncBase(settings)),
          sql`${syncSweepPromises.expiresAt} <= now()`,
          sql`${syncSweepPromises.requestPayload} ->> 'remoteSolver' = 'true'`,
        ),
      )
      .returning({ id: syncSweepPromises.id });
    if (!expired.length) return;
    await tx
      .update(syncSweepPromisePoints)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        and(
          inArray(
            syncSweepPromisePoints.promiseId,
            expired.map((row) => row.id),
          ),
          eq(syncSweepPromisePoints.status, "active"),
        ),
      );
  });
}

async function mirroredRemotePromiseIds(
  db: DB,
  settings: Settings,
): Promise<string[]> {
  const rows = await db
    .select({ id: syncSweepPromises.id })
    .from(syncSweepPromises)
    .where(
      and(
        eq(syncSweepPromises.status, "active"),
        eq(syncSweepPromises.sourceBaseUrl, syncBase(settings)),
        sql`${syncSweepPromises.expiresAt} > now()`,
        sql`${syncSweepPromises.requestPayload} ->> 'remoteSolver' = 'true'`,
      ),
    )
    .orderBy(syncSweepPromises.createdAt, syncSweepPromises.id);
  return rows.map((row) => row.id);
}

async function cancelAuthoritativelyExpiredPromise(
  db: DB,
  engine: EngineClient,
  promiseId: string,
  reason: string,
): Promise<void> {
  const jobs = await db
    .select()
    .from(simJobs)
    .where(
      and(
        sql`${simJobs.requestPayload} ->> 'syncPromiseId' = ${promiseId}`,
        inArray(simJobs.status, [
          "pending",
          "submitted",
          "running",
          "ingesting",
        ]),
      ),
    );
  for (const job of jobs) {
    let engineState: "cancelled" | "cancel_pending" = "cancelled";
    let error = reason;
    if (job.engineJobId && job.status !== "pending") {
      try {
        await engine.cancelJob(job.engineJobId);
      } catch (cancelError) {
        engineState = "cancel_pending";
        error = `${reason}; engine cancellation pending: ${
          cancelError instanceof Error
            ? cancelError.message
            : String(cancelError)
        }`;
      }
    }
    await db
      .update(simJobs)
      .set({
        status: "cancelled",
        engineState,
        error,
        finishedAt: new Date(),
      })
      .where(eq(simJobs.id, job.id));
  }
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await tx
      .update(syncSweepPromises)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        responsePayload: { authoritativeLeaseLoss: true, error: reason },
        updatedAt: new Date(),
      })
      .where(eq(syncSweepPromises.id, promiseId));
    await tx
      .update(syncSweepPromisePoints)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(syncSweepPromisePoints.promiseId, promiseId));
    await tx
      .update(syncRemoteResultDeliveries)
      .set({
        state: "superseded",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        lastError: reason,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncRemoteResultDeliveries.promiseId, promiseId),
          inArray(syncRemoteResultDeliveries.state, [
            "pending",
            "pushing",
            "retry_wait",
            "blocked",
          ]),
        ),
      );
  });
}

class RemotePromiseTransferLeaseError extends Error {
  constructor(
    message: string,
    readonly authoritative: boolean,
  ) {
    super(message);
    this.name = "RemotePromiseTransferLeaseError";
  }
}

async function renewExactRemotePromiseTransferLease(
  db: DB,
  engine: EngineClient,
  settings: Settings,
  promiseId: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(
      `${syncBase(settings)}/sweeps/${promiseId}/heartbeat`,
      {
        method: "POST",
        signal: AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
        headers: headers(settings),
        body: JSON.stringify({ ttlHours: REMOTE_TRANSFER_PROMISE_TTL_HOURS }),
      },
    );
  } catch (error) {
    throw new RemotePromiseTransferLeaseError(
      `remote promise ${promiseId} transfer lease renewal failed transiently: ${
        error instanceof Error ? error.message : String(error)
      }`,
      false,
    );
  }
  if (response.status === 404 || response.status === 409) {
    const reason = `up-tier authoritatively rejected promise ${promiseId} transfer lease renewal (${response.status})`;
    await cancelAuthoritativelyExpiredPromise(db, engine, promiseId, reason);
    throw new RemotePromiseTransferLeaseError(reason, true);
  }
  if (!response.ok) {
    throw new RemotePromiseTransferLeaseError(
      `remote promise ${promiseId} transfer lease renewal failed transiently (${response.status})`,
      false,
    );
  }
  const payload = (await response.json().catch(() => null)) as {
    expiresAt?: unknown;
  } | null;
  const expiresAt =
    typeof payload?.expiresAt === "string" ? new Date(payload.expiresAt) : null;
  if (
    !expiresAt ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= new Date()
  ) {
    throw new RemotePromiseTransferLeaseError(
      `remote promise ${promiseId} transfer lease renewal omitted a live expiry`,
      false,
    );
  }
  const updated = await db
    .update(syncSweepPromises)
    .set({ expiresAt, lastHeartbeatAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(syncSweepPromises.id, promiseId),
        eq(syncSweepPromises.status, "active"),
      ),
    )
    .returning({ id: syncSweepPromises.id });
  if (updated.length !== 1) {
    throw new RemotePromiseTransferLeaseError(
      `local ownership of remote promise ${promiseId} ended during transfer lease renewal`,
      true,
    );
  }
}

interface RemotePromiseTransferLease {
  signal: AbortSignal;
  throwIfFailed: () => void;
  stop: () => Promise<Error | null>;
}

interface RemoteReclaimClaimLease {
  signal: AbortSignal;
  throwIfFailed: () => void;
  stop: () => Promise<Error | null>;
}

/** Renew the exact claim token independently of archive byte progress. A
 * preflight may legitimately stream for hours; the 10-minute claim therefore
 * cannot be a one-shot expiry that another sweeper can steal mid-read. */
export function startRemoteReclaimClaimLease(
  db: DB,
  claim: { id: string; token: string },
): RemoteReclaimClaimLease {
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let failure: Error | null = null;
  const renew = async () => {
    const updated = await db
      .update(syncRemoteHubBindingReceipts)
      .set({
        reclaimClaimExpiresAt: new Date(Date.now() + REMOTE_RECLAIM_CLAIM_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncRemoteHubBindingReceipts.id, claim.id),
          eq(syncRemoteHubBindingReceipts.reclaimState, "claiming"),
          eq(syncRemoteHubBindingReceipts.reclaimClaimToken, claim.token),
        ),
      )
      .returning({ id: syncRemoteHubBindingReceipts.id });
    if (updated.length !== 1)
      throw new Error(
        "brokered evidence reclaim claim expired or changed during preflight",
      );
  };
  const schedule = () => {
    if (stopped || failure) return;
    timer = setTimeout(() => {
      inFlight = renew()
        .catch((error) => {
          failure = error instanceof Error ? error : new Error(String(error));
          if (!controller.signal.aborted) controller.abort(failure);
        })
        .finally(() => {
          inFlight = null;
          schedule();
        });
    }, REMOTE_RECLAIM_CLAIM_RENEW_INTERVAL_MS);
    timer.unref?.();
  };
  schedule();
  return {
    signal: controller.signal,
    throwIfFailed: () => {
      if (failure) throw failure;
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      return failure;
    },
  };
}

/** Keep a potentially multi-hour GCS or multipart transfer claimed. Normal
 * deliveries also renew the exact active upstream promise. An exact maintenance
 * replay for a locally fulfilled promise renews only the delivery claim: it has
 * no new solver-work lease to extend, and the hub revalidates its immutable
 * result/attempt identity before accepting the upgraded archive. */
export async function startRemotePromiseTransferLease(
  db: DB,
  engine: EngineClient,
  settings: Settings,
  promiseId: string,
  onRenew: () => Promise<void>,
  opts: { renewUpstreamPromise?: boolean } = {},
): Promise<RemotePromiseTransferLease> {
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let failure: Error | null = null;
  const renew = async () => {
    if (opts.renewUpstreamPromise !== false) {
      await renewExactRemotePromiseTransferLease(
        db,
        engine,
        settings,
        promiseId,
      );
    }
    await onRenew();
  };
  const schedule = () => {
    if (stopped || failure) return;
    timer = setTimeout(() => {
      inFlight = renew()
        .catch((error) => {
          failure = error instanceof Error ? error : new Error(String(error));
          if (!controller.signal.aborted) controller.abort(failure);
        })
        .finally(() => {
          inFlight = null;
          schedule();
        });
    }, REMOTE_TRANSFER_PROMISE_RENEW_INTERVAL_MS);
    timer.unref?.();
  };
  await renew();
  schedule();
  return {
    signal: controller.signal,
    throwIfFailed: () => {
      if (failure) throw failure;
    },
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      return failure;
    },
  };
}

async function renewMirroredPromiseLeases(
  db: DB,
  engine: EngineClient,
  settings: Settings,
): Promise<void> {
  const intervalMs = Math.max(
    5_000,
    settings.remoteSolverHeartbeatIntervalSeconds * 1_000,
  );
  const rows = await db
    .select({
      id: syncSweepPromises.id,
      expiresAt: syncSweepPromises.expiresAt,
      lastHeartbeatAt: syncSweepPromises.lastHeartbeatAt,
    })
    .from(syncSweepPromises)
    .where(
      and(
        eq(syncSweepPromises.status, "active"),
        eq(syncSweepPromises.sourceBaseUrl, syncBase(settings)),
        sql`${syncSweepPromises.requestPayload} ->> 'remoteSolver' = 'true'`,
        sql`(
          ${syncSweepPromises.lastHeartbeatAt} IS NULL
          OR ${syncSweepPromises.lastHeartbeatAt} <= now() - (${intervalMs}::double precision * interval '1 millisecond')
          OR ${syncSweepPromises.expiresAt} <= now() + (${intervalMs * 2}::double precision * interval '1 millisecond')
        )`,
      ),
    )
    .orderBy(syncSweepPromises.expiresAt, syncSweepPromises.id)
    .limit(100);
  for (const promise of rows) {
    let response: Response;
    try {
      response = await fetch(
        `${syncBase(settings)}/sweeps/${promise.id}/heartbeat`,
        {
          method: "POST",
          signal: AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
          headers: headers(settings),
          body: JSON.stringify({}),
        },
      );
    } catch (error) {
      throw new Error(
        `remote promise ${promise.id} heartbeat failed transiently: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (response.status === 404 || response.status === 409) {
      await cancelAuthoritativelyExpiredPromise(
        db,
        engine,
        promise.id,
        `up-tier rejected promise lease renewal (${response.status})`,
      );
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `remote promise ${promise.id} heartbeat failed (${response.status})`,
      );
    }
    const payload = (await response.json().catch(() => null)) as {
      expiresAt?: unknown;
    } | null;
    const expiresAt =
      typeof payload?.expiresAt === "string"
        ? new Date(payload.expiresAt)
        : null;
    if (!expiresAt || !Number.isFinite(expiresAt.getTime())) {
      throw new Error(
        `remote promise ${promise.id} heartbeat omitted a valid expiry`,
      );
    }
    await db
      .update(syncSweepPromises)
      .set({ expiresAt, lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(syncSweepPromises.id, promise.id),
          eq(syncSweepPromises.status, "active"),
        ),
      );
  }
}

async function cancelMirroredRemotePromise(
  db: DB,
  settings: Settings,
  promiseId: string,
  error: string,
): Promise<void> {
  // Stop local ownership first, then durably enqueue the upstream release.
  // A failed HTTP attempt remains retryable in the outbox; the local heartbeat
  // loop must never keep an AoA leased after deterministic terminal rejection.
  const queued = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const cancelled = await tx
      .update(syncSweepPromises)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        responsePayload: { submitBlocked: true, error },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncSweepPromises.id, promiseId),
          inArray(syncSweepPromises.status, ["active", "expired"]),
        ),
      )
      .returning({ id: syncSweepPromises.id });
    if (!cancelled.length) {
      const [existing] = await tx
        .select({ promiseId: syncRemotePromiseCancellations.promiseId })
        .from(syncRemotePromiseCancellations)
        .where(eq(syncRemotePromiseCancellations.promiseId, promiseId))
        .limit(1);
      return Boolean(existing);
    }
    await tx
      .update(syncSweepPromisePoints)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(syncSweepPromisePoints.promiseId, promiseId),
          eq(syncSweepPromisePoints.status, "active"),
        ),
      );
    await tx
      .insert(syncRemotePromiseCancellations)
      .values({ promiseId, state: "pending", nextAttemptAt: sql`now()` })
      .onConflictDoNothing({
        target: syncRemotePromiseCancellations.promiseId,
      });
    await tx
      .update(syncRemoteResultDeliveries)
      .set({
        state: "superseded",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        lastError: error,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncRemoteResultDeliveries.promiseId, promiseId),
          inArray(syncRemoteResultDeliveries.state, [
            "pending",
            "pushing",
            "retry_wait",
            "blocked",
          ]),
        ),
      );
    return true;
  });
  if (queued && settings.remoteSolverAuthToken) {
    await processPendingPromiseCancellations(db, settings, promiseId);
  }
}

async function cancelMirroredPromisesForDisabledSolver(
  db: DB,
  engine: EngineClient,
  settings: Settings,
): Promise<void> {
  const promises = await db
    .select({ id: syncSweepPromises.id })
    .from(syncSweepPromises)
    .where(
      and(
        inArray(syncSweepPromises.status, ["active", "expired"]),
        sql`${syncSweepPromises.requestPayload} ->> 'remoteSolver' = 'true'`,
      ),
    )
    .orderBy(syncSweepPromises.createdAt, syncSweepPromises.id);
  for (const promise of promises) {
    const reason = "remote solver disabled before the mirrored promise settled";
    await cancelMirroredRemotePromise(db, settings, promise.id, reason);
    await cancelAuthoritativelyExpiredPromise(db, engine, promise.id, reason);
  }
}

async function processPendingPromiseCancellations(
  db: DB,
  settings: Settings,
  onlyPromiseId?: string,
): Promise<void> {
  const rows = await db
    .select({
      promiseId: syncRemotePromiseCancellations.promiseId,
      state: syncRemotePromiseCancellations.state,
      attemptCount: syncRemotePromiseCancellations.attemptCount,
      sourceBaseUrl: syncSweepPromises.sourceBaseUrl,
    })
    .from(syncRemotePromiseCancellations)
    .innerJoin(
      syncSweepPromises,
      eq(syncSweepPromises.id, syncRemotePromiseCancellations.promiseId),
    )
    .where(
      and(
        inArray(syncRemotePromiseCancellations.state, [
          "pending",
          "retry_wait",
        ]),
        sql`${syncRemotePromiseCancellations.nextAttemptAt} <= now()`,
        onlyPromiseId
          ? eq(syncRemotePromiseCancellations.promiseId, onlyPromiseId)
          : undefined,
      ),
    )
    .orderBy(
      syncRemotePromiseCancellations.nextAttemptAt,
      syncRemotePromiseCancellations.promiseId,
    )
    .limit(100);
  for (const row of rows) {
    let response: Response | null = null;
    let failure: string | null = null;
    try {
      const hubBaseUrl = syncBase(settings);
      if (!row.sourceBaseUrl) {
        throw new Error(
          `remote promise ${row.promiseId} has no stored authority endpoint`,
        );
      }
      if (row.sourceBaseUrl !== hubBaseUrl) {
        throw new Error(
          `remote promise ${row.promiseId} cancellation authority no longer matches the configured hub`,
        );
      }
      response = await fetch(`${hubBaseUrl}/sweeps/${row.promiseId}/cancel`, {
        method: "POST",
        signal: AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
        headers: headers(settings),
        // headers() declares JSON for every sync call. Fastify correctly
        // rejects an empty body with that content type before the cancellation
        // route runs, so send the route's explicit empty object payload.
        body: JSON.stringify({}),
      });
      if (!response.ok && response.status !== 404) {
        failure = `remote promise cancellation failed (${response.status})`;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (!failure && response) {
      await db
        .update(syncRemotePromiseCancellations)
        .set({
          state: "delivered",
          attemptCount: row.attemptCount + 1,
          lastHttpStatus: response.status,
          lastError: null,
          deliveredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncRemotePromiseCancellations.promiseId, row.promiseId),
            inArray(syncRemotePromiseCancellations.state, [
              "pending",
              "retry_wait",
            ]),
          ),
        );
      continue;
    }
    const delayMs = Math.min(
      15 * 60_000,
      30_000 * 2 ** Math.min(5, row.attemptCount),
    );
    await db
      .update(syncRemotePromiseCancellations)
      .set({
        state: "retry_wait",
        attemptCount: row.attemptCount + 1,
        nextAttemptAt: sql`now() + (${delayMs}::bigint * interval '1 millisecond')`,
        lastHttpStatus: response?.status ?? null,
        lastError: failure,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncRemotePromiseCancellations.promiseId, row.promiseId),
          inArray(syncRemotePromiseCancellations.state, [
            "pending",
            "retry_wait",
          ]),
        ),
      );
  }
}

async function composeRemotePromiseJob(
  db: DB,
  settings: Settings,
  promiseId: string,
  meshRecoveryVersion: number,
): Promise<
  | {
      kind: "composed";
      jobId: string;
      request: Parameters<EngineClient["submitPolar"]>[0];
    }
  | { kind: "busy"; state: RemotePromiseWorkState }
  | { kind: "waiting"; state: RemotePromiseWorkState }
  | { kind: "terminal"; state: RemotePromiseWorkState }
  | { kind: "stopped" }
> {
  const [promise] = await db
    .select()
    .from(syncSweepPromises)
    .where(eq(syncSweepPromises.id, promiseId))
    .limit(1);
  if (
    !promise ||
    promise.status !== "active" ||
    promise.expiresAt.getTime() <= Date.now() ||
    promise.sourceBaseUrl !== syncBase(settings) ||
    (promise.requestPayload as { remoteSolver?: boolean } | null)
      ?.remoteSolver !== true
  )
    return { kind: "stopped" };

  const [airfoil] = await db
    .select()
    .from(airfoils)
    .where(eq(airfoils.id, promise.airfoilId))
    .limit(1);
  const [revision] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, promise.simulationPresetRevisionId))
    .limit(1);
  if (!airfoil || !revision) return { kind: "stopped" };
  const setup = revision.snapshot as unknown as SimulationSetupSnapshot;
  const executionPool = await requireExecutionPoolForSetup(db, setup);
  const bcId = setup.preset.legacyBoundaryConditionId;
  if (!bcId)
    throw new Error(
      `remote promise ${promiseId} has no local compatibility boundary condition`,
    );

  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const locked = (await tx.execute(sql`
      SELECT remote_promise.id
      FROM sync_sweep_promises remote_promise
      WHERE remote_promise.id = ${promiseId}
        AND remote_promise.status = 'active'
        AND remote_promise."expiresAt" > now()
        AND remote_promise.source_base_url = ${syncBase(settings)}
        AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
      FOR UPDATE OF remote_promise
    `)) as unknown as Array<{ id: string }>;
    if (!locked[0]) return { kind: "stopped" as const };

    const activeJobs = (await tx.execute(sql`
      SELECT job.id
      FROM sim_jobs job
      WHERE job.request_payload ->> 'syncPromiseId' = ${promiseId}
        AND (
          job.status IN ('pending', 'submitted', 'running', 'ingesting')
          OR (
            job.status = 'cancelled'
            AND job.engine_state IN ('cancelling', 'cancel_pending')
          )
        )
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (activeJobs[0]) {
      return {
        kind: "busy" as const,
        state: await remotePromiseWorkState(tx, promiseId),
      };
    }

    const state = await remotePromiseWorkState(tx, promiseId);
    if (!state.dueAoas.length) {
      const kind = state.waitingUntil
        ? "waiting"
        : state.busy || state.completed
          ? "busy"
          : "terminal";
      return { kind, state } as const;
    }

    const { request, speed } = buildPolarRequest({
      airfoil,
      setup,
      aoaList: state.dueAoas,
      wave: 1,
      ransFailurePolicy:
        state.requestedAoas.length > 1 ? "abort_for_precalc" : "continue",
    });
    request.expected_execution_pool = executionPool.routingKey;
    request.expected_mesh_recovery_version = meshRecoveryVersion;
    request.resources = {
      ...(request.resources ?? {}),
      cpu_budget:
        settings.remoteSolverCpuBudget || request.resources?.cpu_budget,
    };
    const payload = {
      remoteSolver: true,
      syncPromiseId: promiseId,
      upstreamBaseUrl: syncBase(settings),
      speedMap: [
        {
          speed,
          bcId,
          presetRevisionId: revision.id,
          mach: setup.flowState.mach,
        },
      ],
      aoas: state.dueAoas,
      ransRetryScope: retryScopeForRequestedPolar(state.requestedAoas),
      meshRecoveryVersion,
      resources: request.resources,
      setupSnapshot: setup,
    };
    const [job] = await tx
      .insert(simJobs)
      .values({
        airfoilId: airfoil.id,
        bcIds: [bcId],
        simulationPresetRevisionId: revision.id,
        solverImplementationId: solverImplementationIdForSetup(setup),
        solverExecutionPoolId: executionPool.id,
        methodKey: "openfoam.rans",
        referenceChordM: setup.referenceGeometry.referenceLengthM,
        wave: 1,
        jobKind: state.dueAoas.length <= 3 ? "targeted" : "sweep",
        status: "pending",
        totalCases: state.dueAoas.length,
        requestPayload: payload,
      })
      .returning({ id: simJobs.id });
    const claimed = await claimAoas(
      tx,
      airfoil.id,
      bcId,
      revision.id,
      state.dueAoas,
      job.id,
    );
    if (!claimed.length) {
      await tx
        .update(simJobs)
        .set({
          status: "cancelled",
          engineState: "cancelled",
          error: "remote promise had no locally claimable AoAs",
          finishedAt: new Date(),
        })
        .where(eq(simJobs.id, job.id));
      return { kind: "busy" as const, state };
    }
    if (claimed.length !== state.dueAoas.length) {
      await tx
        .update(simJobs)
        .set({
          totalCases: claimed.length,
          jobKind: claimed.length <= 3 ? "targeted" : "sweep",
          requestPayload: { ...payload, aoas: claimed },
        })
        .where(eq(simJobs.id, job.id));
    }
    request.aoa = { angles: claimed };
    return { kind: "composed" as const, jobId: job.id, request };
  });
}

async function submitMirroredRemotePromise(
  db: DB,
  engine: EngineClient,
  settings: Settings,
  promiseId: string,
  meshRecoveryVersion: number,
): Promise<RemotePromiseSubmitResult> {
  if (engineBackoffActive()) {
    const error = `remote engine submit for promise ${promiseId} is waiting for the shared connection backoff`;
    await setStatus(db, "error", error);
    return { kind: "waiting" };
  }
  const composition = await composeRemotePromiseJob(
    db,
    settings,
    promiseId,
    meshRecoveryVersion,
  );
  if (composition.kind === "stopped") {
    return { kind: "stopped", error: "remote promise is no longer active" };
  }
  if (composition.kind === "waiting") {
    const retryAt = composition.state.waitingUntil?.toISOString() ?? "later";
    await setStatus(
      db,
      "error",
      `remote engine submit retry for promise ${promiseId} is waiting until ${retryAt}`,
    );
    return { kind: "waiting" };
  }
  if (composition.kind === "busy") {
    await setStatus(db, "solving", null);
    return { kind: "busy" };
  }
  if (composition.kind === "terminal") {
    const error = `remote promise ${promiseId} has no retryable claimed cells`;
    await cancelMirroredRemotePromise(db, settings, promiseId, error);
    await setStatus(db, "error", error);
    return { kind: "terminal", error };
  }

  const outcome = await submitPendingJobWithLifecycleGuard({
    db,
    engine,
    jobId: composition.jobId,
    admissionLane: "remote",
    request: composition.request,
    connectionErrorPrefix: "remote engine unreachable at submit: ",
    submitErrorPrefix: "remote engine submit failed: ",
  });
  if (outcome.kind === "submitted") {
    await clearEngineUnreachable(db);
    await setStatus(db, "solving", null, {
      remoteSolverLastPromiseAt: new Date(),
    });
    return { kind: "submitted" };
  }
  if (outcome.kind === "submission_in_progress") {
    await setStatus(db, "solving", null);
    return { kind: "busy" };
  }
  if (outcome.kind === "connection_failure") {
    const error = `remote engine unreachable at submit: ${outcome.error}`;
    await recordEngineUnreachable(db);
    await setStatus(db, "error", error);
    return { kind: "stopped", error };
  }
  if (outcome.kind === "lifecycle_stopped") {
    await setStatus(db, "error", outcome.error);
    return { kind: "stopped", error: outcome.error };
  }

  // An answered rejection proves the engine is reachable even though it did
  // not accept this request; do not retain a stale connection backoff.
  await clearEngineUnreachable(db);
  const state = await remotePromiseWorkState(db, promiseId);
  if (state.waitingUntil) {
    const error = `remote engine submit failed: ${outcome.error}; one retry is waiting until ${state.waitingUntil.toISOString()}`;
    await setStatus(db, "error", error);
    return { kind: "waiting" };
  }
  const error = `remote engine submit blocked: ${outcome.error}`;
  await cancelMirroredRemotePromise(db, settings, promiseId, error);
  await setStatus(db, "error", error);
  return { kind: "terminal", error };
}

async function claimRemoteWork(
  db: DB,
  engine: EngineClient,
  settings: Settings,
  meshRecoveryVersion: number,
): Promise<RemotePromiseSubmitResult | null> {
  const solverId =
    settings.remoteSolverRegisteredId ?? (await registerSolver(db, settings));
  await setStatus(db, "claiming", null);
  const res = await fetch(`${syncBase(settings)}/sweeps/claim`, {
    method: "POST",
    signal: AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
    headers: headers(settings),
    body: JSON.stringify({ solverId, limit: settings.remoteSolverClaimSize }),
  });
  const payload = (await res
    .json()
    .catch(() => null)) as RemoteClaimResponse | null;
  if (!res.ok) throw new Error(`remote sweep claim failed (${res.status})`);
  if (!payload?.promise) {
    await setStatus(db, "idle", null);
    return null;
  }
  const claim = payload.promise;
  const airfoil = await ensureRemoteAirfoil(db, claim);
  const setup = await ensureRemoteRevision(db, claim, settings);
  await db
    .insert(syncSweepPromises)
    .values({
      id: claim.id,
      sourceInstanceId: "upstream",
      sourceInstanceName: "Up-tier",
      sourceBaseUrl: syncBase(settings),
      airfoilId: airfoil.id,
      simulationPresetRevisionId: setup.revision.id,
      aoaCount: claim.aoas.length,
      expiresAt: new Date(claim.expiresAt),
      lastHeartbeatAt: new Date(),
      requestPayload: {
        remoteSolver: true,
        upstreamBaseUrl: syncBase(settings),
      },
    })
    .onConflictDoUpdate({
      target: syncSweepPromises.id,
      set: {
        expiresAt: new Date(claim.expiresAt),
        aoaCount: claim.aoas.length,
        lastHeartbeatAt: new Date(),
        updatedAt: new Date(),
      },
    });
  await db
    .insert(syncSweepPromisePoints)
    .values(
      claim.aoas.map((aoaDeg) => ({
        promiseId: claim.id,
        airfoilId: airfoil.id,
        simulationPresetRevisionId: setup.revision.id,
        aoaDeg,
      })),
    )
    .onConflictDoNothing();
  return submitMirroredRemotePromise(
    db,
    engine,
    settings,
    claim.id,
    meshRecoveryVersion,
  );
}

interface StreamUpload {
  fieldName: string;
  storageKey: string;
  mimeType: string;
}

function completedUploadGeneration(
  response: Response,
  payload: unknown,
): string | null {
  const validGeneration = (value: string) =>
    /^[1-9][0-9]{0,19}$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n;
  const header = response.headers.get("x-goog-generation");
  if (header && validGeneration(header)) return header;
  if (payload && typeof payload === "object") {
    const generation = (payload as Record<string, unknown>).generation;
    if (typeof generation === "string" && validGeneration(generation))
      return generation;
    if (
      typeof generation === "number" &&
      Number.isSafeInteger(generation) &&
      generation > 0
    )
      return String(generation);
  }
  return null;
}

function resumableOffset(response: Response): number {
  const range = response.headers.get("range");
  const matched = range?.match(/^bytes=0-([0-9]+)$/i);
  return matched ? Number(matched[1]) + 1 : 0;
}

class TerminalEvidenceUploadError extends Error {}

function rejectedRedirect(error: unknown): boolean {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if (current instanceof Error) messages.push(current.message);
    if (typeof current !== "object") break;
    current = (current as { cause?: unknown }).cause;
  }
  return messages.some((message) => /redirect/i.test(message));
}

function rejectUploadRedirect(response: Response): void {
  // 308 is GCS's documented "resume incomplete" response, not an HTTP
  // redirect in this protocol. Every other 3xx response is terminal.
  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.status !== 308
  ) {
    throw new TerminalEvidenceUploadError(
      `GCS resumable evidence upload rejected a redirect (${response.status})`,
    );
  }
}

/** Upload to an opaque GCS resumable capability without any Google
 * credential. The capability itself is never logged or persisted locally. */
export async function uploadBrokeredEvidenceFile(
  uploadUrl: string,
  expected: { bucket: string; objectKey: string },
  storageKey: string,
  totalBytes: number,
  onProgress: () => Promise<void>,
  transferSignal?: AbortSignal,
): Promise<string> {
  if (!isGcsResumableUploadUrl(uploadUrl, expected))
    throw new Error(
      "remote evidence broker returned an invalid GCS upload capability",
    );
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0)
    throw new Error("remote evidence bundle size is invalid");
  const path = join(MEDIA_DIR, storageKey);
  const source = await stat(path);
  if (!source.isFile() || source.size !== totalBytes)
    throw new Error(
      "remote evidence bundle bytes do not match the declared size",
    );
  const chunkBytes = 8 * 1024 * 1024;
  const absolute = AbortSignal.timeout(REMOTE_PUSH_ABSOLUTE_TIMEOUT_MS);
  let offset = 0;
  let transientFailures = 0;
  while (offset < totalBytes) {
    const end = Math.min(totalBytes - 1, offset + chunkBytes - 1);
    try {
      await onProgress();
      const response = await fetch(uploadUrl, {
        method: "PUT",
        // GCS uses 308 as the resumable protocol's normal "committed so far"
        // response. Native fetch classifies 308 as an HTTP redirect before the
        // caller can inspect it when redirect="error". Keep the response
        // observable and reject every non-protocol 3xx below.
        redirect: "manual",
        signal: AbortSignal.any([
          absolute,
          AbortSignal.timeout(REMOTE_PUSH_STALL_TIMEOUT_MS),
          ...(transferSignal ? [transferSignal] : []),
        ]),
        headers: {
          "content-type": "application/zstd",
          "content-length": String(end - offset + 1),
          "content-range": `bytes ${offset}-${end}/${totalBytes}`,
        },
        body: createReadStream(path, {
          start: offset,
          end,
        }) as unknown as RequestInit["body"],
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      await onProgress();
      rejectUploadRedirect(response);
      if (response.status === 308) {
        const next = resumableOffset(response);
        if (next <= offset || next > totalBytes)
          throw new Error(
            "GCS resumable upload returned an invalid committed range",
          );
        offset = next;
        transientFailures = 0;
        continue;
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok)
        throw new Error(
          `GCS resumable evidence upload failed (${response.status})`,
        );
      const generation = completedUploadGeneration(response, payload);
      if (!generation)
        throw new Error(
          "GCS resumable upload response omitted the exact generation",
        );
      return generation;
    } catch (error) {
      if (transferSignal?.aborted)
        throw transferSignal.reason instanceof Error
          ? transferSignal.reason
          : new Error("remote promise transfer lease ended during GCS upload");
      if (
        error instanceof TerminalEvidenceUploadError ||
        rejectedRedirect(error)
      )
        throw error;
      if (++transientFailures > 5) throw error;
      let query: Response;
      try {
        query = await fetch(uploadUrl, {
          method: "PUT",
          redirect: "manual",
          signal: AbortSignal.any([
            absolute,
            AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
            ...(transferSignal ? [transferSignal] : []),
          ]),
          headers: {
            "content-length": "0",
            "content-range": `bytes */${totalBytes}`,
          },
        });
        rejectUploadRedirect(query);
      } catch (queryError) {
        if (
          queryError instanceof TerminalEvidenceUploadError ||
          rejectedRedirect(queryError)
        )
          throw queryError;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(4_000, 250 * 2 ** transientFailures)),
        );
        continue;
      }
      if (query.status === 308) {
        offset = resumableOffset(query);
        continue;
      }
      const payload = await query.json().catch(() => null);
      if (query.ok) {
        const generation = completedUploadGeneration(query, payload);
        if (generation) return generation;
      }
      if (query.status === 404 || query.status === 410)
        throw new Error("GCS resumable evidence upload capability expired");
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(4_000, 250 * 2 ** transientFailures)),
      );
    }
  }
  throw new Error("GCS resumable upload ended without a generation");
}

async function* multipartPolarBody(
  boundary: string,
  manifest: unknown,
  uploads: StreamUpload[],
  onProgress: () => Promise<void>,
): AsyncGenerator<Buffer> {
  await onProgress();
  yield Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="manifest"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(manifest)}\r\n`,
  );
  for (const upload of uploads) {
    await onProgress();
    const filename = basename(upload.storageKey).replace(/["\r\n]/g, "_");
    yield Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${upload.fieldName}"; filename="${filename}"\r\nContent-Type: ${upload.mimeType}\r\n\r\n`,
    );
    for await (const chunk of createReadStream(
      join(MEDIA_DIR, upload.storageKey),
    )) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      await onProgress();
      yield buffer;
    }
    await onProgress();
    yield Buffer.from("\r\n");
  }
  await onProgress();
  yield Buffer.from(`--${boundary}--\r\n`);
}

function attemptForceHistory(
  attempt: typeof resultAttempts.$inferSelect,
): Record<string, unknown> | undefined {
  const evidence =
    attempt.evidencePayload && typeof attempt.evidencePayload === "object"
      ? (attempt.evidencePayload as Record<string, unknown>)
      : null;
  const raw = evidence?.force_history ?? evidence?.forceHistory;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const history = raw as Record<string, unknown>;
  if (
    !Array.isArray(history.t) ||
    !Array.isArray(history.cl) ||
    !Array.isArray(history.cd)
  )
    return undefined;
  return {
    t: history.t,
    cl: history.cl,
    cd: history.cd,
    cm: Array.isArray(history.cm) ? history.cm : null,
    clMean: history.clMean ?? history.cl_mean ?? attempt.cl,
    clRms: history.clRms ?? history.cl_rms ?? attempt.clStd,
    cdMean: history.cdMean ?? history.cd_mean ?? attempt.cd,
    cdRms: history.cdRms ?? history.cd_rms ?? attempt.cdStd,
    strouhal: history.strouhal ?? attempt.strouhal,
    sheddingFreqHz: history.shedding_freq_hz ?? history.sheddingFreqHz ?? null,
    sampleCount: history.samples ?? history.sampleCount ?? null,
  };
}

async function currentAttemptForResult(
  db: DB,
  _job: typeof simJobs.$inferSelect,
  result: typeof results.$inferSelect,
): Promise<typeof resultAttempts.$inferSelect> {
  if (!result.currentResultAttemptId) {
    throw new Error(
      `remote result ${result.id} has no accepted/provisional current attempt`,
    );
  }
  const [attempt] = await db
    .select()
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, result.currentResultAttemptId),
        eq(resultAttempts.resultId, result.id),
      ),
    )
    .limit(1);
  if (!attempt) {
    throw new Error(
      `remote result ${result.id} current-attempt ownership is invalid`,
    );
  }
  return attempt;
}

export interface DeliveryClaim {
  id: string;
  token: string;
  attemptCount: number;
  fulfilledReplay: boolean;
}

export async function claimResultDelivery(
  db: DB,
  promiseId: string,
  job: typeof simJobs.$inferSelect,
  result: typeof results.$inferSelect,
  attempt: typeof resultAttempts.$inferSelect,
): Promise<DeliveryClaim | null> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`remote-delivery:${promiseId}:${result.id}`}, 0))`,
    );
    if (job.wave === 1 && job.simulationPresetRevisionId) {
      const [promotion] = await tx
        .select({ id: simRansPolarPromotions.id })
        .from(simRansPolarPromotions)
        .where(
          and(
            eq(simRansPolarPromotions.parentJobId, job.id),
            eq(
              simRansPolarPromotions.revisionId,
              job.simulationPresetRevisionId,
            ),
            eq(simRansPolarPromotions.syncPromiseId, promiseId),
          ),
        )
        .limit(1);
      if (promotion) return null;
    }
    let [delivery] = await tx
      .select()
      .from(syncRemoteResultDeliveries)
      .where(
        and(
          eq(syncRemoteResultDeliveries.promiseId, promiseId),
          eq(syncRemoteResultDeliveries.resultId, result.id),
        ),
      )
      .for("update")
      .limit(1);
    if (!delivery) {
      [delivery] = await tx
        .insert(syncRemoteResultDeliveries)
        .values({
          promiseId,
          simJobId: job.id,
          resultId: result.id,
          resultAttemptId: attempt.id,
          aoaDeg: result.aoaDeg,
          generationKey: attempt.id,
          state: "pending",
        })
        .returning();
    } else if (delivery.generationKey !== attempt.id) {
      [delivery] = await tx
        .update(syncRemoteResultDeliveries)
        .set({
          simJobId: job.id,
          resultAttemptId: attempt.id,
          aoaDeg: result.aoaDeg,
          generationKey: attempt.id,
          state: "pending",
          attemptCount: 0,
          nextAttemptAt: new Date(),
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          lastHttpStatus: null,
          lastError: null,
          remoteConflictIds: [],
          deliveredAt: null,
          updatedAt: new Date(),
        })
        .where(eq(syncRemoteResultDeliveries.id, delivery.id))
        .returning();
    }
    const now = Date.now();
    if (
      ["delivered", "superseded", "blocked"].includes(delivery.state) ||
      (delivery.state === "retry_wait" &&
        delivery.nextAttemptAt.getTime() > now) ||
      (delivery.state === "pushing" &&
        delivery.claimExpiresAt &&
        delivery.claimExpiresAt.getTime() > now)
    ) {
      return null;
    }
    const [fulfilledReplay] = job.simulationPresetRevisionId
      ? await tx
          .select({ id: syncSweepPromisePoints.id })
          .from(syncSweepPromisePoints)
          .innerJoin(
            syncSweepPromises,
            eq(syncSweepPromises.id, syncSweepPromisePoints.promiseId),
          )
          .where(
            and(
              eq(syncSweepPromises.id, promiseId),
              eq(syncSweepPromises.status, "fulfilled"),
              eq(syncSweepPromisePoints.status, "fulfilled"),
              eq(syncSweepPromisePoints.airfoilId, job.airfoilId),
              eq(
                syncSweepPromisePoints.simulationPresetRevisionId,
                job.simulationPresetRevisionId,
              ),
              eq(syncSweepPromisePoints.aoaDeg, result.aoaDeg),
              eq(syncSweepPromisePoints.resultId, result.id),
              eq(syncSweepPromisePoints.resultAttemptId, attempt.id),
            ),
          )
          .limit(1)
      : [];
    const token = randomUUID();
    const [claimed] = await tx
      .update(syncRemoteResultDeliveries)
      .set({
        state: "pushing",
        claimToken: token,
        claimedAt: new Date(),
        claimExpiresAt: new Date(now + DELIVERY_CLAIM_MS),
        updatedAt: new Date(),
      })
      .where(eq(syncRemoteResultDeliveries.id, delivery.id))
      .returning({
        id: syncRemoteResultDeliveries.id,
        attemptCount: syncRemoteResultDeliveries.attemptCount,
      });
    return claimed
      ? { ...claimed, token, fulfilledReplay: Boolean(fulfilledReplay) }
      : null;
  });
}

export async function renewResultDeliveryClaim(
  db: DB,
  claim: DeliveryClaim,
): Promise<void> {
  const now = new Date();
  const renewed = await db
    .update(syncRemoteResultDeliveries)
    .set({
      claimExpiresAt: new Date(now.getTime() + DELIVERY_CLAIM_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(syncRemoteResultDeliveries.id, claim.id),
        eq(syncRemoteResultDeliveries.state, "pushing"),
        eq(syncRemoteResultDeliveries.claimToken, claim.token),
        gt(syncRemoteResultDeliveries.claimExpiresAt, now),
      ),
    )
    .returning({ id: syncRemoteResultDeliveries.id });
  if (renewed.length !== 1) {
    throw new Error(`remote delivery claim ${claim.id} was lost during upload`);
  }
}

async function assertSingleDeliverySettlement(
  rows: Array<{ id: string }>,
  claim: DeliveryClaim,
): Promise<void> {
  if (rows.length !== 1) {
    throw new Error(
      `remote delivery claim ${claim.id} expired or changed before settlement`,
    );
  }
}

export async function settleResultDelivery(
  db: DB,
  claim: DeliveryClaim,
  input:
    | { kind: "delivered" }
    | {
        kind: "retry";
        error: string;
        httpStatus?: number;
        conflictIds?: string[];
      }
    | {
        kind: "blocked";
        error: string;
        httpStatus?: number;
        conflictIds?: string[];
      },
): Promise<void> {
  const now = new Date();
  if (input.kind === "delivered") {
    const settled = await db
      .update(syncRemoteResultDeliveries)
      .set({
        state: "delivered",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        lastHttpStatus: 200,
        lastError: null,
        remoteConflictIds: [],
        deliveredAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(syncRemoteResultDeliveries.id, claim.id),
          eq(syncRemoteResultDeliveries.state, "pushing"),
          eq(syncRemoteResultDeliveries.claimToken, claim.token),
          gt(syncRemoteResultDeliveries.claimExpiresAt, now),
        ),
      )
      .returning({ id: syncRemoteResultDeliveries.id });
    await assertSingleDeliverySettlement(settled, claim);
    return;
  }
  const nextAttemptCount = claim.attemptCount + 1;
  const conflictRetry =
    input.kind === "retry" && Boolean(input.conflictIds?.length);
  const delayMs = conflictRetry
    ? Math.min(6 * 3600_000, 5 * 60_000 * 2 ** Math.min(6, claim.attemptCount))
    : Math.min(15 * 60_000, 30_000 * 2 ** Math.min(5, claim.attemptCount));
  const settled = await db
    .update(syncRemoteResultDeliveries)
    .set({
      state: input.kind === "blocked" ? "blocked" : "retry_wait",
      attemptCount: nextAttemptCount,
      nextAttemptAt:
        input.kind === "blocked" ? now : new Date(now.getTime() + delayMs),
      claimToken: null,
      claimedAt: null,
      claimExpiresAt: null,
      lastHttpStatus: input.httpStatus ?? null,
      lastError: input.error,
      remoteConflictIds: input.conflictIds ?? [],
      updatedAt: now,
    })
    .where(
      and(
        eq(syncRemoteResultDeliveries.id, claim.id),
        eq(syncRemoteResultDeliveries.state, "pushing"),
        eq(syncRemoteResultDeliveries.claimToken, claim.token),
        gt(syncRemoteResultDeliveries.claimExpiresAt, now),
      ),
    )
    .returning({ id: syncRemoteResultDeliveries.id });
  await assertSingleDeliverySettlement(settled, claim);
}

async function markRemoteJobDeliveryTerminal(
  db: DB,
  promiseId: string,
  jobId: string,
  state: "delivered" | "superseded" | "blocked",
  error: string | null = null,
): Promise<void> {
  await db
    .insert(syncRemoteResultDeliveries)
    .values({
      promiseId,
      simJobId: jobId,
      generationKey: `job:${jobId}`,
      state,
      lastError: error,
      deliveredAt: state === "delivered" ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [
        syncRemoteResultDeliveries.promiseId,
        syncRemoteResultDeliveries.simJobId,
      ],
      targetWhere: sql`${syncRemoteResultDeliveries.resultId} IS NULL`,
      set: {
        state,
        lastError: error,
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        deliveredAt: state === "delivered" ? new Date() : null,
        updatedAt: new Date(),
      },
    });
}

async function settleSuccessfulRemoteResultDelivery(
  db: DB,
  settings: Settings,
  claim: DeliveryClaim,
  promiseId: string,
  job: typeof simJobs.$inferSelect,
  result: typeof results.$inferSelect,
  resultAttemptId: string,
  signedReceipt: SignedHubBindingReceipt,
): Promise<"delivered" | "superseded"> {
  const revisionId = job.simulationPresetRevisionId;
  if (!revisionId)
    throw new Error(`remote job ${job.id} has no immutable setup revision`);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const pointRows = (await tx.execute(sql`
      SELECT promise_point.id
      FROM sync_sweep_promises promise
      JOIN sync_sweep_promise_points promise_point
        ON promise_point.promise_id = promise.id
      WHERE promise.id = ${promiseId}
        AND promise_point.airfoil_id = ${job.airfoilId}
        AND promise_point.simulation_preset_revision_id = ${revisionId}
        AND promise_point.aoa_deg = ${result.aoaDeg}
        AND promise_point.status IN ('active', 'expired', 'fulfilled')
      ORDER BY promise.id, promise_point.id
      FOR UPDATE OF promise, promise_point
    `)) as unknown as Array<{ id: string }>;
    if (pointRows.length !== 1) {
      throw new Error(
        `remote result ${result.id} at ${result.aoaDeg}° is outside mirrored promise ${promiseId}`,
      );
    }
    const [promotion] = await tx
      .select({ id: simRansPolarPromotions.id })
      .from(simRansPolarPromotions)
      .where(
        and(
          eq(simRansPolarPromotions.parentJobId, job.id),
          eq(simRansPolarPromotions.revisionId, revisionId),
          eq(simRansPolarPromotions.syncPromiseId, promiseId),
        ),
      )
      .limit(1);
    const now = new Date();
    const [delivery] = await tx
      .select({
        id: syncRemoteResultDeliveries.id,
        state: syncRemoteResultDeliveries.state,
      })
      .from(syncRemoteResultDeliveries)
      .where(eq(syncRemoteResultDeliveries.id, claim.id))
      .for("update")
      .limit(1);
    const bundles = await tx
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, result.id),
          eq(solverEvidenceArtifacts.resultAttemptId, resultAttemptId),
          eq(solverEvidenceArtifacts.kind, "engine_bundle"),
        ),
      );
    if (bundles.length !== 1)
      throw new Error(
        `remote result ${result.id} cannot bind one exact local engine bundle`,
      );
    const hubBaseUrl = syncBase(settings);
    const bundle = bundles[0]!;
    const remoteReference = {
      localKind: "evidence_artifact",
      localRowId: bundle.id,
      localStorageKey: bundle.storageKey,
      resultId: result.id,
      resultAttemptId,
      sourceInstanceId: null,
      sourceInstanceName: "authoritative remote solver hub",
      remoteResultId: signedReceipt.receipt.canonical.resultId,
      remoteArtifactId: signedReceipt.receipt.canonical.artifactId,
      remoteDownloadUrl: new URL(
        `/api/sync/v1/evidence-uploads/${signedReceipt.receipt.brokeredUploadId}/download`,
        hubBaseUrl,
      ).toString(),
      remoteRenderUrl: null,
      sha256: signedReceipt.receipt.remote.storedSha256,
      byteSize: signedReceipt.receipt.remote.storedByteSize,
      mimeType: "application/zstd",
      availability: "remote_only" as const,
      cachedStorageKey: null,
      metadata: {
        source: "remote-solver-hub",
        authMode: "remote_solver_token",
        hubBaseUrl,
        registeredSolverId: settings.remoteSolverRegisteredId,
        brokeredUploadId: signedReceipt.receipt.brokeredUploadId,
        bucket: signedReceipt.receipt.remote.bucket,
        objectKey: signedReceipt.receipt.remote.objectKey,
        generation: signedReceipt.receipt.remote.generation,
        crc32c: signedReceipt.receipt.remote.crc32c,
      },
    };
    const [insertedRemoteReference] = await tx
      .insert(remoteAssetReferences)
      .values(remoteReference)
      .onConflictDoNothing()
      .returning({ id: remoteAssetReferences.id });
    if (!insertedRemoteReference) {
      const [existingRemoteReference] = await tx
        .select()
        .from(remoteAssetReferences)
        .where(eq(remoteAssetReferences.localStorageKey, bundle.storageKey))
        .limit(1);
      const immutable = (value: Record<string, unknown>) => ({
        localKind: value.localKind,
        localRowId: value.localRowId ?? null,
        localStorageKey: value.localStorageKey,
        resultId: value.resultId ?? null,
        resultAttemptId: value.resultAttemptId ?? null,
        sourceInstanceId: value.sourceInstanceId ?? null,
        sourceInstanceName: value.sourceInstanceName ?? null,
        remoteResultId: value.remoteResultId ?? null,
        remoteArtifactId: value.remoteArtifactId ?? null,
        remoteDownloadUrl: value.remoteDownloadUrl,
        remoteRenderUrl: value.remoteRenderUrl ?? null,
        sha256: value.sha256 ?? null,
        byteSize: value.byteSize ?? null,
        mimeType: value.mimeType,
        metadata: value.metadata ?? {},
      });
      if (
        !existingRemoteReference ||
        canonicalJson(
          immutable(
            existingRemoteReference as unknown as Record<string, unknown>,
          ),
        ) !==
          canonicalJson(
            immutable(remoteReference as unknown as Record<string, unknown>),
          )
      )
        throw new Error(
          `remote result ${result.id} replayed a different hub archive reference`,
        );
    }
    const receiptCanonical = canonicalJson(signedReceipt.receipt);
    const [insertedReceipt] = await tx
      .insert(syncRemoteHubBindingReceipts)
      .values({
        deliveryId: claim.id,
        promiseId,
        simJobId: job.id,
        resultId: result.id,
        resultAttemptId,
        aoaDeg: result.aoaDeg,
        brokeredUploadId: signedReceipt.receipt.brokeredUploadId,
        receiptCanonical,
        receipt: signedReceipt.receipt as unknown as Record<string, unknown>,
        receiptHmac: signedReceipt.receiptHmac,
        receivedAt: now,
        reclaimNextAttemptAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: syncRemoteHubBindingReceipts.id });
    if (!insertedReceipt) {
      const [existingReceipt] = await tx
        .select()
        .from(syncRemoteHubBindingReceipts)
        .where(
          and(
            eq(syncRemoteHubBindingReceipts.promiseId, promiseId),
            eq(syncRemoteHubBindingReceipts.resultAttemptId, resultAttemptId),
          ),
        )
        .limit(1);
      if (
        !existingReceipt ||
        existingReceipt.deliveryId !== claim.id ||
        existingReceipt.simJobId !== job.id ||
        existingReceipt.resultId !== result.id ||
        existingReceipt.aoaDeg !== result.aoaDeg ||
        existingReceipt.brokeredUploadId !==
          signedReceipt.receipt.brokeredUploadId ||
        existingReceipt.receiptCanonical !== receiptCanonical ||
        existingReceipt.receiptHmac !== signedReceipt.receiptHmac
      ) {
        throw new Error(
          `remote result ${result.id} replayed a different immutable hub binding receipt`,
        );
      }
    }
    if (promotion) {
      if (delivery?.state === "superseded") return "superseded";
      const superseded = await tx
        .update(syncRemoteResultDeliveries)
        .set({
          state: "superseded",
          nextAttemptAt: now,
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          lastHttpStatus: 200,
          lastError:
            "late RANS delivery superseded by conditional whole-polar preliminary URANS promotion",
          remoteConflictIds: [],
          deliveredAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(syncRemoteResultDeliveries.id, claim.id),
            eq(syncRemoteResultDeliveries.state, "pushing"),
            eq(syncRemoteResultDeliveries.claimToken, claim.token),
            gt(syncRemoteResultDeliveries.claimExpiresAt, now),
          ),
        )
        .returning({ id: syncRemoteResultDeliveries.id });
      await assertSingleDeliverySettlement(superseded, claim);
      return "superseded";
    }
    await tx
      .update(syncSweepPromisePoints)
      .set({
        status: "fulfilled",
        resultId: result.id,
        resultAttemptId,
        updatedAt: now,
      })
      .where(eq(syncSweepPromisePoints.id, pointRows[0]!.id));
    const delivered = await tx
      .update(syncRemoteResultDeliveries)
      .set({
        state: "delivered",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        lastHttpStatus: 200,
        lastError: null,
        remoteConflictIds: [],
        deliveredAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(syncRemoteResultDeliveries.id, claim.id),
          eq(syncRemoteResultDeliveries.state, "pushing"),
          eq(syncRemoteResultDeliveries.claimToken, claim.token),
          gt(syncRemoteResultDeliveries.claimExpiresAt, now),
        ),
      )
      .returning({ id: syncRemoteResultDeliveries.id });
    await assertSingleDeliverySettlement(delivered, claim);
    return "delivered";
  });
}

/** Complete an upstream promise only after the local durable mirror proves
 * every promised physical point was accepted by /polars. The helper is also
 * called from later ticks, so a process death after the last point stamp but
 * before /complete is recoverable without replaying solver work. */
async function completeMirroredPromiseIfReady(
  db: DB,
  settings: Settings,
  promiseId: string,
  localJobId: string | null,
): Promise<boolean> {
  const [coverage] = (await db.execute(sql`
    SELECT remote_promise.id,
           remote_promise.status,
           remote_promise.aoa_count::int AS aoa_count,
           count(promise_point.id)::int AS point_count,
           COALESCE(bool_and(promise_point.status IN ('fulfilled', 'cancelled')), false) AS all_fulfilled
    FROM sync_sweep_promises remote_promise
    LEFT JOIN sync_sweep_promise_points promise_point
      ON promise_point.promise_id = remote_promise.id
    WHERE remote_promise.id = ${promiseId}
      AND remote_promise.status IN ('active', 'expired', 'fulfilled')
      AND remote_promise.source_base_url = ${syncBase(settings)}
      AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
    GROUP BY remote_promise.id, remote_promise.status, remote_promise.aoa_count
  `)) as unknown as Array<{
    id: string;
    status: string;
    aoa_count: number;
    point_count: number;
    all_fulfilled: boolean;
  }>;
  if (!coverage) return false;
  if (coverage.status === "fulfilled") return true;
  if (
    coverage.aoa_count <= 0 ||
    coverage.point_count !== coverage.aoa_count ||
    !coverage.all_fulfilled
  )
    return false;

  const response = await fetch(
    `${syncBase(settings)}/sweeps/${promiseId}/complete`,
    {
      method: "POST",
      signal: AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
      headers: headers(settings),
      body: JSON.stringify({
        localJobId,
        pushedAt: new Date().toISOString(),
      }),
    },
  );
  if (!response.ok) {
    if (response.status === 409) {
      const payload = (await response.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      if (
        typeof payload?.error === "string" &&
        payload.error.includes("cancelled")
      ) {
        await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as DB;
          await tx
            .update(syncSweepPromises)
            .set({
              status: "cancelled",
              cancelledAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(syncSweepPromises.id, promiseId));
          await tx
            .update(syncSweepPromisePoints)
            .set({ status: "cancelled", updatedAt: new Date() })
            .where(
              and(
                eq(syncSweepPromisePoints.promiseId, promiseId),
                eq(syncSweepPromisePoints.status, "active"),
              ),
            );
        });
        return false;
      }
    }
    throw new Error(`remote promise completion failed (${response.status})`);
  }
  const fulfilledAt = new Date();
  await db
    .update(syncSweepPromises)
    .set({
      status: "fulfilled",
      fulfilledAt,
      updatedAt: fulfilledAt,
    })
    .where(
      and(
        eq(syncSweepPromises.id, promiseId),
        inArray(syncSweepPromises.status, ["active", "expired", "fulfilled"]),
      ),
    );
  return true;
}

async function firstReadyMirroredPromiseId(
  db: DB,
  settings: Settings,
): Promise<string | null> {
  const [row] = (await db.execute(sql`
    SELECT remote_promise.id
    FROM sync_sweep_promises remote_promise
    WHERE remote_promise.status IN ('active', 'expired')
      AND remote_promise.source_base_url = ${syncBase(settings)}
      AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
      AND remote_promise.aoa_count > 0
      AND (
        SELECT count(*)::int
        FROM sync_sweep_promise_points promise_point
        WHERE promise_point.promise_id = remote_promise.id
      ) = remote_promise.aoa_count
      AND NOT EXISTS (
        SELECT 1
        FROM sync_sweep_promise_points promise_point
        WHERE promise_point.promise_id = remote_promise.id
          AND promise_point.status NOT IN ('fulfilled', 'cancelled')
      )
    ORDER BY remote_promise."createdAt", remote_promise.id
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  return row?.id ?? null;
}

async function pushOneRemoteResult(
  db: DB,
  engine: EngineClient,
  settings: Settings,
  promiseId: string,
  job: typeof simJobs.$inferSelect,
  result: typeof results.$inferSelect,
): Promise<boolean> {
  const attempt = await currentAttemptForResult(db, job, result);
  const [runtime] = attempt.solverRuntimeBuildId
    ? await db
        .select({
          runtime: solverRuntimeBuilds,
          implementation: solverImplementations,
        })
        .from(solverRuntimeBuilds)
        .innerJoin(
          solverImplementations,
          eq(
            solverImplementations.id,
            solverRuntimeBuilds.solverImplementationId,
          ),
        )
        .where(eq(solverRuntimeBuilds.id, attempt.solverRuntimeBuildId))
        .limit(1)
    : [];
  const [accepted] = await db
    .select({ id: resultClassifications.id })
    .from(resultClassifications)
    .where(
      and(
        eq(resultClassifications.resultAttemptId, attempt.id),
        eq(resultClassifications.state, "accepted"),
      ),
    )
    .limit(1);
  if (!accepted) return false;
  const claim = await claimResultDelivery(db, promiseId, job, result, attempt);
  if (!claim) return false;
  let transferLease: RemotePromiseTransferLease | null = null;
  try {
    await touchHeartbeat(db);
    const artifacts = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, result.id),
          eq(solverEvidenceArtifacts.resultAttemptId, attempt.id),
          sql`${solverEvidenceArtifacts.engineJobId} IS NOT DISTINCT FROM ${attempt.engineJobId}`,
          sql`${solverEvidenceArtifacts.engineCaseSlug} IS NOT DISTINCT FROM ${attempt.engineCaseSlug}`,
        ),
      )
      .orderBy(solverEvidenceArtifacts.createdAt, solverEvidenceArtifacts.id);
    const manifests = artifacts.filter(
      (artifact) => artifact.kind === "manifest",
    );
    if (
      manifests.length !== 1 ||
      manifests[0].byteSize <= 0 ||
      !/^[0-9a-fA-F]{64}$/.test(manifests[0].sha256) ||
      !manifests[0].storageKey.trim() ||
      !manifests[0].mimeType.trim()
    ) {
      const error = `remote result ${result.id} has ${manifests.length} exact-attempt manifests; expected one`;
      await settleResultDelivery(db, claim, { kind: "retry", error });
      throw new Error(error);
    }
    const evidenceSha256 = manifests[0].sha256;
    const media = await db
      .select()
      .from(resultMedia)
      .where(
        and(
          eq(resultMedia.resultId, result.id),
          eq(resultMedia.resultAttemptId, attempt.id),
          eq(resultMedia.evidenceSha256, evidenceSha256),
          sql`${resultMedia.sha256} ~ '^[0-9a-fA-F]{64}$'`,
          sql`${resultMedia.byteSize} > 0`,
          sql`length(trim(${resultMedia.storageKey})) > 0`,
          sql`length(trim(${resultMedia.mimeType})) > 0`,
        ),
      );
    const extents = await db
      .select()
      .from(resultFieldExtents)
      .where(
        and(
          eq(resultFieldExtents.resultId, result.id),
          eq(resultFieldExtents.resultAttemptId, attempt.id),
          eq(resultFieldExtents.evidenceSha256, evidenceSha256),
        ),
      );
    if (!claim.fulfilledReplay && !extents.length) {
      await settleResultDelivery(db, claim, {
        kind: "retry",
        error: `remote result ${result.id} is waiting for verified default-media field extents`,
      });
      return false;
    }
    const missingDefaultMedia = claim.fulfilledReplay
      ? undefined
      : extents.find(
          (extent) =>
            !media.some(
              (item) =>
                item.field === extent.field &&
                item.renderProfileKey === extent.renderProfileKey &&
                item.evidenceSha256 === extent.evidenceSha256 &&
                item.kind === "image" &&
                item.role === "instantaneous" &&
                item.mimeType.startsWith("image/") &&
                Boolean(item.sha256 && /^[0-9a-fA-F]{64}$/.test(item.sha256)) &&
                Number(item.byteSize ?? 0) > 0 &&
                Boolean(item.storageKey.trim()),
            ),
        );
    if (missingDefaultMedia) {
      await settleResultDelivery(db, claim, {
        kind: "retry",
        error: `remote result ${result.id} is waiting for verified default ${missingDefaultMedia.field} media`,
      });
      return false;
    }
    const [airfoil] = await db
      .select()
      .from(airfoils)
      .where(eq(airfoils.id, result.airfoilId))
      .limit(1);
    const [revision] = job.simulationPresetRevisionId
      ? await db
          .select()
          .from(simulationPresetRevisions)
          .where(
            eq(simulationPresetRevisions.id, job.simulationPresetRevisionId),
          )
          .limit(1)
      : [];
    if (!airfoil || !revision) {
      const error = `remote delivery ${claim.id} cannot resolve airfoil/setup`;
      await settleResultDelivery(db, claim, { kind: "blocked", error });
      throw new Error(error);
    }
    const bundles = artifacts.filter(
      (artifact) => artifact.kind === "engine_bundle",
    );
    if (bundles.length !== 1) {
      const error = `remote result ${result.id} has ${bundles.length} engine bundles; expected one`;
      await settleResultDelivery(db, claim, { kind: "retry", error });
      throw new Error(error);
    }
    const bundle = bundles[0]!;
    const bundleMetadata =
      bundle.metadata && typeof bundle.metadata === "object"
        ? (bundle.metadata as Record<string, unknown>)
        : {};
    const tarSha256 =
      typeof bundleMetadata.uncompressedTarSha256 === "string"
        ? bundleMetadata.uncompressedTarSha256
        : "";
    const tarByteSize = Number(bundleMetadata.uncompressedTarByteSize ?? 0);
    const zstdLevel = Number(bundleMetadata.zstdLevel ?? 0);
    const bundledFileCount = Number(bundleMetadata.bundledFileCount ?? 0);
    if (
      !attempt.engineJobId ||
      !/^[0-9a-f]{64}$/i.test(bundle.sha256) ||
      !/^[0-9a-f]{64}$/i.test(tarSha256) ||
      !Number.isSafeInteger(bundle.byteSize) ||
      bundle.byteSize <= 0 ||
      !Number.isSafeInteger(tarByteSize) ||
      tarByteSize <= 0 ||
      !Number.isInteger(zstdLevel) ||
      zstdLevel < 1 ||
      zstdLevel > 22 ||
      !Number.isSafeInteger(bundledFileCount) ||
      bundledFileCount <= 0
    ) {
      const error = `remote result ${result.id} engine bundle lacks exact archive identity`;
      await settleResultDelivery(db, claim, { kind: "retry", error });
      throw new Error(error);
    }
    let lastBrokerClaimRenewal = 0;
    const brokerProgress = async () => {
      transferLease?.throwIfFailed();
      const now = Date.now();
      if (now - lastBrokerClaimRenewal >= DELIVERY_CLAIM_RENEW_INTERVAL_MS) {
        await renewResultDeliveryClaim(db, claim);
        lastBrokerClaimRenewal = now;
      }
      await touchHeartbeat(db);
    };
    const brokerRequest = {
      // Retries for one promise+attempt must reuse the broker row, while a new
      // upstream promise reusing the same immutable evidence needs a distinct
      // broker request. The deterministic UUID preserves both properties.
      idempotencyKey: brokeredEvidenceIdempotencyKey(promiseId, attempt.id),
      promiseId,
      remoteResultId: result.id,
      remoteResultAttemptId: attempt.id,
      aoaDeg: attempt.aoaDeg,
      engineJobId: attempt.engineJobId!,
      engineCaseSlug: attempt.engineCaseSlug,
      storedSha256: bundle.sha256.toLowerCase(),
      storedByteSize: bundle.byteSize,
      tarSha256: tarSha256.toLowerCase(),
      tarByteSize,
      manifestSha256: manifests[0]!.sha256.toLowerCase(),
      manifestByteSize: manifests[0]!.byteSize,
      zstdLevel,
      bundledFileCount,
    };
    transferLease = await startRemotePromiseTransferLease(
      db,
      engine,
      settings,
      promiseId,
      async () => {
        await renewResultDeliveryClaim(db, claim);
        await touchHeartbeat(db);
      },
      { renewUpstreamPromise: !claim.fulfilledReplay },
    );
    let brokerResponse = (await fetch(
      `${syncBase(settings)}/evidence-uploads`,
      {
        method: "POST",
        signal: AbortSignal.any([
          AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
          transferLease.signal,
        ]),
        headers: headers(settings),
        body: JSON.stringify(brokerRequest),
      },
    ).then(async (response) => {
      const payload = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!response.ok || !payload)
        throw new Error(
          `remote evidence broker request failed (${response.status})`,
        );
      return payload;
    })) as Record<string, unknown>;
    if (brokerResponse.state === "issued") {
      if (
        typeof brokerResponse.id !== "string" ||
        typeof brokerResponse.uploadUrl !== "string" ||
        typeof brokerResponse.bucket !== "string" ||
        typeof brokerResponse.objectKey !== "string" ||
        brokerResponse.objectKey !==
          `solver-evidence/v1/sha256/${brokerRequest.storedSha256.slice(0, 2)}/${brokerRequest.storedSha256}.tar.zst`
      )
        throw new Error("remote evidence broker omitted its upload capability");
      const generation = await uploadBrokeredEvidenceFile(
        brokerResponse.uploadUrl,
        {
          bucket: brokerResponse.bucket,
          objectKey: brokerResponse.objectKey,
        },
        bundle.storageKey,
        bundle.byteSize,
        brokerProgress,
        transferLease.signal,
      );
      brokerResponse = await fetch(
        `${syncBase(settings)}/evidence-uploads/${brokerResponse.id}/verify`,
        {
          method: "POST",
          signal: AbortSignal.any([
            AbortSignal.timeout(REMOTE_PUSH_ABSOLUTE_TIMEOUT_MS),
            transferLease.signal,
          ]),
          headers: headers(settings),
          body: JSON.stringify({ generation }),
        },
      ).then(async (response) => {
        const payload = (await response.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        if (!response.ok || !payload)
          throw new Error(
            `remote evidence verification failed (${response.status})`,
          );
        return payload;
      });
    }
    const remotePointer = brokerResponse.remote as
      | Record<string, unknown>
      | undefined;
    const remoteEvidenceUploadId =
      typeof brokerResponse.id === "string" ? brokerResponse.id : null;
    if (
      !remoteEvidenceUploadId ||
      !["verified", "bound"].includes(String(brokerResponse.state)) ||
      !remotePointer ||
      typeof remotePointer.generation !== "string" ||
      typeof remotePointer.crc32c !== "string"
    )
      throw new Error(
        "remote evidence broker did not return a verified generation",
      );
    const uploads: StreamUpload[] = [];
    const pushedArtifacts = artifacts.filter((artifact) =>
      claim.fulfilledReplay
        ? artifact.kind === "manifest" || artifact.kind === "engine_bundle"
        : artifact.kind === "manifest" ||
          artifact.kind === "frame_image" ||
          artifact.kind === "engine_bundle",
    );
    const evidenceArtifacts = pushedArtifacts.map((artifact, index) => {
      if (artifact.kind === "engine_bundle") {
        return {
          kind: artifact.kind,
          field: artifact.field,
          role: artifact.role,
          mimeType: artifact.mimeType,
          sha256: artifact.sha256,
          byteSize: artifact.byteSize,
          remoteEvidenceUploadId,
          metadata: {
            ...bundleMetadata,
            remoteEvidenceUploadId,
            storageBackend: "gcs",
            bucket: remotePointer.bucket,
            objectKey: remotePointer.objectKey,
            generation: remotePointer.generation,
            crc32c: remotePointer.crc32c,
            tarSha256: brokerRequest.tarSha256,
            tarByteSize: String(brokerRequest.tarByteSize),
            manifestSha256: brokerRequest.manifestSha256,
            manifestByteSize: String(brokerRequest.manifestByteSize),
          },
        };
      }
      const uploadField = `artifact_${index}`;
      uploads.push({
        fieldName: uploadField,
        storageKey: artifact.storageKey,
        mimeType: artifact.mimeType,
      });
      return {
        kind: artifact.kind,
        field: artifact.field,
        role: artifact.role,
        mimeType: artifact.mimeType,
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
        metadata: artifact.metadata,
        uploadField,
      };
    });
    const mediaPayload = (claim.fulfilledReplay ? [] : media).map(
      (item, index) => {
        const uploadField = `media_${index}`;
        uploads.push({
          fieldName: uploadField,
          storageKey: item.storageKey,
          mimeType: item.mimeType,
        });
        return {
          kind: item.kind,
          field: item.field,
          role: item.role,
          mimeType: item.mimeType,
          width: item.width,
          height: item.height,
          frameCount: item.frameCount,
          durationS: item.durationS,
          colorScaleVersion: item.colorScaleVersion,
          scaleVmin: item.scaleVmin,
          scaleVmax: item.scaleVmax,
          scalePolicy: item.scalePolicy,
          renderProfileKey: item.renderProfileKey,
          evidenceSha256: item.evidenceSha256,
          sha256: item.sha256,
          byteSize: item.byteSize,
          uploadField,
        };
      },
    );
    const attemptPayload =
      attempt.evidencePayload && typeof attempt.evidencePayload === "object"
        ? (attempt.evidencePayload as Record<string, unknown>)
        : {};
    const setupSnapshot =
      revision.snapshot as unknown as SimulationSetupSnapshot;
    const payloadNumber = (key: string, fallback: number | null) =>
      typeof attemptPayload[key] === "number"
        ? (attemptPayload[key] as number)
        : fallback;
    const point = {
      aoaDeg: attempt.aoaDeg,
      status: attempt.status,
      source: attempt.source,
      regime: attempt.regime,
      fidelity:
        typeof attemptPayload.fidelity === "string"
          ? attemptPayload.fidelity
          : null,
      reynolds: payloadNumber("reynolds", setupSnapshot.derived.reynolds),
      speed: payloadNumber("speed", setupSnapshot.flowState.speedMps),
      chord: payloadNumber(
        "chord",
        setupSnapshot.referenceGeometry.referenceLengthM,
      ),
      mach: payloadNumber("mach", setupSnapshot.derived.mach),
      cl: attempt.cl,
      cd: attempt.cd,
      cm: attempt.cm,
      clCd: attempt.clCd,
      clStd: attempt.clStd,
      cdStd: attempt.cdStd,
      cmStd: attempt.cmStd,
      stalled: attempt.stalled,
      unsteady: attempt.unsteady,
      converged: attempt.converged,
      finalResidual: attempt.finalResidual,
      iterations: attempt.iterations,
      yPlusAvg: attempt.yPlusAvg,
      yPlusMax: attempt.yPlusMax,
      nCells: attempt.nCells,
      firstOrderFallback: attempt.firstOrderFallback,
      strouhal: attempt.strouhal,
      error: attempt.error,
      qualityWarnings: attempt.qualityWarnings,
      frameTrack:
        attemptPayload.frame_track ?? attemptPayload.frameTrack ?? null,
      steadyHistory:
        attemptPayload.steady_history ?? attemptPayload.steadyHistory ?? null,
      methodKey: attempt.methodKey,
      engine: runtime
        ? {
            family: runtime.implementation.family,
            distribution: runtime.implementation.distribution,
            version: runtime.implementation.releaseVersion,
            numericsRevision: runtime.implementation.numericsRevision,
            adapterContractVersion:
              runtime.implementation.adapterContractVersion,
            buildId: runtime.runtime.buildId,
            sourceRevision: runtime.runtime.sourceRevision,
            imageDigest: runtime.runtime.imageDigest,
            applicationSourceSha256: runtime.runtime.applicationSourceSha256,
            packageSha256: runtime.runtime.packageSha256,
            binarySha256: runtime.runtime.binarySha256,
            architecture: runtime.runtime.architecture,
          }
        : null,
      engineJobId: attempt.engineJobId,
      engineCaseSlug: attempt.engineCaseSlug,
      remoteResultId: result.id,
      remoteResultAttemptId: attempt.id,
      evidencePayload: attempt.evidencePayload,
      forceHistory: attemptForceHistory(attempt),
      // A fulfilled replay is a storage-container upgrade, not a second
      // publication pass. Keep the accepted media/extents immutable on the
      // hub and send only the exact manifest plus brokered engine archive.
      fieldExtents: claim.fulfilledReplay ? [] : extents,
      evidenceArtifacts,
      media: mediaPayload,
    };
    const manifest = {
      promiseId,
      sourceInstanceId: settings.instanceId,
      sourceInstanceName: settings.instanceName,
      airfoilSlug: airfoil.slug,
      simulationPresetSignatureHash: revision.signatureHash,
      bcId: job.bcIds[0],
      results: [point],
    };
    const boundary = `xfoilfoam-${randomBytes(18).toString("hex")}`;
    const uploadAbort = createProgressAwareAbort();
    let lastClaimRenewal = Date.now();
    let lastSweeperHeartbeat = 0;
    const onProgress = async () => {
      uploadAbort.progress();
      transferLease?.throwIfFailed();
      const now = Date.now();
      if (now - lastClaimRenewal >= DELIVERY_CLAIM_RENEW_INTERVAL_MS) {
        await renewResultDeliveryClaim(db, claim);
        lastClaimRenewal = now;
      }
      if (now - lastSweeperHeartbeat >= 15_000) {
        await touchHeartbeat(db);
        lastSweeperHeartbeat = now;
      }
    };
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      signal: AbortSignal.any([uploadAbort.signal, transferLease.signal]),
      headers: {
        ...headers(settings),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body: Readable.from(
        multipartPolarBody(boundary, manifest, uploads, onProgress),
      ) as unknown as RequestInit["body"],
      duplex: "half",
    };
    let response: Response;
    let responsePayload: {
      conflictIds?: unknown[];
      fulfilledAoas?: unknown[];
      unfulfilledAoas?: unknown[];
      bindingReceipts?: unknown[];
      error?: unknown;
    } | null;
    try {
      response = await fetch(`${syncBase(settings)}/polars`, init);
      uploadAbort.progress();
      responsePayload = (await response
        .json()
        .catch(() => null)) as typeof responsePayload;
    } finally {
      uploadAbort.dispose();
    }
    const transferFailure = await transferLease.stop();
    transferLease = null;
    if (transferFailure) throw transferFailure;
    if (!response.ok) {
      const error = `remote polar push failed (${response.status})`;
      if (
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 429
      ) {
        await settleResultDelivery(db, claim, {
          kind: "retry",
          error,
          httpStatus: response.status,
        });
      } else {
        await settleResultDelivery(db, claim, {
          kind: "blocked",
          error,
          httpStatus: response.status,
        });
        await cancelMirroredRemotePromise(db, settings, promiseId, error);
      }
      throw new Error(error);
    }
    const conflictIds = Array.isArray(responsePayload?.conflictIds)
      ? responsePayload.conflictIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [];
    if (conflictIds.length) {
      const error = `remote polar push conflicted for promise ${promiseId}`;
      await settleResultDelivery(db, claim, {
        kind: "blocked",
        error,
        httpStatus: response.status,
        conflictIds,
      });
      throw new Error(error);
    }
    const exactFulfilled = responsePayload?.fulfilledAoas?.some(
      (aoa) => typeof aoa === "number" && aoa === result.aoaDeg,
    );
    if (!exactFulfilled) {
      const exactUnfulfilled = responsePayload?.unfulfilledAoas?.some(
        (aoa) => typeof aoa === "number" && aoa === result.aoaDeg,
      );
      const error = exactUnfulfilled
        ? `remote hub explicitly left ${result.aoaDeg}° unfulfilled for promise ${promiseId}`
        : `remote hub response omitted exact fulfillment for ${result.aoaDeg}° on promise ${promiseId}`;
      await settleResultDelivery(db, claim, {
        kind: exactUnfulfilled ? "blocked" : "retry",
        error,
        httpStatus: response.status,
      });
      if (exactUnfulfilled) {
        await cancelMirroredRemotePromise(db, settings, promiseId, error);
      }
      throw new Error(error);
    }
    if (
      !Array.isArray(responsePayload?.bindingReceipts) ||
      responsePayload.bindingReceipts.length !== 1
    ) {
      throw new Error(
        `remote hub did not return one exact signed binding receipt for ${result.aoaDeg}°`,
      );
    }
    const signedReceipt = exactSignedHubBindingReceipt(
      responsePayload.bindingReceipts[0],
      {
        settings,
        promiseId,
        resultId: result.id,
        resultAttemptId: attempt.id,
        aoaDeg: result.aoaDeg,
        engineJobId: attempt.engineJobId!,
        engineCaseSlug: attempt.engineCaseSlug,
        brokeredUploadId: remoteEvidenceUploadId,
        brokerRequest,
        remotePointer,
      },
    );
    const settlement = await settleSuccessfulRemoteResultDelivery(
      db,
      settings,
      claim,
      promiseId,
      job,
      result,
      attempt.id,
      signedReceipt,
    );
    if (settlement === "delivered") {
      await completeMirroredPromiseIfReady(db, settings, promiseId, job.id);
    }
    await setStatus(db, "idle", null, { remoteSolverLastPushAt: new Date() });
    return true;
  } catch (error) {
    const stillClaimed = await db
      .select({ id: syncRemoteResultDeliveries.id })
      .from(syncRemoteResultDeliveries)
      .where(
        and(
          eq(syncRemoteResultDeliveries.id, claim.id),
          eq(syncRemoteResultDeliveries.state, "pushing"),
          eq(syncRemoteResultDeliveries.claimToken, claim.token),
          sql`${syncRemoteResultDeliveries.claimExpiresAt} > now()`,
        ),
      );
    if (stillClaimed.length > 0) {
      await settleResultDelivery(db, claim, {
        kind: "retry",
        error: error instanceof Error ? error.message : String(error),
      });
    } else {
      const [superseded] = await db
        .select({ id: syncRemoteResultDeliveries.id })
        .from(syncRemoteResultDeliveries)
        .where(
          and(
            eq(syncRemoteResultDeliveries.id, claim.id),
            eq(syncRemoteResultDeliveries.state, "superseded"),
          ),
        )
        .limit(1);
      if (superseded) return true;
    }
    throw error;
  } finally {
    if (transferLease) await transferLease.stop();
  }
}

async function releaseUnacceptedPromiseResults(
  db: DB,
  settings: Settings,
): Promise<void> {
  await db.execute(sql`
    UPDATE results rejected_result
    SET status = 'stale',
        source = 'queued',
        error = NULL,
        "updatedAt" = now()
    WHERE rejected_result.status = 'done'
      AND EXISTS (
        SELECT 1
        FROM sync_sweep_promise_points promise_point
        JOIN sync_sweep_promises remote_promise
          ON remote_promise.id = promise_point.promise_id
        WHERE promise_point.airfoil_id = rejected_result.airfoil_id
          AND promise_point.simulation_preset_revision_id = rejected_result.simulation_preset_revision_id
          AND promise_point.aoa_deg = rejected_result.aoa_deg
          AND promise_point.status = 'active'
          AND remote_promise.status = 'active'
          AND remote_promise.source_base_url = ${syncBase(settings)}
          AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM result_attempts current_attempt
        JOIN result_classifications current_classification
          ON current_classification.result_attempt_id = current_attempt.id
         AND current_classification.state = 'accepted'
        WHERE current_attempt.id = rejected_result.current_result_attempt_id
          AND current_attempt.result_id = rejected_result.id
      )
  `);
}

function exactEvidenceBase(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("engine bundle is missing its exact evidenceBase");
  const parts = value.split("/");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    parts.some((part) => !part || part === "." || part === "..")
  )
    throw new Error("engine bundle evidenceBase is not a safe relative path");
  return parts.join("/");
}

function exactRemoteHubArchiveUrl(
  settings: Settings,
  brokeredUploadId: string,
  remoteDownloadUrl: string,
): string {
  const hub = new URL(syncBase(settings));
  const expected = new URL(
    `/api/sync/v1/evidence-uploads/${brokeredUploadId}/download`,
    hub.origin,
  );
  const supplied = new URL(remoteDownloadUrl);
  if (
    !["http:", "https:"].includes(supplied.protocol) ||
    supplied.origin !== expected.origin ||
    supplied.username ||
    supplied.password ||
    supplied.search ||
    supplied.hash ||
    supplied.pathname !== expected.pathname ||
    supplied.toString() !== expected.toString()
  )
    throw new Error(
      "remote evidence reclaim download authority or path changed",
    );
  return expected.toString();
}

function exactStoredBindingReceipt(
  row: typeof syncRemoteHubBindingReceipts.$inferSelect,
): HubBindingReceipt {
  if (
    !row.receipt ||
    typeof row.receipt !== "object" ||
    Array.isArray(row.receipt) ||
    row.receiptCanonical !== canonicalJson(row.receipt) ||
    !/^[0-9a-f]{64}$/.test(row.receiptHmac)
  )
    throw new Error(
      "remote evidence reclaim receipt is not the immutable signed payload",
    );
  const receipt = row.receipt as unknown as HubBindingReceipt;
  if (
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "hub-canonical-evidence-binding" ||
    receipt.promiseId !== row.promiseId ||
    receipt.remoteResultId !== row.resultId ||
    receipt.remoteResultAttemptId !== row.resultAttemptId ||
    receipt.brokeredUploadId !== row.brokeredUploadId ||
    receipt.bindingState !== "bound" ||
    receipt.promisePointState !== "fulfilled" ||
    !receipt.canonical?.resultId ||
    !receipt.canonical?.resultAttemptId ||
    !receipt.canonical?.artifactId ||
    !receipt.remote?.storedSha256 ||
    !receipt.remote?.generation ||
    receipt.remote.storedByteSize <= 0
  )
    throw new Error("remote evidence reclaim receipt identity changed");
  return receipt;
}

async function preflightBoundRemoteEvidenceArchive(
  db: DB,
  settings: Settings,
  row: typeof syncRemoteHubBindingReceipts.$inferSelect,
  bundle: typeof solverEvidenceArtifacts.$inferSelect,
  claimSignal: AbortSignal,
): Promise<void> {
  if (!settings.remoteSolverAuthToken || !settings.remoteSolverRegisteredId)
    throw new Error(
      "remote evidence reclaim requires the current registered solver token",
    );
  const receipt = exactStoredBindingReceipt(row);
  const references = await db
    .select()
    .from(remoteAssetReferences)
    .where(eq(remoteAssetReferences.localStorageKey, bundle.storageKey));
  if (references.length !== 1)
    throw new Error(
      "remote evidence reclaim requires one exact remote archive reference",
    );
  const reference = references[0]!;
  const metadata =
    reference.metadata && typeof reference.metadata === "object"
      ? reference.metadata
      : {};
  if (
    reference.localKind !== "evidence_artifact" ||
    reference.localRowId !== bundle.id ||
    reference.resultId !== row.resultId ||
    reference.resultAttemptId !== row.resultAttemptId ||
    reference.remoteResultId !== receipt.canonical.resultId ||
    reference.remoteArtifactId !== receipt.canonical.artifactId ||
    reference.sha256 !== receipt.remote.storedSha256 ||
    reference.byteSize !== receipt.remote.storedByteSize ||
    reference.mimeType !== "application/zstd" ||
    reference.availability !== "remote_only" ||
    reference.cachedStorageKey !== null ||
    metadata.source !== "remote-solver-hub" ||
    metadata.authMode !== "remote_solver_token" ||
    metadata.hubBaseUrl !== syncBase(settings) ||
    metadata.registeredSolverId !== settings.remoteSolverRegisteredId ||
    metadata.brokeredUploadId !== row.brokeredUploadId ||
    metadata.bucket !== receipt.remote.bucket ||
    metadata.objectKey !== receipt.remote.objectKey ||
    metadata.generation !== receipt.remote.generation ||
    metadata.crc32c !== receipt.remote.crc32c
  )
    throw new Error(
      "remote evidence reclaim archive reference changed immutable identity",
    );
  const downloadUrl = exactRemoteHubArchiveUrl(
    settings,
    row.brokeredUploadId,
    reference.remoteDownloadUrl,
  );
  const response = await fetch(downloadUrl, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(REMOTE_PUSH_ABSOLUTE_TIMEOUT_MS),
      claimSignal,
    ]),
    headers: {
      accept: "application/zstd",
      "x-xfoilfoam-solver-token": settings.remoteSolverAuthToken,
    },
  });
  if (!response.ok || !response.body)
    throw new Error(
      `remote evidence reclaim archive preflight failed (${response.status})`,
    );
  const declaredLength = Number(response.headers.get("content-length"));
  const contentType = response.headers.get("content-type")?.split(";", 1)[0];
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLength !== reference.byteSize ||
    response.headers.get("x-content-sha256") !== reference.sha256 ||
    response.headers.get("x-gcs-generation") !== receipt.remote.generation ||
    contentType !== reference.mimeType
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new Error(
      "remote evidence reclaim archive headers changed immutable identity",
    );
  }
  let actualBytes = 0;
  const hash = createHash("sha256");
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(chunk);
    actualBytes += bytes.length;
    if (actualBytes > reference.byteSize)
      throw new Error(
        "remote evidence reclaim archive exceeded its signed size",
      );
    hash.update(bytes);
  }
  if (actualBytes !== reference.byteSize)
    throw new Error(
      "remote evidence reclaim archive ended before its signed size",
    );
  if (hash.digest("hex") !== reference.sha256)
    throw new Error(
      "remote evidence reclaim archive failed its stored SHA-256",
    );
}

/** Drain the local-reclaim outbox independently from result delivery. The
 * signed receipt and exact remote reference are immutable before this claim
 * exists. Every attempt first authenticates to the current hub as the owning
 * solver and reads the generation-pinned archive to EOF. Only that successful
 * complete generation-pinned readback proof permits the local engine deletion
 * call; any preflight error is
 * persisted with backoff and leaves all local bytes intact. */
export async function processBrokeredRemoteEvidenceReclaims(
  db: DB,
  settings: Settings,
  limit = 8,
): Promise<number> {
  // This worker drains sequentially. Claim exactly one row so later rows do
  // not spend their entire 10-minute claim waiting behind a multi-hour
  // readback. Horizontal workers remain safe through SKIP LOCKED.
  const sequentialClaimLimit = Math.min(1, Math.max(0, Math.trunc(limit)));
  const claimedIds = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await tx.execute(sql`
      UPDATE sync_remote_hub_binding_receipts
      SET reclaim_state = 'pending', reclaim_claim_token = NULL,
          reclaim_claim_expires_at = NULL,
          reclaim_next_attempt_at = now(),
          reclaim_last_error = 'expired local-reclaim claim recovered',
          "updatedAt" = now()
      WHERE reclaim_state = 'claiming' AND reclaim_claim_expires_at <= now()
    `);
    const rows = (await tx.execute(sql`
      SELECT id
      FROM sync_remote_hub_binding_receipts
      WHERE reclaim_state = 'pending' AND reclaim_next_attempt_at <= now()
      ORDER BY reclaim_next_attempt_at, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${sequentialClaimLimit}
    `)) as unknown as Array<{ id: string }>;
    const claims: Array<{ id: string; token: string }> = [];
    for (const row of rows) {
      const token = randomUUID();
      const updated = await tx
        .update(syncRemoteHubBindingReceipts)
        .set({
          reclaimState: "claiming",
          reclaimAttemptCount: sql`${syncRemoteHubBindingReceipts.reclaimAttemptCount} + 1`,
          reclaimClaimToken: token,
          reclaimClaimExpiresAt: new Date(Date.now() + REMOTE_RECLAIM_CLAIM_MS),
          reclaimLastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncRemoteHubBindingReceipts.id, row.id),
            eq(syncRemoteHubBindingReceipts.reclaimState, "pending"),
          ),
        )
        .returning({ id: syncRemoteHubBindingReceipts.id });
      if (updated.length === 1) claims.push({ id: row.id, token });
    }
    return claims;
  });
  if (!claimedIds.length) return 0;

  const engineBase = (
    process.env.ENGINE_URL ?? "http://localhost:8000"
  ).replace(/\/+$/, "");
  let completed = 0;
  for (const claim of claimedIds) {
    let reclaimLease: RemoteReclaimClaimLease | null = null;
    try {
      const [row] = await db
        .select()
        .from(syncRemoteHubBindingReceipts)
        .where(
          and(
            eq(syncRemoteHubBindingReceipts.id, claim.id),
            eq(syncRemoteHubBindingReceipts.reclaimState, "claiming"),
            eq(syncRemoteHubBindingReceipts.reclaimClaimToken, claim.token),
          ),
        )
        .limit(1);
      if (!row) continue;
      reclaimLease = startRemoteReclaimClaimLease(db, claim);
      const [attempt] = await db
        .select()
        .from(resultAttempts)
        .where(
          and(
            eq(resultAttempts.id, row.resultAttemptId),
            eq(resultAttempts.resultId, row.resultId),
          ),
        )
        .limit(1);
      const bundles = await db
        .select()
        .from(solverEvidenceArtifacts)
        .where(
          and(
            eq(solverEvidenceArtifacts.resultId, row.resultId),
            eq(solverEvidenceArtifacts.resultAttemptId, row.resultAttemptId),
            eq(solverEvidenceArtifacts.kind, "engine_bundle"),
          ),
        );
      if (
        !attempt?.engineJobId ||
        !attempt.engineCaseSlug ||
        bundles.length !== 1
      )
        throw new Error("reclaim cannot resolve one exact local engine bundle");
      const bundle = bundles[0]!;
      await preflightBoundRemoteEvidenceArchive(
        db,
        settings,
        row,
        bundle,
        reclaimLease.signal,
      );
      reclaimLease.throwIfFailed();
      const controlToken = configuredControlPlaneToken();
      if (!controlToken)
        throw new Error(
          "ENGINE_CONTROL_PLANE_TOKEN is required for brokered evidence reclaim",
        );
      const evidenceBase = exactEvidenceBase(
        (bundle.metadata as Record<string, unknown> | null)?.evidenceBase,
      );
      const response = await fetch(
        `${engineBase}/internal/evidence-uploads/reclaim`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.any([
            AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
            reclaimLease.signal,
          ]),
          headers: {
            authorization: `Bearer ${controlToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jobId: attempt.engineJobId,
            caseSlug: attempt.engineCaseSlug,
            evidenceBase,
            receipt: row.receipt,
            receiptHmac: row.receiptHmac,
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (
        !response.ok ||
        !payload ||
        !["complete", "no_local_bytes"].includes(String(payload.state)) ||
        typeof payload.bytes_freed !== "number" ||
        payload.bytes_freed < 0
      )
        throw new Error(
          `engine brokered evidence reclaim failed (${response.status})`,
        );
      const reclaimLeaseFailure = await reclaimLease.stop();
      reclaimLease = null;
      if (reclaimLeaseFailure) throw reclaimLeaseFailure;
      const settled = await db
        .update(syncRemoteHubBindingReceipts)
        .set({
          reclaimState: "reclaimed",
          reclaimClaimToken: null,
          reclaimClaimExpiresAt: null,
          reclaimedAt: new Date(),
          reclaimedBytes: payload.bytes_freed,
          reclaimLastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncRemoteHubBindingReceipts.id, row.id),
            eq(syncRemoteHubBindingReceipts.reclaimState, "claiming"),
            eq(syncRemoteHubBindingReceipts.reclaimClaimToken, claim.token),
          ),
        )
        .returning({ id: syncRemoteHubBindingReceipts.id });
      if (settled.length !== 1)
        throw new Error(
          "brokered evidence reclaim claim changed before settlement",
        );
      completed += 1;
    } catch (error) {
      const [current] = await db
        .select({
          attemptCount: syncRemoteHubBindingReceipts.reclaimAttemptCount,
        })
        .from(syncRemoteHubBindingReceipts)
        .where(eq(syncRemoteHubBindingReceipts.id, claim.id))
        .limit(1);
      const delay = Math.min(
        6 * 60 * 60_000,
        30_000 *
          2 ** Math.min(8, Math.max(0, (current?.attemptCount ?? 1) - 1)),
      );
      await db
        .update(syncRemoteHubBindingReceipts)
        .set({
          reclaimState: "pending",
          reclaimClaimToken: null,
          reclaimClaimExpiresAt: null,
          reclaimNextAttemptAt: new Date(Date.now() + delay),
          reclaimLastError:
            error instanceof Error
              ? error.message.slice(0, 1000)
              : String(error),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncRemoteHubBindingReceipts.id, claim.id),
            eq(syncRemoteHubBindingReceipts.reclaimState, "claiming"),
            eq(syncRemoteHubBindingReceipts.reclaimClaimToken, claim.token),
          ),
        );
    } finally {
      if (reclaimLease) await reclaimLease.stop();
    }
  }
  return completed;
}

async function processReusablePromiseEvidence(
  db: DB,
  engine: EngineClient,
  settings: Settings,
): Promise<boolean> {
  const candidates = (await db.execute(sql`
    SELECT DISTINCT
      remote_promise.id AS promise_id,
      remote_promise."createdAt" AS promise_created_at,
      solved_result.id AS result_id,
      solved_job.id AS job_id
    FROM sync_sweep_promises remote_promise
    JOIN sync_sweep_promise_points promise_point
      ON promise_point.promise_id = remote_promise.id
     AND promise_point.status = 'active'
    JOIN results solved_result
      ON solved_result.airfoil_id = promise_point.airfoil_id
     AND solved_result.simulation_preset_revision_id = promise_point.simulation_preset_revision_id
     AND solved_result.aoa_deg = promise_point.aoa_deg
     AND solved_result.status = 'done'
    JOIN sim_jobs solved_job ON solved_job.id = solved_result.sim_job_id
    JOIN result_attempts solved_attempt
      ON solved_attempt.id = solved_result.current_result_attempt_id
     AND solved_attempt.result_id = solved_result.id
    JOIN result_classifications solved_classification
      ON solved_classification.result_attempt_id = solved_attempt.id
     AND solved_classification.state = 'accepted'
    WHERE remote_promise.status = 'active'
      AND remote_promise.source_base_url = ${syncBase(settings)}
      AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
      AND NOT (
        solved_job.wave = 1
        AND EXISTS (
          SELECT 1 FROM sim_jobs active_child
          WHERE active_child.parent_job_id = solved_job.id
            AND active_child.status IN ('pending', 'submitted', 'running', 'ingesting')
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_rans_polar_promotions promotion
        WHERE promotion.parent_job_id = solved_job.id
          AND promotion.revision_id = solved_result.simulation_preset_revision_id
          AND promotion.sync_promise_id = remote_promise.id
      )
      AND EXISTS (
        SELECT 1
        FROM solver_evidence_artifacts manifest
        WHERE manifest.result_id = solved_result.id
          AND manifest.result_attempt_id = solved_attempt.id
          AND manifest.kind = 'manifest'
        GROUP BY manifest.result_id, manifest.result_attempt_id
        HAVING count(*) = 1
           AND count(*) FILTER (
             WHERE manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
               AND manifest.byte_size > 0
               AND length(trim(manifest.storage_key)) > 0
               AND length(trim(manifest.mime_type)) > 0
           ) = 1
      )
      AND EXISTS (
        SELECT 1
        FROM result_field_extents extent
        WHERE extent.result_id = solved_result.id
          AND extent.result_attempt_id = solved_attempt.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM result_field_extents extent
        WHERE extent.result_id = solved_result.id
          AND extent.result_attempt_id = solved_attempt.id
          AND NOT EXISTS (
            SELECT 1 FROM result_media media
            WHERE media.result_id = solved_result.id
              AND media.result_attempt_id = solved_attempt.id
              AND media.field = extent.field
              AND media.render_profile_key = extent.render_profile_key
              AND media.evidence_sha256 = extent.evidence_sha256
              AND media.kind = 'image'
              AND media.role = 'instantaneous'
              AND media.mime_type LIKE 'image/%'
              AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
              AND media.byte_size > 0
              AND length(trim(media.storage_key)) > 0
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sync_remote_result_deliveries delivery
        WHERE delivery.promise_id = remote_promise.id
          AND delivery.result_id = solved_result.id
          AND (
            delivery.state IN ('delivered', 'blocked', 'superseded')
            OR (delivery.state = 'retry_wait' AND delivery.next_attempt_at > now())
            OR (delivery.state = 'pushing' AND delivery.claim_expires_at > now())
          )
      )
    ORDER BY promise_created_at, remote_promise.id, solved_result.id
    LIMIT 50
  `)) as unknown as Array<{
    promise_id: string;
    result_id: string;
    job_id: string;
  }>;
  for (const candidate of candidates) {
    const [job] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, candidate.job_id))
      .limit(1);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.id, candidate.result_id))
      .limit(1);
    if (
      job &&
      result &&
      (await pushOneRemoteResult(
        db,
        engine,
        settings,
        candidate.promise_id,
        job,
        result,
      ))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A fulfilled point can need one final, container-only replay after its exact
 * legacy gzip evidence has been converted and uploaded through the broker.
 * This path is intentionally separate from normal result discovery: it may
 * omit derived media/extents only because the upstream point already owns the
 * exact accepted result and attempt named by the durable delivery row.
 */
async function processFulfilledEvidenceUpgrades(
  db: DB,
  engine: EngineClient,
  settings: Settings,
): Promise<boolean> {
  const candidates = (await db.execute(sql`
    SELECT
      delivery.promise_id,
      delivery.sim_job_id,
      delivery.result_id
    FROM sync_remote_result_deliveries delivery
    JOIN sync_sweep_promises remote_promise
      ON remote_promise.id = delivery.promise_id
     AND remote_promise.status = 'fulfilled'
    JOIN sync_sweep_promise_points promise_point
      ON promise_point.promise_id = delivery.promise_id
     AND promise_point.status = 'fulfilled'
    JOIN sim_jobs solved_job
      ON solved_job.id = delivery.sim_job_id
     AND solved_job.status IN ('submitted', 'running', 'ingesting', 'done')
     AND solved_job.request_payload ->> 'remoteSolver' = 'true'
     AND (solved_job.request_payload ->> 'syncPromiseId')::uuid = delivery.promise_id
    JOIN results solved_result
      ON solved_result.id = delivery.result_id
     AND solved_result.sim_job_id = solved_job.id
     AND solved_result.current_result_attempt_id = delivery.result_attempt_id
    JOIN result_attempts solved_attempt
      ON solved_attempt.id = delivery.result_attempt_id
     AND solved_attempt.result_id = solved_result.id
     AND delivery.generation_key = solved_attempt.id::text
    JOIN result_classifications solved_classification
      ON solved_classification.result_attempt_id = solved_attempt.id
     AND solved_classification.state = 'accepted'
    WHERE remote_promise.source_base_url = ${syncBase(settings)}
      AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
      AND promise_point.airfoil_id = solved_result.airfoil_id
      AND promise_point.simulation_preset_revision_id = solved_result.simulation_preset_revision_id
      AND promise_point.aoa_deg = solved_result.aoa_deg
      AND promise_point.result_id = solved_result.id
      AND promise_point.result_attempt_id = solved_attempt.id
      AND (
        delivery.state = 'pending'
        OR (delivery.state = 'retry_wait' AND delivery.next_attempt_at <= now())
        OR (
          delivery.state = 'pushing'
          AND delivery.claim_expires_at <= now()
        )
      )
      AND EXISTS (
        SELECT 1
        FROM solver_evidence_artifacts manifest
        WHERE manifest.result_id = solved_result.id
          AND manifest.result_attempt_id = solved_attempt.id
          AND manifest.kind = 'manifest'
        GROUP BY manifest.result_id, manifest.result_attempt_id
        HAVING count(*) = 1
           AND count(*) FILTER (
             WHERE manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
               AND manifest.byte_size > 0
               AND length(trim(manifest.storage_key)) > 0
               AND length(trim(manifest.mime_type)) > 0
           ) = 1
      )
    ORDER BY delivery.next_attempt_at, delivery."createdAt", delivery.id
    LIMIT 50
  `)) as unknown as Array<{
    promise_id: string;
    sim_job_id: string;
    result_id: string;
  }>;
  for (const candidate of candidates) {
    const [job] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, candidate.sim_job_id))
      .limit(1);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.id, candidate.result_id))
      .limit(1);
    if (
      job &&
      result &&
      (await pushOneRemoteResult(
        db,
        engine,
        settings,
        candidate.promise_id,
        job,
        result,
      ))
    ) {
      return true;
    }
  }
  return false;
}

async function processRemoteResultDeliveries(
  db: DB,
  engine: EngineClient,
  settings: Settings,
): Promise<boolean> {
  const jobs = await db
    .select()
    .from(simJobs)
    .where(
      and(
        inArray(simJobs.status, ["submitted", "running", "ingesting", "done"]),
        sql`${simJobs.requestPayload} ? 'syncPromiseId'`,
        sql`${simJobs.requestPayload} ->> 'remoteSolver' = 'true'`,
        sql`NOT (
          ${simJobs.wave} = 1
          AND EXISTS (
            SELECT 1 FROM sim_jobs active_child
            WHERE active_child.parent_job_id = ${simJobs.id}
              AND active_child.status IN ('pending', 'submitted', 'running', 'ingesting')
          )
        )`,
        sql`NOT EXISTS (
          SELECT 1
          FROM sim_rans_polar_promotions promotion
          WHERE promotion.parent_job_id = ${simJobs.id}
            AND promotion.revision_id = ${simJobs.simulationPresetRevisionId}
            AND promotion.sync_promise_id::text = ${simJobs.requestPayload} ->> 'syncPromiseId'
        )`,
        sql`NOT EXISTS (
          SELECT 1
          FROM sync_remote_result_deliveries terminal_delivery
          WHERE terminal_delivery.sim_job_id = ${simJobs.id}
            AND terminal_delivery.result_id IS NULL
            AND terminal_delivery.state IN ('delivered', 'superseded', 'blocked')
        )`,
        sql`(
          (
            ${simJobs.status} = 'done'
            AND NOT EXISTS (
              SELECT 1 FROM results empty_check
              WHERE empty_check.sim_job_id = ${simJobs.id}
            )
          )
          OR EXISTS (
            SELECT 1
            FROM results ready_result
            JOIN result_attempts ready_attempt
              ON ready_attempt.id = ready_result.current_result_attempt_id
             AND ready_attempt.result_id = ready_result.id
            JOIN result_classifications ready_classification
              ON ready_classification.result_attempt_id = ready_attempt.id
             AND ready_classification.state = 'accepted'
            LEFT JOIN sync_remote_result_deliveries ready_delivery
              ON ready_delivery.promise_id = (${simJobs.requestPayload} ->> 'syncPromiseId')::uuid
             AND ready_delivery.result_id = ready_result.id
            WHERE ready_result.sim_job_id = ${simJobs.id}
              AND EXISTS (
                SELECT 1
                FROM solver_evidence_artifacts ready_manifest
                WHERE ready_manifest.result_id = ready_result.id
                  AND ready_manifest.result_attempt_id = ready_attempt.id
                  AND ready_manifest.kind = 'manifest'
                GROUP BY ready_manifest.result_id, ready_manifest.result_attempt_id
                HAVING count(*) = 1
                   AND count(*) FILTER (
                     WHERE ready_manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
                       AND ready_manifest.byte_size > 0
                       AND length(trim(ready_manifest.storage_key)) > 0
                       AND length(trim(ready_manifest.mime_type)) > 0
                   ) = 1
              )
              AND EXISTS (
                SELECT 1
                FROM result_field_extents ready_extent
                WHERE ready_extent.result_id = ready_result.id
                  AND ready_extent.result_attempt_id = ready_attempt.id
              )
              AND NOT EXISTS (
                SELECT 1
                FROM result_field_extents ready_extent
                WHERE ready_extent.result_id = ready_result.id
                  AND ready_extent.result_attempt_id = ready_attempt.id
                  AND NOT EXISTS (
                    SELECT 1 FROM result_media ready_media
                    WHERE ready_media.result_id = ready_result.id
                      AND ready_media.result_attempt_id = ready_attempt.id
                      AND ready_media.field = ready_extent.field
                      AND ready_media.render_profile_key = ready_extent.render_profile_key
                      AND ready_media.evidence_sha256 = ready_extent.evidence_sha256
                      AND ready_media.kind = 'image'
                      AND ready_media.role = 'instantaneous'
                      AND ready_media.mime_type LIKE 'image/%'
                      AND ready_media.sha256 ~ '^[0-9a-fA-F]{64}$'
                      AND ready_media.byte_size > 0
                      AND length(trim(ready_media.storage_key)) > 0
                  )
              )
              AND (
                ready_delivery.id IS NULL
                OR ready_delivery.generation_key IS DISTINCT FROM ready_attempt.id::text
                OR ready_delivery.state = 'pending'
                OR (
                  ready_delivery.state = 'retry_wait'
                  AND ready_delivery.next_attempt_at <= now()
                )
                OR (
                  ready_delivery.state = 'pushing'
                  AND ready_delivery.claim_expires_at <= now()
                )
              )
          )
        )`,
      ),
    )
    .orderBy(
      sql`CASE WHEN ${simJobs.status} IN ('running', 'ingesting') THEN 0 ELSE 1 END`,
      simJobs.createdAt,
      simJobs.id,
    )
    .limit(250);
  for (const job of jobs) {
    const promiseId = (job.requestPayload as { syncPromiseId?: string } | null)
      ?.syncPromiseId;
    if (!promiseId) continue;
    const resultRows = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, job.id))
      .orderBy(results.aoaDeg, results.id);
    const readyRows = (await db.execute(sql`
      SELECT ready_result.id
      FROM results ready_result
      JOIN result_attempts ready_attempt
        ON ready_attempt.id = ready_result.current_result_attempt_id
       AND ready_attempt.result_id = ready_result.id
      JOIN result_classifications ready_classification
        ON ready_classification.result_attempt_id = ready_attempt.id
       AND ready_classification.state = 'accepted'
      WHERE ready_result.sim_job_id = ${job.id}
        AND EXISTS (
          SELECT 1
          FROM solver_evidence_artifacts manifest
          WHERE manifest.result_id = ready_result.id
            AND manifest.result_attempt_id = ready_attempt.id
            AND manifest.kind = 'manifest'
          GROUP BY manifest.result_id, manifest.result_attempt_id
          HAVING count(*) = 1
             AND count(*) FILTER (
               WHERE manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
                 AND manifest.byte_size > 0
                 AND length(trim(manifest.storage_key)) > 0
                 AND length(trim(manifest.mime_type)) > 0
             ) = 1
        )
        AND EXISTS (
          SELECT 1
          FROM result_field_extents extent
          WHERE extent.result_id = ready_result.id
            AND extent.result_attempt_id = ready_attempt.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM result_field_extents extent
          WHERE extent.result_id = ready_result.id
            AND extent.result_attempt_id = ready_attempt.id
            AND NOT EXISTS (
              SELECT 1 FROM result_media media
              WHERE media.result_id = ready_result.id
                AND media.result_attempt_id = ready_attempt.id
                AND media.field = extent.field
                AND media.render_profile_key = extent.render_profile_key
                AND media.evidence_sha256 = extent.evidence_sha256
                AND media.kind = 'image'
                AND media.role = 'instantaneous'
                AND media.mime_type LIKE 'image/%'
                AND media.sha256 ~ '^[0-9a-fA-F]{64}$'
                AND media.byte_size > 0
                AND length(trim(media.storage_key)) > 0
            )
        )
    `)) as unknown as Array<{ id: string }>;
    const readyResultIds = new Set(readyRows.map((row) => row.id));
    for (const result of resultRows) {
      if (!readyResultIds.has(result.id)) continue;
      if (
        await pushOneRemoteResult(db, engine, settings, promiseId, job, result)
      ) {
        return true;
      }
    }
    if (job.status !== "done") continue;
    if (!resultRows.length) {
      const [child] = await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(eq(simJobs.parentJobId, job.id))
        .limit(1);
      await markRemoteJobDeliveryTerminal(
        db,
        promiseId,
        job.id,
        child ? "superseded" : "blocked",
        child ? null : "remote job completed without canonical result evidence",
      );
      if (!child) {
        await cancelMirroredRemotePromise(
          db,
          settings,
          promiseId,
          "remote job completed without canonical result evidence",
        );
      }
      continue;
    }
    const terminalDeliveries = await db
      .select({
        resultId: syncRemoteResultDeliveries.resultId,
        generationKey: syncRemoteResultDeliveries.generationKey,
        state: syncRemoteResultDeliveries.state,
      })
      .from(syncRemoteResultDeliveries)
      .where(
        and(
          eq(syncRemoteResultDeliveries.promiseId, promiseId),
          inArray(
            syncRemoteResultDeliveries.resultId,
            resultRows.map((result) => result.id),
          ),
        ),
      );
    const deliveredByResult = new Map(
      terminalDeliveries.map((delivery) => [delivery.resultId, delivery]),
    );
    let allDelivered = true;
    for (const result of resultRows) {
      if (!result.currentResultAttemptId) {
        allDelivered = false;
        break;
      }
      const attempt = await currentAttemptForResult(db, job, result);
      const delivery = deliveredByResult.get(result.id);
      if (
        delivery?.state !== "delivered" ||
        delivery.generationKey !== attempt.id
      ) {
        allDelivered = false;
        break;
      }
    }
    if (allDelivered) {
      await markRemoteJobDeliveryTerminal(db, promiseId, job.id, "delivered");
      await completeMirroredPromiseIfReady(db, settings, promiseId, job.id);
    }
  }
  return false;
}

async function reopenResolvedConflictDeliveries(
  db: DB,
  settings: Settings,
): Promise<void> {
  const blocked = await db
    .select({
      id: syncRemoteResultDeliveries.id,
      conflictIds: syncRemoteResultDeliveries.remoteConflictIds,
      promiseId: syncRemoteResultDeliveries.promiseId,
      simJobId: syncRemoteResultDeliveries.simJobId,
      aoaDeg: syncRemoteResultDeliveries.aoaDeg,
    })
    .from(syncRemoteResultDeliveries)
    .where(
      and(
        eq(syncRemoteResultDeliveries.state, "blocked"),
        sql`jsonb_array_length(${syncRemoteResultDeliveries.remoteConflictIds}) > 0`,
        sql`${syncRemoteResultDeliveries.nextAttemptAt} <= now()`,
      ),
    )
    .orderBy(
      syncRemoteResultDeliveries.nextAttemptAt,
      syncRemoteResultDeliveries.id,
    )
    .limit(100);
  if (!blocked.length) return;
  const ids = [
    ...new Set(blocked.flatMap((delivery) => delivery.conflictIds)),
  ].slice(0, 500);
  const response = await fetch(`${syncBase(settings)}/conflicts/status`, {
    method: "POST",
    signal: AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
    headers: headers(settings),
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) return;
  const payload = (await response.json().catch(() => null)) as {
    conflicts?: Array<{ id?: unknown; status?: unknown }>;
  } | null;
  const statusById = new Map(
    (payload?.conflicts ?? [])
      .filter(
        (row): row is { id: string; status: "promoted" | "archived" } =>
          typeof row.id === "string" &&
          (row.status === "promoted" || row.status === "archived"),
      )
      .map((row) => [row.id, row.status]),
  );
  const fullyResolved = blocked.filter(
    (delivery) =>
      delivery.conflictIds.length > 0 &&
      delivery.conflictIds.every((id) => statusById.has(id)),
  );
  const archived = fullyResolved.filter((delivery) =>
    delivery.conflictIds.some((id) => statusById.get(id) === "archived"),
  );
  const reopenIds = fullyResolved
    .filter((delivery) =>
      delivery.conflictIds.every((id) => statusById.get(id) === "promoted"),
    )
    .map((delivery) => delivery.id);
  const resolvedIds = new Set(fullyResolved.map((delivery) => delivery.id));
  const unresolvedIds = blocked
    .filter((delivery) => !resolvedIds.has(delivery.id))
    .map((delivery) => delivery.id);
  if (unresolvedIds.length) {
    await db
      .update(syncRemoteResultDeliveries)
      .set({
        nextAttemptAt: new Date(Date.now() + 5 * 60_000),
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(syncRemoteResultDeliveries.id, unresolvedIds),
          eq(syncRemoteResultDeliveries.state, "blocked"),
        ),
      );
  }
  if (reopenIds.length) {
    await db
      .update(syncRemoteResultDeliveries)
      .set({
        state: "pending",
        nextAttemptAt: new Date(),
        lastError: null,
        lastHttpStatus: null,
        remoteConflictIds: [],
        updatedAt: new Date(),
      })
      .where(
        and(
          inArray(syncRemoteResultDeliveries.id, reopenIds),
          eq(syncRemoteResultDeliveries.state, "blocked"),
        ),
      );
  }
  for (const delivery of archived) {
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await tx
        .update(syncRemoteResultDeliveries)
        .set({
          state: "superseded",
          nextAttemptAt: new Date(),
          claimToken: null,
          claimedAt: null,
          claimExpiresAt: null,
          lastError: "remote conflict archived; hub canonical truth retained",
          remoteConflictIds: [],
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncRemoteResultDeliveries.id, delivery.id),
            eq(syncRemoteResultDeliveries.state, "blocked"),
          ),
        );
      if (delivery.aoaDeg != null) {
        await tx
          .update(syncSweepPromisePoints)
          .set({ status: "cancelled", updatedAt: new Date() })
          .where(
            and(
              eq(syncSweepPromisePoints.promiseId, delivery.promiseId),
              eq(syncSweepPromisePoints.aoaDeg, delivery.aoaDeg),
              inArray(syncSweepPromisePoints.status, ["active", "expired"]),
            ),
          );
      }
    });
    await completeMirroredPromiseIfReady(
      db,
      settings,
      delivery.promiseId,
      delivery.simJobId,
    );
  }
}

/** Reconcile remote authority and evidence without admitting a new engine
 * job. Returning true means an admission-only pass may be attempted later in
 * this same scheduler tick, after higher-priority FAST URANS has had the slot. */
export async function reconcileRemoteSolverTick(
  db: DB,
  engine: EngineClient,
): Promise<boolean> {
  const [settings] = await db
    .select()
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1))
    .limit(1);
  try {
    assertRemoteSolverHubUrlContract(settings?.upstreamBaseUrl);
    assertRemoteSolverNodeEvidenceContract(
      settings?.remoteSolverEnabled ?? false,
    );
    // Reclaim is its own durable outbox, but deletion still requires the
    // current owning solver token to read back and authenticate the exact bound
    // hub archive first. Missing/rotated credentials therefore back off with
    // local bytes intact instead of turning an old receipt into delete power.
    if (settings) await processBrokeredRemoteEvidenceReclaims(db, settings);
    // Cancellation is an authority-release outbox, not solver work. Drain it
    // before registration/claim gates and even while solving is disabled; a
    // local pause must never strand an upstream lease. Each row supplies its
    // stored hub URL, while the current same-authority credential is used.
    if (settings?.upstreamBaseUrl && settings.remoteSolverAuthToken) {
      await processPendingPromiseCancellations(db, settings);
    }
    let processedDurableDelivery = false;
    if (settings?.upstreamBaseUrl && settings.remoteSolverAuthToken) {
      await reopenResolvedConflictDeliveries(db, settings);
      processedDurableDelivery =
        (await processFulfilledEvidenceUpgrades(db, engine, settings)) ||
        (await processRemoteResultDeliveries(db, engine, settings));
    }
    if (!settings?.remoteSolverEnabled || !settings.upstreamBaseUrl) {
      if (settings?.upstreamBaseUrl && settings.remoteSolverAuthToken) {
        await cancelMirroredPromisesForDisabledSolver(db, engine, settings);
      }
      if (settings?.remoteSolverLastStatus !== "disabled")
        await setStatus(db, "disabled", null);
      return false;
    }
    if (processedDurableDelivery) return false;
    if (!settings.remoteSolverRegisteredId || !settings.remoteSolverAuthToken) {
      if (!settings.upstreamSecret)
        throw new Error(
          "remote solver has no credential; an admin must install a rotated solver token or temporarily configure the bootstrap secret for first registration",
        );
      await registerSolver(db, settings);
    }
    await renewMirroredPromiseLeases(db, engine, settings);
    await expireMirroredRemotePromises(db, settings);
    await releaseUnacceptedPromiseResults(db, settings);
    const readyPromiseId = await firstReadyMirroredPromiseId(db, settings);
    if (readyPromiseId) {
      await setStatus(db, "pushing", null);
      await completeMirroredPromiseIfReady(db, settings, readyPromiseId, null);
      await setStatus(db, "idle", null, {
        remoteSolverLastPushAt: new Date(),
      });
      return false;
    }
    const active = await activeRemoteJobs(db);
    await heartbeat(
      settings,
      active.length ? "solving" : "idle",
      active.length,
      active.reduce((sum, job) => sum + job.totalCases, 0),
    );
    if (await processReusablePromiseEvidence(db, engine, settings))
      return false;
    return active.length === 0;
  } catch (e) {
    await setStatus(db, "error", e instanceof Error ? e.message : String(e));
    return false;
  }
}

function remoteAdmissionHoldMessage(
  reason: RemoteEngineAdmissionHoldReason,
): string {
  switch (reason) {
    case "storage_pressure":
      return "storage admission is blocked; remote reconciliation continues but no new engine job will be submitted";
    case "safety_stop":
      return "global admission safety stop is active; remote reconciliation continues but no new engine job will be submitted";
    case "mesh_capability_unknown":
      return "engine mesh-recovery capability is unavailable or malformed; remote reconciliation continues but no new engine job will be submitted";
    case "higher_priority_fast_urans":
      return "higher-priority FAST URANS owns this scheduler tick; the remote promise remains active for the next admission opportunity";
    case "shared_capacity_full":
      return "shared scheduler capacity is full; the remote promise remains active while local or FAST work drains";
    case "engine_unavailable":
      return "engine admission is unavailable; remote reconciliation continues but no new engine job will be submitted";
  }
}

/** Attempt only the NEW-engine-work part of remote solving. Reconciliation is
 * deliberately absent: callers run it once, early, then call this boundary
 * only after the local FAST lane and capability gate have been evaluated. */
export async function admitRemoteSolverTick(
  db: DB,
  engine: EngineClient,
  decision: RemoteEngineAdmissionDecision,
): Promise<boolean> {
  const [settings] = await db
    .select()
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1))
    .limit(1);
  try {
    assertRemoteSolverHubUrlContract(settings?.upstreamBaseUrl);
    assertRemoteSolverNodeEvidenceContract(
      settings?.remoteSolverEnabled ?? false,
    );
    if (
      !settings?.remoteSolverEnabled ||
      !settings.upstreamBaseUrl ||
      !settings.remoteSolverAuthToken
    ) {
      return false;
    }
    if (decision.kind === "hold") {
      await setStatus(db, "idle", remoteAdmissionHoldMessage(decision.reason));
      return false;
    }
    const meshRecoveryVersion = parsedMeshRecoveryVersion(
      decision.meshRecoveryVersion,
    );
    if (meshRecoveryVersion == null) {
      await setStatus(
        db,
        "idle",
        remoteAdmissionHoldMessage("mesh_capability_unknown"),
      );
      return false;
    }
    if ((await activeRemoteJobs(db)).length > 0) return false;

    const mirrored = await mirroredRemotePromiseIds(db, settings);
    let outcome: RemotePromiseSubmitResult | null;
    if (mirrored.length) {
      outcome = await submitMirroredRemotePromise(
        db,
        engine,
        settings,
        mirrored[0],
        meshRecoveryVersion,
      );
    } else if (engineBackoffActive()) {
      await setStatus(
        db,
        "error",
        "remote solver is waiting for the shared engine connection backoff",
      );
      return false;
    } else {
      outcome = await claimRemoteWork(
        db,
        engine,
        settings,
        meshRecoveryVersion,
      );
    }
    // `busy` includes another owner already submitting the exact composed job.
    // Conservatively consume this tick so no second engine admission races it.
    return outcome?.kind === "submitted" || outcome?.kind === "busy";
  } catch (e) {
    await setStatus(db, "error", e instanceof Error ? e.message : String(e));
    return false;
  }
}

/** Compatibility wrapper for direct callers and focused remote-solver tests.
 * Production orchestration uses the explicit two-phase functions above. */
export async function remoteSolverTick(
  db: DB,
  engine: EngineClient,
  decision: RemoteEngineAdmissionDecision = {
    kind: "allow",
    meshRecoveryVersion: 0,
  },
): Promise<boolean> {
  if (!(await reconcileRemoteSolverTick(db, engine))) return false;
  return admitRemoteSolverTick(db, engine, decision);
}
