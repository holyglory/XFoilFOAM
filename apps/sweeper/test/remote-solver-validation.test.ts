import "./enabled-engine-pool-fixture";

import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  EngineError,
  type EngineClient,
  type JobStatus,
  type PolarRequest,
} from "@aerodb/engine-client";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const MEDIA_DIR = join(
  tmpdir(),
  `xff-sweeper-remote-${process.pid}-${Date.now().toString(36)}`,
);
mkdirSync(MEDIA_DIR, { recursive: true });
process.env.MEDIA_DIR = MEDIA_DIR;
process.env.ENGINE_CONTROL_PLANE_TOKEN =
  "remote-solver-validation-control-plane-token";
delete process.env.AIRFOILFOAM_EVIDENCE_BUCKET;
process.env.AIRFOILFOAM_EVIDENCE_REMOTE_ONLY = "false";

const dbSchema = await import("@aerodb/db");
const { ensureSimulationPresetRevision } =
  await import("@aerodb/db/simulation-setup");
const {
  admitRemoteSolverTick,
  brokeredEvidenceIdempotencyKey,
  claimResultDelivery,
  createProgressAwareAbort,
  processBrokeredRemoteEvidenceReclaims,
  reconcileRemoteSolverTick,
  remoteSolverTick,
  renewResultDeliveryClaim,
  settleResultDelivery,
  startRemoteReclaimClaimLease,
  startRemotePromiseTransferLease,
} = await import("../src/remote-solver");
const { registerEvidenceArtifacts } = await import("../src/ingest");
const { backfillLegacyBrokeredEvidence } =
  await import("../src/legacy-brokered-evidence-backfill");
const { resetEngineBackoffForTests } = await import("../src/engine-backoff");
const { submitPendingJobWithLifecycleGuard } =
  await import("../src/submit-lifecycle");
const { submitUransRetryForJob } = await import("../src/reconcile");
const { submitRemotePromisePrecalcRecoveries } =
  await import("../src/urans-ladder");

const {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  createClient,
  discoverMissingResultMediaRepairs,
  flowConditions,
  forceHistory,
  mediums,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  recordRansPolarPromotion,
  referenceGeometryProfiles,
  remoteAssetReferences,
  resultAttempts,
  resultClassifications,
  resultFieldExtents,
  resultMedia,
  resultMediaRepairs,
  results,
  schedulingProfiles,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligations,
  simRansPolarPromotionPoints,
  simRansPolarPromotions,
  simResultSubmitRetries,
  simulationPresets,
  solverEvidenceArtifacts,
  solverProfiles,
  solverRuntimeBuilds,
  solverRuntimeProvenanceKey,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  syncApiSettings,
  syncRemotePromiseCancellations,
  syncRemoteResultDeliveries,
  syncRemoteHubBindingReceipts,
  syncSweepPromisePoints,
  syncSweepPromises,
  sweepDefinitions,
} = dbSchema;

const { db, sql } = createClient({ max: 2 });
const PREFIX = `sw-remote-validation-${process.pid}-${Date.now().toString(36)}`;
const UPSTREAM = "https://hub.test/api/sync/v1";
const SECRET = `${PREFIX}-secret`;
const CHORD = 0.37;
const SPEED = 24.5;
const contour = [
  { x: 1, y: 0 },
  { x: 0.5, y: 0.06 },
  { x: 0, y: 0 },
  { x: 0.5, y: -0.05 },
  { x: 1, y: 0 },
];

let savedSettings: typeof syncApiSettings.$inferSelect | null = null;
let categoryId = "";
let airfoilId = "";
let airfoilSlug = "";
let mediumId = "";
let bcId = "";
let flowId = "";
let referenceGeometryId = "";
let presetId = "";
let revisionId = "";
let reynolds = 0;
let mach: number | null = null;
const profileIds = {
  boundary: "",
  mesh: "",
  solver: "",
  scheduling: "",
  output: "",
  sweep: "",
};
const cleanupRuntimeBuildIds = new Set<string>();

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
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

function fixtureBindingReceipt(manifest: Record<string, unknown>): {
  receipt: Record<string, unknown>;
  receiptHmac: string;
} {
  const point = (manifest.results as Array<Record<string, unknown>>)[0]!;
  const artifact = (
    point.evidenceArtifacts as Array<Record<string, unknown>>
  ).find((item) => item.kind === "engine_bundle")!;
  const metadata = artifact.metadata as Record<string, unknown>;
  const now = new Date().toISOString();
  const receipt = {
    schemaVersion: 1,
    kind: "hub-canonical-evidence-binding",
    promiseId: manifest.promiseId,
    aoaDeg: point.aoaDeg,
    remoteResultId: point.remoteResultId,
    remoteResultAttemptId: point.remoteResultAttemptId,
    engineJobId: point.engineJobId,
    engineCaseSlug: point.engineCaseSlug ?? null,
    brokeredUploadId: artifact.remoteEvidenceUploadId,
    bindingState: "bound",
    promisePointState: "fulfilled",
    remote: {
      bucket: metadata.bucket,
      objectKey: metadata.objectKey,
      generation: metadata.generation,
      crc32c: metadata.crc32c,
      storedSha256: artifact.sha256,
      storedByteSize: artifact.byteSize,
      tarSha256: metadata.tarSha256,
      tarByteSize: Number(metadata.tarByteSize),
      manifestSha256: metadata.manifestSha256,
      manifestByteSize: Number(metadata.manifestByteSize),
      zstdLevel: Number(metadata.zstdLevel),
      bundledFileCount: Number(metadata.bundledFileCount),
    },
    canonical: {
      resultId: randomUUID(),
      resultAttemptId: randomUUID(),
      artifactId: randomUUID(),
    },
    boundAt: now,
    fulfilledAt: now,
  };
  return {
    receipt,
    receiptHmac: createHmac("sha256", `${PREFIX}-solver-token`)
      .update("xfoilfoam-hub-canonical-evidence-binding-v1\n")
      .update(canonicalJson(receipt))
      .digest("hex"),
  };
}

async function deleteIds(table: any, column: any, ids: string[]) {
  if (ids.length) await db.delete(table).where(inArray(column, ids));
}

async function deleteSchedulingWhenUnreferenced(id: string) {
  if (!id) return;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const deleted = await db
      .delete(schedulingProfiles)
      .where(
        and(
          eq(schedulingProfiles.id, id),
          dsql`NOT EXISTS (
            SELECT 1 FROM simulation_presets foreign_preset
            WHERE foreign_preset.scheduling_profile_id = ${id}
          )`,
        ),
      )
      .returning({ id: schedulingProfiles.id });
    if (deleted.length) return;
    const [stillExists] = await db
      .select({ id: schedulingProfiles.id })
      .from(schedulingProfiles)
      .where(eq(schedulingProfiles.id, id));
    if (!stillExists) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `remote validation scheduling fixture ${id} remained referenced after cleanup`,
  );
}

async function configureRemoteSolver() {
  await db.insert(syncApiSettings).values({ id: 1 }).onConflictDoNothing();
  const [settings] = await db
    .select()
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1))
    .limit(1);
  savedSettings = savedSettings ?? settings ?? null;
  await db
    .update(syncApiSettings)
    .set({
      enabled: true,
      secret: SECRET,
      upstreamBaseUrl: UPSTREAM,
      // The shared secret is bootstrap-only. Every normal lifecycle assertion
      // in this suite runs after it has been removed.
      upstreamSecret: "",
      remoteSolverEnabled: true,
      remoteSolverCpuBudget: 2,
      remoteSolverClaimSize: 3,
      remoteSolverRegisteredId: randomUUID(),
      remoteSolverAuthToken: `${PREFIX}-solver-token`,
      remoteSolverLastStatus: "idle",
      remoteSolverLastError: null,
      remoteSolverLastPushAt: null,
      updatedAt: new Date(),
    })
    .where(eq(syncApiSettings.id, 1));
}

async function restoreRemoteSolver() {
  if (savedSettings) {
    const { id: _id, createdAt: _createdAt, ...rest } = savedSettings;
    await db
      .update(syncApiSettings)
      .set({ ...rest, updatedAt: new Date() })
      .where(eq(syncApiSettings.id, 1));
  } else {
    await db.delete(syncApiSettings).where(eq(syncApiSettings.id, 1));
  }
}

async function createFixture() {
  const [air] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, "air"))
    .limit(1);
  if (!air) throw new Error("seeded air medium required");
  mediumId = air.id;
  reynolds = Math.round((SPEED * CHORD) / air.kinematicViscosity);
  mach = air.speedOfSound ? SPEED / air.speedOfSound : null;

  const [cat] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-cat`,
      name: `${PREFIX} cat`,
      path: `${PREFIX}-cat`,
      depth: 0,
    })
    .returning();
  categoryId = cat.id;
  const [foil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-foil`,
      name: `${PREFIX} foil`,
      categoryId,
      points: contour,
      pointFormat: "normalized",
      isSymmetric: false,
    })
    .returning();
  airfoilId = foil.id;
  airfoilSlug = foil.slug;

  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-bc`,
      name: `${PREFIX} BC`,
      mediumId,
      reynolds,
      referenceChordM: CHORD,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: SPEED,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach,
      enabled: true,
    })
    .returning({ id: boundaryConditions.id });
  bcId = bc.id;
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${PREFIX}-flow`,
      name: `${PREFIX} flow`,
      mediumId,
      temperatureK: air.refTemperatureK,
      pressurePa: air.refPressurePa,
      speedMps: SPEED,
      density: air.density,
      dynamicViscosity: air.dynamicViscosity,
      kinematicViscosity: air.kinematicViscosity,
      mach,
    })
    .returning();
  flowId = flow.id;
  const [reference] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${PREFIX}-reference`,
      name: `${PREFIX} reference`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: CHORD,
    })
    .returning();
  referenceGeometryId = reference.id;
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` })
    .returning();
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
    .returning();
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` })
    .returning();
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({ slug: `${PREFIX}-scheduling`, name: `${PREFIX} scheduling` })
    .returning();
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
    .returning();
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${PREFIX}-sweep`,
      name: `${PREFIX} sweep`,
      aoaList: [810.001, 811.001, 812.001],
    })
    .returning();
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
      legacyBoundaryConditionId: bcId,
      enabled: false,
    })
    .returning({ id: simulationPresets.id });
  presetId = preset.id;
  const resolved = await ensureSimulationPresetRevision(db, presetId);
  if (!resolved) throw new Error("simulation preset revision required");
  revisionId = resolved.revision.id;
}

function writeMedia(storageKey: string, label: string) {
  const buf = Buffer.from(`${PREFIX}:${label}`);
  const full = join(MEDIA_DIR, storageKey);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, buf);
  return { storageKey, sha256: sha256(buf), byteSize: buf.byteLength };
}

async function seedEngineBundle(
  owner: {
    resultId: string;
    resultAttemptId: string;
    simJobId: string;
    engineJobId: string;
    engineCaseSlug: string | null;
    aoaDeg: number;
  },
  label: string,
) {
  const tarBytes = Buffer.from(`${PREFIX}:${label}:uncompressed-tar`);
  const bundle = writeMedia(
    `jobs/${owner.engineJobId}/cases/${owner.engineCaseSlug ?? "case"}/engine-bundle.tar.zst`,
    `${label}:engine-bundle-zstd`,
  );
  await db.insert(solverEvidenceArtifacts).values({
    resultId: owner.resultId,
    resultAttemptId: owner.resultAttemptId,
    airfoilId,
    simJobId: owner.simJobId,
    engineJobId: owner.engineJobId,
    engineCaseSlug: owner.engineCaseSlug,
    aoaDeg: owner.aoaDeg,
    kind: "engine_bundle",
    role: "raw",
    storageKey: bundle.storageKey,
    mimeType: "application/zstd",
    sha256: bundle.sha256,
    byteSize: bundle.byteSize,
    metadata: {
      archiveFormat: "tar+zstd",
      compression: "zstd",
      evidenceBase: "evidence",
      uncompressedTarSha256: sha256(tarBytes),
      uncompressedTarByteSize: tarBytes.byteLength,
      zstdLevel: 19,
      bundledFileCount: 2,
    },
  });
  return bundle;
}

async function cleanupRemoteRows() {
  if (!revisionId) return;
  const promiseIds = await db
    .select({ id: syncSweepPromises.id })
    .from(syncSweepPromises)
    .where(eq(syncSweepPromises.simulationPresetRevisionId, revisionId));
  if (promiseIds.length) {
    await db.delete(syncRemoteHubBindingReceipts).where(
      inArray(
        syncRemoteHubBindingReceipts.promiseId,
        promiseIds.map((row) => row.id),
      ),
    );
    await db.delete(syncRemotePromiseCancellations).where(
      inArray(
        syncRemotePromiseCancellations.promiseId,
        promiseIds.map((row) => row.id),
      ),
    );
  }
  const resultIds = await db
    .select({ id: results.id })
    .from(results)
    .where(eq(results.simulationPresetRevisionId, revisionId));
  if (resultIds.length) {
    await db.delete(remoteAssetReferences).where(
      inArray(
        remoteAssetReferences.resultId,
        resultIds.map((row) => row.id),
      ),
    );
  }
  await db
    .delete(solverEvidenceArtifacts)
    .where(eq(solverEvidenceArtifacts.airfoilId, airfoilId));
  await db
    .delete(resultClassifications)
    .where(eq(resultClassifications.simulationPresetRevisionId, revisionId));
  await db
    .delete(simPrecalcObligations)
    .where(eq(simPrecalcObligations.revisionId, revisionId));
  await db
    .delete(polarFitSets)
    .where(eq(polarFitSets.simulationPresetRevisionId, revisionId));
  await db
    .delete(results)
    .where(eq(results.simulationPresetRevisionId, revisionId));
  await db
    .delete(resultAttempts)
    .where(eq(resultAttempts.simulationPresetRevisionId, revisionId));
  await db
    .delete(simJobs)
    .where(eq(simJobs.simulationPresetRevisionId, revisionId));
  if (cleanupRuntimeBuildIds.size) {
    await db
      .delete(solverRuntimeBuilds)
      .where(
        inArray(solverRuntimeBuilds.id, Array.from(cleanupRuntimeBuildIds)),
      );
    cleanupRuntimeBuildIds.clear();
  }
  await db
    .delete(syncSweepPromises)
    .where(eq(syncSweepPromises.simulationPresetRevisionId, revisionId));
}

async function seedDoneRemoteJob(
  label: string,
  aoas: number[],
  wave = 2,
  promisedId?: string,
) {
  const engineJobId = `${PREFIX}-${label}`;
  const promiseId = promisedId ?? randomUUID();
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      referenceChordM: CHORD,
      wave,
      status: "done",
      engineJobId,
      totalCases: aoas.length,
      completedCases: aoas.length,
      ingestedAt: new Date(),
      finishedAt: new Date(),
      requestPayload: {
        syncPromiseId: promiseId,
        remoteSolver: true,
        upstreamBaseUrl: UPSTREAM,
        speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
      },
    })
    .returning();

  for (const [idx, aoaDeg] of aoas.entries()) {
    const [row] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "rans",
        reynolds,
        speed: SPEED,
        chord: CHORD,
        mach,
        cl: 0.5 + idx / 10,
        cd: 0.012 + idx / 1000,
        cm: -0.02,
        clCd: 40 + idx,
        stalled: false,
        unsteady: false,
        converged: true,
        simJobId: job.id,
        engineJobId,
        engineCaseSlug: `aoa_${idx}`,
        solvedAt: new Date(),
      })
      .returning();
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: row.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        simJobId: job.id,
        engineJobId,
        engineCaseSlug: row.engineCaseSlug,
        status: "done",
        source: "solved",
        regime: "rans",
        validForPolar: true,
        cl: row.cl,
        cd: row.cd,
        cm: row.cm,
        clCd: row.clCd,
        stalled: false,
        unsteady: false,
        converged: true,
        evidencePayload: { fixture: label, index: idx },
        solvedAt: new Date(),
      })
      .returning();
    await db
      .update(results)
      .set({ currentResultAttemptId: attempt.id })
      .where(eq(results.id, row.id));
    await db.insert(resultClassifications).values({
      resultId: row.id,
      resultAttemptId: attempt.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      regime: "rans",
      classifierVersion: "remote-delivery-test-v1",
      state: "accepted",
      reasons: [],
    });
    const manifest = writeMedia(
      `jobs/${engineJobId}/cases/${idx}/manifest.json`,
      `${label}:${idx}:manifest`,
    );
    await db.insert(solverEvidenceArtifacts).values({
      resultId: row.id,
      resultAttemptId: attempt.id,
      airfoilId,
      simJobId: job.id,
      engineJobId,
      engineCaseSlug: row.engineCaseSlug,
      aoaDeg,
      kind: "manifest",
      role: "raw",
      storageKey: manifest.storageKey,
      mimeType: "application/json",
      sha256: manifest.sha256,
      byteSize: manifest.byteSize,
      metadata: { fixture: label, index: idx },
    });
    await seedEngineBundle(
      {
        resultId: row.id,
        resultAttemptId: attempt.id,
        simJobId: job.id,
        engineJobId,
        engineCaseSlug: row.engineCaseSlug,
        aoaDeg,
      },
      `${label}:${idx}`,
    );
    const stored = writeMedia(
      `jobs/${engineJobId}/cases/${idx}/pressure.png`,
      `${label}:${idx}`,
    );
    await db.insert(resultMedia).values({
      resultId: row.id,
      resultAttemptId: attempt.id,
      kind: "image",
      field: `pressure_${idx}`,
      role: "instantaneous",
      storageKey: stored.storageKey,
      mimeType: "image/png",
      width: 4,
      height: 4,
      evidenceSha256: manifest.sha256,
      sha256: stored.sha256,
      byteSize: stored.byteSize,
    });
  }

  return job;
}

async function readJobPayload(jobId: string) {
  const [row] = await db
    .select({ requestPayload: simJobs.requestPayload })
    .from(simJobs)
    .where(eq(simJobs.id, jobId))
    .limit(1);
  return (row?.requestPayload ?? {}) as { remotePushedAt?: string };
}

async function deliveriesForJob(jobId: string) {
  return db
    .select()
    .from(syncRemoteResultDeliveries)
    .where(eq(syncRemoteResultDeliveries.simJobId, jobId))
    .orderBy(syncRemoteResultDeliveries.aoaDeg, syncRemoteResultDeliveries.id);
}

async function parsedRequestBody(init?: RequestInit): Promise<unknown> {
  if (!init?.body) return null;
  const cached = (init as RequestInit & { __parsedBody?: unknown })
    .__parsedBody;
  if (cached !== undefined) return cached;
  if (typeof init.body === "string") return JSON.parse(init.body);
  const chunks: Buffer[] = [];
  for await (const chunk of init.body as unknown as AsyncIterable<unknown>) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === "string" || chunk instanceof Uint8Array)
      chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const contentType = new Headers(init.headers).get("content-type") ?? "";
  const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1];
  if (!boundary) return JSON.parse(text);
  const manifestHeader = 'name="manifest"';
  const fieldAt = text.indexOf(manifestHeader);
  const valueAt = text.indexOf("\r\n\r\n", fieldAt) + 4;
  const endAt = text.indexOf(`\r\n--${boundary}`, valueAt);
  const parsed = JSON.parse(text.slice(valueAt, endAt));
  (init as RequestInit & { __parsedBody?: unknown }).__parsedBody = parsed;
  return parsed;
}

const brokerObjects = new Map<string, string>();
const brokerArchives = new Map<
  string,
  { bytes: Buffer; sha256: string; byteSize: number }
>();

async function brokerFixtureResponse(
  input: string | URL,
  init?: RequestInit,
): Promise<Response | null> {
  const url = String(input);
  if (url.endsWith("/evidence-uploads")) {
    const body = (await parsedRequestBody(init)) as {
      idempotencyKey?: string;
      storedSha256?: string;
      storedByteSize?: number;
    };
    const id = body.idempotencyKey ?? randomUUID();
    const storedSha256 = body.storedSha256 ?? "0".repeat(64);
    const objectKey = `solver-evidence/v1/sha256/${storedSha256.slice(0, 2)}/${storedSha256}.tar.zst`;
    brokerObjects.set(id, objectKey);
    brokerArchives.set(id, {
      bytes: Buffer.alloc(0),
      sha256: storedSha256,
      byteSize: body.storedByteSize ?? 0,
    });
    const query = new URLSearchParams({
      uploadType: "resumable",
      name: objectKey,
      upload_id: id,
      ifGenerationMatch: "0",
    });
    return new Response(
      JSON.stringify({
        id,
        state: "issued",
        bucket: "airfoils-pro-storage-bucket",
        objectKey,
        uploadUrl: `https://storage.googleapis.com/upload/storage/v1/b/airfoils-pro-storage-bucket/o?${query.toString()}`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (
    url.startsWith(
      "https://storage.googleapis.com/upload/storage/v1/b/airfoils-pro-storage-bucket/o?",
    )
  ) {
    const uploadId = new URL(url).searchParams.get("upload_id") ?? "";
    const chunks: Buffer[] = [];
    if (init?.body) {
      for await (const chunk of init.body as unknown as AsyncIterable<unknown>) {
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
    }
    const archive = brokerArchives.get(uploadId);
    if (archive) archive.bytes = Buffer.concat(chunks);
    return new Response(JSON.stringify({ generation: "9007199254740993123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const verify = /\/evidence-uploads\/([^/]+)\/verify$/.exec(url);
  if (verify) {
    return new Response(
      JSON.stringify({
        id: verify[1],
        state: "verified",
        remote: {
          bucket: "airfoils-pro-storage-bucket",
          objectKey: brokerObjects.get(verify[1]!) ?? "missing",
          generation: "9007199254740993123",
          crc32c: "AAAAAA==",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const download = /\/evidence-uploads\/([^/]+)\/download$/.exec(url);
  if (download) {
    const archive = brokerArchives.get(download[1]!);
    if (!archive) return Response.json({ error: "missing" }, { status: 409 });
    return new Response(archive.bytes, {
      status: 200,
      headers: {
        "content-type": "application/zstd",
        "content-length": String(archive.byteSize),
        "x-content-sha256": archive.sha256,
        "x-gcs-generation": "9007199254740993123",
      },
    });
  }
  return null;
}

function stubFetch(
  opts: {
    conflictIdsByPolarIndex?: Record<number, string[]>;
    conflictStatuses?: Record<string, "pending" | "promoted" | "archived">;
    failPolarIndex?: number;
    failCancelCount?: number;
    unfulfilledPolarIndex?: number;
    observeJobId?: string;
  } = {},
) {
  let polarIndex = 0;
  let cancelIndex = 0;
  const pushedAtDuringPosts: (string | undefined)[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const broker = await brokerFixtureResponse(input, init);
    if (broker) return broker;
    if (
      opts.observeJobId &&
      (url.endsWith("/polars") || url.includes("/complete"))
    ) {
      pushedAtDuringPosts.push(
        (await readJobPayload(opts.observeJobId)).remotePushedAt,
      );
    }
    if (url.endsWith("/polars")) {
      polarIndex += 1;
      if (opts.failPolarIndex === polarIndex)
        return new Response(JSON.stringify({ error: "chunk failed" }), {
          status: 500,
        });
      const body = (await parsedRequestBody(init)) as Record<
        string,
        unknown
      > & {
        results?: Array<{ aoaDeg?: unknown }>;
      };
      const pushedAoas = Array.isArray(body.results)
        ? body.results
            .map((result: { aoaDeg?: unknown }) => result.aoaDeg)
            .filter((aoa: unknown): aoa is number => typeof aoa === "number")
        : [];
      return new Response(
        JSON.stringify({
          imported: 1,
          conflictIds: opts.conflictIdsByPolarIndex?.[polarIndex] ?? [],
          fulfilledAoas:
            opts.unfulfilledPolarIndex === polarIndex ||
            Boolean(opts.conflictIdsByPolarIndex?.[polarIndex]?.length)
              ? []
              : pushedAoas,
          unfulfilledAoas:
            opts.unfulfilledPolarIndex === polarIndex ? pushedAoas : [],
          bindingReceipts:
            opts.unfulfilledPolarIndex === polarIndex ||
            Boolean(opts.conflictIdsByPolarIndex?.[polarIndex]?.length)
              ? []
              : [fixtureBindingReceipt(body)],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.endsWith("/conflicts/status")) {
      const body = (await parsedRequestBody(init)) as { ids?: string[] };
      return new Response(
        JSON.stringify({
          conflicts: (body.ids ?? []).map((id) => ({
            id,
            status: opts.conflictStatuses?.[id] ?? "pending",
          })),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (url.endsWith("/internal/evidence-uploads/reclaim"))
      return Response.json({ state: "complete", bytes_freed: 128 });
    if (url.includes("/complete"))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.includes("/heartbeat"))
      return new Response(
        JSON.stringify({
          ok: true,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    if (url.includes("/sweeps/") && url.endsWith("/cancel")) {
      cancelIndex += 1;
      if (cancelIndex <= (opts.failCancelCount ?? 0)) {
        return new Response(JSON.stringify({ error: "cancel unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/solvers/register"))
      return new Response(
        JSON.stringify({
          authToken: `${PREFIX}-registered-solver-token`,
          solver: { id: randomUUID() },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    if (url.endsWith("/sweeps/claim"))
      return new Response(JSON.stringify({ promise: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, pushedAtDuringPosts };
}

function requests(fetchMock: ReturnType<typeof vi.fn>, suffix: string) {
  return fetchMock.mock.calls
    .map(([url, init]) => ({
      url: String(url),
      body:
        (init as (RequestInit & { __parsedBody?: unknown }) | undefined)
          ?.__parsedBody ??
        (typeof init?.body === "string" ? JSON.parse(init.body) : null),
    }))
    .filter((call) => call.url.endsWith(suffix));
}

async function seedMirroredPromise(label: string, aoas: number[], id?: string) {
  const [promise] = await db
    .insert(syncSweepPromises)
    .values({
      ...(id ? { id } : {}),
      sourceInstanceId: "upstream",
      sourceInstanceName: `Up-tier ${label}`,
      sourceBaseUrl: UPSTREAM,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaCount: aoas.length,
      expiresAt: new Date(Date.now() + 3_600_000),
      lastHeartbeatAt: new Date(),
      requestPayload: {
        remoteSolver: true,
        upstreamBaseUrl: UPSTREAM,
        fixture: label,
      },
    })
    .returning();
  await db.insert(syncSweepPromisePoints).values(
    aoas.map((aoaDeg) => ({
      promiseId: promise.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
    })),
  );
  return promise;
}

async function seedRemoteRejectedParent(label: string, aoaDeg: number) {
  const promise = await seedMirroredPromise(label, [aoaDeg]);
  const engineJobId = `${PREFIX}-${label}-rans`;
  const [parent] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      referenceChordM: CHORD,
      wave: 1,
      jobKind: "targeted",
      status: "done",
      engineJobId,
      totalCases: 1,
      completedCases: 1,
      ingestedAt: new Date(),
      finishedAt: new Date(),
      requestPayload: {
        syncPromiseId: promise.id,
        remoteSolver: true,
        upstreamBaseUrl: UPSTREAM,
        speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
        aoas: [aoaDeg],
      },
    })
    .returning();
  const [result] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      status: "failed",
      source: "queued",
      regime: "rans",
      fidelity: "rans",
      simJobId: parent.id,
      engineJobId,
      converged: false,
      stalled: true,
      unsteady: false,
      error: "RANS did not converge",
      solvedAt: new Date(),
    })
    .returning();
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      simJobId: parent.id,
      engineJobId,
      status: "failed",
      source: "queued",
      regime: "rans",
      validForPolar: false,
      converged: false,
      stalled: true,
      unsteady: false,
      error: "RANS did not converge",
      evidencePayload: { failure_disposition: "hard_solver" },
      solvedAt: new Date(),
    })
    .returning();
  await db.insert(resultClassifications).values({
    resultAttemptId: attempt.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg,
    regime: "rans",
    classifierVersion: "remote-lifecycle-test-v1",
    state: "rejected",
    reasons: ["RANS did not converge"],
  });
  return { promise, parent, result, attempt };
}

async function seedRemoteWholePolarParent(label: string) {
  const aoas = [0, 2, 8];
  const promise = await seedMirroredPromise(label, aoas);
  const ingestLeaseToken = randomUUID();
  const engineJobId = `${PREFIX}-${label}-rans`;
  const [parent] = await db
    .insert(simJobs)
    .values({
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      referenceChordM: CHORD,
      wave: 1,
      jobKind: "sweep",
      status: "ingesting",
      engineJobId,
      totalCases: aoas.length,
      completedCases: 2,
      ingestLeaseToken,
      ingestLeaseExpiresAt: new Date(Date.now() + 60_000),
      requestPayload: {
        syncPromiseId: promise.id,
        remoteSolver: true,
        upstreamBaseUrl: UPSTREAM,
        speedMap: [{ speed: SPEED, bcId, presetRevisionId: revisionId, mach }],
        aoas,
        ransRetryScope: { origin: "continuous-polar", requestedAoas: aoas },
      },
    })
    .returning();

  const [acceptedResult] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 0,
      status: "done",
      source: "solved",
      regime: "rans",
      fidelity: "rans",
      simJobId: parent.id,
      engineJobId,
      engineCaseSlug: "aoa_0",
      converged: true,
      cl: 0.12,
      cd: 0.01,
      cm: -0.01,
      solvedAt: new Date(),
    })
    .returning();
  const [acceptedAttempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: acceptedResult.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 0,
      simJobId: parent.id,
      engineJobId,
      engineCaseSlug: "aoa_0",
      status: "done",
      source: "solved",
      regime: "rans",
      validForPolar: true,
      converged: true,
      cl: 0.12,
      cd: 0.01,
      cm: -0.01,
      evidencePayload: { failure_disposition: "none" },
      solvedAt: new Date(),
    })
    .returning();
  await db
    .update(results)
    .set({ currentResultAttemptId: acceptedAttempt.id })
    .where(eq(results.id, acceptedResult.id));
  await db.insert(resultClassifications).values({
    resultId: acceptedResult.id,
    resultAttemptId: acceptedAttempt.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg: 0,
    regime: "rans",
    classifierVersion: "remote-whole-polar-test-v1",
    state: "accepted",
    reasons: [],
  });
  const acceptedManifest = writeMedia(
    `jobs/${engineJobId}/cases/aoa_0/manifest.json`,
    `${label}:accepted-rans-manifest`,
  );
  await db.insert(solverEvidenceArtifacts).values({
    resultId: acceptedResult.id,
    resultAttemptId: acceptedAttempt.id,
    airfoilId,
    simJobId: parent.id,
    engineJobId,
    engineCaseSlug: "aoa_0",
    aoaDeg: 0,
    kind: "manifest",
    role: "raw",
    storageKey: acceptedManifest.storageKey,
    mimeType: "application/json",
    sha256: acceptedManifest.sha256,
    byteSize: acceptedManifest.byteSize,
    metadata: { fixture: label, promotionRace: true },
  });
  await seedEngineBundle(
    {
      resultId: acceptedResult.id,
      resultAttemptId: acceptedAttempt.id,
      simJobId: parent.id,
      engineJobId,
      engineCaseSlug: "aoa_0",
      aoaDeg: 0,
    },
    `${label}:accepted-rans`,
  );

  const [triggerResult] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 2,
      status: "failed",
      source: "queued",
      regime: "rans",
      fidelity: "rans",
      simJobId: parent.id,
      engineJobId,
      engineCaseSlug: "aoa_2",
      converged: false,
      error: "steady solver diverged after residual growth",
      solvedAt: new Date(),
    })
    .returning();
  const [triggerAttempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: triggerResult.id,
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 2,
      simJobId: parent.id,
      engineJobId,
      engineCaseSlug: "aoa_2",
      status: "failed",
      source: "queued",
      regime: "rans",
      validForPolar: false,
      converged: false,
      error: "steady solver diverged after residual growth",
      evidencePayload: { failure_disposition: "hard_solver" },
      solvedAt: new Date(),
    })
    .returning();
  await db.insert(resultClassifications).values({
    resultId: triggerResult.id,
    resultAttemptId: triggerAttempt.id,
    airfoilId,
    simulationPresetRevisionId: revisionId,
    aoaDeg: 2,
    regime: "rans",
    classifierVersion: "remote-whole-polar-test-v1",
    state: "rejected",
    reasons: ["steady solver diverged after residual growth"],
  });
  await db.insert(results).values({
    airfoilId,
    bcId,
    simulationPresetRevisionId: revisionId,
    aoaDeg: 8,
    status: "queued",
    source: "queued",
    simJobId: parent.id,
  });
  await db
    .update(syncSweepPromisePoints)
    .set({
      status: "fulfilled",
      resultId: acceptedResult.id,
      resultAttemptId: acceptedAttempt.id,
    })
    .where(
      and(
        eq(syncSweepPromisePoints.promiseId, promise.id),
        eq(syncSweepPromisePoints.aoaDeg, 0),
      ),
    );
  return {
    aoas,
    promise,
    parent,
    ingestLeaseToken,
    acceptedResult,
    acceptedAttempt,
    triggerResult,
    triggerAttempt,
  };
}

async function jobsForPromise(promiseId: string) {
  const rows = await db
    .select()
    .from(simJobs)
    .where(eq(simJobs.simulationPresetRevisionId, revisionId))
    .orderBy(simJobs.createdAt, simJobs.id);
  return rows.filter(
    (row) =>
      (row.requestPayload as { syncPromiseId?: string } | null)
        ?.syncPromiseId === promiseId,
  );
}

async function resultForAoa(aoaDeg: number) {
  const [row] = await db
    .select({
      id: results.id,
      status: results.status,
      simJobId: results.simJobId,
      retryState: simResultSubmitRetries.state,
      retryCount: simResultSubmitRetries.attemptCount,
      retryAt: simResultSubmitRetries.nextAttemptAt,
    })
    .from(results)
    .leftJoin(
      simResultSubmitRetries,
      eq(simResultSubmitRetries.resultId, results.id),
    )
    .where(
      and(
        eq(results.simulationPresetRevisionId, revisionId),
        eq(results.aoaDeg, aoaDeg),
      ),
    )
    .limit(1);
  return row;
}

function acceptedStatus(label: string, totalCases = 1): JobStatus {
  return {
    job_id: `${PREFIX}-${label}-${randomUUID()}`,
    state: "pending",
    total_cases: totalCases,
    completed_cases: 0,
  };
}

async function readPromise(promiseId: string) {
  const [promise] = await db
    .select()
    .from(syncSweepPromises)
    .where(eq(syncSweepPromises.id, promiseId));
  const points = await db
    .select()
    .from(syncSweepPromisePoints)
    .where(eq(syncSweepPromisePoints.promiseId, promiseId))
    .orderBy(syncSweepPromisePoints.aoaDeg);
  return { promise, points };
}

beforeAll(async () => {
  await createFixture();
  await configureRemoteSolver();
});

beforeEach(async () => {
  resetEngineBackoffForTests();
  await cleanupRemoteRows();
  await configureRemoteSolver();
});

afterEach(async () => {
  resetEngineBackoffForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await cleanupRemoteRows();
});

afterAll(async () => {
  await cleanupRemoteRows();
  await restoreRemoteSolver();
  await deleteIds(
    simulationPresets,
    simulationPresets.id,
    [presetId].filter(Boolean),
  );
  await deleteIds(
    boundaryConditions,
    boundaryConditions.id,
    [bcId].filter(Boolean),
  );
  await deleteIds(flowConditions, flowConditions.id, [flowId].filter(Boolean));
  await deleteIds(
    referenceGeometryProfiles,
    referenceGeometryProfiles.id,
    [referenceGeometryId].filter(Boolean),
  );
  await deleteIds(
    boundaryProfiles,
    boundaryProfiles.id,
    [profileIds.boundary].filter(Boolean),
  );
  await deleteIds(
    meshProfiles,
    meshProfiles.id,
    [profileIds.mesh].filter(Boolean),
  );
  await deleteIds(
    solverProfiles,
    solverProfiles.id,
    [profileIds.solver].filter(Boolean),
  );
  await deleteSchedulingWhenUnreferenced(profileIds.scheduling);
  await deleteIds(
    outputProfiles,
    outputProfiles.id,
    [profileIds.output].filter(Boolean),
  );
  await deleteIds(
    sweepDefinitions,
    sweepDefinitions.id,
    [profileIds.sweep].filter(Boolean),
  );
  await deleteIds(airfoils, airfoils.id, [airfoilId].filter(Boolean));
  await deleteIds(categories, categories.id, [categoryId].filter(Boolean));
  await sql.end();
  rmSync(MEDIA_DIR, { recursive: true, force: true });
});

describe("remote solver submit lifecycle", () => {
  it("fails a tick before any claim or upload network call for an unsafe stored hub", async () => {
    await db
      .update(syncApiSettings)
      .set({
        upstreamBaseUrl: "http://unsafe-hub.example.test/api/sync/v1",
        updatedAt: new Date(),
      })
      .where(eq(syncApiSettings.id, 1));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await reconcileRemoteSolverTick(db, {} as EngineClient)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const [settings] = await db
      .select({
        status: syncApiSettings.remoteSolverLastStatus,
        error: syncApiSettings.remoteSolverLastError,
      })
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    expect(settings).toMatchObject({ status: "error" });
    expect(settings?.error).toMatch(/must use HTTPS/i);
  });

  it("keeps remote reconciliation live but does not submit an engine job while storage admission is blocked", async () => {
    const aoa = 900.501;
    const promise = await seedMirroredPromise("storage-blocked", [aoa]);
    stubFetch();
    const submitPolar = vi.fn(async () => acceptedStatus("must-not-submit"));

    await remoteSolverTick(
      db,
      { submitPolar, cancelJob: vi.fn() } as unknown as EngineClient,
      { kind: "hold", reason: "storage_pressure" },
    );

    expect(submitPolar).not.toHaveBeenCalled();
    expect(await jobsForPromise(promise.id)).toEqual([]);
    expect((await readPromise(promise.id)).promise.status).toBe("active");
    const [settings] = await db
      .select({ error: syncApiSettings.remoteSolverLastError })
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    expect(settings?.error).toMatch(/storage admission is blocked/i);
    expect(settings?.error).not.toMatch(/safety stop/i);
  });

  it("reports a safety hold truthfully and never labels it as storage pressure", async () => {
    const promise = await seedMirroredPromise("safety-stop", [900.601]);
    stubFetch();
    const submitPolar = vi.fn(async () => acceptedStatus("must-not-submit"));

    await remoteSolverTick(
      db,
      { submitPolar, cancelJob: vi.fn() } as unknown as EngineClient,
      { kind: "hold", reason: "safety_stop" },
    );

    expect(submitPolar).not.toHaveBeenCalled();
    expect(await jobsForPromise(promise.id)).toEqual([]);
    expect((await readPromise(promise.id)).promise.status).toBe("active");
    const [settings] = await db
      .select({ error: syncApiSettings.remoteSolverLastError })
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    expect(settings?.error).toMatch(/global admission safety stop/i);
    expect(settings?.error).not.toMatch(/storage/i);
  });

  it("fails closed before composing remote RANS when the supplied mesh capability is malformed", async () => {
    const promise = await seedMirroredPromise("unknown-mesh", [900.701]);
    stubFetch();
    const submitPolar = vi.fn(async () => acceptedStatus("must-not-submit"));

    await remoteSolverTick(
      db,
      { submitPolar, cancelJob: vi.fn() } as unknown as EngineClient,
      { kind: "allow", meshRecoveryVersion: Number.NaN },
    );

    expect(submitPolar).not.toHaveBeenCalled();
    expect(await jobsForPromise(promise.id)).toEqual([]);
    expect((await readPromise(promise.id)).promise.status).toBe("active");
    const [settings] = await db
      .select({ error: syncApiSettings.remoteSolverLastError })
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    expect(settings?.error).toMatch(/mesh-recovery capability.*malformed/i);
  });

  it("keeps reconciliation early but leaves remote RANS untouched when FAST owns the tick", async () => {
    const promise = await seedMirroredPromise("fast-priority", [900.801]);
    stubFetch();
    const submitPolar = vi.fn(async (_request: PolarRequest) =>
      acceptedStatus("must-not-submit"),
    );
    const engine = {
      submitPolar,
      cancelJob: vi.fn(),
    } as unknown as EngineClient;

    expect(await reconcileRemoteSolverTick(db, engine)).toBe(true);
    expect(
      await admitRemoteSolverTick(db, engine, {
        kind: "hold",
        reason: "higher_priority_fast_urans",
      }),
    ).toBe(false);
    expect(submitPolar).not.toHaveBeenCalled();
    expect(await jobsForPromise(promise.id)).toEqual([]);
    expect((await readPromise(promise.id)).promise.status).toBe("active");
  });

  it.each([0, 17])(
    "admits remote RANS with known mesh capability v%s and pins the exact version",
    async (meshRecoveryVersion) => {
      const promise = await seedMirroredPromise(
        `known-mesh-v${meshRecoveryVersion}`,
        [900.901 + meshRecoveryVersion / 1000],
      );
      stubFetch();
      const submitPolar = vi.fn(async (_request: PolarRequest) =>
        acceptedStatus("remote-known-mesh"),
      );
      const engine = {
        submitPolar,
        cancelJob: vi.fn(),
      } as unknown as EngineClient;

      expect(
        await remoteSolverTick(db, engine, {
          kind: "allow",
          meshRecoveryVersion,
        }),
      ).toBe(true);
      expect(submitPolar).toHaveBeenCalledTimes(1);
      const request = submitPolar.mock.calls[0]?.[0];
      expect(request?.expected_mesh_recovery_version).toBe(meshRecoveryVersion);
      const [job] = await jobsForPromise(promise.id);
      expect(job?.requestPayload).toMatchObject({
        meshRecoveryVersion,
        remoteSolver: true,
        syncPromiseId: promise.id,
      });
    },
  );

  it("releases a connection failure without answered allowance and honors shared backoff before recomposing", async () => {
    const aoa = 901.001;
    const promise = await seedMirroredPromise("connection", [aoa]);
    const { fetchMock } = stubFetch();
    let reachable = false;
    const submitPolar = vi.fn(async () => {
      if (!reachable) throw new Error("connect ECONNREFUSED 127.0.0.1");
      return acceptedStatus("connection-retry");
    });
    const engine = {
      submitPolar,
      cancelJob: vi.fn(),
    } as unknown as EngineClient;

    await remoteSolverTick(db, engine);

    expect(submitPolar).toHaveBeenCalledTimes(1);
    expect(await jobsForPromise(promise.id)).toMatchObject([
      { status: "cancelled", engineState: "cancelled" },
    ]);
    expect(await resultForAoa(aoa)).toMatchObject({
      status: "pending",
      simJobId: null,
      retryState: null,
      retryCount: null,
    });

    reachable = true;
    await remoteSolverTick(db, engine);
    expect(submitPolar).toHaveBeenCalledTimes(1);
    expect(requests(fetchMock, "/sweeps/claim")).toHaveLength(0);

    resetEngineBackoffForTests();
    await remoteSolverTick(db, engine);
    expect(submitPolar).toHaveBeenCalledTimes(2);
    expect((await jobsForPromise(promise.id)).map((row) => row.status)).toEqual(
      ["cancelled", "submitted"],
    );
    expect(await resultForAoa(aoa)).toMatchObject({
      status: "queued",
      retryState: null,
    });
    expect(requests(fetchMock, "/sweeps/claim")).toHaveLength(0);
  });

  it("waits 30 seconds after the first answered 5xx, then recomposes the same promise without a new upstream claim", async () => {
    const aoa = 902.001;
    const promise = await seedMirroredPromise("first-5xx", [aoa]);
    const { fetchMock } = stubFetch();
    let fail = true;
    const submitPolar = vi.fn(async () => {
      if (fail) throw new EngineError("engine overloaded", 503);
      return acceptedStatus("first-5xx-retry");
    });
    const engine = {
      submitPolar,
      cancelJob: vi.fn(),
    } as unknown as EngineClient;

    await remoteSolverTick(db, engine);
    const delayed = await resultForAoa(aoa);
    expect(delayed).toMatchObject({
      status: "pending",
      simJobId: null,
      retryState: "retry_wait",
      retryCount: 1,
    });
    expect(delayed.retryAt?.getTime()).toBeGreaterThan(Date.now());
    expect((await readPromise(promise.id)).promise.status).toBe("active");

    await remoteSolverTick(db, engine);
    expect(submitPolar).toHaveBeenCalledTimes(1);

    await db
      .update(simResultSubmitRetries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(simResultSubmitRetries.resultId, delayed.id));
    fail = false;
    await remoteSolverTick(db, engine);

    expect(submitPolar).toHaveBeenCalledTimes(2);
    expect((await jobsForPromise(promise.id)).map((row) => row.status)).toEqual(
      ["failed", "submitted"],
    );
    expect(await resultForAoa(aoa)).toMatchObject({
      status: "queued",
      retryState: null,
      retryCount: null,
    });
    expect(requests(fetchMock, "/sweeps/claim")).toHaveLength(0);
    expect(requests(fetchMock, `/sweeps/${promise.id}/cancel`)).toHaveLength(0);
  });

  it("blocks the exact cell and cancels the upstream promise after a second answered 5xx", async () => {
    const aoa = 903.001;
    const promise = await seedMirroredPromise("second-5xx", [aoa]);
    const { fetchMock } = stubFetch();
    const submitPolar = vi.fn(async () => {
      throw new EngineError("engine overloaded", 503);
    });
    const engine = {
      submitPolar,
      cancelJob: vi.fn(),
    } as unknown as EngineClient;

    await remoteSolverTick(db, engine);
    const delayed = await resultForAoa(aoa);
    await db
      .update(simResultSubmitRetries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(simResultSubmitRetries.resultId, delayed.id));
    await remoteSolverTick(db, engine);

    expect(submitPolar).toHaveBeenCalledTimes(2);
    expect(await resultForAoa(aoa)).toMatchObject({
      status: "failed",
      retryState: "blocked",
      retryCount: 1,
    });
    const mirror = await readPromise(promise.id);
    expect(mirror.promise.status).toBe("cancelled");
    expect(mirror.points.map((row) => row.status)).toEqual(["cancelled"]);
    expect(requests(fetchMock, `/sweeps/${promise.id}/cancel`)).toEqual([
      {
        url: `${UPSTREAM}/sweeps/${promise.id}/cancel`,
        body: {},
      },
    ]);
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.simulationPresetRevisionId, revisionId)),
    ).toHaveLength(0);
  });

  it("does not send the current solver credential to a stale cancellation authority", async () => {
    const aoa = 903.501;
    const promise = await seedMirroredPromise("cancel-outbox", [aoa]);
    const { fetchMock } = stubFetch({ failCancelCount: 1 });
    const submitPolar = vi.fn(async () => {
      await db
        .update(syncSweepPromises)
        .set({
          status: "expired",
          expiredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(syncSweepPromises.id, promise.id));
      await db
        .update(syncSweepPromisePoints)
        .set({ status: "expired", updatedAt: new Date() })
        .where(eq(syncSweepPromisePoints.promiseId, promise.id));
      throw new EngineError("invalid request", 422);
    });

    await remoteSolverTick(db, {
      submitPolar,
      cancelJob: vi.fn(),
    } as unknown as EngineClient);

    expect((await readPromise(promise.id)).promise.status).toBe("cancelled");
    const [retry] = await db
      .select()
      .from(syncRemotePromiseCancellations)
      .where(eq(syncRemotePromiseCancellations.promiseId, promise.id));
    expect(retry).toMatchObject({ state: "retry_wait", attemptCount: 1 });
    expect(
      requests(fetchMock, `/sweeps/${promise.id}/cancel`).map(
        (request) => request.url,
      ),
    ).toEqual([`${UPSTREAM}/sweeps/${promise.id}/cancel`]);

    await db
      .update(syncRemotePromiseCancellations)
      .set({ nextAttemptAt: dsql`now() - interval '1 second'` })
      .where(eq(syncRemotePromiseCancellations.promiseId, promise.id));
    await db
      .update(syncApiSettings)
      .set({
        upstreamBaseUrl: "https://new-hub.test/api/sync/v1",
        upstreamSecret: `${PREFIX}-rotated-secret`,
        remoteSolverEnabled: false,
        remoteSolverRegisteredId: null,
        updatedAt: new Date(),
      })
      .where(eq(syncApiSettings.id, 1));

    await remoteSolverTick(db, {} as never);

    const [blockedRetry] = await db
      .select()
      .from(syncRemotePromiseCancellations)
      .where(eq(syncRemotePromiseCancellations.promiseId, promise.id));
    expect(blockedRetry).toMatchObject({
      state: "retry_wait",
      attemptCount: 2,
    });
    expect(blockedRetry.lastError).toMatch(/no longer matches/i);
    expect(
      requests(fetchMock, `/sweeps/${promise.id}/cancel`).map(
        (request) => request.url,
      ),
    ).toEqual([`${UPSTREAM}/sweeps/${promise.id}/cancel`]);
    expect(requests(fetchMock, `/sweeps/${promise.id}/heartbeat`)).toEqual([]);
  });

  it("blocks an answered 4xx immediately without inventing solver evidence", async () => {
    const aoa = 904.001;
    const promise = await seedMirroredPromise("4xx", [aoa]);
    const { fetchMock } = stubFetch();
    const submitPolar = vi.fn(async () => {
      throw new EngineError("invalid request", 422);
    });
    const engine = {
      submitPolar,
      cancelJob: vi.fn(),
    } as unknown as EngineClient;

    await remoteSolverTick(db, engine);

    expect(submitPolar).toHaveBeenCalledTimes(1);
    expect(await resultForAoa(aoa)).toMatchObject({
      status: "failed",
      retryState: "blocked",
      retryCount: 0,
    });
    expect((await readPromise(promise.id)).promise.status).toBe("cancelled");
    expect(requests(fetchMock, `/sweeps/${promise.id}/cancel`)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.simulationPresetRevisionId, revisionId)),
    ).toHaveLength(0);
  });

  it("allows only one engine submit when two remote ticks race the same mirrored promise", async () => {
    const aoa = 905.001;
    const promise = await seedMirroredPromise("concurrent", [aoa]);
    stubFetch();
    const submitPolar = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return acceptedStatus("concurrent");
    });
    const engine = {
      submitPolar,
      cancelJob: vi.fn(),
    } as unknown as EngineClient;

    await Promise.all([
      remoteSolverTick(db, engine),
      remoteSolverTick(db, engine),
    ]);

    expect(submitPolar).toHaveBeenCalledTimes(1);
    const jobs = await jobsForPromise(promise.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "submitted" });
    expect(await resultForAoa(aoa)).toMatchObject({
      status: "queued",
      simJobId: jobs[0].id,
    });
  });

  it("pins a new marched job to every exact promise point after an earlier sibling was fulfilled", async () => {
    const promise = await seedMirroredPromise("pinned-full-scope", [0, 2, 8]);
    await db
      .update(syncSweepPromisePoints)
      .set({ status: "fulfilled", updatedAt: new Date() })
      .where(
        and(
          eq(syncSweepPromisePoints.promiseId, promise.id),
          eq(syncSweepPromisePoints.aoaDeg, 0),
        ),
      );
    stubFetch();
    const submitPolar = vi.fn(async (_request: PolarRequest) =>
      acceptedStatus("pinned-full-scope", 2),
    );

    await remoteSolverTick(db, {
      submitPolar,
      cancelJob: vi.fn(),
    } as unknown as EngineClient);

    const [remoteStatus] = await db
      .select({ error: syncApiSettings.remoteSolverLastError })
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    expect(remoteStatus?.error).toBeNull();
    expect(submitPolar).toHaveBeenCalledTimes(1);
    const request = submitPolar.mock.calls[0]?.[0] as PolarRequest;
    expect(request.aoa.angles).toEqual([2, 8]);
    expect(request.solver?.rans_failure_policy).toBe("abort_for_precalc");
    const [job] = await jobsForPromise(promise.id);
    expect(job.requestPayload).toMatchObject({
      aoas: [2, 8],
      ransRetryScope: {
        origin: "continuous-polar",
        requestedAoas: [0, 2, 8],
      },
    });
    expect((await readPromise(promise.id)).points).toMatchObject([
      { aoaDeg: 0, status: "fulfilled" },
      { aoaDeg: 2, status: "active" },
      { aoaDeg: 8, status: "active" },
    ]);
  });

  it.each([
    ["cancelled", 906.001],
    ["expired", 907.001],
  ] as const)(
    "persists and compensates an accepted engine task when its mirrored promise becomes %s in flight",
    async (transition, aoa) => {
      const promise = await seedMirroredPromise(`compensate-${transition}`, [
        aoa,
      ]);
      stubFetch();
      const accepted = acceptedStatus(`compensate-${transition}`);
      const cancelJob = vi.fn(async () => accepted);
      const submitPolar = vi.fn(async () => {
        if (transition === "cancelled") {
          await db
            .update(syncSweepPromises)
            .set({ status: "cancelled", cancelledAt: new Date() })
            .where(eq(syncSweepPromises.id, promise.id));
          await db
            .update(syncSweepPromisePoints)
            .set({ status: "cancelled" })
            .where(eq(syncSweepPromisePoints.promiseId, promise.id));
        } else {
          await db
            .update(syncSweepPromises)
            .set({ expiresAt: new Date(Date.now() - 1_000) })
            .where(eq(syncSweepPromises.id, promise.id));
        }
        return accepted;
      });
      const engine = { submitPolar, cancelJob } as unknown as EngineClient;

      await remoteSolverTick(db, engine);

      expect(submitPolar).toHaveBeenCalledTimes(1);
      expect(cancelJob).toHaveBeenCalledWith(accepted.job_id);
      const [job] = await jobsForPromise(promise.id);
      expect(job).toMatchObject({
        status: "cancelled",
        engineJobId: accepted.job_id,
        engineState: "cancelled",
      });
      expect(job.error).toContain("compensating engine cancellation confirmed");
      expect(await resultForAoa(aoa)).toMatchObject({
        status: "pending",
        simJobId: null,
      });
    },
  );

  it("fails closed before engine submit when a job claim is not an active AoA of its mirrored promise", async () => {
    const promisedAoa = 908.001;
    const wrongAoa = 908.501;
    const promise = await seedMirroredPromise("wrong-aoa", [promisedAoa]);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        referenceChordM: CHORD,
        wave: 1,
        status: "pending",
        totalCases: 1,
        requestPayload: {
          remoteSolver: true,
          syncPromiseId: promise.id,
          upstreamBaseUrl: UPSTREAM,
          aoas: [wrongAoa],
        },
      })
      .returning();
    await db.insert(results).values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: wrongAoa,
      status: "queued",
      source: "queued",
      simJobId: job.id,
    });
    const submitPolar = vi.fn(async () => acceptedStatus("wrong-aoa"));
    const outcome = await submitPendingJobWithLifecycleGuard({
      db,
      engine: { submitPolar } as unknown as EngineClient,
      jobId: job.id,
      admissionLane: "remote",
      request: {
        airfoil: { points: contour.map(({ x, y }) => [x, y]) },
        aoa: { angles: [wrongAoa] },
      } as PolarRequest,
      connectionErrorPrefix: "remote engine unreachable at submit: ",
      submitErrorPrefix: "remote engine submit failed: ",
    });

    expect(outcome.kind).toBe("lifecycle_stopped");
    expect(submitPolar).not.toHaveBeenCalled();
    expect((await jobsForPromise(promise.id))[0]).toMatchObject({
      status: "cancelled",
      engineJobId: null,
    });
    expect(await resultForAoa(wrongAoa)).toMatchObject({
      status: "pending",
      simJobId: null,
    });
  });

  it("fails closed before engine submit when the job names a different upstream than the mirrored promise", async () => {
    const aoa = 909.001;
    const promise = await seedMirroredPromise("wrong-upstream", [aoa]);
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        referenceChordM: CHORD,
        wave: 1,
        status: "pending",
        totalCases: 1,
        requestPayload: {
          remoteSolver: true,
          syncPromiseId: promise.id,
          upstreamBaseUrl: "https://different-hub.test/api/sync/v1",
          aoas: [aoa],
        },
      })
      .returning();
    await db.insert(results).values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: aoa,
      status: "queued",
      source: "queued",
      simJobId: job.id,
    });
    const submitPolar = vi.fn(async () => acceptedStatus("wrong-upstream"));

    const outcome = await submitPendingJobWithLifecycleGuard({
      db,
      engine: { submitPolar } as unknown as EngineClient,
      jobId: job.id,
      admissionLane: "remote",
      request: {
        airfoil: { points: contour.map(({ x, y }) => [x, y]) },
        aoa: { angles: [aoa] },
      } as PolarRequest,
      connectionErrorPrefix: "remote engine unreachable at submit: ",
      submitErrorPrefix: "remote engine submit failed: ",
    });

    expect(outcome.kind).toBe("lifecycle_stopped");
    expect(submitPolar).not.toHaveBeenCalled();
    expect(await resultForAoa(aoa)).toMatchObject({
      status: "pending",
      simJobId: null,
    });
  });
});

describe("remote-owned whole-polar promotion scope", () => {
  it("atomically reopens a fulfilled sibling and preserves its evidence link while recording full preliminary coverage", async () => {
    const seeded = await seedRemoteWholePolarParent("promote-fulfilled");

    const first = await recordRansPolarPromotion(db, {
      parentJobId: seeded.parent.id,
      ingestLeaseToken: seeded.ingestLeaseToken,
      airfoilId,
      revisionId,
      triggerResultAttemptId: seeded.triggerAttempt.id,
      triggerAoaDeg: 2,
      requestedAoas: seeded.aoas,
      intentionallyOmittedAoas: [8],
      ownership: { syncPromiseIds: [seeded.promise.id] },
    });
    await db
      .update(resultClassifications)
      .set({
        state: "superseded_by_urans",
        supersededByResultId: seeded.triggerResult.id,
        updatedAt: new Date(),
      })
      .where(
        eq(resultClassifications.resultAttemptId, seeded.triggerAttempt.id),
      );
    await db
      .update(syncSweepPromises)
      .set({
        status: "expired",
        expiredAt: new Date(),
        expiresAt: new Date(Date.now() - 1_000),
        updatedAt: new Date(),
      })
      .where(eq(syncSweepPromises.id, seeded.promise.id));
    const second = await recordRansPolarPromotion(db, {
      parentJobId: seeded.parent.id,
      ingestLeaseToken: seeded.ingestLeaseToken,
      airfoilId,
      revisionId,
      triggerResultAttemptId: seeded.triggerAttempt.id,
      triggerAoaDeg: 2,
      requestedAoas: seeded.aoas,
      intentionallyOmittedAoas: [8],
      ownership: { syncPromiseIds: [seeded.promise.id] },
    });
    const driftedReplay = await recordRansPolarPromotion(db, {
      parentJobId: seeded.parent.id,
      ingestLeaseToken: seeded.ingestLeaseToken,
      airfoilId,
      revisionId,
      triggerResultAttemptId: randomUUID(),
      triggerAoaDeg: 4,
      requestedAoas: [2],
      intentionallyOmittedAoas: [2],
      ownership: { backgroundOwner: true },
    });

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    // An already-normalized event is authoritative. Replay derives omitted
    // coverage from its point ledger rather than accepting or rejecting a
    // caller's later trigger, scope, omission, or owner drift.
    expect(driftedReplay).toEqual(first);
    const promise = await readPromise(seeded.promise.id);
    expect(promise.points).toMatchObject([
      {
        aoaDeg: 0,
        status: "active",
        resultId: seeded.acceptedResult.id,
        resultAttemptId: seeded.acceptedAttempt.id,
      },
      { aoaDeg: 2, status: "active" },
      { aoaDeg: 8, status: "active" },
    ]);
    const promotions = await db
      .select()
      .from(simRansPolarPromotions)
      .where(eq(simRansPolarPromotions.parentJobId, seeded.parent.id));
    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({
      triggerResultAttemptId: seeded.triggerAttempt.id,
      triggerAoaDeg: 2,
      failureDisposition: "hard_solver",
      requestOrigin: "continuous-polar",
      ownerKind: "sync_promise",
      campaignId: null,
      syncPromiseId: seeded.promise.id,
    });
    const promotionPoints = await db
      .select()
      .from(simRansPolarPromotionPoints)
      .where(eq(simRansPolarPromotionPoints.promotionId, promotions[0]!.id))
      .orderBy(simRansPolarPromotionPoints.aoaDeg);
    expect(promotionPoints).toMatchObject([
      { aoaDeg: 0, intentionallyOmittedByRans: false },
      { aoaDeg: 2, intentionallyOmittedByRans: false },
      { aoaDeg: 8, intentionallyOmittedByRans: true },
    ]);
    const obligations = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.revisionId, revisionId))
      .orderBy(simPrecalcObligations.aoaDeg);
    expect(obligations).toMatchObject([
      { aoaDeg: 0, backgroundOwner: false, state: "pending" },
      { aoaDeg: 2, backgroundOwner: false, state: "pending" },
      { aoaDeg: 8, backgroundOwner: false, state: "pending" },
    ]);
    expect(new Set(first?.obligationIds)).toEqual(
      new Set(obligations.map((obligation) => obligation.id)),
    );
    expect(await resultForAoa(8)).toMatchObject({
      status: "queued",
      simJobId: null,
    });
  });

  it("MUST-CATCH: terminal replay ignores a replacement remote owner, targeted scope, and changed classification", async () => {
    const seeded = await seedRemoteWholePolarParent("terminal-event-first");
    const recorded = await recordRansPolarPromotion(db, {
      parentJobId: seeded.parent.id,
      ingestLeaseToken: seeded.ingestLeaseToken,
      airfoilId,
      revisionId,
      triggerResultAttemptId: seeded.triggerAttempt.id,
      triggerAoaDeg: 2,
      requestedAoas: seeded.aoas,
      intentionallyOmittedAoas: [8],
      ownership: { syncPromiseIds: [seeded.promise.id] },
    });
    expect(recorded?.owner).toEqual({
      kind: "sync_promise",
      syncPromiseId: seeded.promise.id,
    });

    // The original promise has ended and another valid promise now owns the
    // same cells. Mutable parent transport is deliberately retargeted to that
    // replacement and narrowed to one explicit angle. Without event-first
    // replay the generic path would compose a non-event targeted child.
    await db
      .update(syncSweepPromises)
      .set({
        status: "expired",
        expiredAt: new Date(),
        expiresAt: new Date(Date.now() - 1_000),
        updatedAt: new Date(),
      })
      .where(eq(syncSweepPromises.id, seeded.promise.id));
    await db
      .update(syncSweepPromisePoints)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(syncSweepPromisePoints.promiseId, seeded.promise.id));
    const replacement = await seedMirroredPromise(
      "terminal-event-first-replacement",
      seeded.aoas,
    );
    await db
      .update(simJobs)
      .set({
        requestPayload: {
          syncPromiseId: replacement.id,
          remoteSolver: true,
          upstreamBaseUrl: UPSTREAM,
          speedMap: [
            { speed: SPEED, bcId, presetRevisionId: revisionId, mach },
          ],
          aoas: [2],
          ransRetryScope: {
            origin: "explicit-targeted",
            requestedAoas: [2],
          },
        },
      })
      .where(eq(simJobs.id, seeded.parent.id));
    await db
      .update(resultClassifications)
      .set({ state: "needs_urans", updatedAt: new Date() })
      .where(
        eq(resultClassifications.resultAttemptId, seeded.triggerAttempt.id),
      );
    const [driftedParent] = await db
      .select()
      .from(simJobs)
      .where(eq(simJobs.id, seeded.parent.id));
    const submitPolar = vi.fn(async () =>
      acceptedStatus("terminal-event-first-unbound"),
    );

    await submitUransRetryForJob(
      db,
      { submitPolar } as unknown as EngineClient,
      driftedParent,
      { ingestLeaseToken: seeded.ingestLeaseToken },
    );

    expect(submitPolar).not.toHaveBeenCalled();
    expect(
      await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(
          and(eq(simJobs.parentJobId, seeded.parent.id), eq(simJobs.wave, 2)),
        ),
    ).toHaveLength(0);
    expect(
      await db
        .select({ syncPromiseId: simRansPolarPromotions.syncPromiseId })
        .from(simRansPolarPromotions)
        .where(eq(simRansPolarPromotions.parentJobId, seeded.parent.id)),
    ).toEqual([{ syncPromiseId: seeded.promise.id }]);

    const finalized = await db
      .update(simJobs)
      .set({
        status: "done",
        ingestedAt: new Date(),
        finishedAt: new Date(),
        ingestLeaseToken: null,
        ingestLeaseClaimedAt: null,
        ingestLeaseExpiresAt: null,
      })
      .where(
        and(
          eq(simJobs.id, seeded.parent.id),
          eq(simJobs.status, "ingesting"),
          eq(simJobs.ingestLeaseToken, seeded.ingestLeaseToken),
        ),
      )
      .returning({ id: simJobs.id });
    expect(finalized).toEqual([{ id: seeded.parent.id }]);
  });

  it("keeps the exact original promise active when an already-streaming parent RANS delivery answers after promotion", async () => {
    const seeded = await seedRemoteWholePolarParent("late-rans-delivery");
    let uploadStartedResolve!: () => void;
    let releaseUploadResolve!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      uploadStartedResolve = resolve;
    });
    const releaseUpload = new Promise<void>((resolve) => {
      releaseUploadResolve = resolve;
    });
    const fetchMock = vi.fn(
      async (input: string | URL, _init?: RequestInit) => {
        const url = String(input);
        const broker = await brokerFixtureResponse(input, _init);
        if (broker) return broker;
        if (url.endsWith("/polars")) {
          uploadStartedResolve();
          await releaseUpload;
          return new Response(
            JSON.stringify({
              imported: 1,
              conflictIds: [],
              fulfilledAoas: [0],
              unfulfilledAoas: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.endsWith(`/sweeps/${seeded.promise.id}/heartbeat`))
          return Response.json({
            ok: true,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const tick = remoteSolverTick(db, {} as EngineClient);
    await uploadStarted;
    const [inFlight] = await db
      .select()
      .from(syncRemoteResultDeliveries)
      .where(
        and(
          eq(syncRemoteResultDeliveries.promiseId, seeded.promise.id),
          eq(syncRemoteResultDeliveries.simJobId, seeded.parent.id),
        ),
      );
    expect(inFlight).toMatchObject({
      resultId: seeded.acceptedResult.id,
      resultAttemptId: seeded.acceptedAttempt.id,
      state: "pushing",
    });

    const recorded = await recordRansPolarPromotion(db, {
      parentJobId: seeded.parent.id,
      ingestLeaseToken: seeded.ingestLeaseToken,
      airfoilId,
      revisionId,
      triggerResultAttemptId: seeded.triggerAttempt.id,
      triggerAoaDeg: 2,
      requestedAoas: seeded.aoas,
      intentionallyOmittedAoas: [8],
      ownership: { syncPromiseIds: [seeded.promise.id] },
    });
    expect(recorded?.owner).toEqual({
      kind: "sync_promise",
      syncPromiseId: seeded.promise.id,
    });
    const [supersededBeforeResponse] = await db
      .select()
      .from(syncRemoteResultDeliveries)
      .where(eq(syncRemoteResultDeliveries.id, inFlight.id));
    expect(supersededBeforeResponse).toMatchObject({
      state: "superseded",
      claimToken: null,
      claimExpiresAt: null,
    });
    expect((await readPromise(seeded.promise.id)).points).toMatchObject([
      { aoaDeg: 0, status: "active" },
      { aoaDeg: 2, status: "active" },
      { aoaDeg: 8, status: "active" },
    ]);

    releaseUploadResolve();
    await tick;

    expect(requests(fetchMock, "/polars")).toHaveLength(1);
    expect((await readPromise(seeded.promise.id)).points).toMatchObject([
      { aoaDeg: 0, status: "active" },
      { aoaDeg: 2, status: "active" },
      { aoaDeg: 8, status: "active" },
    ]);
    const [settled] = await db
      .select()
      .from(syncRemoteResultDeliveries)
      .where(eq(syncRemoteResultDeliveries.id, inFlight.id));
    expect(settled).toMatchObject({
      state: "superseded",
      resultAttemptId: seeded.acceptedAttempt.id,
    });
    expect((await readPromise(seeded.promise.id)).promise.status).toBe(
      "active",
    );
  });

  it.each(["cancelled", "expired"] as const)(
    "does not resurrect fulfilled siblings when the exact remote promise is %s",
    async (terminalStatus) => {
      const seeded = await seedRemoteWholePolarParent(
        `promote-${terminalStatus}`,
      );
      await db
        .update(syncSweepPromises)
        .set({
          status: terminalStatus,
          ...(terminalStatus === "cancelled"
            ? { cancelledAt: new Date() }
            : {
                expiredAt: new Date(),
                expiresAt: new Date(Date.now() - 1_000),
              }),
          updatedAt: new Date(),
        })
        .where(eq(syncSweepPromises.id, seeded.promise.id));
      const before = await readPromise(seeded.promise.id);

      const recorded = await recordRansPolarPromotion(db, {
        parentJobId: seeded.parent.id,
        ingestLeaseToken: seeded.ingestLeaseToken,
        airfoilId,
        revisionId,
        triggerResultAttemptId: seeded.triggerAttempt.id,
        triggerAoaDeg: 2,
        requestedAoas: seeded.aoas,
        intentionallyOmittedAoas: [8],
        ownership: { syncPromiseIds: [seeded.promise.id] },
      });

      expect(recorded).toBeNull();
      expect(await readPromise(seeded.promise.id)).toEqual(before);
      expect(
        await db
          .select()
          .from(simRansPolarPromotions)
          .where(eq(simRansPolarPromotions.parentJobId, seeded.parent.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(simPrecalcObligations)
          .where(eq(simPrecalcObligations.revisionId, revisionId)),
      ).toHaveLength(0);
    },
  );

  it("does not steal a fulfilled sibling that a different active promise now owns", async () => {
    const seeded = await seedRemoteWholePolarParent("promote-competing-owner");
    const competing = await seedMirroredPromise("competing-owner", [0]);

    const recorded = await recordRansPolarPromotion(db, {
      parentJobId: seeded.parent.id,
      ingestLeaseToken: seeded.ingestLeaseToken,
      airfoilId,
      revisionId,
      triggerResultAttemptId: seeded.triggerAttempt.id,
      triggerAoaDeg: 2,
      requestedAoas: seeded.aoas,
      intentionallyOmittedAoas: [8],
      ownership: { syncPromiseIds: [seeded.promise.id] },
    });

    expect(recorded).toBeNull();
    expect((await readPromise(seeded.promise.id)).points).toMatchObject([
      { aoaDeg: 0, status: "fulfilled" },
      { aoaDeg: 2, status: "active" },
      { aoaDeg: 8, status: "active" },
    ]);
    expect((await readPromise(competing.id)).points).toMatchObject([
      { aoaDeg: 0, status: "active" },
    ]);
    expect(
      await db
        .select()
        .from(simRansPolarPromotions)
        .where(eq(simRansPolarPromotions.parentJobId, seeded.parent.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.revisionId, revisionId)),
    ).toHaveLength(0);
  });

  it("acquires competing promise owners before the shared cell lock under two-transaction contention", async () => {
    const seeded = await seedRemoteWholePolarParent("promotion-lock-order");
    const competing = await seedMirroredPromise(
      "promotion-lock-competitor",
      [0],
    );
    let ownerLockedResolve!: () => void;
    let proceedResolve!: () => void;
    const ownerLocked = new Promise<void>((resolve) => {
      ownerLockedResolve = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      proceedResolve = resolve;
    });
    const competitorTransaction = db.transaction(async (tx) => {
      await tx.execute(dsql`
        SELECT promise.id
        FROM sync_sweep_promises promise
        JOIN sync_sweep_promise_points point
          ON point.promise_id = promise.id
        WHERE promise.id = ${competing.id}
        FOR UPDATE OF promise, point
      `);
      ownerLockedResolve();
      await proceed;
      await tx.execute(dsql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${`precalc-cell:${airfoilId}:${revisionId}:0`},
            0
          )
        )
      `);
    });
    await ownerLocked;

    const promotion = recordRansPolarPromotion(db, {
      parentJobId: seeded.parent.id,
      ingestLeaseToken: seeded.ingestLeaseToken,
      airfoilId,
      revisionId,
      triggerResultAttemptId: seeded.triggerAttempt.id,
      triggerAoaDeg: 2,
      requestedAoas: seeded.aoas,
      intentionallyOmittedAoas: [8],
      ownership: { syncPromiseIds: [seeded.promise.id] },
    });
    // Give the promotion transaction time to reach the owner row held above.
    // Correct owner->cell order means it cannot hold the shared cell yet.
    await new Promise((resolve) => setTimeout(resolve, 100));
    proceedResolve();

    const [, recorded] = await Promise.all([competitorTransaction, promotion]);
    expect(recorded).toBeNull();
    expect((await readPromise(seeded.promise.id)).points[0]).toMatchObject({
      aoaDeg: 0,
      status: "fulfilled",
    });
    expect((await readPromise(competing.id)).points[0]).toMatchObject({
      aoaDeg: 0,
      status: "active",
    });
  }, 10_000);
});

describe("remote-owned derived PRECALC lifecycle", () => {
  it("MUST-CATCH: a pending attempt-2 PRECALC owns the remote point before any replacement RANS shell", async () => {
    const aoa = 919.001;
    const { promise, parent, result } = await seedRemoteRejectedParent(
      "pending-precalc-attempt-2",
      aoa,
    );
    await db
      .update(syncApiSettings)
      .set({ remoteSolverCpuBudget: 1 })
      .where(eq(syncApiSettings.id, 1));
    const firstSubmit = vi.fn(async () =>
      acceptedStatus("pending-precalc-attempt-1"),
    );
    await submitUransRetryForJob(
      db,
      { submitPolar: firstSubmit } as unknown as EngineClient,
      parent,
      {
        meshRecoveryVersion: 4,
        uransRecoveryVersion: 1,
        cpuSlots: 1,
      },
    );
    const [firstChild] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
    const [obligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.latestSimJobId, firstChild.id));
    expect(obligation).toMatchObject({ state: "running", attemptCount: 1 });

    await db
      .update(simJobs)
      .set({
        status: "done",
        engineState: "completed",
        ingestedAt: new Date(),
        finishedAt: new Date(),
      })
      .where(eq(simJobs.id, firstChild.id));
    await db
      .update(simPrecalcObligationAttempts)
      .set({
        state: "rejected",
        outcome: "quality_rejected",
        error: "preliminary observation horizon was too short",
        completedAt: new Date(),
      })
      .where(eq(simPrecalcObligationAttempts.simJobId, firstChild.id));
    await db
      .update(simPrecalcObligations)
      .set({
        state: "pending",
        attemptCount: 1,
        nextSubmitAt: new Date(Date.now() - 1_000),
        lastOutcome: "quality_rejected",
        lastError: "preliminary observation horizon was too short",
      })
      .where(eq(simPrecalcObligations.id, obligation.id));
    await db
      .update(results)
      .set({ status: "stale" })
      .where(eq(results.id, result.id));

    const forbiddenRansSubmit = vi.fn(async () =>
      acceptedStatus("forbidden-replacement-rans"),
    );
    expect(
      await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(
          and(
            inArray(simJobs.status, [
              "pending",
              "submitted",
              "running",
              "ingesting",
            ]),
            dsql`${simJobs.requestPayload} ? 'syncPromiseId'`,
          ),
        ),
    ).toHaveLength(0);
    const remoteAdmissionConsumed = await admitRemoteSolverTick(
      db,
      { submitPolar: forbiddenRansSubmit } as unknown as EngineClient,
      { kind: "allow", meshRecoveryVersion: 4 },
    );
    const [admissionStatus] = await db
      .select({
        status: syncApiSettings.remoteSolverLastStatus,
        error: syncApiSettings.remoteSolverLastError,
      })
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    expect({ remoteAdmissionConsumed, admissionStatus }).toMatchObject({
      remoteAdmissionConsumed: true,
      admissionStatus: { status: "solving", error: null },
    });
    expect(forbiddenRansSubmit).not.toHaveBeenCalled();
    expect(
      await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(
          and(
            eq(simJobs.wave, 1),
            dsql`${simJobs.requestPayload} ->> 'syncPromiseId' = ${promise.id}`,
            dsql`${simJobs.id} <> ${parent.id}`,
          ),
        ),
    ).toHaveLength(0);

    const correctiveSubmit = vi.fn(async (_request: PolarRequest) =>
      acceptedStatus("pending-precalc-attempt-2"),
    );
    await expect(
      submitRemotePromisePrecalcRecoveries(
        db,
        { submitPolar: correctiveSubmit } as unknown as EngineClient,
        4,
        1,
      ),
    ).resolves.toBe(true);
    expect(correctiveSubmit).toHaveBeenCalledTimes(1);
    expect(correctiveSubmit.mock.calls[0]![0]).toMatchObject({
      aoa: { angles: [aoa] },
      resources: { cpu_budget: 1 },
      solver: { urans_fidelity: "precalc" },
    });
    const children = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)))
      .orderBy(simJobs.createdAt);
    expect(children).toHaveLength(2);
    expect(children[1]).toMatchObject({
      status: "submitted",
      methodKey: "openfoam.urans",
    });
    expect(children[1]!.requestPayload).toMatchObject({
      syncPromiseId: promise.id,
      remoteSolver: true,
      uransFidelity: "precalc",
      aoas: [aoa],
      resources: { cpu_budget: 1 },
    });
    expect(
      await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligation.id)),
    ).toMatchObject([
      {
        state: "running",
        attemptCount: 2,
        latestSimJobId: children[1]!.id,
      },
    ]);
  });

  it("submits an exact promised wave-2 child with conjunctive remote provenance and no background owner", async () => {
    const aoa = 920.001;
    const { promise, parent } = await seedRemoteRejectedParent(
      "derived-active",
      aoa,
    );
    const submitPolar = vi.fn(async () => acceptedStatus("derived-active"));
    const engine = {
      submitPolar,
      cancelJob: vi.fn(),
    } as unknown as EngineClient;

    await submitUransRetryForJob(db, engine, parent);

    expect(submitPolar).toHaveBeenCalledTimes(1);
    const [child] = await db
      .select()
      .from(simJobs)
      .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
    expect(child).toMatchObject({
      campaignId: null,
      status: "submitted",
      wave: 2,
    });
    const payload = child.requestPayload as {
      syncPromiseId: string;
      remoteSolver: boolean;
      upstreamBaseUrl: string;
      aoas: number[];
      precalcObligationIds: string[];
    };
    expect(payload).toMatchObject({
      syncPromiseId: promise.id,
      remoteSolver: true,
      upstreamBaseUrl: UPSTREAM,
      aoas: [aoa],
    });
    expect(payload.precalcObligationIds).toHaveLength(1);
    const [obligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, payload.precalcObligationIds[0]));
    expect(obligation).toMatchObject({
      airfoilId,
      revisionId,
      aoaDeg: aoa,
      backgroundOwner: false,
      state: "running",
      attemptCount: 1,
      latestSimJobId: child.id,
    });
    expect(
      await db
        .select()
        .from(simPrecalcObligationAttempts)
        .where(eq(simPrecalcObligationAttempts.obligationId, obligation.id)),
    ).toMatchObject([
      { simJobId: child.id, attemptNumber: 1, state: "submitted" },
    ]);
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.simJobId, child.id)),
    ).toHaveLength(0);
  });

  it.each([
    ["cancelled", 921.001],
    ["expired", 922.001],
  ] as const)(
    "does not derive or resubmit wave-2 work when the remote promise is already %s",
    async (transition, aoa) => {
      const { promise, parent } = await seedRemoteRejectedParent(
        `derived-before-${transition}`,
        aoa,
      );
      if (transition === "cancelled") {
        await db
          .update(syncSweepPromises)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(eq(syncSweepPromises.id, promise.id));
        await db
          .update(syncSweepPromisePoints)
          .set({ status: "cancelled" })
          .where(eq(syncSweepPromisePoints.promiseId, promise.id));
      } else {
        await db
          .update(syncSweepPromises)
          .set({ expiresAt: new Date(Date.now() - 1_000) })
          .where(eq(syncSweepPromises.id, promise.id));
      }
      const submitPolar = vi.fn(async () =>
        acceptedStatus(`derived-before-${transition}`),
      );
      const engine = {
        submitPolar,
        cancelJob: vi.fn(),
      } as unknown as EngineClient;

      await submitUransRetryForJob(db, engine, parent);
      await submitUransRetryForJob(db, engine, parent);

      expect(submitPolar).not.toHaveBeenCalled();
      expect(
        await db
          .select()
          .from(simJobs)
          .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2))),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(simPrecalcObligations)
          .where(eq(simPrecalcObligations.revisionId, revisionId)),
      ).toHaveLength(0);
    },
  );

  it.each([
    ["cancelled", 923.001],
    ["expired", 924.001],
  ] as const)(
    "compensates exactly once when the remote promise becomes %s during derived wave-2 submit",
    async (transition, aoa) => {
      const { promise, parent } = await seedRemoteRejectedParent(
        `derived-inflight-${transition}`,
        aoa,
      );
      const accepted = acceptedStatus(`derived-inflight-${transition}`);
      const cancelJob = vi.fn(async () => accepted);
      const submitPolar = vi.fn(async () => {
        if (transition === "cancelled") {
          await db
            .update(syncSweepPromises)
            .set({ status: "cancelled", cancelledAt: new Date() })
            .where(eq(syncSweepPromises.id, promise.id));
          await db
            .update(syncSweepPromisePoints)
            .set({ status: "cancelled" })
            .where(eq(syncSweepPromisePoints.promiseId, promise.id));
        } else {
          await db
            .update(syncSweepPromises)
            .set({ expiresAt: new Date(Date.now() - 1_000) })
            .where(eq(syncSweepPromises.id, promise.id));
        }
        return accepted;
      });
      const engine = { submitPolar, cancelJob } as unknown as EngineClient;

      await submitUransRetryForJob(db, engine, parent);
      await submitUransRetryForJob(db, engine, parent);

      expect(submitPolar).toHaveBeenCalledTimes(1);
      expect(cancelJob).toHaveBeenCalledTimes(1);
      expect(cancelJob).toHaveBeenCalledWith(accepted.job_id);
      const [child] = await db
        .select()
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
      expect(child).toMatchObject({
        campaignId: null,
        status: "cancelled",
        engineJobId: accepted.job_id,
        engineState: "cancelled",
      });
      expect(child.requestPayload).toMatchObject({
        syncPromiseId: promise.id,
        remoteSolver: true,
        upstreamBaseUrl: UPSTREAM,
        aoas: [aoa],
      });
      const obligationIds = (
        child.requestPayload as { precalcObligationIds: string[] }
      ).precalcObligationIds;
      const [obligation] = await db
        .select()
        .from(simPrecalcObligations)
        .where(eq(simPrecalcObligations.id, obligationIds[0]));
      expect(obligation).toMatchObject({
        backgroundOwner: false,
        state: "cancelled",
        attemptCount: 1,
        latestSimJobId: child.id,
        lastOutcome: "ownerless",
      });
      expect(
        await db
          .select()
          .from(resultAttempts)
          .where(eq(resultAttempts.simJobId, child.id)),
      ).toHaveLength(0);
    },
  );
});

describe("remote solver push validation regressions", () => {
  it("scopes broker upload idempotency to the promise and immutable attempt", () => {
    const attemptId = randomUUID();
    const firstPromiseId = randomUUID();
    const secondPromiseId = randomUUID();

    const first = brokeredEvidenceIdempotencyKey(firstPromiseId, attemptId);
    const retry = brokeredEvidenceIdempotencyKey(firstPromiseId, attemptId);
    const reusedEvidence = brokeredEvidenceIdempotencyKey(
      secondPromiseId,
      attemptId,
    );

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(retry).toBe(first);
    expect(reusedEvidence).not.toBe(first);
  });

  it("preserves the application-source fingerprint in the pushed runtime identity", async () => {
    const aoaDeg = 809.501;
    const job = await seedDoneRemoteJob("runtime-provenance", [aoaDeg]);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("runtime-provenance", [aoaDeg], promiseId);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, job.id));
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, result.id));
    const applicationSourceSha256 = sha256(
      Buffer.from(`${PREFIX}:runtime-application-source`),
    );
    const provenance = {
      solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
      buildId: `${PREFIX}-runtime-build`,
      sourceRevision: null,
      imageDigest: null,
      applicationSourceSha256,
      packageSha256: null,
      binarySha256: null,
      architecture: "x86_64",
    };
    const [runtime] = await db
      .insert(solverRuntimeBuilds)
      .values({
        ...provenance,
        provenanceKey: solverRuntimeProvenanceKey(provenance),
        metadata: { fixture: PREFIX },
      })
      .returning({ id: solverRuntimeBuilds.id });
    cleanupRuntimeBuildIds.add(runtime.id);
    await db
      .update(resultAttempts)
      .set({
        methodKey: "openfoam.rans",
        solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
        solverRuntimeBuildId: runtime.id,
      })
      .where(eq(resultAttempts.id, attempt.id));
    await db
      .update(results)
      .set({
        methodKey: "openfoam.rans",
        solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
        solverRuntimeBuildId: runtime.id,
      })
      .where(eq(results.id, result.id));
    await db
      .update(simJobs)
      .set({
        solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
        solverRuntimeBuildId: runtime.id,
      })
      .where(eq(simJobs.id, job.id));
    const { fetchMock } = stubFetch();

    await remoteSolverTick(db, {} as never);

    const [polar] = requests(fetchMock, "/polars");
    expect(polar.body.results[0].engine).toMatchObject({
      family: "openfoam",
      distribution: "opencfd",
      version: "2406",
      applicationSourceSha256,
    });
  });

  it("MUST-CATCH: streams one durable completed result per tick and completes only after every delivery", async () => {
    const job = await seedDoneRemoteJob(
      "chunking",
      [810.001, 811.001, 812.001],
    );
    const { fetchMock, pushedAtDuringPosts } = stubFetch({
      observeJobId: job.id,
    });
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise(
      "push-completion",
      [810.001, 811.001, 812.001],
      promiseId,
    );

    await remoteSolverTick(db, {} as never);
    await remoteSolverTick(db, {} as never);
    await remoteSolverTick(db, {} as never);

    const polars = requests(fetchMock, "/polars");
    const [remoteStatus] = await db
      .select({ error: syncApiSettings.remoteSolverLastError })
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    expect(
      polars,
      remoteStatus?.error ?? "no remote solver error",
    ).toHaveLength(3);
    expect(polars.map((call) => call.body.results.length)).toEqual([1, 1, 1]);
    expect(polars.map((call) => call.body.airfoilSlug)).toEqual([
      airfoilSlug,
      airfoilSlug,
      airfoilSlug,
    ]);
    expect(
      requests(
        fetchMock,
        `/sweeps/${(job.requestPayload as { syncPromiseId: string }).syncPromiseId}/complete`,
      ),
    ).toHaveLength(1);
    expect(pushedAtDuringPosts.every((stamp) => stamp === undefined)).toBe(
      true,
    );
    expect((await readJobPayload(job.id)).remotePushedAt).toBeUndefined();
    expect(
      (await deliveriesForJob(job.id)).filter((row) => row.resultId),
    ).toMatchObject([
      { state: "delivered" },
      { state: "delivered" },
      { state: "delivered" },
    ]);
    const mirror = await readPromise(promiseId);
    expect(mirror.promise.status).toBe("fulfilled");
    expect(mirror.points.map((row) => row.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
  });

  it("blocks a 200 response that explicitly leaves the exact AoA unfulfilled", async () => {
    const aoaDeg = 813.001;
    const job = await seedDoneRemoteJob("urans-evidence", [aoaDeg]);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("urans-evidence", [aoaDeg], promiseId);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, job.id));
    const qualityWarning =
      "URANS integration stopped by the wall-clock budget guard: retained 1.4 of 3 periods";
    const frameTrack = {
      stationary: false,
      periods_retained: 1.4,
      selected_frame_count: 28,
    };
    const steadyHistory = {
      iterations: [100, 200],
      cl: [0.4, 0.42],
      cd: [0.02, 0.021],
      cm: [-0.02, -0.021],
      window: { start_iter: 100, end_iter: 200 },
      mean_stable: false,
    };
    const historyPayload = {
      t: [0, 1, 2],
      cl: [0.4, 0.5, 0.4],
      cd: [0.02, 0.03, 0.02],
      cm: null,
      clMean: 0.433,
      clRms: 0.047,
      cdMean: 0.023,
      cdRms: 0.0047,
      strouhal: 0.18,
      sheddingFreqHz: 4.1,
      sampleCount: 3,
    };
    await db
      .update(results)
      .set({
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        stalled: true,
        clStd: 0.02,
        cdStd: 0.001,
        cmStd: 0.003,
        nCells: 234_567,
        qualityWarnings: [qualityWarning],
        frameTrack,
        steadyHistory,
      })
      .where(eq(results.id, result.id));
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, result.id));
    await db
      .update(resultAttempts)
      .set({
        regime: "urans",
        unsteady: true,
        stalled: true,
        clStd: 0.02,
        cdStd: 0.001,
        cmStd: 0.003,
        nCells: 234_567,
        qualityWarnings: [qualityWarning],
        evidencePayload: {
          fidelity: "urans_precalc",
          quality_warnings: [qualityWarning],
          frame_track: frameTrack,
          steady_history: steadyHistory,
          force_history: historyPayload,
        },
      })
      .where(eq(resultAttempts.id, attempt.id));
    await db
      .update(resultClassifications)
      .set({ regime: "urans" })
      .where(eq(resultClassifications.resultAttemptId, attempt.id));
    await db.insert(forceHistory).values({
      resultId: result.id,
      resultAttemptId: attempt.id,
      ...historyPayload,
    });
    const [manifest] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultAttemptId, attempt.id),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      );
    const video = writeMedia(
      `jobs/${job.engineJobId}/cases/0/pressure.mp4`,
      "urans-evidence-video",
    );
    await db.insert(resultMedia).values({
      resultId: result.id,
      resultAttemptId: attempt.id,
      kind: "video",
      field: "pressure_transport",
      role: "instantaneous",
      storageKey: video.storageKey,
      mimeType: "video/mp4",
      frameCount: 28,
      durationS: 1.4,
      evidenceSha256: manifest.sha256,
      sha256: video.sha256,
      byteSize: video.byteSize,
    });
    const { fetchMock } = stubFetch({ unfulfilledPolarIndex: 1 });

    await remoteSolverTick(db, {} as never);

    const [polar] = requests(fetchMock, "/polars");
    expect(polar.body.results).toHaveLength(1);
    expect(polar.body.results[0]).toMatchObject({
      aoaDeg,
      regime: "urans",
      fidelity: "urans_precalc",
      clStd: 0.02,
      cdStd: 0.001,
      cmStd: 0.003,
      nCells: 234_567,
      qualityWarnings: [qualityWarning],
      frameTrack,
      steadyHistory,
      forceHistory: {
        t: [0, 1, 2],
        cl: [0.4, 0.5, 0.4],
        cd: [0.02, 0.03, 0.02],
        cm: null,
        clMean: 0.433,
        clRms: 0.047,
        cdMean: 0.023,
        cdRms: 0.0047,
        strouhal: 0.18,
        sheddingFreqHz: 4.1,
        sampleCount: 3,
      },
    });
    expect(polar.body.results[0].media).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "video",
          field: "pressure_transport",
          sha256: video.sha256,
          byteSize: video.byteSize,
        }),
      ]),
    );
    expect(requests(fetchMock, `/sweeps/${promiseId}/complete`)).toHaveLength(
      0,
    );
    const mirror = await readPromise(promiseId);
    expect(mirror.promise.status).toBe("cancelled");
    expect(mirror.points).toMatchObject([
      { status: "cancelled", resultId: null },
    ]);
    expect((await readJobPayload(job.id)).remotePushedAt).toBeUndefined();
    expect(
      (await deliveriesForJob(job.id)).filter((row) => row.resultId),
    ).toMatchObject([
      {
        state: "superseded",
        lastHttpStatus: 200,
        lastError: expect.stringContaining(
          `explicitly left ${aoaDeg}° unfulfilled`,
        ),
      },
    ]);
  });

  it("persists a failed point delivery and retries only undelivered results", async () => {
    const job = await seedDoneRemoteJob(
      "chunk-retry",
      [820.001, 821.001, 822.001],
    );
    await seedMirroredPromise(
      "chunk-retry",
      [820.001, 821.001, 822.001],
      (job.requestPayload as { syncPromiseId: string }).syncPromiseId,
    );
    const failed = stubFetch({ failPolarIndex: 2 });

    await remoteSolverTick(db, {} as never);
    await remoteSolverTick(db, {} as never);

    expect(requests(failed.fetchMock, "/polars")).toHaveLength(2);
    expect(
      requests(
        failed.fetchMock,
        `/sweeps/${(job.requestPayload as { syncPromiseId: string }).syncPromiseId}/complete`,
      ),
    ).toHaveLength(0);
    expect((await readJobPayload(job.id)).remotePushedAt).toBeUndefined();
    const [settingsAfterFailure] = await db
      .select()
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1))
      .limit(1);
    expect(settingsAfterFailure.remoteSolverLastStatus).toBe("error");
    expect(settingsAfterFailure.remoteSolverLastError).toContain(
      "remote polar push failed (500)",
    );

    await db
      .update(syncRemoteResultDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(syncRemoteResultDeliveries.state, "retry_wait"));

    vi.unstubAllGlobals();
    const retried = stubFetch();
    await remoteSolverTick(db, {} as never);
    await remoteSolverTick(db, {} as never);

    expect(requests(retried.fetchMock, "/polars")).toHaveLength(2);
    expect(
      requests(
        retried.fetchMock,
        `/sweeps/${(job.requestPayload as { syncPromiseId: string }).syncPromiseId}/complete`,
      ),
    ).toHaveLength(1);
    expect((await readJobPayload(job.id)).remotePushedAt).toBeUndefined();
    expect(
      (await deliveriesForJob(job.id)).filter((row) => row.resultId),
    ).toSatisfy((rows: Array<{ state: string }>) =>
      rows.every((row) => row.state === "delivered"),
    );
  });

  it("MUST-CATCH: does not deliver or reclaim a result before default-media extents exist", async () => {
    const aoa = 822.101;
    const job = await seedDoneRemoteJob("media-before-delivery", [aoa]);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("media-before-delivery", [aoa], promiseId);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, job.id));
    await db
      .delete(resultFieldExtents)
      .where(eq(resultFieldExtents.resultId, result.id));
    const waitingFetch = stubFetch();

    await remoteSolverTick(db, {} as never);

    expect(requests(waitingFetch.fetchMock, "/polars")).toHaveLength(0);
    expect(
      (await deliveriesForJob(job.id)).filter((row) => row.resultId),
    ).toHaveLength(0);
  });

  it("retires local media work after the authoritative hub accepted that exact generation", async () => {
    const aoa = 822.102;
    const job = await seedDoneRemoteJob("hub-owns-media-repair", [aoa]);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("hub-owns-media-repair", [aoa], promiseId);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, job.id));
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.id, result.currentResultAttemptId!));
    const [manifest] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, result.id),
          eq(solverEvidenceArtifacts.resultAttemptId, attempt.id),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      );
    await db.insert(syncRemoteResultDeliveries).values({
      promiseId,
      simJobId: job.id,
      resultId: result.id,
      resultAttemptId: attempt.id,
      aoaDeg: aoa,
      generationKey: attempt.id,
      state: "delivered",
      deliveredAt: new Date(),
    });
    await db.insert(resultMediaRepairs).values({
      resultId: result.id,
      resultAttemptId: attempt.id,
      state: "retry_wait",
      evidenceSignature: `${attempt.engineJobId}:${attempt.engineCaseSlug}:${manifest.sha256}`,
      nextAttemptAt: new Date(),
      lastError: "local archive was reclaimed after signed hub acknowledgement",
    });

    await discoverMissingResultMediaRepairs(db, { resultId: result.id });

    expect(
      await db
        .select()
        .from(resultMediaRepairs)
        .where(eq(resultMediaRepairs.resultId, result.id)),
    ).toHaveLength(0);
  });

  it("MUST-CATCH: terminal wave-2 children unblock a wave-1 parent push, while running children still delay it", async () => {
    const unblocked = await seedDoneRemoteJob(
      "done-child-unblocks",
      [830.001],
      1,
    );
    await seedMirroredPromise(
      "done-child-unblocks",
      [830.001],
      (unblocked.requestPayload as { syncPromiseId: string }).syncPromiseId,
    );
    await db.insert(simJobs).values({
      parentJobId: unblocked.id,
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      referenceChordM: CHORD,
      wave: 2,
      status: "done",
      engineJobId: `${PREFIX}-done-child`,
      totalCases: 1,
      completedCases: 1,
      finishedAt: new Date(),
    });
    const doneChildFetch = stubFetch();

    await remoteSolverTick(db, {} as never);

    expect(requests(doneChildFetch.fetchMock, "/polars")).toHaveLength(1);
    expect((await readJobPayload(unblocked.id)).remotePushedAt).toBeUndefined();
    expect(
      (await deliveriesForJob(unblocked.id)).filter((row) => row.resultId),
    ).toMatchObject([{ state: "delivered" }]);

    vi.unstubAllGlobals();
    await cleanupRemoteRows();
    const blocked = await seedDoneRemoteJob(
      "running-child-blocks",
      [831.001],
      1,
    );
    await seedMirroredPromise(
      "running-child-blocks",
      [831.001],
      (blocked.requestPayload as { syncPromiseId: string }).syncPromiseId,
    );
    await db.insert(simJobs).values({
      parentJobId: blocked.id,
      airfoilId,
      bcIds: [bcId],
      simulationPresetRevisionId: revisionId,
      referenceChordM: CHORD,
      wave: 2,
      status: "running",
      engineJobId: `${PREFIX}-running-child`,
      totalCases: 1,
      completedCases: 0,
      submittedAt: new Date(),
    });
    const runningChildFetch = stubFetch();

    await remoteSolverTick(db, {} as never);

    expect(requests(runningChildFetch.fetchMock, "/polars")).toHaveLength(0);
    expect(requests(runningChildFetch.fetchMock, "/complete")).toHaveLength(0);
    expect((await readJobPayload(blocked.id)).remotePushedAt).toBeUndefined();
  });

  it("does not complete a promise after a partial job push and fulfills it only after every promised point is pushed", async () => {
    const promiseId = randomUUID();
    const first = await seedDoneRemoteJob(
      "partial-first",
      [840.001],
      2,
      promiseId,
    );
    await seedMirroredPromise(
      "partial-coverage",
      [840.001, 841.001],
      promiseId,
    );
    const firstPush = stubFetch();

    await remoteSolverTick(db, {} as never);

    expect(requests(firstPush.fetchMock, "/polars")).toHaveLength(1);
    expect(
      requests(firstPush.fetchMock, `/sweeps/${promiseId}/complete`),
    ).toHaveLength(0);
    expect((await readJobPayload(first.id)).remotePushedAt).toBeUndefined();
    expect(
      (await deliveriesForJob(first.id)).filter((row) => row.resultId),
    ).toMatchObject([{ state: "delivered" }]);
    const partial = await readPromise(promiseId);
    expect(partial.promise.status).toBe("active");
    expect(partial.points.map((row) => row.status)).toEqual([
      "fulfilled",
      "active",
    ]);

    vi.unstubAllGlobals();
    const second = await seedDoneRemoteJob(
      "partial-second",
      [841.001],
      2,
      promiseId,
    );
    const secondPush = stubFetch();
    await remoteSolverTick(db, {} as never);

    expect(requests(secondPush.fetchMock, "/polars")).toHaveLength(1);
    expect(
      requests(secondPush.fetchMock, `/sweeps/${promiseId}/complete`),
    ).toHaveLength(1);
    expect((await readJobPayload(second.id)).remotePushedAt).toBeUndefined();
    expect(
      (await deliveriesForJob(second.id)).filter((row) => row.resultId),
    ).toMatchObject([{ state: "delivered" }]);
    const complete = await readPromise(promiseId);
    expect(complete.promise.status).toBe("fulfilled");
    expect(complete.points.map((row) => row.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
  });

  it("keeps a slow progressing upload alive past multiple stall windows and aborts a stalled upload", async () => {
    const progressing = createProgressAwareAbort({
      stallTimeoutMs: 30,
      absoluteTimeoutMs: 1_000,
    });
    for (let step = 0; step < 4; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      progressing.progress();
      expect(progressing.signal.aborted).toBe(false);
    }
    progressing.dispose();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(progressing.signal.aborted).toBe(false);

    const stalled = createProgressAwareAbort({
      stallTimeoutMs: 20,
      absoluteTimeoutMs: 1_000,
    });
    await new Promise<void>((resolve) =>
      stalled.signal.addEventListener("abort", () => resolve(), {
        once: true,
      }),
    );
    expect(stalled.signal.aborted).toBe(true);
    expect(String(stalled.signal.reason)).toContain(
      "stalled without stream progress",
    );
    stalled.dispose();
  });

  it("MUST-CATCH: a transfer lasting beyond one hour renews the exact upstream promise with a one-hour TTL throughout", async () => {
    const promiseId = randomUUID();
    const [settings] = await db
      .select()
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    const returning = vi.fn(async () => [{ id: promiseId }]);
    const dbMock = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning })),
        })),
      })),
    };
    const heartbeatBodies: Array<Record<string, unknown>> = [];
    vi.useFakeTimers({ now: new Date("2026-07-18T00:00:00.000Z") });
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: string | URL, init?: RequestInit) => {
          heartbeatBodies.push(JSON.parse(String(init?.body ?? "{}")));
          return Response.json({
            ok: true,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }),
      );
      const onRenew = vi.fn(async () => undefined);
      const lease = await startRemotePromiseTransferLease(
        dbMock as unknown as typeof db,
        {} as EngineClient,
        settings,
        promiseId,
        onRenew,
      );
      await vi.advanceTimersByTimeAsync(61 * 60_000);
      expect(lease.signal.aborted).toBe(false);
      expect(heartbeatBodies).toHaveLength(5);
      expect(heartbeatBodies).toSatisfy(
        (rows: Array<Record<string, unknown>>) =>
          rows.every((row) => row.ttlHours === 1),
      );
      expect(onRenew).toHaveBeenCalledTimes(5);
      expect(returning).toHaveBeenCalledTimes(5);
      expect(await lease.stop()).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("MUST-CATCH: an exact fulfilled-result evidence replay renews its local claim without reopening the upstream work lease", async () => {
    const promiseId = randomUUID();
    const [settings] = await db
      .select()
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    const fetchMock = vi.fn(async () => {
      throw new Error("fulfilled evidence replay must not heartbeat work");
    });
    vi.stubGlobal("fetch", fetchMock);
    const onRenew = vi.fn(async () => undefined);
    const lease = await startRemotePromiseTransferLease(
      {} as typeof db,
      {} as EngineClient,
      settings,
      promiseId,
      onRenew,
      { renewUpstreamPromise: false },
    );
    expect(lease.signal.aborted).toBe(false);
    expect(onRenew).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await lease.stop()).toBeNull();
  });

  it("MUST-CATCH: a fulfilled evidence replay sends only the manifest and brokered archive", async () => {
    const aoaDeg = 865.901;
    const job = await seedDoneRemoteJob("fulfilled-storage-only", [aoaDeg]);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("fulfilled-storage-only", [aoaDeg], promiseId);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, job.id));
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, result.id));
    await db
      .update(syncSweepPromises)
      .set({ status: "fulfilled", fulfilledAt: new Date() })
      .where(eq(syncSweepPromises.id, promiseId));
    await db
      .update(syncSweepPromisePoints)
      .set({
        status: "fulfilled",
        resultId: result.id,
        resultAttemptId: attempt.id,
      })
      .where(eq(syncSweepPromisePoints.promiseId, promiseId));
    await db.insert(syncRemoteResultDeliveries).values({
      promiseId,
      simJobId: job.id,
      resultId: result.id,
      resultAttemptId: attempt.id,
      aoaDeg,
      generationKey: attempt.id,
    });
    const { fetchMock } = stubFetch();

    await remoteSolverTick(db, {} as never);

    const [polar] = requests(fetchMock, "/polars");
    const [deliveryAfter] = await db
      .select()
      .from(syncRemoteResultDeliveries)
      .where(eq(syncRemoteResultDeliveries.promiseId, promiseId));
    const [settingsAfter] = await db
      .select()
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    expect(
      polar,
      JSON.stringify({
        deliveryAfter,
        remoteSolverLastStatus: settingsAfter?.remoteSolverLastStatus,
        remoteSolverLastError: settingsAfter?.remoteSolverLastError,
        requests: fetchMock.mock.calls.map(([input]) => String(input)),
      }),
    ).toBeTruthy();
    expect(polar.body.results[0].media).toEqual([]);
    expect(polar.body.results[0].fieldExtents).toEqual([]);
    expect(
      polar.body.results[0].evidenceArtifacts.map(
        (artifact: { kind: string }) => artifact.kind,
      ),
    ).toEqual(["manifest", "engine_bundle"]);
    expect(requests(fetchMock, `/sweeps/${promiseId}/heartbeat`)).toHaveLength(
      0,
    );
  });

  it("MUST-CATCH: a cancelled lease with an exact fulfilled point replays only evidence storage", async () => {
    const aoaDeg = 865.903;
    const job = await seedDoneRemoteJob("cancelled-storage-only", [aoaDeg]);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("cancelled-storage-only", [aoaDeg], promiseId);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, job.id));
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, result.id));
    await db
      .update(syncSweepPromises)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(syncSweepPromises.id, promiseId));
    await db
      .update(syncSweepPromisePoints)
      .set({
        status: "fulfilled",
        resultId: result.id,
        resultAttemptId: attempt.id,
      })
      .where(eq(syncSweepPromisePoints.promiseId, promiseId));
    await db.insert(syncRemoteResultDeliveries).values({
      promiseId,
      simJobId: job.id,
      resultId: result.id,
      resultAttemptId: attempt.id,
      aoaDeg,
      generationKey: attempt.id,
    });
    const { fetchMock } = stubFetch();

    await remoteSolverTick(db, {} as never);

    const [polar] = requests(fetchMock, "/polars");
    expect(polar).toBeTruthy();
    expect(polar.body.results[0].media).toEqual([]);
    expect(polar.body.results[0].fieldExtents).toEqual([]);
    expect(
      polar.body.results[0].evidenceArtifacts.map(
        (artifact: { kind: string }) => artifact.kind,
      ),
    ).toEqual(["manifest", "engine_bundle"]);
    expect(requests(fetchMock, `/sweeps/${promiseId}/heartbeat`)).toHaveLength(
      0,
    );
  });

  it("MUST-CATCH: legacy migration selects a cancelled promise only through its exact fulfilled point", async () => {
    const aoaDeg = 865.904;
    const job = await seedDoneRemoteJob("cancelled-legacy-backfill", [aoaDeg]);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("cancelled-legacy-backfill", [aoaDeg], promiseId);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, job.id));
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, result.id));
    await db
      .delete(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, result.id),
          eq(solverEvidenceArtifacts.resultAttemptId, attempt.id),
          eq(solverEvidenceArtifacts.kind, "engine_bundle"),
        ),
      );
    const legacy = writeMedia(
      `jobs/${job.engineJobId}/cases/${attempt.engineCaseSlug}/evidence/openfoam_evidence.tar.gz`,
      "cancelled-legacy-backfill:gzip",
    );
    await db.insert(solverEvidenceArtifacts).values({
      resultId: result.id,
      resultAttemptId: attempt.id,
      airfoilId,
      simJobId: job.id,
      engineJobId: job.engineJobId,
      engineCaseSlug: attempt.engineCaseSlug,
      aoaDeg,
      kind: "openfoam_bundle",
      role: "raw",
      storageKey: legacy.storageKey,
      mimeType: "application/gzip",
      sha256: legacy.sha256,
      byteSize: legacy.byteSize,
      metadata: { evidenceBase: "evidence" },
    });
    await db
      .update(syncSweepPromises)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(syncSweepPromises.id, promiseId));
    await db
      .update(syncSweepPromisePoints)
      .set({
        status: "fulfilled",
        resultId: result.id,
        resultAttemptId: attempt.id,
      })
      .where(eq(syncSweepPromisePoints.promiseId, promiseId));
    const [delivery] = await db
      .insert(syncRemoteResultDeliveries)
      .values({
        promiseId,
        simJobId: job.id,
        resultId: result.id,
        resultAttemptId: attempt.id,
        aoaDeg,
        generationKey: attempt.id,
        state: "superseded",
      })
      .returning();

    await expect(
      backfillLegacyBrokeredEvidence({
        db,
        engine: {} as EngineClient,
        execute: false,
        deliveryIds: [delivery.id],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        deliveryId: delivery.id,
        resultId: result.id,
        resultAttemptId: attempt.id,
        state: "planned",
      }),
    ]);
  });

  it("FALSE-POSITIVE-GUARD: a closed promise without the exact result-attempt owner cannot enter storage-only replay", async () => {
    const aoaDeg = 865.902;
    const job = await seedDoneRemoteJob("fulfilled-owner-mismatch", [aoaDeg]);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("fulfilled-owner-mismatch", [aoaDeg], promiseId);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, job.id));
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, result.id));
    await db
      .update(syncSweepPromises)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(syncSweepPromises.id, promiseId));
    await db
      .update(syncSweepPromisePoints)
      .set({ status: "fulfilled", resultId: result.id, resultAttemptId: null })
      .where(eq(syncSweepPromisePoints.promiseId, promiseId));
    await db.insert(syncRemoteResultDeliveries).values({
      promiseId,
      simJobId: job.id,
      resultId: result.id,
      resultAttemptId: attempt.id,
      aoaDeg,
      generationKey: attempt.id,
    });
    const { fetchMock } = stubFetch();

    await remoteSolverTick(db, {} as never);

    expect(requests(fetchMock, "/polars")).toHaveLength(0);
    expect((await deliveriesForJob(job.id))[0]).toMatchObject({
      state: "pending",
      attemptCount: 0,
    });
  });

  it("keeps transfer-heartbeat failures retryable but authoritatively stops ownership on 404/409 before upload", async () => {
    for (const [status, expectedState] of [
      [503, "retry_wait"],
      [404, "superseded"],
      [409, "superseded"],
    ] as const) {
      vi.unstubAllGlobals();
      await cleanupRemoteRows();
      await configureRemoteSolver();
      const aoa = 865 + status / 1000;
      const job = await seedDoneRemoteJob(`transfer-heartbeat-${status}`, [
        aoa,
      ]);
      const promiseId = (job.requestPayload as { syncPromiseId: string })
        .syncPromiseId;
      await seedMirroredPromise(
        `transfer-heartbeat-${status}`,
        [aoa],
        promiseId,
      );
      const base = stubFetch().fetchMock;
      const fetchMock = vi.fn(
        async (input: string | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith(`/sweeps/${promiseId}/heartbeat`))
            return Response.json(
              { error: "lease renewal rejected" },
              { status },
            );
          return base(input, init);
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      await remoteSolverTick(db, {} as EngineClient);
      expect(requests(fetchMock, "/evidence-uploads")).toHaveLength(0);
      expect(requests(fetchMock, "/polars")).toHaveLength(0);
      const [delivery] = (await deliveriesForJob(job.id)).filter(
        (row) => row.resultId,
      );
      expect(delivery.state).toBe(expectedState);
      const mirror = await readPromise(promiseId);
      if (status === 503) {
        expect(mirror.promise.status).toBe("active");
        expect(mirror.points[0]?.status).toBe("active");
      } else {
        expect(mirror.promise.status).toBe("cancelled");
        expect(mirror.points[0]?.status).toBe("cancelled");
      }
    }
  });

  it("MUST-CATCH: a reclaim read lasting beyond the ten-minute claim cannot be stolen by another sweeper", async () => {
    const returning = vi.fn(async () => [{ id: randomUUID() }]);
    const dbMock = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning })),
        })),
      })),
    };
    vi.useFakeTimers({ now: new Date("2026-07-18T00:00:00.000Z") });
    try {
      const lease = startRemoteReclaimClaimLease(
        dbMock as unknown as typeof db,
        { id: randomUUID(), token: randomUUID() },
      );
      await vi.advanceTimersByTimeAsync(21 * 60_000);
      expect(lease.signal.aborted).toBe(false);
      expect(returning).toHaveBeenCalledTimes(10);
      expect(await lease.stop()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("MUST-CATCH: reads the exact bound hub archive to EOF before reclaim and keeps every preflight failure retryable without deletion", async () => {
    type FailureCase =
      | "missing-token"
      | "unsafe-hub"
      | "wrong-token"
      | "forbidden"
      | "cross-solver"
      | "redirect"
      | "truncated"
      | "wrong-hash"
      | "wrong-generation"
      | "wrong-mime"
      | "missing-reference"
      | "mismatched-reference";

    const seedPendingReclaim = async (label: string, aoa: number) => {
      vi.unstubAllGlobals();
      await cleanupRemoteRows();
      await configureRemoteSolver();
      brokerObjects.clear();
      brokerArchives.clear();
      const job = await seedDoneRemoteJob(label, [aoa]);
      const promiseId = (job.requestPayload as { syncPromiseId: string })
        .syncPromiseId;
      await seedMirroredPromise(label, [aoa], promiseId);
      stubFetch();
      await remoteSolverTick(db, {} as EngineClient);
      const [receipt] = await db
        .select()
        .from(syncRemoteHubBindingReceipts)
        .where(eq(syncRemoteHubBindingReceipts.promiseId, promiseId));
      const [reference] = await db
        .select()
        .from(remoteAssetReferences)
        .where(
          eq(remoteAssetReferences.resultAttemptId, receipt.resultAttemptId),
        );
      const [settings] = await db
        .select()
        .from(syncApiSettings)
        .where(eq(syncApiSettings.id, 1));
      const archive = brokerArchives.get(receipt.brokeredUploadId);
      expect(receipt).toBeTruthy();
      expect(reference).toBeTruthy();
      expect(archive).toBeTruthy();
      vi.unstubAllGlobals();
      return { receipt, reference, settings, archive: archive! };
    };

    const failures: FailureCase[] = [
      "missing-token",
      "unsafe-hub",
      "wrong-token",
      "forbidden",
      "cross-solver",
      "redirect",
      "truncated",
      "wrong-hash",
      "wrong-generation",
      "wrong-mime",
      "missing-reference",
      "mismatched-reference",
    ];
    for (const [index, failure] of failures.entries()) {
      const fixture = await seedPendingReclaim(
        `reclaim-${failure}`,
        870.001 + index,
      );
      if (failure === "missing-reference") {
        await db
          .delete(remoteAssetReferences)
          .where(eq(remoteAssetReferences.id, fixture.reference.id));
      }
      if (failure === "mismatched-reference") {
        await db
          .update(remoteAssetReferences)
          .set({
            remoteDownloadUrl: `https://attacker.invalid/api/sync/v1/evidence-uploads/${fixture.receipt.brokeredUploadId}/download`,
          })
          .where(eq(remoteAssetReferences.id, fixture.reference.id));
      }
      const attemptedSettings =
        failure === "missing-token"
          ? { ...fixture.settings, remoteSolverAuthToken: "" }
          : failure === "unsafe-hub"
            ? {
                ...fixture.settings,
                upstreamBaseUrl: "http://unsafe-hub.example.test/api/sync/v1",
              }
            : failure === "wrong-token"
              ? {
                  ...fixture.settings,
                  remoteSolverAuthToken:
                    "wrong-current-registered-solver-token-value",
                }
              : fixture.settings;
      const calls: string[] = [];
      const fetchMock = vi.fn(
        async (input: string | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/internal/evidence-uploads/reclaim")) {
            calls.push("reclaim");
            return Response.json({ state: "complete", bytes_freed: 128 });
          }
          if (!url.endsWith(`/${fixture.receipt.brokeredUploadId}/download`))
            throw new Error(`unexpected reclaim preflight request ${url}`);
          calls.push("download");
          expect(init?.method).toBe("GET");
          expect(init?.redirect).toBe("error");
          const suppliedToken = new Headers(init?.headers).get(
            "x-xfoilfoam-solver-token",
          );
          if (failure === "wrong-token") {
            expect(suppliedToken).toBe(
              "wrong-current-registered-solver-token-value",
            );
            return Response.json(
              { error: "invalid solver token" },
              { status: 403 },
            );
          }
          expect(suppliedToken).toBe(fixture.settings.remoteSolverAuthToken);
          if (failure === "forbidden")
            return Response.json({ error: "forbidden" }, { status: 403 });
          if (failure === "cross-solver")
            return Response.json(
              { error: "bound upload is owned by another solver" },
              { status: 409 },
            );
          if (failure === "redirect")
            return new Response(null, {
              status: 302,
              headers: { location: "https://attacker.invalid/archive" },
            });
          let bytes = fixture.archive.bytes;
          if (failure === "truncated") bytes = bytes.subarray(0, -1);
          if (failure === "wrong-hash") {
            bytes = Buffer.from(bytes);
            bytes[0] = (bytes[0] ?? 0) ^ 0xff;
          }
          return new Response(bytes, {
            status: 200,
            headers: {
              "content-type":
                failure === "wrong-mime"
                  ? "application/gzip"
                  : "application/zstd",
              "content-length": String(fixture.archive.byteSize),
              "x-content-sha256": fixture.archive.sha256,
              "x-gcs-generation":
                failure === "wrong-generation"
                  ? "9007199254740993124"
                  : "9007199254740993123",
            },
          });
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      expect(
        await processBrokeredRemoteEvidenceReclaims(db, attemptedSettings, 1),
        failure,
      ).toBe(0);
      expect(calls, failure).not.toContain("reclaim");
      const [retained] = await db
        .select()
        .from(syncRemoteHubBindingReceipts)
        .where(eq(syncRemoteHubBindingReceipts.id, fixture.receipt.id));
      expect(retained, failure).toMatchObject({
        reclaimState: "pending",
        reclaimAttemptCount: 1,
        reclaimedAt: null,
        reclaimedBytes: null,
      });
      expect(retained.reclaimLastError, failure).toBeTruthy();
    }

    const fixture = await seedPendingReclaim("reclaim-success", 889.001);
    const events: string[] = [];
    let sent = false;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/${fixture.receipt.brokeredUploadId}/download`)) {
        events.push("download");
        expect(new Headers(init?.headers).get("x-xfoilfoam-solver-token")).toBe(
          fixture.settings.remoteSolverAuthToken,
        );
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue(fixture.archive.bytes);
              return;
            }
            events.push("eof");
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "application/zstd",
            "content-length": String(fixture.archive.byteSize),
            "x-content-sha256": fixture.archive.sha256,
            "x-gcs-generation": "9007199254740993123",
          },
        });
      }
      if (url.endsWith("/internal/evidence-uploads/reclaim")) {
        events.push("reclaim");
        return Response.json({ state: "complete", bytes_freed: 128 });
      }
      throw new Error(`unexpected successful reclaim request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await processBrokeredRemoteEvidenceReclaims(db, fixture.settings, 1),
    ).toBe(1);
    expect(events).toEqual(["download", "eof", "reclaim"]);
    const [reclaimed] = await db
      .select()
      .from(syncRemoteHubBindingReceipts)
      .where(eq(syncRemoteHubBindingReceipts.id, fixture.receipt.id));
    expect(reclaimed).toMatchObject({
      reclaimState: "reclaimed",
      reclaimedBytes: 128,
      reclaimLastError: null,
    });
  });

  it("claims only the one reclaim row a sequential worker can actively renew", async () => {
    vi.unstubAllGlobals();
    await cleanupRemoteRows();
    await configureRemoteSolver();
    brokerObjects.clear();
    brokerArchives.clear();
    const aoas = [890.001, 891.001];
    const job = await seedDoneRemoteJob("reclaim-sequential-queue", aoas);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("reclaim-sequential-queue", aoas, promiseId);
    stubFetch();
    await remoteSolverTick(db, {} as EngineClient);
    await db
      .update(syncRemoteHubBindingReceipts)
      .set({ reclaimNextAttemptAt: new Date(Date.now() + 3_600_000) });
    await remoteSolverTick(db, {} as EngineClient);
    await db
      .update(syncRemoteHubBindingReceipts)
      .set({ reclaimNextAttemptAt: new Date(Date.now() - 1_000) });
    const [settings] = await db
      .select()
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    const receipts = await db
      .select()
      .from(syncRemoteHubBindingReceipts)
      .where(eq(syncRemoteHubBindingReceipts.promiseId, promiseId));
    expect(receipts).toHaveLength(2);
    vi.unstubAllGlobals();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        const download = /\/evidence-uploads\/([^/]+)\/download$/.exec(url);
        if (download) {
          const archive = brokerArchives.get(download[1]!);
          if (!archive)
            return Response.json({ error: "missing" }, { status: 409 });
          return new Response(archive.bytes, {
            headers: {
              "content-type": "application/zstd",
              "content-length": String(archive.byteSize),
              "x-content-sha256": archive.sha256,
              "x-gcs-generation": "9007199254740993123",
            },
          });
        }
        if (url.endsWith("/internal/evidence-uploads/reclaim"))
          return Response.json({ state: "complete", bytes_freed: 128 });
        throw new Error(`unexpected sequential reclaim request ${url}`);
      }),
    );
    expect(await processBrokeredRemoteEvidenceReclaims(db, settings, 8)).toBe(
      1,
    );
    expect(
      await db
        .select({ state: syncRemoteHubBindingReceipts.reclaimState })
        .from(syncRemoteHubBindingReceipts)
        .where(eq(syncRemoteHubBindingReceipts.promiseId, promiseId)),
    ).toSatisfy(
      (rows: Array<{ state: string }>) =>
        rows.filter((row) => row.state === "reclaimed").length === 1 &&
        rows.filter((row) => row.state === "pending").length === 1,
    );
    expect(await processBrokeredRemoteEvidenceReclaims(db, settings, 8)).toBe(
      1,
    );
  });

  it("renews a delivery claim that has streamed for more than 30 minutes and rejects a stale settlement token", async () => {
    const job = await seedDoneRemoteJob("long-claim", [850.001]);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("long-claim", [850.001], promiseId);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, job.id));
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, result.id));
    const claim = await claimResultDelivery(
      db,
      promiseId,
      job,
      result,
      attempt,
    );
    expect(claim).not.toBeNull();
    expect(claim!.fulfilledReplay).toBe(false);
    await db
      .update(syncRemoteResultDeliveries)
      .set({
        claimedAt: new Date(Date.now() - 35 * 60_000),
        claimExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(syncRemoteResultDeliveries.id, claim!.id));
    await renewResultDeliveryClaim(db, claim!);
    const [renewed] = await db
      .select()
      .from(syncRemoteResultDeliveries)
      .where(eq(syncRemoteResultDeliveries.id, claim!.id));
    expect(renewed.claimedAt!.getTime()).toBeLessThan(Date.now() - 30 * 60_000);
    expect(renewed.claimExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    await settleResultDelivery(db, claim!, { kind: "delivered" });

    await db
      .update(syncSweepPromises)
      .set({ status: "fulfilled", fulfilledAt: new Date() })
      .where(eq(syncSweepPromises.id, promiseId));
    await db
      .update(syncSweepPromisePoints)
      .set({
        status: "fulfilled",
        resultId: result.id,
        resultAttemptId: attempt.id,
      })
      .where(eq(syncSweepPromisePoints.promiseId, promiseId));

    await db
      .update(syncRemoteResultDeliveries)
      .set({
        state: "pending",
        claimToken: null,
        claimedAt: null,
        claimExpiresAt: null,
        deliveredAt: null,
      })
      .where(eq(syncRemoteResultDeliveries.id, claim!.id));
    const staleClaim = await claimResultDelivery(
      db,
      promiseId,
      job,
      result,
      attempt,
    );
    expect(staleClaim).not.toBeNull();
    expect(staleClaim!.fulfilledReplay).toBe(true);
    const replacementToken = randomUUID();
    await db
      .update(syncRemoteResultDeliveries)
      .set({ claimToken: replacementToken })
      .where(eq(syncRemoteResultDeliveries.id, staleClaim!.id));
    await expect(
      settleResultDelivery(db, staleClaim!, { kind: "delivered" }),
    ).rejects.toThrow("expired or changed before settlement");
    expect(
      (
        await db
          .select()
          .from(syncRemoteResultDeliveries)
          .where(eq(syncRemoteResultDeliveries.id, staleClaim!.id))
      )[0],
    ).toMatchObject({ state: "pushing", claimToken: replacementToken });
  });

  it("keeps transient promise-heartbeat failures retryable but cancels engine work on authoritative 404/409 lease loss", async () => {
    const seedLease = async (label: string, aoa: number) => {
      const promise = await seedMirroredPromise(label, [aoa]);
      await db
        .update(syncSweepPromises)
        .set({
          expiresAt: new Date(Date.now() + 1_000),
          lastHeartbeatAt: new Date(Date.now() - 3_600_000),
        })
        .where(eq(syncSweepPromises.id, promise.id));
      const [job] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [bcId],
          simulationPresetRevisionId: revisionId,
          referenceChordM: CHORD,
          wave: 2,
          status: "running",
          engineJobId: `${PREFIX}-${label}-engine`,
          totalCases: 1,
          completedCases: 0,
          requestPayload: {
            syncPromiseId: promise.id,
            remoteSolver: true,
            upstreamBaseUrl: UPSTREAM,
          },
        })
        .returning();
      return { promise, job };
    };

    const transient = await seedLease("heartbeat-transient", 851.001);
    const transientCancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        if (String(input).includes(`/sweeps/${transient.promise.id}/heartbeat`))
          throw new Error("temporary route timeout");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    await remoteSolverTick(db, {
      cancelJob: transientCancel,
    } as unknown as EngineClient);
    expect((await readPromise(transient.promise.id)).promise.status).toBe(
      "active",
    );
    expect(
      (
        await db.select().from(simJobs).where(eq(simJobs.id, transient.job.id))
      )[0].status,
    ).toBe("running");
    expect(transientCancel).not.toHaveBeenCalled();

    for (const [status, aoa] of [
      [404, 852.001],
      [409, 853.001],
    ] as const) {
      vi.unstubAllGlobals();
      await cleanupRemoteRows();
      await configureRemoteSolver();
      const authoritative = await seedLease(`heartbeat-${status}`, aoa);
      const cancelJob = vi.fn(async () => undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) => {
          if (
            String(input).includes(
              `/sweeps/${authoritative.promise.id}/heartbeat`,
            )
          )
            return new Response(JSON.stringify({ error: "lease lost" }), {
              status,
            });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }),
      );
      await remoteSolverTick(db, { cancelJob } as unknown as EngineClient);
      expect(cancelJob).toHaveBeenCalledWith(authoritative.job.engineJobId);
      expect((await readPromise(authoritative.promise.id)).promise.status).toBe(
        "cancelled",
      );
      expect(
        (
          await db
            .select()
            .from(simJobs)
            .where(eq(simJobs.id, authoritative.job.id))
        )[0],
      ).toMatchObject({ status: "cancelled", engineState: "cancelled" });
    }
  });

  it("retries promoted conflicts but retires archived conflicts without re-push", async () => {
    const aoa = 854.001;
    const job = await seedDoneRemoteJob("conflict-reopen", [aoa]);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("conflict-reopen", [aoa], promiseId);
    const conflictId = randomUUID();
    const blockedFetch = stubFetch({
      conflictIdsByPolarIndex: { 1: [conflictId] },
    });

    await remoteSolverTick(db, {} as never);

    expect(requests(blockedFetch.fetchMock, "/polars")).toHaveLength(1);
    expect(
      (await deliveriesForJob(job.id)).find((row) => row.resultId),
    ).toMatchObject({
      state: "blocked",
      remoteConflictIds: [conflictId],
    });

    vi.unstubAllGlobals();
    const unresolvedFetch = stubFetch({
      conflictStatuses: { [conflictId]: "pending" },
    });
    await remoteSolverTick(db, {} as never);
    expect(requests(unresolvedFetch.fetchMock, "/polars")).toHaveLength(0);
    expect(
      (await deliveriesForJob(job.id)).find((row) => row.resultId)?.state,
    ).toBe("blocked");

    await db
      .update(syncRemoteResultDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(syncRemoteResultDeliveries.simJobId, job.id));

    vi.unstubAllGlobals();
    const resolvedFetch = stubFetch({
      conflictStatuses: { [conflictId]: "archived" },
    });
    await remoteSolverTick(db, {} as never);
    expect(requests(resolvedFetch.fetchMock, "/polars")).toHaveLength(0);
    expect(
      (await deliveriesForJob(job.id)).find((row) => row.resultId)?.state,
    ).toBe("superseded");
    expect((await readPromise(promiseId)).points[0]?.status).toBe("cancelled");
  });

  it("uses deterministic promise-scoped keys when one delivery advances generations", async () => {
    const aoas = [855.201, 855.202];
    const job = await seedDoneRemoteJob("delivery-generation-advance", aoas);
    const promiseId = (job.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("delivery-generation-advance", aoas, promiseId);
    const deliveryFetch = stubFetch();

    await remoteSolverTick(db, {} as never);
    const [result] = await db
      .select()
      .from(results)
      .where(and(eq(results.simJobId, job.id), eq(results.aoaDeg, aoas[0]!)));
    const attemptA = result.currentResultAttemptId!;
    const [deliveryA] = await db
      .select()
      .from(syncRemoteResultDeliveries)
      .where(
        and(
          eq(syncRemoteResultDeliveries.promiseId, promiseId),
          eq(syncRemoteResultDeliveries.resultId, result.id),
        ),
      );
    expect(deliveryA).toMatchObject({
      state: "delivered",
      generationKey: attemptA,
      resultAttemptId: attemptA,
    });

    const caseSlug = "aoa_0_generation_b";
    const [attemptB] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: aoas[0]!,
        simJobId: job.id,
        engineJobId: job.engineJobId,
        engineCaseSlug: caseSlug,
        status: "done",
        source: "solved",
        regime: "urans",
        validForPolar: true,
        cl: 0.61,
        cd: 0.013,
        cm: -0.021,
        clCd: 46.9,
        stalled: false,
        unsteady: true,
        converged: true,
        evidencePayload: { fixture: "delivery-generation-b" },
        solvedAt: new Date(),
      })
      .returning();
    await db
      .update(results)
      .set({
        currentResultAttemptId: attemptB.id,
        engineCaseSlug: caseSlug,
        cl: attemptB.cl,
        cd: attemptB.cd,
        cm: attemptB.cm,
        clCd: attemptB.clCd,
      })
      .where(eq(results.id, result.id));
    await db
      .update(resultClassifications)
      .set({
        resultAttemptId: attemptB.id,
        regime: "urans",
        classifierVersion: "remote-delivery-generation-v1",
        state: "accepted",
        reasons: [],
        updatedAt: new Date(),
      })
      .where(eq(resultClassifications.resultId, result.id));
    const manifest = writeMedia(
      `jobs/${job.engineJobId}/cases/${caseSlug}/manifest.json`,
      "delivery-generation-b:manifest",
    );
    await db.insert(solverEvidenceArtifacts).values({
      resultId: result.id,
      resultAttemptId: attemptB.id,
      airfoilId,
      simJobId: job.id,
      engineJobId: job.engineJobId,
      engineCaseSlug: caseSlug,
      aoaDeg: aoas[0]!,
      kind: "manifest",
      role: "raw",
      storageKey: manifest.storageKey,
      mimeType: "application/json",
      sha256: manifest.sha256,
      byteSize: manifest.byteSize,
      metadata: { fixture: "delivery-generation-b" },
    });
    await seedEngineBundle(
      {
        resultId: result.id,
        resultAttemptId: attemptB.id,
        simJobId: job.id,
        engineJobId: job.engineJobId!,
        engineCaseSlug: caseSlug,
        aoaDeg: aoas[0]!,
      },
      "delivery-generation-b",
    );
    const image = writeMedia(
      `jobs/${job.engineJobId}/cases/${caseSlug}/pressure.png`,
      "delivery-generation-b:pressure",
    );
    await db.insert(resultMedia).values({
      resultId: result.id,
      resultAttemptId: attemptB.id,
      kind: "image",
      field: "pressure_generation_b",
      role: "instantaneous",
      storageKey: image.storageKey,
      mimeType: "image/png",
      width: 4,
      height: 4,
      evidenceSha256: manifest.sha256,
      sha256: image.sha256,
      byteSize: image.byteSize,
    });

    await remoteSolverTick(db, {} as never);

    const brokerRequests = requests(
      deliveryFetch.fetchMock,
      "/evidence-uploads",
    );
    expect(
      brokerRequests.map((request) => request.body.idempotencyKey),
    ).toEqual([
      brokeredEvidenceIdempotencyKey(promiseId, attemptA),
      brokeredEvidenceIdempotencyKey(promiseId, attemptB.id),
    ]);
    const [deliveryB] = await db
      .select()
      .from(syncRemoteResultDeliveries)
      .where(eq(syncRemoteResultDeliveries.id, deliveryA.id));
    expect(deliveryB).toMatchObject({
      state: "delivered",
      generationKey: attemptB.id,
      resultAttemptId: attemptB.id,
    });
  });

  it("does not let more than 250 blocked or not-due jobs starve one ready result delivery", async () => {
    const promiseId = randomUUID();
    const aoas = Array.from({ length: 252 }, (_, index) => 860 + index / 1000);
    await seedMirroredPromise("delivery-fairness", aoas, promiseId);
    const jobs = [];
    for (const [index, aoa] of aoas.entries()) {
      jobs.push(
        await seedDoneRemoteJob(
          `delivery-fairness-${index}`,
          [aoa],
          2,
          promiseId,
        ),
      );
    }
    for (const [index, job] of jobs.slice(0, 251).entries()) {
      const [result] = await db
        .select()
        .from(results)
        .where(eq(results.simJobId, job.id));
      const [attempt] = await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.resultId, result.id));
      await db.insert(syncRemoteResultDeliveries).values({
        promiseId,
        simJobId: job.id,
        resultId: result.id,
        resultAttemptId: attempt.id,
        aoaDeg: result.aoaDeg,
        generationKey: attempt.id,
        state: index % 2 === 0 ? "blocked" : "retry_wait",
        nextAttemptAt: new Date(Date.now() + 3_600_000),
        lastError: "fixture must not be selected",
      });
    }
    const ready = jobs[251];
    const readyFetch = stubFetch();

    await remoteSolverTick(db, {} as never);

    const pushes = requests(readyFetch.fetchMock, "/polars");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].body.results).toMatchObject([{ aoaDeg: aoas[251] }]);
    expect(
      (await deliveriesForJob(ready.id)).find((row) => row.resultId)?.state,
    ).toBe("delivered");
  }, 120_000);

  it("reuses accepted cached evidence for a new promise but releases rejected cached evidence for continuation", async () => {
    const acceptedAoa = 854.101;
    const acceptedJob = await seedDoneRemoteJob("reuse-accepted", [
      acceptedAoa,
    ]);
    await db
      .update(simJobs)
      .set({ requestPayload: { reusableFixture: true } })
      .where(eq(simJobs.id, acceptedJob.id));
    const acceptedPromise = await seedMirroredPromise("reuse-accepted", [
      acceptedAoa,
    ]);
    const acceptedFetch = stubFetch();
    const submitPolar = vi.fn();

    const [reusableReadiness] = (await db.execute(dsql`
      SELECT
        accepted_result.current_result_attempt_id IS NOT NULL AS has_pointer,
        EXISTS (
          SELECT 1 FROM result_classifications classification
          WHERE classification.result_attempt_id = accepted_result.current_result_attempt_id
            AND classification.state = 'accepted'
        ) AS accepted,
        EXISTS (
          SELECT 1 FROM solver_evidence_artifacts manifest
          WHERE manifest.result_id = accepted_result.id
            AND manifest.result_attempt_id = accepted_result.current_result_attempt_id
            AND manifest.kind = 'manifest'
        ) AS has_manifest
      FROM results accepted_result
      WHERE accepted_result.sim_job_id = ${acceptedJob.id}
    `)) as unknown as Array<{
      has_pointer: boolean;
      accepted: boolean;
      has_manifest: boolean;
    }>;
    expect(reusableReadiness).toEqual({
      has_pointer: true,
      accepted: true,
      has_manifest: true,
    });
    const [candidateCount] = (await db.execute(dsql`
      SELECT count(*)::int AS n
      FROM sync_sweep_promises promise
      JOIN sync_sweep_promise_points point
        ON point.promise_id = promise.id AND point.status = 'active'
      JOIN results accepted_result
        ON accepted_result.airfoil_id = point.airfoil_id
       AND accepted_result.simulation_preset_revision_id = point.simulation_preset_revision_id
       AND accepted_result.aoa_deg = point.aoa_deg
       AND accepted_result.status = 'done'
      JOIN sim_jobs accepted_job ON accepted_job.id = accepted_result.sim_job_id
      JOIN result_attempts accepted_attempt
        ON accepted_attempt.id = accepted_result.current_result_attempt_id
       AND accepted_attempt.result_id = accepted_result.id
      JOIN result_classifications classification
        ON classification.result_attempt_id = accepted_attempt.id
       AND classification.state = 'accepted'
      WHERE promise.id = ${acceptedPromise.id}
        AND promise.status = 'active'
        AND promise.source_base_url = ${UPSTREAM}
        AND promise.request_payload ->> 'remoteSolver' = 'true'
    `)) as unknown as Array<{ n: number }>;
    expect(candidateCount?.n).toBe(1);

    await remoteSolverTick(db, { submitPolar } as unknown as EngineClient);

    expect(submitPolar).not.toHaveBeenCalled();
    expect(
      (await deliveriesForJob(acceptedJob.id)).find((row) => row.resultId)
        ?.state,
    ).toBe("delivered");
    expect(requests(acceptedFetch.fetchMock, "/polars")).toHaveLength(1);
    expect((await readPromise(acceptedPromise.id)).points[0].status).toBe(
      "fulfilled",
    );

    vi.unstubAllGlobals();
    await cleanupRemoteRows();
    await configureRemoteSolver();
    const rejectedAoa = 854.201;
    const rejectedJob = await seedDoneRemoteJob("reuse-rejected", [
      rejectedAoa,
    ]);
    await db
      .update(simJobs)
      .set({ requestPayload: { reusableFixture: true } })
      .where(eq(simJobs.id, rejectedJob.id));
    const [rejectedResult] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, rejectedJob.id));
    await db
      .update(resultClassifications)
      .set({ state: "rejected", reasons: ["fixture rejected"] })
      .where(eq(resultClassifications.resultId, rejectedResult.id));
    const rejectedPromise = await seedMirroredPromise("reuse-rejected", [
      rejectedAoa,
    ]);
    stubFetch();
    const continuation = acceptedStatus("reuse-rejected-continuation");
    const submitRejected = vi.fn(async () => continuation);

    await remoteSolverTick(db, {
      submitPolar: submitRejected,
    } as unknown as EngineClient);

    expect(submitRejected).toHaveBeenCalledTimes(1);
    expect(await resultForAoa(rejectedAoa)).toMatchObject({
      status: "queued",
      simJobId: expect.any(String),
    });
    expect((await readPromise(rejectedPromise.id)).points[0].status).toBe(
      "active",
    );
  });

  it("ships only the exact child attempt generation and ignores stale parent artifact, media, and extent rows", async () => {
    const aoa = 855.001;
    const child = await seedDoneRemoteJob("exact-child", [aoa]);
    const promiseId = (child.requestPayload as { syncPromiseId: string })
      .syncPromiseId;
    await seedMirroredPromise("exact-child", [aoa], promiseId);
    const [result] = await db
      .select()
      .from(results)
      .where(eq(results.simJobId, child.id));
    const [childAttempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, result.id));
    const [childManifest] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultAttemptId, childAttempt.id),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      );
    const [parent] = await db
      .insert(simJobs)
      .values({
        airfoilId,
        bcIds: [bcId],
        simulationPresetRevisionId: revisionId,
        referenceChordM: CHORD,
        wave: 1,
        status: "done",
        engineJobId: `${PREFIX}-exact-parent`,
        totalCases: 1,
        completedCases: 1,
        finishedAt: new Date(),
      })
      .returning();
    await db
      .update(simJobs)
      .set({ parentJobId: parent.id })
      .where(eq(simJobs.id, child.id));
    const [parentAttempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: result.id,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: aoa,
        simJobId: parent.id,
        engineJobId: parent.engineJobId,
        engineCaseSlug: "stale_parent_case",
        status: "done",
        source: "solved",
        regime: "rans",
        validForPolar: true,
        cl: result.cl,
        cd: result.cd,
        cm: result.cm,
        solvedAt: new Date(),
      })
      .returning();
    const staleManifest = writeMedia(
      `jobs/${parent.engineJobId}/stale-parent-manifest.json`,
      "stale-parent-manifest",
    );
    await db.insert(solverEvidenceArtifacts).values({
      resultId: result.id,
      resultAttemptId: parentAttempt.id,
      airfoilId,
      simJobId: parent.id,
      engineJobId: parent.engineJobId,
      engineCaseSlug: "stale_parent_case",
      aoaDeg: aoa,
      kind: "manifest",
      role: "raw",
      storageKey: staleManifest.storageKey,
      mimeType: "application/json",
      sha256: staleManifest.sha256,
      byteSize: staleManifest.byteSize,
      metadata: { generation: "stale-parent" },
    });
    const staleMedia = writeMedia(
      `jobs/${parent.engineJobId}/stale-parent.png`,
      "stale-parent-media",
    );
    await db.insert(resultMedia).values({
      resultId: result.id,
      resultAttemptId: parentAttempt.id,
      kind: "image",
      field: "stale_parent_field",
      role: "instantaneous",
      storageKey: staleMedia.storageKey,
      mimeType: "image/png",
      evidenceSha256: staleManifest.sha256,
      sha256: staleMedia.sha256,
      byteSize: staleMedia.byteSize,
    });
    await db.insert(resultFieldExtents).values([
      {
        resultId: result.id,
        resultAttemptId: childAttempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        field: "pressure_0",
        vmin: 0,
        vmax: 1,
        finiteCount: 10,
        evidenceSha256: childManifest.sha256,
      },
      {
        resultId: result.id,
        resultAttemptId: parentAttempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        field: "stale_parent_field",
        vmin: -9,
        vmax: 9,
        finiteCount: 99,
        evidenceSha256: staleManifest.sha256,
      },
    ]);
    const fetch = stubFetch();

    await remoteSolverTick(db, {} as never);

    const [polar] = requests(fetch.fetchMock, "/polars");
    expect(polar.body.results[0].evidenceArtifacts).toHaveLength(2);
    expect(
      polar.body.results[0].evidenceArtifacts.find(
        (artifact: { kind: string }) => artifact.kind === "manifest",
      ).sha256,
    ).toBe(childManifest.sha256);
    expect(
      polar.body.results[0].evidenceArtifacts.some(
        (artifact: { sha256: string }) =>
          artifact.sha256 === staleManifest.sha256,
      ),
    ).toBe(false);
    expect(polar.body.results[0].media).toHaveLength(1);
    expect(polar.body.results[0].media[0].field).not.toBe("stale_parent_field");
    expect(polar.body.results[0].fieldExtents).toMatchObject([
      { field: "pressure_0", evidenceSha256: childManifest.sha256 },
    ]);
  });

  it("rejects changed local artifact association metadata while allowing identical bytes for another owner", async () => {
    const first = await seedDoneRemoteJob("local-association-a", [856.001]);
    const second = await seedDoneRemoteJob("local-association-b", [856.002]);
    const readOwner = async (jobId: string) => {
      const [result] = await db
        .select()
        .from(results)
        .where(eq(results.simJobId, jobId));
      const [attempt] = await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.resultId, result.id));
      return { result, attempt };
    };
    const ownerA = await readOwner(first.id);
    const ownerB = await readOwner(second.id);
    const bytes = Buffer.from(`${PREFIX}:shared-local-association`);
    const artifact = {
      kind: "log",
      role: "raw",
      path: "/shared/exact-association.log",
      mime_type: "text/plain",
      sha256: sha256(bytes),
      byte_size: bytes.byteLength,
      metadata: { immutable: "v1" },
    };
    const engine = { baseUrl: "http://engine.test" } as EngineClient;
    const register = async (
      job: typeof simJobs.$inferSelect,
      owner: {
        result: typeof results.$inferSelect;
        attempt: typeof resultAttempts.$inferSelect;
      },
      metadata: Record<string, unknown>,
    ) =>
      registerEvidenceArtifacts({
        db,
        engine,
        resultId: owner.result.id,
        resultAttemptId: owner.attempt.id,
        airfoilId,
        simJobId: job.id,
        engineJobId: job.engineJobId!,
        point: {
          aoa_deg: owner.result.aoaDeg,
          case_slug: owner.result.engineCaseSlug,
        } as never,
        artifact: { ...artifact, metadata } as never,
      });

    await register(first, ownerA, { immutable: "v1" });
    await expect(
      register(first, ownerA, { immutable: "changed" }),
    ).rejects.toThrow("changed immutable association metadata");
    await register(second, ownerB, { immutable: "v1" });

    const associations = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.sha256, artifact.sha256));
    expect(associations).toHaveLength(2);
    expect(new Set(associations.map((row) => row.resultAttemptId))).toEqual(
      new Set([ownerA.attempt.id, ownerB.attempt.id]),
    );
  });

  it.each(["running", "ingesting"] as const)(
    "pushes incrementally ingested evidence while the producing job is still %s",
    async (status) => {
      const aoa = status === "running" ? 857.001 : 858.001;
      const job = await seedDoneRemoteJob(`partial-${status}`, [aoa]);
      const promiseId = (job.requestPayload as { syncPromiseId: string })
        .syncPromiseId;
      await seedMirroredPromise(`partial-${status}`, [aoa], promiseId);
      await db
        .update(simJobs)
        .set({
          status,
          completedCases: 1,
          totalCases: 3,
          finishedAt: null,
        })
        .where(eq(simJobs.id, job.id));
      const fetch = stubFetch();

      await remoteSolverTick(db, {} as never);

      expect(requests(fetch.fetchMock, "/polars")).toHaveLength(1);
      expect(
        (await deliveriesForJob(job.id)).find((row) => row.resultId)?.state,
      ).toBe("delivered");
      expect(
        (await db.select().from(simJobs).where(eq(simJobs.id, job.id)))[0]
          .status,
      ).toBe(status);
    },
  );
});
