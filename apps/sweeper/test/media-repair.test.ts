import {
  acquireResultEvidenceLock,
  airfoils,
  boundaryProfiles,
  boundaryConditions,
  categories,
  claimNextResultMediaRepair,
  completeSatisfiedResultMediaRepair,
  createClient,
  discoverMissingResultMediaRepairs,
  failClaimedResultMediaRepair,
  forceHistory,
  flowConditions,
  healExpiredResultMediaRepairClaims,
  mediums,
  renewResultMediaRepairClaim,
  resultClassifications,
  resultAttempts,
  resultFieldExtents,
  resultMedia,
  resultMediaRepairs,
  referenceGeometryProfiles,
  results,
  schedulingProfiles,
  simulationPresets,
  simCampaignAirfoils,
  simCampaignConditions,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaigns,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligations,
  simUransVerifyQueue,
  meshProfiles,
  outputProfiles,
  polarCompatibilityFitSets,
  polarFitSets,
  solverProfiles,
  solverEvidenceArtifacts,
  sweepDefinitions,
  type DB,
  refreshPolarCacheForRevision,
  satisfyPrecalcObligationFromAcceptedResult,
  withEvidenceArtifactWriteLocks,
} from "@aerodb/db";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import type {
  EngineClient,
  FieldExtentsResponse,
  ImageFieldName,
  RenderDefaultMediaRequest,
  RenderDefaultMediaResponse,
} from "@aerodb/engine-client";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  finalizeSatisfiedResultMediaRepairs,
  resultMediaRepairTick,
} from "../src/media-repair";
import { repairDefaultMediaForStoredResult } from "../src/ingest";

const { db, sql } = createClient({ max: 4 });
const PREFIX = `media-repair-${process.pid}-${Date.now().toString(36)}`;
const MEDIA_ROOT = resolve("/tmp", PREFIX);
const previousMediaDir = process.env.MEDIA_DIR;
process.env.MEDIA_DIR = MEDIA_ROOT;
const here = dirname(fileURLToPath(import.meta.url));
const frameTrack = JSON.parse(
  readFileSync(resolve(here, "fixtures/frame-track-contract.json"), "utf8"),
) as Record<string, unknown>;

let bcId = "";
let revisionId = "";
let presetId = "";
let referenceGeometryId = "";
let flowId = "";
const setupIds = {
  medium: "",
  boundary: "",
  mesh: "",
  solver: "",
  scheduling: "",
  output: "",
  sweep: "",
};
const airfoilIds: string[] = [];
const categoryIds: string[] = [];
const campaignIds: string[] = [];

interface Fixture {
  airfoilId: string;
  resultId: string;
  resultAttemptId: string;
  manifestSha: string;
  engineJobId: string;
  caseSlug: string;
}

interface BlockedPrecalcFixture extends Fixture {
  jobId: string;
  resultAttemptId: string;
  obligationId: string;
}

async function createAirfoil(label: string): Promise<string> {
  const [category] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-${label}-cat`,
      name: `${PREFIX} ${label}`,
      path: `${PREFIX}-${label}-cat`,
      depth: 0,
    })
    .returning();
  categoryIds.push(category.id);
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-${label}`,
      name: `${PREFIX} ${label}`,
      categoryId: category.id,
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.08 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.04 },
        { x: 1, y: 0 },
      ],
      isSymmetric: false,
    })
    .returning();
  airfoilIds.push(airfoil.id);
  return airfoil.id;
}

async function createSolvedResult(
  label: string,
  opts: {
    airfoilId?: string;
    aoa?: number;
    unsteady?: boolean;
    fidelity?: "rans" | "urans_precalc" | "urans_full";
    regime?: "rans" | "urans";
    simJobId?: string;
  } = {},
): Promise<Fixture> {
  const airfoilId = opts.airfoilId ?? (await createAirfoil(label));
  const aoa = opts.aoa ?? 6;
  const unsteady = opts.unsteady ?? true;
  const fidelity = opts.fidelity ?? "urans_precalc";
  const regime = opts.regime ?? (unsteady ? "urans" : "rans");
  const engineJobId = `${PREFIX}-${label}-job`;
  const caseSlug = `${label}-case`;
  const manifestSha = createHash("sha256")
    .update(`${PREFIX}:${label}:manifest`)
    .digest("hex");
  const [result] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: aoa,
      status: "done",
      source: "solved",
      regime,
      fidelity,
      reynolds: 250_000,
      speed: 25,
      chord: 0.15,
      mach: 0.07,
      cl: 0.81,
      cd: 0.041,
      cm: -0.032,
      clCd: 19.75,
      clStd: unsteady ? 0.02 : null,
      cdStd: unsteady ? 0.002 : null,
      cmStd: unsteady ? 0.001 : null,
      stalled: unsteady,
      unsteady,
      converged: true,
      strouhal: unsteady ? 0.17 : null,
      frameTrack: unsteady ? frameTrack : null,
      engineJobId,
      engineCaseSlug: caseSlug,
      simJobId: opts.simJobId ?? null,
      solvedAt: new Date(),
    })
    .returning();
  const force = unsteady
    ? {
        t: [0, 0.1, 0.2, 0.3],
        cl: [0.79, 0.83, 0.8, 0.82],
        cd: [0.04, 0.042, 0.041, 0.041],
        cm: [-0.03, -0.033, -0.031, -0.032],
      }
    : null;
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: aoa,
      simJobId: opts.simJobId ?? null,
      engineJobId,
      engineCaseSlug: caseSlug,
      status: "done",
      source: "solved",
      regime,
      validForPolar: true,
      cl: 0.81,
      cd: 0.041,
      cm: -0.032,
      clCd: 19.75,
      clStd: unsteady ? 0.02 : null,
      cdStd: unsteady ? 0.002 : null,
      cmStd: unsteady ? 0.001 : null,
      stalled: unsteady,
      unsteady,
      converged: true,
      strouhal: unsteady ? 0.17 : null,
      evidencePayload: {
        fidelity,
        frame_track: unsteady ? frameTrack : null,
        force_history: force,
      },
      solvedAt: new Date(),
    })
    .returning({ id: resultAttempts.id });
  await db.insert(solverEvidenceArtifacts).values({
    resultId: result.id,
    resultAttemptId: attempt.id,
    airfoilId,
    simJobId: opts.simJobId ?? null,
    engineJobId,
    engineCaseSlug: caseSlug,
    aoaDeg: aoa,
    kind: "manifest",
    storageKey: `${PREFIX}/${label}/manifest.json`,
    mimeType: "application/json",
    sha256: manifestSha,
    byteSize: 512,
    metadata: { evidenceBase: `evidence/${label}` },
  });
  if (unsteady) {
    await db.insert(forceHistory).values({
      resultId: result.id,
      resultAttemptId: attempt.id,
      ...force!,
    });
  }
  // Classify the exact attempt before deciding whether it can own the public
  // pointer. Missing transient media must remain rejected/unselected until the
  // exact-attempt repair finishes and reclassification accepts it.
  await refreshPolarCacheForRevision(db, airfoilId, revisionId);
  const [classification] = await db
    .select({ state: resultClassifications.state })
    .from(resultClassifications)
    .where(eq(resultClassifications.resultAttemptId, attempt.id));
  if (
    classification?.state === "accepted" ||
    classification?.state === "needs_urans"
  ) {
    await db
      .update(results)
      .set({ currentResultAttemptId: attempt.id })
      .where(eq(results.id, result.id));
  }
  return {
    airfoilId,
    resultId: result.id,
    resultAttemptId: attempt.id,
    manifestSha,
    engineJobId,
    caseSlug,
  };
}

async function createBlockedPrecalcFixture(
  label: string,
): Promise<BlockedPrecalcFixture> {
  const airfoilId = await createAirfoil(label);
  const aoaDeg = 6;
  const [obligation] = await db
    .insert(simPrecalcObligations)
    .values({
      airfoilId,
      revisionId,
      aoaDeg,
      state: "blocked",
      attemptCount: 1,
      maxAttempts: 2,
      lastOutcome: "rejected_exhausted",
      lastError: "missing-urans-video",
      completedAt: new Date(),
    })
    .returning();
  const engineJobId = `${PREFIX}-${label}-job`;
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      campaignId: null,
      referenceChordM: 0.15,
      wave: 2,
      status: "done",
      engineJobId,
      totalCases: 1,
      completedCases: 1,
      ingestedAt: new Date(),
      finishedAt: new Date(),
      requestPayload: {
        aoas: [aoaDeg],
        uransFidelity: "precalc",
        precalcObligationIds: [obligation.id],
      },
    })
    .returning();
  const fixture = await createSolvedResult(label, {
    airfoilId,
    aoa: aoaDeg,
    simJobId: job.id,
  });
  const attempt = { id: fixture.resultAttemptId };
  await refreshPolarCacheForRevision(db, airfoilId, revisionId);
  const [attemptClassification] = await db
    .select({ state: resultClassifications.state })
    .from(resultClassifications)
    .where(eq(resultClassifications.resultAttemptId, attempt.id));
  if (attemptClassification?.state !== "rejected") {
    throw new Error(
      `blocked PRECALC fixture must begin rejected, got ${attemptClassification?.state ?? "none"}`,
    );
  }
  await db
    .update(simPrecalcObligations)
    .set({
      sourceResultId: fixture.resultId,
      sourceResultAttemptId: attempt.id,
      latestSimJobId: job.id,
    })
    .where(eq(simPrecalcObligations.id, obligation.id));
  await db.insert(simPrecalcObligationAttempts).values({
    obligationId: obligation.id,
    simJobId: job.id,
    attemptNumber: 1,
    state: "rejected",
    outcome: "rejected_exhausted",
    resultAttemptId: attempt.id,
    error: "missing-urans-video",
    completedAt: new Date(),
  });
  return {
    ...fixture,
    jobId: job.id,
    resultAttemptId: attempt.id,
    obligationId: obligation.id,
  };
}

async function createNoSheddingBlockedPrecalcFixture(
  label: string,
): Promise<BlockedPrecalcFixture> {
  const airfoilId = await createAirfoil(label);
  const aoaDeg = 6;
  const engineJobId = `${PREFIX}-${label}-job`;
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      campaignId: null,
      referenceChordM: 0.15,
      wave: 2,
      status: "done",
      engineJobId,
      totalCases: 1,
      completedCases: 1,
      ingestedAt: new Date(),
      finishedAt: new Date(),
      requestPayload: {
        aoas: [aoaDeg],
        uransFidelity: "precalc",
      },
    })
    .returning();
  const fixture = await createSolvedResult(label, {
    airfoilId,
    aoa: aoaDeg,
    unsteady: false,
    simJobId: job.id,
  });
  // createSolvedResult promotes the exact attempt after its first refresh;
  // refresh once more so the canonical result classification sees that newly
  // selected no-shedding PRECALC generation.
  await refreshPolarCacheForRevision(db, airfoilId, revisionId);
  const [classification] = await db
    .select({ state: resultClassifications.state })
    .from(resultClassifications)
    .where(eq(resultClassifications.resultAttemptId, fixture.resultAttemptId));
  if (classification?.state !== "accepted") {
    throw new Error(
      `no-shedding PRECALC fixture must begin accepted, got ${classification?.state ?? "none"}`,
    );
  }
  const [obligation] = await db
    .insert(simPrecalcObligations)
    .values({
      airfoilId,
      revisionId,
      aoaDeg,
      state: "blocked",
      attemptCount: 2,
      maxAttempts: 2,
      latestSimJobId: job.id,
      sourceResultId: fixture.resultId,
      sourceResultAttemptId: fixture.resultAttemptId,
      lastOutcome: "rejected_exhausted",
      lastError: "stale classification from before no-shedding PRECALC support",
      completedAt: new Date(),
    })
    .returning();
  await db.insert(simPrecalcObligationAttempts).values({
    obligationId: obligation.id,
    simJobId: job.id,
    attemptNumber: 2,
    state: "rejected",
    outcome: "rejected_exhausted",
    resultAttemptId: fixture.resultAttemptId,
    error: "stale classification from before no-shedding PRECALC support",
    completedAt: new Date(),
  });
  return {
    ...fixture,
    jobId: job.id,
    obligationId: obligation.id,
  };
}

function completeMediaResponse(
  jobId: string,
  request: RenderDefaultMediaRequest,
): RenderDefaultMediaResponse {
  const fields = request.fields ?? [];
  const item = (
    field: ImageFieldName,
    kind: "image" | "video",
    role: "instantaneous" | "mean",
  ) => {
    const path = `scaled/${request.case_slug}/${field}-${role}.${kind === "video" ? "mp4" : "png"}`;
    const bytes = Buffer.from(`${jobId}:${path}:real-rendered-bytes`, "utf8");
    const full = resolve(MEDIA_ROOT, "jobs", jobId, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    return {
      kind,
      field,
      role,
      path,
      url: `/jobs/${jobId}/files/${path}`,
      mime_type: kind === "video" ? "video/mp4" : "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_size: bytes.byteLength,
    };
  };
  return {
    images: fields.map((field) => item(field, "image", "instantaneous")),
    mean_images: request.unsteady
      ? fields.map((field) => item(field, "image", "mean"))
      : [],
    videos: request.unsteady
      ? fields.map((field) => item(field, "video", "instantaneous"))
      : [],
    scale_version: request.scale_version ?? 1,
    render_profile_key: request.render_profile_key ?? "default:v1:zoom2",
  };
}

function engineWith(
  opts: {
    extents?: () => Promise<FieldExtentsResponse>;
    render?: (
      jobId: string,
      request: RenderDefaultMediaRequest,
    ) => Promise<RenderDefaultMediaResponse>;
  } = {},
): EngineClient {
  return {
    baseUrl: "http://engine.test",
    computeFieldExtents:
      opts.extents ??
      (async () => ({
        fields: {
          velocity_magnitude: { min: 0, max: 44, finite_count: 500 },
          pressure: { min: -3, max: 2, finite_count: 500 },
        },
        window_start: 1,
        window_end: 2,
      })),
    renderDefaultMedia:
      opts.render ??
      (async (jobId: string, request: RenderDefaultMediaRequest) =>
        completeMediaResponse(jobId, request)),
  } as unknown as EngineClient;
}

beforeAll(async () => {
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: `${PREFIX}-medium`,
      name: `${PREFIX} medium`,
      phase: "gas",
      density: 1.225,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.8375e-5,
      dynamicViscosity: 1.8375e-5,
      kinematicViscosity: 1.5e-5,
      speedOfSound: 357.14285714285717,
    })
    .returning();
  setupIds.medium = medium.id;
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${PREFIX}-flow`,
      name: `${PREFIX} flow`,
      mediumId: medium.id,
      speedMps: 25,
      density: 1.225,
      dynamicViscosity: 1.8375e-5,
      kinematicViscosity: 1.5e-5,
      mach: 0.07,
    })
    .returning();
  flowId = flow.id;
  const [reference] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${PREFIX}-geometry`,
      name: `${PREFIX} geometry`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: 0.15,
    })
    .returning();
  referenceGeometryId = reference.id;
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({
      slug: `${PREFIX}-boundary`,
      name: `${PREFIX} boundary`,
    })
    .returning();
  setupIds.boundary = boundary.id;
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
    .returning();
  setupIds.mesh = mesh.id;
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` })
    .returning();
  setupIds.solver = solver.id;
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({
      slug: `${PREFIX}-scheduling`,
      name: `${PREFIX} scheduling`,
    })
    .returning();
  setupIds.scheduling = scheduling.id;
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
    .returning();
  setupIds.output = output.id;
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${PREFIX}-sweep`,
      name: `${PREFIX} sweep`,
      aoaList: [6],
    })
    .returning();
  setupIds.sweep = sweep.id;
  const [legacy] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-legacy`,
      name: `${PREFIX} legacy`,
      mediumId: medium.id,
      reynolds: 250_000,
      referenceChordM: 0.15,
      speedMps: 25,
      density: 1.225,
      dynamicViscosity: 1.8375e-5,
      kinematicViscosity: 1.5e-5,
      mach: 0.07,
      aoaList: [6],
    })
    .returning();
  bcId = legacy.id;
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${PREFIX}-preset`,
      name: `${PREFIX} preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: reference.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: legacy.id,
      enabled: false,
    })
    .returning();
  presetId = preset.id;
  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  if (!resolved) throw new Error("media repair test revision required");
  revisionId = resolved.revision.id;
});

afterAll(async () => {
  if (campaignIds.length) {
    await db.delete(simCampaigns).where(inArray(simCampaigns.id, campaignIds));
  }
  if (revisionId) {
    await db
      .delete(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.revisionId, revisionId));
    await db
      .delete(resultClassifications)
      .where(eq(resultClassifications.simulationPresetRevisionId, revisionId));
    await db
      .update(results)
      .set({ currentResultAttemptId: null })
      .where(eq(results.simulationPresetRevisionId, revisionId));
    await db
      .delete(results)
      .where(eq(results.simulationPresetRevisionId, revisionId));
    await db
      .delete(simJobs)
      .where(eq(simJobs.simulationPresetRevisionId, revisionId));
  }
  if (airfoilIds.length)
    await db.delete(airfoils).where(inArray(airfoils.id, airfoilIds));
  if (categoryIds.length)
    await db.delete(categories).where(inArray(categories.id, categoryIds));
  if (presetId)
    await db
      .delete(simulationPresets)
      .where(eq(simulationPresets.id, presetId));
  if (bcId)
    await db.delete(boundaryConditions).where(eq(boundaryConditions.id, bcId));
  if (flowId)
    await db.delete(flowConditions).where(eq(flowConditions.id, flowId));
  if (referenceGeometryId) {
    await db
      .delete(referenceGeometryProfiles)
      .where(eq(referenceGeometryProfiles.id, referenceGeometryId));
  }
  if (setupIds.boundary)
    await db
      .delete(boundaryProfiles)
      .where(eq(boundaryProfiles.id, setupIds.boundary));
  if (setupIds.mesh)
    await db.delete(meshProfiles).where(eq(meshProfiles.id, setupIds.mesh));
  if (setupIds.solver)
    await db
      .delete(solverProfiles)
      .where(eq(solverProfiles.id, setupIds.solver));
  if (setupIds.scheduling)
    await db
      .delete(schedulingProfiles)
      .where(eq(schedulingProfiles.id, setupIds.scheduling));
  if (setupIds.output)
    await db
      .delete(outputProfiles)
      .where(eq(outputProfiles.id, setupIds.output));
  if (setupIds.sweep)
    await db
      .delete(sweepDefinitions)
      .where(eq(sweepDefinitions.id, setupIds.sweep));
  if (setupIds.medium)
    await db.delete(mediums).where(eq(mediums.id, setupIds.medium));
  await sql.end();
  rmSync(MEDIA_ROOT, { recursive: true, force: true });
  if (previousMediaDir == null) delete process.env.MEDIA_DIR;
  else process.env.MEDIA_DIR = previousMediaDir;
});

describe("durable result media repair", () => {
  it("MUST-CATCH: defers default-media rendering while its producing CFD job is still running", async () => {
    const airfoilId = await createAirfoil("active-producer");
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        referenceChordM: 0.15,
        wave: 2,
        status: "running",
        engineJobId: `${PREFIX}-active-producer-job`,
        totalCases: 1,
        completedCases: 1,
      })
      .returning();
    const fixture = await createSolvedResult("active-producer", {
      airfoilId,
      simJobId: job.id,
    });

    expect(
      await discoverMissingResultMediaRepairs(db, {
        resultId: fixture.resultId,
      }),
    ).toBe(0);
    expect(
      await claimNextResultMediaRepair(db, { resultId: fixture.resultId }),
    ).toBeNull();

    await db
      .update(simJobs)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(simJobs.id, job.id));
    expect(
      await discoverMissingResultMediaRepairs(db, {
        resultId: fixture.resultId,
      }),
    ).toBe(1);
    expect(
      await claimNextResultMediaRepair(db, { resultId: fixture.resultId }),
    ).toMatchObject({ resultId: fixture.resultId, state: "running" });
  });

  it("records an extent failure as a bounded retry instead of losing the obligation", async () => {
    const fixture = await createSolvedResult("extent-failure");
    const outcome = await resultMediaRepairTick(
      db,
      engineWith({
        extents: async () => {
          throw new Error("stored VTK extent read failed");
        },
      }),
      { resultId: fixture.resultId },
    );
    expect(outcome.claimed).toBe(true);
    expect(outcome.retrying).toBe(1);
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair.state).toBe("retry_wait");
    expect(repair.attemptCount).toBe(1);
    expect(repair.lastError).toContain("extent read failed");
  });

  it("keeps valid selected media visible until a replacement render commits", async () => {
    const fixture = await createSolvedResult("staged-render-failure");
    const storageKey = `jobs/${fixture.engineJobId}/scaled/${fixture.caseSlug}/velocity_magnitude-instantaneous.mp4`;
    const bytes = Buffer.from("previous verified exact-generation video");
    const fullPath = resolve(MEDIA_ROOT, storageKey);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, bytes);
    const [video] = await db
      .insert(resultMedia)
      .values({
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        kind: "video",
        field: "velocity_magnitude",
        role: "instantaneous",
        storageKey,
        mimeType: "video/mp4",
        renderProfileKey: "default:v1:zoom2",
        evidenceSha256: fixture.manifestSha,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.byteLength,
      })
      .returning({ id: resultMedia.id });
    await refreshPolarCacheForRevision(db, fixture.airfoilId, revisionId, {
      afterAttemptClassifications: async (tx) => {
        await tx
          .update(results)
          .set({ currentResultAttemptId: fixture.resultAttemptId })
          .where(eq(results.id, fixture.resultId));
      },
    });

    let videoVisibleDuringRender = false;
    let pointerVisibleDuringRender = false;
    const outcome = await resultMediaRepairTick(
      db,
      engineWith({
        extents: async () => ({
          fields: {
            velocity_magnitude: { min: 0, max: 44, finite_count: 500 },
          },
          window_start: 1,
          window_end: 2,
        }),
        render: async () => {
          const [visibleVideo] = await db
            .select({ id: resultMedia.id })
            .from(resultMedia)
            .where(eq(resultMedia.id, video.id));
          const [visibleResult] = await db
            .select({ currentResultAttemptId: results.currentResultAttemptId })
            .from(results)
            .where(eq(results.id, fixture.resultId));
          videoVisibleDuringRender = visibleVideo?.id === video.id;
          pointerVisibleDuringRender =
            visibleResult?.currentResultAttemptId === fixture.resultAttemptId;
          throw new Error("replacement renderer unavailable");
        },
      }),
      { resultId: fixture.resultId },
    );

    expect(outcome.retrying).toBe(1);
    expect(videoVisibleDuringRender).toBe(true);
    expect(pointerVisibleDuringRender).toBe(true);
    expect(
      await db
        .select({ id: resultMedia.id })
        .from(resultMedia)
        .where(eq(resultMedia.id, video.id)),
    ).toEqual([{ id: video.id }]);
    const [selected] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, fixture.resultId));
    expect(selected.currentResultAttemptId).toBe(fixture.resultAttemptId);
  });

  it("refuses default-media repair when stored physical scale is missing or zero", async () => {
    const missingChord = await createSolvedResult("missing-render-chord");
    const zeroSpeed = await createSolvedResult("zero-render-speed");
    await db
      .update(results)
      .set({ chord: null })
      .where(eq(results.id, missingChord.resultId));
    await db
      .update(results)
      .set({ speed: 0 })
      .where(eq(results.id, zeroSpeed.resultId));
    let renderCalls = 0;
    const engine = engineWith({
      render: async (jobId, request) => {
        renderCalls += 1;
        return completeMediaResponse(jobId, request);
      },
    });

    for (const [fixture, expectedError] of [
      [missingChord, "no valid reference chord"],
      [zeroSpeed, "no valid flow speed"],
    ] as const) {
      const outcome = await resultMediaRepairTick(db, engine, {
        resultId: fixture.resultId,
      });
      expect(outcome.retrying).toBe(1);
      const [repair] = await db
        .select()
        .from(resultMediaRepairs)
        .where(eq(resultMediaRepairs.resultId, fixture.resultId));
      expect(repair.state).toBe("retry_wait");
      expect(repair.lastError).toContain(expectedError);
    }
    expect(renderCalls).toBe(0);
  });

  it("rejects a successful-but-empty render response", async () => {
    const fixture = await createSolvedResult("empty-render");
    await resultMediaRepairTick(
      db,
      engineWith({
        render: async (_jobId, request) => ({
          images: [],
          mean_images: [],
          videos: [],
          scale_version: request.scale_version ?? 1,
          render_profile_key: request.render_profile_key ?? "default:v1:zoom2",
        }),
      }),
      { resultId: fixture.resultId },
    );
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair.state).toBe("retry_wait");
    expect(repair.lastError).toContain("missing instantaneous image");
    expect(
      await db
        .select()
        .from(resultMedia)
        .where(eq(resultMedia.resultId, fixture.resultId)),
    ).toHaveLength(0);
  });

  it("rejects renderer metadata whose checksum does not match stored bytes", async () => {
    const fixture = await createSolvedResult("checksum-mismatch");
    await resultMediaRepairTick(
      db,
      engineWith({
        render: async (jobId, request) => {
          const response = completeMediaResponse(jobId, request);
          if (response.images[0]) response.images[0].sha256 = "0".repeat(64);
          return response;
        },
      }),
      { resultId: fixture.resultId },
    );
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair.state).toBe("retry_wait");
    expect(repair.lastError).toContain("checksum mismatch");
    expect(
      await db
        .select()
        .from(resultMedia)
        .where(eq(resultMedia.resultId, fixture.resultId)),
    ).toHaveLength(0);
  });

  it("fences a delayed renderer after newer evidence replaces its claim", async () => {
    const fixture = await createSolvedResult("stale-renderer");
    const newerManifestSha = "c".repeat(64);
    let invalidated = false;
    const outcome = await resultMediaRepairTick(
      db,
      engineWith({
        render: async (jobId, request) => {
          const response = completeMediaResponse(jobId, request);
          if (!invalidated) {
            invalidated = true;
            await db.insert(solverEvidenceArtifacts).values({
              resultId: fixture.resultId,
              airfoilId: fixture.airfoilId,
              engineJobId: fixture.engineJobId,
              engineCaseSlug: fixture.caseSlug,
              aoaDeg: 6,
              kind: "manifest",
              storageKey: `${PREFIX}/stale-renderer/new-manifest.json`,
              mimeType: "application/json",
              sha256: newerManifestSha,
              byteSize: 513,
              metadata: { evidenceBase: "evidence/stale-renderer-new" },
              createdAt: new Date(Date.now() + 1_000),
            });
            await db
              .update(resultMediaRepairs)
              .set({
                state: "pending",
                evidenceSignature: `${fixture.engineJobId}:${fixture.caseSlug}:${newerManifestSha}`,
                claimToken: null,
                claimedAt: null,
                claimExpiresAt: null,
              })
              .where(eq(resultMediaRepairs.resultId, fixture.resultId));
          }
          return response;
        },
      }),
      { resultId: fixture.resultId },
    );
    expect(outcome.claimed).toBe(true);
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair.state).toBe("pending");
    expect(repair.evidenceSignature).toContain(newerManifestSha);
    expect(
      await db
        .select()
        .from(resultMedia)
        .where(eq(resultMedia.resultId, fixture.resultId)),
    ).toHaveLength(0);
  });

  it("keeps exact repaired media as history but cannot publish over a requeued cell", async () => {
    const fixture = await createSolvedResult("requeued-during-extents");
    const outcome = await resultMediaRepairTick(
      db,
      engineWith({
        extents: async () => {
          await db
            .update(results)
            .set({ status: "pending", source: "queued" })
            .where(eq(results.id, fixture.resultId));
          return {
            fields: {
              velocity_magnitude: { min: 0, max: 50, finite_count: 500 },
            },
          };
        },
      }),
      { resultId: fixture.resultId },
    );
    expect(outcome.claimed).toBe(true);
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair.state).toBe("done");
    expect(repair.lastError).toBeNull();
    expect(
      await db
        .select()
        .from(resultFieldExtents)
        .where(eq(resultFieldExtents.resultId, fixture.resultId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(resultMedia)
        .where(eq(resultMedia.resultId, fixture.resultId)),
    ).toHaveLength(3);
    const [cell] = await db
      .select({
        status: results.status,
        source: results.source,
        currentAttemptId: results.currentResultAttemptId,
      })
      .from(results)
      .where(eq(results.id, fixture.resultId));
    expect(cell).toEqual({
      status: "pending",
      source: "queued",
      currentAttemptId: null,
    });
  });

  it("does not let an old crash-finalizer settle a newer evidence signature", async () => {
    const fixture = await createSolvedResult("stale-finalizer");
    await discoverMissingResultMediaRepairs(db, { resultId: fixture.resultId });
    const [observed] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    const newerSignature = `${fixture.engineJobId}:${fixture.caseSlug}:${"d".repeat(64)}`;
    await db
      .update(resultMediaRepairs)
      .set({ evidenceSignature: newerSignature, state: "pending" })
      .where(eq(resultMediaRepairs.id, observed.id));

    expect(
      await completeSatisfiedResultMediaRepair(
        db,
        observed.id,
        fixture.resultAttemptId,
        observed.evidenceSignature,
      ),
    ).toBe(false);
    const [current] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.id, observed.id));
    expect(current.state).toBe("pending");
    expect(current.evidenceSignature).toBe(newerSignature);
  });

  it("serializes crash finalization with a concurrently attached current manifest", async () => {
    const fixture = await createSolvedResult("manifest-finalize-lock");
    expect(
      (
        await resultMediaRepairTick(db, engineWith(), {
          resultId: fixture.resultId,
        })
      ).finalized,
    ).toBe(1);
    const [repair] = await db
      .update(resultMediaRepairs)
      .set({
        state: "pending",
        completedAt: null,
        downstreamFinalizedAt: null,
      })
      .where(eq(resultMediaRepairs.resultId, fixture.resultId))
      .returning();

    let releaseWriter!: () => void;
    let writerLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      writerLocked = resolve;
    });
    const newerManifestSha = "f".repeat(64);
    const writer = db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await acquireResultEvidenceLock(tx, fixture.resultId);
      writerLocked();
      await release;
      await tx.insert(solverEvidenceArtifacts).values({
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        airfoilId: fixture.airfoilId,
        engineJobId: fixture.engineJobId,
        engineCaseSlug: fixture.caseSlug,
        aoaDeg: 6,
        kind: "manifest",
        storageKey: `${PREFIX}/manifest-finalize-lock/new-manifest.json`,
        mimeType: "application/json",
        sha256: newerManifestSha,
        byteSize: 640,
        metadata: { evidenceBase: "evidence/manifest-finalize-lock-new" },
      });
    });
    await locked;

    let completionSettled = false;
    const completion = completeSatisfiedResultMediaRepair(
      db,
      repair.id,
      fixture.resultAttemptId,
      repair.evidenceSignature,
    ).then((value) => {
      completionSettled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completionSettled).toBe(false);

    releaseWriter();
    await writer;
    expect(await completion).toBe(false);
    const [current] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.id, repair.id));
    expect(current.state).toBe("pending");
  });

  it("locks an artifact's existing result owner before adding a distinct shared-byte association", async () => {
    const fixture = await createSolvedResult("artifact-conflict-lock");
    const storageKey = `${PREFIX}/artifact-conflict-lock/manifest.json`;

    let releaseOwner!: () => void;
    let ownerLocked!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      ownerLocked = resolve;
    });
    const owner = db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await acquireResultEvidenceLock(tx, fixture.resultId);
      ownerLocked();
      await release;
    });
    await locked;

    let associationSettled = false;
    const association = withEvidenceArtifactWriteLocks(
      db,
      {
        storageKey,
        sha256: fixture.manifestSha,
        incomingResultId: null,
      },
      async (tx) => {
        await tx.insert(solverEvidenceArtifacts).values({
          resultId: null,
          airfoilId: fixture.airfoilId,
          engineJobId: `${fixture.engineJobId}-shared-owner`,
          engineCaseSlug: `${fixture.caseSlug}-shared-owner`,
          aoaDeg: 6,
          kind: "manifest",
          storageKey,
          mimeType: "application/json",
          sha256: fixture.manifestSha,
          byteSize: 512,
          metadata: { evidenceBase: "evidence/shared-byte-association" },
        });
      },
    ).then(() => {
      associationSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(associationSettled).toBe(false);

    releaseOwner();
    await owner;
    await association;
    const artifacts = await db
      .select({ resultId: solverEvidenceArtifacts.resultId })
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.storageKey, storageKey),
          eq(solverEvidenceArtifacts.sha256, fixture.manifestSha),
        ),
      );
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.resultId)).toEqual(
      expect.arrayContaining([fixture.resultId, null]),
    );
  });

  it("binds repair to the current solve manifest, not a newer timestamp from an old job", async () => {
    const fixture = await createSolvedResult("manifest-job-scope");
    await db.insert(solverEvidenceArtifacts).values({
      resultId: fixture.resultId,
      airfoilId: fixture.airfoilId,
      engineJobId: `${fixture.engineJobId}-old-other-job`,
      engineCaseSlug: fixture.caseSlug,
      aoaDeg: 6,
      kind: "manifest",
      storageKey: `${PREFIX}/manifest-job-scope/foreign-manifest.json`,
      mimeType: "application/json",
      sha256: "e".repeat(64),
      byteSize: 700,
      metadata: { evidenceBase: "evidence/foreign-old-job" },
      createdAt: new Date(Date.now() + 60_000),
    });

    await discoverMissingResultMediaRepairs(db, { resultId: fixture.resultId });
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair.evidenceSignature).toBe(
      `${fixture.engineJobId}:${fixture.caseSlug}:${fixture.manifestSha}`,
    );
  });

  it("rejects an extent response that silently drops a prior evidence-backed field", async () => {
    const fixture = await createSolvedResult("partial-extents");
    await db.insert(resultFieldExtents).values({
      resultId: fixture.resultId,
      resultAttemptId: fixture.resultAttemptId,
      airfoilId: fixture.airfoilId,
      simulationPresetRevisionId: revisionId,
      field: "pressure",
      vmin: -2,
      vmax: 2,
      finiteCount: 100,
      evidenceSha256: fixture.manifestSha,
    });
    let renderCalls = 0;
    await resultMediaRepairTick(
      db,
      engineWith({
        extents: async () => ({
          fields: {
            velocity_magnitude: { min: 0, max: 30, finite_count: 100 },
          },
        }),
        render: async (jobId, request) => {
          renderCalls++;
          return completeMediaResponse(jobId, request);
        },
      }),
      { resultId: fixture.resultId },
    );
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair.lastError).toContain(
      "omitted prior evidence-backed fields: pressure",
    );
    expect(renderCalls).toBe(0);
  });

  it("removes fields from superseded evidence without requiring them from the new manifest", async () => {
    const fixture = await createSolvedResult("superseded-field");
    await db.insert(resultFieldExtents).values({
      resultId: fixture.resultId,
      airfoilId: fixture.airfoilId,
      simulationPresetRevisionId: revisionId,
      field: "pressure",
      vmin: -9,
      vmax: 9,
      finiteCount: 100,
      evidenceSha256: "old-manifest-sha",
    });
    const outcome = await resultMediaRepairTick(
      db,
      engineWith({
        extents: async () => ({
          fields: {
            velocity_magnitude: { min: 0, max: 30, finite_count: 100 },
          },
        }),
      }),
      { resultId: fixture.resultId },
    );
    expect(outcome.finalized).toBe(1);
    const extents = await db
      .select()
      .from(resultFieldExtents)
      .where(
        and(
          eq(resultFieldExtents.resultId, fixture.resultId),
          eq(resultFieldExtents.resultAttemptId, fixture.resultAttemptId),
        ),
      );
    expect(extents.map((row) => row.field)).toEqual(["velocity_magnitude"]);
    expect(extents[0]?.evidenceSha256).toBe(fixture.manifestSha);

    const historicalExtents = await db
      .select()
      .from(resultFieldExtents)
      .where(
        and(
          eq(resultFieldExtents.resultId, fixture.resultId),
          eq(resultFieldExtents.evidenceSha256, "old-manifest-sha"),
        ),
      );
    expect(historicalExtents).toHaveLength(1);
  });

  it("does not mistake custom-profile artifacts for complete default media", async () => {
    const fixture = await createSolvedResult("custom-is-not-default");
    await db.insert(resultFieldExtents).values({
      resultId: fixture.resultId,
      resultAttemptId: fixture.resultAttemptId,
      airfoilId: fixture.airfoilId,
      simulationPresetRevisionId: revisionId,
      field: "pressure",
      renderProfileKey: "default:v1:zoom2",
      vmin: -2,
      vmax: 2,
      finiteCount: 100,
      evidenceSha256: fixture.manifestSha,
    });
    await db.insert(resultMedia).values([
      {
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        field: "pressure",
        kind: "image",
        role: "instantaneous",
        storageKey: `${PREFIX}/custom/pressure.png`,
        mimeType: "image/png",
        renderProfileKey: "custom:v1",
      },
      {
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        field: "pressure",
        kind: "image",
        role: "mean",
        storageKey: `${PREFIX}/custom/pressure-mean.png`,
        mimeType: "image/png",
        renderProfileKey: "custom:v1",
      },
      {
        resultId: fixture.resultId,
        resultAttemptId: fixture.resultAttemptId,
        field: "pressure",
        kind: "video",
        role: "instantaneous",
        storageKey: `${PREFIX}/custom/pressure.mp4`,
        mimeType: "video/mp4",
        renderProfileKey: "custom:v1",
      },
    ]);

    let renderCalls = 0;
    const outcome = await resultMediaRepairTick(
      db,
      engineWith({
        render: async (jobId, request) => {
          renderCalls++;
          return completeMediaResponse(jobId, request);
        },
      }),
      { resultId: fixture.resultId },
    );
    expect(outcome.finalized).toBe(1);
    expect(renderCalls).toBeGreaterThan(0);
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair.state).toBe("done");
    const stored = await db
      .select()
      .from(resultMedia)
      .where(
        and(
          eq(resultMedia.resultId, fixture.resultId),
          eq(resultMedia.resultAttemptId, fixture.resultAttemptId),
          eq(resultMedia.renderProfileKey, "default:v1:zoom2"),
        ),
      );
    expect(stored.length).toBeGreaterThan(0);
    expect(
      stored.every((row) => row.evidenceSha256 === fixture.manifestSha),
    ).toBe(true);

    const custom = await db
      .select()
      .from(resultMedia)
      .where(
        and(
          eq(resultMedia.resultId, fixture.resultId),
          eq(resultMedia.resultAttemptId, fixture.resultAttemptId),
          eq(resultMedia.renderProfileKey, "custom:v1"),
        ),
      );
    expect(custom).toHaveLength(3);
  });

  it("self-heals a crash after media commit and enqueues exactly one verification", async () => {
    const fixture = await createSolvedResult("crash-after-commit");
    await discoverMissingResultMediaRepairs(db, { resultId: fixture.resultId });
    const claim = await claimNextResultMediaRepair(db, {
      resultId: fixture.resultId,
    });
    expect(claim).not.toBeNull();
    await repairDefaultMediaForStoredResult({
      db,
      engine: engineWith(),
      resultId: fixture.resultId,
      resultAttemptId: fixture.resultAttemptId,
      heartbeat: async () => undefined,
      repairFence: {
        repairId: claim!.id,
        resultAttemptId: fixture.resultAttemptId,
        claimToken: claim!.claimToken!,
        evidenceSignature: claim!.evidenceSignature,
      },
    });
    const [stillRunning] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(stillRunning.state).toBe("running");

    const first = await finalizeSatisfiedResultMediaRepairs(db, {
      resultId: fixture.resultId,
    });
    const second = await finalizeSatisfiedResultMediaRepairs(db, {
      resultId: fixture.resultId,
    });
    expect(first.finalized).toBe(1);
    expect(second.finalized).toBe(0);
    const [settled] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(settled.state).toBe("done");
    const [classification] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, fixture.resultId));
    expect(classification.state).toBe("accepted");
    const verifyRows = await db
      .select()
      .from(simUransVerifyQueue)
      .where(eq(simUransVerifyQueue.precalcResultId, fixture.resultId));
    expect(verifyRows).toHaveLength(1);
  });

  it("satisfies a blocked PRECALC obligation after verified media makes its real attempt accepted", async () => {
    const fixture = await createBlockedPrecalcFixture(
      "precalc-obligation-media-success",
    );
    const outcome = await resultMediaRepairTick(db, engineWith(), {
      resultId: fixture.resultId,
    });
    expect(outcome.finalized).toBe(1);

    const [resultClassification] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, fixture.resultId));
    const [attemptClassification] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(
        eq(resultClassifications.resultAttemptId, fixture.resultAttemptId),
      );
    expect(resultClassification.state).toBe("accepted");
    expect(attemptClassification.state).toBe("accepted");

    const [obligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, fixture.obligationId));
    expect(obligation).toMatchObject({
      state: "satisfied",
      attemptCount: 1,
      latestSimJobId: fixture.jobId,
      sourceResultId: fixture.resultId,
      sourceResultAttemptId: fixture.resultAttemptId,
      lastOutcome: "accepted",
      lastError: null,
    });
    const ledger = await db
      .select()
      .from(simPrecalcObligationAttempts)
      .where(
        eq(simPrecalcObligationAttempts.obligationId, fixture.obligationId),
      );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      attemptNumber: 1,
      state: "accepted",
      outcome: "accepted",
      resultAttemptId: fixture.resultAttemptId,
      error: null,
    });
    expect(
      await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(eq(simJobs.airfoilId, fixture.airfoilId)),
    ).toEqual([{ id: fixture.jobId }]);

    // Re-running downstream finalization is a no-op: no second ledger row,
    // no solver job, and no attempt-budget mutation.
    expect(
      (
        await finalizeSatisfiedResultMediaRepairs(db, {
          resultId: fixture.resultId,
        })
      ).finalized,
    ).toBe(0);
    expect(
      await db
        .select({ id: simPrecalcObligationAttempts.id })
        .from(simPrecalcObligationAttempts)
        .where(
          eq(simPrecalcObligationAttempts.obligationId, fixture.obligationId),
        ),
    ).toHaveLength(1);
  });

  it("MUST-CATCH: satisfies a no-shedding preliminary URANS obligation stored with the physical RANS regime", async () => {
    const fixture = await createNoSheddingBlockedPrecalcFixture(
      "no-shedding-precalc-settlement",
    );

    const satisfaction = await satisfyPrecalcObligationFromAcceptedResult(
      db,
      fixture.resultId,
    );
    expect(satisfaction).toMatchObject({
      obligationId: fixture.obligationId,
      resultAttemptId: fixture.resultAttemptId,
      changed: true,
    });
    const [obligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, fixture.obligationId));
    expect(obligation).toMatchObject({
      state: "satisfied",
      sourceResultId: fixture.resultId,
      sourceResultAttemptId: fixture.resultAttemptId,
      lastOutcome: "accepted",
      lastError: null,
    });
  });

  it("keeps the physical PRECALC obligation blocked when media repair exhausts", async () => {
    const fixture = await createBlockedPrecalcFixture(
      "precalc-obligation-media-exhausted",
    );
    const failingEngine = engineWith({
      extents: async () => {
        throw new Error("raw evidence unavailable for media repair");
      },
    });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await resultMediaRepairTick(db, failingEngine, {
        resultId: fixture.resultId,
      });
      if (attempt < 3) {
        await db
          .update(resultMediaRepairs)
          .set({ nextAttemptAt: new Date(0) })
          .where(eq(resultMediaRepairs.resultId, fixture.resultId));
      }
    }
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair).toMatchObject({
      state: "blocked",
      attemptCount: 3,
    });
    expect(repair.lastError).toContain("raw evidence unavailable");

    const [obligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, fixture.obligationId));
    expect(obligation).toMatchObject({
      state: "blocked",
      attemptCount: 1,
      sourceResultAttemptId: fixture.resultAttemptId,
      lastOutcome: "rejected_exhausted",
      lastError: "missing-urans-video",
    });
    const [ledger] = await db
      .select()
      .from(simPrecalcObligationAttempts)
      .where(
        eq(simPrecalcObligationAttempts.obligationId, fixture.obligationId),
      );
    expect(ledger).toMatchObject({
      state: "rejected",
      outcome: "rejected_exhausted",
      resultAttemptId: fixture.resultAttemptId,
    });
    const [classification] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(
        eq(resultClassifications.resultAttemptId, fixture.resultAttemptId),
      );
    expect(classification.state).toBe("rejected");
    expect(
      await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(eq(simJobs.airfoilId, fixture.airfoilId)),
    ).toEqual([{ id: fixture.jobId }]);
  });

  it("withdraws a selected URANS generation when crash-recovered video bytes are missing", async () => {
    const fixture = await createSolvedResult("crash-byte-loss");
    await discoverMissingResultMediaRepairs(db, { resultId: fixture.resultId });
    const claim = await claimNextResultMediaRepair(db, {
      resultId: fixture.resultId,
    });
    expect(claim?.claimToken).toBeTruthy();
    await repairDefaultMediaForStoredResult({
      db,
      engine: engineWith({
        extents: async () => ({
          fields: {
            velocity_magnitude: { min: 0, max: 44, finite_count: 500 },
          },
          window_start: 1,
          window_end: 2,
        }),
      }),
      resultId: fixture.resultId,
      resultAttemptId: fixture.resultAttemptId,
      heartbeat: async () => undefined,
      repairFence: {
        repairId: claim!.id,
        resultAttemptId: fixture.resultAttemptId,
        claimToken: claim!.claimToken!,
        evidenceSignature: claim!.evidenceSignature,
      },
    });
    await refreshPolarCacheForRevision(db, fixture.airfoilId, revisionId, {
      afterAttemptClassifications: async (tx) => {
        await tx
          .update(results)
          .set({ currentResultAttemptId: fixture.resultAttemptId })
          .where(eq(results.id, fixture.resultId));
      },
    });
    const [selectedBeforeLoss] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, fixture.resultId));
    const [classificationBeforeLoss] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(
        eq(resultClassifications.resultAttemptId, fixture.resultAttemptId),
      );
    const [fitBeforeLoss] = await db
      .select({ id: polarFitSets.id })
      .from(polarFitSets)
      .where(
        and(
          eq(polarFitSets.airfoilId, fixture.airfoilId),
          eq(polarFitSets.simulationPresetRevisionId, revisionId),
          eq(polarFitSets.isCurrent, true),
        ),
      );
    const [compatibilityBeforeLoss] = await db
      .select({ id: polarCompatibilityFitSets.id })
      .from(polarCompatibilityFitSets)
      .where(
        and(
          eq(polarCompatibilityFitSets.airfoilId, fixture.airfoilId),
          eq(polarCompatibilityFitSets.isCurrent, true),
        ),
      );
    expect(selectedBeforeLoss.currentResultAttemptId).toBe(
      fixture.resultAttemptId,
    );
    expect(classificationBeforeLoss.state).toBe("accepted");
    const [stored] = await db
      .select()
      .from(resultMedia)
      .where(
        and(
          eq(resultMedia.resultId, fixture.resultId),
          eq(resultMedia.resultAttemptId, fixture.resultAttemptId),
          eq(resultMedia.kind, "video"),
          eq(resultMedia.role, "instantaneous"),
        ),
      )
      .limit(1);
    expect(stored).toBeTruthy();
    rmSync(resolve(MEDIA_ROOT, stored.storageKey), { force: true });

    const finalized = await finalizeSatisfiedResultMediaRepairs(db, {
      resultId: fixture.resultId,
    });
    expect(finalized.finalized).toBe(0);
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair.state).toBe("retry_wait");
    expect(repair.lastError).toContain("not readable on the shared volume");
    expect(
      await db.select().from(resultMedia).where(eq(resultMedia.id, stored.id)),
    ).toHaveLength(0);
    const [withdrawn] = await db
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, fixture.resultId));
    const [rejectedAttempt] = await db
      .select({
        state: resultClassifications.state,
        reasons: resultClassifications.reasons,
      })
      .from(resultClassifications)
      .where(
        eq(resultClassifications.resultAttemptId, fixture.resultAttemptId),
      );
    const [retiredFit] = await db
      .select({ isCurrent: polarFitSets.isCurrent })
      .from(polarFitSets)
      .where(eq(polarFitSets.id, fitBeforeLoss.id));
    const [retiredCompatibility] = await db
      .select({ isCurrent: polarCompatibilityFitSets.isCurrent })
      .from(polarCompatibilityFitSets)
      .where(eq(polarCompatibilityFitSets.id, compatibilityBeforeLoss.id));
    expect(withdrawn.currentResultAttemptId).toBeNull();
    expect(rejectedAttempt.state).toBe("rejected");
    expect(rejectedAttempt.reasons).toContain("missing-urans-video");
    expect(retiredFit.isCurrent).toBe(false);
    expect(retiredCompatibility.isCurrent).toBe(false);
  });

  it("fences concurrent and stale owners, then blocks after three attempts without rediscovery", async () => {
    const fixture = await createSolvedResult("claim-fencing");
    const t0 = new Date("2026-07-11T00:00:00.000Z");
    await discoverMissingResultMediaRepairs(db, {
      resultId: fixture.resultId,
      now: t0,
    });
    const [a, b] = await Promise.all([
      claimNextResultMediaRepair(db, {
        resultId: fixture.resultId,
        now: t0,
        leaseMs: 30_000,
      }),
      claimNextResultMediaRepair(db, {
        resultId: fixture.resultId,
        now: t0,
        leaseMs: 30_000,
      }),
    ]);
    const first = a ?? b;
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(first).not.toBeNull();

    const t1 = new Date(t0.getTime() + 31_000);
    expect(await renewResultMediaRepairClaim(db, first!, { now: t1 })).toBe(
      false,
    );
    expect(
      (await healExpiredResultMediaRepairClaims(db, { now: t1 })).retrying,
    ).toBe(1);
    const second = await claimNextResultMediaRepair(db, {
      resultId: fixture.resultId,
      now: t1,
    });
    expect(second?.claimToken).not.toBe(first?.claimToken);
    expect(
      await failClaimedResultMediaRepair(db, first!, "stale owner", {
        now: t1,
        backoffMs: 0,
      }),
    ).toBeNull();
    const [ownedBySecond] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(ownedBySecond.state).toBe("running");
    expect(ownedBySecond.claimToken).toBe(second?.claimToken);

    expect(
      await failClaimedResultMediaRepair(db, second!, "attempt two", {
        now: t1,
        backoffMs: 0,
      }),
    ).toBe("retry_wait");
    const third = await claimNextResultMediaRepair(db, {
      resultId: fixture.resultId,
      now: new Date(t1.getTime() + 1),
    });
    expect(third?.attemptCount).toBe(3);
    expect(
      await failClaimedResultMediaRepair(
        db,
        third!,
        "raw evidence unavailable",
        {
          now: new Date(t1.getTime() + 2),
        },
      ),
    ).toBe("blocked");
    expect(
      await discoverMissingResultMediaRepairs(db, {
        resultId: fixture.resultId,
      }),
    ).toBe(0);
    expect(
      await claimNextResultMediaRepair(db, { resultId: fixture.resultId }),
    ).toBeNull();
    const [blocked] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(blocked.state).toBe("blocked");
    expect(blocked.attemptCount).toBe(3);
    expect(blocked.lastError).toContain("raw evidence unavailable");
  });

  it("does not let an unchanged blocked prefix consume the discovery limit", async () => {
    const airfoilId = await createAirfoil("starvation");
    const blockedA = await createSolvedResult("starvation-a", {
      airfoilId,
      aoa: 1,
    });
    const blockedB = await createSolvedResult("starvation-b", {
      airfoilId,
      aoa: 2,
    });
    const target = await createSolvedResult("starvation-target", {
      airfoilId,
      aoa: 3,
    });
    for (const fixture of [blockedA, blockedB]) {
      await discoverMissingResultMediaRepairs(db, {
        resultId: fixture.resultId,
      });
      await db
        .update(resultMediaRepairs)
        .set({ state: "blocked", attemptCount: 3, lastError: "permanent" })
        .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    }
    expect(
      await discoverMissingResultMediaRepairs(db, { airfoilId, limit: 1 }),
    ).toBe(1);
    const [targetRepair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, target.resultId));
    expect(targetRepair?.state).toBe("pending");
  });

  it("preserves background provenance when a catalog result is linked to a campaign before discovery", async () => {
    const airfoilId = await createAirfoil("background-linked");
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        campaignId: null,
        referenceChordM: 0.15,
        wave: 2,
        status: "done",
        totalCases: 1,
        completedCases: 1,
        requestPayload: null,
      })
      .returning();
    const fixture = await createSolvedResult("background-linked", {
      airfoilId,
      simJobId: job.id,
    });

    const [campaign] = await db
      .insert(simCampaigns)
      .values({
        slug: `${PREFIX}-background-linked-campaign`,
        name: `${PREFIX} background linked campaign`,
        idempotencyKey: `${PREFIX}-background-linked-key`,
      })
      .returning();
    campaignIds.push(campaign.id);
    const [plan] = await db
      .insert(simCampaignPlanRevisions)
      .values({
        campaignId: campaign.id,
        revisionNumber: 1,
        kind: "initial",
        plan: {},
        summary: {},
      })
      .returning();
    await db
      .update(simCampaigns)
      .set({ currentPlanRevisionId: plan.id })
      .where(eq(simCampaigns.id, campaign.id));
    await db
      .insert(simCampaignAirfoils)
      .values({ campaignId: campaign.id, airfoilId });
    const [condition] = await db
      .insert(simCampaignConditions)
      .values({
        campaignId: campaign.id,
        ord: 1,
        flowConditionId: flowId,
        referenceGeometryProfileId: referenceGeometryId,
        presetId,
        simulationPresetRevisionId: revisionId,
        reynolds: 250_000,
        mach: 0.07,
        introducedInPlanRevisionId: plan.id,
      })
      .returning();
    await db.insert(simCampaignPoints).values({
      campaignId: campaign.id,
      conditionId: condition.id,
      airfoilId,
      aoaDeg: 6,
      revisionId,
      planRevisionNumber: 1,
      state: "terminal",
      resultId: fixture.resultId,
    });

    expect(
      await discoverMissingResultMediaRepairs(db, {
        resultId: fixture.resultId,
      }),
    ).toBe(1);
    const [repair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, fixture.resultId));
    expect(repair.backgroundOwner).toBe(true);
  });

  it("re-scales one claimed result at a time and reopens siblings on the old scale", async () => {
    const airfoilId = await createAirfoil("scale-fence");
    const first = await createSolvedResult("scale-fence-a", {
      airfoilId,
      aoa: 1,
    });
    expect(
      (
        await resultMediaRepairTick(db, engineWith(), {
          resultId: first.resultId,
        })
      ).finalized,
    ).toBe(1);

    const second = await createSolvedResult("scale-fence-b", {
      airfoilId,
      aoa: 2,
    });
    const secondOutcome = await resultMediaRepairTick(
      db,
      engineWith({
        extents: async () => ({
          fields: {
            velocity_magnitude: { min: 0, max: 100, finite_count: 500 },
            pressure: { min: -8, max: 6, finite_count: 500 },
          },
        }),
      }),
      { resultId: second.resultId },
    );
    expect(secondOutcome.finalized).toBe(1);
    const [secondRepair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, second.resultId));
    expect(secondRepair.state).toBe("done");

    // Activating B's wider shared scale makes A's media stale. Discovery
    // reopens A under its own token instead of writing A under B's claim.
    expect(
      await discoverMissingResultMediaRepairs(db, { resultId: first.resultId }),
    ).toBe(1);
    const [firstRepair] = await db
      .select()
      .from(resultMediaRepairs)
      .where(eq(resultMediaRepairs.resultId, first.resultId));
    expect(firstRepair.state).toBe("pending");
  });

  it("FALSE-POSITIVE GUARD: a no-shedding PRECALC result needs exact stills, not an invented transient video", async () => {
    const fixture = await createSolvedResult("no-shedding", {
      unsteady: false,
      fidelity: "urans_precalc",
      regime: "rans",
    });
    const unsteadyFlags: boolean[] = [];
    const outcome = await resultMediaRepairTick(
      db,
      engineWith({
        render: async (jobId, request) => {
          unsteadyFlags.push(Boolean(request.unsteady));
          return completeMediaResponse(jobId, request);
        },
      }),
      { resultId: fixture.resultId },
    );
    expect(outcome.finalized).toBe(1);
    expect(unsteadyFlags.length).toBeGreaterThan(0);
    expect(unsteadyFlags.every((flag) => flag === false)).toBe(true);
    const videos = await db
      .select()
      .from(resultMedia)
      .where(
        and(
          eq(resultMedia.resultId, fixture.resultId),
          eq(resultMedia.kind, "video"),
        ),
      );
    expect(videos).toHaveLength(0);
  });
});
