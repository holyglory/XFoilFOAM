import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";

const statfsControl = vi.hoisted(() => ({
  availableBytes: null as bigint | null,
  paths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    statfs: async (...args: unknown[]) => {
      statfsControl.paths.push(String(args[0]));
      if (statfsControl.availableBytes == null) {
        return (actual.statfs as (...input: unknown[]) => unknown)(...args);
      }
      return { bavail: statfsControl.availableBytes, bsize: 1n };
    },
  };
});

const MEDIA_DIR = join(
  tmpdir(),
  `xff-api-sync-${process.pid}-${Date.now().toString(36)}`,
);
mkdirSync(MEDIA_DIR, { recursive: true });
process.env.MEDIA_DIR = MEDIA_DIR;
const TEST_MULTIPART_UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024;
const TEST_MULTIPART_MANIFEST_LIMIT_BYTES = 2 * 1024 * 1024;
const savedMultipartUploadLimit =
  process.env.SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES;
const savedMultipartManifestLimit =
  process.env.SYNC_POLAR_MULTIPART_MAX_MANIFEST_BYTES;
process.env.SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES = String(
  TEST_MULTIPART_UPLOAD_LIMIT_BYTES,
);
process.env.SYNC_POLAR_MULTIPART_MAX_MANIFEST_BYTES = String(
  TEST_MULTIPART_MANIFEST_LIMIT_BYTES,
);

const dbSchema = await import("@aerodb/db");
const {
  ensureSimulationPresetRevision,
  flowConditionCanonicalKey,
  referenceGeometryCanonicalKey,
} = await import("@aerodb/db/simulation-setup");
const { advisoryLockSql, db, sql } = await import("../src/db");
const { buildServer } = await import("../src/server");
const { assertMultipartDiskReserveAvailableBytes } =
  await import("../src/sync-routes");
const { createExactResultAttemptFixture } =
  await import("./exact-result-fixture");

const {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  fieldColorScales,
  flowConditions,
  forceHistory,
  mediums,
  meshProfiles,
  outputProfiles,
  polarFitSets,
  referenceGeometryProfiles,
  remoteAssetReferences,
  resultAttempts,
  resultClassifications,
  resultMedia,
  results,
  schedulingProfiles,
  simCampaignConditions,
  simCampaignLanes,
  simCampaignPoints,
  simCampaignProgress,
  simCampaigns,
  simJobs,
  simPrecalcObligationCampaigns,
  simPrecalcObligations,
  simResultSubmitRetries,
  simulationPresetRevisions,
  simulationPresetAirfoilTargets,
  simulationPresets,
  solverEvidenceArtifacts,
  solverProfiles,
  solverRuntimeBuilds,
  syncApiPermissions,
  syncApiSettings,
  syncImportConflicts,
  syncRemotePromiseCancellations,
  syncSweepPromisePoints,
  syncSweepPromises,
  sweepDefinitions,
} = dbSchema;

const PREFIX = `sync-remote-validation-${process.pid}-${Date.now().toString(36)}`;
const CAMPAIGN_PHYSICAL_DISCRIMINATOR =
  Number.parseInt(
    createHash("sha256").update(PREFIX).digest("hex").slice(0, 12),
    16,
  ) / 0xffffffffffff;
const SECRET = `${PREFIX}-secret`;
const SYNC_TYPES = [
  "sweeps",
  "airfoils",
  "catalog_metadata",
  "mediums",
  "simulation_setup",
  "polars",
  "evidence_artifacts",
  "result_media",
] as const;
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
const TEST_EXPECTED_ENGINE = {
  key: "openfoam:opencfd:2606:rans-urans:1",
  family: "openfoam",
  distribution: "opencfd",
  releaseVersion: "2606",
  methodFamily: "rans-urans",
  numericsRevision: "1",
  adapterContractVersion: 1,
};
const TEST_MATCHING_RUNTIME = {
  family: "openfoam",
  distribution: "opencfd",
  version: "2606",
  numericsRevision: "1",
  adapterContractVersion: 1,
  buildId: `${PREFIX}-matching-opencfd-2606`,
};
const TERMINAL_GAP_AOA = 739.101;
const TERMINAL_ACCEPTED_AOA = 739.102;
const CANCELLED_GAP_AOA = 739.201;
const CAMPAIGN_FALLBACK_AOA = 739.301;
const profileIds = {
  boundary: "",
  mesh: "",
  solver: "",
  scheduling: "",
  output: "",
  sweep: "",
};
const cleanupPromiseIds = new Set<string>();
const cleanupConflictIds = new Set<string>();
const cleanupRuntimeBuildIds = new Set<string>();
const cleanupCampaignIds: string[] = [];

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function deleteIds(table: any, column: any, ids: string[]) {
  if (ids.length) await db.delete(table).where(inArray(column, ids));
}

async function configureSync() {
  await db.insert(syncApiSettings).values({ id: 1 }).onConflictDoNothing();
  const [settings] = await db
    .select()
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1))
    .limit(1);
  savedSettings = settings ?? null;
  savedPermissions = await db.select().from(syncApiPermissions);
  await db
    .update(syncApiSettings)
    .set({
      enabled: true,
      secret: SECRET,
      defaultPromiseTtlHours: 24,
      updatedAt: new Date(),
    })
    .where(eq(syncApiSettings.id, 1));
  for (const dataType of SYNC_TYPES) {
    await db
      .insert(syncApiPermissions)
      .values({ dataType, canFetch: true, canPush: true })
      .onConflictDoUpdate({
        target: syncApiPermissions.dataType,
        set: { canFetch: true, canPush: true, updatedAt: new Date() },
      });
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
  if (savedPermissions.length)
    await db.insert(syncApiPermissions).values(savedPermissions);
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
  const [air] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, "air"))
    .limit(1);
  if (!air) throw new Error("seeded air medium required");
  mediumId = air.id;
  // Keep this fixture first in the claim queue without mutating any unrelated
  // shared-DB preset: the claim route sorts by Reynolds before airfoil slug.
  speed = 0.00004;
  kinematicViscosity = air.kinematicViscosity;
  reynolds = Math.round((speed * CHORD) / air.kinematicViscosity);
  mach = air.speedOfSound ? speed / air.speedOfSound : null;

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
      slug: `000-${PREFIX}-foil`,
      name: `${PREFIX} foil`,
      categoryId,
      points: contour,
      pointFormat: "normalized",
      isSymmetric: false,
    })
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
      aoaList: [
        TERMINAL_GAP_AOA,
        TERMINAL_ACCEPTED_AOA,
        CANCELLED_GAP_AOA,
        CAMPAIGN_FALLBACK_AOA,
      ],
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
      legacyBoundaryConditionId: legacyBcId,
      targetScope: "airfoils",
      enabled: false,
    })
    .returning({ id: simulationPresets.id });
  presetId = preset.id;
  await db.insert(simulationPresetAirfoilTargets).values({
    presetId,
    airfoilId,
  });
  await db
    .update(simulationPresets)
    .set({ enabled: true, updatedAt: new Date() })
    .where(eq(simulationPresets.id, presetId));
  const resolved = await ensureSimulationPresetRevision(db, presetId);
  if (!resolved) throw new Error("simulation preset revision required");
  revisionId = resolved.revision.id;
  revisionSignatureHash = resolved.revision.signatureHash;
  await db
    .update(simulationPresets)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(simulationPresets.id, presetId));
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

function videoItem(label: string) {
  return {
    kind: "video",
    field: `pressure_${label.replace(/[^a-z0-9]+/gi, "_")}`,
    role: "instantaneous",
    width: 8,
    height: 8,
    frameCount: 80,
    durationS: 4,
    renderProfileKey: "default:v1:zoom2",
    ...bytesItem(`video:${label}`, "video/mp4"),
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
  const point = {
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
    evidenceArtifacts: [artifactItem(`default-manifest-${aoaDeg}`)],
    media: [],
    ...patch,
  } as Record<string, unknown>;
  const artifacts = Array.isArray(point.evidenceArtifacts)
    ? (point.evidenceArtifacts as Array<Record<string, unknown>>)
    : [];
  const manifest = artifacts.find((item) => item.kind === "manifest");
  const manifestSha = manifest?.sha256;
  if (typeof manifestSha === "string") {
    point.media = (Array.isArray(point.media) ? point.media : []).map(
      (item: Record<string, unknown>) => ({
        ...item,
        evidenceSha256:
          item.evidenceSha256 ?? item.evidence_sha256 ?? manifestSha,
      }),
    );
    point.fieldExtents = (
      Array.isArray(point.fieldExtents) ? point.fieldExtents : []
    ).map((item: Record<string, unknown>) => ({
      ...item,
      evidenceSha256:
        item.evidenceSha256 ?? item.evidence_sha256 ?? manifestSha,
    }));
  }
  return point;
}

function uransEvidencePatch(label: string, qualityWarnings: string[] = []) {
  return {
    regime: "urans",
    fidelity: "urans_precalc",
    stalled: true,
    unsteady: true,
    converged: true,
    clStd: 0.021,
    cdStd: 0.0012,
    cmStd: 0.004,
    nCells: 123_456,
    qualityWarnings,
    frameTrack: {
      stationary: true,
      periods_retained: 3.5,
      selected_frame_count: 80,
      contract: `${label}-frame-track`,
    },
    steadyHistory: {
      iterations: [100, 200, 300],
      cl: [0.4, 0.41, 0.405],
      cd: [0.02, 0.021, 0.0205],
      cm: [-0.02, -0.021, -0.0205],
      window: { start_iter: 100, end_iter: 300 },
      mean_stable: true,
      note: `${label}-steady-history`,
    },
    forceHistory: {
      t: [0, 1, 2, 3, 4],
      cl: [0.4, 0.5, 0.4, 0.5, 0.4],
      cd: [0.02, 0.03, 0.02, 0.03, 0.02],
      cm: [-0.02, -0.03, -0.02, -0.03, -0.02],
      clMean: 0.45,
      clRms: 0.05,
      cdMean: 0.025,
      cdRms: 0.005,
      strouhal: 0.18,
      sheddingFreqHz: 4.2,
      sampleCount: 5,
    },
    media: [videoItem(label)],
  };
}

function polarPayload(
  resultsPayload: unknown[],
  patch: Record<string, unknown> = {},
) {
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

type MultipartTestPart =
  | { type: "field"; fieldName: string; value: string }
  | {
      type: "file";
      fieldName: string;
      filename: string;
      mimeType: string;
      bytes: Buffer;
    };

function multipartFilePart(
  fieldName: string,
  bytes: Buffer,
  mimeType = "application/json",
): MultipartTestPart {
  return {
    type: "file",
    fieldName,
    filename: `${fieldName}.bin`,
    mimeType,
    bytes,
  };
}

function multipartManifestPart(value: unknown): MultipartTestPart {
  return {
    type: "field",
    fieldName: "manifest",
    value: typeof value === "string" ? value : JSON.stringify(value),
  };
}

async function postMultipartPolars(parts: MultipartTestPart[]) {
  const boundary = `sync-test-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part.type === "field") {
      chunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${part.fieldName}"\r\nContent-Type: application/json\r\n\r\n${part.value}\r\n`,
        ),
      );
      continue;
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.fieldName}"; filename="${part.filename}"\r\nContent-Type: ${part.mimeType}\r\n\r\n`,
      ),
      part.bytes,
      Buffer.from("\r\n"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return app.inject({
    method: "POST",
    url: "/api/sync/v1/polars",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "x-xfoilfoam-sync-secret": SECRET,
    },
    payload: Buffer.concat(chunks),
  });
}

function multipartArtifact(
  fieldName: string,
  bytes: Buffer,
  index: number,
): Record<string, unknown> {
  return {
    kind: index === 0 ? "manifest" : "field_data",
    field: index === 0 ? null : `multipart_file_${index}`,
    role: index === 0 ? "exact-attempt" : "raw",
    filename: `${fieldName}.json`,
    mimeType: "application/json",
    uploadField: fieldName,
    sha256: sha256(bytes),
    byteSize: bytes.byteLength,
  };
}

function mediaFilePaths(root = MEDIA_DIR, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  const paths: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    const full = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...mediaFilePaths(full, relative));
    else paths.push(relative);
  }
  return paths.sort();
}

async function expectMultipartFailureCleansFiles(opts: {
  parts: MultipartTestPart[];
  aoaDeg?: number;
  statusCode?: number;
  error?: RegExp;
  unreferencedSha256?: string;
}) {
  const before = mediaFilePaths();
  const response = await postMultipartPolars(opts.parts);
  if (opts.statusCode != null)
    expect(response.statusCode, response.body).toBe(opts.statusCode);
  else expect(response.statusCode).toBeGreaterThanOrEqual(400);
  if (opts.error) {
    const error = response.json().error;
    expect(typeof error === "string" ? error : JSON.stringify(error)).toMatch(
      opts.error,
    );
  }
  if (opts.unreferencedSha256) {
    expect(
      await db
        .select({ id: solverEvidenceArtifacts.id })
        .from(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.sha256, opts.unreferencedSha256)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: resultMedia.id })
        .from(resultMedia)
        .where(eq(resultMedia.sha256, opts.unreferencedSha256)),
    ).toHaveLength(0);
  }
  expect(mediaFilePaths()).toEqual(before);
  if (opts.aoaDeg != null) expect(await resultAt(opts.aoaDeg)).toBeNull();
  return response;
}

async function resultAt(aoaDeg: number) {
  const [row] = await db
    .select()
    .from(results)
    .where(
      and(
        eq(results.airfoilId, airfoilId),
        eq(results.simulationPresetRevisionId, revisionId),
        eq(results.aoaDeg, aoaDeg),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function createSelectedRemoteAssetGeneration(
  aoaDeg: number,
  label: string,
  pointPatch: Record<string, unknown> = {},
) {
  const remoteResultId = `${PREFIX}-${label}-remote-result`;
  const imported = await postPolars(
    polarPayload([
      makePoint(aoaDeg, {
        ...pointPatch,
        engineJobId: remoteResultId,
        evidenceArtifacts: [artifactItem(`${label}-manifest`)],
      }),
    ]),
  );
  expect(imported.statusCode, imported.body).toBe(200);
  const result = await resultAt(aoaDeg);
  if (!result?.currentResultAttemptId) {
    throw new Error(`selected remote generation missing at aoa ${aoaDeg}`);
  }
  const manifests = await db
    .select()
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, result.id),
        eq(
          solverEvidenceArtifacts.resultAttemptId,
          result.currentResultAttemptId,
        ),
        eq(solverEvidenceArtifacts.kind, "manifest"),
      ),
    );
  expect(manifests).toHaveLength(1);
  return { remoteResultId, result, manifest: manifests[0] };
}

async function runUpstreamEvidenceExport(
  data: Record<string, unknown>,
  mode: "full" | "db_only_remote_assets" = "full",
) {
  const [settingsBefore] = await db
    .select()
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1))
    .limit(1);
  if (!settingsBefore) throw new Error("sync settings fixture missing");
  const upstreamBaseUrl = "https://upstream.example.test/api/sync/v1";
  await db
    .update(syncApiSettings)
    .set({
      upstreamBaseUrl,
      upstreamSecret: `${PREFIX}-upstream-secret`,
      updatedAt: new Date(),
    })
    .where(eq(syncApiSettings.id, 1));
  const beforeFiles = mediaFilePaths();
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === `${upstreamBaseUrl}/status`) {
      return new Response(
        JSON.stringify({
          instanceId: `${PREFIX}-source`,
          instanceName: "remote validation test",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.startsWith(`${upstreamBaseUrl}/export?`)) {
      return new Response(
        JSON.stringify({
          items: [{ type: "evidence_artifacts", data }],
          nextCursor: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("unexpected asset download", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/sync/upstream/run",
      headers: {
        "content-type": "application/json",
        "x-xfoilfoam-sync-secret": SECRET,
      },
      payload: JSON.stringify({
        mode,
        types: ["evidence_artifacts"],
        limit: 25,
      }),
    });
    return {
      response,
      urls: fetchMock.mock.calls.map(([input]) => String(input)),
      beforeFiles,
    };
  } finally {
    vi.unstubAllGlobals();
    const { id: _id, createdAt: _createdAt, ...restore } = settingsBefore;
    await db
      .update(syncApiSettings)
      .set({ ...restore, updatedAt: new Date() })
      .where(eq(syncApiSettings.id, 1));
  }
}

async function createPromise(
  status: "active" | "fulfilled" | "cancelled",
  aoas: number | number[],
) {
  const aoaList = Array.isArray(aoas) ? aoas : [aoas];
  const [promise] = await db
    .insert(syncSweepPromises)
    .values({
      sourceInstanceId: `${PREFIX}-source`,
      sourceInstanceName: "remote validation test",
      status,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaCount: aoaList.length,
      expiresAt: new Date(Date.now() + 3600_000),
      fulfilledAt: status === "fulfilled" ? new Date() : null,
      cancelledAt: status === "cancelled" ? new Date() : null,
    })
    .returning({ id: syncSweepPromises.id });
  cleanupPromiseIds.add(promise.id);
  await db.insert(syncSweepPromisePoints).values(
    aoaList.map((aoaDeg) => ({
      promiseId: promise.id,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      status,
    })),
  );
  return promise.id;
}

async function readPromise(promiseId: string) {
  const [promise] = await db
    .select()
    .from(syncSweepPromises)
    .where(eq(syncSweepPromises.id, promiseId))
    .limit(1);
  const points = await db
    .select()
    .from(syncSweepPromisePoints)
    .where(eq(syncSweepPromisePoints.promiseId, promiseId))
    .orderBy(syncSweepPromisePoints.aoaDeg);
  return { promise, points };
}

let campaignFixtureSequence = 0;

async function createCampaignCompatiblePublicPreset(
  label: string,
  aoas: number[],
) {
  const sequence = ++campaignFixtureSequence;
  const speedMps =
    0.137 + CAMPAIGN_PHYSICAL_DISCRIMINATOR * 10 + sequence * 0.01;
  const chordM =
    0.641 + CAMPAIGN_PHYSICAL_DISCRIMINATOR * 0.1 + sequence * 0.0001;
  const [medium] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.id, mediumId))
    .limit(1);
  if (!medium) throw new Error("campaign fixture medium required");
  const fixtureSlug = `campaign-${PREFIX.toLowerCase()}-${label}-${sequence}`;
  const localMach = medium.speedOfSound ? speedMps / medium.speedOfSound : null;
  const localReynolds = Math.round(
    (speedMps * chordM) / medium.kinematicViscosity,
  );
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${fixtureSlug}-flow`,
      name: `${PREFIX} ${label} flow`,
      mediumId,
      temperatureK: 288.15,
      pressurePa: 101325,
      speedMps,
      density: medium.density,
      dynamicViscosity: medium.dynamicViscosity,
      kinematicViscosity: medium.kinematicViscosity,
      mach: localMach,
      origin: "campaign",
      canonicalKey: flowConditionCanonicalKey({
        mediumId,
        temperatureK: 288.15,
        pressurePa: 101325,
        speedMps,
      }),
    })
    .returning();
  const [reference] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${fixtureSlug}-reference`,
      name: `${PREFIX} ${label} reference`,
      geometryType: "airfoil_2d",
      referenceLengthKind: "chord",
      referenceLengthM: chordM,
      spanM: 1,
      referenceAreaM2: null,
      origin: "campaign",
      canonicalKey: referenceGeometryCanonicalKey({
        geometryType: "airfoil_2d",
        referenceLengthKind: "chord",
        referenceLengthM: chordM,
        spanM: 1,
        referenceAreaM2: null,
      }),
    })
    .returning();
  const [legacy] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${fixtureSlug}-legacy`,
      name: `${PREFIX} ${label} legacy bridge`,
      mediumId,
      reynolds: localReynolds,
      referenceChordM: chordM,
      temperatureK: 288.15,
      pressurePa: 101325,
      speedMps,
      density: medium.density,
      dynamicViscosity: medium.dynamicViscosity,
      kinematicViscosity: medium.kinematicViscosity,
      mach: localMach,
      enabled: true,
    })
    .returning();
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${fixtureSlug}-sweep`,
      name: `${PREFIX} ${label} sweep`,
      aoaList: aoas,
    })
    .returning();
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${fixtureSlug}-preset`,
      name: `${PREFIX} ${label} public preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: reference.id,
      boundaryProfileId: profileIds.boundary,
      meshProfileId: profileIds.mesh,
      solverProfileId: profileIds.solver,
      schedulingProfileId: profileIds.scheduling,
      outputProfileId: profileIds.output,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: legacy.id,
      targetScope: "airfoils",
      origin: "campaign",
      enabled: true,
    })
    .returning();
  await db.insert(simulationPresetAirfoilTargets).values({
    presetId: preset.id,
    airfoilId,
  });
  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  if (!resolved) throw new Error("campaign-compatible revision required");
  // This branch predates the schema-level engine field. Remote campaign
  // promises nevertheless need the same immutable identity as production,
  // so make that fixture contract explicit.
  await db
    .update(simulationPresetRevisions)
    .set({
      snapshot: {
        ...(resolved.revision.snapshot as Record<string, unknown>),
        engine: TEST_EXPECTED_ENGINE,
      },
    })
    .where(eq(simulationPresetRevisions.id, resolved.revision.id));
  return {
    presetId: preset.id,
    revisionId: resolved.revision.id,
    speedMps,
    chordM,
  };
}

type RemoteCampaignCondition = {
  id: string;
  revisionId: string;
  signatureHash: string;
  presetId: string;
  bcId: string;
  snapshot: Record<string, any>;
  reynolds: number;
};

async function launchRemoteCampaign(
  label: string,
  aoas: number[],
  options: {
    priority?: number;
    speedCount?: number;
    speedMps?: number;
    chordM?: number;
    objectivesEnabled?: boolean;
  } = {},
) {
  const sequence = ++campaignFixtureSequence;
  const speedCount = options.speedCount ?? 1;
  const speeds = Array.from(
    { length: speedCount },
    (_, index) =>
      (options.speedMps ??
        0.337 + CAMPAIGN_PHYSICAL_DISCRIMINATOR * 10 + sequence * 0.02) +
      index * 0.001,
  );
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/campaigns",
    payload: {
      name: `${PREFIX} ${label}`,
      priority: options.priority ?? 9,
      idempotencyKey: `${PREFIX}-${label}-${sequence}`,
      airfoilIds: [airfoilId],
      plan: {
        mediumId,
        ambients: [[288.15, 101325]],
        speedsMps: speeds,
        chordsM: [
          options.chordM ??
            0.731 + CAMPAIGN_PHYSICAL_DISCRIMINATOR * 0.1 + sequence * 0.0001,
        ],
        spanM: 1,
        areaMode: "derived",
        excludedConditions: [],
        baseSweep: {
          fromDeg: null,
          toDeg: null,
          stepDeg: null,
          listDeg: aoas,
        },
        objectives: {
          ldMax: {
            enabled: options.objectivesEnabled ?? false,
            toleranceDeg: 0.1,
            maxRounds: 2,
          },
          clZero: {
            enabled: options.objectivesEnabled ?? false,
            toleranceDeg: 0.05,
            maxRounds: 2,
          },
          clMax: {
            enabled: options.objectivesEnabled ?? false,
            toleranceDeg: 0.1,
            maxRounds: 2,
          },
        },
        numerics: {
          boundaryProfileId: profileIds.boundary,
          meshProfileId: profileIds.mesh,
          solverProfileId: profileIds.solver,
          outputProfileId: profileIds.output,
        },
      },
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const campaignId = response.json().campaign.id as string;
  cleanupCampaignIds.push(campaignId);
  const conditions = (await db.execute(drizzleSql`
    SELECT condition.id,
           condition.simulation_preset_revision_id AS revision_id,
           revision.signature_hash,
           condition.preset_id,
           preset.legacy_boundary_condition_id AS bc_id,
           revision.snapshot,
           condition.reynolds
    FROM sim_campaign_conditions condition
    JOIN simulation_presets preset ON preset.id = condition.preset_id
    JOIN simulation_preset_revisions revision
      ON revision.id = condition.simulation_preset_revision_id
    WHERE condition.campaign_id = ${campaignId}
    ORDER BY condition.reynolds, condition.id
  `)) as unknown as Array<{
    id: string;
    revision_id: string;
    signature_hash: string;
    preset_id: string;
    bc_id: string;
    snapshot: Record<string, any>;
    reynolds: number;
  }>;
  return {
    campaignId,
    conditions: conditions.map(
      (condition): RemoteCampaignCondition => ({
        id: condition.id,
        revisionId: condition.revision_id,
        signatureHash: condition.signature_hash,
        presetId: condition.preset_id,
        bcId: condition.bc_id,
        snapshot: condition.snapshot,
        reynolds: Number(condition.reynolds),
      }),
    ),
  };
}

function makeCampaignPoint(
  aoaDeg: number,
  condition: RemoteCampaignCondition,
  patch: Record<string, unknown> = {},
) {
  const snapshot = condition.snapshot;
  return makePoint(aoaDeg, {
    reynolds: condition.reynolds,
    speed: Number(snapshot.flowState.speedMps),
    chord: Number(snapshot.referenceGeometry.referenceLengthM),
    mach:
      snapshot.flowState.mach == null ? null : Number(snapshot.flowState.mach),
    engine: TEST_MATCHING_RUNTIME,
    engineJobId: `${PREFIX}-campaign-engine-${condition.id}-${aoaDeg}`,
    ...patch,
  });
}

async function claimRemote(limit: number) {
  const response = await postJson("/api/sync/v1/sweeps/claim", {
    limit,
    sourceInstanceId: `${PREFIX}-campaign-remote`,
    sourceInstanceName: "campaign remote validation",
  });
  expect(response.statusCode, response.body).toBe(200);
  const promise = response.json().promise as {
    id: string;
    aoas: number[];
    airfoil: { id: string };
    setupRevision: { id: string; presetId: string };
  } | null;
  if (promise) cleanupPromiseIds.add(promise.id);
  return promise;
}

async function requestPayloadForPromise(promiseId: string) {
  const [row] = await db
    .select({ requestPayload: syncSweepPromises.requestPayload })
    .from(syncSweepPromises)
    .where(eq(syncSweepPromises.id, promiseId))
    .limit(1);
  return row?.requestPayload ?? null;
}

beforeAll(async () => {
  await configureSync();
  await createFixture();
  app = await buildServer();
});

afterAll(async () => {
  await app?.close();
  await db
    .delete(solverEvidenceArtifacts)
    .where(eq(solverEvidenceArtifacts.airfoilId, airfoilId));
  await db
    .delete(resultClassifications)
    .where(eq(resultClassifications.simulationPresetRevisionId, revisionId));
  await db
    .delete(fieldColorScales)
    .where(eq(fieldColorScales.simulationPresetRevisionId, revisionId));
  await db
    .delete(polarFitSets)
    .where(eq(polarFitSets.simulationPresetRevisionId, revisionId));
  if (cleanupPromiseIds.size) {
    await db
      .delete(syncRemotePromiseCancellations)
      .where(
        inArray(
          syncRemotePromiseCancellations.promiseId,
          Array.from(cleanupPromiseIds),
        ),
      );
    await db
      .delete(syncSweepPromises)
      .where(inArray(syncSweepPromises.id, Array.from(cleanupPromiseIds)));
  }
  await cleanupCampaignFixtures(db, {
    campaignIds: cleanupCampaignIds,
    presetSlugPrefix: `campaign-${PREFIX.toLowerCase()}`,
  });
  await db
    .delete(results)
    .where(eq(results.simulationPresetRevisionId, revisionId));
  await db
    .delete(resultAttempts)
    .where(eq(resultAttempts.simulationPresetRevisionId, revisionId));
  await db
    .delete(simJobs)
    .where(eq(simJobs.simulationPresetRevisionId, revisionId));
  if (cleanupRuntimeBuildIds.size)
    await db
      .delete(solverRuntimeBuilds)
      .where(
        inArray(solverRuntimeBuilds.id, Array.from(cleanupRuntimeBuildIds)),
      );
  if (cleanupConflictIds.size)
    await db
      .delete(syncImportConflicts)
      .where(inArray(syncImportConflicts.id, Array.from(cleanupConflictIds)));
  await db
    .delete(syncImportConflicts)
    .where(eq(syncImportConflicts.sourceInstanceId, `${PREFIX}-source`));
  await deleteIds(
    simulationPresets,
    simulationPresets.id,
    [presetId].filter(Boolean),
  );
  await deleteIds(
    boundaryConditions,
    boundaryConditions.id,
    [legacyBcId, validLocalBcId].filter(Boolean),
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
  await deleteIds(
    schedulingProfiles,
    schedulingProfiles.id,
    [profileIds.scheduling].filter(Boolean),
  );
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
  await restoreSync();
  await advisoryLockSql.end();
  await sql.end();
  rmSync(MEDIA_DIR, { recursive: true, force: true });
  if (savedMultipartUploadLimit == null)
    delete process.env.SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES;
  else
    process.env.SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES =
      savedMultipartUploadLimit;
  if (savedMultipartManifestLimit == null)
    delete process.env.SYNC_POLAR_MULTIPART_MAX_MANIFEST_BYTES;
  else
    process.env.SYNC_POLAR_MULTIPART_MAX_MANIFEST_BYTES =
      savedMultipartManifestLimit;
});

describe("remote solver sync validation regressions", () => {
  it("preserves the generic cross-engine bundle kind during remote asset sync", async () => {
    const applicationSourceSha256 = sha256(
      Buffer.from(`${PREFIX}:remote-application-source`),
    );
    const fixture = await createSelectedRemoteAssetGeneration(
      726.901,
      "generic-engine-bundle",
      {
        methodKey: "openfoam.rans",
        engine: {
          family: "openfoam",
          distribution: "opencfd",
          version: "2406",
          numericsRevision: "1",
          adapterContractVersion: 1,
          buildId: `${PREFIX}-remote-build`,
          sourceRevision: null,
          imageDigest: null,
          applicationSourceSha256,
          packageSha256: null,
          binarySha256: null,
          architecture: "x86_64",
        },
      },
    );
    const [runtime] = await db
      .select({
        id: solverRuntimeBuilds.id,
        applicationSourceSha256: solverRuntimeBuilds.applicationSourceSha256,
      })
      .from(resultAttempts)
      .innerJoin(
        solverRuntimeBuilds,
        eq(resultAttempts.solverRuntimeBuildId, solverRuntimeBuilds.id),
      )
      .where(eq(resultAttempts.id, fixture.result.currentResultAttemptId!))
      .limit(1);
    expect(runtime?.applicationSourceSha256).toBe(applicationSourceSha256);
    cleanupRuntimeBuildIds.add(runtime!.id);
    const bundleBytes = Buffer.from(`${PREFIX}:generic-engine-bundle`);
    const remoteArtifactId = `${PREFIX}-generic-engine-bundle-artifact`;
    const run = await runUpstreamEvidenceExport(
      {
        remoteArtifactId,
        remoteResultId: fixture.remoteResultId,
        remoteResultAttemptId: fixture.result.currentResultAttemptId,
        kind: "engine_bundle",
        field: null,
        role: "evidence",
        mimeType: "application/gzip",
        sha256: sha256(bundleBytes),
        byteSize: bundleBytes.byteLength,
        generationManifestSha256: fixture.manifest.sha256,
        downloadUrl: "/artifacts/generic-engine-bundle/download",
      },
      "db_only_remote_assets",
    );

    expect(run.response.statusCode, run.response.body).toBe(200);
    expect(run.response.json().lastRun).toMatchObject({
      imported: 1,
      conflicts: [],
    });
    const [stored] = await db
      .select({
        kind: solverEvidenceArtifacts.kind,
        role: solverEvidenceArtifacts.role,
        engineUrl: solverEvidenceArtifacts.engineUrl,
      })
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(
            solverEvidenceArtifacts.resultAttemptId,
            fixture.result.currentResultAttemptId!,
          ),
          eq(solverEvidenceArtifacts.sha256, sha256(bundleBytes)),
        ),
      )
      .limit(1);
    expect(stored).toMatchObject({
      kind: "engine_bundle",
      role: "evidence",
      engineUrl:
        "https://upstream.example.test/api/sync/v1/artifacts/generic-engine-bundle/download",
    });
  });

  it("rejects remote-solver evidence whose runtime identity differs from the promised immutable engine", async () => {
    const expectedEngine = TEST_EXPECTED_ENGINE;
    const matchingRuntime = TEST_MATCHING_RUNTIME;
    const cases = [
      ["distribution", { ...matchingRuntime, distribution: "foundation" }],
      ["release", { ...matchingRuntime, version: "2406" }],
      ["numerics", { ...matchingRuntime, numericsRevision: "legacy" }],
      ["adapter", { ...matchingRuntime, adapterContractVersion: 2 }],
    ] as const;
    const mismatchAoas = cases.map((_, index) => 698.11 + index / 1000);
    const missingIdentityAoa = 698.12;
    const matchingAoa = 698.13;
    const promiseId = await createPromise("active", [
      ...mismatchAoas,
      missingIdentityAoa,
      matchingAoa,
    ]);
    await db
      .update(syncSweepPromises)
      .set({ requestPayload: { remoteSolver: true }, updatedAt: new Date() })
      .where(eq(syncSweepPromises.id, promiseId));
    const [revisionBefore] = await db
      .select({ snapshot: simulationPresetRevisions.snapshot })
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, revisionId));
    if (!revisionBefore) throw new Error("identity fixture revision missing");
    await db
      .update(simulationPresetRevisions)
      .set({
        snapshot: {
          ...(revisionBefore.snapshot as Record<string, unknown>),
          engine: expectedEngine,
        },
      })
      .where(eq(simulationPresetRevisions.id, revisionId));

    try {
      for (const [index, [label, engine]] of cases.entries()) {
        const aoaDeg = mismatchAoas[index]!;
        const rejected = await postPolars(
          polarPayload([makePoint(aoaDeg, { engine })], {
            promiseId,
            bcId: undefined,
          }),
        );
        expect(rejected.statusCode, `${label}: ${rejected.body}`).toBe(409);
        expect(rejected.json().error).toMatch(/engine.*identity|runtime/i);
        expect(await resultAt(aoaDeg)).toBeNull();
      }

      const missingIdentity = await postPolars(
        polarPayload([makePoint(missingIdentityAoa)], {
          promiseId,
          bcId: undefined,
        }),
      );
      expect(missingIdentity.statusCode, missingIdentity.body).toBe(409);
      expect(missingIdentity.json().error).toMatch(/engine.*identity|runtime/i);
      expect(await resultAt(missingIdentityAoa)).toBeNull();

      const accepted = await postPolars(
        polarPayload([makePoint(matchingAoa, { engine: matchingRuntime })], {
          promiseId,
          bcId: undefined,
        }),
      );
      expect(accepted.statusCode, accepted.body).toBe(200);
      const stored = await resultAt(matchingAoa);
      expect(stored?.currentResultAttemptId).toBeTruthy();
      const [attempt] = await db
        .select({ evidencePayload: resultAttempts.evidencePayload })
        .from(resultAttempts)
        .where(eq(resultAttempts.id, stored!.currentResultAttemptId!));
      expect(attempt?.evidencePayload).toMatchObject({
        engine: {
          family: matchingRuntime.family,
          distribution: matchingRuntime.distribution,
          version: matchingRuntime.version,
          numerics_revision: matchingRuntime.numericsRevision,
          adapter_contract_version: matchingRuntime.adapterContractVersion,
          build_id: matchingRuntime.buildId,
        },
      });
    } finally {
      await db
        .update(simulationPresetRevisions)
        .set({ snapshot: revisionBefore.snapshot })
        .where(eq(simulationPresetRevisions.id, revisionId));
      await db
        .delete(syncSweepPromises)
        .where(eq(syncSweepPromises.id, promiseId));
      cleanupPromiseIds.delete(promiseId);
    }
  });

  it("refuses an up-tier authority switch while mirrored work is unfinished", async () => {
    const oldBase = "http://old-hub.test/api/sync/v1";
    const oldSecret = `${PREFIX}-old-upstream-secret`;
    await db
      .update(syncApiSettings)
      .set({
        upstreamBaseUrl: oldBase,
        upstreamSecret: oldSecret,
        updatedAt: new Date(),
      })
      .where(eq(syncApiSettings.id, 1));
    const promiseId = await createPromise("active", 699.001);
    await db
      .update(syncSweepPromises)
      .set({
        sourceBaseUrl: oldBase,
        requestPayload: { remoteSolver: true },
        updatedAt: new Date(),
      })
      .where(eq(syncSweepPromises.id, promiseId));

    const blocked = await app.inject({
      method: "PATCH",
      url: "/api/admin/sync",
      headers: {
        "content-type": "application/json",
        "x-xfoilfoam-sync-secret": SECRET,
      },
      payload: JSON.stringify({
        upstreamBaseUrl: "http://new-hub.test/api/sync/v1",
        upstreamSecret: `${PREFIX}-new-upstream-secret`,
      }),
    });
    expect(blocked.statusCode).toBe(409);
    const [unchanged] = await db
      .select({
        upstreamBaseUrl: syncApiSettings.upstreamBaseUrl,
        upstreamSecret: syncApiSettings.upstreamSecret,
      })
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    expect(unchanged).toEqual({
      upstreamBaseUrl: oldBase,
      upstreamSecret: oldSecret,
    });

    const cleared = await app.inject({
      method: "PATCH",
      url: "/api/admin/sync",
      headers: {
        "content-type": "application/json",
        "x-xfoilfoam-sync-secret": SECRET,
      },
      payload: JSON.stringify({
        upstreamBaseUrl: oldBase,
        upstreamSecret: "",
      }),
    });
    expect(cleared.statusCode).toBe(409);

    const rotatedSecret = `${PREFIX}-rotated-upstream-secret`;
    const rotated = await app.inject({
      method: "PATCH",
      url: "/api/admin/sync",
      headers: {
        "content-type": "application/json",
        "x-xfoilfoam-sync-secret": SECRET,
      },
      payload: JSON.stringify({
        upstreamBaseUrl: oldBase,
        upstreamSecret: rotatedSecret,
      }),
    });
    expect(rotated.statusCode).toBe(200);
    const [afterRotation] = await db
      .select({
        upstreamBaseUrl: syncApiSettings.upstreamBaseUrl,
        upstreamSecret: syncApiSettings.upstreamSecret,
      })
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1));
    expect(afterRotation).toEqual({
      upstreamBaseUrl: oldBase,
      upstreamSecret: rotatedSecret,
    });

    await db
      .update(syncSweepPromises)
      .set({
        status: "cancelled",
        cancelledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(syncSweepPromises.id, promiseId));
    await db
      .update(syncSweepPromisePoints)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(syncSweepPromisePoints.promiseId, promiseId));
    const released = await app.inject({
      method: "PATCH",
      url: "/api/admin/sync",
      headers: {
        "content-type": "application/json",
        "x-xfoilfoam-sync-secret": SECRET,
      },
      payload: JSON.stringify({
        upstreamBaseUrl: "http://new-hub.test/api/sync/v1",
        upstreamSecret: rotatedSecret,
      }),
    });
    expect(released.statusCode).toBe(200);
    await db
      .update(syncApiSettings)
      .set({
        upstreamBaseUrl: oldBase,
        upstreamSecret: oldSecret,
        updatedAt: new Date(),
      })
      .where(eq(syncApiSettings.id, 1));
  });

  it("orders public priority above an intact campaign, dedupes the shared cell, then terminal-links exact campaign evidence", async () => {
    const aoas = [1.31, 2.31, 3.31];
    const aoaDeg = aoas[1]!;
    const publicFixture = await createCampaignCompatiblePublicPreset(
      "campaign-priority-exact-link",
      aoas,
    );
    const fixture = await launchRemoteCampaign(
      "campaign-priority-exact-link",
      aoas,
      {
        objectivesEnabled: true,
        speedMps: publicFixture.speedMps,
        chordM: publicFixture.chordM,
      },
    );
    const condition = fixture.conditions[0]!;
    expect(condition).toMatchObject({
      presetId: publicFixture.presetId,
      revisionId: publicFixture.revisionId,
    });
    let priorityResultId = "";
    try {
      const [priorityResult] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId: condition.bcId,
          simulationPresetRevisionId: condition.revisionId,
          aoaDeg,
          status: "pending",
          source: "queued",
          priority: 10,
        })
        .returning({ id: results.id });
      priorityResultId = priorityResult.id;

      const publicClaim = await claimRemote(aoas.length);
      const publicRequest = await requestPayloadForPromise(publicClaim!.id);
      expect(publicRequest).toMatchObject({
        remoteSolver: true,
        workSource: "public",
      });
      expect(publicClaim).toMatchObject({
        aoas: [aoaDeg],
        airfoil: { id: airfoilId },
        setupRevision: {
          id: condition.revisionId,
          presetId: condition.presetId,
        },
      });
      expect(publicRequest as Record<string, unknown>).not.toHaveProperty(
        "campaignId",
      );
      expect(
        (await postJson(`/api/sync/v1/sweeps/${publicClaim!.id}/cancel`, {}))
          .statusCode,
      ).toBe(200);
      await db.delete(results).where(eq(results.id, priorityResult.id));
      priorityResultId = "";

      const campaignClaim = await claimRemote(aoas.length);
      expect(campaignClaim).toMatchObject({
        aoas,
        airfoil: { id: airfoilId },
        setupRevision: {
          id: condition.revisionId,
          presetId: condition.presetId,
        },
      });
      expect(await requestPayloadForPromise(campaignClaim!.id)).toMatchObject({
        remoteSolver: true,
        workSource: "campaign",
        campaignId: fixture.campaignId,
        conditionId: condition.id,
      });
      expect(Object.keys(campaignClaim!).sort()).toEqual(
        [
          "airfoil",
          "aoas",
          "expiresAt",
          "id",
          "setupRevision",
          "ttlHours",
        ].sort(),
      );

      const payload = polarPayload(
        aoas.map((angle) => makeCampaignPoint(angle, condition)),
        {
          promiseId: campaignClaim!.id,
          sourceInstanceId: `${PREFIX}-campaign-remote`,
          bcId: undefined,
          simulationPresetRevisionId: condition.revisionId,
          simulationPresetSignatureHash: condition.signatureHash,
        },
      );
      const pushed = await postPolars(payload);
      expect(pushed.statusCode, pushed.body).toBe(200);
      expect(pushed.json()).toMatchObject({
        fulfilledAoas: aoas,
        terminalAoas: [],
        unfulfilledAoas: [],
      });
      const [point] = await db
        .select()
        .from(simCampaignPoints)
        .where(
          and(
            eq(simCampaignPoints.campaignId, fixture.campaignId),
            eq(simCampaignPoints.conditionId, condition.id),
            eq(simCampaignPoints.airfoilId, airfoilId),
            eq(simCampaignPoints.aoaDeg, aoaDeg),
          ),
        );
      expect(point).toMatchObject({
        state: "terminal",
        resultId: expect.any(String),
        resultAttemptId: expect.any(String),
      });
      const [progress] = await db
        .select()
        .from(simCampaignProgress)
        .where(
          and(
            eq(simCampaignProgress.campaignId, fixture.campaignId),
            eq(simCampaignProgress.conditionId, condition.id),
            eq(simCampaignProgress.airfoilId, airfoilId),
          ),
        );
      expect(progress).toMatchObject({
        requested: aoas.length,
        solved: aoas.length,
        failed: 0,
        blocked: 0,
      });
      const lanes = await db
        .select({ state: simCampaignLanes.state })
        .from(simCampaignLanes)
        .where(eq(simCampaignLanes.campaignId, fixture.campaignId));
      expect(lanes).toHaveLength(3);
      expect(lanes.map((lane) => lane.state)).not.toContain("awaiting_seed");

      const replay = await postPolars(payload);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json()).toMatchObject({
        attempts: 0,
        fulfilledAoas: aoas,
        unfulfilledAoas: [],
      });
      const [replayedPoint] = await db
        .select()
        .from(simCampaignPoints)
        .where(
          and(
            eq(simCampaignPoints.campaignId, fixture.campaignId),
            eq(simCampaignPoints.conditionId, condition.id),
            eq(simCampaignPoints.airfoilId, airfoilId),
            eq(simCampaignPoints.aoaDeg, aoaDeg),
          ),
        );
      expect(replayedPoint.resultAttemptId).toBe(point.resultAttemptId);
      expect(
        (
          await postJson(`/api/sync/v1/sweeps/${campaignClaim!.id}/complete`, {
            accepted: true,
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      if (priorityResultId)
        await db.delete(results).where(eq(results.id, priorityResultId));
    }
  }, 30_000);

  it("leases only complete campaign polar groups and skips limited or partially owned groups", async () => {
    const aoas = [3.21, 3.22];
    const fixture = await launchRemoteCampaign(
      "campaign-full-group-exclusions",
      aoas,
      { speedCount: 10, priority: 0 },
    );
    await db
      .update(simulationPresets)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(simulationPresets.id, presetId));
    const [fallbackResult] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: legacyBcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: CAMPAIGN_FALLBACK_AOA,
        status: "pending",
        source: "queued",
        priority: 8,
      })
      .returning({ id: results.id });
    try {
      const limited = await claimRemote(1);
      expect(limited?.setupRevision.id).toBe(revisionId);
      expect(await requestPayloadForPromise(limited!.id)).toMatchObject({
        workSource: "public",
      });
      expect(
        (await postJson(`/api/sync/v1/sweeps/${limited!.id}/cancel`, {}))
          .statusCode,
      ).toBe(200);

      const intact = await claimRemote(2);
      const head = fixture.conditions[0]!;
      expect(intact).toMatchObject({
        aoas,
        setupRevision: { id: head.revisionId },
      });
      expect(await requestPayloadForPromise(intact!.id)).toMatchObject({
        workSource: "campaign",
        campaignId: fixture.campaignId,
        conditionId: head.id,
      });
      expect(
        (await postJson(`/api/sync/v1/sweeps/${intact!.id}/cancel`, {}))
          .statusCode,
      ).toBe(200);

      const conditions = fixture.conditions;
      await db
        .update(simCampaignPoints)
        .set({ state: "terminal" })
        .where(eq(simCampaignPoints.conditionId, conditions[0]!.id));
      await db
        .update(simCampaignProgress)
        .set({ solved: aoas.length })
        .where(
          and(
            eq(simCampaignProgress.campaignId, fixture.campaignId),
            eq(simCampaignProgress.conditionId, conditions[0]!.id),
            eq(simCampaignProgress.airfoilId, airfoilId),
          ),
        );
      const afterCompletedHead = await claimRemote(2);
      expect(afterCompletedHead).toMatchObject({
        aoas,
        setupRevision: { id: conditions[1]!.revisionId },
      });
      expect(
        await requestPayloadForPromise(afterCompletedHead!.id),
      ).toMatchObject({
        workSource: "campaign",
        campaignId: fixture.campaignId,
        conditionId: conditions[1]!.id,
      });
      expect(
        (
          await postJson(
            `/api/sync/v1/sweeps/${afterCompletedHead!.id}/cancel`,
            {},
          )
        ).statusCode,
      ).toBe(200);

      await db
        .update(simCampaignPoints)
        .set({ state: "released" })
        .where(
          and(
            eq(simCampaignPoints.conditionId, conditions[0]!.id),
            eq(simCampaignPoints.aoaDeg, aoas[1]!),
          ),
        );
      await db
        .update(simCampaignPoints)
        .set({ derivedBySymmetry: true })
        .where(eq(simCampaignPoints.conditionId, conditions[1]!.id));

      const [activeJob] = await db
        .insert(simJobs)
        .values({
          airfoilId,
          bcIds: [conditions[2]!.bcId, conditions[3]!.bcId],
          simulationPresetRevisionId: conditions[2]!.revisionId,
          campaignId: fixture.campaignId,
          referenceChordM: Number(
            conditions[2]!.snapshot.referenceGeometry.referenceLengthM,
          ),
          status: "running",
          totalCases: 2,
          requestPayload: { fixture: "campaign remote local ownership" },
        })
        .returning({ id: simJobs.id });
      for (const [index, status] of [
        [2, "queued"],
        [3, "running"],
        [4, "done"],
        [5, "failed"],
        [6, "pending"],
      ] as const) {
        const condition = conditions[index]!;
        const [owned] = await db
          .insert(results)
          .values({
            airfoilId,
            bcId: condition.bcId,
            simulationPresetRevisionId: condition.revisionId,
            aoaDeg: aoas[1]!,
            status,
            source: status === "done" ? "solved" : "queued",
            simJobId:
              status === "queued" || status === "running" ? activeJob.id : null,
          })
          .returning({ id: results.id });
        if (index === 6) {
          await db.insert(simResultSubmitRetries).values({
            resultId: owned.id,
            state: "retry_wait",
            attemptCount: 1,
            nextAttemptAt: new Date(Date.now() + 3600_000),
            lastError: "campaign remote retry backoff fixture",
          });
        }
      }
      await db.insert(simPrecalcObligations).values({
        airfoilId,
        revisionId: conditions[7]!.revisionId,
        aoaDeg: aoas[1]!,
        state: "pending",
      });
      const [existingPromise] = await db
        .insert(syncSweepPromises)
        .values({
          sourceInstanceId: `${PREFIX}-existing-campaign-owner`,
          airfoilId,
          simulationPresetRevisionId: conditions[8]!.revisionId,
          aoaCount: 1,
          expiresAt: new Date(Date.now() + 3600_000),
          requestPayload: { remoteSolver: true },
        })
        .returning({ id: syncSweepPromises.id });
      cleanupPromiseIds.add(existingPromise.id);
      await db.insert(syncSweepPromisePoints).values({
        promiseId: existingPromise.id,
        airfoilId,
        simulationPresetRevisionId: conditions[8]!.revisionId,
        aoaDeg: aoas[1]!,
      });
      await db
        .update(simCampaignConditions)
        .set({ status: "released" })
        .where(eq(simCampaignConditions.id, conditions[9]!.id));

      const partial = await claimRemote(2);
      expect(partial?.setupRevision.id).toBe(revisionId);
      expect(await requestPayloadForPromise(partial!.id)).toMatchObject({
        workSource: "public",
      });
      expect(
        (await postJson(`/api/sync/v1/sweeps/${partial!.id}/cancel`, {}))
          .statusCode,
      ).toBe(200);
      const campaignPromiseRows = await db
        .select({ id: syncSweepPromises.id })
        .from(syncSweepPromises)
        .where(
          and(
            inArray(
              syncSweepPromises.simulationPresetRevisionId,
              conditions.map((condition) => condition.revisionId),
            ),
            eq(syncSweepPromises.status, "active"),
          ),
        );
      expect(campaignPromiseRows).toEqual([{ id: existingPromise.id }]);

      const paused = await launchRemoteCampaign(
        "campaign-paused-not-claimable",
        [3.41],
      );
      await db
        .update(simCampaigns)
        .set({ status: "paused" })
        .where(eq(simCampaigns.id, paused.campaignId));
      const inactive = await claimRemote(1);
      expect(inactive?.setupRevision.id).toBe(revisionId);
      expect(await requestPayloadForPromise(inactive!.id)).toMatchObject({
        workSource: "public",
      });
      expect(
        (await postJson(`/api/sync/v1/sweeps/${inactive!.id}/cancel`, {}))
          .statusCode,
      ).toBe(200);
    } finally {
      await db.delete(results).where(eq(results.id, fallbackResult.id));
      await db
        .update(simulationPresets)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(simulationPresets.id, presetId));
    }
  }, 30_000);

  it("attaches a public promise's terminal rejected URANS obligation to every live campaign sharing the provisional RANS cell", async () => {
    const hardFailureAoa = 0.25;
    const aoaDeg = 1.25;
    const aoas = [hardFailureAoa, aoaDeg];
    const publicFixture = await createCampaignCompatiblePublicPreset(
      "campaign-terminal-precalc",
      aoas,
    );
    const fixture = await launchRemoteCampaign(
      "campaign-terminal-precalc-a",
      aoas,
      {
        speedMps: publicFixture.speedMps,
        chordM: publicFixture.chordM,
      },
    );
    const sharedFixture = await launchRemoteCampaign(
      "campaign-terminal-precalc-b",
      aoas,
      {
        speedMps: publicFixture.speedMps,
        chordM: publicFixture.chordM,
      },
    );
    const condition = fixture.conditions[0]!;
    const sharedCondition = sharedFixture.conditions[0]!;
    expect(condition).toMatchObject({
      presetId: publicFixture.presetId,
      revisionId: publicFixture.revisionId,
    });
    expect(sharedCondition).toMatchObject({
      presetId: publicFixture.presetId,
      revisionId: publicFixture.revisionId,
    });
    await db.insert(results).values(
      aoas.map((angle) => ({
        airfoilId,
        bcId: condition.bcId,
        simulationPresetRevisionId: condition.revisionId,
        aoaDeg: angle,
        status: "pending" as const,
        source: "queued" as const,
        priority: 10,
      })),
    );
    const claim = await claimRemote(aoas.length);
    expect(claim).toMatchObject({
      aoas,
      setupRevision: { id: condition.revisionId },
    });
    expect(await requestPayloadForPromise(claim!.id)).toMatchObject({
      remoteSolver: true,
      workSource: "public",
    });

    const marchedEngineJobId = `${PREFIX}-campaign-terminal-rans-march`;
    const ransPayload = polarPayload(
      [
        makeCampaignPoint(hardFailureAoa, condition, {
          engineJobId: marchedEngineJobId,
          converged: false,
          stalled: true,
        }),
        makeCampaignPoint(aoaDeg, condition, {
          engineJobId: marchedEngineJobId,
        }),
      ],
      {
        promiseId: claim!.id,
        sourceInstanceId: `${PREFIX}-campaign-remote`,
        bcId: undefined,
        simulationPresetRevisionId: condition.revisionId,
        simulationPresetSignatureHash: condition.signatureHash,
      },
    );
    const ransPushed = await postPolars(ransPayload);
    expect(ransPushed.statusCode, ransPushed.body).toBe(200);
    expect(ransPushed.json()).toMatchObject({
      fulfilledAoas: [],
      terminalAoas: aoas,
      unfulfilledAoas: [],
    });
    const [provisionalPoint] = await db
      .select()
      .from(syncSweepPromisePoints)
      .where(
        and(
          eq(syncSweepPromisePoints.promiseId, claim!.id),
          eq(syncSweepPromisePoints.aoaDeg, aoaDeg),
        ),
      );
    expect(provisionalPoint).toMatchObject({
      status: "cancelled",
      resultId: expect.any(String),
      resultAttemptId: expect.any(String),
    });
    const provisionalResultId = provisionalPoint.resultId!;
    const provisionalAttemptId = provisionalPoint.resultAttemptId!;
    const [provisionalResult] = await db
      .select()
      .from(results)
      .where(eq(results.id, provisionalResultId));
    expect(provisionalResult.currentResultAttemptId).toBe(provisionalAttemptId);
    const [provisionalClassification] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultAttemptId, provisionalAttemptId))
      .limit(1);
    expect(provisionalClassification?.state).toBe("needs_urans");

    // A newer continuation may already own the cell when the older solver's
    // late terminal evidence arrives. The old verdict must block all campaign
    // owners now, while later accepted exact truth from this newer lease must
    // satisfy the same physical obligation.
    const [newerPromise] = await db
      .insert(syncSweepPromises)
      .values({
        sourceInstanceId: `${PREFIX}-campaign-remote`,
        sourceInstanceName: "campaign remote validation",
        airfoilId,
        simulationPresetRevisionId: condition.revisionId,
        aoaCount: 1,
        expiresAt: new Date(Date.now() + 24 * 3600_000),
        requestPayload: { remoteSolver: true, workSource: "public" },
      })
      .returning({ id: syncSweepPromises.id });
    cleanupPromiseIds.add(newerPromise.id);
    await db.insert(syncSweepPromisePoints).values({
      promiseId: newerPromise.id,
      airfoilId,
      simulationPresetRevisionId: condition.revisionId,
      aoaDeg,
      resultId: provisionalResultId,
      resultAttemptId: provisionalAttemptId,
    });

    const terminalEvidence = uransEvidencePatch("campaign-terminal-precalc", [
      "URANS integration stopped by the wall-clock budget guard before a stable period window",
    ]);
    const payload = polarPayload(
      [
        makeCampaignPoint(aoaDeg, condition, {
          ...terminalEvidence,
          engineJobId: `${PREFIX}-campaign-terminal-urans`,
        }),
      ],
      {
        promiseId: claim!.id,
        sourceInstanceId: `${PREFIX}-campaign-remote`,
        bcId: undefined,
        simulationPresetRevisionId: condition.revisionId,
        simulationPresetSignatureHash: condition.signatureHash,
      },
    );
    const pushed = await postPolars(payload);
    expect(pushed.statusCode, pushed.body).toBe(200);
    const [canonicalAfterTerminal] = await db
      .select({
        currentResultAttemptId: results.currentResultAttemptId,
        status: results.status,
      })
      .from(results)
      .where(eq(results.id, provisionalResultId));
    expect(canonicalAfterTerminal?.currentResultAttemptId).toBe(
      provisionalAttemptId,
    );
    expect(pushed.json()).toMatchObject({
      fulfilledAoas: [],
      terminalAoas: [aoaDeg],
      unfulfilledAoas: [],
    });
    const points = await db
      .select()
      .from(simCampaignPoints)
      .where(
        and(
          eq(simCampaignPoints.revisionId, condition.revisionId),
          eq(simCampaignPoints.airfoilId, airfoilId),
          eq(simCampaignPoints.aoaDeg, aoaDeg),
          inArray(simCampaignPoints.campaignId, [
            fixture.campaignId,
            sharedFixture.campaignId,
          ]),
        ),
      );
    expect(points).toHaveLength(2);
    expect(
      points.every(
        (point) =>
          point.state === "terminal" &&
          point.resultId === provisionalResultId &&
          point.resultAttemptId === provisionalAttemptId,
      ),
    ).toBe(true);
    const [obligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, airfoilId),
          eq(simPrecalcObligations.revisionId, condition.revisionId),
          eq(simPrecalcObligations.aoaDeg, aoaDeg),
        ),
      );
    expect(obligation).toMatchObject({
      state: "blocked",
      attemptCount: 0,
      sourceResultId: provisionalResultId,
      sourceResultAttemptId: provisionalAttemptId,
      lastOutcome: "remote_terminal_rejected",
    });
    const ownership = await db
      .select()
      .from(simPrecalcObligationCampaigns)
      .where(eq(simPrecalcObligationCampaigns.obligationId, obligation.id));
    expect(ownership.map((owner) => owner.campaignId).sort()).toEqual(
      [fixture.campaignId, sharedFixture.campaignId].sort(),
    );
    expect(ownership.every((owner) => owner.state === "active")).toBe(true);
    const progress = await db
      .select()
      .from(simCampaignProgress)
      .where(
        and(
          eq(simCampaignProgress.airfoilId, airfoilId),
          inArray(simCampaignProgress.campaignId, [
            fixture.campaignId,
            sharedFixture.campaignId,
          ]),
        ),
      );
    expect(progress).toHaveLength(2);
    expect(progress.every((row) => row.solved === 0 && row.blocked === 1)).toBe(
      true,
    );

    const replayed = await postPolars(payload);
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.json()).toMatchObject({
      attempts: 0,
      terminalAoas: [aoaDeg],
    });
    const [replayedObligation] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligation.id));
    expect(replayedObligation).toMatchObject({
      state: "blocked",
      attemptCount: 0,
    });
    const replayedPoints = await db
      .select()
      .from(simCampaignPoints)
      .where(
        and(
          inArray(simCampaignPoints.campaignId, [
            fixture.campaignId,
            sharedFixture.campaignId,
          ]),
          eq(simCampaignPoints.aoaDeg, aoaDeg),
        ),
      );
    expect(replayedPoints).toHaveLength(2);
    expect(
      replayedPoints.every(
        (point) => point.resultAttemptId === provisionalAttemptId,
      ),
    ).toBe(true);
    const campaignStatesWhileReplacementIsActive = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(
        inArray(simCampaigns.id, [
          fixture.campaignId,
          sharedFixture.campaignId,
        ]),
      );
    expect(
      campaignStatesWhileReplacementIsActive.every(
        (row) => row.status === "active",
      ),
    ).toBe(true);

    // The low-angle hard RANS failure exists only to create the provisional
    // promotion fixture. Remove that separate terminal scope before checking
    // recovery of the target cell: an unresolved failed campaign point must
    // truthfully keep the campaign in attention, independently of whether the
    // target's newer accepted generation repairs its blocked obligation.
    await db
      .update(simCampaignPoints)
      .set({ state: "released" })
      .where(
        and(
          eq(simCampaignPoints.airfoilId, airfoilId),
          eq(simCampaignPoints.revisionId, condition.revisionId),
          eq(simCampaignPoints.aoaDeg, hardFailureAoa),
          inArray(simCampaignPoints.campaignId, [
            fixture.campaignId,
            sharedFixture.campaignId,
          ]),
        ),
      );

    const acceptedPayload = polarPayload(
      [
        makeCampaignPoint(aoaDeg, condition, {
          ...uransEvidencePatch("campaign-accepted-after-terminal"),
          engineJobId: `${PREFIX}-campaign-accepted-after-terminal`,
        }),
      ],
      {
        promiseId: newerPromise.id,
        sourceInstanceId: `${PREFIX}-campaign-remote`,
        bcId: undefined,
        simulationPresetRevisionId: condition.revisionId,
        simulationPresetSignatureHash: condition.signatureHash,
      },
    );
    const accepted = await postPolars(acceptedPayload);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      fulfilledAoas: [aoaDeg],
      terminalAoas: [],
      unfulfilledAoas: [],
    });
    const [satisfied] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligation.id));
    expect(satisfied).toMatchObject({
      state: "satisfied",
      attemptCount: 0,
      sourceResultId: provisionalResultId,
      sourceResultAttemptId: expect.any(String),
      lastOutcome: "accepted",
      lastError: null,
      nextSubmitAt: null,
    });
    expect(satisfied.sourceResultAttemptId).not.toBe(provisionalAttemptId);
    const acceptedCampaignPoints = await db
      .select({ resultAttemptId: simCampaignPoints.resultAttemptId })
      .from(simCampaignPoints)
      .where(
        and(
          eq(simCampaignPoints.airfoilId, airfoilId),
          eq(simCampaignPoints.revisionId, condition.revisionId),
          eq(simCampaignPoints.aoaDeg, aoaDeg),
          inArray(simCampaignPoints.campaignId, [
            fixture.campaignId,
            sharedFixture.campaignId,
          ]),
        ),
      );
    expect(acceptedCampaignPoints).toHaveLength(2);
    expect(
      acceptedCampaignPoints.every(
        (point) => point.resultAttemptId === satisfied.sourceResultAttemptId,
      ),
    ).toBe(true);
    const satisfiedProgress = await db
      .select()
      .from(simCampaignProgress)
      .where(
        and(
          eq(simCampaignProgress.airfoilId, airfoilId),
          inArray(simCampaignProgress.campaignId, [
            fixture.campaignId,
            sharedFixture.campaignId,
          ]),
        ),
      );
    expect(satisfiedProgress).toHaveLength(2);
    expect(
      satisfiedProgress.every((row) => row.blocked === 0 && row.solved === 1),
    ).toBe(true);
    const campaignStates = await db
      .select({ status: simCampaigns.status })
      .from(simCampaigns)
      .where(
        inArray(simCampaigns.id, [
          fixture.campaignId,
          sharedFixture.campaignId,
        ]),
      );
    expect(campaignStates).toHaveLength(2);
    expect(campaignStates.every((row) => row.status === "completed")).toBe(
      true,
    );
    const acceptedReplay = await postPolars(acceptedPayload);
    expect(acceptedReplay.statusCode, acceptedReplay.body).toBe(200);
    expect(acceptedReplay.json()).toMatchObject({
      attempts: 0,
      fulfilledAoas: [aoaDeg],
      unfulfilledAoas: [],
    });
    const [replayedSatisfied] = await db
      .select()
      .from(simPrecalcObligations)
      .where(eq(simPrecalcObligations.id, obligation.id));
    expect(replayedSatisfied).toMatchObject({
      state: "satisfied",
      attemptCount: 0,
      sourceResultAttemptId: satisfied.sourceResultAttemptId,
      lastOutcome: "accepted",
    });
  }, 45_000);

  it("replays the selected attempt's sole manifest without a second row or download", async () => {
    const fixture = await createSelectedRemoteAssetGeneration(
      727.001,
      "manifest-exact-replay",
    );
    const refsBefore = await db
      .select({ id: remoteAssetReferences.id })
      .from(remoteAssetReferences)
      .where(eq(remoteAssetReferences.localRowId, fixture.manifest.id));
    const run = await runUpstreamEvidenceExport({
      remoteArtifactId: `${PREFIX}-manifest-exact-replay-artifact`,
      remoteResultId: fixture.remoteResultId,
      remoteResultAttemptId: fixture.result.currentResultAttemptId,
      kind: "manifest",
      field: fixture.manifest.field,
      role: fixture.manifest.role,
      storageKey: fixture.manifest.storageKey,
      mimeType: fixture.manifest.mimeType,
      sha256: fixture.manifest.sha256,
      byteSize: fixture.manifest.byteSize,
      generationManifestSha256: fixture.manifest.sha256,
      downloadUrl: "/artifacts/manifest-exact-replay/download",
    });
    expect(run.response.statusCode, run.response.body).toBe(200);
    expect(run.response.json().lastRun).toMatchObject({
      imported: 1,
      conflicts: [],
    });
    expect(run.urls).toHaveLength(2);
    expect(run.urls.some((url) => url.includes("/download"))).toBe(false);
    expect(mediaFilePaths()).toEqual(run.beforeFiles);
    const manifestsAfter = await db
      .select({ id: solverEvidenceArtifacts.id })
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, fixture.result.id),
          eq(
            solverEvidenceArtifacts.resultAttemptId,
            fixture.result.currentResultAttemptId!,
          ),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      );
    expect(manifestsAfter).toEqual([{ id: fixture.manifest.id }]);
    expect(
      await db
        .select({ id: remoteAssetReferences.id })
        .from(remoteAssetReferences)
        .where(eq(remoteAssetReferences.localRowId, fixture.manifest.id)),
    ).toEqual(refsBefore);
    expect((await resultAt(727.001))?.currentResultAttemptId).toBe(
      fixture.result.currentResultAttemptId,
    );
  });

  it("conflicts a same-checksum manifest with another storage identity without downloading or mutating selection", async () => {
    const fixture = await createSelectedRemoteAssetGeneration(
      728.001,
      "manifest-storage-conflict",
    );
    const run = await runUpstreamEvidenceExport({
      remoteArtifactId: `${PREFIX}-manifest-storage-conflict-artifact`,
      remoteResultId: fixture.remoteResultId,
      remoteResultAttemptId: fixture.result.currentResultAttemptId,
      kind: "manifest",
      field: fixture.manifest.field,
      role: fixture.manifest.role,
      storageKey: `${fixture.manifest.storageKey}.different-owner`,
      mimeType: fixture.manifest.mimeType,
      sha256: fixture.manifest.sha256,
      byteSize: fixture.manifest.byteSize,
      generationManifestSha256: fixture.manifest.sha256,
      downloadUrl: "/artifacts/manifest-storage-conflict/download",
    });
    expect(run.response.statusCode, run.response.body).toBe(200);
    const lastRun = run.response.json().lastRun as {
      imported: number;
      conflicts: string[];
    };
    expect(lastRun.imported).toBe(0);
    expect(lastRun.conflicts).toHaveLength(1);
    cleanupConflictIds.add(lastRun.conflicts[0]);
    expect(run.urls).toHaveLength(2);
    expect(run.urls.some((url) => url.includes("/download"))).toBe(false);
    expect(mediaFilePaths()).toEqual(run.beforeFiles);
    const manifestsAfter = await db
      .select({ id: solverEvidenceArtifacts.id })
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, fixture.result.id),
          eq(
            solverEvidenceArtifacts.resultAttemptId,
            fixture.result.currentResultAttemptId!,
          ),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      );
    expect(manifestsAfter).toEqual([{ id: fixture.manifest.id }]);
    expect(
      await db
        .select({ id: remoteAssetReferences.id })
        .from(remoteAssetReferences)
        .where(eq(remoteAssetReferences.localRowId, fixture.manifest.id)),
    ).toHaveLength(0);
    expect((await resultAt(728.001))?.currentResultAttemptId).toBe(
      fixture.result.currentResultAttemptId,
    );
  });

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

    const accepted = await postPolars(
      polarPayload([makePoint(700.001, { media: [bigMedia] })]),
    );
    expect(accepted.statusCode).toBeGreaterThanOrEqual(200);
    expect(accepted.statusCode).toBeLessThan(300);
    expect(accepted.json()).toMatchObject({
      imported: 1,
      attempts: 1,
      media: 1,
    });

    const tooLargeForDefault = await postJson("/api/sync/v1/sweeps/claim", {
      limit: 1,
      sourceInstanceId: `${PREFIX}-default-limit`,
      padding: bigMedia.contentBase64,
    });
    expect(tooLargeForDefault.statusCode).toBe(413);
  });

  it("uses the hub revision legacy boundary condition for foreign bcId and preserves a valid local bcId", async () => {
    const foreignBcId = randomUUID();
    const foreign = await postPolars(
      polarPayload([makePoint(701.001)], { bcId: foreignBcId }),
    );
    expect(foreign.statusCode).toBe(200);
    const foreignRow = await resultAt(701.001);
    expect(foreignRow?.bcId).toBe(legacyBcId);
    expect(foreignRow?.bcId).not.toBe(foreignBcId);

    const validLocal = await postPolars(
      polarPayload([makePoint(702.001)], { bcId: validLocalBcId }),
    );
    expect(validLocal.statusCode).toBe(200);
    const validLocalRow = await resultAt(702.001);
    expect(validLocalRow?.bcId).toBe(validLocalBcId);
  });

  it("strips media and evidence artifact contentBase64 from result_attempts.evidence_payload while retaining hashes and metadata", async () => {
    const artifact = artifactItem("attempt-sanitize");
    const media = mediaItem("attempt-sanitize");
    const pushed = await postPolars(
      polarPayload([
        makePoint(703.001, { evidenceArtifacts: [artifact], media: [media] }),
      ]),
    );
    expect(pushed.statusCode).toBe(200);
    const row = await resultAt(703.001);
    expect(row?.id).toBeTruthy();
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, row!.id))
      .limit(1);
    const evidencePayload = attempt.evidencePayload as {
      evidenceArtifacts?: Record<string, unknown>[];
      media?: Record<string, unknown>[];
    };
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

  it("reuses one attempt when an exact replay omits regime and normalizes a completed queued point", async () => {
    const aoaDeg = 703.101;
    const point = makePoint(aoaDeg, {
      regime: undefined,
      source: "queued",
    });
    const payload = polarPayload([point]);

    const first = await postPolars(payload);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      imported: 1,
      attempts: 1,
      conflictIds: [],
    });
    expect(await resultAt(aoaDeg)).toMatchObject({
      source: "solved",
      regime: "rans",
    });

    const replay = await postPolars(payload);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      imported: 0,
      attempts: 0,
      conflictIds: [],
    });
    const canonical = await resultAt(aoaDeg);
    const storedAttempts = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, canonical!.id));
    expect(storedAttempts).toHaveLength(1);
  });

  it("conflicts an exact-attempt replay that rebinds the sole manifest to another storage identity", async () => {
    const aoaDeg = 703.151;
    const manifest = artifactItem("polar-replay-manifest-storage");
    const point = makePoint(aoaDeg, {
      evidencePayload: { contract: "stable-polar-replay-v1" },
      evidenceArtifacts: [manifest],
    });
    const first = await postPolars(polarPayload([point]));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      imported: 1,
      attempts: 1,
      conflictIds: [],
    });
    const canonical = await resultAt(aoaDeg);
    if (!canonical?.currentResultAttemptId) {
      throw new Error("selected exact replay fixture has no current attempt");
    }
    const [storedManifest] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, canonical.id),
          eq(
            solverEvidenceArtifacts.resultAttemptId,
            canonical.currentResultAttemptId,
          ),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      );
    expect(storedManifest.storageKey).toMatch(/\.json$/);
    const filesBeforeReplay = mediaFilePaths();

    const replay = await postPolars(
      polarPayload([
        {
          ...point,
          evidenceArtifacts: [
            {
              ...manifest,
              filename: "same-manifest-bytes-different-owner.txt",
            },
          ],
        },
      ]),
    );
    expect(replay.statusCode, replay.body).toBe(200);
    const replayBody = replay.json() as {
      imported: number;
      attempts: number;
      conflictIds: string[];
    };
    expect(replayBody.imported).toBe(0);
    expect(replayBody.attempts).toBe(0);
    expect(replayBody.conflictIds).toHaveLength(1);
    cleanupConflictIds.add(replayBody.conflictIds[0]);
    expect(mediaFilePaths()).toEqual(filesBeforeReplay);
    expect(
      await db
        .select({ id: solverEvidenceArtifacts.id })
        .from(solverEvidenceArtifacts)
        .where(
          and(
            eq(solverEvidenceArtifacts.resultId, canonical.id),
            eq(
              solverEvidenceArtifacts.resultAttemptId,
              canonical.currentResultAttemptId,
            ),
            eq(solverEvidenceArtifacts.kind, "manifest"),
          ),
        ),
    ).toEqual([{ id: storedManifest.id }]);
    expect((await resultAt(aoaDeg))?.currentResultAttemptId).toBe(
      canonical.currentResultAttemptId,
    );
  });

  it.each([
    ["legacy result-level", 703.201, "result", "cancelled"],
    ["non-selected attempt", 703.301, "stale", "cancelled"],
    ["selected exact attempt", 703.401, "selected", "fulfilled"],
  ] as const)(
    "settles an archived conflict safely for a %s accepted classification",
    async (
      _classificationLabel,
      aoaDeg,
      classificationOwner,
      expectedStatus,
    ) => {
      const [canonical] = await db
        .insert(results)
        .values({
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
          cl: 0.51,
          cd: 0.013,
          cm: -0.02,
          converged: true,
          engineJobId: `${PREFIX}-projection-${aoaDeg}`,
          solvedAt: new Date(),
        })
        .returning({ id: results.id });
      const attempts = await db
        .insert(resultAttempts)
        .values([
          {
            resultId: canonical.id,
            airfoilId,
            bcId: legacyBcId,
            simulationPresetRevisionId: revisionId,
            aoaDeg,
            status: "done" as const,
            source: "solved" as const,
            regime: "rans" as const,
            cl: 0.41,
            cd: 0.014,
            cm: -0.02,
            converged: true,
            engineJobId: `${PREFIX}-stale-attempt-${aoaDeg}`,
            solvedAt: new Date(),
          },
          {
            resultId: canonical.id,
            airfoilId,
            bcId: legacyBcId,
            simulationPresetRevisionId: revisionId,
            aoaDeg,
            status: "done" as const,
            source: "solved" as const,
            regime: "rans" as const,
            cl: 0.51,
            cd: 0.013,
            cm: -0.02,
            converged: true,
            engineJobId: `${PREFIX}-selected-attempt-${aoaDeg}`,
            solvedAt: new Date(),
          },
        ])
        .returning({ id: resultAttempts.id });
      const [staleAttempt, selectedAttempt] = attempts;
      await db
        .update(results)
        .set({ currentResultAttemptId: selectedAttempt.id })
        .where(eq(results.id, canonical.id));
      await db.insert(resultClassifications).values({
        resultId: classificationOwner === "result" ? canonical.id : null,
        resultAttemptId:
          classificationOwner === "stale"
            ? staleAttempt.id
            : classificationOwner === "selected"
              ? selectedAttempt.id
              : null,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        regime: "rans",
        classifierVersion: `${PREFIX}-stale-classification`,
        state: "accepted",
        region: "attached",
      });

      const promiseId = await createPromise("active", aoaDeg);
      const [conflict] = await db
        .insert(syncImportConflicts)
        .values({
          dataType: "polars",
          naturalKey: `${airfoilId}:${revisionId}:${aoaDeg}`,
          sourceInstanceId: `${PREFIX}-source`,
          incomingPayload: {},
          artifactManifest: { promiseId },
        })
        .returning({ id: syncImportConflicts.id });
      cleanupConflictIds.add(conflict.id);

      const archived = await postJson(
        `/api/admin/sync/conflicts/${conflict.id}/archive`,
        {},
      );
      expect(archived.statusCode).toBe(200);

      const settled = await readPromise(promiseId);
      expect(settled.promise).toMatchObject({ status: expectedStatus });
      if (expectedStatus === "cancelled") {
        expect(settled.promise.cancelledAt).not.toBeNull();
        expect(settled.points).toMatchObject([
          {
            status: "cancelled",
            resultId: null,
            resultAttemptId: null,
          },
        ]);
      } else {
        expect(settled.points).toMatchObject([
          {
            status: "fulfilled",
            resultId: canonical.id,
            resultAttemptId: selectedAttempt.id,
          },
        ]);
      }
      const [archivedConflict] = await db
        .select({ status: syncImportConflicts.status })
        .from(syncImportConflicts)
        .where(eq(syncImportConflicts.id, conflict.id));
      expect(archivedConflict?.status).toBe("archived");
    },
  );

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
    const promiseId = await createPromise("active", aoaDeg);

    const media = mediaItem("conflict-sanitize");
    const pushed = await postPolars(
      polarPayload([makePoint(aoaDeg, { cl: 0.99, media: [media] })], {
        promiseId,
      }),
    );
    expect(pushed.statusCode).toBe(200);
    const body = pushed.json() as { conflictIds: string[] };
    expect(body.conflictIds).toHaveLength(1);
    cleanupConflictIds.add(body.conflictIds[0]);

    const [conflict] = await db
      .select()
      .from(syncImportConflicts)
      .where(eq(syncImportConflicts.id, body.conflictIds[0]))
      .limit(1);
    const incoming = conflict.incomingPayload as {
      media?: Record<string, unknown>[];
    };
    const serialized = JSON.stringify(incoming);
    expect(serialized).not.toContain(media.contentBase64);
    expect(incoming.media?.[0]).toMatchObject({
      contentBase64: `[stripped ${media.contentBase64.length} base64 chars]`,
      sha256: media.sha256,
      field: media.field,
    });

    expect(await resultAt(aoaDeg)).toMatchObject({
      cl: 0.42,
      engineJobId: `${PREFIX}-existing-conflict`,
    });
    const attemptsForConflict = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, (await resultAt(aoaDeg))!.id));
    expect(attemptsForConflict).toHaveLength(0);
    expect((await readPromise(promiseId)).points).toMatchObject([
      { status: "active", resultId: null },
    ]);
    const incomplete = await postJson(
      `/api/sync/v1/sweeps/${promiseId}/complete`,
      {},
    );
    expect(incomplete.statusCode).toBe(409);

    const refusedPromotion = await postJson(
      `/api/admin/sync/conflicts/${conflict.id}/promote`,
      {},
    );
    expect(refusedPromotion.statusCode).toBe(409);
    expect(refusedPromotion.json()).toMatchObject({
      error: expect.stringContaining("bytes are not retained"),
    });
    const [stillPending] = await db
      .select({ status: syncImportConflicts.status })
      .from(syncImportConflicts)
      .where(eq(syncImportConflicts.id, conflict.id));
    expect(stillPending?.status).toBe("pending");
  });

  it("keeps metadata-only polar conflict promotion fail-closed", async () => {
    const aoaDeg = 704.101;
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
      cl: 0.31,
      cd: 0.018,
      cm: -0.01,
      converged: true,
      engineJobId: `${PREFIX}-local-before-promote`,
      solvedAt: new Date(),
    });
    const promiseId = await createPromise("active", aoaDeg);
    const point = makePoint(aoaDeg, {
      ...uransEvidencePatch("conflict-promote"),
      evidenceArtifacts: [],
      media: [],
    });
    const payload = polarPayload([point], { promiseId });
    const pushed = await postPolars(payload);
    expect(pushed.statusCode).toBe(200);
    const [conflictId] = (pushed.json() as { conflictIds: string[] })
      .conflictIds;
    expect(conflictId).toBeTruthy();
    cleanupConflictIds.add(conflictId);

    const before = await resultAt(aoaDeg);
    const refused = await postJson(
      `/api/admin/sync/conflicts/${conflictId}/promote`,
      {},
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: expect.stringContaining("re-push the complete exact-attempt"),
    });
    expect(await resultAt(aoaDeg)).toMatchObject({
      id: before!.id,
      cl: before!.cl,
      cd: before!.cd,
      regime: before!.regime,
      engineJobId: before!.engineJobId,
      currentResultAttemptId: null,
    });
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.resultId, before!.id)),
    ).toHaveLength(0);
    const [stillPending] = await db
      .select({ status: syncImportConflicts.status })
      .from(syncImportConflicts)
      .where(eq(syncImportConflicts.id, conflictId));
    expect(stillPending?.status).toBe("pending");
  });

  it("does not reach a promotion status write for legacy polar conflicts", async () => {
    const aoaDeg = 704.151;
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
      cl: 0.211,
      cd: 0.021,
      cm: -0.011,
      converged: true,
      engineJobId: `${PREFIX}-atomic-local`,
      solvedAt: new Date(),
    });
    const incoming = makePoint(aoaDeg, {
      cl: 0.933,
      evidenceArtifacts: [],
      media: [],
    });
    const conflicted = await postPolars(polarPayload([incoming]));
    expect(conflicted.statusCode).toBe(200);
    const [conflictId] = (conflicted.json() as { conflictIds: string[] })
      .conflictIds;
    cleanupConflictIds.add(conflictId);
    const before = await resultAt(aoaDeg);
    const suffix = `${process.pid}_${randomUUID().replace(/-/g, "")}`;
    const functionName = `sync_promotion_fault_${suffix}`;
    const triggerName = `sync_promotion_fault_trigger_${suffix}`;
    await sql.unsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${conflictId}'::uuid AND NEW.status = 'promoted' THEN
          RAISE EXCEPTION 'injected promotion status fault';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await sql.unsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE UPDATE ON sync_import_conflicts
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
    try {
      const promoted = await postJson(
        `/api/admin/sync/conflicts/${conflictId}/promote`,
        {},
      );
      expect(promoted.statusCode).toBe(409);
    } finally {
      await sql.unsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON sync_import_conflicts`,
      );
      await sql.unsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }

    expect(await resultAt(aoaDeg)).toMatchObject({
      id: before!.id,
      cl: before!.cl,
      cd: before!.cd,
      engineJobId: before!.engineJobId,
      regime: before!.regime,
    });
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.resultId, before!.id)),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select()
          .from(syncImportConflicts)
          .where(eq(syncImportConflicts.id, conflictId))
      )[0].status,
    ).toBe("pending");
  });

  it("refuses to relabel existing local media as remote conflict truth", async () => {
    const aoaDeg = 704.201;
    const [local] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId: legacyBcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg,
        status: "done",
        source: "solved",
        regime: "rans",
        cl: 0.2,
        cd: 0.02,
        cm: -0.01,
        converged: true,
        engineJobId: `${PREFIX}-local-media-engine`,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    await db.insert(resultMedia).values({
      resultId: local.id,
      kind: "image",
      field: "pressure",
      role: "instantaneous",
      storageKey: `${PREFIX}/local-only-pressure.png`,
      mimeType: "image/png",
      sha256: sha256(Buffer.from("local-only-pressure")),
      byteSize: Buffer.byteLength("local-only-pressure"),
    });
    const promiseId = await createPromise("active", aoaDeg);
    const pushed = await postPolars(
      polarPayload([makePoint(aoaDeg, { evidenceArtifacts: [] })], {
        promiseId,
      }),
    );
    const [conflictId] = (pushed.json() as { conflictIds: string[] })
      .conflictIds;
    cleanupConflictIds.add(conflictId);

    const refused = await postJson(
      `/api/admin/sync/conflicts/${conflictId}/promote`,
      {},
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: expect.stringContaining("re-push the complete exact-attempt"),
    });
    expect(await resultAt(aoaDeg)).toMatchObject({
      id: local.id,
      engineJobId: `${PREFIX}-local-media-engine`,
      cl: 0.2,
    });
    const retainedMedia = await db
      .select({ storageKey: resultMedia.storageKey })
      .from(resultMedia)
      .where(eq(resultMedia.resultId, local.id));
    expect(retainedMedia).toEqual([
      { storageKey: `${PREFIX}/local-only-pressure.png` },
    ]);
  });

  it("keeps a partially imported promise active and rejects completion until every point has canonical evidence", async () => {
    const aoas = [707.001, 708.001];
    const promiseId = await createPromise("active", aoas);

    const firstPush = await postPolars(
      polarPayload([makePoint(aoas[0])], {
        promiseId,
        bcId: undefined,
      }),
    );
    expect(firstPush.statusCode).toBe(200);
    expect(firstPush.json()).toMatchObject({
      imported: 1,
      attempts: 1,
      conflictIds: [],
    });

    const partial = await readPromise(promiseId);
    expect(partial.promise.status).toBe("active");
    expect(partial.points.map((point) => point.status)).toEqual([
      "fulfilled",
      "active",
    ]);
    expect(partial.points[0].resultId).toBe((await resultAt(aoas[0]))?.id);
    expect(partial.points[1].resultId).toBeNull();

    const rejectedCompletion = await postJson(
      `/api/sync/v1/sweeps/${promiseId}/complete`,
      { partial: true },
    );
    expect(rejectedCompletion.statusCode).toBe(409);
    expect(rejectedCompletion.json()).toMatchObject({
      expectedPointCount: 2,
      pointCount: 2,
      unfulfilledPointCount: 1,
    });
    expect((await readPromise(promiseId)).promise.status).toBe("active");

    const secondPush = await postPolars(
      polarPayload([makePoint(aoas[1])], {
        promiseId,
        bcId: undefined,
      }),
    );
    expect(secondPush.statusCode).toBe(200);
    expect((await readPromise(promiseId)).promise.status).toBe("active");

    const completed = await postJson(
      `/api/sync/v1/sweeps/${promiseId}/complete`,
      { allPointsPushed: true },
    );
    expect(completed.statusCode).toBe(200);
    const finalState = await readPromise(promiseId);
    expect(finalState.promise.status).toBe("fulfilled");
    expect(finalState.points.map((point) => point.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
  });

  it("retargets a fulfilled RANS sibling to its accepted preliminary URANS generation while the exact promise remains active", async () => {
    const aoas = [711.101, 711.201];
    const promiseId = await createPromise("active", aoas);
    const ransPush = await postPolars(
      polarPayload([makePoint(aoas[0])], {
        promiseId,
        bcId: undefined,
      }),
    );
    expect(ransPush.statusCode).toBe(200);
    expect(ransPush.json()).toMatchObject({
      fulfilledAoas: [aoas[0]],
      unfulfilledAoas: [],
    });
    const afterRans = await readPromise(promiseId);
    const ransPoint = afterRans.points[0]!;
    expect(ransPoint).toMatchObject({
      aoaDeg: aoas[0],
      status: "fulfilled",
    });
    expect(ransPoint.resultId).toBeTruthy();
    expect(ransPoint.resultAttemptId).toBeTruthy();
    expect(afterRans.points[1]).toMatchObject({
      aoaDeg: aoas[1],
      status: "active",
    });

    const uransPush = await postPolars(
      polarPayload(
        [
          makePoint(aoas[0], {
            ...uransEvidencePatch("fulfilled-rans-to-precalc"),
            engineJobId: `${PREFIX}-fulfilled-rans-to-precalc-urans`,
          }),
        ],
        { promiseId, bcId: undefined },
      ),
    );

    expect(uransPush.statusCode).toBe(200);
    expect(uransPush.json()).toMatchObject({
      conflictIds: [],
      fulfilledAoas: [aoas[0]],
      unfulfilledAoas: [],
    });
    const afterUrans = await readPromise(promiseId);
    expect(afterUrans.promise.status).toBe("active");
    expect(afterUrans.points[0]).toMatchObject({
      aoaDeg: aoas[0],
      status: "fulfilled",
      resultId: ransPoint.resultId,
    });
    expect(afterUrans.points[0]!.resultAttemptId).not.toBe(
      ransPoint.resultAttemptId,
    );
    expect(afterUrans.points[1]).toMatchObject({
      aoaDeg: aoas[1],
      status: "active",
    });
    expect(
      await db
        .select({ id: resultAttempts.id, regime: resultAttempts.regime })
        .from(resultAttempts)
        .where(eq(resultAttempts.resultId, ransPoint.resultId!))
        .orderBy(resultAttempts.createdAt),
    ).toMatchObject([{ regime: "rans" }, { regime: "urans" }]);
  });

  it("does not retarget a fulfilled point to an unrelated changed RANS generation", async () => {
    const aoas = [711.301, 711.401];
    const promiseId = await createPromise("active", aoas);
    const first = await postPolars(
      polarPayload([makePoint(aoas[0])], {
        promiseId,
        bcId: undefined,
      }),
    );
    expect(first.statusCode).toBe(200);
    const originalPoint = (await readPromise(promiseId)).points[0]!;
    expect(originalPoint).toMatchObject({
      status: "fulfilled",
      aoaDeg: aoas[0],
    });

    const changedRans = await postPolars(
      polarPayload(
        [
          makePoint(aoas[0], {
            engineJobId: `${PREFIX}-unrelated-second-rans-generation`,
          }),
        ],
        { promiseId, bcId: undefined },
      ),
    );

    expect(changedRans.statusCode).toBe(200);
    expect(changedRans.json()).toMatchObject({
      fulfilledAoas: [],
      unfulfilledAoas: [aoas[0]],
    });
    expect((await readPromise(promiseId)).points[0]).toMatchObject({
      status: "fulfilled",
      resultId: originalPoint.resultId,
      resultAttemptId: originalPoint.resultAttemptId,
    });
  });

  it("serializes concurrent preliminary URANS replacements so one fulfilled RANS sibling advances exactly once", async () => {
    const aoas = [711.601, 711.701];
    const promiseId = await createPromise("active", aoas);
    const ransPush = await postPolars(
      polarPayload([makePoint(aoas[0])], {
        promiseId,
        bcId: undefined,
      }),
    );
    expect(ransPush.statusCode).toBe(200);
    const ransPoint = (await readPromise(promiseId)).points[0]!;
    const evidenceA = uransEvidencePatch("concurrent-rans-upgrade-a");
    const evidenceB = {
      ...uransEvidencePatch("concurrent-rans-upgrade-b"),
      forceHistory: {
        ...uransEvidencePatch("concurrent-rans-upgrade-b").forceHistory,
        cl: [0.4, 0.72, 0.4, 0.72, 0.4],
        clMean: 0.56,
      },
    };

    const [responseA, responseB] = await Promise.all([
      postPolars(
        polarPayload(
          [
            makePoint(aoas[0], {
              ...evidenceA,
              engineJobId: `${PREFIX}-concurrent-rans-upgrade-a`,
            }),
          ],
          { promiseId, bcId: undefined },
        ),
      ),
      postPolars(
        polarPayload(
          [
            makePoint(aoas[0], {
              ...evidenceB,
              engineJobId: `${PREFIX}-concurrent-rans-upgrade-b`,
            }),
          ],
          { promiseId, bcId: undefined },
        ),
      ),
    ]);

    const bodies = [responseA.json(), responseB.json()] as Array<{
      conflictIds: string[];
      fulfilledAoas: number[];
      unfulfilledAoas: number[];
    }>;
    const accepted = bodies.filter((body) => body.conflictIds.length === 0);
    const conflicted = bodies.filter((body) => body.conflictIds.length === 1);
    expect(accepted).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      fulfilledAoas: [aoas[0]],
      unfulfilledAoas: [],
    });
    expect(conflicted[0]).toMatchObject({
      fulfilledAoas: [],
      unfulfilledAoas: [aoas[0]],
    });
    cleanupConflictIds.add(conflicted[0]!.conflictIds[0]!);
    const final = await readPromise(promiseId);
    expect(final.promise.status).toBe("active");
    expect(final.points[0]).toMatchObject({
      status: "fulfilled",
      resultId: ransPoint.resultId,
    });
    expect(final.points[0]!.resultAttemptId).not.toBe(
      ransPoint.resultAttemptId,
    );
    expect(final.points[1]).toMatchObject({ status: "active" });
    const canonical = await resultAt(aoas[0]);
    expect(canonical?.currentResultAttemptId).toBe(
      final.points[0]!.resultAttemptId,
    );
    expect(
      await db
        .select({ regime: resultAttempts.regime })
        .from(resultAttempts)
        .where(eq(resultAttempts.resultId, ransPoint.resultId!)),
    ).toHaveLength(2);
  });

  it.each([
    ["pending", 709.001],
    ["stale", 710.001],
  ] as const)(
    "promotes a %s no-truth placeholder at the same result id without a conflict",
    async (status, aoaDeg) => {
      const [placeholder] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId: legacyBcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          status,
          source: "queued",
          simJobId: null,
        })
        .returning({ id: results.id });
      const promiseId = await createPromise("active", aoaDeg);

      const pushed = await postPolars(
        polarPayload([makePoint(aoaDeg)], {
          promiseId,
          bcId: undefined,
        }),
      );
      expect(pushed.statusCode).toBe(200);
      expect(pushed.json()).toMatchObject({
        imported: 1,
        attempts: 1,
        conflictIds: [],
      });

      const promoted = await resultAt(aoaDeg);
      expect(promoted).toMatchObject({
        id: placeholder.id,
        status: "done",
        source: "solved",
        cl: 0.4 + aoaDeg / 10000,
        simJobId: null,
      });
      const attemptsForResult = await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.resultId, placeholder.id));
      expect(attemptsForResult).toHaveLength(1);
      expect((await readPromise(promiseId)).points).toMatchObject([
        { status: "fulfilled", resultId: placeholder.id },
      ]);
    },
  );

  it("round-trips accepted URANS classification evidence and fulfills only after result and attempt classify accepted", async () => {
    const aoaDeg = 712.001;
    const promiseId = await createPromise("active", aoaDeg);
    const evidence = uransEvidencePatch("accepted-round-trip");

    const pushed = await postPolars(
      polarPayload([makePoint(aoaDeg, evidence)], {
        promiseId,
        bcId: undefined,
      }),
    );

    expect(pushed.statusCode).toBe(200);
    expect(pushed.json()).toMatchObject({
      imported: 1,
      attempts: 1,
      fulfilledAoas: [aoaDeg],
      unfulfilledAoas: [],
    });
    const canonical = await resultAt(aoaDeg);
    expect(canonical).toMatchObject({
      fidelity: "urans_precalc",
      qualityWarnings: [],
      frameTrack: evidence.frameTrack,
      steadyHistory: evidence.steadyHistory,
      clStd: evidence.clStd,
      cdStd: evidence.cdStd,
      cmStd: evidence.cmStd,
      nCells: evidence.nCells,
    });
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, canonical!.id));
    expect(attempt).toMatchObject({
      qualityWarnings: [],
      clStd: evidence.clStd,
      cdStd: evidence.cdStd,
      cmStd: evidence.cmStd,
      nCells: evidence.nCells,
    });
    expect(attempt.evidencePayload).toMatchObject({
      fidelity: "urans_precalc",
      quality_warnings: [],
      frame_track: evidence.frameTrack,
      steady_history: evidence.steadyHistory,
    });
    const [history] = await db
      .select()
      .from(forceHistory)
      .where(eq(forceHistory.resultId, canonical!.id));
    expect(history).toMatchObject(evidence.forceHistory);
    expect(
      await db
        .select({ state: resultClassifications.state })
        .from(resultClassifications)
        .where(eq(resultClassifications.resultId, canonical!.id)),
    ).toEqual([{ state: "accepted" }]);
    expect(
      await db
        .select({ state: resultClassifications.state })
        .from(resultClassifications)
        .where(eq(resultClassifications.resultAttemptId, attempt.id)),
    ).toEqual([{ state: "accepted" }]);
    expect((await readPromise(promiseId)).points).toMatchObject([
      { status: "fulfilled", resultId: canonical!.id },
    ]);
    const repeated = await postPolars(
      polarPayload([makePoint(aoaDeg, evidence)], {
        promiseId,
        bcId: undefined,
      }),
    );
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({
      attempts: 0,
      conflictIds: [],
      fulfilledAoas: [aoaDeg],
    });
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.resultId, canonical!.id)),
    ).toHaveLength(1);
    expect(
      (
        await postJson(`/api/sync/v1/sweeps/${promiseId}/complete`, {
          accepted: true,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("retains a rejected URANS timeout on its attempt without publishing it", async () => {
    const aoaDeg = 713.001;
    const promiseId = await createPromise("active", aoaDeg);
    const timeoutWarning =
      "URANS integration stopped by the wall-clock budget guard: retained 1.4 of 3 periods (budget)";
    const evidence = uransEvidencePatch("timeout-round-trip", [timeoutWarning]);

    const pushed = await postPolars(
      polarPayload([makePoint(aoaDeg, evidence)], {
        promiseId,
        bcId: undefined,
      }),
    );

    expect(pushed.statusCode).toBe(200);
    expect(pushed.json()).toMatchObject({
      fulfilledAoas: [],
      terminalAoas: [aoaDeg],
      unfulfilledAoas: [],
    });
    const canonical = await resultAt(aoaDeg);
    const [attempt] = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, canonical!.id));
    expect(canonical).toMatchObject({
      status: "failed",
      currentResultAttemptId: null,
      qualityWarnings: null,
      fidelity: null,
      frameTrack: null,
    });
    expect(attempt.qualityWarnings).toEqual([timeoutWarning]);
    expect(attempt.evidencePayload).toMatchObject({
      quality_warnings: [timeoutWarning],
      fidelity: "urans_precalc",
      frame_track: evidence.frameTrack,
    });
    const [canonicalClassification] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultId, canonical!.id));
    const [attemptClassification] = await db
      .select()
      .from(resultClassifications)
      .where(eq(resultClassifications.resultAttemptId, attempt.id));
    expect(canonicalClassification).toMatchObject({
      state: "rejected",
      resultAttemptId: null,
      reasons: expect.arrayContaining(["missing-coefficients"]),
    });
    expect(attemptClassification).toMatchObject({
      state: "rejected",
      reasons: expect.arrayContaining(["incomplete-urans-integration"]),
    });
    expect((await readPromise(promiseId)).points).toMatchObject([
      {
        status: "cancelled",
        resultId: canonical!.id,
        resultAttemptId: attempt.id,
      },
    ]);
    const replayed = await postPolars(
      polarPayload([makePoint(aoaDeg, evidence)], {
        promiseId,
        bcId: undefined,
      }),
    );
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.json()).toMatchObject({
      attempts: 0,
      conflictIds: [],
      fulfilledAoas: [],
      terminalAoas: [aoaDeg],
      unfulfilledAoas: [],
    });
    const completed = await postJson(
      `/api/sync/v1/sweeps/${promiseId}/complete`,
      { accepted: false, terminalEvidenceReported: true },
    );
    expect(completed.statusCode, completed.body).toBe(409);
    expect(completed.json()).toMatchObject({
      error: "promise still has points without imported solver evidence",
      unfulfilledPointCount: 1,
    });
    const cancelled = await postJson(
      `/api/sync/v1/sweeps/${promiseId}/cancel`,
      { terminalEvidenceReported: true },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const settled = await readPromise(promiseId);
    expect(settled.promise.status).toBe("cancelled");
    expect(settled.points).toMatchObject([
      {
        status: "cancelled",
        resultId: canonical!.id,
        resultAttemptId: attempt.id,
      },
    ]);
  });

  it("skips an evidence-backed terminal cell but reclaims a plain cancelled promise", async () => {
    const terminalPromiseId = await createPromise("active", [
      TERMINAL_GAP_AOA,
      TERMINAL_ACCEPTED_AOA,
    ]);
    const terminalEvidence = uransEvidencePatch("terminal-gap", [
      "URANS integration stopped by the wall-clock budget guard before a stable period window",
    ]);
    const terminalPush = await postPolars(
      polarPayload(
        [
          makePoint(TERMINAL_GAP_AOA, terminalEvidence),
          makePoint(TERMINAL_ACCEPTED_AOA),
        ],
        {
          promiseId: terminalPromiseId,
          bcId: undefined,
        },
      ),
    );
    expect(terminalPush.statusCode, terminalPush.body).toBe(200);
    expect(terminalPush.json()).toMatchObject({
      fulfilledAoas: [TERMINAL_ACCEPTED_AOA],
      terminalAoas: [TERMINAL_GAP_AOA],
      unfulfilledAoas: [],
    });
    const terminalComplete = await postJson(
      `/api/sync/v1/sweeps/${terminalPromiseId}/complete`,
      { terminalEvidenceReported: true },
    );
    expect(terminalComplete.statusCode, terminalComplete.body).toBe(409);
    const terminalCancelled = await postJson(
      `/api/sync/v1/sweeps/${terminalPromiseId}/cancel`,
      { terminalEvidenceReported: true },
    );
    expect(terminalCancelled.statusCode, terminalCancelled.body).toBe(200);
    const terminalPromise = await readPromise(terminalPromiseId);
    expect(terminalPromise.promise.status).toBe("cancelled");
    expect(terminalPromise.points).toMatchObject([
      {
        aoaDeg: TERMINAL_GAP_AOA,
        status: "cancelled",
        resultId: expect.any(String),
        resultAttemptId: expect.any(String),
      },
      {
        aoaDeg: TERMINAL_ACCEPTED_AOA,
        status: "fulfilled",
        resultId: expect.any(String),
        resultAttemptId: expect.any(String),
      },
    ]);

    const cancelledPromiseId = await createPromise("active", CANCELLED_GAP_AOA);
    const cancelled = await postJson(
      `/api/sync/v1/sweeps/${cancelledPromiseId}/cancel`,
      {},
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(await resultAt(CANCELLED_GAP_AOA)).toBeNull();

    await db
      .update(simulationPresets)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(simulationPresets.id, presetId));
    try {
      const claim = await postJson("/api/sync/v1/sweeps/claim", {
        limit: 1,
        sourceInstanceId: `${PREFIX}-terminal-gap-claimer`,
      });
      expect(claim.statusCode, claim.body).toBe(200);
      const claimedPromise = claim.json().promise as {
        id: string;
        aoas: number[];
        airfoil: { id: string };
        setupRevision: { id: string };
      };
      cleanupPromiseIds.add(claimedPromise.id);
      expect(claimedPromise).toMatchObject({
        aoas: [CANCELLED_GAP_AOA],
        airfoil: { id: airfoilId },
        setupRevision: { id: revisionId },
      });
    } finally {
      await db
        .update(simulationPresets)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(simulationPresets.id, presetId));
    }

    expect(await resultAt(TERMINAL_GAP_AOA)).toMatchObject({
      status: "failed",
      currentResultAttemptId: null,
    });
    expect((await readPromise(cancelledPromiseId)).points).toMatchObject([
      { status: "cancelled", resultId: null, resultAttemptId: null },
    ]);
  });

  it("retains a rejected URANS continuation without erasing its needs_urans RANS pointer", async () => {
    const hardFailureAoa = 0.25;
    const provisionalAoa = 1.25;
    const promiseId = await createPromise("active", [
      hardFailureAoa,
      provisionalAoa,
    ]);
    const marchedEngineJobId = `${PREFIX}-terminal-continuation-rans`;
    const ransPush = await postPolars(
      polarPayload(
        [
          makePoint(hardFailureAoa, {
            engineJobId: marchedEngineJobId,
            converged: false,
            stalled: true,
          }),
          makePoint(provisionalAoa, {
            engineJobId: marchedEngineJobId,
          }),
        ],
        { promiseId, bcId: undefined },
      ),
    );
    expect(ransPush.statusCode, ransPush.body).toBe(200);
    expect(ransPush.json()).toMatchObject({
      fulfilledAoas: [],
      terminalAoas: [hardFailureAoa, provisionalAoa],
      unfulfilledAoas: [],
    });
    const before = await readPromise(promiseId);
    const provisionalPoint = before.points.find(
      (point) => point.aoaDeg === provisionalAoa,
    )!;
    const provisionalResult = await resultAt(provisionalAoa);
    expect(provisionalPoint.status).toBe("cancelled");
    expect(provisionalResult?.currentResultAttemptId).toBe(
      provisionalPoint.resultAttemptId,
    );
    const [provisionalClassification] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(
        eq(
          resultClassifications.resultAttemptId,
          provisionalPoint.resultAttemptId!,
        ),
      )
      .limit(1);
    expect(provisionalClassification?.state).toBe("needs_urans");

    const failedUrans = uransEvidencePatch("terminal-continuation-urans", [
      "URANS integration stopped by the wall-clock budget guard: retained 1.4 of 3 periods (budget)",
    ]);
    const childPush = await postPolars(
      polarPayload(
        [
          makePoint(provisionalAoa, {
            ...failedUrans,
            engineJobId: `${PREFIX}-terminal-continuation-urans`,
          }),
        ],
        { promiseId, bcId: undefined },
      ),
    );
    expect(childPush.statusCode, childPush.body).toBe(200);
    expect(childPush.json()).toMatchObject({
      fulfilledAoas: [],
      terminalAoas: [provisionalAoa],
      unfulfilledAoas: [],
    });

    const canonical = await resultAt(provisionalAoa);
    expect(canonical).toMatchObject({
      status: "done",
      currentResultAttemptId: provisionalPoint.resultAttemptId,
    });
    const after = await readPromise(promiseId);
    expect(
      after.points.find((point) => point.aoaDeg === provisionalAoa),
    ).toMatchObject({
      status: "cancelled",
      resultId: provisionalPoint.resultId,
      resultAttemptId: provisionalPoint.resultAttemptId,
    });
    const attempts = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, canonical!.id));
    expect(attempts).toHaveLength(2);
    const childAttempt = attempts.find(
      (attempt) => attempt.id !== provisionalPoint.resultAttemptId,
    );
    const [rejectedChild] = await db
      .select({ state: resultClassifications.state })
      .from(resultClassifications)
      .where(eq(resultClassifications.resultAttemptId, childAttempt!.id))
      .limit(1);
    expect(rejectedChild?.state).toBe("rejected");
  });

  it("rejects malformed force history before writing solver evidence", async () => {
    const aoaDeg = 716.001;
    const promiseId = await createPromise("active", aoaDeg);
    const evidence = uransEvidencePatch("malformed-history");
    const malformed = {
      ...evidence,
      forceHistory: {
        ...evidence.forceHistory,
        t: [0, 0],
        cl: [0.4, 0.5],
        cd: [0.02],
        cm: null,
      },
    };

    const pushed = await postPolars(
      polarPayload([makePoint(aoaDeg, malformed)], {
        promiseId,
        bcId: undefined,
      }),
    );

    expect(pushed.statusCode).toBeGreaterThanOrEqual(400);
    expect(pushed.statusCode).toBeLessThan(500);
    expect(await resultAt(aoaDeg)).toBeNull();
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(
          and(
            eq(resultAttempts.airfoilId, airfoilId),
            eq(resultAttempts.simulationPresetRevisionId, revisionId),
            eq(resultAttempts.aoaDeg, aoaDeg),
          ),
        ),
    ).toHaveLength(0);
    expect((await readPromise(promiseId)).points).toMatchObject([
      { status: "active", resultId: null },
    ]);
  });

  it.each([
    ["missing", undefined, 718.001],
    ["ambiguous", "bad:source", 719.001],
  ] as const)(
    "rejects a %s direct-push source identity before writing evidence",
    async (_label, sourceInstanceId, aoaDeg) => {
      const pushed = await postPolars(
        polarPayload([makePoint(aoaDeg)], { sourceInstanceId }),
      );

      expect(pushed.statusCode).toBe(409);
      expect(await resultAt(aoaDeg)).toBeNull();
      expect(
        await db
          .select()
          .from(resultAttempts)
          .where(
            and(
              eq(resultAttempts.airfoilId, airfoilId),
              eq(resultAttempts.simulationPresetRevisionId, revisionId),
              eq(resultAttempts.aoaDeg, aoaDeg),
            ),
          ),
      ).toHaveLength(0);
    },
  );

  it("turns a force-history mismatch into a reviewable conflict without overwriting canonical evidence", async () => {
    const aoaDeg = 714.001;
    const evidence = uransEvidencePatch("force-history-conflict");
    expect(
      (await postPolars(polarPayload([makePoint(aoaDeg, evidence)])))
        .statusCode,
    ).toBe(200);
    const canonical = await resultAt(aoaDeg);
    const [beforeHistory] = await db
      .select()
      .from(forceHistory)
      .where(eq(forceHistory.resultId, canonical!.id));
    const beforeAttempts = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, canonical!.id));
    const promiseId = await createPromise("active", aoaDeg);
    const altered = {
      ...evidence,
      forceHistory: {
        ...evidence.forceHistory,
        cl: [0.4, 0.8, 0.4, 0.8, 0.4],
        clMean: 0.6,
      },
    };

    const pushed = await postPolars(
      polarPayload([makePoint(aoaDeg, altered)], {
        promiseId,
        bcId: undefined,
      }),
    );

    expect(pushed.statusCode).toBe(200);
    const body = pushed.json() as {
      conflictIds: string[];
      fulfilledAoas: number[];
      unfulfilledAoas: number[];
    };
    expect(body.conflictIds).toHaveLength(1);
    cleanupConflictIds.add(body.conflictIds[0]);
    expect(body.fulfilledAoas).toEqual([]);
    expect(body.unfulfilledAoas).toEqual([aoaDeg]);
    expect(
      await db
        .select()
        .from(forceHistory)
        .where(eq(forceHistory.resultId, canonical!.id)),
    ).toEqual([beforeHistory]);
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.resultId, canonical!.id)),
    ).toHaveLength(beforeAttempts.length);
    expect((await readPromise(promiseId)).points).toMatchObject([
      { status: "active", resultId: null },
    ]);
  });

  it("turns a same-role media checksum mismatch into a conflict without replacing stored bytes", async () => {
    const aoaDeg = 715.001;
    const evidence = uransEvidencePatch("media-conflict");
    expect(
      (await postPolars(polarPayload([makePoint(aoaDeg, evidence)])))
        .statusCode,
    ).toBe(200);
    const canonical = await resultAt(aoaDeg);
    const [beforeMedia] = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultId, canonical!.id));
    const beforeAttempts = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, canonical!.id));
    const promiseId = await createPromise("active", aoaDeg);
    const alteredBytes = bytesItem("video:media-conflict-altered", "video/mp4");
    const altered = {
      ...evidence,
      media: [{ ...evidence.media[0], ...alteredBytes }],
    };

    const pushed = await postPolars(
      polarPayload([makePoint(aoaDeg, altered)], {
        promiseId,
        bcId: undefined,
      }),
    );

    expect(pushed.statusCode).toBe(200);
    const body = pushed.json() as {
      conflictIds: string[];
      fulfilledAoas: number[];
      unfulfilledAoas: number[];
    };
    expect(body.conflictIds).toHaveLength(1);
    cleanupConflictIds.add(body.conflictIds[0]);
    expect(body.fulfilledAoas).toEqual([]);
    expect(body.unfulfilledAoas).toEqual([aoaDeg]);
    expect(
      await db
        .select()
        .from(resultMedia)
        .where(eq(resultMedia.resultId, canonical!.id)),
    ).toEqual([beforeMedia]);
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(eq(resultAttempts.resultId, canonical!.id)),
    ).toHaveLength(beforeAttempts.length);
    expect((await readPromise(promiseId)).points).toMatchObject([
      { status: "active", resultId: null },
    ]);
  });

  it("serializes concurrent differing evidence so one complete point wins and the other becomes a conflict", async () => {
    const aoaDeg = 717.001;
    const promiseId = await createPromise("active", aoaDeg);
    const evidenceA = uransEvidencePatch("concurrent-evidence");
    const alternateBytes = bytesItem(
      "video:concurrent-evidence-alternate",
      "video/mp4",
    );
    const evidenceB = {
      ...evidenceA,
      forceHistory: {
        ...evidenceA.forceHistory,
        cl: [0.4, 0.7, 0.4, 0.7, 0.4],
        clMean: 0.55,
      },
      media: [{ ...evidenceA.media[0], ...alternateBytes }],
    };

    const [responseA, responseB] = await Promise.all([
      postPolars(
        polarPayload([makePoint(aoaDeg, evidenceA)], {
          promiseId,
          bcId: undefined,
        }),
      ),
      postPolars(
        polarPayload([makePoint(aoaDeg, evidenceB)], {
          promiseId,
          bcId: undefined,
        }),
      ),
    ]);

    expect(responseA.statusCode).toBe(200);
    expect(responseB.statusCode).toBe(200);
    const bodies = [responseA.json(), responseB.json()] as Array<{
      conflictIds: string[];
      fulfilledAoas: number[];
      unfulfilledAoas: number[];
    }>;
    const accepted = bodies.filter((body) => body.conflictIds.length === 0);
    const conflicted = bodies.filter((body) => body.conflictIds.length === 1);
    expect(accepted).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
    expect(accepted[0].fulfilledAoas).toEqual([aoaDeg]);
    expect(conflicted[0].unfulfilledAoas).toEqual([aoaDeg]);
    cleanupConflictIds.add(conflicted[0].conflictIds[0]);

    const canonical = await resultAt(aoaDeg);
    const attemptsForResult = await db
      .select()
      .from(resultAttempts)
      .where(eq(resultAttempts.resultId, canonical!.id));
    const [storedHistory] = await db
      .select()
      .from(forceHistory)
      .where(eq(forceHistory.resultId, canonical!.id));
    const [storedMedia] = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultId, canonical!.id));
    expect(attemptsForResult).toHaveLength(1);
    const aWon = storedHistory.clMean === evidenceA.forceHistory.clMean;
    expect(storedHistory.clMean).toBe(
      aWon ? evidenceA.forceHistory.clMean : evidenceB.forceHistory.clMean,
    );
    expect(storedMedia.sha256).toBe(
      aWon ? evidenceA.media[0].sha256 : evidenceB.media[0].sha256,
    );
    expect((await readPromise(promiseId)).points).toMatchObject([
      { status: "fulfilled", resultId: canonical!.id },
    ]);
    expect(
      (
        await postJson(`/api/sync/v1/sweeps/${promiseId}/complete`, {
          concurrentWinner: true,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("rejects a mixed owned/foreign batch before any point, artifact, media, attempt, or field-scale write", async () => {
    const promisedAoa = 711.001;
    const untouchedPromisedAoa = 711.251;
    const unpromisedAoa = 711.501;
    const promiseId = await createPromise("active", [
      promisedAoa,
      untouchedPromisedAoa,
    ]);
    const field = `${PREFIX}-atomic-mixed-pressure`;
    const artifact = artifactItem("atomic-mixed");
    const media = mediaItem("atomic-mixed");

    const pushed = await postPolars(
      polarPayload(
        [
          makePoint(promisedAoa, {
            evidenceArtifacts: [artifact],
            media: [media],
          }),
          makePoint(unpromisedAoa),
        ],
        {
          promiseId,
          bcId: undefined,
          fieldColorScales: [
            {
              field,
              vmin: -1,
              vmax: 1,
              evidenceSignature: `${PREFIX}-atomic-mixed-signature`,
              renderProfileKey: "default:v1:zoom2",
              version: 1,
            },
          ],
        },
      ),
    );

    expect(pushed.statusCode).toBe(409);
    expect(await resultAt(promisedAoa)).toBeNull();
    expect(await resultAt(unpromisedAoa)).toBeNull();
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(
          and(
            eq(resultAttempts.airfoilId, airfoilId),
            eq(resultAttempts.simulationPresetRevisionId, revisionId),
            inArray(resultAttempts.aoaDeg, [promisedAoa, unpromisedAoa]),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.sha256, artifact.sha256)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(resultMedia)
        .where(eq(resultMedia.sha256, media.sha256)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(fieldColorScales)
        .where(
          and(
            eq(fieldColorScales.simulationPresetRevisionId, revisionId),
            eq(fieldColorScales.field, field),
          ),
        ),
    ).toHaveLength(0);
    expect((await readPromise(promiseId)).points).toMatchObject([
      { aoaDeg: promisedAoa, status: "active", resultId: null },
      { aoaDeg: untouchedPromisedAoa, status: "active", resultId: null },
    ]);
  });

  it("accepts late chunks for fulfilled promises but rejects cancelled promises without writing a result", async () => {
    const fulfilledPromiseId = await createPromise("fulfilled", 705.001);
    const late = await postPolars(
      polarPayload([makePoint(705.001)], {
        promiseId: fulfilledPromiseId,
        bcId: undefined,
      }),
    );
    expect(late.statusCode).toBe(200);
    expect(await resultAt(705.001)).toMatchObject({
      aoaDeg: 705.001,
      bcId: legacyBcId,
    });

    const cancelledPromiseId = await createPromise("cancelled", 706.001);
    const rejected = await postPolars(
      polarPayload([makePoint(706.001)], {
        promiseId: cancelledPromiseId,
        bcId: undefined,
      }),
    );
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
    expect(await resultAt(706.001)).toBeNull();
  });

  it("accepts and exactly replays a production-shaped multipart polar with 3,628 uploaded evidence files", async () => {
    const aoaDeg = 720.001;
    const uploadCount = 3_628;
    const sharedBytes = Buffer.from(`${PREFIX}:multipart-3628-shared-blob`);
    const artifacts = Array.from({ length: uploadCount }, (_, index) =>
      multipartArtifact(`production_file_${index}`, sharedBytes, index),
    );
    const payload = polarPayload([
      makePoint(aoaDeg, { evidenceArtifacts: artifacts }),
    ]);
    const parts: MultipartTestPart[] = [
      multipartManifestPart(payload),
      ...Array.from({ length: uploadCount }, (_, index) =>
        multipartFilePart(`production_file_${index}`, sharedBytes),
      ),
    ];
    const before = mediaFilePaths();

    const accepted = await postMultipartPolars(parts);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      imported: 1,
      attempts: 1,
      artifacts: uploadCount,
      conflictIds: [],
    });
    const canonical = await resultAt(aoaDeg);
    expect(canonical?.id).toBeTruthy();
    const stored = await db
      .select({
        id: solverEvidenceArtifacts.id,
        resultAttemptId: solverEvidenceArtifacts.resultAttemptId,
      })
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.resultId, canonical!.id));
    expect(stored).toHaveLength(uploadCount);
    expect(new Set(stored.map((row) => row.resultAttemptId)).size).toBe(1);
    const afterAccepted = mediaFilePaths();
    expect(afterAccepted.filter((path) => path.includes("/tmp/"))).toEqual([]);
    expect(afterAccepted.filter((path) => !before.includes(path))).toHaveLength(
      1,
    );

    const replayed = await postMultipartPolars(parts);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toMatchObject({
      imported: 0,
      attempts: 0,
      artifacts: uploadCount,
      conflictIds: [],
    });
    expect(mediaFilePaths()).toEqual(afterAccepted);
    expect(
      await db
        .select({ id: solverEvidenceArtifacts.id })
        .from(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.resultId, canonical!.id)),
    ).toHaveLength(uploadCount);
  }, 120_000);

  it("rejects changed API artifact association metadata while allowing identical bytes for another owner", async () => {
    const firstAoa = 720.101;
    const secondAoa = 720.102;
    const shared = {
      ...artifactItem("shared-api-association"),
      metadata: { immutable: "v1" },
    };
    const first = await postPolars(
      polarPayload([makePoint(firstAoa, { evidenceArtifacts: [shared] })]),
    );
    expect(first.statusCode).toBe(200);
    const firstResult = await resultAt(firstAoa);
    const [firstAssociation] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.resultId, firstResult!.id));
    expect(firstAssociation.metadata).toMatchObject({ immutable: "v1" });

    const changed = await postPolars(
      polarPayload([
        makePoint(firstAoa, {
          evidenceArtifacts: [
            { ...shared, metadata: { immutable: "changed" } },
          ],
        }),
      ]),
    );
    expect(changed.statusCode).toBe(200);
    const changedBody = changed.json() as { conflictIds: string[] };
    expect(changedBody.conflictIds).toHaveLength(1);
    cleanupConflictIds.add(changedBody.conflictIds[0]);
    expect(
      (
        await db
          .select()
          .from(solverEvidenceArtifacts)
          .where(eq(solverEvidenceArtifacts.id, firstAssociation.id))
      )[0].metadata,
    ).toMatchObject({ immutable: "v1" });

    const second = await postPolars(
      polarPayload([makePoint(secondAoa, { evidenceArtifacts: [shared] })]),
    );
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ conflictIds: [], imported: 1 });
    const associations = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.sha256, shared.sha256));
    expect(associations).toHaveLength(2);
    expect(new Set(associations.map((row) => row.resultId))).toEqual(
      new Set([firstResult!.id, (await resultAt(secondAoa))!.id]),
    );
  });

  it("enforces manifest-first ordering, declarations, exact sizes, duplicate fields, file count, and disk reserve", async () => {
    const bytes = Buffer.from(`${PREFIX}:multipart-contract`);
    const artifact = multipartArtifact("contract_file", bytes, 0);
    const payload = polarPayload([
      makePoint(720.201, { evidenceArtifacts: [artifact] }),
    ]);

    await expectMultipartFailureCleansFiles({
      statusCode: 400,
      error: /manifest must be the first part/i,
      parts: [
        multipartFilePart("contract_file", bytes),
        multipartManifestPart(payload),
      ],
    });

    await expectMultipartFailureCleansFiles({
      statusCode: 400,
      error: /not declared by the manifest/i,
      parts: [
        multipartManifestPart(polarPayload([makePoint(720.202)])),
        multipartFilePart("undeclared_file", bytes),
      ],
    });

    await expectMultipartFailureCleansFiles({
      statusCode: 400,
      error: /repeats upload field/i,
      parts: [
        multipartManifestPart(
          polarPayload([
            makePoint(720.203, {
              evidenceArtifacts: [
                artifact,
                { ...artifact, kind: "log", field: "duplicate" },
              ],
            }),
          ]),
        ),
      ],
    });

    await expectMultipartFailureCleansFiles({
      statusCode: 400,
      error: /repeats upload field/i,
      parts: [
        multipartManifestPart(payload),
        multipartFilePart("contract_file", bytes),
        multipartFilePart("contract_file", bytes),
      ],
    });

    await expectMultipartFailureCleansFiles({
      statusCode: 400,
      error: /does not match its declared byteSize/i,
      parts: [
        multipartManifestPart(
          polarPayload([
            makePoint(720.204, {
              evidenceArtifacts: [
                { ...artifact, byteSize: bytes.byteLength + 1 },
              ],
            }),
          ]),
        ),
        multipartFilePart("contract_file", bytes),
      ],
    });

    await expectMultipartFailureCleansFiles({
      statusCode: 400,
      error: /missing multipart upload field/i,
      parts: [multipartManifestPart(payload)],
    });

    const zeroSha = "0".repeat(64);
    const tooMany = Array.from({ length: 8_193 }, (_, index) => ({
      kind: index === 0 ? "manifest" : "log",
      role: "raw",
      uploadField: `f${index}`,
      mimeType: "application/json",
      sha256: zeroSha,
      byteSize: 0,
    }));
    await expectMultipartFailureCleansFiles({
      statusCode: 400,
      error: /more than 8192 artifact\/media items/i,
      parts: [
        multipartManifestPart(
          polarPayload([makePoint(720.205, { evidenceArtifacts: tooMany })]),
        ),
      ],
    });

    expect(() =>
      assertMultipartDiskReserveAvailableBytes(
        new Map([["declared", bytes.byteLength]]),
        0n,
      ),
    ).toThrow(/insufficient free disk.*safety reserve/i);
  }, 120_000);

  it("rejects multipart uploads over the cumulative decoded-byte quota and removes every staged file", async () => {
    const aoaDeg = 721.001;
    const first = Buffer.alloc(
      Math.floor(TEST_MULTIPART_UPLOAD_LIMIT_BYTES / 2) + 1,
      0x61,
    );
    const second = Buffer.alloc(
      Math.floor(TEST_MULTIPART_UPLOAD_LIMIT_BYTES / 2) + 1,
      0x62,
    );
    const artifacts = [
      multipartArtifact("quota_first", first, 0),
      multipartArtifact("quota_second", second, 1),
    ];
    await expectMultipartFailureCleansFiles({
      aoaDeg,
      statusCode: 413,
      error: /upload|quota|bytes|large/i,
      parts: [
        multipartManifestPart(
          polarPayload([makePoint(aoaDeg, { evidenceArtifacts: artifacts })]),
        ),
        multipartFilePart("quota_first", first),
        multipartFilePart("quota_second", second),
      ],
    });
  });

  it("caps the multipart manifest before accepting any uploaded file", async () => {
    const aoaDeg = 722.001;
    const staged = Buffer.from(`${PREFIX}:manifest-cap-staged-file`);
    const artifact = multipartArtifact("manifest_cap_staged", staged, 0);
    const oversized = polarPayload(
      [makePoint(aoaDeg, { evidenceArtifacts: [artifact] })],
      { padding: "x".repeat(TEST_MULTIPART_MANIFEST_LIMIT_BYTES) },
    );
    await expectMultipartFailureCleansFiles({
      aoaDeg,
      statusCode: 413,
      error: /manifest|field|large|limit/i,
      parts: [
        multipartManifestPart(oversized),
        multipartFilePart("manifest_cap_staged", staged),
      ],
    });
  });

  it("removes uploaded files when multipart parsing or manifest schema validation fails", async () => {
    const parseBytes = Buffer.from(`${PREFIX}:multipart-parse-failure`);
    await expectMultipartFailureCleansFiles({
      parts: [
        multipartManifestPart("{not valid json"),
        multipartFilePart("parse_failure_file", parseBytes),
      ],
    });

    const schemaBytes = Buffer.from(`${PREFIX}:multipart-schema-failure`);
    await expectMultipartFailureCleansFiles({
      statusCode: 400,
      parts: [
        multipartManifestPart(
          polarPayload([], { sourceInstanceId: `${PREFIX}-source` }),
        ),
        multipartFilePart("schema_failure_file", schemaBytes),
      ],
    });
  });

  it("removes uploaded evidence when its data-type permission rejects the parsed request", async () => {
    const aoaDeg = 723.001;
    const bytes = Buffer.from(`${PREFIX}:multipart-permission-failure`);
    const artifact = multipartArtifact("permission_failure_file", bytes, 0);
    await db
      .update(syncApiPermissions)
      .set({ canPush: false, updatedAt: new Date() })
      .where(eq(syncApiPermissions.dataType, "evidence_artifacts"));
    try {
      await expectMultipartFailureCleansFiles({
        aoaDeg,
        statusCode: 403,
        error: /push disabled for evidence_artifacts/i,
        parts: [
          multipartManifestPart(
            polarPayload([
              makePoint(aoaDeg, { evidenceArtifacts: [artifact] }),
            ]),
          ),
          multipartFilePart("permission_failure_file", bytes),
        ],
      });
    } finally {
      await db
        .update(syncApiPermissions)
        .set({ canPush: true, updatedAt: new Date() })
        .where(eq(syncApiPermissions.dataType, "evidence_artifacts"));
    }
  });

  it("removes uploaded media when exact-attempt evidence binding rejects it", async () => {
    const aoaDeg = 724.001;
    const bytes = Buffer.from(`${PREFIX}:multipart-unbound-media`);
    const media = {
      kind: "image",
      field: "pressure_unbound_multipart",
      role: "instantaneous",
      width: 2,
      height: 2,
      mimeType: "image/png",
      uploadField: "unbound_media_file",
      sha256: sha256(bytes),
      byteSize: bytes.byteLength,
    };
    await expectMultipartFailureCleansFiles({
      aoaDeg,
      statusCode: 409,
      error: /lacks an exact-attempt manifest/i,
      unreferencedSha256: sha256(bytes),
      parts: [
        multipartManifestPart(
          polarPayload([
            makePoint(aoaDeg, { evidenceArtifacts: [], media: [media] }),
          ]),
        ),
        multipartFilePart("unbound_media_file", bytes, "image/png"),
      ],
    });
  });

  it("removes uploaded evidence when canonical import resolves to a conflict", async () => {
    const aoaDeg = 725.001;
    const initial = await postPolars(polarPayload([makePoint(aoaDeg)]));
    expect(initial.statusCode).toBe(200);
    const bytes = Buffer.from(`${PREFIX}:multipart-import-conflict`);
    const artifact = multipartArtifact("import_conflict_file", bytes, 0);
    const before = mediaFilePaths();
    const conflicted = await postMultipartPolars([
      multipartManifestPart(
        polarPayload([
          makePoint(aoaDeg, {
            cl: 9.99,
            evidenceArtifacts: [artifact],
          }),
        ]),
      ),
      multipartFilePart("import_conflict_file", bytes),
    ]);
    expect(conflicted.statusCode).toBe(200);
    const body = conflicted.json() as {
      imported: number;
      conflictIds: string[];
    };
    expect(body.imported).toBe(0);
    expect(body.conflictIds).toHaveLength(1);
    cleanupConflictIds.add(body.conflictIds[0]);
    expect(mediaFilePaths()).toEqual(before);
    expect(
      await db
        .select({ id: solverEvidenceArtifacts.id })
        .from(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.sha256, sha256(bytes))),
    ).toHaveLength(0);
  });

  it("cleans staged legacy JSON/base64 bytes after invalid evidence and after a conflict", async () => {
    const invalidAoa = 726.001;
    const invalid = artifactItem("legacy-json-invalid");
    const beforeInvalid = mediaFilePaths();
    const rejected = await postPolars(
      polarPayload([
        makePoint(invalidAoa, {
          evidenceArtifacts: [{ ...invalid, sha256: "0".repeat(64) }],
        }),
      ]),
    );
    expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
    expect(await resultAt(invalidAoa)).toBeNull();
    expect(mediaFilePaths()).toEqual(beforeInvalid);

    const conflictAoa = 726.101;
    expect(
      (await postPolars(polarPayload([makePoint(conflictAoa)]))).statusCode,
    ).toBe(200);
    const beforeConflict = mediaFilePaths();
    const conflictArtifact = artifactItem("legacy-json-conflict");
    const conflicted = await postPolars(
      polarPayload([
        makePoint(conflictAoa, {
          cl: 9.123,
          evidenceArtifacts: [conflictArtifact],
        }),
      ]),
    );
    expect(conflicted.statusCode).toBe(200);
    const body = conflicted.json() as { conflictIds: string[] };
    expect(body.conflictIds).toHaveLength(1);
    cleanupConflictIds.add(body.conflictIds[0]);
    expect(mediaFilePaths()).toEqual(beforeConflict);
    expect(
      await db
        .select()
        .from(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.sha256, conflictArtifact.sha256)),
    ).toHaveLength(0);
  });

  it("fails closed on low statfs reserve before staging legacy JSON/base64 evidence", async () => {
    const aoaDeg = 726.201;
    const artifact = artifactItem("legacy-json-low-disk");
    const before = mediaFilePaths();
    statfsControl.paths = [];
    statfsControl.availableBytes = 0n;
    let response: Awaited<ReturnType<typeof postPolars>>;
    try {
      response = await postPolars(
        polarPayload([makePoint(aoaDeg, { evidenceArtifacts: [artifact] })]),
      );
    } finally {
      statfsControl.availableBytes = null;
    }

    expect(response.statusCode).toBe(507);
    expect(response.json()).toMatchObject({
      error: expect.stringMatching(/insufficient free disk.*safety reserve/i),
    });
    expect(mediaFilePaths()).toEqual(before);
    expect(statfsControl.paths).toEqual([join(MEDIA_DIR, "sync-imports")]);
    expect(await resultAt(aoaDeg)).toBeNull();
    expect(
      await db
        .select()
        .from(resultAttempts)
        .where(
          and(
            eq(resultAttempts.airfoilId, airfoilId),
            eq(resultAttempts.simulationPresetRevisionId, revisionId),
            eq(resultAttempts.aoaDeg, aoaDeg),
          ),
        ),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.sha256, artifact.sha256)),
    ).toHaveLength(0);
  });
});
