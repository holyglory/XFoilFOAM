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
  resultFieldExtents,
  resultMedia,
  results,
  schedulingProfiles,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
  solverEvidenceArtifacts,
  solverProfiles,
  syncApiSettings,
  syncSweepPromisePoints,
  syncSweepPromises,
  sweepDefinitions,
} from "@aerodb/db";
import { simulationSetupSignature, type SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import type { EngineClient } from "@aerodb/engine-client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { buildPolarRequest } from "./build-request";
import { claimAoas } from "./claim";

const MEDIA_DIR = process.env.MEDIA_DIR ?? "/data/airfoilfoam";

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

function syncBase(settings: Settings): string {
  if (!settings.upstreamBaseUrl) throw new Error("up-tier endpoint is not configured");
  return settings.upstreamBaseUrl.replace(/\/+$/, "");
}

function headers(settings: Settings) {
  return {
    "content-type": "application/json",
    "x-xfoilfoam-sync-secret": settings.upstreamSecret ?? "",
  };
}

function slugPart(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && value.trim() ? value : fallback;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

async function setStatus(db: DB, status: Settings["remoteSolverLastStatus"], error: string | null = null, patch: Partial<typeof syncApiSettings.$inferInsert> = {}) {
  await db
    .update(syncApiSettings)
    .set({ remoteSolverLastStatus: status, remoteSolverLastError: error, ...patch, updatedAt: new Date() })
    .where(eq(syncApiSettings.id, 1));
}

async function ensureRemoteAirfoil(db: DB, claim: NonNullable<RemoteClaimResponse["promise"]>) {
  const [category] = await db
    .insert(categories)
    .values({ slug: "remote-sync", name: "Remote sync", path: "remote-sync", depth: 0, sortOrder: 9999 })
    .onConflictDoUpdate({ target: categories.slug, set: { name: "Remote sync", updatedAt: new Date() } })
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

async function ensureRemoteRevision(db: DB, claim: NonNullable<RemoteClaimResponse["promise"]>, settings: Settings) {
  const snapshot = claim.setupRevision.snapshot;
  const signatureHash = claim.setupRevision.signatureHash || simulationSetupSignature(snapshot);
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
      speedOfSound: snapshot.flowState.mach && snapshot.flowState.mach > 0 ? snapshot.flowState.speedMps / snapshot.flowState.mach : null,
    })
    .onConflictDoUpdate({
      target: mediums.slug,
      set: { density: snapshot.flowState.density, dynamicViscosity: snapshot.flowState.dynamicViscosity, kinematicViscosity: snapshot.flowState.kinematicViscosity, updatedAt: new Date() },
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
    .onConflictDoUpdate({ target: flowConditions.slug, set: { updatedAt: new Date() } })
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
    .onConflictDoUpdate({ target: referenceGeometryProfiles.slug, set: { updatedAt: new Date() } })
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
    .onConflictDoUpdate({ target: boundaryProfiles.slug, set: { updatedAt: new Date() } })
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
    .onConflictDoUpdate({ target: meshProfiles.slug, set: { updatedAt: new Date() } })
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
    .onConflictDoUpdate({ target: solverProfiles.slug, set: { updatedAt: new Date() } })
    .returning({ id: solverProfiles.id });
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({
      slug: `${prefix}-scheduling`,
      name: `Remote scheduling ${signatureHash.slice(0, 8)}`,
      schedulingPolicy: snapshot.scheduling.schedulingPolicy,
      caseConcurrency: snapshot.scheduling.caseConcurrency,
      solverProcesses: snapshot.scheduling.solverProcesses,
      cpuBudget: settings.remoteSolverCpuBudget || snapshot.scheduling.cpuBudget,
    })
    .onConflictDoUpdate({ target: schedulingProfiles.slug, set: { updatedAt: new Date() } })
    .returning({ id: schedulingProfiles.id });
  const [output] = await db
    .insert(outputProfiles)
    .values({
      slug: `${prefix}-output`,
      name: `Remote output ${signatureHash.slice(0, 8)}`,
      writeImages: snapshot.output.writeImages,
      imageZoomChords: snapshot.output.imageZoomChords,
    })
    .onConflictDoUpdate({ target: outputProfiles.slug, set: { updatedAt: new Date() } })
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
    .onConflictDoUpdate({ target: sweepDefinitions.slug, set: { updatedAt: new Date() } })
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
      cpuBudget: settings.remoteSolverCpuBudget || snapshot.scheduling.cpuBudget,
      caseConcurrency: snapshot.scheduling.caseConcurrency,
      solverProcesses: snapshot.scheduling.solverProcesses,
      aoaStart: snapshot.sweep.aoaStart,
      aoaStop: snapshot.sweep.aoaStop,
      aoaStep: snapshot.sweep.aoaStep,
      aoaList: snapshot.sweep.aoaList,
      enabled: false,
    })
    .onConflictDoUpdate({ target: boundaryConditions.slug, set: { updatedAt: new Date() } })
    .returning({ id: boundaryConditions.id });
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${prefix}-preset`,
      name: snapshot.preset.name || `Remote preset ${signatureHash.slice(0, 8)}`,
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
    .onConflictDoUpdate({ target: simulationPresets.slug, set: { updatedAt: new Date() } })
    .returning({ id: simulationPresets.id });
  const localSnapshot: SimulationSetupSnapshot = {
    ...snapshot,
    preset: { ...snapshot.preset, id: preset.id, slug: `${prefix}-preset`, legacyBoundaryConditionId: legacy.id, enabled: false },
    flowState: { ...snapshot.flowState, mediumId: medium.id },
    scheduling: { ...snapshot.scheduling, cpuBudget: settings.remoteSolverCpuBudget || snapshot.scheduling.cpuBudget },
  };
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
    })
    .onConflictDoNothing({ target: [simulationPresetRevisions.presetId, simulationPresetRevisions.signatureHash] })
    .returning();
  const row =
    revision ??
    (
      await db
        .select()
        .from(simulationPresetRevisions)
        .where(and(eq(simulationPresetRevisions.presetId, preset.id), eq(simulationPresetRevisions.signatureHash, signatureHash)))
        .limit(1)
    )[0];
  return { revision: row, snapshot: localSnapshot, bcId: legacy.id };
}

async function registerSolver(db: DB, settings: Settings): Promise<string> {
  const res = await fetch(`${syncBase(settings)}/solvers/register`, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({
      instanceId: settings.instanceId,
      instanceName: settings.instanceName,
      publicEndpoint: settings.publicEndpointOverride,
      cpuCapacity: settings.remoteSolverCpuBudget,
      cpuBudget: settings.remoteSolverCpuBudget,
      buildVersion: process.env.AIRFOILFOAM_BUILD_ID ?? process.env.npm_package_version ?? null,
    }),
  });
  const payload = (await res.json().catch(() => null)) as { solver?: { id?: string } } | null;
  if (!res.ok || !payload?.solver?.id) throw new Error(`remote solver registration failed (${res.status})`);
  await db
    .update(syncApiSettings)
    .set({ remoteSolverRegisteredId: payload.solver.id, remoteSolverLastStatus: "idle", remoteSolverLastError: null, updatedAt: new Date() })
    .where(eq(syncApiSettings.id, 1));
  return payload.solver.id;
}

async function heartbeat(settings: Settings, status: Settings["remoteSolverLastStatus"], activePromiseCount: number, activeAoaCount: number) {
  if (!settings.remoteSolverRegisteredId) return;
  await fetch(`${syncBase(settings)}/solvers/${settings.remoteSolverRegisteredId}/heartbeat`, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({
      status,
      activePromiseCount,
      activeAoaCount,
      cpuCapacity: settings.remoteSolverCpuBudget,
      cpuBudget: settings.remoteSolverCpuBudget,
    }),
  }).catch(() => undefined);
}

async function activeRemoteJobs(db: DB) {
  const jobs = await db.select().from(simJobs).where(inArray(simJobs.status, ["pending", "submitted", "running", "ingesting"]));
  return jobs.filter((job) => Boolean((job.requestPayload as { syncPromiseId?: string } | null)?.syncPromiseId));
}

async function claimRemoteWork(db: DB, engine: EngineClient, settings: Settings): Promise<void> {
  const solverId = settings.remoteSolverRegisteredId ?? (await registerSolver(db, settings));
  await setStatus(db, "claiming", null);
  const res = await fetch(`${syncBase(settings)}/sweeps/claim`, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({ solverId, limit: settings.remoteSolverClaimSize }),
  });
  const payload = (await res.json().catch(() => null)) as RemoteClaimResponse | null;
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
      requestPayload: { remoteSolver: true, upstreamBaseUrl: syncBase(settings) },
    })
    .onConflictDoUpdate({
      target: syncSweepPromises.id,
      set: { expiresAt: new Date(claim.expiresAt), aoaCount: claim.aoas.length, updatedAt: new Date() },
    });
  await db
    .insert(syncSweepPromisePoints)
    .values(claim.aoas.map((aoaDeg) => ({ promiseId: claim.id, airfoilId: airfoil.id, simulationPresetRevisionId: setup.revision.id, aoaDeg })))
    .onConflictDoNothing();
  const { request, speed } = buildPolarRequest({ airfoil, setup: setup.snapshot, aoaList: claim.aoas, wave: 1, queuePressure: 0 });
  request.resources = { ...(request.resources ?? {}), cpu_budget: settings.remoteSolverCpuBudget || request.resources?.cpu_budget };
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId: airfoil.id,
      bcIds: [setup.bcId],
      simulationPresetRevisionId: setup.revision.id,
      referenceChordM: setup.snapshot.referenceGeometry.referenceLengthM,
      wave: 1,
      status: "pending",
      totalCases: claim.aoas.length,
      requestPayload: {
        syncPromiseId: claim.id,
        speedMap: [{ speed, bcId: setup.bcId, presetRevisionId: setup.revision.id, mach: setup.snapshot.flowState.mach }],
        aoas: claim.aoas,
        resources: request.resources,
        setupSnapshot: setup.snapshot,
      },
    })
    .returning({ id: simJobs.id });
  const claimed = await claimAoas(db, airfoil.id, setup.bcId, setup.revision.id, claim.aoas, job.id);
  request.aoa = { angles: claimed };
  if (claimed.length === 0) {
    await db.update(simJobs).set({ status: "cancelled", error: "remote promise had no locally claimable AoAs", finishedAt: new Date() }).where(eq(simJobs.id, job.id));
    return;
  }
  const status = await engine.submitPolar(request);
  await db
    .update(simJobs)
    .set({ status: "submitted", engineJobId: status.job_id, submittedAt: new Date(), engineState: status.state, totalCases: status.total_cases })
    .where(eq(simJobs.id, job.id));
  await setStatus(db, "solving", null, { remoteSolverLastPromiseAt: new Date() });
}

async function bytes(storageKey: string): Promise<string> {
  return (await readFile(join(MEDIA_DIR, storageKey))).toString("base64");
}

async function pushCompletedJob(db: DB, settings: Settings, job: typeof simJobs.$inferSelect): Promise<boolean> {
  const payload = (job.requestPayload as { syncPromiseId?: string; remotePushedAt?: string } | null) ?? {};
  if (!payload.syncPromiseId || payload.remotePushedAt || job.status !== "done" || !job.simulationPresetRevisionId) return false;
  if (job.wave === 1) {
    const [replacement] = await db
      .select({ id: simJobs.id })
      .from(simJobs)
      .where(eq(simJobs.parentJobId, job.id))
      .limit(1);
    if (replacement) return false;
  }
  const [airfoil] = await db.select().from(airfoils).where(eq(airfoils.id, job.airfoilId)).limit(1);
  const [revision] = await db.select().from(simulationPresetRevisions).where(eq(simulationPresetRevisions.id, job.simulationPresetRevisionId)).limit(1);
  if (!airfoil || !revision) return false;
  const resultRows = await db.select().from(results).where(eq(results.simJobId, job.id));
  if (!resultRows.length) return false;
  await setStatus(db, "pushing", null);
  const payloadResults = [];
  for (const result of resultRows) {
    const artifacts = await db.select().from(solverEvidenceArtifacts).where(eq(solverEvidenceArtifacts.resultId, result.id));
    const media = await db.select().from(resultMedia).where(eq(resultMedia.resultId, result.id));
    const extents = await db.select().from(resultFieldExtents).where(eq(resultFieldExtents.resultId, result.id));
    payloadResults.push({
      aoaDeg: result.aoaDeg,
      status: result.status,
      source: result.source,
      regime: result.regime,
      reynolds: result.reynolds,
      speed: result.speed,
      chord: result.chord,
      mach: result.mach,
      cl: result.cl,
      cd: result.cd,
      cm: result.cm,
      clCd: result.clCd,
      stalled: result.stalled,
      unsteady: result.unsteady,
      converged: result.converged,
      finalResidual: result.finalResidual,
      iterations: result.iterations,
      yPlusAvg: result.yPlusAvg,
      yPlusMax: result.yPlusMax,
      firstOrderFallback: result.firstOrderFallback,
      strouhal: result.strouhal,
      error: result.error,
      engineJobId: result.engineJobId,
      engineCaseSlug: result.engineCaseSlug,
      fieldExtents: extents,
      evidenceArtifacts: await Promise.all(artifacts.map(async (artifact) => ({
        kind: artifact.kind,
        field: artifact.field,
        role: artifact.role,
        mimeType: artifact.mimeType,
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
        metadata: artifact.metadata,
        contentBase64: await bytes(artifact.storageKey),
      }))),
      media: await Promise.all(media.map(async (item) => ({
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
        contentBase64: await bytes(item.storageKey),
      }))),
    });
  }
  const res = await fetch(`${syncBase(settings)}/polars`, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({
      promiseId: payload.syncPromiseId,
      sourceInstanceId: settings.instanceId,
      sourceInstanceName: settings.instanceName,
      airfoilSlug: airfoil.slug,
      simulationPresetSignatureHash: revision.signatureHash,
      bcId: job.bcIds[0],
      results: payloadResults,
    }),
  });
  if (!res.ok) throw new Error(`remote polar push failed (${res.status})`);
  await fetch(`${syncBase(settings)}/sweeps/${payload.syncPromiseId}/complete`, {
    method: "POST",
    headers: headers(settings),
    body: JSON.stringify({ localJobId: job.id, pushedAt: new Date().toISOString() }),
  });
  await db
    .update(simJobs)
    .set({ requestPayload: { ...payload, remotePushedAt: new Date().toISOString() } })
    .where(eq(simJobs.id, job.id));
  await setStatus(db, "idle", null, { remoteSolverLastPushAt: new Date() });
  return true;
}

export async function remoteSolverTick(db: DB, engine: EngineClient): Promise<void> {
  const [settings] = await db.select().from(syncApiSettings).where(eq(syncApiSettings.id, 1)).limit(1);
  if (!settings?.remoteSolverEnabled || !settings.upstreamBaseUrl || !settings.upstreamSecret) {
    if (settings?.remoteSolverLastStatus !== "disabled") await setStatus(db, "disabled", null);
    return;
  }
  try {
    if (!settings.remoteSolverRegisteredId) {
      await registerSolver(db, settings);
    }
    const active = await activeRemoteJobs(db);
    await heartbeat(settings, active.length ? "solving" : "idle", active.length, active.reduce((sum, job) => sum + job.totalCases, 0));
    const doneRemoteJobs = await db.select().from(simJobs).where(eq(simJobs.status, "done")).limit(25);
    for (const job of doneRemoteJobs) {
      if (await pushCompletedJob(db, settings, job)) return;
    }
    if (active.length === 0) {
      await claimRemoteWork(db, engine, settings);
    }
  } catch (e) {
    await setStatus(db, "error", e instanceof Error ? e.message : String(e));
  }
}
