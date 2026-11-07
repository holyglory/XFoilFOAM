import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  createClient,
  analysisContentHash,
  forceHistory,
  flowConditions,
  referenceGeometryProfiles,
  meshProfiles,
  solverProfiles,
  schedulingProfiles,
  outputProfiles,
  sweepDefinitions,
  simulationPresets,
  mediums,
  resultAttempts,
  resultClassifications,
  results,
  simJobs,
  simulationPresetRevisions,
  solverEvidenceArchives,
  solverEvidenceArtifactMembers,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
} from "@aerodb/db";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import type {
  EngineClient,
  EngineEvidenceArtifact,
  JobResult,
  PolarPoint,
  VerifyRemoteEvidenceManifestRequest,
  VerifyRemoteEvidenceManifestResponse,
} from "@aerodb/engine-client";
import { and, eq, inArray, like } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { ingestResult, registerEvidenceArtifacts } from "../src/ingest";
import { claimJobForIngest } from "../src/ingest-lease";
import {
  parseEvidenceMigrationReceipt,
  planEvidenceMigrationReceipt,
  registerEvidenceMigrationReceipt,
} from "../src/evidence-storage-backfill";

const { db, sql } = createClient({ max: 2 });
let replayQueries: Record<string, number> | null = null;
sql.options.debug = (_connection, query) => {
  if (!replayQueries) return;
  replayQueries.total = (replayQueries.total ?? 0) + 1;
  const operation = query.trim().split(/\s+/, 1)[0].toLowerCase();
  for (const table of ["solver_evidence_artifacts", "solver_evidence_artifact_members"])
    if (query.includes(`"${table}"`)) {
      const key = `${table}:${operation}`;
      replayQueries[key] = (replayQueries[key] ?? 0) + 1;
    }
};
const PREFIX = `evidence-gcs-ingest-${process.pid}-${Date.now().toString(36)}`;
const BUCKET = "airfoils-pro-storage-bucket";
const EXACT_GCS_GENERATION = "18446744073709551615";
const verifyRemoteEvidenceManifest =
  vi.fn<
    (
      request: VerifyRemoteEvidenceManifestRequest,
    ) => Promise<VerifyRemoteEvidenceManifestResponse>
  >();
const ENGINE = {
  baseUrl: "http://engine.test",
  verifyRemoteEvidenceManifest,
} as unknown as EngineClient;

const sha256 = (value: string): string =>
  createHash("sha256").update(`${PREFIX}:${value}`).digest("hex");

interface OwnerFixture {
  categoryId: string;
  airfoilId: string;
  bcId: string;
  simJobId: string;
  engineJobId: string;
  caseSlug: string;
  resultId: string;
  resultAttemptId: string;
  evidenceBase: string;
  point: PolarPoint;
}

let fixture: OwnerFixture | null = null;
let mediumId = "";
let replayPresetId: string | null = null;
const replayProfiles: Array<{ id: string; table: typeof flowConditions | typeof referenceGeometryProfiles |
  typeof boundaryProfiles | typeof meshProfiles | typeof solverProfiles | typeof schedulingProfiles |
  typeof outputProfiles | typeof sweepDefinitions }> = [];

async function createReplayRevision(owner: OwnerFixture) {
  const [medium] = await db.select().from(mediums).where(eq(mediums.id, mediumId));
  const [condition] = await db.select().from(boundaryConditions).where(eq(boundaryConditions.id, owner.bcId));
  const [flow] = await db.insert(flowConditions).values({
    slug: `${owner.engineJobId}-flow`, name: "Metadata replay flow", mediumId,
    temperatureK: medium.refTemperatureK, pressurePa: medium.refPressurePa, speedMps: condition.speedMps!,
    density: medium.density, dynamicViscosity: medium.dynamicViscosity,
    kinematicViscosity: medium.kinematicViscosity, mach: condition.speedMps! / medium.speedOfSound!,
  }).returning();
  replayProfiles.push({ id: flow.id, table: flowConditions });
  const [geometry] = await db.insert(referenceGeometryProfiles).values({
    slug: `${owner.engineJobId}-geometry`, name: "Metadata replay geometry", geometryType: "airfoil_2d",
    referenceLengthKind: "chord", referenceLengthM: condition.referenceChordM!,
  }).returning();
  replayProfiles.push({ id: geometry.id, table: referenceGeometryProfiles });
  const [boundary] = await db.insert(boundaryProfiles).values({ slug: `${owner.engineJobId}-boundary`, name: "Metadata replay boundary" }).returning();
  replayProfiles.push({ id: boundary.id, table: boundaryProfiles });
  const [mesh] = await db.insert(meshProfiles).values({ slug: `${owner.engineJobId}-mesh`, name: "Metadata replay mesh" }).returning();
  replayProfiles.push({ id: mesh.id, table: meshProfiles });
  const [solver] = await db.insert(solverProfiles).values({ slug: `${owner.engineJobId}-solver`, name: "Metadata replay solver" }).returning();
  replayProfiles.push({ id: solver.id, table: solverProfiles });
  const [scheduling] = await db.insert(schedulingProfiles).values({ slug: `${owner.engineJobId}-scheduling`, name: "Metadata replay scheduling" }).returning();
  replayProfiles.push({ id: scheduling.id, table: schedulingProfiles });
  const [output] = await db.insert(outputProfiles).values({ slug: `${owner.engineJobId}-output`, name: "Metadata replay output" }).returning();
  replayProfiles.push({ id: output.id, table: outputProfiles });
  const [sweep] = await db.insert(sweepDefinitions).values({ slug: `${owner.engineJobId}-sweep`, name: "Metadata replay sweep", aoaList: [0, 9] }).returning();
  replayProfiles.push({ id: sweep.id, table: sweepDefinitions });
  const [preset] = await db.insert(simulationPresets).values({
    slug: `${owner.engineJobId}-preset`, name: "Metadata replay preset", enabled: false, targetScope: "airfoils",
    flowConditionId: flow.id, referenceGeometryProfileId: geometry.id, boundaryProfileId: boundary.id,
    meshProfileId: mesh.id, solverProfileId: solver.id, schedulingProfileId: scheduling.id,
    outputProfileId: output.id, sweepDefinitionId: sweep.id, legacyBoundaryConditionId: owner.bcId,
  }).returning();
  replayPresetId = preset.id;
  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  if (!resolved) throw new Error("Exact metadata replay setup revision is missing");
  return resolved;
}

async function createAttempt(
  owner: Pick<
    OwnerFixture,
    "airfoilId" | "bcId" | "simJobId" | "engineJobId" | "caseSlug"
  >,
  aoaDeg: number,
): Promise<{ resultId: string; resultAttemptId: string }> {
  const [result] = await db
    .insert(results)
    .values({
      airfoilId: owner.airfoilId,
      bcId: owner.bcId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "rans",
      simJobId: owner.simJobId,
      engineJobId: owner.engineJobId,
      engineCaseSlug: owner.caseSlug,
      converged: true,
      solvedAt: new Date(),
    })
    .returning({ id: results.id });
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId: result.id,
      airfoilId: owner.airfoilId,
      bcId: owner.bcId,
      aoaDeg,
      simJobId: owner.simJobId,
      engineJobId: owner.engineJobId,
      engineCaseSlug: owner.caseSlug,
      status: "done",
      source: "solved",
      regime: "rans",
      validForPolar: true,
      converged: true,
      solvedAt: new Date(),
    })
    .returning({ id: resultAttempts.id });
  return { resultId: result.id, resultAttemptId: attempt.id };
}

async function createOwnerFixture(): Promise<OwnerFixture> {
  const token = `${PREFIX}-${randomUUID().slice(0, 8)}`;
  const [category] = await db
    .insert(categories)
    .values({
      slug: `${token}-cat`,
      name: token,
      path: `${token}-cat`,
      depth: 0,
    })
    .returning({ id: categories.id });
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${token}-foil`,
      name: token,
      categoryId: category.id,
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.08 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.08 },
        { x: 1, y: 0 },
      ],
      isSymmetric: true,
    })
    .returning({ id: airfoils.id });
  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${token}-bc`,
      name: `${token} bc`,
      mediumId,
      reynolds: 250_000,
      referenceChordM: 0.2,
      speedMps: 25,
    })
    .returning({ id: boundaryConditions.id });
  const engineJobId = `${token}-engine`;
  const caseSlug = `${token}-case`;
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId: airfoil.id,
      bcIds: [bc.id],
      referenceChordM: 0.2,
      status: "done",
      engineJobId,
      totalCases: 1,
      completedCases: 1,
    })
    .returning({ id: simJobs.id });
  const attemptOwner = await createAttempt(
    {
      airfoilId: airfoil.id,
      bcId: bc.id,
      simJobId: job.id,
      engineJobId,
      caseSlug,
    },
    0,
  );
  const evidenceBase = `evidence/${token}`;
  return {
    categoryId: category.id,
    airfoilId: airfoil.id,
    bcId: bc.id,
    simJobId: job.id,
    engineJobId,
    caseSlug,
    ...attemptOwner,
    evidenceBase,
    point: { aoa_deg: 0, case_slug: caseSlug } as PolarPoint,
  };
}

beforeAll(async () => {
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: `${PREFIX}-air`,
      name: `${PREFIX} air`,
      phase: "gas",
      density: 1.225,
      viscosityModel: "constant",
      constantDynamicViscosity: 1.789e-5,
      dynamicViscosity: 1.789e-5,
      kinematicViscosity: 1.46e-5,
      speedOfSound: 340.3,
    })
    .returning({ id: mediums.id });
  mediumId = medium.id;
});

function artifactUrl(owner: OwnerFixture, path: string): string {
  return `/jobs/${owner.engineJobId}/files/cases/${owner.caseSlug}/${path}`;
}

function logicalArtifact(
  owner: OwnerFixture,
  kind: string,
  memberPath: string,
): EngineEvidenceArtifact {
  const path = `${owner.evidenceBase}/${memberPath}`;
  return {
    kind,
    path,
    url: artifactUrl(owner, path),
    mime_type:
      kind === "vtk_window"
        ? "application/vnd.vtk"
        : kind === "frame_image"
          ? "image/png"
          : kind === "manifest"
            ? "application/json"
            : "text/plain",
    sha256: sha256(`${kind}:${memberPath}`),
    byte_size: 123,
    role: kind === "manifest" ? "evidence" : kind,
    metadata: { evidenceBase: owner.evidenceBase },
  };
}

function gcsBundle(
  owner: OwnerFixture,
  overrides: {
    artifact?: Partial<EngineEvidenceArtifact>;
    metadata?: Record<string, unknown>;
  } = {},
): EngineEvidenceArtifact {
  const path = `${owner.evidenceBase}/engine_evidence.tar.zst`;
  const bundleSha = sha256("bundle");
  const metadata = {
    evidenceBase: owner.evidenceBase,
    storageBackend: "gcs",
    bucket: BUCKET,
    objectKey: `${PREFIX}/sha256/${bundleSha.slice(0, 2)}/${bundleSha}.tar.zst`,
    generation: EXACT_GCS_GENERATION,
    crc32c: "AAAAAA==",
    compression: "zstd",
    archiveFormat: "tar+zstd",
    zstdLevel: 10,
    uncompressedTarSha256: sha256("tar-stream"),
    uncompressedTarByteSize: 98_765,
    verifiedAt: "2026-07-15T10:30:00.000Z",
    ...overrides.metadata,
  };
  return {
    kind: "engine_bundle",
    path,
    url: artifactUrl(owner, path),
    mime_type: "application/zstd",
    sha256: bundleSha,
    byte_size: 54_321,
    role: "evidence",
    metadata,
    ...overrides.artifact,
  };
}

async function register(
  artifact: EngineEvidenceArtifact,
  owner = fixture!,
  ids: { resultId: string; resultAttemptId: string } = owner,
): Promise<void> {
  await registerEvidenceArtifacts({
    db,
    engine: ENGINE,
    resultId: ids.resultId,
    resultAttemptId: ids.resultAttemptId,
    airfoilId: owner.airfoilId,
    simJobId: owner.simJobId,
    engineJobId: owner.engineJobId,
    point: owner.point,
    artifact,
  });
}

async function archivesFor(owner: OwnerFixture) {
  return db
    .select()
    .from(solverEvidenceArchives)
    .where(
      and(
        eq(solverEvidenceArchives.resultId, owner.resultId),
        eq(solverEvidenceArchives.resultAttemptId, owner.resultAttemptId),
      ),
    );
}

async function artifactsFor(
  owner: OwnerFixture,
  kind: (typeof solverEvidenceArtifacts.$inferSelect)["kind"],
) {
  return db
    .select()
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, owner.resultId),
        eq(solverEvidenceArtifacts.resultAttemptId, owner.resultAttemptId),
        eq(solverEvidenceArtifacts.kind, kind),
      ),
    );
}

async function blobsForSha(digest: string) {
  return db
    .select()
    .from(solverEvidenceBlobs)
    .where(eq(solverEvidenceBlobs.sha256, digest));
}

beforeEach(async () => {
  verifyRemoteEvidenceManifest.mockReset();
  verifyRemoteEvidenceManifest.mockImplementation(async (request) => ({
    state: "verified",
    remote: request.remote,
    manifestSha256: request.manifestSha256,
    manifestByteSize: request.manifestByteSize,
    manifestMemberSetSha256: request.manifestMemberSetSha256,
    manifestMemberCount: request.manifestMemberCount,
  }));
  fixture = await createOwnerFixture();
});

afterEach(async () => {
  const owner = fixture;
  fixture = null;
  if (owner) {
    await db.delete(airfoils).where(eq(airfoils.id, owner.airfoilId));
    if (replayPresetId) {
      await db.delete(simulationPresetRevisions).where(eq(simulationPresetRevisions.presetId, replayPresetId));
      await db.delete(simulationPresets).where(eq(simulationPresets.id, replayPresetId));
      replayPresetId = null;
    }
    for (const profile of replayProfiles.splice(0).reverse()) {
      if (profile.table === flowConditions)
        await sql`DELETE FROM flow_conditions WHERE id=${profile.id}::uuid
          AND NOT EXISTS(SELECT 1 FROM simulation_presets WHERE flow_condition_id=${profile.id}::uuid)
          AND NOT EXISTS(SELECT 1 FROM sim_campaign_conditions WHERE flow_condition_id=${profile.id}::uuid)`;
      else if (profile.table === referenceGeometryProfiles)
        await sql`DELETE FROM reference_geometry_profiles WHERE id=${profile.id}::uuid
          AND NOT EXISTS(SELECT 1 FROM simulation_presets WHERE reference_geometry_profile_id=${profile.id}::uuid)
          AND NOT EXISTS(SELECT 1 FROM sim_campaign_conditions WHERE reference_geometry_profile_id=${profile.id}::uuid)`;
      else await db.delete(profile.table).where(eq(profile.table.id, profile.id));
    }
    await db
      .delete(solverEvidenceBlobs)
      .where(like(solverEvidenceBlobs.objectKey, `${PREFIX}/%`));
    await db
      .delete(boundaryConditions)
      .where(eq(boundaryConditions.id, owner.bcId));
    await db.delete(categories).where(eq(categories.id, owner.categoryId));
  }
});

afterAll(async () => {
  if (mediumId) await db.delete(mediums).where(eq(mediums.id, mediumId));
  await sql.end();
});

describe("GCS Zstandard evidence ingestion", () => {
  it.each([false, true])("replays bounded artifact metadata through real ingestion with archive=%s", async (archived) => {
    const owner = fixture!;
    const { revision, snapshot } = await createReplayRevision(owner);
    expect(snapshot.preset.legacyBoundaryConditionId).toBe(owner.bcId);
    await db.update(simJobs).set({ simulationPresetRevisionId: revision.id, status: "running", engineState: "completed" })
      .where(eq(simJobs.id, owner.simJobId));
    const lease = await claimJobForIngest(db, owner.simJobId);
    if (!lease) throw new Error("Metadata replay fixture could not claim its exact ingest lease");
    const points = [false, true].map((rejected): PolarPoint => {
      const alpha = rejected ? 9 : 0;
      const caseOwner = { ...owner, caseSlug: `${owner.caseSlug}-${alpha}`, evidenceBase: `${owner.evidenceBase}/${alpha}` };
      const artifacts = Array.from({ length: 64 }, (_, index) => {
        const artifact = logicalArtifact(caseOwner, index === 0 ? "mesh_evidence" : "time_directory", `raw/${index}.dat`);
        delete artifact.role;
        return { ...artifact,
          sha256: createHash("sha256").update(`artifact-metadata-replay-v1/${alpha}/${index}`).digest("hex"),
          ...(index % 3 === 0 ? { field: "p" } : {}),
          ...(index % 2 === 0 ? { role: "raw" } : {}),
          metadata: { evidenceBase: caseOwner.evidenceBase, index, nested: { exact: true } },
        };
      });
      const manifest = logicalArtifact(caseOwner, "manifest", "evidence_manifest.json");
      manifest.sha256 = createHash("sha256").update(`artifact-metadata-replay-manifest-v1/${alpha}`).digest("hex");
      const bundleSha = createHash("sha256").update(`artifact-metadata-replay-bundle-v1/${alpha}`).digest("hex");
      const bundle = gcsBundle(caseOwner, { artifact: { sha256: bundleSha }, metadata: {
        objectKey: `${PREFIX}/sha256/${bundleSha.slice(0, 2)}/${bundleSha}.tar.zst`,
        uncompressedTarSha256: createHash("sha256").update(`artifact-metadata-replay-tar-v1/${alpha}`).digest("hex"),
      } });
      return {
        aoa_deg: alpha, case_slug: caseOwner.caseSlug, cl: rejected ? null : 0.4,
        cd: rejected ? null : 0.03, cm: rejected ? null : 0, converged: !rejected,
        unsteady: false, first_order_fallback: false, images: {},
        error: rejected ? "Isolated rejected physical evidence" : null,
        ...(rejected ? { failure_disposition: "hard_solver" as const } : {}),
        solver_active_seconds: 1,
        force_history: { t: [0, 0.1, 0.2], cl: [0.4, 0.4, 0.4], cd: [0.03, 0.03, 0.03], cm: [0, 0, 0], samples: 3 },
        evidence_artifacts: [manifest, ...(archived ? [bundle] : []), ...artifacts],
      };
    });
    const report: JobResult = { job_id: owner.engineJobId, state: "completed", polars: [{
      speed: snapshot.flowState.speedMps, chord: snapshot.referenceGeometry.referenceLengthM,
      reynolds: snapshot.derived.reynolds, mach: snapshot.derived.mach,
      points: [points[0]], attempts: [points[1]],
    }] };
    const input = { db, engine: ENGINE, engineJobId: owner.engineJobId, simJobId: owner.simJobId,
      airfoilId: owner.airfoilId,
      speedMap: [{ speed: snapshot.flowState.speedMps, bcId: owner.bcId,
        presetRevisionId: revision.id, mach: snapshot.derived.mach }],
      result: report, ingestLeaseToken: lease.token, heartbeat: async () => {},
    };
    const first = await ingestResult(input);
    expect(first.resultAttemptIds).toHaveLength(2);
    const exactSnapshot = async () => {
      const artifacts = await db.select().from(solverEvidenceArtifacts)
        .where(inArray(solverEvidenceArtifacts.resultAttemptId, first.resultAttemptIds)).orderBy(solverEvidenceArtifacts.id);
      const members = await db.select({ archiveId: solverEvidenceArtifactMembers.archiveId,
        artifactId: solverEvidenceArtifactMembers.artifactId, memberPath: solverEvidenceArtifactMembers.memberPath })
        .from(solverEvidenceArtifactMembers).innerJoin(solverEvidenceArtifacts,
          eq(solverEvidenceArtifacts.id, solverEvidenceArtifactMembers.artifactId))
        .where(inArray(solverEvidenceArtifacts.resultAttemptId, first.resultAttemptIds))
        .orderBy(solverEvidenceArtifactMembers.archiveId, solverEvidenceArtifactMembers.artifactId);
      const archives = await db.select().from(solverEvidenceArchives)
        .where(inArray(solverEvidenceArchives.resultAttemptId, first.resultAttemptIds)).orderBy(solverEvidenceArchives.id);
      const histories = await db.select().from(forceHistory)
        .where(inArray(forceHistory.resultAttemptId, first.resultAttemptIds)).orderBy(forceHistory.resultAttemptId);
      const attempts = await db.select().from(resultAttempts)
        .where(inArray(resultAttempts.id, first.resultAttemptIds)).orderBy(resultAttempts.id);
      const classifications = await db.select({ resultId: resultClassifications.resultId,
        resultAttemptId: resultClassifications.resultAttemptId, state: resultClassifications.state,
        reasons: resultClassifications.reasons, classifierVersion: resultClassifications.classifierVersion })
        .from(resultClassifications).where(inArray(resultClassifications.resultAttemptId, first.resultAttemptIds))
        .orderBy(resultClassifications.resultAttemptId);
      const pointers = await db.select({ id: results.id, attempt: results.currentResultAttemptId,
        status: results.status, cl: results.cl, cd: results.cd, cm: results.cm, converged: results.converged })
        .from(results).where(and(eq(results.airfoilId, owner.airfoilId), eq(results.simulationPresetRevisionId, revision.id)))
        .orderBy(results.id);
      return { artifacts, members, archives, histories, attempts, classifications, pointers };
    };
    const before = await exactSnapshot();
    expect(before.artifacts).toHaveLength(archived ? 132 : 130);
    expect(before.archives).toHaveLength(archived ? 2 : 0);
    expect(before.histories).toHaveLength(2);
    expect(before.attempts.find((attempt) => attempt.aoaDeg === 9)?.validForPolar).toBe(false);
    expect(before.classifications.some((classification) => classification.state === "accepted"), JSON.stringify(before.classifications)).toBe(true);
    const measure = async (concurrent: boolean) => {
      const queries: Record<string, number> = {};
      replayQueries = queries;
      const cpuStart = process.cpuUsage();
      const wallStart = performance.now();
      try {
        const receipts = concurrent ? await Promise.all([ingestResult(input), ingestResult(input)]) : [await ingestResult(input)];
        const wallMs = performance.now() - wallStart;
        const cpu = process.cpuUsage(cpuStart);
        replayQueries = null;
        for (const receipt of receipts) expect(receipt).toEqual(first);
        expect(await exactSnapshot()).toEqual(before);
        return { concurrent, queries, wallMs, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system };
      } finally { replayQueries = null; }
    };
    const measurements = [];
    for (let repetition = 0; repetition < 3; repetition++) measurements.push(await measure(false));
    measurements.push(await measure(true));
    console.log("artifact-metadata-replay-measurement", JSON.stringify({ version: 1, archived,
      inputHash: analysisContentHash(report),
      fixtureShapeHash: analysisContentHash(JSON.parse(JSON.stringify(report)
        .replaceAll(owner.engineJobId, "fixture-engine").replaceAll(owner.caseSlug, "fixture-case")
        .replaceAll(owner.evidenceBase, "fixture-evidence").replaceAll(PREFIX, "fixture-prefix"))),
      fixtureSourceHash: createHash("sha256").update(await readFile(new URL(import.meta.url))).digest("hex"),
      helperSourceHash: createHash("sha256").update(await readFile(new URL("../src/ingest.ts", import.meta.url))).digest("hex"),
      hashes: Object.fromEntries(Object.entries(before).map(([name, rows]) => [name, analysisContentHash(JSON.parse(JSON.stringify(rows)))])),
      measurements }));
    const bulk = before.artifacts.find((artifact) => artifact.kind === "time_directory")!;
    const nullable = before.artifacts.find((artifact) => artifact.kind === "time_directory" && artifact.field === null && artifact.role === null)!;
    expect(nullable).toBeDefined();
    const changes: Array<{ artifact: typeof bulk; values: Partial<typeof bulk> }> = [{ mimeType: "changed/type" }, { byteSize: bulk.byteSize + 1 },
      { engineUrl: "https://foreign.invalid/evidence" }, { metadata: { ...bulk.metadata, changed: true } },
      { engineCaseSlug: "foreign-case" }, { methodKey: "urans" }, { simJobId: null }, { engineJobId: "foreign-job" }]
      .map((values) => ({ artifact: bulk, values }));
    changes.push({ artifact: nullable, values: { field: "" } }, { artifact: nullable, values: { role: "" } });
    if (revision.solverImplementationId && revision.solverImplementationId !== bulk.solverImplementationId)
      changes.push({ artifact: bulk, values: { solverImplementationId: revision.solverImplementationId } });
    for (const changed of changes) {
      const rollback = new Error("Restore immutable metadata refusal fixture");
      await db.transaction(async (transaction) => {
        await transaction.delete(solverEvidenceArtifacts).where(eq(solverEvidenceArtifacts.id, changed.artifact.id));
        await transaction.insert(solverEvidenceArtifacts).values({ ...changed.artifact, ...changed.values });
        await expect(ingestResult({ ...input, db: transaction as unknown as typeof db })).rejects.toThrow("immutable association metadata");
        throw rollback;
      }).catch((error) => { if (error !== rollback) throw error; });
      expect(await exactSnapshot()).toEqual(before);
    }
    const changedReport = structuredClone(report);
    changedReport.polars[0].points[0].evidence_artifacts!.find((artifact) => artifact.kind === "time_directory")!.sha256 = "0".repeat(64);
    await expect(ingestResult({ ...input, result: changedReport })).rejects.toThrow("result attempt replay changed immutable evidence");
    expect(await exactSnapshot()).toEqual(before);
    if (archived) {
      const member = before.members.find((entry) => entry.artifactId === bulk.id)!;
      const rollback = new Error("Restore conflicting archive member fixture");
      await db.transaction(async (transaction) => {
        await transaction.delete(solverEvidenceArtifactMembers).where(and(eq(solverEvidenceArtifactMembers.archiveId, member.archiveId),
          eq(solverEvidenceArtifactMembers.artifactId, member.artifactId)));
        await transaction.insert(solverEvidenceArtifactMembers).values({ ...member, memberPath: "wrong/immutable-member.dat" });
        await expect(ingestResult({ ...input, db: transaction as unknown as typeof db })).rejects.toThrow("conflicts with immutable evidence");
        throw rollback;
      }).catch((error) => { if (error !== rollback) throw error; });
      expect(await exactSnapshot()).toEqual(before);
    }
    await db.delete(solverEvidenceArtifacts).where(eq(solverEvidenceArtifacts.id, bulk.id));
    expect((await ingestResult(input)).resultAttemptIds).toEqual(first.resultAttemptIds);
    const restored = await exactSnapshot();
    expect(restored.artifacts).toHaveLength(before.artifacts.length);
    expect(restored.classifications).toEqual(before.classifications);
    expect(restored.pointers).toEqual(before.pointers);
    if (archived) {
      const restoredBulk = restored.artifacts.find((artifact) => artifact.kind === "time_directory")!;
      const member = restored.members.find((entry) => entry.artifactId === restoredBulk.id)!;
      await db.delete(solverEvidenceArtifactMembers).where(and(eq(solverEvidenceArtifactMembers.archiveId, member.archiveId),
        eq(solverEvidenceArtifactMembers.artifactId, member.artifactId)));
      await ingestResult(input);
      expect((await exactSnapshot()).members).toEqual(restored.members);
    }
  }, 120_000);

  it("MUST-CATCH: registers a rejected URANS checkpoint without rewriting the canonical result's older RANS provenance", async () => {
    const canonical = fixture!;
    const engineJobId = `${PREFIX}-continuation-engine`;
    const caseSlug = `${PREFIX}-continuation-case`;
    const [job] = await db
      .insert(simJobs)
      .values({
        airfoilId: canonical.airfoilId,
        bcIds: [canonical.bcId],
        referenceChordM: 0.2,
        status: "failed",
        methodKey: "openfoam.urans",
        engineJobId,
        totalCases: 1,
        completedCases: 1,
      })
      .returning({ id: simJobs.id });
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId: canonical.resultId,
        airfoilId: canonical.airfoilId,
        bcId: canonical.bcId,
        aoaDeg: 0,
        simJobId: job.id,
        engineJobId,
        engineCaseSlug: caseSlug,
        methodKey: "openfoam.urans",
        status: "failed",
        source: "solved",
        regime: "urans",
        validForPolar: false,
        converged: false,
        error: "requires further same-case integration",
        solvedAt: new Date(),
      })
      .returning({ id: resultAttempts.id });
    const owner: OwnerFixture = {
      ...canonical,
      simJobId: job.id,
      engineJobId,
      caseSlug,
      resultAttemptId: attempt.id,
      evidenceBase: `evidence/${caseSlug}`,
      point: {
        aoa_deg: 0,
        case_slug: caseSlug,
        method_key: "openfoam.urans",
      } as PolarPoint,
    };
    const manifestBytes = Buffer.from(
      JSON.stringify({ schemaVersion: 2, bundleExcludes: [], files: [] }),
    );
    const migratedSha = sha256("continuation-migrated-zstd");
    await register(
      {
        ...logicalArtifact(owner, "manifest", "evidence_manifest.json"),
        sha256: createHash("sha256").update(manifestBytes).digest("hex"),
        byte_size: manifestBytes.byteLength,
      },
      owner,
    );
    const legacyPath = `${owner.evidenceBase}/engine_evidence.tar.zst`;
    await register(
      {
        kind: "engine_bundle",
        path: legacyPath,
        url: artifactUrl(owner, legacyPath),
        mime_type: "application/zstd",
        sha256: migratedSha,
        byte_size: 54_321,
        role: "evidence",
        metadata: { evidenceBase: owner.evidenceBase },
      },
      owner,
    );

    const mediaRoot = await mkdtemp(
      join(tmpdir(), "evidence-backfill-continuation-owner-"),
    );
    const evidencePath = `cases/${caseSlug}/${owner.evidenceBase}`;
    const receiptDir = join(mediaRoot, "jobs", engineJobId, evidencePath);
    const receiptPath = join(receiptDir, "storage_migration.json");
    const tarSha = sha256("continuation-tar");
    await mkdir(receiptDir, { recursive: true });
    await writeFile(join(receiptDir, "evidence_manifest.json"), manifestBytes);
    await writeFile(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        state: "awaiting_database_registration",
        jobId: engineJobId,
        evidencePath,
        archive: {
          storedSha256: migratedSha,
          storedByteSize: 54_321,
          uncompressedTarSha256: tarSha,
          uncompressedTarByteSize: 98_765,
          zstdLevel: 10,
        },
        remote: {
          schemaVersion: 1,
          format: "tar+zstd",
          bucket: BUCKET,
          objectKey: `${PREFIX}/sha256/${migratedSha.slice(0, 2)}/${migratedSha}.tar.zst`,
          generation: EXACT_GCS_GENERATION,
          storedSha256: migratedSha,
          storedSize: 54_321,
          tarSha256: tarSha,
          tarSize: 98_765,
          crc32c: "AAAAAA==",
          zstdLevel: 10,
          createdAt: "2026-07-20T09:30:00.000Z",
        },
        sourceArchives: [],
      }),
    );

    try {
      const acknowledgement = await registerEvidenceMigrationReceipt({
        db,
        engine: ENGINE,
        receiptPath,
        mediaRoot,
      });
      expect(acknowledgement).toMatchObject({
        state: "registered",
        resultId: canonical.resultId,
        resultAttemptId: attempt.id,
      });
      expect(await archivesFor(owner)).toHaveLength(1);
      const [canonicalResult] = await db
        .select({
          simJobId: results.simJobId,
          engineJobId: results.engineJobId,
          methodKey: results.methodKey,
        })
        .from(results)
        .where(eq(results.id, canonical.resultId));
      expect(canonicalResult).toMatchObject({
        simJobId: canonical.simJobId,
        engineJobId: canonical.engineJobId,
      });
      expect(canonicalResult?.methodKey).not.toBe("openfoam.urans");
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });

  it("MUST-CATCH: dry-run and execute authenticate omitted members from the exact canonical GCS generation before any write", async () => {
    const owner = fixture!;
    const memberPath = "openfoam/mesh_evidence/logs/log.blockMesh";
    const memberBytes = Buffer.from("verified retained mesh log\n");
    const memberSha = createHash("sha256").update(memberBytes).digest("hex");
    const manifestBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        bundleExcludes: [],
        files: [
          {
            path: memberPath,
            role: "mesh_evidence",
            sha256: memberSha,
            byteSize: memberBytes.byteLength,
          },
        ],
      }),
    );
    await register({
      ...logicalArtifact(owner, "manifest", "evidence_manifest.json"),
      sha256: createHash("sha256").update(manifestBytes).digest("hex"),
      byte_size: manifestBytes.byteLength,
    });

    const mediaRoot = await mkdtemp(
      join(tmpdir(), "evidence-backfill-canonical-archive-"),
    );
    const evidencePath = `cases/${owner.caseSlug}/${owner.evidenceBase}`;
    const receiptDir = join(mediaRoot, "jobs", owner.engineJobId, evidencePath);
    const receiptPath = join(receiptDir, "storage_migration.json");
    const migratedSha = sha256("retained-archive-migrated-zstd");
    const tarSha = sha256("canonical-migrated-tar");
    const tarSize = 98_765;
    await mkdir(receiptDir, { recursive: true });
    await writeFile(join(receiptDir, "evidence_manifest.json"), manifestBytes);
    const legacyPath = `${owner.evidenceBase}/openfoam_evidence.tar.gz`;
    await register({
      kind: "engine_bundle",
      path: legacyPath,
      url: artifactUrl(owner, legacyPath),
      mime_type: "application/gzip",
      sha256: sha256("legacy-canonical-source"),
      byte_size: 90_000,
      role: "evidence",
      metadata: { evidenceBase: owner.evidenceBase },
    });
    const receiptPayload = {
      schemaVersion: 1,
      state: "awaiting_database_registration",
      jobId: owner.engineJobId,
      evidencePath,
      archive: {
        storedSha256: migratedSha,
        storedByteSize: 54_321,
        uncompressedTarSha256: tarSha,
        uncompressedTarByteSize: tarSize,
        zstdLevel: 10,
      },
      remote: {
        schemaVersion: 1,
        format: "tar+zstd",
        bucket: BUCKET,
        objectKey: `${PREFIX}/sha256/${migratedSha.slice(0, 2)}/${migratedSha}.tar.zst`,
        generation: EXACT_GCS_GENERATION,
        storedSha256: migratedSha,
        storedSize: 54_321,
        tarSha256: tarSha,
        tarSize,
        crc32c: "AAAAAA==",
        zstdLevel: 10,
        createdAt: "2026-07-18T22:00:00.000Z",
      },
      sourceArchives: [],
    };
    await writeFile(receiptPath, JSON.stringify(receiptPayload));

    try {
      await expect(
        planEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).resolves.toMatchObject({
        status: "planned",
        resultId: owner.resultId,
        resultAttemptId: owner.resultAttemptId,
        reconciledManifestMembers: 1,
      });
      expect(await artifactsFor(owner, "mesh")).toHaveLength(0);
      expect(await archivesFor(owner)).toHaveLength(0);
      expect(
        await readFile(join(receiptDir, "storage_migration.database.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      expect(verifyRemoteEvidenceManifest).toHaveBeenCalledTimes(1);
      expect(verifyRemoteEvidenceManifest).toHaveBeenCalledWith(
        expect.objectContaining({
          remote: receiptPayload.remote,
          manifestBase64: manifestBytes.toString("base64"),
          manifestSha256: createHash("sha256")
            .update(manifestBytes)
            .digest("hex"),
          manifestByteSize: manifestBytes.byteLength,
          manifestMemberCount: 2,
        }),
      );

      verifyRemoteEvidenceManifest.mockRejectedValueOnce(
        new Error("wrong generation"),
      );
      await expect(
        planEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).rejects.toThrow(/canonical GCS archive: wrong generation/);
      verifyRemoteEvidenceManifest.mockRejectedValueOnce(
        new Error("wrong generation"),
      );
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).rejects.toThrow(/canonical GCS archive: wrong generation/);
      expect(await artifactsFor(owner, "mesh")).toHaveLength(0);
      expect(await archivesFor(owner)).toHaveLength(0);
      expect(
        await readFile(join(receiptDir, "storage_migration.database.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);

      const [ack, concurrentAck] = await Promise.all([
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ]);
      expect(concurrentAck).toEqual(ack);
      expect(ack).toMatchObject({
        state: "registered",
        resultId: owner.resultId,
        resultAttemptId: owner.resultAttemptId,
      });
      expect(await artifactsFor(owner, "mesh")).toEqual([
        expect.objectContaining({
          storageKey: `jobs/${owner.engineJobId}/${evidencePath}/${memberPath}`,
          sha256: memberSha,
          byteSize: memberBytes.byteLength,
          role: "mesh_evidence",
        }),
      ]);
      expect(await archivesFor(owner)).toHaveLength(1);

      const replay = await registerEvidenceMigrationReceipt({
        db,
        engine: ENGINE,
        receiptPath,
        mediaRoot,
      });
      expect(replay).toEqual(ack);
      expect(await artifactsFor(owner, "mesh")).toHaveLength(1);
      expect(await archivesFor(owner)).toHaveLength(1);
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });

  it("MUST-CATCH: reconciles an omitted mesh-evidence row only from exact local bytes and withholds acknowledgement on mismatch", async () => {
    const owner = fixture!;
    const memberPath = "openfoam/mesh_evidence/logs/log.blockMesh";
    const memberBytes = Buffer.from("legacy verified mesh evidence\n");
    const companionPath = "openfoam/mesh_evidence/manifest.json";
    const companionBytes = Buffer.from('{"verified":true}\n');
    const manifestBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        bundleExcludes: [],
        files: [
          {
            path: memberPath,
            role: "mesh_evidence",
            sha256: createHash("sha256").update(memberBytes).digest("hex"),
            byteSize: memberBytes.byteLength,
          },
          {
            path: companionPath,
            role: "mesh_evidence",
            sha256: createHash("sha256").update(companionBytes).digest("hex"),
            byteSize: companionBytes.byteLength,
          },
        ],
      }),
    );
    await register({
      ...logicalArtifact(owner, "manifest", "evidence_manifest.json"),
      sha256: createHash("sha256").update(manifestBytes).digest("hex"),
      byte_size: manifestBytes.byteLength,
    });
    const legacyPath = `${owner.evidenceBase}/openfoam_evidence.tar.gz`;
    await register({
      kind: "engine_bundle",
      path: legacyPath,
      url: artifactUrl(owner, legacyPath),
      mime_type: "application/gzip",
      sha256: sha256("legacy-mesh-evidence-gzip"),
      byte_size: 90_000,
      role: "evidence",
      metadata: { evidenceBase: owner.evidenceBase },
    });

    const mediaRoot = await mkdtemp(join(tmpdir(), "evidence-backfill-gap-"));
    const evidencePath = `cases/${owner.caseSlug}/${owner.evidenceBase}`;
    const receiptDir = join(mediaRoot, "jobs", owner.engineJobId, evidencePath);
    const receiptPath = join(receiptDir, "storage_migration.json");
    const migratedSha = sha256("migrated-mesh-evidence-zstd");
    const tarSha = sha256("legacy-mesh-evidence-tar-stream");
    await mkdir(join(receiptDir, "openfoam", "mesh_evidence", "logs"), {
      recursive: true,
    });
    await writeFile(join(receiptDir, "evidence_manifest.json"), manifestBytes);
    await writeFile(join(receiptDir, memberPath), Buffer.from("wrong bytes"));
    await writeFile(join(receiptDir, companionPath), companionBytes);
    await writeFile(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        state: "awaiting_database_registration",
        jobId: owner.engineJobId,
        evidencePath,
        archive: {
          storedSha256: migratedSha,
          storedByteSize: 54_321,
          uncompressedTarSha256: tarSha,
          uncompressedTarByteSize: 98_765,
          zstdLevel: 10,
        },
        remote: {
          schemaVersion: 1,
          format: "tar+zstd",
          bucket: BUCKET,
          objectKey: `${PREFIX}/sha256/${migratedSha.slice(0, 2)}/${migratedSha}.tar.zst`,
          generation: EXACT_GCS_GENERATION,
          storedSha256: migratedSha,
          storedSize: 54_321,
          tarSha256: tarSha,
          tarSize: 98_765,
          crc32c: "AAAAAA==",
          zstdLevel: 10,
          createdAt: "2026-07-18T20:00:00.000Z",
        },
      }),
    );

    try {
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).rejects.toThrow(
        /local bytes do not match its authenticated manifest identity/,
      );
      expect(
        await readFile(join(receiptDir, "storage_migration.database.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      expect(await artifactsFor(owner, "mesh")).toHaveLength(0);
      expect(await archivesFor(owner)).toHaveLength(0);
      expect(verifyRemoteEvidenceManifest).not.toHaveBeenCalled();

      const memberFile = join(receiptDir, memberPath);
      await rm(memberFile, { force: true });
      verifyRemoteEvidenceManifest.mockRejectedValueOnce(
        new Error("canonical archive unavailable"),
      );
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).rejects.toThrow(/canonical GCS archive: canonical archive unavailable/);
      expect(verifyRemoteEvidenceManifest).toHaveBeenCalledTimes(1);
      expect(await archivesFor(owner)).toHaveLength(0);
      expect(
        await readFile(join(receiptDir, "storage_migration.database.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);

      const symlinkTarget = join(mediaRoot, "outside-member");
      await writeFile(symlinkTarget, memberBytes);
      await symlink(symlinkTarget, memberFile);
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).rejects.toThrow(/without symlink traversal/);
      expect(verifyRemoteEvidenceManifest).toHaveBeenCalledTimes(1);
      expect(await archivesFor(owner)).toHaveLength(0);
      expect(
        await readFile(join(receiptDir, "storage_migration.database.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      await rm(memberFile, { force: true });

      const memberParent = join(
        receiptDir,
        "openfoam",
        "mesh_evidence",
        "logs",
      );
      await rm(memberParent, { recursive: true, force: true });
      const outsideParent = join(mediaRoot, "outside-parent");
      await mkdir(outsideParent, { recursive: true });
      await writeFile(join(outsideParent, "log.blockMesh"), memberBytes);
      await symlink(outsideParent, memberParent, "dir");
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).rejects.toThrow(/without symlink traversal/);
      expect(verifyRemoteEvidenceManifest).toHaveBeenCalledTimes(1);
      expect(await archivesFor(owner)).toHaveLength(0);
      expect(
        await readFile(join(receiptDir, "storage_migration.database.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      await rm(memberParent, { force: true });
      await mkdir(memberParent, { recursive: true });
      await writeFile(join(receiptDir, memberPath), memberBytes);

      await db
        .update(solverEvidenceArtifacts)
        .set({ aoaDeg: 1 })
        .where(
          eq(solverEvidenceArtifacts.resultAttemptId, owner.resultAttemptId),
        );
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).rejects.toThrow(
        /does not exactly match its referenced result\/attempt\/job owners/,
      );
      expect(await artifactsFor(owner, "mesh")).toHaveLength(0);
      expect(await archivesFor(owner)).toHaveLength(0);
      expect(
        await readFile(join(receiptDir, "storage_migration.database.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      await db
        .update(solverEvidenceArtifacts)
        .set({ aoaDeg: 0 })
        .where(
          eq(solverEvidenceArtifacts.resultAttemptId, owner.resultAttemptId),
        );

      const memberArtifactPath = `${owner.evidenceBase}/${memberPath}`;
      const memberSha = createHash("sha256").update(memberBytes).digest("hex");
      await register({
        kind: "mesh_evidence",
        path: memberArtifactPath,
        url: artifactUrl(owner, memberArtifactPath),
        mime_type: "application/octet-stream",
        sha256: memberSha,
        byte_size: memberBytes.byteLength,
        role: "mesh_evidence",
        metadata: { evidenceBase: owner.evidenceBase },
      });
      await register({
        kind: "field_data",
        path: memberArtifactPath,
        url: artifactUrl(owner, memberArtifactPath),
        mime_type: "application/octet-stream",
        sha256: memberSha,
        byte_size: memberBytes.byteLength,
        role: "quality_evidence",
        metadata: { evidenceBase: owner.evidenceBase },
      });
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).rejects.toThrow(/ambiguous artifacts for bundled manifest member/);
      expect(await archivesFor(owner)).toHaveLength(0);
      expect(
        await readFile(join(receiptDir, "storage_migration.database.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      await db
        .delete(solverEvidenceArtifacts)
        .where(
          and(
            eq(solverEvidenceArtifacts.resultAttemptId, owner.resultAttemptId),
            eq(
              solverEvidenceArtifacts.storageKey,
              `jobs/${owner.engineJobId}/${evidencePath}/${memberPath}`,
            ),
          ),
        );

      const conflictingBundle = gcsBundle(owner);
      await register(conflictingBundle);
      const archivesBeforeLateFailure = await archivesFor(owner);
      const membersBeforeLateFailure = await db
        .select()
        .from(solverEvidenceArtifactMembers)
        .where(
          eq(
            solverEvidenceArtifactMembers.archiveId,
            archivesBeforeLateFailure[0]!.id,
          ),
        );
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).rejects.toThrow(/different current evidence archive/);
      expect(await artifactsFor(owner, "mesh")).toHaveLength(0);
      expect(await blobsForSha(migratedSha)).toHaveLength(0);
      expect((await archivesFor(owner)).map((row) => row.id)).toEqual(
        archivesBeforeLateFailure.map((row) => row.id),
      );
      expect(
        await db
          .select()
          .from(solverEvidenceArtifactMembers)
          .where(
            eq(
              solverEvidenceArtifactMembers.archiveId,
              archivesBeforeLateFailure[0]!.id,
            ),
          ),
      ).toEqual(membersBeforeLateFailure);
      expect(
        (await artifactsFor(owner, "engine_bundle")).some(
          (artifact) => artifact.sha256 === migratedSha,
        ),
      ).toBe(false);
      expect(
        await readFile(join(receiptDir, "storage_migration.database.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      const conflictingSources = await artifactsFor(owner, "engine_bundle");
      const conflictingSource = conflictingSources.find(
        (artifact) => artifact.sha256 === conflictingBundle.sha256,
      );
      expect(conflictingSource).toBeDefined();
      await db
        .delete(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.id, conflictingSource!.id));

      const ack = await registerEvidenceMigrationReceipt({
        db,
        engine: ENGINE,
        receiptPath,
        mediaRoot,
      });
      expect(ack).toMatchObject({
        state: "registered",
        resultId: owner.resultId,
        resultAttemptId: owner.resultAttemptId,
      });
      const meshArtifacts = await artifactsFor(owner, "mesh");
      const meshArtifact = meshArtifacts.find((artifact) =>
        artifact.storageKey.endsWith(`/${memberPath}`),
      )!;
      expect(meshArtifacts).toHaveLength(2);
      expect(meshArtifact).toMatchObject({
        resultId: owner.resultId,
        resultAttemptId: owner.resultAttemptId,
        airfoilId: owner.airfoilId,
        simJobId: owner.simJobId,
        engineJobId: owner.engineJobId,
        engineCaseSlug: owner.caseSlug,
        aoaDeg: 0,
        role: "mesh_evidence",
        storageKey: `jobs/${owner.engineJobId}/${evidencePath}/${memberPath}`,
        mimeType: "application/octet-stream",
        sha256: memberSha,
        byteSize: memberBytes.byteLength,
        metadata: expect.objectContaining({
          evidenceBase: owner.evidenceBase,
          engineArtifactKind: "mesh_evidence",
        }),
      });
      const [archive] = await archivesFor(owner);
      const mappings = await db
        .select()
        .from(solverEvidenceArtifactMembers)
        .where(eq(solverEvidenceArtifactMembers.archiveId, archive.id));
      expect(mappings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            artifactId: meshArtifact.id,
            memberPath,
          }),
        ]),
      );

      const replay = await registerEvidenceMigrationReceipt({
        db,
        engine: ENGINE,
        receiptPath,
        mediaRoot,
      });
      expect(replay).toEqual(ack);
      expect(await artifactsFor(owner, "mesh")).toHaveLength(2);
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });

  it("backfills a verified filesystem migration receipt and writes a DB acknowledgement", async () => {
    const owner = fixture!;
    const manifestBytes = Buffer.from(
      JSON.stringify({ schemaVersion: 2, files: [] }),
    );
    const manifestArtifact = logicalArtifact(
      owner,
      "manifest",
      "evidence_manifest.json",
    );
    await register(manifestArtifact);
    const legacyPath = `${owner.evidenceBase}/openfoam_evidence.tar.gz`;
    await register({
      kind: "engine_bundle",
      path: legacyPath,
      url: artifactUrl(owner, legacyPath),
      mime_type: "application/gzip",
      sha256: sha256("legacy-gzip"),
      byte_size: 90_000,
      role: "evidence",
      metadata: { evidenceBase: owner.evidenceBase },
    });
    const mediaRoot = await mkdtemp(join(tmpdir(), "evidence-backfill-"));
    const evidencePath = `cases/${owner.caseSlug}/${owner.evidenceBase}`;
    const receiptDir = join(mediaRoot, "jobs", owner.engineJobId, evidencePath);
    await mkdir(receiptDir, { recursive: true });
    await writeFile(join(receiptDir, "evidence_manifest.json"), manifestBytes);
    const receiptPath = join(receiptDir, "storage_migration.json");
    const migratedSha = sha256("migrated-zstd");
    const tarSha = sha256("legacy-tar-stream");
    const receiptPayload = {
      schemaVersion: 1,
      state: "awaiting_database_registration",
      jobId: owner.engineJobId,
      evidencePath,
      archive: {
        storedSha256: migratedSha,
        storedByteSize: 54_321,
        uncompressedTarSha256: tarSha,
        uncompressedTarByteSize: 98_765,
        zstdLevel: 10,
      },
      remote: {
        schemaVersion: 1,
        format: "tar+zstd",
        bucket: BUCKET,
        objectKey: `${PREFIX}/sha256/${migratedSha.slice(0, 2)}/${migratedSha}.tar.zst`,
        generation: EXACT_GCS_GENERATION,
        storedSha256: migratedSha,
        storedSize: 54_321,
        tarSha256: tarSha,
        tarSize: 98_765,
        crc32c: "AAAAAA==",
        zstdLevel: 10,
        createdAt: "2026-07-15T20:00:00.000Z",
      },
    };
    expect(() =>
      parseEvidenceMigrationReceipt(
        {
          ...receiptPayload,
          remote: {
            ...receiptPayload.remote,
            objectKey: `${PREFIX}/migration/${migratedSha}.tar.zst`,
          },
        },
        receiptPath,
        mediaRoot,
      ),
    ).toThrow(/content-addressed/);
    await writeFile(receiptPath, JSON.stringify(receiptPayload));

    try {
      await expect(
        registerEvidenceMigrationReceipt({
          db,
          engine: ENGINE,
          receiptPath,
          mediaRoot,
        }),
      ).rejects.toThrow(/manifest artifact checksum or byte size/);
      expect(
        await readFile(join(receiptDir, "storage_migration.database.json"))
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      const [storedManifest] = await artifactsFor(owner, "manifest");
      await db
        .update(solverEvidenceArtifacts)
        .set({
          sha256: createHash("sha256").update(manifestBytes).digest("hex"),
          byteSize: manifestBytes.byteLength,
        })
        .where(eq(solverEvidenceArtifacts.id, storedManifest.id));

      const ack = await registerEvidenceMigrationReceipt({
        db,
        engine: ENGINE,
        receiptPath,
        mediaRoot,
      });
      expect(ack).toMatchObject({
        state: "registered",
        jobId: owner.engineJobId,
        evidencePath,
        storedSha256: migratedSha,
        generation: EXACT_GCS_GENERATION,
        resultId: owner.resultId,
        resultAttemptId: owner.resultAttemptId,
      });
      expect(
        JSON.parse(
          await readFile(
            join(receiptDir, "storage_migration.database.json"),
            "utf8",
          ),
        ),
      ).toMatchObject(ack);
      expect(await archivesFor(owner)).toHaveLength(1);
      expect(await artifactsFor(owner, "engine_bundle")).toHaveLength(2);
      const replay = await registerEvidenceMigrationReceipt({
        db,
        engine: ENGINE,
        receiptPath,
        mediaRoot,
      });
      expect(replay.archiveId).toBe(ack.archiveId);
      expect(await archivesFor(owner)).toHaveLength(1);
    } finally {
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });

  it("creates one exact blob/archive, backfills early members, excludes frames and aliases, and maps later members idempotently", async () => {
    const owner = fixture!;
    const manifest = logicalArtifact(
      owner,
      "manifest",
      "evidence_manifest.json",
    );
    const frame = logicalArtifact(
      owner,
      "frame_image",
      "frames/pressure/f0000.png",
    );
    const bundle = gcsBundle(owner);
    await register(manifest);
    await register(frame);
    await register({ ...bundle, kind: "openfoam_bundle" });
    expect(await archivesFor(owner)).toHaveLength(0);

    await register(bundle);

    const [blob] = await blobsForSha(bundle.sha256);
    expect(blob).toMatchObject({
      backend: "gcs",
      bucket: BUCKET,
      generation: EXACT_GCS_GENERATION,
      compression: "zstd",
      mimeType: "application/zstd",
      sha256: bundle.sha256,
      byteSize: bundle.byte_size,
      crc32c: "AAAAAA==",
    });
    const [archive] = await archivesFor(owner);
    const [source] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.id, archive.sourceArtifactId));
    expect(source.kind).toBe("engine_bundle");

    const memberRows = async () =>
      db
        .select({
          kind: solverEvidenceArtifacts.kind,
          memberPath: solverEvidenceArtifactMembers.memberPath,
        })
        .from(solverEvidenceArtifactMembers)
        .innerJoin(
          solverEvidenceArtifacts,
          eq(
            solverEvidenceArtifacts.id,
            solverEvidenceArtifactMembers.artifactId,
          ),
        )
        .where(eq(solverEvidenceArtifactMembers.archiveId, archive.id))
        .orderBy(solverEvidenceArtifactMembers.memberPath);
    expect(await memberRows()).toEqual([
      { kind: "manifest", memberPath: "evidence_manifest.json" },
    ]);

    const vtk = logicalArtifact(owner, "vtk_window", "VTK/pressure_0.vtu");
    const continuationState = {
      ...logicalArtifact(
        owner,
        "dictionary",
        "openfoam/transient/transient_start.json",
      ),
      mime_type: "application/json",
      role: "continuation_state",
    };
    await register(vtk);
    await register(vtk);
    await register(continuationState);
    expect(await memberRows()).toEqual([
      { kind: "vtk_window", memberPath: "VTK/pressure_0.vtu" },
      { kind: "manifest", memberPath: "evidence_manifest.json" },
      {
        kind: "dictionary",
        memberPath: "openfoam/transient/transient_start.json",
      },
    ]);
  });

  it("preserves the decimal GCS generation and replays the same archive without duplicates", async () => {
    const bundle = gcsBundle(fixture!);
    await register(bundle);
    await register(bundle);
    expect(
      await db
        .select({ generation: solverEvidenceBlobs.generation })
        .from(solverEvidenceBlobs)
        .where(eq(solverEvidenceBlobs.sha256, bundle.sha256)),
    ).toEqual([{ generation: EXACT_GCS_GENERATION }]);
    expect(await archivesFor(fixture!)).toHaveLength(1);
    expect(await artifactsFor(fixture!, "engine_bundle")).toHaveLength(1);
  });

  it("lets different attempts share one exact GCS generation verified at different times", async () => {
    const owner = fixture!;
    const first = gcsBundle(owner);
    await register(first);
    const secondIds = await createAttempt(owner, 1);
    const secondOwner: OwnerFixture = {
      ...owner,
      ...secondIds,
      point: { ...owner.point, aoa_deg: 1 },
    };
    const second = gcsBundle(secondOwner, {
      metadata: {
        objectKey: first.metadata!.objectKey,
        generation: first.metadata!.generation,
        verifiedAt: "2026-07-15T11:30:00.000Z",
      },
    });

    await register(second, secondOwner);

    expect(await blobsForSha(first.sha256)).toHaveLength(1);
    expect(await archivesFor(owner)).toHaveLength(1);
    expect(await archivesFor(secondOwner)).toHaveLength(1);
  });

  it.each([
    ["missing storage backend", { storageBackend: undefined }],
    ["numeric generation", { generation: 9_007_199_254_740_992 }],
    ["unsafe object key", { objectKey: "../escape.tar.zst" }],
    [
      "non-content-addressed object key",
      { objectKey: `${PREFIX}/migration/${sha256("bundle")}.tar.zst` },
    ],
    ["wrong compression", { compression: "gzip" }],
    ["invalid CRC32C", { crc32c: "bad" }],
    ["invalid tar digest", { uncompressedTarSha256: "bad" }],
    ["zero tar size", { uncompressedTarByteSize: 0 }],
    ["invalid verification time", { verifiedAt: "not-a-time" }],
    ["unsafe evidence base", { evidenceBase: "evidence/../escape" }],
  ])("rejects malformed verified metadata: %s", async (_label, metadata) => {
    const bundle = gcsBundle(fixture!, { metadata });
    await expect(register(bundle)).rejects.toThrow(
      /GCS evidence|GCS engine_bundle/,
    );
    expect(await blobsForSha(bundle.sha256)).toHaveLength(0);
    expect(await artifactsFor(fixture!, "engine_bundle")).toHaveLength(0);
  });

  it("rejects a different current archive instead of silently superseding immutable evidence", async () => {
    const first = gcsBundle(fixture!);
    await register(first);
    const differentSha = sha256("different-bundle");
    const second = gcsBundle(fixture!, {
      artifact: {
        sha256: differentSha,
        byte_size: 45_678,
      },
      metadata: {
        objectKey: `${PREFIX}/sha256/${differentSha.slice(0, 2)}/${differentSha}.tar.zst`,
        generation: "9007199254740993",
        crc32c: "AQIDBA==",
      },
    });
    await expect(register(second)).rejects.toThrow(
      "different current evidence archive",
    );
    expect(await archivesFor(fixture!)).toHaveLength(1);
    expect(
      await db
        .select()
        .from(solverEvidenceBlobs)
        .where(like(solverEvidenceBlobs.objectKey, `${PREFIX}/%`)),
    ).toHaveLength(1);
    expect(await artifactsFor(fixture!, "engine_bundle")).toHaveLength(1);
  });

  it("rejects unsafe late member paths atomically", async () => {
    await register(gcsBundle(fixture!));
    const unsafe = logicalArtifact(fixture!, "log", "../secret.log");
    await expect(register(unsafe)).rejects.toThrow("safe relative path");
    expect(await artifactsFor(fixture!, "log")).toHaveLength(0);
    const [archive] = await archivesFor(fixture!);
    expect(
      await db
        .select()
        .from(solverEvidenceArtifactMembers)
        .where(eq(solverEvidenceArtifactMembers.archiveId, archive.id)),
    ).toHaveLength(0);
  });

  it("rejects a bundle whose attempt does not exactly own the claimed result", async () => {
    const other = await createAttempt(fixture!, 1);
    await expect(
      register(gcsBundle(fixture!), fixture!, {
        resultId: fixture!.resultId,
        resultAttemptId: other.resultAttemptId,
      }),
    ).rejects.toThrow("does not own result");
    expect(await blobsForSha(gcsBundle(fixture!).sha256)).toHaveLength(0);
    expect(await archivesFor(fixture!)).toHaveLength(0);
  });
});
