import { PublicPointReader, PUBLIC_POINT_CONNECTIONS } from "../src/public-point-reader";
import {
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  fieldRenderCache,
  flowConditions,
  forceHistory,
  meshProfiles,
  mediums,
  outputProfiles,
  referenceGeometryProfiles,
  remoteAssetReferences,
  RESULT_MEDIA_LOCAL_BYTES_UNAVAILABLE_MARKER,
  resultAttempts,
  resultClassifications,
  resultMedia,
  resultMediaStorageUploads,
  results,
  schedulingProfiles,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  solverEvidenceArtifacts,
  sweepDefinitions,
  syncApiPermissions,
  syncApiSettings,
} from "@aerodb/db";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { db, sql as interactiveSql, syncSql, syncControlSql, advisoryLockSql, closeDatabasePools } from "../src/db";
import { verifyInteractivePool } from "./interactive-pool-fixture";
import { buildServer } from "../src/server";
import { loadSolverHistorySource } from "@aerodb/db/solver-history-storage";
import { decodeSolverHistory, encodeSolverHistory, type SolverHistoryArchiveIdentity } from "@aerodb/core/solver-history-storage";
import { SolverHistoryGcsStore } from "@aerodb/core/solver-history-gcs";
import { archiveSolverHistory } from "../../sweeper/src/solver-history-archive";
import type { DB } from "@aerodb/db/client";
import { verifyAttemptEvidenceApiAccess, verifyAttemptEvidenceApiReadthrough } from "./attempt-evidence-readthrough-fixture";

const attemptReadScope = vi.hoisted(() => ({ connection: null as DB | null }));
vi.mock("../src/db", async (original) => {
  const actual = await original<typeof import("../src/db")>();
  const scoped = (pool: DB) => new Proxy(pool, {
    get(target, property) {
      const connection = attemptReadScope.connection ?? target;
      const value = Reflect.get(connection, property);
      return typeof value === "function" ? value.bind(connection) : value;
    },
  });
  return { ...actual, db: scoped(actual.db), syncDb: scoped(actual.syncDb) };
});

import { checkHzHistoryApi } from "./hz-point-history-fixture";
import { noSheddingCertificate } from "../../../packages/core/test/no-shedding-fixture";
import { periodicPoint } from "../../../packages/db/test-support/periodic-urans-point";

const PREFIX = `api-exact-${process.pid}-${Date.now().toString(36)}`;
const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

let app: Awaited<ReturnType<typeof buildServer>>;
let categoryId = "";
let airfoilId = "";
let bcId = "";
let revisionId = "";
let presetId = "";
let flowId = "";
let referenceId = "";
let boundaryProfileId = "";
let meshId = "";
let solverId = "";
let schedulingId = "";
let outputId = "";
let sweepId = "";
let resultId = "";
let oldAttemptId = "";
let currentAttemptId = "";
let currentManifestSha = "";

beforeAll(async () => {
  app = await buildServer();
  const [medium] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, "air"))
    .limit(1);
  if (!medium) throw new Error("seeded air medium is required");
  const [category] = await db
    .insert(categories)
    .values({
      slug: `${PREFIX}-cat`,
      name: `${PREFIX} category`,
      path: `${PREFIX}-cat`,
      depth: 0,
    })
    .returning();
  categoryId = category.id;
  const [airfoil] = await db
    .insert(airfoils)
    .values({
      slug: `${PREFIX}-foil`,
      name: `${PREFIX} foil`,
      categoryId,
      points: [
        { x: 1, y: 0 },
        { x: 0.5, y: 0.08 },
        { x: 0, y: 0 },
        { x: 0.5, y: -0.08 },
        { x: 1, y: 0 },
      ],
    })
    .returning();
  airfoilId = airfoil.id;
  const [bc] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${PREFIX}-bc`,
      name: `${PREFIX} condition`,
      mediumId: medium.id,
      reynolds: 171_000,
      referenceChordM: 0.1,
      speedMps: 25,
      temperatureK: medium.refTemperatureK,
      pressurePa: medium.refPressurePa,
      density: medium.density,
      dynamicViscosity: medium.dynamicViscosity,
      kinematicViscosity: medium.kinematicViscosity,
      mach: 0.073,
      enabled: false,
    })
    .returning();
  bcId = bc.id;
  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${PREFIX}-flow`,
      name: `${PREFIX} flow`,
      mediumId: medium.id,
      speedMps: 25,
      temperatureK: medium.refTemperatureK,
      pressurePa: medium.refPressurePa,
      density: medium.density,
      dynamicViscosity: medium.dynamicViscosity,
      kinematicViscosity: medium.kinematicViscosity,
      mach: 0.073,
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
      referenceLengthM: 0.1,
    })
    .returning();
  referenceId = reference.id;
  const [boundaryProfile] = await db
    .insert(boundaryProfiles)
    .values({ slug: `${PREFIX}-boundary`, name: `${PREFIX} boundary` })
    .returning();
  boundaryProfileId = boundaryProfile.id;
  const [mesh] = await db
    .insert(meshProfiles)
    .values({ slug: `${PREFIX}-mesh`, name: `${PREFIX} mesh` })
    .returning();
  meshId = mesh.id;
  const [solver] = await db
    .insert(solverProfiles)
    .values({ slug: `${PREFIX}-solver`, name: `${PREFIX} solver` })
    .returning();
  solverId = solver.id;
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({ slug: `${PREFIX}-scheduling`, name: `${PREFIX} scheduling` })
    .returning();
  schedulingId = scheduling.id;
  const [output] = await db
    .insert(outputProfiles)
    .values({ slug: `${PREFIX}-output`, name: `${PREFIX} output` })
    .returning();
  outputId = output.id;
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${PREFIX}-sweep`,
      name: `${PREFIX} sweep`,
      aoaList: [4],
    })
    .returning();
  sweepId = sweep.id;
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${PREFIX}-preset`,
      name: `${PREFIX} preset`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: reference.id,
      boundaryProfileId: boundaryProfile.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: bc.id,
      enabled: false,
    })
    .returning();
  presetId = preset.id;
  const resolved = await ensureSimulationPresetRevision(db, preset.id);
  if (!resolved) throw new Error("simulation revision fixture is required");
  revisionId = resolved.revision.id;
  const [result] = await db
    .insert(results)
    .values({
      airfoilId,
      bcId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 4,
      status: "done",
      source: "solved",
      regime: "rans",
      reynolds: 171_000,
      speed: 25,
      chord: 0.1,
      mach: 0.073,
      // Deliberately stale projection: public detail must use the pointer.
      cl: 0.41,
      cd: 0.021,
      cm: -0.01,
      clCd: 19.52,
      converged: true,
      engineJobId: `${PREFIX}-old-engine`,
      engineCaseSlug: "old-case",
      solvedAt: new Date(),
    })
    .returning();
  resultId = result.id;
  const attempts = await db
    .insert(resultAttempts)
    .values([
      {
        resultId,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 4,
        status: "done" as const,
        source: "solved" as const,
        regime: "rans" as const,
        validForPolar: true,
        cl: 0.41,
        cd: 0.021,
        cm: -0.01,
        clCd: 19.52,
        converged: true,
        engineJobId: `${PREFIX}-old-engine`,
        engineCaseSlug: "old-case",
        evidencePayload: { fidelity: "rans" },
        solvedAt: new Date(),
      },
      {
        resultId,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: 4,
        status: "done" as const,
        source: "solved" as const,
        regime: "rans" as const,
        validForPolar: true,
        cl: 0.63,
        cd: 0.014,
        cm: -0.025,
        clCd: 45,
        converged: true,
        engineJobId: `${PREFIX}-current-engine`,
        engineCaseSlug: "current-case",
        evidencePayload: { fidelity: "rans" },
        solvedAt: new Date(),
      },
    ])
    .returning();
  oldAttemptId = attempts[0].id;
  currentAttemptId = attempts[1].id;
  await db.insert(resultClassifications).values([
    {
      resultAttemptId: oldAttemptId,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 4,
      regime: "rans" as const,
      classifierVersion: `${PREFIX}-accepted-v1`,
      state: "accepted" as const,
      reasons: [],
    },
    {
      resultAttemptId: currentAttemptId,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      aoaDeg: 4,
      regime: "rans" as const,
      classifierVersion: `${PREFIX}-accepted-v1`,
      state: "accepted" as const,
      reasons: [],
    },
  ]);
  const oldManifestSha = sha(`${PREFIX}-old-manifest`);
  currentManifestSha = sha(`${PREFIX}-current-manifest`);
  await db.insert(solverEvidenceArtifacts).values([
    {
      resultId,
      resultAttemptId: oldAttemptId,
      airfoilId,
      engineJobId: `${PREFIX}-old-engine`,
      engineCaseSlug: "old-case",
      aoaDeg: 4,
      kind: "manifest" as const,
      role: "evidence",
      storageKey: `${PREFIX}/old/evidence_manifest.json`,
      mimeType: "application/json",
      sha256: oldManifestSha,
      byteSize: 100,
      metadata: { evidenceBase: "old/evidence" },
    },
    {
      resultId,
      resultAttemptId: currentAttemptId,
      airfoilId,
      engineJobId: `${PREFIX}-current-engine`,
      engineCaseSlug: "current-case",
      aoaDeg: 4,
      kind: "manifest" as const,
      role: "evidence",
      storageKey: `${PREFIX}/current/evidence_manifest.json`,
      mimeType: "application/json",
      sha256: currentManifestSha,
      byteSize: 120,
      metadata: { evidenceBase: "current/evidence" },
    },
  ]);
  await db.insert(resultMedia).values([
    {
      resultId,
      resultAttemptId: oldAttemptId,
      kind: "image" as const,
      field: "pressure",
      role: "instantaneous" as const,
      storageKey: `${PREFIX}/old/pressure.png`,
      mimeType: "image/png",
      evidenceSha256: oldManifestSha,
      sha256: sha(`${PREFIX}-old-image`),
      byteSize: 20,
    },
    {
      resultId,
      resultAttemptId: currentAttemptId,
      kind: "image" as const,
      field: "vorticity",
      role: "instantaneous" as const,
      storageKey: `${PREFIX}/current/vorticity.png`,
      mimeType: "image/png",
      evidenceSha256: currentManifestSha,
      sha256: sha(`${PREFIX}-current-image`),
      byteSize: 24,
    },
  ]);
  await db.insert(forceHistory).values([
    {
      resultId,
      resultAttemptId: oldAttemptId,
      t: [0, 1],
      cl: [0.4, 0.41],
      cd: [0.02, 0.021],
    },
    {
      resultId,
      resultAttemptId: currentAttemptId,
      t: [10, 11],
      cl: [0.62, 0.63],
      cd: [0.013, 0.014],
    },
  ]);
  await db.insert(fieldRenderCache).values([
    {
      resultId,
      field: "pressure",
      role: "instantaneous",
      paramsHash: `${PREFIX}-old-render`,
      params: { evidenceSha256: oldManifestSha },
      storageKey: `${PREFIX}/old/custom.png`,
      mimeType: "image/png",
      sha256: sha(`${PREFIX}-old-custom`),
      byteSize: 30,
    },
    {
      resultId,
      field: "vorticity",
      role: "instantaneous",
      paramsHash: `${PREFIX}-current-render`,
      params: { evidenceSha256: currentManifestSha },
      storageKey: `${PREFIX}/current/custom.png`,
      mimeType: "image/png",
      sha256: sha(`${PREFIX}-current-custom`),
      byteSize: 32,
    },
  ]);
  await db
    .update(results)
    .set({ currentResultAttemptId: currentAttemptId })
    .where(eq(results.id, resultId));
});

afterAll(async () => {
  if (resultId) {
    await db
      .update(results)
      .set({ currentResultAttemptId: null })
      .where(eq(results.id, resultId));
    await db.delete(results).where(eq(results.id, resultId));
  }
  if (presetId)
    await db
      .delete(simulationPresets)
      .where(eq(simulationPresets.id, presetId));
  if (bcId)
    await db.delete(boundaryConditions).where(eq(boundaryConditions.id, bcId));
  if (flowId)
    await db.delete(flowConditions).where(eq(flowConditions.id, flowId));
  if (referenceId)
    await db
      .delete(referenceGeometryProfiles)
      .where(eq(referenceGeometryProfiles.id, referenceId));
  if (boundaryProfileId)
    await db
      .delete(boundaryProfiles)
      .where(eq(boundaryProfiles.id, boundaryProfileId));
  if (meshId) await db.delete(meshProfiles).where(eq(meshProfiles.id, meshId));
  if (solverId)
    await db.delete(solverProfiles).where(eq(solverProfiles.id, solverId));
  if (schedulingId)
    await db
      .delete(schedulingProfiles)
      .where(eq(schedulingProfiles.id, schedulingId));
  if (outputId)
    await db.delete(outputProfiles).where(eq(outputProfiles.id, outputId));
  if (sweepId)
    await db.delete(sweepDefinitions).where(eq(sweepDefinitions.id, sweepId));
  if (airfoilId) await db.delete(airfoils).where(eq(airfoils.id, airfoilId));
  if (categoryId)
    await db.delete(categories).where(eq(categories.id, categoryId));
  await app.close();
  await closeDatabasePools();
});

describe("public exact-generation reads", () => {
  it("opens a selected 400-sample point and reads the catalog and admin sync view while report imports hold every sync connection", async () => {
    expect(
      interactiveSql.options.max +
        PUBLIC_POINT_CONNECTIONS +
        syncSql.options.max + syncControlSql.options.max,
    ).toBe(10);
    expect(advisoryLockSql.options.max).toBe(16);
    const reader = new PublicPointReader();
    const serving = await buildServer(reader);
    try {
      await verifyInteractivePool({
        db,
        app: serving,
        slots: syncSql.options.max,
        slug: `${PREFIX}-foil`,
        airfoilName: `${PREFIX} foil`,
        airfoilId,
        revisionId,
        bcId,
        resultId,
        attemptId: currentAttemptId,
      });
      const selector = `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}`;
      for (const url of [
        selector,
        selector + "&resultAttemptId=" + oldAttemptId,
        selector + "&resultAttemptId=" + currentAttemptId,
      ]) {
        const [expected, served] = await Promise.all([
          app.inject({ method: "GET", url }),
          serving.inject({ method: "GET", url }),
        ]);
        expect(served.statusCode).toBe(expected.statusCode);
        expect(served.json()).toEqual(expected.json());
      }
      // Run the real thread while the HTTP event loop is occupied. Scientific
      // assembly must be able to complete before the reply can run on main.
      const isolated = reader.read([
        `${PREFIX}-foil`,
        undefined,
        undefined,
        resultId,
        undefined,
      ]);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
      const completed = await isolated;
      expect(completed.detail?.resultId).toBe(resultId);
      expect(completed.timing.handoffMs).toBeGreaterThan(150);
      const { dispatchMs, resultDeliveryMs, handoffMs } = completed.timing;
      expect(dispatchMs).toBeGreaterThanOrEqual(0);
      expect(resultDeliveryMs).toBeGreaterThanOrEqual(0);
      expect(dispatchMs + resultDeliveryMs).toBeGreaterThan(150);
      expect(dispatchMs + resultDeliveryMs).toBeLessThanOrEqual(handoffMs + 2);
    } finally {
      serving.server.closeAllConnections();
      await serving.close();
    }
  }, 45_000);

  it("keeps canonical attempt archive reads within configured access and leaves HZ unavailable", async () => {
    await verifyAttemptEvidenceApiAccess();
  });
  it("preserves accepted/provisional public science and original admin evidence through exact attempt archive read-through", async () => {
    await verifyAttemptEvidenceApiReadthrough({ db, app, resultId, selectedAttemptId: currentAttemptId,
      originalAttemptId: oldAttemptId, slug: `${PREFIX}-foil`, revisionId,
      setConnection: (connection) => { attemptReadScope.connection = connection; },
    });
  });
  it("serves media, evidence, custom renders, fields, coefficients and history only from the selected attempt", async () => {
    const media = await app.inject({
      method: "GET",
      url: `/api/results/${resultId}/media`,
    });
    expect(media.statusCode).toBe(200);
    expect(
      media.json().items.map((item: { field: string }) => item.field),
    ).toEqual(["vorticity"]);

    const evidence = await app.inject({
      method: "GET",
      url: `/api/results/${resultId}/evidence`,
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json().artifacts).toHaveLength(1);
    expect(evidence.json().artifacts[0].sha256).toBe(currentManifestSha);
    expect(evidence.json().media).toHaveLength(1);
    expect(evidence.json().media[0].field).toBe("vorticity");
    expect(evidence.json().customRenders).toHaveLength(1);
    expect(evidence.json().customRenders[0].field).toBe("vorticity");

    const track = await app.inject({
      method: "GET",
      url: `/api/airfoils/${PREFIX}-foil/field-track`,
    });
    expect(track.statusCode).toBe(200);
    expect(track.json().items).toHaveLength(1);
    expect(track.json().items[0].fields).toEqual(["vorticity"]);

    const sim = await app.inject({
      method: "GET",
      url: `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}`,
    });
    expect(sim.statusCode).toBe(200);
    expect(sim.json()).toMatchObject({
      cl: 0.63,
      cd: 0.014,
      ld: 45,
      renderTarget: { resultAttemptId: currentAttemptId, manifestSha256: currentManifestSha },
      availableFields: ["vorticity"],
      history: { t: [10, 11], cl: [0.62, 0.63], cd: [0.013, 0.014] },
    });
  });

  it("offers a custom render only for the exact current manifest and preserves historical downloads", async () => {
    const publicUrl = `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}`;
    const adminUrl = `/api/admin/point-history/${resultId}/sim?resultAttemptId=`;
    async function read(url: string) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, response.body).toBe(200);
      return response.json();
    }
    const old = await read(adminUrl + oldAttemptId);
    expect(old).toMatchObject({ resultAttemptId: oldAttemptId, renderTarget: null });
    expect(old.evidenceArtifacts).toContainEqual(expect.objectContaining({ sha256: sha(`${PREFIX}-old-manifest`) }));
    expect(await read(adminUrl + currentAttemptId)).toMatchObject({
      renderTarget: { resultAttemptId: currentAttemptId, manifestSha256: currentManifestSha },
    });

    const rollback = new Error("roll back render manifest fixture");
    await expect(db.transaction(async tx => {
      attemptReadScope.connection = tx as unknown as DB;
      try {
        const owned = and(eq(solverEvidenceArtifacts.resultAttemptId, currentAttemptId), eq(solverEvidenceArtifacts.kind, "manifest"));
        await tx.update(solverEvidenceArtifacts).set({ engineCaseSlug: "old-case" }).where(owned);
        for (const url of [publicUrl, adminUrl + currentAttemptId]) {
          expect(await read(url)).toMatchObject({ renderTarget: null,
            evidenceArtifacts: [expect.objectContaining({ sha256: currentManifestSha })] });
        }
        await tx.delete(solverEvidenceArtifacts).where(owned);
        for (const url of [publicUrl, adminUrl + currentAttemptId]) {
          expect(await read(url)).toMatchObject({ renderTarget: null, availableFields: ["vorticity"], evidenceArtifacts: [] });
        }
      } finally { attemptReadScope.connection = null; }
      throw rollback;
    })).rejects.toBe(rollback);
  });

  it("reports only numerical convergence and URANS outcomes recorded on the requested generation", async () => {
    const restore = new Error("rollback scoped outcome fixture");
    await expect(db.transaction(async (tx) => {
      attemptReadScope.connection = tx as unknown as DB;
      try {
        const track = periodicPoint(4, 5, true).frame_track!;
        const publicUrl = `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}`;
        const adminUrl = `/api/admin/point-history/${resultId}/sim?resultAttemptId=`;
        async function read(url: string) {
          const res = await app.inject({ method: "GET", url });
          expect(res.statusCode, res.body).toBe(200);
          return res.json();
        }
        // Stale result-level values must never replace either exact attempt.
        await tx.update(results).set({ converged: true, unsteady: true, frameTrack: track }).where(eq(results.id, resultId));
        await tx.update(resultAttempts).set({ converged: false, unsteady: true, regime: "urans",
          evidencePayload: { fidelity: "urans_precalc" } }).where(eq(resultAttempts.id, oldAttemptId));
        expect(await read(adminUrl + oldAttemptId)).toMatchObject({
          resultAttemptId: oldAttemptId, numericalConvergence: false, uransFlowOutcome: null, frameTrack: null,
        });
        const cases = [
          [{ frame_track: track }, "periodic"],
          [{ no_shedding_certificate: noSheddingCertificate }, "no_shedding"],
          [{ noSheddingCertificate: noSheddingCertificate }, "no_shedding"],
          [{ no_shedding_certificate: { ...noSheddingCertificate, certified: false } }, null],
          [{ no_shedding_certificate: noSheddingCertificate, frame_track: track }, null],
          [{ frame_track: { ...track, period_s: null } }, null],
          [{ frame_track: { ...track, frames: [] } }, null],
          [{ frame_track: { ...track, window: { t_start: 0, t_end: 0.071 } } }, null],
          [{ frame_track: { ...track, frames: [...track.frames].reverse() } }, null],
        ] as const;
        for (const [evidence, expected] of cases) {
          // Each independent source starts inline. Roll back its savepoint
          // rather than deleting history from a previously observed generation.
          try {
            await tx.transaction(async (scoped) => {
              attemptReadScope.connection = scoped as unknown as DB;
              await scoped.update(resultAttempts).set({ converged: true, regime: "urans",
                evidencePayload: { fidelity: "urans_full", ...evidence } })
                .where(eq(resultAttempts.id, currentAttemptId));
              for (const url of [publicUrl, adminUrl + currentAttemptId]) {
                const body = await read(url);
                expect(body).toMatchObject({ numericalConvergence: true, uransFlowOutcome: expected });
                if (expected === "periodic") expect(body.frameTrack).toMatchObject({
                  periodS: track.period_s, periodsRetained: track.periods_retained,
                });
              }
              throw restore;
            });
          } catch (error) {
            if (error !== restore) throw error;
          } finally { attemptReadScope.connection = tx as unknown as DB; }
        }
      } finally { attemptReadScope.connection = null; }
      throw restore;
    })).rejects.toBe(restore);
  });

  it("opens a selected result by ID when Reynolds is stored only on its immutable setup", async () => {
    const [original] = await db
      .select({ reynolds: results.reynolds })
      .from(results)
      .where(eq(results.id, resultId));
    const [revision] = await db
      .select({ reynolds: simulationPresetRevisions.reynolds })
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, revisionId));
    await db.update(results).set({ reynolds: null }).where(eq(results.id, resultId));
    try {
      for (const hint of ["", "&re=1"]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}${hint}`,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          resultId,
          re: revision.reynolds,
          cl: 0.63,
          cd: 0.014,
          history: { t: [10, 11], cl: [0.62, 0.63], cd: [0.013, 0.014] },
        });
      }
    } finally {
      await db.update(results).set({ reynolds: original.reynolds }).where(eq(results.id, resultId));
    }
  });

  it("serves the same selected coefficients and history after its arrays move out of PostgreSQL", async () => {
    const [rawBefore] = await db.select().from(results).where(eq(results.id, resultId)).limit(1);
    const [attemptBefore] = await db.select().from(resultAttempts).where(eq(resultAttempts.id, currentAttemptId)).limit(1);
    // This fixture intentionally keeps a stale raw cell projection. Detail
    // selects currentResultAttemptId; archiving must preserve both sources.
    expect(rawBefore).toMatchObject({
      currentResultAttemptId: currentAttemptId,
      cl: 0.41, cd: 0.021, cm: -0.01, clCd: 19.52,
    });
    expect(attemptBefore).toMatchObject({
      id: currentAttemptId, resultId,
      cl: 0.63, cd: 0.014, cm: -0.025, clCd: 45,
    });
    const simBefore = await app.inject({ method: "GET", url: `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}` });
    expect(simBefore.statusCode).toBe(200);
    const selectedBefore = simBefore.json();
    const visibleBefore = {
      cl: selectedBefore.cl, cd: selectedBefore.cd, cm: selectedBefore.cm,
      ld: selectedBefore.ld, history: selectedBefore.history,
    };
    expect(visibleBefore).toEqual({
      cl: 0.63, cd: 0.014, cm: -0.025, ld: 45,
      history: { t: [10, 11], cl: [0.62, 0.63], cd: [0.013, 0.014] },
    });
    const [history] = await db.select().from(forceHistory).where(eq(forceHistory.resultAttemptId, currentAttemptId)).limit(1);
    const source = await loadSolverHistorySource(db, "force_history", history.id);
    const encoded = encodeSolverHistory("api-history-fixture", source);
    const identity: SolverHistoryArchiveIdentity = {
      sourceInstance: "api-history-fixture", ...source, ...encoded,
      bucket: "fixture-evidence", objectKey: `solver-histories/v1/${history.id}/${encoded.storedSha256}.json.gz`,
      generation: "1", crc32c: "AAAAAA==",
    };
    const store = {
      put: async () => identity,
      read: async (pointer: SolverHistoryArchiveIdentity) => decodeSolverHistory(encoded.stored, pointer),
    };
    const read = vi.spyOn(SolverHistoryGcsStore.prototype, "read").mockImplementation(store.read);
    try {
      const archived = await archiveSolverHistory(db, store, {
        bucket: identity.bucket, sourceInstance: identity.sourceInstance, sourceKind: "force_history", sourceId: history.id,
      });
      expect(archived.offloaded).toBe(true);
      const [stored] = await db.select().from(forceHistory).where(eq(forceHistory.id, history.id));
      expect([stored.t, stored.cl, stored.cd, stored.cm]).toEqual([null, null, null, null]);
      expect(stored.historyArchiveId).toBe(archived.archive.id);
      const sim = await app.inject({ method: "GET", url: `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}` });
      expect(sim.statusCode).toBe(200);
      expect(sim.json()).toMatchObject(visibleBefore);
      expect(read).toHaveBeenCalled();
      const evidence = await app.inject({ method: "GET", url: `/api/results/${resultId}/evidence` });
      expect(evidence.statusCode).toBe(200);
      expect(evidence.json().artifacts[0].sha256).toBe(currentManifestSha);
      const [rawAfter] = await db.select().from(results).where(eq(results.id, resultId));
      const [attemptAfter] = await db.select().from(resultAttempts).where(eq(resultAttempts.id, currentAttemptId));
      expect(rawAfter).toMatchObject({ currentResultAttemptId: currentAttemptId, cl: 0.41 });
      expect(rawAfter).toEqual(rawBefore);
      expect(attemptAfter).toEqual(attemptBefore);
    } finally {
      // Normal ingestion restores inline arrays and clears the pointer via
      // 0204's trigger. Other cases continue to prove their own boundaries.
      await db.update(forceHistory).set({ t: history.t, cl: history.cl, cd: history.cd, cm: history.cm }).where(eq(forceHistory.id, history.id));
      read.mockRestore();
    }
  });

  it("HZ point histories preserve selected detail, sync export and missing-copy failure", async () => {
    await checkHzHistoryApi(app, db, resultId, currentAttemptId, `${PREFIX}-foil`);
  });

  it("returns a truthful temporary failure while missing local media is queued for reconstruction", async () => {
    const [media] = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultAttemptId, currentAttemptId))
      .limit(1);
    await db.insert(resultMediaStorageUploads).values({
      resultMediaId: media.id,
      state: "retry_wait",
      attemptCount: 1,
      nextAttemptAt: new Date(Date.now() + 6 * 60 * 60_000),
      error: `${RESULT_MEDIA_LOCAL_BYTES_UNAVAILABLE_MARKER}: ${media.storageKey}`,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/result-media/${media.id}`,
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({
        error: "stored media recovery is pending",
      });
      const detail = await app.inject({
        method: "GET",
        url: `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}`,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        renderTarget: null,
        availableFields: [],
        media: null,
      });
    } finally {
      await db
        .delete(resultMediaStorageUploads)
        .where(eq(resultMediaStorageUploads.resultMediaId, media.id));
    }
  });

  it("fails pointer-null public reads closed and exposes no historical fallback", async () => {
    await db
      .update(results)
      .set({ currentResultAttemptId: null })
      .where(eq(results.id, resultId));
    try {
      const media = await app.inject({
        method: "GET",
        url: `/api/results/${resultId}/media`,
      });
      expect(media.statusCode).toBe(200);
      expect(media.json().items).toEqual([]);
      const evidence = await app.inject({
        method: "GET",
        url: `/api/results/${resultId}/evidence`,
      });
      expect(evidence.json()).toEqual({
        artifacts: [],
        media: [],
        customRenders: [],
      });
      const sim = await app.inject({
        method: "GET",
        url: `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}`,
      });
      expect(sim.statusCode).toBe(404);
      const render = await app.inject({
        method: "POST",
        url: `/api/results/${resultId}/render`,
        payload: { field: "vorticity", scaleMode: "auto" },
      });
      expect(render.statusCode).toBe(409);
      expect(render.json().error).toContain("selected evidence generation");
    } finally {
      await db
        .update(results)
        .set({ currentResultAttemptId: currentAttemptId })
        .where(eq(results.id, resultId));
    }
  });

  it("fails a rejected selected attempt closed even when the pointer is present", async () => {
    await db
      .update(resultClassifications)
      .set({ state: "rejected", reasons: ["missing-urans-video"] })
      .where(eq(resultClassifications.resultAttemptId, currentAttemptId));
    try {
      const sim = await app.inject({
        method: "GET",
        url: `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}`,
      });
      expect(sim.statusCode).toBe(404);
    } finally {
      await db
        .update(resultClassifications)
        .set({ state: "accepted", reasons: [] })
        .where(eq(resultClassifications.resultAttemptId, currentAttemptId));
    }
  });

  it("rejects custom render when current physical inputs are missing instead of inventing defaults", async () => {
    await db
      .update(results)
      .set({ chord: null })
      .where(eq(results.id, resultId));
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/results/${resultId}/render`,
        payload: { field: "vorticity", scaleMode: "auto" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain("reference chord or flow speed");
    } finally {
      await db
        .update(results)
        .set({ chord: 0.1 })
        .where(eq(results.id, resultId));
    }
  });

  it("rejects custom render when the selected result has zero flow speed", async () => {
    await db.update(results).set({ speed: 0 }).where(eq(results.id, resultId));
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/results/${resultId}/render`,
        payload: { field: "vorticity", scaleMode: "auto" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain("reference chord or flow speed");
    } finally {
      await db
        .update(results)
        .set({ speed: 25 })
        .where(eq(results.id, resultId));
    }
  });

  it.each([502, 503])(
    "preserves engine archived-evidence status %s for custom rendering",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response('{"detail":"remote evidence unavailable"}', {
              status,
              headers: { "content-type": "application/json" },
            }),
        ),
      );
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/results/${resultId}/render`,
          payload: { field: "vorticity", scaleMode: "auto" },
        });
        expect(response.statusCode).toBe(status);
        expect(response.json().error).toMatch(
          status === 503 ? /temporarily unavailable/ : /verified or rendered/,
        );
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("rejects a delegated render when the upstream pointer advanced to another evidence signature", async () => {
    const [savedSettings] = await db
      .select()
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1))
      .limit(1);
    const [savedPermission] = await db
      .select()
      .from(syncApiPermissions)
      .where(eq(syncApiPermissions.dataType, "result_media"))
      .limit(1);
    const secret = `${PREFIX}-render-secret`;
    await db
      .insert(syncApiSettings)
      .values({ id: 1, enabled: true, secret })
      .onConflictDoUpdate({
        target: syncApiSettings.id,
        set: { enabled: true, secret, updatedAt: new Date() },
      });
    await db
      .insert(syncApiPermissions)
      .values({ dataType: "result_media", canFetch: true, canPush: false })
      .onConflictDoUpdate({
        target: syncApiPermissions.dataType,
        set: { canFetch: true, updatedAt: new Date() },
      });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/sync/v1/results/${resultId}/render`,
        headers: { "x-xfoilfoam-sync-secret": secret },
        payload: {
          field: "vorticity",
          role: "instantaneous",
          scaleMode: "auto",
          expectedEvidenceSha256: sha(`${PREFIX}-old-manifest`),
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain("generation changed");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      if (savedSettings) {
        const { id: _id, createdAt: _createdAt, ...restore } = savedSettings;
        await db
          .update(syncApiSettings)
          .set({ ...restore, updatedAt: new Date() })
          .where(eq(syncApiSettings.id, 1));
      }
      if (savedPermission) {
        const {
          dataType: _dataType,
          ...restore
        } = savedPermission;
        await db
          .update(syncApiPermissions)
          .set({ ...restore, updatedAt: new Date() })
          .where(eq(syncApiPermissions.dataType, "result_media"));
      } else {
        await db
          .delete(syncApiPermissions)
          .where(eq(syncApiPermissions.dataType, "result_media"));
      }
    }
  });

  it("refuses to persist a remote custom render that omits exact content identity", async () => {
    const [savedSettings] = await db
      .select()
      .from(syncApiSettings)
      .where(eq(syncApiSettings.id, 1))
      .limit(1);
    const [manifest] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.sha256, currentManifestSha))
      .limit(1);
    if (!manifest) throw new Error("current manifest fixture missing");
    const remoteEngineJobId = `sync:${PREFIX}:remote-result`;
    const authorityKey = `remote/${PREFIX}/manifest`;
    await db
      .update(syncApiSettings)
      .set({
        upstreamBaseUrl: "https://upstream.example.test/api/sync/v1",
        upstreamSecret: `${PREFIX}-upstream-secret`,
        updatedAt: new Date(),
      })
      .where(eq(syncApiSettings.id, 1));
    await db
      .update(resultAttempts)
      .set({ engineJobId: remoteEngineJobId })
      .where(eq(resultAttempts.id, currentAttemptId));
    await db
      .update(solverEvidenceArtifacts)
      .set({ engineJobId: remoteEngineJobId })
      .where(eq(solverEvidenceArtifacts.id, manifest.id));
    await db.insert(remoteAssetReferences).values({
      localKind: "evidence_artifact",
      localRowId: manifest.id,
      localStorageKey: authorityKey,
      resultId,
      resultAttemptId: currentAttemptId,
      sourceInstanceId: `${PREFIX}-upstream`,
      sourceInstanceName: "Exact upstream fixture",
      remoteResultId: resultId,
      remoteArtifactId: manifest.id,
      remoteDownloadUrl: "https://upstream.example.test/manifest",
      sha256: manifest.sha256,
      byteSize: manifest.byteSize,
      mimeType: manifest.mimeType,
      availability: "remote_only",
    });
    const fetchMock = vi.fn(
      async (_input: string | URL, init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: `${PREFIX}-remote-cache`,
            url: "/incomplete-render.png",
            field: "vorticity",
            role: "instantaneous",
            // Deliberately missing result/attempt/evidence, checksum and bytes.
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const detail = await app.inject({ method: "GET", url: `/api/airfoils/${PREFIX}-foil/sim?resultId=${resultId}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().renderTarget).toEqual({ resultAttemptId: currentAttemptId, manifestSha256: currentManifestSha });
      expect(fetchMock).not.toHaveBeenCalled();
      const response = await app.inject({
        method: "POST",
        url: `/api/results/${resultId}/render`,
        payload: { field: "vorticity", scaleMode: "auto" },
      });
      expect(response.statusCode).toBe(502);
      expect(JSON.stringify(response.json())).toContain("exact generation");
      const requestBody = JSON.parse(
        String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
      );
      expect(requestBody.expectedEvidenceSha256).toBe(currentManifestSha);
      expect(
        new Headers(
          (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers,
        ).get("x-xfoilfoam-expected-evidence-sha256"),
      ).toBe(currentManifestSha);
      const stored = await db
        .select()
        .from(remoteAssetReferences)
        .where(
          and(
            eq(remoteAssetReferences.localKind, "field_render_cache"),
            eq(remoteAssetReferences.resultId, resultId),
            eq(remoteAssetReferences.resultAttemptId, currentAttemptId),
          ),
        );
      expect(
        stored.filter(
          (row) =>
            row.resultId === resultId &&
            row.resultAttemptId === currentAttemptId,
        ),
      ).toEqual([]);

      const remoteRenderSha = sha(`${PREFIX}-remote-custom-render`);
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: `${PREFIX}-remote-cache-exact`,
            url: "/exact-render.png",
            field: "vorticity",
            role: "instantaneous",
            paramsHash: `${PREFIX}-remote-params`,
            resultId,
            resultAttemptId: `${PREFIX}-remote-attempt`,
            evidenceSha256: currentManifestSha,
            mimeType: "image/png",
            sha256: remoteRenderSha,
            byteSize: 321,
            cached: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
      const accepted = await app.inject({
        method: "POST",
        url: `/api/results/${resultId}/render`,
        payload: { field: "vorticity", scaleMode: "auto" },
      });
      expect(accepted.statusCode).toBe(200);
      expect(accepted.json()).toMatchObject({
        resultId,
        resultAttemptId: currentAttemptId,
        evidenceSha256: currentManifestSha,
        sha256: remoteRenderSha,
        byteSize: 321,
        mimeType: "image/png",
      });
      const [exactStored] = await db
        .select()
        .from(remoteAssetReferences)
        .where(
          and(
            eq(remoteAssetReferences.localKind, "field_render_cache"),
            eq(remoteAssetReferences.resultId, resultId),
            eq(remoteAssetReferences.resultAttemptId, currentAttemptId),
          ),
        );
      expect(exactStored).toMatchObject({
        resultId,
        resultAttemptId: currentAttemptId,
        remoteResultId: resultId,
        remoteCacheId: `${PREFIX}-remote-cache-exact`,
        sha256: remoteRenderSha,
        byteSize: 321,
        mimeType: "image/png",
        metadata: {
          evidenceSha256: currentManifestSha,
          remoteResultAttemptId: `${PREFIX}-remote-attempt`,
        },
      });
    } finally {
      vi.unstubAllGlobals();
      await db
        .delete(remoteAssetReferences)
        .where(
          and(
            eq(remoteAssetReferences.localKind, "field_render_cache"),
            eq(remoteAssetReferences.resultId, resultId),
            eq(remoteAssetReferences.resultAttemptId, currentAttemptId),
          ),
        );
      await db
        .delete(remoteAssetReferences)
        .where(eq(remoteAssetReferences.localStorageKey, authorityKey));
      await db
        .update(resultAttempts)
        .set({ engineJobId: `${PREFIX}-current-engine` })
        .where(eq(resultAttempts.id, currentAttemptId));
      await db
        .update(solverEvidenceArtifacts)
        .set({ engineJobId: `${PREFIX}-current-engine` })
        .where(eq(solverEvidenceArtifacts.id, manifest.id));
      if (savedSettings) {
        const { id: _id, createdAt: _createdAt, ...restore } = savedSettings;
        await db
          .update(syncApiSettings)
          .set({ ...restore, updatedAt: new Date() })
          .where(eq(syncApiSettings.id, 1));
      }
    }
  });
});
