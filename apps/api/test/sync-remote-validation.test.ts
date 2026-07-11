import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MEDIA_DIR = join(tmpdir(), `xff-api-sync-${process.pid}-${Date.now().toString(36)}`);
mkdirSync(MEDIA_DIR, { recursive: true });
process.env.MEDIA_DIR = MEDIA_DIR;

const dbSchema = await import("@aerodb/db");
const { ensureSimulationPresetRevision } = await import("@aerodb/db/simulation-setup");
const { db, sql } = await import("../src/db");
const { buildServer } = await import("../src/server");

const {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  referenceGeometryProfiles,
  resultAttempts,
  results,
  schedulingProfiles,
  simJobs,
  simulationPresets,
  solverEvidenceArtifacts,
  solverProfiles,
  syncApiPermissions,
  syncApiSettings,
  syncImportConflicts,
  syncSweepPromisePoints,
  syncSweepPromises,
  sweepDefinitions,
} = dbSchema;

const PREFIX = `sync-remote-validation-${process.pid}-${Date.now().toString(36)}`;
const SECRET = `${PREFIX}-secret`;
const SYNC_TYPES = ["sweeps", "airfoils", "catalog_metadata", "mediums", "simulation_setup", "polars", "evidence_artifacts", "result_media"] as const;
const contour = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.07 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.05 },
  { x: 1, y: 0 },
];

let app: Awaited<ReturnType<typeof buildServer>>;
let savedSettings: typeof syncApiSettings.$inferSelect | null = null;
let savedPermissions: (typeof syncApiPermissions.$inferSelect)[] = [];
let categoryId = "";
let airfoilId = "";
let airfoilSlug = "";
let mediumId = "";
let legacyBcId = "";
let validLocalBcId = "";
let flowId = "";
let referenceGeometryId = "";
let presetId = "";
let revisionId = "";
let revisionSignatureHash = "";
let reynolds = 0;
let mach: number | null = null;
let speed = 0;
let kinematicViscosity = 0;
const CHORD = 0.432;
const profileIds = { boundary: "", mesh: "", solver: "", scheduling: "", output: "", sweep: "" };
const cleanupPromiseIds = new Set<string>();
const cleanupConflictIds = new Set<string>();

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function deleteIds(table: any, column: any, ids: string[]) {
  if (ids.length) await db.delete(table).where(inArray(column, ids));
}

async function configureSync() {
  await db.insert(syncApiSettings).values({ id: 1 }).onConflictDoNothing();
  const [settings] = await db.select().from(syncApiSettings).where(eq(syncApiSettings.id, 1)).limit(1);
  savedSettings = settings ?? null;
  savedPermissions = await db.select().from(syncApiPermissions);
  await db
    .update(syncApiSettings)
    .set({ enabled: true, secret: SECRET, defaultPromiseTtlHours: 24, updatedAt: new Date() })
    .where(eq(syncApiSettings.id, 1));
  for (const dataType of SYNC_TYPES) {
    await db
      .insert(syncApiPermissions)
      .values({ dataType, canFetch: true, canPush: true })
      .onConflictDoUpdate({ target: syncApiPermissions.dataType, set: { canFetch: true, canPush: true, updatedAt: new Date() } });
  }
}

async function restoreSync() {
  if (savedSettings) {
    const { id: _id, createdAt: _createdAt, ...rest } = savedSettings;
    await db
      .update(syncApiSettings)
      .set({ ...rest, updatedAt: new Date() })
      .where(eq(syncApiSettings.id, 1));
  } else {
    await db.delete(syncApiSettings).where(eq(syncApiSettings.id, 1));
  }
  await db.delete(syncApiPermissions);
  if (savedPermissions.length) await db.insert(syncApiPermissions).values(savedPermissions);
}

async function createBoundaryCondition(suffix: string, speedMps: number) {
  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-${suffix}-bc`,
      name: `${PREFIX} ${suffix} BC`,
      mediumId,
      reynolds: Math.round((speedMps * CHORD) / kinematicViscosity),
      referenceChordM: CHORD,
      temperatureK: 288.15,
      pressurePa: 101325,
      speedMps,
      density: 1.225,
      dynamicViscosity: 1.789e-5,
      kinematicViscosity,
      mach,
      enabled: true,
    })
    .returning({ id: boundaryConditions.id });
  return bc.id;
}

async function createFixture() {
  const [air] = await db.select().from(mediums).where(eq(mediums.slug, "air")).limit(1);
  if (!air) throw new Error("seeded air medium required");
  mediumId = air.id;
  speed = 23.75;
  kinematicViscosity = air.kinematicViscosity;
  reynolds = Math.round((speed * CHORD) / air.kinematicViscosity);
  mach = air.speedOfSound ? speed / air.speedOfSound : null;

  const [cat] = await db.insert(categories).values({ slug: `${PREFIX}-cat`, name: `${PREFIX} cat`, path: `${PREFIX}-cat`, depth: 0 }).returning();
  categoryId = cat.id;
  const [foil] = await db
    .insert(airfoils)
    .values({ slug: `${PREFIX}-foil`, name: `${PREFIX} foil`, categoryId, points: contour, pointFormat: "normalized", isSymmetric: false })
    .returning();
  airfoilId = foil.id;
  airfoilSlug = foil.slug;

  const [legacy] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-legacy-bc`,
      name: `${PREFIX} legacy BC`,
      mediumId,
      reynolds,
      referenceChordM: CHORD,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: speed,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach,
      enabled: true,
    })
    .returning({ id: boundaryConditions.id });
  legacyBcId = legacy.id;
  validLocalBcId = await createBoundaryCondition("valid-local", speed + 1.25);

  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${PREFIX}-flow`,
      name: `${PREFIX} flow`,
      mediumId,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: speed,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach,
    })
    .returning();
  flowId = flow.id;
  const [reference] = await db
    .insert(referenceGeometryProfiles)
    .values({ slug: `${PREFIX}-reference`, name: `${PREFIX} reference`, geometryType: "airfoil_2d", referenceLengthKind: "chord", referenceLengthM: CHORD })
    .returning();
  referenceGeometryId = reference.id;
  const [boundary] = await db.insert(boundaryProfiles).values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` }).returning();
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` }).returning();
  const [solver] = await db.insert(solverProfiles).values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` }).returning();
  const [scheduling] = await db.insert(schedulingProfiles).values({ slug: `${PREFIX}-scheduling`, name: `${PREFIX} scheduling` }).returning();
  const [output] = await db.insert(outputProfiles).values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` }).returning();
  const [sweep] = await db.insert(sweepDefinitions).values({ slug: `${PREFIX}-sweep`, name: `${PREFIX} sweep`, aoaList: [700.001, 701.001, 702.001] }).returning();
  profileIds.boundary = boundary.id;
  profileIds.mesh = mesh.id;
  profileIds.solver = solver.id;
  profileIds.scheduling = scheduling.id;
  profileIds.output = output.id;
  profileIds.sweep = sweep.id;

  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${PREFIX}-preset`,
      name: `${PREFIX} preset`,
      flowConditionId: flowId,
      referenceGeometryProfileId: referenceGeometryId,
      boundaryProfileId: profileIds.boundary,
      meshProfileId: profileIds.mesh,
      solverProfileId: profileIds.solver,
      schedulingProfileId: profileIds.scheduling,
      outputProfileId: profileIds.output,
      sweepDefinitionId: profileIds.sweep,
      legacyBoundaryConditionId: legacyBcId,
      enabled: false,
    })
    .returning({ id: simulationPresets.id });
  presetId = preset.id;
  const resolved = await ensureSimulationPresetRevision(db, presetId);
  if (!resolved) throw new Error("simulation preset revision required");
  revisionId = resolved.revision.id;
  revisionSignatureHash = resolved.revision.signatureHash;
}

function bytesItem(label: string, mimeType = "application/json") {
  const buf = Buffer.from(`${PREFIX}:${label}`);
  const contentBase64 = buf.toString("base64");
  return {
    contentBase64,
    sha256: sha256(buf),
    byteSize: buf.byteLength,
    mimeType,
  };
}

function mediaItem(label: string, mimeType = "image/png") {
  return {
    kind: "image",
    field: `pressure_${label.replace(/[^a-z0-9]+/gi, "_")}`,
    role: "instantaneous",
    width: 2,
    height: 2,
    renderProfileKey: "default:v1:zoom2",
    ...bytesItem(`media:${label}`, mimeType),
  };
}

function artifactItem(label: string) {
  return {
    kind: "manifest",
    role: "raw",
    filename: `${label}.json`,
    metadata: { label, retained: true },
    ...bytesItem(`artifact:${label}`, "application/json"),
  };
}

function makePoint(aoaDeg: number, patch: Record<string, unknown> = {}) {
  return {
    aoaDeg,
    status: "done",
    source: "solved",
    regime: "rans",
    reynolds,
    speed,
    chord: CHORD,
    mach,
    cl: 0.4 + aoaDeg / 10000,
    cd: 0.012 + aoaDeg / 100000,
    cm: -0.02,
    clCd: 30,
    stalled: false,
    unsteady: false,
    converged: true,
    firstOrderFallback: false,
    finalResidual: 1e-5,
    iterations: 1200,
    engineJobId: `${PREFIX}-engine-${aoaDeg}`,
    engineCaseSlug: `aoa_${String(aoaDeg).replace(".", "_")}`,
    fieldExtents: [],
    evidenceArtifacts: [],
    media: [],
    ...patch,
  };
}

function polarPayload(resultsPayload: unknown[], patch: Record<string, unknown> = {}) {
  return {
    sourceInstanceId: `${PREFIX}-source`,
    sourceInstanceName: "remote validation test",
    airfoilSlug,
    simulationPresetRevisionId: revisionId,
    simulationPresetSignatureHash: revisionSignatureHash,
    bcId: legacyBcId,
    fieldColorScales: [],
    results: resultsPayload,
    ...patch,
  };
}

async function postJson(url: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/json",
      "x-xfoilfoam-sync-secret": SECRET,
    },
    payload: JSON.stringify(payload),
  });
}

async function postPolars(payload: unknown) {
  return postJson("/api/sync/v1/polars", payload);
}

async function resultAt(aoaDeg: number) {
  const [row] = await db
    .select()
    .from(results)
    .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, aoaDeg)))
    .limit(1);
  return row ?? null;
}

async function createPromise(status: "fulfilled" | "cancelled", aoaDeg: number) {
  const [promise] = await db
    .insert(syncSweepPromises)
    .values({
      sourceInstanceId: `${PREFIX}-${status}`,
      sourceInstanceName: `${status} remote`,
      status,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaCount: 1,
      expiresAt: new Date(Date.now() + 3600_000),
      fulfilledAt: status === "fulfilled" ? new Date() : null,
      cancelledAt: status === "cancelled" ? new Date() : null,
    })
    .returning({ id: syncSweepPromises.id });
  cleanupPromiseIds.add(promise.id);
  await db.insert(syncSweepPromisePoints).values({
    promiseId: promise.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg,
    status,
  });
  return promise.id;
}

beforeAll(async () => {
  await configureSync();
  await createFixture();
  app = await buildServer();
});

afterAll(async () => {
  await app?.close();
  await db.delete(solverEvidenceArtifacts).where(eq(solverEvidenceArtifacts.airfoilId, airfoilId));
  await db.delete(resultAttempts).where(eq(resultAttempts.simulationPresetRevisionId, revisionId));
  await db.delete(polarFitSets).where(eq(polarFitSets.simulationPresetRevisionId, revisionId));
  if (cleanupPromiseIds.size) await db.delete(syncSweepPromises).where(inArray(syncSweepPromises.id, Array.from(cleanupPromiseIds)));
  await db.delete(results).where(eq(results.simulationPresetRevisionId, revisionId));
  await db.delete(simJobs).where(eq(simJobs.simulationPresetRevisionId, revisionId));
  if (cleanupConflictIds.size) await db.delete(syncImportConflicts).where(inArray(syncImportConflicts.id, Array.from(cleanupConflictIds)));
  await db.delete(syncImportConflicts).where(eq(syncImportConflicts.sourceInstanceId, `${PREFIX}-source`));
  await deleteIds(simulationPresets, simulationPresets.id, [presetId].filter(Boolean));
  await deleteIds(boundaryConditions, boundaryConditions.id, [legacyBcId, validLocalBcId].filter(Boolean));
  await deleteIds(flowConditions, flowConditions.id, [flowId].filter(Boolean));
  await deleteIds(referenceGeometryProfiles, referenceGeometryProfiles.id, [referenceGeometryId].filter(Boolean));
  await deleteIds(boundaryProfiles, boundaryProfiles.id, [profileIds.boundary].filter(Boolean));
  await deleteIds(meshProfiles, meshProfiles.id, [profileIds.mesh].filter(Boolean));
  await deleteIds(solverProfiles, solverProfiles.id, [profileIds.solver].filter(Boolean));
  await deleteIds(schedulingProfiles, schedulingProfiles.id, [profileIds.scheduling].filter(Boolean));
  await deleteIds(outputProfiles, outputProfiles.id, [profileIds.output].filter(Boolean));
  await deleteIds(sweepDefinitions, sweepDefinitions.id, [profileIds.sweep].filter(Boolean));
  await deleteIds(airfoils, airfoils.id, [airfoilId].filter(Boolean));
  await deleteIds(categories, categories.id, [categoryId].filter(Boolean));
  await restoreSync();
  await sql.end();
  rmSync(MEDIA_DIR, { recursive: true, force: true });
});

describe("remote solver sync validation regressions", () => {
  it("MUST-CATCH: /polars accepts a >1 MiB inline-media body while other sync POST routes keep the default 413 limit", async () => {
    const buf = Buffer.alloc(1_600_000, 7);
    const bigMedia = {
      kind: "image",
      field: "pressure_big",
      role: "instantaneous",
      width: 16,
      height: 16,
      mimeType: "image/png",
      contentBase64: buf.toString("base64"),
      sha256: sha256(buf),
      byteSize: buf.byteLength,
    };

    const accepted = await postPolars(polarPayload([makePoint(700.001, { media: [bigMedia] })]));
    expect(accepted.statusCode).toBeGreaterThanOrEqual(200);
    expect(accepted.statusCode).toBeLessThan(300);
    expect(accepted.json()).toMatchObject({ imported: 1, attempts: 1, media: 1 });

    const tooLargeForDefault = await postJson("/api/sync/v1/sweeps/claim", {
      limit: 1,
      sourceInstanceId: `${PREFIX}-default-limit`,
      padding: bigMedia.contentBase64,
    });
    expect(tooLargeForDefault.statusCode).toBe(413);
  });

  it("uses the hub revision legacy boundary condition for foreign bcId and preserves a valid local bcId", async () => {
    const foreignBcId = randomUUID();
    const foreign = await postPolars(polarPayload([makePoint(701.001)], { bcId: foreignBcId }));
    expect(foreign.statusCode).toBe(200);
    const foreignRow = await resultAt(701.001);
    expect(foreignRow?.bcId).toBe(legacyBcId);
    expect(foreignRow?.bcId).not.toBe(foreignBcId);

    const validLocal = await postPolars(polarPayload([makePoint(702.001)], { bcId: validLocalBcId }));
    expect(validLocal.statusCode).toBe(200);
    const validLocalRow = await resultAt(702.001);
    expect(validLocalRow?.bcId).toBe(validLocalBcId);
  });

  it("strips media and evidence artifact contentBase64 from result_attempts.evidence_payload while retaining hashes and metadata", async () => {
    const artifact = artifactItem("attempt-sanitize");
    const media = mediaItem("attempt-sanitize");
    const pushed = await postPolars(polarPayload([makePoint(703.001, { evidenceArtifacts: [artifact], media: [media] })]));
    expect(pushed.statusCode).toBe(200);
    const row = await resultAt(703.001);
    expect(row?.id).toBeTruthy();
    const [attempt] = await db.select().from(resultAttempts).where(eq(resultAttempts.resultId, row!.id)).limit(1);
    const evidencePayload = attempt.evidencePayload as { evidenceArtifacts?: Record<string, unknown>[]; media?: Record<string, unknown>[] };
    const serialized = JSON.stringify(evidencePayload);
    expect(serialized).not.toContain(artifact.contentBase64);
    expect(serialized).not.toContain(media.contentBase64);
    expect(evidencePayload.evidenceArtifacts?.[0]).toMatchObject({
      contentBase64: `[stripped ${artifact.contentBase64.length} base64 chars]`,
      sha256: artifact.sha256,
      metadata: { label: "attempt-sanitize", retained: true },
    });
    expect(evidencePayload.media?.[0]).toMatchObject({
      contentBase64: `[stripped ${media.contentBase64.length} base64 chars]`,
      sha256: media.sha256,
      field: media.field,
    });
  });

  it("strips base64 from sync conflict incoming_payload for non-equivalent existing polar rows", async () => {
    const aoaDeg = 704.001;
    await db.insert(results).values({
      airfoilId,
      bcId: legacyBcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "rans",
      reynolds,
      speed,
      chord: CHORD,
      mach,
      cl: 0.42,
      cd: 0.011,
      cm: -0.02,
      stalled: false,
      unsteady: false,
      converged: true,
      engineJobId: `${PREFIX}-existing-conflict`,
      solvedAt: new Date(),
    });

    const media = mediaItem("conflict-sanitize");
    const pushed = await postPolars(polarPayload([makePoint(aoaDeg, { cl: 0.99, media: [media] })]));
    expect(pushed.statusCode).toBe(200);
    const body = pushed.json() as { conflictIds: string[] };
    expect(body.conflictIds).toHaveLength(1);
    cleanupConflictIds.add(body.conflictIds[0]);

    const [conflict] = await db.select().from(syncImportConflicts).where(eq(syncImportConflicts.id, body.conflictIds[0])).limit(1);
    const incoming = conflict.incomingPayload as { media?: Record<string, unknown>[] };
    const serialized = JSON.stringify(incoming);
    expect(serialized).not.toContain(media.contentBase64);
    expect(incoming.media?.[0]).toMatchObject({
      contentBase64: `[stripped ${media.contentBase64.length} base64 chars]`,
      sha256: media.sha256,
      field: media.field,
    });
  });

  it("accepts late chunks for fulfilled promises but rejects cancelled promises without writing a result", async () => {
    const fulfilledPromiseId = await createPromise("fulfilled", 705.001);
    const late = await postPolars(polarPayload([makePoint(705.001)], { promiseId: fulfilledPromiseId, bcId: undefined }));
    expect(late.statusCode).toBe(200);
    expect(await resultAt(705.001)).toMatchObject({ aoaDeg: 705.001, bcId: legacyBcId });

    const cancelledPromiseId = await createPromise("cancelled", 706.001);
    const rejected = await postPolars(polarPayload([makePoint(706.001)], { promiseId: cancelledPromiseId, bcId: undefined }));
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
    expect(await resultAt(706.001)).toBeNull();
  });
});
