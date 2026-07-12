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
  resultAttempts,
  resultClassifications,
  resultMedia,
  results,
  schedulingProfiles,
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

import { db } from "../src/db";
import { buildServer } from "../src/server";

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
});

describe("public exact-generation reads", () => {
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
      availableFields: ["vorticity"],
      history: { t: [10, 11], cl: [0.62, 0.63], cd: [0.013, 0.014] },
    });
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
          createdAt: _createdAt,
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
