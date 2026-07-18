// Admin request-URANS endpoint (fidelity ladder contract 6): requireAdmin,
// validation, IDEMPOTENT creation per (cell, fidelity) — replay returns the
// open item with created=false — and the cell-scope GET the Points tab /
// campaign cell panel reads. Shared-database integration test: rows are
// pw- prefixed and deleted in afterAll (global test-hygiene rule).

import {
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
  URANS_CONTINUATION_REQUIRED_MARKER,
} from "@aerodb/core";
import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  flowConditions,
  mediums,
  meshProfiles,
  outputProfiles,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
  referenceGeometryProfiles,
  resultAttempts,
  resultClassifications,
  results,
  schedulingProfiles,
  simulationPresetRevisions,
  simulationPresets,
  simUransRequests,
  solverEvidenceArchives,
  solverEvidenceArtifactMembers,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  solverProfiles,
  sweepDefinitions,
} from "@aerodb/db";
import { cleanupCampaignFixtures } from "@aerodb/db/test-cleanup";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const PREFIX = `pw-uransreq-${process.pid}-${Date.now().toString(36)}`;
const ADMIN_EMAIL = "admin@airfoils.pro";
const ADMIN_PASSWORD = "urans-request-test-password";

let app: Awaited<ReturnType<(typeof import("../src/server"))["buildServer"]>>;
let db: (typeof import("../src/db"))["db"];
let adminCookie = "";
let categoryId = "";
let airfoilId = "";
let presetId = "";
let revisionId = "";
let mediumId = "";
let bcId = "";
const registryIds: { table: string; id: string }[] = [];
const evidenceBlobIds: string[] = [];

const RESTART_ARCHIVE_MEMBERS = [
  "openfoam/transient/transient_start.json",
  "openfoam/transient/system/controlDict",
  "openfoam/transient/system/fvSchemes",
  "openfoam/transient/system/fvSolution",
  "openfoam/transient/constant/polyMesh/points",
  "openfoam/transient/constant/polyMesh/faces",
  "openfoam/transient/constant/polyMesh/owner",
  "openfoam/transient/constant/polyMesh/neighbour",
  "openfoam/transient/constant/polyMesh/boundary",
  "openfoam/transient/constant/transportProperties",
  "openfoam/transient/constant/turbulenceProperties",
  "time_directories/10/U",
  "time_directories/10/p",
  "time_directories/10/k",
  "time_directories/10/omega",
  "time_directories/10/nut",
  "time_directories/10/phi",
  "openfoam/postProcessing/forceCoeffs1/0/coefficient.dat",
] as const;

beforeAll(async () => {
  process.env.ADMIN_AUTH_REQUIRED = "true";
  process.env.ADMIN_AUTH_DISABLED = "false";
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.ADMIN_SESSION_SECRET = "urans-request-test-secret";
  delete process.env.ADMIN_GOOGLE_CLIENT_ID;
  delete process.env.ADMIN_GOOGLE_CLIENT_SECRET;

  const [{ buildServer }, dbModule] = await Promise.all([
    import("../src/server"),
    import("../src/db"),
  ]);
  db = dbModule.db;
  app = await buildServer();

  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const setCookie = login.headers["set-cookie"];
  adminCookie = String(
    Array.isArray(setCookie) ? setCookie[0] : setCookie,
  ).split(";")[0];

  const [category] = await db
    .insert(categories)
    .values({ slug: PREFIX, name: PREFIX, path: PREFIX, depth: 0 })
    .returning({ id: categories.id });
  categoryId = category.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-af`,
      name: `${PREFIX} airfoil`,
      categoryId,
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.06 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.06 },
        { x: 1, y: 0 },
      ],
    })
    .returning({ id: airfoils.id });
  airfoilId = airfoil.id;

  // Minimal preset graph so a real revision row exists to pin against.
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
      kinematicViscosity: 1.789e-5 / 1.225,
    })
    .returning({ id: mediums.id });
  mediumId = medium.id;
  registryIds.push({ table: "mediums", id: medium.id });
  // Legacy bc row so continuation source results rows can exist (results.bc_id
  // is NOT NULL).
  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-bc`,
      name: `${PREFIX} bc`,
      mediumId,
      reynolds: 300000,
    })
    .returning({ id: boundaryConditions.id });
  bcId = bc.id;
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${PREFIX}-flow`,
      name: `${PREFIX} flow`,
      mediumId: medium.id,
    })
    .returning({ id: flowConditions.id });
  const [geo] = await db
    .insert(referenceGeometryProfiles)
    .values({ slug: `${PREFIX}-geo`, name: `${PREFIX} geo` })
    .returning({ id: referenceGeometryProfiles.id });
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({ slug: `${PREFIX}-b`, name: `${PREFIX} b` })
    .returning({ id: boundaryProfiles.id });
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-m`, name: `${PREFIX} m` })
    .returning({ id: meshProfiles.id });
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${PREFIX}-s`, name: `${PREFIX} s` })
    .returning({ id: solverProfiles.id });
  const [sched] = await db
    .insert(schedulingProfiles)
    .values({ slug: `${PREFIX}-sc`, name: `${PREFIX} sc` })
    .returning({ id: schedulingProfiles.id });
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-o`, name: `${PREFIX} o` })
    .returning({ id: outputProfiles.id });
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({ slug: `${PREFIX}-sw`, name: `${PREFIX} sw` })
    .returning({ id: sweepDefinitions.id });
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${PREFIX}-preset`,
      name: `${PREFIX} preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: geo.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: sched.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      enabled: false,
    })
    .returning({ id: simulationPresets.id });
  presetId = preset.id;
  const [revision] = await db
    .insert(simulationPresetRevisions)
    .values({
      presetId: preset.id,
      revisionNumber: 1,
      signatureHash: `${PREFIX}-sig`,
      reynolds: 300000,
      referenceLengthM: 1,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      snapshot: {},
    })
    .returning({ id: simulationPresetRevisions.id });
  revisionId = revision.id;
  registryIds.push(
    { table: "flow_conditions", id: flow.id },
    { table: "reference_geometry_profiles", id: geo.id },
    { table: "boundary_profiles", id: boundary.id },
    { table: "mesh_profiles", id: mesh.id },
    { table: "solver_profiles", id: solver.id },
    { table: "scheduling_profiles", id: sched.id },
    { table: "output_profiles", id: output.id },
    { table: "sweep_definitions", id: sweep.id },
  );
});

async function attachExactRestartArchive(input: {
  resultId: string;
  resultAttemptId: string;
  airfoilId: string;
  engineJobId: string | null;
  engineCaseSlug: string | null;
  aoaDeg: number;
  omitMember?: string;
  backend?: "gcs" | "volume";
  compression?: "zstd" | "gzip";
}): Promise<void> {
  const [manifest] = await db
    .select({ id: solverEvidenceArtifacts.id })
    .from(solverEvidenceArtifacts)
    .where(
      sql`${solverEvidenceArtifacts.resultId} = ${input.resultId}::uuid
        AND ${solverEvidenceArtifacts.resultAttemptId} = ${input.resultAttemptId}::uuid
        AND ${solverEvidenceArtifacts.kind} = 'manifest'`,
    )
    .limit(1);
  if (!manifest) throw new Error("exact continuation manifest missing");
  const [bundle] = await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: input.resultId,
      resultAttemptId: input.resultAttemptId,
      airfoilId: input.airfoilId,
      engineJobId: input.engineJobId,
      engineCaseSlug: input.engineCaseSlug,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      aoaDeg: input.aoaDeg,
      kind: "engine_bundle",
      storageKey: `test/${PREFIX}/${input.resultAttemptId}/engine.tar.zst`,
      mimeType: "application/zstd",
      sha256: "b".repeat(64),
      byteSize: 4096,
    })
    .returning({ id: solverEvidenceArtifacts.id });
  const backend = input.backend ?? "gcs";
  const compression = input.compression ?? "zstd";
  const [blob] = await db
    .insert(solverEvidenceBlobs)
    .values({
      backend,
      bucket: backend === "gcs" ? "exact-continuation-api-test" : null,
      objectKey: `${PREFIX}/${input.resultAttemptId}.tar.${compression === "zstd" ? "zst" : "gz"}`,
      generation:
        backend === "gcs" ? String(30_000 + evidenceBlobIds.length) : null,
      compression,
      mimeType:
        compression === "zstd" ? "application/zstd" : "application/gzip",
      sha256: "c".repeat(64),
      byteSize: 4096,
      crc32c: "AAAAAA==",
      uncompressedTarSha256: "d".repeat(64),
      uncompressedTarByteSize: 8192,
      verifiedAt: new Date(),
    })
    .returning({ id: solverEvidenceBlobs.id });
  evidenceBlobIds.push(blob.id);
  const [archive] = await db
    .insert(solverEvidenceArchives)
    .values({
      resultId: input.resultId,
      resultAttemptId: input.resultAttemptId,
      sourceArtifactId: bundle.id,
      blobId: blob.id,
    })
    .returning({ id: solverEvidenceArchives.id });
  const memberPaths = RESTART_ARCHIVE_MEMBERS.filter(
    (path) => path !== input.omitMember,
  );
  const members = await db
    .insert(solverEvidenceArtifacts)
    .values(
      memberPaths.map((path, index) => ({
        resultId: input.resultId,
        resultAttemptId: input.resultAttemptId,
        airfoilId: input.airfoilId,
        engineJobId: input.engineJobId,
        engineCaseSlug: input.engineCaseSlug,
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        aoaDeg: input.aoaDeg,
        kind: "time_directory" as const,
        storageKey: `test/${PREFIX}/${input.resultAttemptId}/${path}`,
        mimeType: "application/octet-stream",
        sha256: (index % 16).toString(16).repeat(64),
        byteSize: 64,
      })),
    )
    .returning({ id: solverEvidenceArtifacts.id });
  await db.insert(solverEvidenceArtifactMembers).values([
    {
      archiveId: archive.id,
      artifactId: manifest.id,
      memberPath: "evidence_manifest.json",
    },
    ...members.map((member, index) => ({
      archiveId: archive.id,
      artifactId: member.id,
      memberPath: memberPaths[index]!,
    })),
  ]);
}

async function attachRestartableAttempt(
  resultId: string,
  opts: {
    archive?: "valid" | "missing" | "incomplete" | "volume" | "gzip";
    classification?: "accepted" | "rejected";
    engineCase?: boolean;
    revisionId?: string;
    aoaDeg?: number;
    fidelity?: "rans" | "urans_precalc" | "urans_full";
    source?: "queued" | "solved";
    status?: "done" | "failed" | "running";
    warnings?: string[];
  } = {},
): Promise<string> {
  const [result] = await db
    .select()
    .from(results)
    .where(eq(results.id, resultId))
    .limit(1);
  if (!result) throw new Error(`missing continuation fixture ${resultId}`);
  const targetRevisionId = opts.revisionId ?? result.simulationPresetRevisionId;
  if (!targetRevisionId)
    throw new Error(`continuation fixture ${resultId} has no revision`);
  const aoaDeg = opts.aoaDeg ?? result.aoaDeg;
  const engineCase = opts.engineCase ?? true;
  const warnings = opts.warnings ??
    result.qualityWarnings ?? [
      `URANS continuation ${URANS_CONTINUATION_REQUIRED_MARKER}: restartable test checkpoint retained`,
    ];
  const [attempt] = await db
    .insert(resultAttempts)
    .values({
      resultId,
      airfoilId: result.airfoilId,
      bcId: result.bcId,
      simulationPresetRevisionId: targetRevisionId,
      aoaDeg,
      engineJobId: engineCase
        ? (result.engineJobId ?? `${PREFIX}-engine-${aoaDeg}`)
        : null,
      engineCaseSlug: engineCase
        ? (result.engineCaseSlug ?? `aoa_${aoaDeg}`)
        : null,
      methodKey: "openfoam.urans",
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      status: opts.status ?? "done",
      source: opts.source ?? "solved",
      regime: "urans",
      validForPolar: false,
      cl: result.cl,
      cd: result.cd,
      cm: result.cm,
      converged: result.converged,
      unsteady: true,
      qualityWarnings: warnings,
      evidencePayload: {
        fidelity: opts.fidelity ?? result.fidelity ?? "urans_precalc",
      },
      solvedAt: result.solvedAt ?? new Date(),
    })
    .returning();
  await db.insert(resultClassifications).values({
    resultAttemptId: attempt.id,
    airfoilId: result.airfoilId,
    simulationPresetRevisionId: targetRevisionId,
    aoaDeg,
    regime: "urans",
    classifierVersion: "exact-continuation-api-test-v1",
    state: opts.classification ?? "rejected",
    region: "post_stall",
    confidence: 1,
    reasons: ["continuation-required"],
  });
  await db.insert(solverEvidenceArtifacts).values({
    resultId,
    resultAttemptId: attempt.id,
    airfoilId: result.airfoilId,
    engineJobId: attempt.engineJobId,
    engineCaseSlug: attempt.engineCaseSlug,
    aoaDeg,
    kind: "manifest",
    storageKey: `test/${PREFIX}/${resultId}/${attempt.id}/manifest.json`,
    mimeType: "application/json",
    sha256: "a".repeat(64),
    byteSize: 1,
    metadata: { fixture: "exact-continuation" },
  });
  await db
    .update(results)
    .set({ currentResultAttemptId: attempt.id })
    .where(eq(results.id, resultId));
  if (opts.archive !== "missing") {
    await attachExactRestartArchive({
      resultId,
      resultAttemptId: attempt.id,
      airfoilId: result.airfoilId,
      engineJobId: attempt.engineJobId,
      engineCaseSlug: attempt.engineCaseSlug,
      aoaDeg,
      ...(opts.archive === "incomplete"
        ? { omitMember: "time_directories/10/p" }
        : {}),
      ...(opts.archive === "volume" ? { backend: "volume" as const } : {}),
      ...(opts.archive === "gzip" ? { compression: "gzip" as const } : {}),
    });
  }
  return attempt.id;
}

async function createContinuationSource(
  aoaDeg: number,
  opts: Parameters<typeof attachRestartableAttempt>[1] = {},
): Promise<{ resultId: string; resultAttemptId: string }> {
  const [source] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg,
      status: "done",
      source: "solved",
      regime: "urans",
      fidelity: opts.fidelity === "urans_full" ? "urans_full" : "urans_precalc",
      unsteady: true,
      converged: true,
      cl: 0.4 + aoaDeg / 100,
      cd: 0.05,
      engineJobId: `${PREFIX}-guard-${aoaDeg}`,
      engineCaseSlug: `aoa_${aoaDeg}`,
      qualityWarnings: opts.warnings ?? [
        `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: exact checkpoint retained`,
      ],
      solvedAt: new Date(),
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      methodKey: "openfoam.urans",
    })
    .returning({ id: results.id });
  const resultAttemptId = await attachRestartableAttempt(source.id, opts);
  return { resultId: source.id, resultAttemptId };
}

afterAll(async () => {
  if (db) {
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.revisionId, revisionId));
    // Continuation fixtures: results rows before the revision/bc they reference.
    await db
      .delete(results)
      .where(eq(results.simulationPresetRevisionId, revisionId));
    if (evidenceBlobIds.length) {
      await db
        .delete(solverEvidenceBlobs)
        .where(inArray(solverEvidenceBlobs.id, evidenceBlobIds));
    }
    if (bcId)
      await db
        .delete(boundaryConditions)
        .where(eq(boundaryConditions.id, bcId));
    if (presetId) {
      await db
        .delete(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.presetId, presetId));
      await db
        .delete(simulationPresets)
        .where(eq(simulationPresets.id, presetId));
    }
    const byTable: Record<string, unknown> = {
      mediums,
      flow_conditions: flowConditions,
      reference_geometry_profiles: referenceGeometryProfiles,
      boundary_profiles: boundaryProfiles,
      mesh_profiles: meshProfiles,
      solver_profiles: solverProfiles,
      scheduling_profiles: schedulingProfiles,
      output_profiles: outputProfiles,
      sweep_definitions: sweepDefinitions,
    };
    // Delete in reverse FK order: preset gone, so registry rows are free;
    // medium last (flow references it).
    for (const entry of [...registryIds].reverse()) {
      const table = byTable[entry.table] as typeof mediums;
      await db.delete(table).where(eq(table.id, entry.id));
    }
    if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
    if (categoryId)
      await db.delete(categories).where(eq(categories.id, categoryId));
  }
  await app?.close();
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/admin/urans-requests (contract 6)", () => {
  it("requires admin auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      payload: { airfoilId, revisionId, aoaDeg: 8, fidelity: "precalc" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("validates payload and 404s unknown airfoil/revision", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, fidelity: "ultra" },
    });
    expect(bad.statusCode).toBe(400);
    const missing = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        airfoilId,
        revisionId: "00000000-0000-4000-8000-000000000000",
        fidelity: "full",
      },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("creates a work item, replays idempotently per (cell, fidelity), and lists it for the cell scope", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, aoaDeg: 8, fidelity: "precalc" },
    });
    expect(first.statusCode).toBe(201);
    const created = first.json() as {
      created: boolean;
      request: {
        id: string;
        state: string;
        backgroundOwner: boolean;
        requestedBy: string | null;
        aoaDeg: number;
      };
    };
    expect(created.created).toBe(true);
    expect(created.request.state).toBe("pending");
    expect(created.request.aoaDeg).toBe(8);
    expect(created.request.backgroundOwner).toBe(true);
    expect(created.request.requestedBy).toBe(ADMIN_EMAIL);

    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, aoaDeg: 8, fidelity: "precalc" },
    });
    expect(replay.statusCode).toBe(200);
    const replayed = replay.json() as {
      created: boolean;
      request: { id: string };
    };
    expect(replayed.created).toBe(false);
    expect(replayed.request.id).toBe(created.request.id);

    // Exact-angle work already exists, so a later whole-polar request would
    // overlap it. The API surfaces the typed coverage conflict instead of
    // silently stacking duplicate solver work.
    const conflictingWhole = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, fidelity: "precalc" },
    });
    expect(conflictingWhole.statusCode).toBe(409);
    expect(conflictingWhole.json()).toMatchObject({
      code: "whole_polar_overlaps_open_exact",
      conflictingRequestIds: [created.request.id],
    });

    await db
      .update(simUransRequests)
      .set({ state: "cancelled" })
      .where(eq(simUransRequests.id, created.request.id));
    const wholePolar = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, fidelity: "precalc" },
    });
    expect(wholePolar.statusCode).toBe(201);
    const whole = wholePolar.json() as {
      request: { id: string; aoaDeg: number | null };
    };
    expect(whole.request.aoaDeg).toBeNull();

    // A whole-polar item covers every exact angle, so exact-after-whole reuses
    // the global item rather than inserting another row.
    const coveredExact = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, aoaDeg: 9, fidelity: "precalc" },
    });
    expect(coveredExact.statusCode).toBe(200);
    expect(
      (coveredExact.json() as { request: { id: string } }).request.id,
    ).toBe(whole.request.id);

    const list = await app.inject({
      method: "GET",
      url: `/api/admin/urans-requests?airfoilId=${airfoilId}&revisionId=${revisionId}`,
      headers: { cookie: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      requests: { id: string }[];
      verifyItems: unknown[];
    };
    expect(body.requests.length).toBe(2);
    expect(body.verifyItems).toEqual([]);

    // DB truth: exactly the two open rows, isolated to this test's revision.
    const rows = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.revisionId, revisionId));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.state).sort()).toEqual(["cancelled", "pending"]);
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.revisionId, revisionId));
  });

  it("promotes a reused automatic request to independent ownership without rewriting its creator", async () => {
    const [automatic] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: 7.75,
        fidelity: "precalc",
        state: "pending",
        backgroundOwner: false,
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      })
      .returning();

    const reuse = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, aoaDeg: 7.75, fidelity: "precalc" },
    });
    expect(reuse.statusCode).toBe(200);
    const body = reuse.json() as {
      created: boolean;
      request: {
        id: string;
        backgroundOwner: boolean;
        requestedBy: string | null;
      };
    };
    expect(body).toMatchObject({
      created: false,
      request: {
        id: automatic.id,
        backgroundOwner: true,
        requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
      },
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/admin/urans-requests?airfoilId=${airfoilId}&revisionId=${revisionId}`,
      headers: { cookie: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const listed = (
      list.json() as {
        requests: Array<{
          id: string;
          backgroundOwner: boolean;
          independentOwner: boolean;
          requestedBy: string | null;
        }>;
      }
    ).requests.find((request) => request.id === automatic.id);
    expect(listed).toMatchObject({
      backgroundOwner: true,
      independentOwner: true,
      requestedBy: AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
    });
    await db
      .delete(simUransRequests)
      .where(eq(simUransRequests.id, automatic.id));
  });
});

describe("POST /api/admin/urans-requests continuation mode (amendment C)", () => {
  it("derives cell + fidelity from the source row and persists continue_from_result_id + budget_override_s", async () => {
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 9,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_full",
        unsteady: true,
        converged: true,
        cl: 0.9,
        cd: 0.07,
        engineJobId: `${PREFIX}-engine-src`,
        engineCaseSlug: "aoa_9.00",
        qualityWarnings: [
          "URANS integration stopped by the wall-clock budget guard: retained 4.1 of 7 periods (budget); projected 6.4h continuation exceeds 80% of the 12.0h solver timeout",
        ],
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const sourceAttemptId = await attachRestartableAttempt(source.id, {
      fidelity: "urans_full",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: source.id,
        continueFromResultAttemptId: sourceAttemptId,
        budgetOverrideS: 21600,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      created: boolean;
      request: {
        airfoilId: string;
        revisionId: string;
        aoaDeg: number;
        fidelity: string;
        state: string;
        continueFromResultId: string | null;
        continueFromResultAttemptId: string | null;
        budgetOverrideS: number | null;
        requestedBy: string | null;
      };
    };
    expect(body.created).toBe(true);
    expect(body.request.airfoilId).toBe(airfoilId);
    expect(body.request.revisionId).toBe(revisionId);
    expect(body.request.aoaDeg).toBe(9);
    expect(body.request.fidelity).toBe("full"); // derived from urans_full evidence
    expect(body.request.state).toBe("pending");
    expect(body.request.continueFromResultId).toBe(source.id);
    expect(body.request.continueFromResultAttemptId).toBe(sourceAttemptId);
    expect(body.request.budgetOverrideS).toBe(21600);
    expect(body.request.requestedBy).toBe(ADMIN_EMAIL);
  });

  it("MUST-CATCH: requires one exact result+attempt pair and rejects every non-restartable generation shape", async () => {
    const paired = await createContinuationSource(40);
    for (const payload of [
      { continueFromResultId: paired.resultId },
      { continueFromResultAttemptId: paired.resultAttemptId },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/urans-requests",
        headers: { cookie: adminCookie },
        payload,
      });
      expect(response.statusCode).toBe(400);
    }

    const otherAngle = await createContinuationSource(41);
    const mismatchedAnglePair = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: paired.resultId,
        continueFromResultAttemptId: otherAngle.resultAttemptId,
      },
    });
    expect(mismatchedAnglePair.statusCode).toBe(404);

    const [otherAirfoil] = await db
      .insert(airfoils)
      .values({
        slug: `${PREFIX}-other-continuation-owner`,
        name: `${PREFIX} other continuation owner`,
        categoryId,
        points: [
          { x: 1, y: 0 },
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
      })
      .returning({ id: airfoils.id });
    const [otherOwnerResult] = await db
      .insert(results)
      .values({
        airfoilId: otherAirfoil.id,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 42,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        converged: true,
        engineJobId: `${PREFIX}-other-owner-job`,
        engineCaseSlug: "aoa_42",
        qualityWarnings: [
          `URANS ${URANS_CONTINUATION_REQUIRED_MARKER}: exact checkpoint retained`,
        ],
        solvedAt: new Date(),
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        methodKey: "openfoam.urans",
      })
      .returning({ id: results.id });
    const otherOwnerAttemptId = await attachRestartableAttempt(
      otherOwnerResult.id,
    );
    const mismatchedOwnerPair = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: paired.resultId,
        continueFromResultAttemptId: otherOwnerAttemptId,
      },
    });
    expect(mismatchedOwnerPair.statusCode).toBe(404);
    await db.delete(airfoils).where(eq(airfoils.id, otherAirfoil.id));

    const variants = [
      { name: "attempt-status", opts: { status: "running" as const } },
      { name: "typed-source", opts: { source: "queued" as const } },
      { name: "wrong-fidelity", opts: { fidelity: "rans" as const } },
      {
        name: "classification",
        opts: { classification: "accepted" as const },
      },
      { name: "marker", opts: { warnings: [] } },
      { name: "missing-archive", opts: { archive: "missing" as const } },
      {
        name: "incomplete-archive",
        opts: { archive: "incomplete" as const },
      },
    ];
    for (let index = 0; index < variants.length; index += 1) {
      const variant = variants[index]!;
      const source = await createContinuationSource(43 + index / 10, {
        ...variant.opts,
      });
      const response = await app.inject({
        method: "POST",
        url: "/api/admin/urans-requests",
        headers: { cookie: adminCookie },
        payload: {
          continueFromResultId: source.resultId,
          continueFromResultAttemptId: source.resultAttemptId,
          budgetOverrideS: 7200,
        },
      });
      expect(response.statusCode, variant.name).toBe(422);
      expect(
        await db
          .select({ id: simUransRequests.id })
          .from(simUransRequests)
          .where(
            eq(
              simUransRequests.continueFromResultAttemptId,
              source.resultAttemptId,
            ),
          ),
        variant.name,
      ).toEqual([]);
    }

    const invalidResultStatus = await createContinuationSource(44.5);
    await db
      .update(results)
      .set({ status: "pending" })
      .where(eq(results.id, invalidResultStatus.resultId));
    const invalidResultResponse = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: invalidResultStatus.resultId,
        continueFromResultAttemptId: invalidResultStatus.resultAttemptId,
      },
    });
    expect(invalidResultResponse.statusCode).toBe(422);
  }, 120_000);

  it("422s a source without saved case state, 404s unknown sources, 400s a stray budget override", async () => {
    const [noCase] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 10,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        converged: true,
        cl: 0.5,
        cd: 0.06,
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const noCaseAttemptId = await attachRestartableAttempt(noCase.id, {
      engineCase: false,
      fidelity: "urans_precalc",
    });
    const missingCase = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: noCase.id,
        continueFromResultAttemptId: noCaseAttemptId,
        budgetOverrideS: 7200,
      },
    });
    expect(missingCase.statusCode).toBe(422);

    const unknown = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: "00000000-0000-4000-8000-000000000000",
        continueFromResultAttemptId: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(unknown.statusCode).toBe(404);

    const strayBudget = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        airfoilId,
        revisionId,
        aoaDeg: 2,
        fidelity: "precalc",
        budgetOverrideS: 7200,
      },
    });
    expect(strayBudget.statusCode).toBe(400);
  });

  it("400s a budget override above the engine cap (URANS_BUDGET_OVERRIDE_MAX_S = 86400) instead of queuing a doomed request", async () => {
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 12,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        converged: true,
        cl: 0.6,
        cd: 0.05,
        engineJobId: `${PREFIX}-engine-cap`,
        engineCaseSlug: "aoa_12.00",
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const sourceAttemptId = await attachRestartableAttempt(source.id, {
      fidelity: "urans_precalc",
    });
    // 24h is the engine's le= bound: accepted here, accepted at engine submit.
    const atCap = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: source.id,
        continueFromResultAttemptId: sourceAttemptId,
        budgetOverrideS: 24 * 3600,
      },
    });
    expect(atCap.statusCode).toBe(201);
    // 48h passed the old zod bound but the engine 422s it at submit and the
    // request is cancelled — an avoidable dead-end. Reject it up front.
    const aboveCap = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: source.id,
        continueFromResultAttemptId: sourceAttemptId,
        budgetOverrideS: 48 * 3600,
      },
    });
    expect(aboveCap.statusCode).toBe(400);
  });

  it("409s a continuation whose cell is covered by an open NON-continuation request (a fresh solve must never be presented as a resume)", async () => {
    const [source] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 13,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        converged: true,
        cl: 0.55,
        cd: 0.052,
        engineJobId: `${PREFIX}-engine-mix`,
        engineCaseSlug: "aoa_13.00",
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const sourceAttemptId = await attachRestartableAttempt(source.id, {
      fidelity: "urans_precalc",
    });
    // An admin queues an ordinary fresh-solve request-URANS on the cell first.
    const fresh = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: { airfoilId, revisionId, aoaDeg: 13, fidelity: "precalc" },
    });
    expect(fresh.statusCode).toBe(201);
    // Later, Continue +6h on the same cell: the open item is NOT a
    // continuation — reusing it would silently discard the saved case state.
    const cont = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: source.id,
        continueFromResultAttemptId: sourceAttemptId,
        budgetOverrideS: 21600,
      },
    });
    expect(cont.statusCode).toBe(409);
    const body = cont.json() as {
      error: string;
      request: { continueFromResultId: string | null };
    };
    expect(body.error).toContain("NOT a continuation");
    expect(body.request.continueFromResultId).toBeNull();
    // Replaying a MATCHING continuation still reuses idempotently (200).
    const [source14] = await db
      .insert(results)
      .values({
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 14,
        status: "done",
        source: "solved",
        regime: "urans",
        fidelity: "urans_precalc",
        unsteady: true,
        converged: true,
        cl: 0.5,
        cd: 0.05,
        engineJobId: `${PREFIX}-engine-idem`,
        engineCaseSlug: "aoa_14.00",
        solvedAt: new Date(),
      })
      .returning({ id: results.id });
    const source14AttemptId = await attachRestartableAttempt(source14.id, {
      fidelity: "urans_precalc",
    });
    const first = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: source14.id,
        continueFromResultAttemptId: source14AttemptId,
        budgetOverrideS: 7200,
      },
    });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: source14.id,
        continueFromResultAttemptId: source14AttemptId,
        budgetOverrideS: 7200,
      },
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { created: boolean }).created).toBe(false);
  });

  it("MUST-CATCH: exact-pair reuse never retargets a pending/running different generation or a whole-polar request", async () => {
    const source = await createContinuationSource(51);
    const first = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: source.resultId,
        continueFromResultAttemptId: source.resultAttemptId,
        budgetOverrideS: 7200,
      },
    });
    expect(first.statusCode).toBe(201);
    const firstRequest = (first.json() as { request: { id: string } }).request;

    const competingAttemptId = await attachRestartableAttempt(source.resultId);
    const pendingConflict = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: source.resultId,
        continueFromResultAttemptId: competingAttemptId,
        budgetOverrideS: 7200,
      },
    });
    expect(pendingConflict.statusCode).toBe(409);
    expect(
      (pendingConflict.json() as { request: { id: string } }).request.id,
    ).toBe(firstRequest.id);

    await db
      .update(simUransRequests)
      .set({ state: "running" })
      .where(eq(simUransRequests.id, firstRequest.id));
    const runningConflict = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: source.resultId,
        continueFromResultAttemptId: competingAttemptId,
      },
    });
    expect(runningConflict.statusCode).toBe(409);
    const [stillPinned] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, firstRequest.id));
    expect(stillPinned).toMatchObject({
      state: "running",
      continueFromResultId: source.resultId,
      continueFromResultAttemptId: source.resultAttemptId,
    });
    await db
      .update(simUransRequests)
      .set({ state: "cancelled" })
      .where(eq(simUransRequests.id, firstRequest.id));

    const wholeSource = await createContinuationSource(52);
    const [whole] = await db
      .insert(simUransRequests)
      .values({
        airfoilId,
        revisionId,
        aoaDeg: null,
        fidelity: "precalc",
        state: "pending",
        backgroundOwner: true,
        requestedBy: `${PREFIX}-whole-conflict`,
      })
      .returning();
    const wholeConflict = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests",
      headers: { cookie: adminCookie },
      payload: {
        continueFromResultId: wholeSource.resultId,
        continueFromResultAttemptId: wholeSource.resultAttemptId,
      },
    });
    expect(wholeConflict.statusCode).toBe(409);
    expect(
      (wholeConflict.json() as { request: { id: string } }).request.id,
    ).toBe(whole.id);
    const [stillWhole] = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, whole.id));
    expect(stillWhole).toMatchObject({
      state: "pending",
      aoaDeg: null,
      continueFromResultId: null,
      continueFromResultAttemptId: null,
    });
  }, 120_000);
});

describe("POST /api/admin/urans-requests/bulk-continue (bulk resume)", () => {
  // Hermetic on the shared dev DB: everything scoped to a fixture CAMPAIGN so
  // the bulk sweep can never touch (or create requests for) foreign rows.
  const BPREFIX = `${PREFIX}-bulk`;
  let campaignId = "";
  let campaignRevisionId = "";
  const bulkOwned = {
    medium: "",
    boundary: "",
    mesh: "",
    solver: "",
    output: "",
  };

  afterAll(async () => {
    await cleanupCampaignFixtures(db, {
      campaignIds: [campaignId],
      presetSlugPrefix: `campaign-${BPREFIX.toLowerCase()}`,
    });
    if (bulkOwned.boundary)
      await db
        .delete(boundaryProfiles)
        .where(eq(boundaryProfiles.id, bulkOwned.boundary));
    if (bulkOwned.mesh)
      await db.delete(meshProfiles).where(eq(meshProfiles.id, bulkOwned.mesh));
    if (bulkOwned.solver)
      await db
        .delete(solverProfiles)
        .where(eq(solverProfiles.id, bulkOwned.solver));
    if (bulkOwned.output)
      await db
        .delete(outputProfiles)
        .where(eq(outputProfiles.id, bulkOwned.output));
    if (bulkOwned.medium)
      await db.delete(mediums).where(eq(mediums.id, bulkOwned.medium));
  });

  it("queues continuations for exactly the continuable needs-review rows of the campaign", async () => {
    // Minimal plan fixtures (own medium + numerics profiles).
    const [medium] = await db
      .insert(mediums)
      .values({
        slug: `${BPREFIX}-air`,
        name: `${BPREFIX} air`,
        phase: "gas",
        density: 1.225,
        viscosityModel: "constant",
        constantDynamicViscosity: 1.789e-5,
        dynamicViscosity: 1.789e-5,
        kinematicViscosity: 1.789e-5 / 1.225,
        speedOfSound: 340.3,
      })
      .returning({ id: mediums.id });
    const [bp] = await db
      .insert(boundaryProfiles)
      .values({ slug: `${BPREFIX}-b`, name: `${BPREFIX} b` })
      .returning({ id: boundaryProfiles.id });
    const [mp] = await db
      .insert(meshProfiles)
      .values({ slug: `${BPREFIX}-m`, name: `${BPREFIX} m` })
      .returning({ id: meshProfiles.id });
    const [sp] = await db
      .insert(solverProfiles)
      .values({ slug: `${BPREFIX}-s`, name: `${BPREFIX} s` })
      .returning({ id: solverProfiles.id });
    const [op] = await db
      .insert(outputProfiles)
      .values({ slug: `${BPREFIX}-o`, name: `${BPREFIX} o` })
      .returning({ id: outputProfiles.id });
    bulkOwned.medium = medium.id;
    bulkOwned.boundary = bp.id;
    bulkOwned.mesh = mp.id;
    bulkOwned.solver = sp.id;
    bulkOwned.output = op.id;

    const launch = await app.inject({
      method: "POST",
      url: "/api/admin/campaigns",
      headers: { cookie: adminCookie },
      payload: {
        name: `${BPREFIX} campaign`,
        priority: 5,
        idempotencyKey: `${BPREFIX}-key`,
        airfoilIds: [airfoilId],
        plan: {
          mediumId: medium.id,
          ambients: [[288.15, 101325]],
          speedsMps: [17.9137],
          chordsM: [0.29137],
          spanM: 1,
          areaMode: "derived",
          excludedConditions: [],
          baseSweep: { fromDeg: 5, toDeg: 11, stepDeg: 1, listDeg: null },
          objectives: {
            ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
            clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 4 },
            clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 4 },
          },
          numerics: {
            boundaryProfileId: bp.id,
            meshProfileId: mp.id,
            solverProfileId: sp.id,
            outputProfileId: op.id,
          },
        },
      },
    });
    expect(launch.statusCode).toBe(201);
    campaignId = launch.json().campaign.id;
    const [condition] = (await db.execute(sql`
      SELECT id, simulation_preset_revision_id AS revision_id, preset_id FROM sim_campaign_conditions WHERE campaign_id = ${campaignId}
    `)) as unknown as Array<{
      id: string;
      revision_id: string;
      preset_id: string;
    }>;
    campaignRevisionId = condition.revision_id;

    // Three terminal-rejected precalc rows in the campaign: 5° is budget-
    // stopped and 7° reached the bounded same-case chunk cap; both have saved
    // state and are continuable. 6° has no restartable marker and is excluded.
    const mkRow = async (
      aoa: number,
      warnings: string[],
      archive: Parameters<
        typeof attachRestartableAttempt
      >[1]["archive"] = "valid",
    ) => {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: campaignRevisionId,
          aoaDeg: aoa,
          status: "done",
          source: "solved",
          regime: "urans",
          fidelity: "urans_precalc",
          unsteady: true,
          converged: true,
          cl: 0.4 + aoa / 100,
          cd: 0.02,
          qualityWarnings: warnings,
          engineJobId: `${BPREFIX}-engine-${aoa}`,
          engineCaseSlug: `aoa_${aoa}.00`,
          solvedAt: new Date(),
        })
        .returning({ id: results.id });
      await db.execute(sql`
        INSERT INTO result_classifications (result_id, airfoil_id, simulation_preset_revision_id, aoa_deg, regime, classifier_version, state, region, confidence)
        VALUES (${row.id}, ${airfoilId}, ${campaignRevisionId}, ${aoa}, 'urans', 'test-fixture', 'rejected', 'post_stall', 0.9)
      `);
      const resultAttemptId = await attachRestartableAttempt(row.id, {
        revisionId: campaignRevisionId,
        aoaDeg: aoa,
        fidelity: "urans_precalc",
        warnings,
        archive,
      });
      await db.execute(sql`
        UPDATE sim_campaign_points
        SET state = 'terminal', result_id = ${row.id},
            result_attempt_id = ${resultAttemptId}
        WHERE campaign_id = ${campaignId} AND aoa_deg = ${aoa} AND NOT derived_by_symmetry
      `);
      return { resultId: row.id, resultAttemptId };
    };
    const budgetStopped =
      "URANS integration stopped by the wall-clock budget guard: retained 1.1 of 3 periods (budget)";
    const rowA = await mkRow(5, [budgetStopped]);
    await mkRow(6, [
      "URANS quality could not be measured: missing or flat shedding history.",
    ]);
    const rowC = await mkRow(7, [
      `URANS continuation ${URANS_CONTINUATION_REQUIRED_MARKER}: reached the 6-chunk in-run safety cap with restartable saved case state; URANS window not stationary (precalc established-oscillation test): cycle means trend upward monotonically`,
    ]);
    const restartableWarning = [
      `URANS continuation ${URANS_CONTINUATION_REQUIRED_MARKER}: exact saved state retained`,
    ];
    await mkRow(8, restartableWarning, "missing");
    await mkRow(9, restartableWarning, "incomplete");
    await mkRow(10, restartableWarning, "volume");
    await mkRow(11, restartableWarning, "gzip");

    const res = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests/bulk-continue",
      headers: { cookie: adminCookie },
      payload: { campaignId, budgetOverrideS: 21600 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      continuable: 2,
      created: 2,
      reused: 0,
      conflicted: 0,
    });

    const queued = await db
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.revisionId, campaignRevisionId));
    expect(queued.length).toBe(2);
    for (const q of queued) {
      expect(q.state).toBe("pending");
      expect(q.fidelity).toBe("precalc");
      expect(q.budgetOverrideS).toBe(21600);
      const expected = [rowA, rowC].find(
        (row) => row.resultId === q.continueFromResultId,
      );
      expect(expected).toBeDefined();
      expect(q.continueFromResultAttemptId).toBe(expected!.resultAttemptId);
    }

    // Replay: the queued cells are now SCHEDULED, so they leave the
    // needs-review bucket entirely — zeros across the board, and the request
    // table is unchanged (idempotency at the bucket level, not just per-cell).
    const replay = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests/bulk-continue",
      headers: { cookie: adminCookie },
      payload: { campaignId, budgetOverrideS: 21600 },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({
      continuable: 0,
      created: 0,
      reused: 0,
      conflicted: 0,
    });
    expect(
      (
        await db
          .select()
          .from(simUransRequests)
          .where(eq(simUransRequests.revisionId, campaignRevisionId))
      ).length,
    ).toBe(2);

    // Foreign-campaign scoping: a random campaign id sweeps nothing.
    const foreign = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests/bulk-continue",
      headers: { cookie: adminCookie },
      payload: {
        campaignId: "00000000-0000-4000-8000-000000000000",
        budgetOverrideS: 21600,
      },
    });
    expect(foreign.statusCode).toBe(200);
    expect(foreign.json().continuable).toBe(0);
  });

  it("requires admin auth and a budget", async () => {
    const noAuth = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests/bulk-continue",
      payload: { budgetOverrideS: 7200 },
    });
    expect([401, 403]).toContain(noAuth.statusCode);
    const noBudget = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests/bulk-continue",
      headers: { cookie: adminCookie },
      payload: {},
    });
    expect(noBudget.statusCode).toBe(400);
    const overCap = await app.inject({
      method: "POST",
      url: "/api/admin/urans-requests/bulk-continue",
      headers: { cookie: adminCookie },
      payload: { budgetOverrideS: 48 * 3600 },
    });
    expect(overCap.statusCode).toBe(400);
  });
});
