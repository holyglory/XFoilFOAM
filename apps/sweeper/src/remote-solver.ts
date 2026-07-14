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
  resultAttempts,
  resultClassifications,
  resultFieldExtents,
  resultMedia,
  results,
  schedulingProfiles,
  simJobs,
  simRansPolarPromotions,
  simResultSubmitRetries,
  simulationPresetRevisions,
  simulationPresets,
  solverEvidenceArtifacts,
  solverProfiles,
  syncApiSettings,
  syncRemotePromiseCancellations,
  syncRemoteResultDeliveries,
  syncSweepPromisePoints,
  syncSweepPromises,
  sweepDefinitions,
} from "@aerodb/db";
import {
  physicsHashForSnapshot,
  simulationSetupSignature,
  type SimulationSetupSnapshot,
} from "@aerodb/db/simulation-setup";
import type { EngineClient } from "@aerodb/engine-client";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, join } from "node:path";
import { Readable } from "node:stream";

import { buildPolarRequest } from "./build-request";
import { claimAoas } from "./claim";
import {
  clearEngineUnreachable,
  engineBackoffActive,
  recordEngineUnreachable,
} from "./engine-backoff";
import { touchHeartbeat } from "./heartbeat";
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

type Settings = typeof syncApiSettings.$inferSelect;

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

function syncBase(settings: Settings): string {
  if (!settings.upstreamBaseUrl)
    throw new Error("up-tier endpoint is not configured");
  return settings.upstreamBaseUrl.replace(/\/+$/, "");
}

function headers(settings: Settings) {
  return {
    "content-type": "application/json",
    "x-xfoilfoam-sync-secret": settings.upstreamSecret ?? "",
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
      set: { updatedAt: new Date() },
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
  if (row && !row.physicsHash) {
    const [withPhysicsHash] = await db
      .update(simulationPresetRevisions)
      .set({
        physicsHash: physicsHashForSnapshot(
          row.snapshot as unknown as SimulationSetupSnapshot,
        ),
      })
      .where(eq(simulationPresetRevisions.id, row.id))
      .returning();
    row = withPhysicsHash ?? row;
  }
  return { revision: row, snapshot: localSnapshot, bcId: legacy.id };
}

async function registerSolver(db: DB, settings: Settings): Promise<string> {
  const res = await fetch(`${syncBase(settings)}/solvers/register`, {
    method: "POST",
    signal: AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
    headers: headers(settings),
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
    }),
  });
  const payload = (await res.json().catch(() => null)) as {
    solver?: { id?: string };
  } | null;
  if (!res.ok || !payload?.solver?.id)
    throw new Error(`remote solver registration failed (${res.status})`);
  await db
    .update(syncApiSettings)
    .set({
      remoteSolverRegisteredId: payload.solver.id,
      remoteSolverLastStatus: "idle",
      remoteSolverLastError: null,
      updatedAt: new Date(),
    })
    .where(eq(syncApiSettings.id, 1));
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
    .where(eq(syncSweepPromisePoints.promiseId, promiseId));

  const now = Date.now();
  const activeRows = rows.filter((row) => row.pointStatus === "active");
  const dueAoas: number[] = [];
  let waitingUntil: Date | null = null;
  let busy = false;
  let completed = false;
  let terminal = false;
  for (const row of activeRows) {
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
  });
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
  if (queued) {
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
      if (!row.sourceBaseUrl) {
        throw new Error(
          `remote promise ${row.promiseId} has no stored authority endpoint`,
        );
      }
      response = await fetch(
        `${row.sourceBaseUrl.replace(/\/+$/, "")}/sweeps/${row.promiseId}/cancel`,
        {
          method: "POST",
          signal: AbortSignal.timeout(REMOTE_POLL_TIMEOUT_MS),
          headers: headers(settings),
        },
      );
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
      resources: request.resources,
      setupSnapshot: setup,
    };
    const [job] = await tx
      .insert(simJobs)
      .values({
        airfoilId: airfoil.id,
        bcIds: [bcId],
        simulationPresetRevisionId: revision.id,
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
): Promise<RemotePromiseSubmitResult> {
  if (engineBackoffActive()) {
    const error = `remote engine submit for promise ${promiseId} is waiting for the shared connection backoff`;
    await setStatus(db, "error", error);
    return { kind: "waiting" };
  }
  const composition = await composeRemotePromiseJob(db, settings, promiseId);
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
): Promise<void> {
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
    return;
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
  await submitMirroredRemotePromise(db, engine, settings, claim.id);
}

interface StreamUpload {
  fieldName: string;
  storageKey: string;
  mimeType: string;
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
    return claimed ? { ...claimed, token } : null;
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
  claim: DeliveryClaim,
  promiseId: string,
  job: typeof simJobs.$inferSelect,
  result: typeof results.$inferSelect,
  resultAttemptId: string,
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
  settings: Settings,
  promiseId: string,
  job: typeof simJobs.$inferSelect,
  result: typeof results.$inferSelect,
): Promise<boolean> {
  const attempt = await currentAttemptForResult(db, job, result);
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
    const missingDefaultMedia = extents.find(
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
    const uploads: StreamUpload[] = [];
    const evidenceArtifacts = artifacts.map((artifact, index) => {
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
    const mediaPayload = media.map((item, index) => {
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
    });
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
      engineJobId: attempt.engineJobId,
      engineCaseSlug: attempt.engineCaseSlug,
      evidencePayload: attempt.evidencePayload,
      forceHistory: attemptForceHistory(attempt),
      fieldExtents: extents,
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
      signal: uploadAbort.signal,
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
    const settlement = await settleSuccessfulRemoteResultDelivery(
      db,
      claim,
      promiseId,
      job,
      result,
      attempt.id,
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

async function processReusablePromiseEvidence(
  db: DB,
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
      if (await pushOneRemoteResult(db, settings, promiseId, job, result)) {
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

export async function remoteSolverTick(
  db: DB,
  engine: EngineClient,
): Promise<void> {
  const [settings] = await db
    .select()
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1))
    .limit(1);
  try {
    // Cancellation is an authority-release outbox, not solver work. Drain it
    // before registration/claim gates and even while solving is disabled; a
    // local pause must never strand an upstream lease. Each row supplies its
    // stored hub URL, while the current same-authority credential is used.
    if (settings?.upstreamSecret) {
      await processPendingPromiseCancellations(db, settings);
    }
    let processedDurableDelivery = false;
    if (settings?.upstreamBaseUrl && settings.upstreamSecret) {
      await reopenResolvedConflictDeliveries(db, settings);
      processedDurableDelivery = await processRemoteResultDeliveries(
        db,
        settings,
      );
    }
    if (
      !settings?.remoteSolverEnabled ||
      !settings.upstreamBaseUrl ||
      !settings.upstreamSecret
    ) {
      if (settings?.upstreamBaseUrl && settings.upstreamSecret) {
        await cancelMirroredPromisesForDisabledSolver(db, engine, settings);
      }
      if (settings?.remoteSolverLastStatus !== "disabled")
        await setStatus(db, "disabled", null);
      return;
    }
    if (processedDurableDelivery) return;
    if (!settings.remoteSolverRegisteredId) {
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
      return;
    }
    const active = await activeRemoteJobs(db);
    await heartbeat(
      settings,
      active.length ? "solving" : "idle",
      active.length,
      active.reduce((sum, job) => sum + job.totalCases, 0),
    );
    if (await processReusablePromiseEvidence(db, settings)) return;
    if (active.length === 0) {
      const mirrored = await mirroredRemotePromiseIds(db, settings);
      if (mirrored.length) {
        await submitMirroredRemotePromise(db, engine, settings, mirrored[0]);
      } else if (engineBackoffActive()) {
        await setStatus(
          db,
          "error",
          "remote solver is waiting for the shared engine connection backoff",
        );
      } else {
        await claimRemoteWork(db, engine, settings);
      }
    }
  } catch (e) {
    await setStatus(db, "error", e instanceof Error ? e.message : String(e));
  }
}
